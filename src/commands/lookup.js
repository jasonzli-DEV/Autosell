const { SlashCommandBuilder } = require('discord.js');
const { handleLookupCommand } = require('../systems/lookup');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lookup')
    .setDescription('Look up ticket details by ID, user, name, or transcript text')
    .addStringOption(opt =>
      opt
        .setName('ticket')
        .setDescription('Ticket code, user ID/mention, or ticket detail text')
        .setRequired(true)
        .setMaxLength(64),
    )
    .addBooleanOption(opt =>
      opt
        .setName('search_transcripts')
        .setDescription('Search transcript files too (default: true)')
        .setRequired(false),
    ),

  async execute(interaction) {
    await handleLookupCommand(interaction);
  },
};
