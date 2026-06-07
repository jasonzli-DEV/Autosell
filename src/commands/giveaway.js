const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const { Giveaway } = require('../lib/models');
const { GIVEAWAY_STATUS } = require('../lib/autosellConfig');
const {
  createGiveawayPost,
  endGiveawayEntries,
  rerollGiveawayWinners,
} = require('../systems/giveaway');

function getAdminIds() {
  return (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}

function isStaff(interaction) {
  const staffRoleId = `${process.env.TICKET_STAFF_ROLE_ID || ''}`.trim();
  if (getAdminIds().includes(interaction.user.id)) return true;
  if (staffRoleId && interaction.member?.roles?.cache?.has(staffRoleId)) return true;
  return false;
}

function parseDuration(str) {
  const match = `${str}`.match(/^(\d+(?:\.\d+)?)(m|h|d)$/i);
  if (!match) return null;
  const n = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 'm') return n * 60 * 1000;
  if (unit === 'h') return n * 60 * 60 * 1000;
  if (unit === 'd') return n * 24 * 60 * 60 * 1000;
  return null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Giveaway management (staff only)')
    .addSubcommand(sub =>
      sub
        .setName('start')
        .setDescription('Start a giveaway')
        .addStringOption(opt =>
          opt.setName('prize').setDescription('Prize description (e.g. 10b DonutSMP money)').setRequired(true),
        )
        .addStringOption(opt =>
          opt.setName('duration').setDescription('Duration: 30m, 2h, 1d').setRequired(true),
        )
        .addIntegerOption(opt =>
          opt.setName('winners').setDescription('Number of winners (default 1)').setMinValue(1).setMaxValue(20),
        )
        .addStringOption(opt =>
          opt.setName('claim_duration').setDescription('How long winners have to claim (default 6h)'),
        ),
    )
    .addSubcommand(sub =>
      sub
        .setName('end')
        .setDescription('End a giveaway early')
        .addStringOption(opt =>
          opt.setName('id').setDescription('Giveaway ID (blank = most recent active in this channel)'),
        ),
    )
    .addSubcommand(sub =>
      sub
        .setName('reroll')
        .setDescription('Reroll winners for an ended giveaway')
        .addStringOption(opt =>
          opt.setName('id').setDescription('Giveaway ID (blank = most recent in this channel)'),
        ),
    ),

  async execute(interaction) {
    if (!isStaff(interaction)) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('You do not have permission to use this command.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'start') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const prizeText = interaction.options.getString('prize');
      const durationStr = interaction.options.getString('duration');
      const claimDurationStr = interaction.options.getString('claim_duration') || '6h';
      const winnersCount = interaction.options.getInteger('winners') || 1;

      const entryDurationMs = parseDuration(durationStr);
      if (!entryDurationMs) {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('Invalid duration. Use formats like `30m`, `2h`, `1d`.')],
        });
      }

      const claimDurationMs = parseDuration(claimDurationStr) || 6 * 60 * 60 * 1000;

      const giveaway = await createGiveawayPost({
        guild: interaction.guild,
        channel: interaction.channel,
        prizeText,
        winnersCount,
        entryDurationMs,
        claimDurationMs,
        createdBy: interaction.user.id,
      });

      const entryEndsAt = new Date(giveaway.entryEndsAt);
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0x57F287).setDescription(
          `Giveaway started! Prize: **${prizeText}** — ends <t:${Math.floor(entryEndsAt.getTime() / 1000)}:R>`,
        )],
      });
    }

    if (sub === 'end') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const id = interaction.options.getString('id');
      let giveaway;
      if (id) {
        giveaway = await Giveaway.findOne({ _id: id, status: GIVEAWAY_STATUS.ACTIVE }).catch(() => null);
      } else {
        giveaway = await Giveaway.findOne({ channelId: interaction.channel.id, status: GIVEAWAY_STATUS.ACTIVE }).sort({ createdAt: -1 });
      }

      if (!giveaway) {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('No active giveaway found.')],
        });
      }

      await endGiveawayEntries(giveaway.id);
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0x57F287).setDescription('Giveaway entries ended and winners were rolled.')],
      });
    }

    if (sub === 'reroll') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const id = interaction.options.getString('id');
      let giveaway;
      if (id) {
        giveaway = await Giveaway.findById(id).catch(() => null);
      } else {
        giveaway = await Giveaway.findOne({ channelId: interaction.channel.id }).sort({ createdAt: -1 });
      }

      if (!giveaway) {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('No giveaway found.')],
        });
      }

      const result = await rerollGiveawayWinners(giveaway);
      if (!result.ok) {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(result.reason)],
        });
      }

      if (result.winners.length > 0 && interaction.channel) {
        const content = `🎉 Reroll! New winner(s): ${result.winners.map(id => `<@${id}>`).join(', ')}`;
        const msg = await interaction.channel.send({ content, allowedMentions: { users: result.winners } }).catch(() => null);
        if (msg) setTimeout(() => msg.delete().catch(() => null), 6000);
      }

      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0x57F287).setDescription(
          `Rerolled! New winner(s): ${result.winners.map(id => `<@${id}>`).join(', ')}`,
        )],
      });
    }
  },
};
