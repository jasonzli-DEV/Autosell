const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const { getLtcUsdPrice } = require('../lib/price');
const { getWalletBalanceLtc } = require('../lib/ltc');
const { getPricePerMillionUsd, updateSettings } = require('../lib/botSettings');
const { postInviteRewardPanel } = require('../systems/inviteRewards');

function getAdminIds() {
  return (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}

function formatRate(pricePerMillionUsd) {
  const per100m = pricePerMillionUsd * 100;
  return `${parseFloat(per100m.toFixed(2))}Usd per 100m`;
}

async function buildPanelEmbed() {
  const ltcUsd = await getLtcUsdPrice();
  const walletLtc = await getWalletBalanceLtc();
  const pricePerMillionUsd = await getPricePerMillionUsd();

  const walletUsd = walletLtc * ltcUsd;
  const maxSellDonuts = (walletUsd / pricePerMillionUsd) * 1_000_000;

  return new EmbedBuilder()
    .setTitle('Money AutoSell')
    .setColor(0x2b2d31)
    .setDescription([
      'Setup your IGN and LTC address using `Settings`',
      'Click Sell and use the exact command shown in the reply',
      'Use the same IGN in settings that you pay from in-game',
      'Payments under `10m` are ignored',
    ].join('\n'))
    .addFields(
      { name: 'Current Rate –', value: `\`${formatRate(pricePerMillionUsd)}\``, inline: false },
      { name: 'USD Balance –', value: `\`$${walletUsd.toFixed(2)}\``, inline: false },
      { name: 'LTC Balance –', value: `\`${walletLtc.toFixed(4)} LTC\``, inline: false },
      { name: 'Max Sell –', value: `\`${(maxSellDonuts / 1_000_000).toFixed(2)}m\``, inline: false },
    );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Panel management (admins only)')
    .addSubcommand(sub =>
      sub.setName('post').setDescription('Post the DonutSMP → LTC trading panel'),
    )
    .addSubcommand(sub =>
      sub.setName('invite-rewards').setDescription('Post the invite reward claim panel'),
    ),

  async execute(interaction) {
    if (!getAdminIds().includes(interaction.user.id)) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('You do not have permission to use this command.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'post') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      let embed;
      try {
        embed = await buildPanelEmbed();
      } catch (err) {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`Failed to fetch data: ${err.message}`)],
        });
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('autosell_sell').setLabel('Sell').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('autosell_balance').setLabel('Balance').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('autosell_settings').setLabel('Settings').setStyle(ButtonStyle.Secondary),
      );

      const panelMessage = await interaction.channel.send({ embeds: [embed], components: [row] });

      await updateSettings({
        panelChannelId: interaction.channel.id,
        panelMessageId: panelMessage.id,
      });

      await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x57F287).setDescription('Panel posted.')] });
    } else if (sub === 'invite-rewards') {
      await postInviteRewardPanel(interaction);
    }
  },
};
