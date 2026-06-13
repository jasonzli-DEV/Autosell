const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const { getSettings, updateSettings } = require('../lib/botSettings');
const { getUserSettings } = require('../lib/userSettings');
const { getLtcUsdPrice } = require('../lib/price');
const { sendLtc } = require('../lib/ltc');
const { getPayerBot } = require('../lib/minecraftPayer');
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

// Packet names the server sends when teleporting a player (varies by MC version)
const TELEPORT_PACKET_NAMES = new Set([
  'position',
  'player_position_and_look',
  'synchronize_player_position',
]);
const ITEM_PICKUP_WAIT_MS = 3000;
const CHEST_DEPOSIT_DELAY_MS = 150;
const CHEST_DEPOSIT_RETRY_DELAY_MS = 300;

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
  if (!bot) throw new Error('Minecraft bot is not connected.');
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

// Reads the first lore line's mob type from the 1.20.5+ components array.
// DonutSMP stores the mob name (e.g. "Skeleton") as the text of the first
// extra element on the first lore line.
function getSpawnerMobType(components) {
  if (!Array.isArray(components)) return null;
  try {
    const loreComp = components.find(c => c.type === 'lore');
    if (!loreComp?.data?.length) return null;
    const firstLine = loreComp.data[0];

    // NBT-compound wrapped: data[0].value.extra.value.value[0].value.text.value
    const extras = firstLine?.value?.extra?.value?.value;
    if (Array.isArray(extras) && extras.length > 0) {
      const text = extras[0]?.value?.text?.value ?? extras[0]?.text?.value;
      if (text) return text;
    }

    // Plain TextComponent: data[0].extra[0].text
    const extra2 = firstLine?.extra;
    if (Array.isArray(extra2) && extra2.length > 0) {
      const text = extra2[0]?.text;
      if (typeof text === 'string') return text;
      if (text?.value) return text.value;
    }

    return null;
  } catch {
    return null;
  }
}

function isSkeletonSpawner(item) {
  if (!isSpawnerItem(item.name)) return false;
  const mob = getSpawnerMobType(item.components);
  if (!mob) return false;
  return mob.toLowerCase() === 'skeleton';
}

function countSpawnersInShulkerComponents(components) {
  if (!Array.isArray(components)) return 0;
  try {
    const containerComp = components.find(c => c.type === 'minecraft:container' || c.type === 'container');
    if (!containerComp) {
      console.log('[SpawnerSell] shulker component types:', JSON.stringify(components.map(c => c.type)));
      return 0;
    }
    console.log('[SpawnerSell] shulker container data type:', typeof containerComp.data, Array.isArray(containerComp.data) ? 'array' : JSON.stringify(containerComp.data)?.slice(0, 200));

    // data can be a plain array or NBT-wrapped list: { type:'list', value:{ type:'compound', value:[...] } }
    let slots;
    if (Array.isArray(containerComp.data)) {
      slots = containerComp.data;
    } else {
      slots = containerComp.data?.value?.value;
      if (!Array.isArray(slots)) return 0;
    }

    return slots.reduce((sum, slotEntry) => {
      // Plain: { slot, item } — NBT: { value: { slot: {value}, item: {value} } }
      const slotItem = slotEntry?.item ?? slotEntry?.value?.item?.value;
      if (!slotItem) return sum;
      const id = (slotItem.id?.value ?? slotItem.id ?? slotItem.name?.value ?? slotItem.name ?? '').replace('minecraft:', '');
      if (!isSpawnerItem(id)) return sum;
      const count = slotItem.count?.value ?? slotItem.Count?.value ?? slotItem.count ?? 1;
      const itemComponents = Array.isArray(slotItem.components) ? slotItem.components : null;
      if (itemComponents) {
        const mob = getSpawnerMobType(itemComponents);
        if (mob && mob.toLowerCase() !== 'skeleton') return sum;
      }
      return sum + count;
    }, 0);
  } catch (err) {
    console.log('[SpawnerSell] shulker parse error:', err.message);
    return 0;
  }
}

function countSpawnersInItems(items) {
  let total = 0;
  for (const item of items) {
    if (isSkeletonSpawner(item)) {
      total += item.count;
    } else if (item.name.endsWith('_shulker_box')) {
      total += countSpawnersInShulkerComponents(item.components);
    }
  }
  return total;
}

function findEnderchest(bot) {
  const ecId = bot.registry?.blocksByName?.['ender_chest']?.id;
  if (!ecId) return null;
  return bot.findBlock({ matching: ecId, maxDistance: ENDERCHEST_MAX_DISTANCE });
}

async function depositIntoEnderchest(bot, ecBlock) {
  let window;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      window = await bot.openBlock(ecBlock);
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`[SpawnerSell] openBlock attempt ${attempt} failed: ${err.message} — retrying`);
      await sleep(2000);
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

  // Capture baseline position from entity (may be null if physics is disabled)
  const entityPos = bot.entity?.position;
  let baseX = entityPos?.x ?? null;
  let baseY = entityPos?.y ?? null;
  let baseZ = entityPos?.z ?? null;

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

  // With physics disabled, bot.entity.position never updates. Instead we watch
  // for the server's position/teleport packet directly on the raw client socket.
  let tpaSettled = false;

  const onPositionPacket = (data, meta) => {
    if (tpaSettled) return;
    if (!TELEPORT_PACKET_NAMES.has(meta?.name)) return;
    if (typeof data?.x !== 'number') return;

    const { x, y, z } = data;

    // First packet establishes baseline if entity.position was unavailable
    if (baseX === null) {
      baseX = x;
      baseY = y;
      baseZ = z;
      return;
    }

    const dx = x - baseX;
    const dy = y - baseY;
    const dz = z - baseZ;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) > TELEPORT_DISTANCE_THRESHOLD) {
      tpaSettled = true;
      clearTimeout(session.tpaTimeoutId);
      session.tpaTimeoutId = null;
      session.tpaCleanup?.();

      // Physics is disabled so the bot's entity position never updates automatically.
      // Manually patch it so findBlock searches from the correct location.
      const currentBot = getPayerBot();
      if (currentBot?.entity?.position) {
        currentBot.entity.position.x = x;
        currentBot.entity.position.y = y;
        currentBot.entity.position.z = z;
        if (currentBot.entity) currentBot.entity.onGround = true;
      }

      onTeleportDetected(session).catch(err => failSession(session, err.message));
    }
  };

  bot._client.on('packet', onPositionPacket);

  session.tpaCleanup = () => {
    tpaSettled = true;
    try { bot._client.removeListener('packet', onPositionPacket); } catch {}
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

  const before = countSpawnersInItems(session.inventoryBefore);
  const after = countSpawnersInItems(inventoryAfter);
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

async function doCleanup() {
  const bot = getPayerBot();
  if (!bot) return;
  try {
    bot.chat('/rtp east');
    await sleep(3000);
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
  if (!bot) {
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
