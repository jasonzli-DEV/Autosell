let _client = null;

function setVcClient(client) {
  _client = client;
}

async function updateVoiceChannelName(walletUsd) {
  const channelId = process.env.VOICE_CHANNEL_ID;
  if (!_client || !channelId) return;

  try {
    const channel = await _client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;
    const name = `$${walletUsd.toFixed(2)} Bot Balance`;
    await channel.setName(name);
  } catch (err) {
    console.error('[VoiceChannel] Failed to update name:', err.message);
  }
}

module.exports = { setVcClient, updateVoiceChannelName };
