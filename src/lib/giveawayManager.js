const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { Giveaway } = require('./models');
const { logSuccess } = require('./logger');

let _client = null;
const giveawayEndTimers = new Map();

function setGiveawayClient(client) {
  _client = client;
}

function buildGiveawayEmbed(giveaway) {
  const entryCount = (giveaway.entrants || []).length;

  if (giveaway.status === 'active') {
    const endTs = Math.floor(new Date(giveaway.entryEndsAt).getTime() / 1000);
    return new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle(`🎁 ${giveaway.prizeText} Giveaway`)
      .setDescription('Click **Enter Giveaway** below to participate!')
      .addFields(
        { name: '🏆 Prize', value: giveaway.prizeText, inline: true },
        { name: '👑 Winners', value: `${giveaway.winnersCount}`, inline: true },
        { name: '🎟️ Entries', value: `${entryCount}`, inline: true },
        { name: '⏰ Time Left', value: `<t:${endTs}:R>`, inline: false },
      )
      .setFooter({ text: `Giveaway ID: ${giveaway._id}` });
  }

  const winners = giveaway.winnerIds || [];
  const winnerText = winners.length > 0
    ? winners.map(id => `<@${id}>`).join(', ')
    : 'No winners';

  return new EmbedBuilder()
    .setColor(winners.length > 0 ? 0xf1c40f : 0xe74c3c)
    .setTitle(`🔚 ${giveaway.prizeText} Giveaway Ended`)
    .addFields(
      { name: '🏆 Prize', value: giveaway.prizeText, inline: true },
      { name: '🎟️ Total Entries', value: `${entryCount}`, inline: true },
      { name: '🎊 Winners', value: winnerText, inline: false },
    )
    .setFooter({ text: `Giveaway ID: ${giveaway._id}` });
}

function buildGiveawayJoinRow(giveawayId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`giveaway_join:${giveawayId}`)
      .setLabel('Enter Giveaway')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`giveaway_leave:${giveawayId}`)
      .setLabel('Leave')
      .setStyle(ButtonStyle.Secondary),
  );
}

function selectWinners(entrants, count) {
  const pool = [...entrants];
  const winners = [];
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(idx, 1)[0]);
  }
  return winners;
}

async function refreshGiveawayMessage(giveaway) {
  if (!giveaway.messageId || !_client) return;

  const guild = await _client.guilds.fetch(giveaway.guildId).catch(() => null);
  if (!guild) return;
  const channel = await guild.channels.fetch(giveaway.channelId).catch(() => null);
  if (!channel) return;
  const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
  if (!message) return;

  const embed = buildGiveawayEmbed(giveaway);
  const components = giveaway.status === 'active'
    ? [buildGiveawayJoinRow(giveaway._id.toString())]
    : [];

  await message.edit({ embeds: [embed], components }).catch(err =>
    console.error('[Giveaway] Failed to refresh message:', err.message),
  );
}

async function endGiveaway(giveawayId) {
  const giveaway = await Giveaway.findOne({ _id: giveawayId, status: 'active' });
  if (!giveaway) return;

  const timer = giveawayEndTimers.get(giveawayId.toString());
  if (timer) {
    clearTimeout(timer);
    giveawayEndTimers.delete(giveawayId.toString());
  }

  const winners = selectWinners(giveaway.entrants || [], giveaway.winnersCount);
  giveaway.winnerIds = winners;
  giveaway.status = 'ended';
  await giveaway.save();

  await refreshGiveawayMessage(giveaway);

  const winnerText = winners.length > 0 ? winners.map(id => `<@${id}>`).join(', ') : 'No winners';
  logSuccess('Giveaway Ended', `**${giveaway.prizeText}** giveaway concluded`, [
    { name: 'Winners', value: winnerText, inline: false },
    { name: 'Total Entries', value: `${(giveaway.entrants || []).length}`, inline: true },
  ]).catch(() => null);

  if (winners.length > 0 && _client) {
    const guild = await _client.guilds.fetch(giveaway.guildId).catch(() => null);
    const channel = guild ? await guild.channels.fetch(giveaway.channelId).catch(() => null) : null;
    if (channel) {
      const content = `🎉 Congratulations ${winners.map(id => `<@${id}>`).join(', ')}! You won **${giveaway.prizeText}**!`;
      const ping = await channel.send({ content, allowedMentions: { users: winners } }).catch(() => null);
      if (ping) setTimeout(() => ping.delete().catch(() => null), 6000);
    }
  }
}

function scheduleGiveawayEnd(giveaway) {
  const id = giveaway._id.toString();
  const existing = giveawayEndTimers.get(id);
  if (existing) clearTimeout(existing);

  if (giveaway.status !== 'active') return;

  const delay = new Date(giveaway.entryEndsAt).getTime() - Date.now();
  if (delay <= 0) {
    endGiveaway(id).catch(console.error);
    return;
  }

  const timer = setTimeout(() => endGiveaway(id).catch(console.error), delay);
  giveawayEndTimers.set(id, timer);
}

async function resumeActiveGiveaways() {
  const active = await Giveaway.find({ status: 'active' });
  for (const g of active) {
    scheduleGiveawayEnd(g);
  }
  if (active.length > 0) {
    console.log(`[Giveaway] Resumed ${active.length} active giveaway(s).`);
  }
}

module.exports = {
  setGiveawayClient,
  buildGiveawayEmbed,
  buildGiveawayJoinRow,
  selectWinners,
  endGiveaway,
  scheduleGiveawayEnd,
  resumeActiveGiveaways,
  refreshGiveawayMessage,
};
