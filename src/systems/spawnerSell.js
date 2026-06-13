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
const TELEPORT_POLL_MS = 500;
const TELEPORT_DISTANCE_THRESHOLD = 5;
const ENDERCHEST_MAX_DISTANCE = 4;
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
  if (session.teleportPollId) clearInterval(session.teleportPollId);
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
    slot: item.slot,
    count: item.count,
    nbt: item.nbt,
  }));
}

function countSpawnersInShulkerNbt(nbt) {
  try {
    const items = nbt?.value?.BlockEntityTag?.value?.Items?.value?.value || [];
    return items.reduce((sum, slotItem) => {
      const id = slotItem?.value?.id?.value || '';
      const count = slotItem?.value?.Count?.value || 0;
      return sum + (id === 'minecraft:skeleton_spawner' ? count : 0);
    }, 0);
  } catch {
    return 0;
  }
}

function countSpawnersInItems(items) {
  let total = 0;
  for (const item of items) {
    if (item.name === 'skeleton_spawner') {
      total += item.count;
    } else if (item.name.endsWith('_shulker_box')) {
      total += countSpawnersInShulkerNbt(item.nbt);
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
  const window = await bot.openBlock(ecBlock);
  try {
    for (let pass = 0; pass < 3; pass++) {
      let found = false;
      for (let slot = window.inventoryStart; slot < window.slots.length; slot++) {
        const item = window.slots[slot];
        if (!item) continue;
        if (item.name === 'skeleton_spawner' || item.name.endsWith('_shulker_box')) {
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
      .filter(item => item && (item.name === 'skeleton_spawner' || item.name.endsWith('_shulker_box')))
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
  const initialPos = bot.entity?.position;
  session.tpaPosition = initialPos ? { x: initialPos.x, y: initialPos.y, z: initialPos.z } : { x: 0, y: 0, z: 0 };

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

  session.teleportPollId = setInterval(() => {
    if (!spawnerActive || spawnerActive.userId !== session.userId) {
      clearInterval(session.teleportPollId);
      return;
    }
    const bot = getPayerBot();
    if (!bot?.entity?.position) return;
    const p = bot.entity.position;
    const dx = p.x - session.tpaPosition.x;
    const dy = p.y - session.tpaPosition.y;
    const dz = p.z - session.tpaPosition.z;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) > TELEPORT_DISTANCE_THRESHOLD) {
      clearInterval(session.teleportPollId);
      clearTimeout(session.tpaTimeoutId);
      session.teleportPollId = null;
      session.tpaTimeoutId = null;
      onTeleportDetected(session).catch(err => failSession(session, err.message));
    }
  }, TELEPORT_POLL_MS);

  session.tpaTimeoutId = setTimeout(async () => {
    if (!spawnerActive || spawnerActive.userId !== session.userId) return;
    clearInterval(session.teleportPollId);
    session.teleportPollId = null;

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
      infoEmbed('Step 2 — Enderchest Check', 'Teleported! Checking for an enderchest within reach...'),
    ],
    components: [],
  });

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
    await failSession(session, 'Enderchest moved out of reach after drop. Contact an admin — your spawners are in the bot\'s inventory.');
    return;
  }

  let depositResult;
  try {
    depositResult = await depositIntoEnderchest(bot, ecBlock);
  } catch (err) {
    await failSession(session, `Could not open enderchest: ${err.message}. Contact an admin.`);
    return;
  }

  if (!depositResult.success) {
    await failSession(session, `${depositResult.remaining} item(s) could not be moved to the enderchest (may be full). Contact an admin.`);
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

async function failSession(session, reason) {
  console.error(`[SpawnerSell] Session failed for ${session.userId}: ${reason}`);
  await dmUser(session.userId, errorEmbed(`Something went wrong: ${reason}`));
  logError('Spawner Sell Failed', `<@${session.userId}> (${session.ign})`, [
    { name: 'Reason', value: reason, inline: false },
  ], { category: 'spawner' }).catch(() => null);
  await doCleanup().catch(() => null);
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
    tpaPosition: null,
    tpaTimeoutId: null,
    dropTimeoutId: null,
    teleportPollId: null,
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
