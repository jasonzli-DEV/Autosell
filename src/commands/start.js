const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { updateSettings } = require('../lib/botSettings');

function getAdminIds() {
  return (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('start')
    .setDescription('Resume the bot — starts accepting sell requests again (admins only)'),

  async execute(interaction) {
    if (!getAdminIds().includes(interaction.user.id)) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('You do not have permission to use this command.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    await updateSettings({ isKilled: false });

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle('🟢 Bot Resumed')
          .setDescription('The bot is now active. Sell requests are being accepted.'),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};
