const { EmbedBuilder } = require('discord.js');
const { fetchDonutStatsWithRetry } = require('./lib/donut');
const { calculateLtcAmount } = require('./lib/price');
const { sendLtc } = require('./lib/ltc');
const { formatMoney } = require('./utils');
const { logInfo, logSuccess, logError } = require('./lib/logger');

const POLL_MS = 2_000;
const MIN_PAYMENT = 10_000_000;
const VERBOSE_LOGS = process.env.VERBOSE_LOGS === 'true';

let active = null;
const queue = [];
let _client = null;

function verboseLog(...args) {
  if (VERBOSE_LOGS) console.log(...args);
}

function setClient(client) {
  _client = client;
}

function isActive() {
  return active !== null;
}

function hasActiveTrade(userId) {
  if (active?.userId === userId) return true;
  return queue.some(t => t.userId === userId);
}

function getQueuePosition(userId) {
  if (active?.userId === userId) return 0;
  const idx = queue.findIndex(t => t.userId === userId);
  return idx === -1 ? -1 : idx + 1;
}

async function dmUser(userId, embedOrOptions) {
  try {
    const user = await _client.users.fetch(userId);
    const options = embedOrOptions instanceof EmbedBuilder
      ? { embeds: [embedOrOptions] }
      : embedOrOptions;
    await user.send(options);
  } catch {
    console.error(`[Queue] Failed to DM user ${userId}.`);
  }
}

function clearTransaction(tx) {
  if (tx?.intervalId) clearInterval(tx.intervalId);
  if (tx?.timeoutId) clearTimeout(tx.timeoutId);
}

async function processNext() {
  if (active || queue.length === 0) return;

  active = queue.shift();
  active.status = 'awaiting_payment';

  try {
    await startPayment(active);
  } catch (err) {
    console.error(`[Queue] Failed to start payment for ${active.userId}:`, err);
    clearTransaction(active);
    await dmUser(active.userId, new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle('Error Starting Trade')
      .setDescription(`Something went wrong: ${err.message}\n\nTry again or contact an admin.`),
    );
    logError('Trade Start Error', `Failed to start trade for <@${active.userId}>`, [
      { name: 'IGN', value: active.ign || 'unknown', inline: true },
      { name: 'Error', value: err.message, inline: false },
    ], { category: 'donut' }).catch(() => null);
    active = null;
    processNext().catch(console.error);
  }
}

async function startPayment(tx) {
  const { userId, ign, ltcAddress, receiverIgn } = tx;
  const timeoutMin = Math.max(1, parseInt(process.env.PAYMENT_TIMEOUT_MINUTES || '5', 10));
  const receiver = `${receiverIgn || process.env.DONUTSMP_RECEIVER_IGN || ''}`.trim();

  const baseline = await fetchDonutStatsWithRetry(ign);
  const receiverBaseline = await fetchDonutStatsWithRetry(receiver);

  await dmUser(userId, new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('💚 Payment Window Open')
    .setDescription(`You have **${timeoutMin} minutes** to send at least **10m** in-game. Multiple payments count.`)
    .addFields(
      { name: '👤 IGN', value: `\`${ign}\``, inline: true },
      { name: '⏱️ Time Limit', value: `${timeoutMin} minutes`, inline: true },
      { name: '💰 Minimum', value: '10m total', inline: true },
      { name: '🎮 In-Game Command', value: `\`/pay ${receiver} <amount>\``, inline: false },
      { name: '🔑 Your LTC Address', value: `\`${ltcAddress}\``, inline: false },
    )
    .setFooter({ text: `Must pay from IGN: ${ign}` }),
  );

  logInfo('Sell Started', `<@${userId}> opened a sell window`, [
    { name: 'IGN', value: ign, inline: true },
    { name: 'LTC Address', value: ltcAddress, inline: false },
  ], { category: 'donut' }).catch(() => null);

  verboseLog(`[Queue] Payment tracking started: user=${userId} ign=${ign}`);

  let checks = 0;
  let lastPaymentTotal = 0;
  let running = false;

  const runCheck = async () => {
    if (running || !active || active.userId !== userId) return;
    running = true;
    try {
      const [current, receiverCurrent] = await Promise.all([
        fetchDonutStatsWithRetry(ign),
        fetchDonutStatsWithRetry(receiver),
      ]);
      const senderDrop = baseline.money - current.money;
      const receiverGain = receiverCurrent.money - receiverBaseline.money;
      const totalPayment = Math.min(Math.max(0, senderDrop), Math.max(0, receiverGain));
      lastPaymentTotal = totalPayment;
      checks++;

      verboseLog(`[Queue] Check #${checks} for ${userId}: senderDrop=${senderDrop} receiverGain=${receiverGain} required=10000000`);

      if (senderDrop >= MIN_PAYMENT && receiverGain >= MIN_PAYMENT) {
        clearTransaction(tx);
        await onPaymentConfirmed(tx, totalPayment);
      }
    } catch (err) {
      console.error(`[Queue] Poll error for ${userId}:`, err.message);
    } finally {
      running = false;
    }
  };

  const onTimeout = async () => {
    clearInterval(tx.intervalId);
    verboseLog(`[Queue] Timeout for ${userId} after ${checks} checks. totalPayment=${lastPaymentTotal}`);

    if (!active || active.userId !== userId) return;
    active = null;

    await dmUser(userId, new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle('Payment Window Expired')
      .setDescription(
        `The ${timeoutMin}-minute window closed.\n\n` +
        `Detected: **${formatMoney(lastPaymentTotal)}** confirmed to receiver (minimum needed: **10m**)\n\n` +
        `If you already paid, contact an admin with your Discord ID: \`${userId}\``,
      ),
    );

    logInfo('Sell Timed Out', `<@${userId}> did not pay in time`, [
      { name: 'IGN', value: ign, inline: true },
      { name: 'Detected', value: formatMoney(Math.max(0, lastPaymentTotal)), inline: true },
    ], { category: 'donut' }).catch(() => null);

    processNext().catch(console.error);
  };

  tx.intervalId = setInterval(() => runCheck().catch(console.error), POLL_MS);
  tx.timeoutId = setTimeout(() => onTimeout().catch(console.error), timeoutMin * 60_000);

  await runCheck();
}

async function onPaymentConfirmed(tx, totalPayment) {
  const { userId, ltcAddress } = tx;

  await dmUser(userId, new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('Payment Confirmed')
    .setDescription(`Got **${formatMoney(totalPayment)}**. Sending LTC now...`),
  );

  let ltcAmount, usdValue;
  try {
    const result = await calculateLtcAmount(totalPayment);
    ltcAmount = result.ltcAmount;
    usdValue = result.usdValue;
  } catch (err) {
    console.error(`[Queue] Calculate LTC failed for ${userId}:`, err);
    active = null;

    await dmUser(userId, new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle('Payment Calculation Failed')
      .setDescription('Your payment went through but we failed to calculate LTC amount. Contact an admin.')
      .addFields(
        { name: 'Error', value: `\`${err.message}\``, inline: false },
        { name: 'Discord ID', value: `\`${userId}\``, inline: true },
        { name: 'Amount paid', value: `\`${formatMoney(totalPayment)}\``, inline: true },
      ),
    );

    logError('LTC Calculation Failed', `<@${userId}> paid but LTC calculation failed`, [
      { name: 'Paid', value: formatMoney(totalPayment), inline: true },
      { name: 'Error', value: err.message, inline: false },
    ], { category: 'ltc' }).catch(() => null);

    processNext().catch(console.error);
    return;
  }

  let txHash;
  try {
    txHash = await sendLtc(ltcAddress, ltcAmount);
  } catch (err) {
    console.error(`[Queue] LTC send failed for ${userId}:`, err);
    active = null;

    await dmUser(userId, new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle('LTC Send Failed')
      .setDescription('Your payment went through but the LTC send failed. Contact an admin immediately.')
      .addFields(
        { name: 'Error', value: `\`${err.message}\``, inline: false },
        { name: 'Discord ID', value: `\`${userId}\``, inline: true },
        { name: 'Amount owed', value: `\`${ltcAmount.toFixed(8)}\` LTC`, inline: true },
        { name: 'To address', value: `\`${ltcAddress}\``, inline: false },
      ),
    );

    logError('LTC Send Failed', `<@${userId}> paid but LTC send failed — manual action required`, [
      { name: 'Paid', value: formatMoney(totalPayment), inline: true },
      { name: 'Owed', value: `${ltcAmount.toFixed(8)} LTC`, inline: true },
      { name: 'Address', value: ltcAddress, inline: false },
      { name: 'Error', value: err.message, inline: false },
    ], { category: 'ltc' }).catch(() => null);

    processNext().catch(console.error);
    return;
  }

  await dmUser(userId, new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('LTC Sent')
    .addFields(
      { name: 'Amount Received', value: `\`${totalPayment}\` Donut Money`, inline: false },
      { name: 'LTC Sent', value: `\`${ltcAmount.toFixed(8)}\` LTC`, inline: true },
      { name: 'USD Value', value: `\`$${usdValue.toFixed(2)}\``, inline: true },
      { name: 'Address', value: `\`${ltcAddress}\``, inline: false },
      { name: 'TX Hash', value: `\`${txHash}\``, inline: false },
      { name: 'Explorer', value: `https://live.blockcypher.com/ltc/tx/${txHash}/`, inline: false },
    ),
  );

  logSuccess('Trade Completed', `<@${userId}> sold DonutSMP money`, [
    { name: 'Paid (Donut)', value: formatMoney(totalPayment), inline: true },
    { name: 'LTC Sent', value: `${ltcAmount.toFixed(8)} LTC`, inline: true },
    { name: 'USD Value', value: `$${usdValue.toFixed(2)}`, inline: true },
    { name: 'TX Hash', value: txHash, inline: false },
  ], { category: 'ltc' }).catch(() => null);

  console.log(`[Queue] LTC sent for ${userId}: ${ltcAmount} LTC ← ${formatMoney(totalPayment)} tx=${txHash}`);

  const clientRoleId = `${process.env.CLIENT_ROLE_ID || ''}`.trim();
  const guildId = `${process.env.DISCORD_GUILD_ID || ''}`.trim();
  if (clientRoleId && guildId && _client) {
    try {
      const guild = await _client.guilds.fetch(guildId);
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member && !member.roles.cache.has(clientRoleId)) {
        await member.roles.add(clientRoleId);
        console.log(`[Queue] Assigned client role to ${userId}`);
      }
    } catch (err) {
      console.error(`[Queue] Failed to assign client role to ${userId}:`, err.message);
    }
  }

  active = null;
  processNext().catch(console.error);
}

async function addToQueueNoAmount(transaction) {
  const immediate = !active;
  queue.push(transaction);

  if (immediate) {
    processNext().catch(console.error);
  }

  return { immediate, position: immediate ? 0 : queue.length };
}

async function addToQueue(transaction) {
  const immediate = !active;
  queue.push(transaction);

  if (immediate) {
    processNext().catch(console.error);
  }

  return { immediate, position: immediate ? 0 : queue.length };
}

module.exports = { setClient, addToQueue, addToQueueNoAmount, isActive, hasActiveTrade, getQueuePosition };
