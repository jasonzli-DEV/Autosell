const { EmbedBuilder } = require('discord.js');

let _client = null;

function setLoggerClient(client) {
  _client = client;
}

function resolveLogChannelIds(options = {}) {
  const category = `${options.category || ''}`.trim().toLowerCase().replace(/[\s_-]+/g, '-');
  const explicit = `${options.channelId || ''}`.trim();
  const ids = [];

  if (explicit) ids.push(explicit);
  if (category === 'donut') ids.push(process.env.DONUT_PAYMENT_LOGS_CHANNEL_ID, process.env.AUTOSELL_LOGS_CHANNEL_ID);
  if (category === 'ltc') ids.push(process.env.LTC_PAYMENT_LOGS_CHANNEL_ID, process.env.AUTOSELL_LOGS_CHANNEL_ID);
  if (category === 'autosell') ids.push(process.env.AUTOSELL_LOGS_CHANNEL_ID);
  if (category === 'ticket') ids.push(process.env.TICKET_LOGS_CHANNEL_ID);
  if (category === 'transcript' || category === 'ticket-transcript') ids.push(process.env.TICKET_TRANSCRIPTS_CHANNEL_ID, process.env.TICKET_LOGS_CHANNEL_ID);
  if (category === 'giveaway') ids.push(process.env.GIVEAWAY_LOGS_CHANNEL_ID, process.env.TICKET_TRANSCRIPTS_CHANNEL_ID);
  if (category === 'invite') ids.push(process.env.INVITE_LOGS_CHANNEL_ID);
  if (category === 'join' || category === 'leave' || category === 'member') ids.push(process.env.JOIN_LOGS_CHANNEL_ID, process.env.INVITE_LOGS_CHANNEL_ID);
  ids.push(process.env.LOGS_CHANNEL_ID);

  return [...new Set(ids.map(id => `${id || ''}`.trim()).filter(Boolean))];
}

async function logToChannel(embed, options = {}) {
  const channelIds = resolveLogChannelIds(options);
  if (!_client || channelIds.length === 0) return;

  try {
    for (const channelId of channelIds) {
      const channel = await _client.channels.fetch(channelId).catch(() => null);
      if (!channel) continue;
      await channel.send({ embeds: [embed] });
      if (!options.broadcast) break;
    }
  } catch (err) {
    console.error('[Logger] Failed to send log:', err.message);
  }
}

async function logInfo(title, description, fields = [], options = {}) {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(title)
    .setDescription(description);
  if (fields.length) embed.addFields(fields);
  await logToChannel(embed, options);
}

async function logSuccess(title, description, fields = [], options = {}) {
  const embed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle(title)
    .setDescription(description);
  if (fields.length) embed.addFields(fields);
  await logToChannel(embed, options);
}

async function logError(title, description, fields = [], options = {}) {
  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle(title)
    .setDescription(description);
  if (fields.length) embed.addFields(fields);
  await logToChannel(embed, options);
}

module.exports = { setLoggerClient, logInfo, logSuccess, logError, resolveLogChannelIds };
