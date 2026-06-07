const {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const { updateSettings, getSettings } = require('../lib/botSettings');
const { getMoneyBuyPrice } = require('../lib/sellPricing');
const {
  handleTicketClose,
  handleTicketAdd,
  handleTicketRemove,
  buildTicketPanel,
  buildPanelButtonRow,
} = require('../systems/tickets');

function getAdminIds() {
  return (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}

function isAdmin(interaction) {
  return getAdminIds().includes(interaction.user.id);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Ticket management')
    .addSubcommand(sub =>
      sub.setName('panel').setDescription('Post the ticket panel'),
    )
    .addSubcommand(sub =>
      sub.setName('close').setDescription('Close this ticket channel'),
    )
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription('Add a user to this ticket')
        .addUserOption(opt =>
          opt.setName('user').setDescription('User to add').setRequired(true),
        ),
    )
    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription('Remove a user from this ticket')
        .addUserOption(opt =>
          opt.setName('user').setDescription('User to remove').setRequired(true),
        ),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'panel') {
      await handleTicketPanel(interaction);
      return;
    }

    if (sub === 'close') {
      await handleTicketClose(interaction);
      return;
    }

    if (sub === 'add') {
      const target = interaction.options.getUser('user');
      await handleTicketAdd(interaction, target);
      return;
    }

    if (sub === 'remove') {
      const target = interaction.options.getUser('user');
      await handleTicketRemove(interaction, target);
    }
  },
};

async function handleTicketPanel(interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('You do not have permission to use this command.')],
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const settings = await getSettings();
  const panelMessage = await interaction.channel.send({
    components: [
      buildTicketPanel(
        getMoneyBuyPrice(settings) || 0.038,
        settings.spawnerBuyPriceEach || 0.16,
        settings.moneySellPricePerMillion || 0.05,
        settings.spawnerSellPriceEach || 0.2,
      ),
      buildPanelButtonRow(),
    ],
    flags: MessageFlags.IsComponentsV2,
  });

  await updateSettings({
    ticketPanelChannelId: interaction.channel.id,
    ticketPanelMessageId: panelMessage.id,
  });

  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(0x57F287).setDescription('Ticket panel posted.')],
  });
}

module.exports.handleTicketPanel = handleTicketPanel;
