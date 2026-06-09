const { SlashCommandBuilder } = require('discord.js');
const {
  handleAdminInviteView,
  handleAdminInviteAdd,
  handleAdminInviteSet,
  handleAdminInviteRemove,
} = require('../systems/inviteRewards');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('invite')
    .setDescription('Admin invite management')
    .addSubcommand(sub =>
      sub
        .setName('view')
        .setDescription("View a user's invite stats")
        .addUserOption(opt =>
          opt.setName('user').setDescription('The user to view').setRequired(true),
        ),
    )
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription('Add bonus invites to a user')
        .addUserOption(opt =>
          opt.setName('user').setDescription('The user to add invites for').setRequired(true),
        )
        .addIntegerOption(opt =>
          opt.setName('count').setDescription('Number of bonus invites to add').setMinValue(1).setRequired(true),
        ),
    )
    .addSubcommand(sub =>
      sub
        .setName('set')
        .setDescription("Set a user's bonus invite count")
        .addUserOption(opt =>
          opt.setName('user').setDescription('The user to set invites for').setRequired(true),
        )
        .addIntegerOption(opt =>
          opt.setName('count').setDescription('Number of bonus invites to set').setMinValue(0).setRequired(true),
        ),
    )
    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription('Remove bonus invites from a user')
        .addUserOption(opt =>
          opt.setName('user').setDescription('The user to remove invites from').setRequired(true),
        )
        .addIntegerOption(opt =>
          opt.setName('count').setDescription('Number of bonus invites to remove (omit to remove all)').setMinValue(1).setRequired(false),
        ),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'view') return handleAdminInviteView(interaction);
    if (sub === 'add') return handleAdminInviteAdd(interaction);
    if (sub === 'set') return handleAdminInviteSet(interaction);
    if (sub === 'remove') return handleAdminInviteRemove(interaction);
  },
};
