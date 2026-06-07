const { SlashCommandBuilder } = require('discord.js');
const { handleSetPricePanel } = require('../systems/priceSettings');
const { configureInviteRewards } = require('../systems/inviteRewards');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set')
    .setDescription('Admin settings')
    .addSubcommand(sub =>
      sub
        .setName('price')
        .setDescription('Open the price configuration panel'),
    )
    .addSubcommand(sub =>
      sub
        .setName('invite-rewards')
        .setDescription('Configure invite reward payout settings')
        .addIntegerOption(option =>
          option
            .setName('minimum_invites')
            .setDescription('Minimum valid payable invites required to claim')
            .setMinValue(1)
            .setRequired(true),
        )
        .addIntegerOption(option =>
          option
            .setName('payout_per_invite')
            .setDescription('DonutSMP money paid per valid invite')
            .setMinValue(1)
            .setRequired(true),
        ),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'price') {
      await handleSetPricePanel(interaction);
    } else if (sub === 'invite-rewards') {
      await configureInviteRewards(interaction);
    }
  },
};
