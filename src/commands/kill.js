const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { updateSettings } = require('../lib/botSettings');

function getAdminIds() {
  return (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kill')
    .setDescription('Pause the auto-sell system — stops accepting new DonutSMP money → LTC sell requests (admins only)'),

  async execute(interaction) {
    if (!getAdminIds().includes(interaction.user.id)) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('You do not have permission to use this command.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    await updateSettings({ isKilled: true });

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xED4245)
          .setTitle('🔴 Bot Paused')
          .setDescription('The bot is now paused. No new sell requests will be accepted until `/start` is run.'),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};
