const { SlashCommandBuilder } = require('discord.js');
const {
  handleAdminInviteView,
  handleAdminInviteAdd,
  handleAdminInviteSet,
  handleAdminInviteRemove,
  handleAdminInviteToggle,
} = require('../systems/inviteRewards');

function buildInviteCommand(invitesEnabled = true) {
  const statusLabel = invitesEnabled ? 'currently enabled' : 'currently disabled';
  return new SlashCommandBuilder()
    .setName('invite')
    .setDescription('Admin invite management')
    .addSubcommand(sub =>
      sub
        .setName('toggle')
        .setDescription(`Toggle invite tracking and rewards on/off (${statusLabel})`),
    )
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
        .setDescription("Remove payable invites from a user's count")
        .addUserOption(opt =>
          opt.setName('user').setDescription('The inviter to remove payable invites from').setRequired(true),
        )
        .addIntegerOption(opt =>
          opt.setName('count').setDescription('Number of payable invites to remove (omit to remove all)').setMinValue(1).setRequired(false),
        ),
    );
}

module.exports = {
  buildInviteCommand,
  data: buildInviteCommand(true),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'toggle') return handleAdminInviteToggle(interaction);
    if (sub === 'view') return handleAdminInviteView(interaction);
    if (sub === 'add') return handleAdminInviteAdd(interaction);
    if (sub === 'set') return handleAdminInviteSet(interaction);
    if (sub === 'remove') return handleAdminInviteRemove(interaction);
  },
};
