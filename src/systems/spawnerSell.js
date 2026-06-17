const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const { Vec3 } = require('vec3');
const { getSettings, updateSettings } = require('../lib/botSettings');
const { getUserSettings } = require('../lib/userSettings');
const { getLtcUsdPrice } = require('../lib/price');
const { sendLtc } = require('../lib/ltc');
const { getPayerBot, isPayerConnected, getPacketTrace, formatPacketTraceForLog } = require('../lib/minecraftPayer');
const { logInfo, logSuccess, logError } = require('../lib/logger');

const spawnerSellEnterCustomId = 'spawner_sell_enter';
const spawnerSellResendTpaCustomId = 'spawner_sell_resend_tpa';
const spawnerSellRecheckEcCustomId = 'spawner_sell_recheck_ec';
const spawnerSellDoneCustomId = 'spawner_sell_done';

const TPA_TIMEOUT_MS = 2 * 60 * 1000;
const DROP_TIMEOUT_MS = 5 * 60 * 1000;
const TELEPORT_DISTANCE_THRESHOLD = 5;
const ENDERCHEST_MAX_DISTANCE = 4;
const CHUNK_LOAD_WAIT_MS = 2000;
const ITEM_PICKUP_WAIT_MS = 3000;
const CHEST_DEPOSIT_DELAY_MS = 150;
const CHEST_DEPOSIT_RETRY_DELAY_MS = 300;
// Time for our rotation packet to flush before we interact with a block.
const POSITION_SETTLE_MS = 200;
// After a trade, /rtp the bot away from the user, retrying until it actually moves.
const RTP_RETRY_INTERVAL_MS = 5000;
const RTP_MAX_ATTEMPTS = 12; // safety cap (~60s) so a broken /rtp can't loop forever

const spawnerQueue = [];
let spawnerActive = null;
let _client = null;

function setSpawnerClient(client) {
  _client = client;
}

function isInSpawnerQueue(userId) {
  if (spawnerActive?.userId === userId) return true;
  return spawnerQueue.some(s => s.userId === userId);
}

function getSpawnerQueuePosition(userId) {
  if (spawnerActive?.userId === userId) return 0;
  const idx = spawnerQueue.findIndex(s => s.userId === userId);
  return idx === -1 ? -1 : idx + 1;
}

async function dmUser(userId, options) {
  try {
    const user = await _client.users.fetch(userId);
    const payload = options instanceof EmbedBuilder ? { embeds: [options] } : options;
    return user.send(payload);
  } catch {
    console.error(`[SpawnerSell] Failed to DM user ${userId}`);
    return null;
  }
}

function errorEmbed(description) {
  return new EmbedBuilder().setColor(0xED4245).setDescription(description);
}

function infoEmbed(title, description) {
  return new EmbedBuilder().setColor(0x5865F2).setTitle(title).setDescription(description);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clearSession(session) {
  if (!session) return;
  if (session.tpaTimeoutId) clearTimeout(session.tpaTimeoutId);
  if (session.dropTimeoutId) clearTimeout(session.dropTimeoutId);
  session.tpaCleanup?.();
}

// ── Mineflayer helpers ────────────────────────────────────────────────────────

function requireBot() {
  const bot = getPayerBot();
  if (!bot || !isPayerConnected()) throw new Error('Minecraft bot is not connected.');
  return bot;
}

function snapshotInventory(bot) {
  return bot.inventory.items().map(item => ({
    name: item.name,
    displayName: item.displayName,
    customName: item.customName ?? null,
    slot: item.slot,
    count: item.count,
    nbt: item.nbt,
    components: item.components ?? null,
  }));
}

function isSpawnerItem(name) {
  return name === 'spawner' || name === 'monster_spawner';
}

// Recursively collects every string value out of a (possibly NBT-wrapped) value —
// chat components, lore, block_entity_data, etc. — so we can search the whole item
// for a mob name regardless of how the server nests it.
function collectStrings(node, out) {
  if (node == null) return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (Array.isArray(node)) {
    for (const n of node) collectStrings(n, out);
    return out;
  }
  if (typeof node === 'object') {
    for (const key of Object.keys(node)) collectStrings(node[key], out);
  }
  return out;
}

// custom_name / item_name are the display name, which players can change with an
// anvil — so they must NEVER be trusted for the mob type, or someone could rename a
// cheap spawner "Skeleton Spawner" to trick the bot into paying out.
const RENAMEABLE_COMPONENT_TYPES = new Set([
  'custom_name', 'minecraft:custom_name', 'item_name', 'minecraft:item_name',
]);

// A spawner counts as a skeleton spawner only if "skeleton" appears in a component a
// player cannot edit: the plugin-set lore or the spawner's block_entity_data (its
// SpawnData entity id). The renameable display name is excluded.
function mentionsSkeleton(components) {
  if (!Array.isArray(components)) return false;
  const trusted = components.filter(c => !RENAMEABLE_COMPONENT_TYPES.has(c?.type));
  const strings = collectStrings(trusted, []);
  return strings.some(s => s.toLowerCase().includes('skeleton'));
}

function isSkeletonSpawner(item) {
  return isSpawnerItem(item.name) && mentionsSkeleton(item.components);
}

// prismarine-item factory for the bot's version, used to parse shulker contents.
let _itemFactory = null;
let _itemFactoryVersion = null;
function getItemFactory(bot) {
  const version = bot?.version || bot?.registry?.version?.minecraftVersion;
  if (!version) return null;
  if (!_itemFactory || _itemFactoryVersion !== version) {
    _itemFactory = require('prismarine-item')(version);
    _itemFactoryVersion = version;
  }
  return _itemFactory;
}

// Pulls the slot entries out of a shulker box's container component. The 1.20.5+
// network format is { contents: [ { itemId, itemCount, components }, ... ] }; older
// shapes (plain array, NBT-wrapped list) are handled as fallbacks.
function getContainerContents(components) {
  if (!Array.isArray(components)) return null;
  const comp = components.find(c => c.type === 'minecraft:container' || c.type === 'container');
  if (!comp) return null;
  const data = comp.data;
  if (Array.isArray(data?.contents)) return data.contents;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.value?.value)) return data.value.value;
  return null;
}

function countSpawnersInShulker(shulkerComponents, bot) {
  const contents = getContainerContents(shulkerComponents);
  if (!contents) return 0;
  const Item = getItemFactory(bot);
  if (!Item) return 0;

  let total = 0;
  for (const entry of contents) {
    let slotItem;
    try {
      slotItem = Item.fromNotch(entry);
    } catch {
      continue;
    }
    if (slotItem && isSkeletonSpawner(slotItem)) {
      total += slotItem.count;
    }
  }
  return total;
}

function countSpawnersInItems(items, bot) {
  let total = 0;
  for (const item of items) {
    if (isSkeletonSpawner(item)) {
      total += item.count;
    } else if (item.name.endsWith('_shulker_box')) {
      total += countSpawnersInShulker(item.components, bot);
    }
  }
  return total;
}

function findEnderchest(bot) {
  const ecId = bot.registry?.blocksByName?.['ender_chest']?.id;
  if (!ecId) return null;
  return bot.findBlock({ matching: ecId, maxDistance: ENDERCHEST_MAX_DISTANCE });
}

// prismarine block face indices → unit normal vectors (what openBlock expects).
const FACE_VECTORS = [
  new Vec3(0, -1, 0), // 0 bottom
  new Vec3(0, 1, 0),  // 1 top
  new Vec3(0, 0, -1), // 2 north
  new Vec3(0, 0, 1),  // 3 south
  new Vec3(-1, 0, 0), // 4 west
  new Vec3(1, 0, 0),  // 5 east
];

// Raycasts from the bot's eye toward a block and returns the face the ray enters
// plus the cursor position on that face (relative coordinates in [0,1]). Returns
// null if the ray doesn't hit the target block, in which case the caller falls back
// to mineflayer's default interaction.
function raycastBlockFace(bot, block) {
  if (!bot.world?.raycast || !bot.entity?.position) return null;
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
  const center = block.position.offset(0.5, 0.5, 0.5);
  const dir = center.minus(eye).normalize();
  const hit = bot.world.raycast(eye, dir, 6);
  if (!hit?.position?.equals(block.position) || hit.face == null || !hit.intersect) return null;
  const faceVec = FACE_VECTORS[hit.face];
  if (!faceVec) return null;
  return { faceVec, cursor: hit.intersect.minus(block.position) };
}

async function depositIntoEnderchest(bot, ecBlock) {
  // Physics is disabled, so the bot never sends a serverbound position packet on its
  // own. Without one the server has no confirmed client position and silently ignores
  // the block_place interaction — windowOpen never fires. Tell the server where we
  // stand (on the ground, looking at the chest) before each open attempt.
  const ecCenter = ecBlock.position.offset(0.5, 0.5, 0.5);

  let window;
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Evidence gathering: record which clientbound packets arrive in the window
    // after we send the interaction, so we can see whether the server responds at all.
    const received = [];
    const onPacket = (data, meta) => { if (meta?.name) received.push(meta.name); };
    bot._client.on('packet', onPacket);
    try {
      // Face the chest so our rotation matches the interaction we send (Grim checks
      // this). force=true rotates instantly rather than over several physics ticks.
      await bot.lookAt(ecCenter, true);
      await sleep(POSITION_SETTLE_MS);

      // mineflayer's activateBlock hardcodes the top face with a centre cursor, which
      // is geometrically impossible (a top-face click needs cursorY = 1.0). Strict
      // anticheat (Grim, on DonutSMP) rejects that mismatch: it acks the interaction
      // but never opens the chest. Raycast from the eye to find the real face + cursor.
      const aim = raycastBlockFace(bot, ecBlock);
      console.log(
        `[SpawnerSell] openBlock attempt ${attempt}: block=${ecBlock.name}@${ecBlock.position} ` +
        `botPos=${bot.entity?.position} dist=${bot.entity?.position?.distanceTo?.(ecCenter)?.toFixed?.(2)} ` +
        `aim=${aim ? `face=${aim.faceVec} cursor=${aim.cursor}` : 'raycast-miss(using default face)'}`,
      );
      window = aim
        ? await bot.openBlock(ecBlock, aim.faceVec, aim.cursor)
        : await bot.openBlock(ecBlock);
      break;
    } catch (err) {
      const counts = received.reduce((m, n) => { m[n] = (m[n] || 0) + 1; return m; }, {});
      console.warn(`[SpawnerSell] openBlock attempt ${attempt} failed: ${err.message}`);
      console.warn(`[SpawnerSell] clientbound packets during attempt: ${JSON.stringify(counts)}`);
      console.warn('[SpawnerSell] recent packet trace:\n' + formatPacketTraceForLog(getPacketTrace().slice(-25)));
      if (attempt === 3) throw err;
      await sleep(2000);
    } finally {
      bot._client.removeListener('packet', onPacket);
    }
  }

  try {
    for (let pass = 0; pass < 3; pass++) {
      let found = false;
      for (let slot = window.inventoryStart; slot < window.slots.length; slot++) {
        const item = window.slots[slot];
        if (!item) continue;
        if (isSpawnerItem(item.name) || item.name.endsWith('_shulker_box')) {
          found = true;
          try {
            await bot.clickWindow(slot, 0, 1);
            await sleep(CHEST_DEPOSIT_DELAY_MS);
          } catch (err) {
            console.warn(`[SpawnerSell] Deposit slot ${slot} error: ${err.message}`);
          }
        }
      }
      if (!found) break;
      await sleep(CHEST_DEPOSIT_RETRY_DELAY_MS);
    }

    const remaining = window.slots
      .slice(window.inventoryStart)
      .filter(item => item && (isSpawnerItem(item.name) || item.name.endsWith('_shulker_box')))
      .length;

    return { success: remaining === 0, remaining };
  } finally {
    try { window.close(); } catch {}
  }
}

async function dropBotInventory(bot) {
  for (const item of [...bot.inventory.items()]) {
    try {
      await bot.tossStack(item);
      await sleep(50);
    } catch {}
  }
}

// ── Session flow ──────────────────────────────────────────────────────────────

async function processSpawnerNext() {
  if (spawnerActive || spawnerQueue.length === 0) return;
  spawnerActive = spawnerQueue.shift();

  // Notify next user in case they were queued and waiting
  const queueSize = spawnerQueue.length;
  for (let i = 0; i < queueSize; i++) {
    dmUser(spawnerQueue[i].userId, infoEmbed(
      'Queue Update',
      `You are now **#${i + 1}** in the spawner sell queue.`,
    )).catch(() => null);
  }

  try {
    await startSpawnerSession(spawnerActive);
  } catch (err) {
    console.error(`[SpawnerSell] Failed to start session for ${spawnerActive.userId}:`, err);
    await dmUser(spawnerActive.userId, errorEmbed(`Failed to start your session: ${err.message}\n\nContact an admin.`));
    logError('Spawner Sell Start Error', `Failed for <@${spawnerActive.userId}>`, [
      { name: 'IGN', value: spawnerActive.ign, inline: true },
      { name: 'Error', value: err.message, inline: false },
    ], { category: 'spawner' }).catch(() => null);
    clearSession(spawnerActive);
    spawnerActive = null;
    processSpawnerNext().catch(console.error);
  }
}

async function startSpawnerSession(session) {
  const bot = requireBot();

  session.status = 'awaiting_tpa';

  // Physics is enabled, so bot.entity.position is kept in sync natively. Capture the
  // baseline so we can detect the jump when the user accepts the TPA.
  const base = bot.entity?.position?.clone() ?? null;

  bot.chat(`/tpa ${session.ign}`);

  await dmUser(session.userId, {
    embeds: [
      new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('Step 1 — Accept the TPA')
        .setDescription(
          `The bot sent you a TPA request!\n\n` +
          `**IGN:** \`${session.ign}\`\n` +
          `Type \`/tpaccept\` in-game to let the bot teleport to you.\n\n` +
          `You have **2 minutes** to accept.`,
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(spawnerSellResendTpaCustomId)
          .setLabel('Resend TPA Request')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  });

  logInfo('Spawner Sell TPA Sent', `<@${session.userId}> — /tpa ${session.ign}`, [], { category: 'spawner' }).catch(() => null);

  // The server teleports the bot when the user runs /tpaccept. mineflayer emits
  // 'forcedMove' on every server-side reposition; the first one that moves us far
  // from the baseline is the accepted teleport.
  let tpaSettled = false;

  const onForcedMove = () => {
    if (tpaSettled) return;
    const pos = bot.entity?.position;
    if (!pos) return;
    if (base && pos.distanceTo(base) <= TELEPORT_DISTANCE_THRESHOLD) return;

    tpaSettled = true;
    clearTimeout(session.tpaTimeoutId);
    session.tpaTimeoutId = null;
    session.tpaCleanup?.();

    onTeleportDetected(session).catch(err => failSession(session, err.message));
  };

  bot.on('forcedMove', onForcedMove);

  session.tpaCleanup = () => {
    tpaSettled = true;
    try { bot.removeListener('forcedMove', onForcedMove); } catch {}
  };

  session.tpaTimeoutId = setTimeout(async () => {
    if (!spawnerActive || spawnerActive.userId !== session.userId) return;
    session.tpaCleanup?.();

    await dmUser(session.userId, errorEmbed('TPA timed out — you did not accept within 2 minutes. Removed from queue.'));
    logInfo('Spawner Sell TPA Timeout', `<@${session.userId}> — ${session.ign}`, [], { category: 'spawner' }).catch(() => null);

    clearSession(session);
    spawnerActive = null;
    processSpawnerNext().catch(console.error);
  }, TPA_TIMEOUT_MS);
}

async function onTeleportDetected(session) {
  session.status = 'awaiting_enderchest';

  await dmUser(session.userId, {
    embeds: [
      infoEmbed('Step 2 — Enderchest Check', 'Teleported! Waiting for chunks to load...'),
    ],
    components: [],
  });

  // Give the server time to send chunks around the new location before scanning for blocks
  await sleep(CHUNK_LOAD_WAIT_MS);

  await checkEnderchest(session);
}

async function checkEnderchest(session) {
  const bot = requireBot();
  const ecBlock = findEnderchest(bot);

  if (!ecBlock) {
    await dmUser(session.userId, {
      embeds: [
        new EmbedBuilder()
          .setColor(0xFEE75C)
          .setTitle('No Enderchest Found')
          .setDescription(
            'No enderchest was found within **4 blocks**.\n\n' +
            'Place one within reach of the bot, then press **Recheck**.',
          ),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(spawnerSellRecheckEcCustomId)
            .setLabel('Recheck Enderchest')
            .setStyle(ButtonStyle.Primary),
        ),
      ],
    });
    return;
  }

  session.ecBlock = ecBlock;
  session.inventoryBefore = snapshotInventory(bot);
  session.status = 'awaiting_drop';

  session.dropTimeoutId = setTimeout(async () => {
    if (!spawnerActive || spawnerActive.userId !== session.userId) return;
    await dmUser(session.userId, errorEmbed('You took too long to drop spawners (5 min limit). Removed from queue.'));
    logInfo('Spawner Sell Drop Timeout', `<@${session.userId}>`, [], { category: 'spawner' }).catch(() => null);
    clearSession(session);
    spawnerActive = null;
    processSpawnerNext().catch(console.error);
  }, DROP_TIMEOUT_MS);

  await dmUser(session.userId, {
    embeds: [
      new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('Step 3 — Drop Your Spawners')
        .setDescription(
          'Enderchest found! ✅\n\n' +
          'Now **drop your skeleton spawners** (or shulker boxes containing them) at the bot\'s feet.\n\n' +
          'Press **I\'m Done Dropping** when finished.',
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(spawnerSellDoneCustomId)
          .setLabel("I'm Done Dropping")
          .setStyle(ButtonStyle.Success),
      ),
    ],
  });
}

async function onSpawnerDone(session) {
  if (session.status !== 'awaiting_drop') return;

  clearTimeout(session.dropTimeoutId);
  session.dropTimeoutId = null;
  session.status = 'processing';

  await dmUser(session.userId, {
    embeds: [infoEmbed('Processing', 'Counting your spawners... Please wait.')],
    components: [],
  });

  await sleep(ITEM_PICKUP_WAIT_MS);

  const bot = requireBot();
  const inventoryAfter = snapshotInventory(bot);

  const before = countSpawnersInItems(session.inventoryBefore, bot);
  const after = countSpawnersInItems(inventoryAfter, bot);
  const newSpawners = after - before;
  console.log(`[SpawnerSell] spawnersBefore=${before} spawnersAfter=${after} new=${newSpawners}`);

  if (newSpawners <= 0) {
    session.status = 'awaiting_drop';
    session.inventoryBefore = inventoryAfter;

    session.dropTimeoutId = setTimeout(async () => {
      if (!spawnerActive || spawnerActive.userId !== session.userId) return;
      await dmUser(session.userId, errorEmbed('Session timed out. Contact an admin.'));
      clearSession(session);
      spawnerActive = null;
      processSpawnerNext().catch(console.error);
    }, DROP_TIMEOUT_MS);

    await dmUser(session.userId, {
      embeds: [
        new EmbedBuilder()
          .setColor(0xFEE75C)
          .setTitle('No Spawners Detected')
          .setDescription(
            'No new skeleton spawners were found in the bot\'s inventory.\n\n' +
            'Make sure to drop them **at the bot\'s feet** in-game.\n' +
            'Press **I\'m Done Dropping** again once you have.',
          ),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(spawnerSellDoneCustomId)
            .setLabel("I'm Done Dropping")
            .setStyle(ButtonStyle.Success),
        ),
      ],
    });
    return;
  }

  session.spawnerCount = newSpawners;

  const ecBlock = findEnderchest(bot);
  if (!ecBlock) {
    await failSession(session, 'Enderchest moved out of reach after drop. Contact an admin — your spawners are in the bot\'s inventory.', { skipCleanup: true });
    return;
  }

  let depositResult;
  try {
    depositResult = await depositIntoEnderchest(bot, ecBlock);
  } catch (err) {
    await failSession(session, `Could not open enderchest: ${err.message}. Contact an admin.`, { skipCleanup: true });
    return;
  }

  if (!depositResult.success) {
    await failSession(session, `${depositResult.remaining} item(s) could not be moved to the enderchest (may be full). Contact an admin.`, { skipCleanup: true });
    return;
  }

  await payUser(session);
}

async function payUser(session) {
  const { userId, ign, ltcAddress, spawnerCount } = session;

  let ltcAmount, usdValue, ltcUsd;
  try {
    const settings = await getSettings();
    const priceEach = Number(settings.spawnerBuyPriceEach) || 0.16;
    ltcUsd = await getLtcUsdPrice();
    usdValue = spawnerCount * priceEach;
    ltcAmount = Math.floor((usdValue / ltcUsd) * 1e8) / 1e8;
  } catch (err) {
    await failSession(session, `Spawners stored but payout calculation failed: ${err.message}. Contact an admin.`);
    return;
  }

  await dmUser(userId, {
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('Spawners Safe — Sending LTC')
        .setDescription(
          `**${spawnerCount}** skeleton spawner(s) stored in enderchest ✅\n\n` +
          `Sending **${ltcAmount.toFixed(8)} LTC** (~$${usdValue.toFixed(2)}) to your address...`,
        ),
    ],
  });

  let txHash;
  try {
    txHash = await sendLtc(ltcAddress, ltcAmount);
  } catch (err) {
    await dmUser(userId, errorEmbed(
      `Your spawners are safe in the enderchest but the LTC send failed: ${err.message}\n\n` +
      `Contact an admin — you are owed **${ltcAmount.toFixed(8)} LTC** (~$${usdValue.toFixed(2)}).`,
    ));
    logError('Spawner Sell LTC Send Failed', `<@${userId}> (${ign}) — manual action required`, [
      { name: 'Spawners', value: `${spawnerCount}`, inline: true },
      { name: 'Owed', value: `${ltcAmount.toFixed(8)} LTC`, inline: true },
      { name: 'Address', value: ltcAddress, inline: false },
      { name: 'Error', value: err.message, inline: false },
    ], { category: 'spawner' }).catch(() => null);
    await doCleanup();
    clearSession(session);
    spawnerActive = null;
    processSpawnerNext().catch(console.error);
    return;
  }

  await dmUser(userId, {
    embeds: [
      new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('Sold! LTC Sent')
        .addFields(
          { name: 'Spawners Sold', value: `\`${spawnerCount}\``, inline: true },
          { name: 'LTC Sent', value: `\`${ltcAmount.toFixed(8)}\` LTC`, inline: true },
          { name: 'USD Value', value: `\`$${usdValue.toFixed(2)}\``, inline: true },
          { name: 'LTC Address', value: `\`${ltcAddress}\``, inline: false },
          { name: 'TX Hash', value: `\`${txHash}\``, inline: false },
        ),
    ],
  });

  logSuccess('Spawner Sell Completed', `<@${userId}> (${ign}) sold ${spawnerCount} spawner(s)`, [
    { name: 'Spawners', value: `${spawnerCount}`, inline: true },
    { name: 'LTC Sent', value: `${ltcAmount.toFixed(8)} LTC`, inline: true },
    { name: 'USD Value', value: `$${usdValue.toFixed(2)}`, inline: true },
    { name: 'LTC Rate', value: `$${ltcUsd.toFixed(2)}/LTC`, inline: true },
    { name: 'TX Hash', value: txHash, inline: false },
  ], { category: 'spawner' }).catch(() => null);

  await doCleanup();
  clearSession(session);
  spawnerActive = null;
  processSpawnerNext().catch(console.error);
}

// Sends /rtp east every RTP_RETRY_INTERVAL_MS until the bot's position has moved
// from where it started (the teleport landed), or the safety cap is hit. /rtp can
// fail silently (cooldown), so we confirm by the position change rather than assuming.
async function relocateUntilMoved(bot, { intervalMs = RTP_RETRY_INTERVAL_MS, maxAttempts = RTP_MAX_ATTEMPTS } = {}) {
  const start = bot.entity?.position?.clone() ?? null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    bot.chat('/rtp east');
    await sleep(intervalMs);
    const pos = bot.entity?.position;
    if (!start || (pos && pos.distanceTo(start) > TELEPORT_DISTANCE_THRESHOLD)) {
      console.log(`[SpawnerSell] /rtp moved the bot after ${attempt} attempt(s)`);
      return true;
    }
  }
  console.warn(`[SpawnerSell] /rtp did not move the bot after ${maxAttempts} attempts`);
  return false;
}

async function doCleanup() {
  const bot = getPayerBot();
  if (!bot || !isPayerConnected()) return;
  try {
    await relocateUntilMoved(bot);
    await dropBotInventory(bot);
  } catch (err) {
    console.error('[SpawnerSell] Cleanup error:', err.message);
  }
}

async function failSession(session, reason, { skipCleanup = false } = {}) {
  console.error(`[SpawnerSell] Session failed for ${session.userId}: ${reason}`);
  await dmUser(session.userId, errorEmbed(`Something went wrong: ${reason}`));
  logError('Spawner Sell Failed', `<@${session.userId}> (${session.ign})`, [
    { name: 'Reason', value: reason, inline: false },
  ], { category: 'spawner' }).catch(() => null);
  if (!skipCleanup) await doCleanup().catch(() => null);
  clearSession(session);
  spawnerActive = null;
  processSpawnerNext().catch(console.error);
}

// ── Button handlers ───────────────────────────────────────────────────────────

async function handleSpawnerSellEnter(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (isInSpawnerQueue(interaction.user.id)) {
    const pos = getSpawnerQueuePosition(interaction.user.id);
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865F2)
          .setDescription(
            pos === 0
              ? 'Your session is active — check your DMs!'
              : `You\'re already **#${pos}** in the queue.`,
          ),
      ],
    });
  }

  const settings = await getUserSettings(interaction.user.id);
  if (!settings?.ign || !settings?.ltcAddress) {
    return interaction.editReply({
      embeds: [errorEmbed('Please set your IGN and LTC address using the **Settings** button first.')],
    });
  }

  const bot = getPayerBot();
  if (!bot || !isPayerConnected()) {
    return interaction.editReply({
      embeds: [errorEmbed('The Minecraft bot is currently offline. Try again shortly.')],
    });
  }

  const session = {
    userId: interaction.user.id,
    ign: settings.ign,
    ltcAddress: settings.ltcAddress,
    status: 'queued',
    inventoryBefore: null,
    ecBlock: null,
    spawnerCount: 0,
    tpaTimeoutId: null,
    dropTimeoutId: null,
    tpaCleanup: null,
  };

  spawnerQueue.push(session);
  const position = spawnerQueue.length;
  const immediate = !spawnerActive;

  processSpawnerNext().catch(console.error);

  if (immediate) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle("It's Your Turn!")
          .setDescription(`The bot is starting your session now. **Check your DMs!**\n\nIGN: \`${settings.ign}\``),
      ],
    });
  }

  await dmUser(interaction.user.id, {
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('Added to Queue')
        .setDescription(`You\'re **#${position}** in the spawner sell queue.\nWe\'ll DM you when it\'s your turn.`),
    ],
  });

  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865F2)
        .setDescription(`You\'re **#${position}** in the queue. Watch your DMs for updates.`),
    ],
  });
}

async function handleSpawnerResendTpa(interaction) {
  if (!spawnerActive || spawnerActive.userId !== interaction.user.id) {
    return interaction.reply({ embeds: [errorEmbed('No active session found for you.')], flags: MessageFlags.Ephemeral });
  }
  if (spawnerActive.status !== 'awaiting_tpa') {
    return interaction.reply({ embeds: [errorEmbed('TPA is no longer pending.')], flags: MessageFlags.Ephemeral });
  }

  await interaction.deferUpdate();

  const bot = requireBot();
  bot.chat(`/tpa ${spawnerActive.ign}`);

  await interaction.followUp({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865F2)
        .setDescription(`TPA request resent to \`${spawnerActive.ign}\`. Type \`/tpaccept\` in-game.`),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSpawnerRecheckEnderchest(interaction) {
  if (!spawnerActive || spawnerActive.userId !== interaction.user.id) {
    return interaction.reply({ embeds: [errorEmbed('No active session found for you.')], flags: MessageFlags.Ephemeral });
  }
  if (spawnerActive.status !== 'awaiting_enderchest') {
    return interaction.reply({ embeds: [errorEmbed('Not in the enderchest check phase.')], flags: MessageFlags.Ephemeral });
  }

  await interaction.deferUpdate();
  await checkEnderchest(spawnerActive).catch(err => failSession(spawnerActive, err.message));
}

async function handleSpawnerDoneDropping(interaction) {
  if (!spawnerActive || spawnerActive.userId !== interaction.user.id) {
    return interaction.reply({ embeds: [errorEmbed('No active session found for you.')], flags: MessageFlags.Ephemeral });
  }
  if (spawnerActive.status !== 'awaiting_drop') {
    return interaction.reply({ embeds: [errorEmbed('Not in the drop phase.')], flags: MessageFlags.Ephemeral });
  }

  await interaction.deferUpdate();
  onSpawnerDone(spawnerActive).catch(err => failSession(spawnerActive, err.message));
}

// ── Panel ─────────────────────────────────────────────────────────────────────

function getAdminIds() {
  return (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}

function spawnerSellPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle('Skeleton Spawner AutoSell')
    .setDescription([
      'Sell your skeleton spawners for automatic **LTC** payouts.',
      '',
      '**How it works:**',
      '1. Set your IGN + LTC address in `Settings`',
      '2. Click **Sell Spawners** to join the queue',
      '3. Accept the bot\'s TPA request in-game',
      '4. Drop your spawners at the bot\'s feet',
      '5. LTC is sent to your address automatically',
      '',
      'Shulker boxes containing skeleton spawners are accepted.',
    ].join('\n'));
}

async function postSpawnerSellPanel(interaction) {
  if (!getAdminIds().includes(interaction.user.id)) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('You do not have permission.')],
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const panelMessage = await interaction.channel.send({
    embeds: [spawnerSellPanelEmbed()],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(spawnerSellEnterCustomId).setLabel('Sell Spawners').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('autosell_settings').setLabel('Settings').setStyle(ButtonStyle.Secondary),
      ),
    ],
  });

  await updateSettings({
    spawnerSellPanelChannelId: interaction.channel.id,
    spawnerSellPanelMessageId: panelMessage.id,
  });

  return interaction.editReply({
    embeds: [new EmbedBuilder().setColor(0x57F287).setDescription('Spawner sell panel posted.')],
  });
}

module.exports = {
  depositIntoEnderchest,
  relocateUntilMoved,
  countSpawnersInItems,
  countSpawnersInShulker,
  isSkeletonSpawner,
  raycastBlockFace,
  FACE_VECTORS,
  spawnerSellEnterCustomId,
  spawnerSellResendTpaCustomId,
  spawnerSellRecheckEcCustomId,
  spawnerSellDoneCustomId,
  setSpawnerClient,
  handleSpawnerSellEnter,
  handleSpawnerResendTpa,
  handleSpawnerRecheckEnderchest,
  handleSpawnerDoneDropping,
  postSpawnerSellPanel,
};
