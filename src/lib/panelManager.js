const { EmbedBuilder } = require('discord.js');

function formatRate(pricePerMillionUsd) {
  const per100m = pricePerMillionUsd * 100;
  return `${parseFloat(per100m.toFixed(2))}Usd per 100m`;
}

let _client = null;

function setPanelClient(client) {
  _client = client;
}

async function refreshPanel(channelId, messageId) {
  if (!_client || !channelId || !messageId) return;

  try {
    const { getLtcUsdPrice } = require('./price');
    const { getWalletBalanceLtc } = require('./ltc');
    const { getPricePerMillionUsd } = require('./botSettings');
    const { updateVoiceChannelName } = require('./voiceChannel');

    const channel = await _client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message || !message.embeds[0]) return;

    const ltcUsd = await getLtcUsdPrice();
    const walletLtc = await getWalletBalanceLtc();
    const pricePerMillionUsd = await getPricePerMillionUsd();

    const walletUsd = walletLtc * ltcUsd;
    const maxSellDonuts = (walletUsd / pricePerMillionUsd) * 1_000_000;

    const updatedEmbed = EmbedBuilder.from(message.embeds[0]).setFields(
      { name: 'Current Rate –', value: `\`${formatRate(pricePerMillionUsd)}\``, inline: false },
      { name: 'USD Balance –', value: `\`$${walletUsd.toFixed(2)}\``, inline: false },
      { name: 'LTC Balance –', value: `\`${walletLtc.toFixed(4)} LTC\``, inline: false },
      { name: 'Max Sell –', value: `\`${(maxSellDonuts / 1_000_000).toFixed(2)}m\``, inline: false },
    );

    await message.edit({ embeds: [updatedEmbed] });

    updateVoiceChannelName(walletUsd).catch(() => null);
  } catch (err) {
    console.error('[Panel] Failed to refresh panel:', err.message);
  }
}

module.exports = { setPanelClient, refreshPanel };
