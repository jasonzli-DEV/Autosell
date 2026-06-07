const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getWalletAddress, getWalletBalanceLtc } = require('../lib/ltc');
const { getSettings } = require('../lib/botSettings');
const { refreshPanel } = require('../lib/panelManager');

function getAdminIds() {
  return (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pay')
    .setDescription('Show the bot LTC deposit address (admins only)'),

  async execute(interaction) {
    if (!getAdminIds().includes(interaction.user.id)) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('You do not have permission to use this command.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const address = getWalletAddress();
      const walletLtc = await getWalletBalanceLtc();

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('💳 Bot LTC Deposit Address')
            .setDescription('Send LTC to the address below to fund the bot\'s wallet.')
            .addFields(
              { name: 'Deposit Address', value: `\`${address}\``, inline: false },
              { name: 'Current Balance', value: `${walletLtc.toFixed(8)} LTC`, inline: true },
            ),
        ],
      });

      const settings = await getSettings();
      if (settings.panelChannelId && settings.panelMessageId) {
        await refreshPanel(settings.panelChannelId, settings.panelMessageId);
      }
    } catch (err) {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`Error: ${err.message}`)],
      });
    }
  },
};
