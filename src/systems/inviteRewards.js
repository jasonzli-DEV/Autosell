const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { randomUUID } = require('crypto');
const { getSettings, updateSettings } = require('../lib/botSettings');
const { InviteRewardInvite, InviteRewardClaim } = require('../lib/models');
const { getUserSettings } = require('../lib/userSettings');
const { validateIgn } = require('../lib/donut');
const { sendDonutPayment } = require('../lib/minecraftPayer');
const { logInfo, logSuccess, logError } = require('../lib/logger');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_PAYOUT_PER_INVITE = 10_000_000;
const DEFAULT_MINIMUM_INVITES = 5;
const inviteRewardCheckCustomId = 'invite_reward_check';
const inviteRewardClaimCustomId = 'invite_reward_claim';
const inviteRewardClaimModalCustomId = 'invite_reward_claim_modal';

const inviteCache = new Map();

function getAdminIds() {
  return (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}

function isAdmin(interaction) {
  return getAdminIds().includes(interaction.user.id);
}

function positiveInteger(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : fallback;
}

function getInviteRewardConfig(settings = {}) {
  return {
    payoutPerInvite: positiveInteger(settings.inviteRewardPayoutPerInvite, DEFAULT_PAYOUT_PER_INVITE),
    minimumInvites: positiveInteger(settings.inviteRewardMinimumInvites, DEFAULT_MINIMUM_INVITES),
  };
}

function formatDonutAmount(amount) {
  const num = Number(amount);
  if (!Number.isFinite(num)) return '0';
  const units = [
    { suffix: 't', value: 1_000_000_000_000 },
    { suffix: 'b', value: 1_000_000_000 },
    { suffix: 'm', value: 1_000_000 },
    { suffix: 'k', value: 1_000 },
  ];
  const unit = units.find(item => Math.abs(num) >= item.value);
  if (!unit) return `${Math.trunc(num)}`;
  const value = num / unit.value;
  return `${Number(value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2))}${unit.suffix}`;
}

function calculateInviteRewardStats({ invites = [], claimedMemberIds = [] } = {}) {
  const claimed = new Set(claimedMemberIds);
  const stats = {
    total: invites.length,
    left: 0,
    fake: 0,
    rejoin: 0,
    payable: 0,
    claimed: 0,
    claimable: 0,
    claimableMemberIds: [],
  };

  for (const invite of invites) {
    const memberId = `${invite.memberId || ''}`;
    const isClaimed = claimed.has(memberId) || Boolean(invite.claimedAt) || invite.claimStatus === 'paid';
    if (invite.leftAt) stats.left += 1;
    if (invite.fake) stats.fake += 1;
    if (invite.rejoin) stats.rejoin += 1;
    if (isClaimed) stats.claimed += 1;

    if (!invite.leftAt && !invite.fake && !invite.rejoin) {
      stats.payable += 1;
      if (!isClaimed && invite.claimStatus !== 'pending') {
        stats.claimable += 1;
        if (memberId) stats.claimableMemberIds.push(memberId);
      }
    }
  }

  return stats;
}

function buildPayCommand(ign, amount) {
  return `/pay ${`${ign || ''}`.trim()} ${Math.trunc(Number(amount) || 0)}`;
}

function parsePaymentChatMessage(message, position) {
  const lower = `${message || ''}`.toLowerCase();
  if (!lower) return null;
  if (
    lower.includes('insufficient') ||
    lower.includes('not have enough') ||
    lower.includes('need more money') ||
    lower.includes("can't afford") ||
    lower.includes('cannot afford')
  ) {
    return { type: 'insufficient_balance' };
  }
  if (
    lower.includes('cannot process') ||
    lower.includes('unable to process') ||
    lower.includes('we are sorry') ||
    lower.includes('we am sorry') ||
    lower.includes('transaction failed') ||
    lower.includes('payment failed') ||
    lower.includes('could not complete')
  ) {
    return { type: 'payment_rejected' };
  }
  if (
    lower.includes('player not found') ||
    lower.includes('could not find') ||
    lower.includes('never joined') ||
    lower.includes('invalid player')
  ) {
    return { type: 'invalid_player' };
  }
  // Only accept payment confirmations from system messages, not player chat,
  // to prevent player chat containing "paid" from triggering a false positive.
  if (position && position !== 'system') return null;
  if (
    lower.includes(' paid ') ||
    lower.startsWith('paid ') ||
    lower.includes('successfully paid') ||
    lower.includes('sent $') ||
    lower.includes('you paid')
  ) {
    return { type: 'paid' };
  }
  return null;
}

async function getInviteRewardStats(guildId, inviterId) {
  const invites = await InviteRewardInvite.find({ guildId, inviterId }).sort({ joinedAt: 1 }).lean();
  return calculateInviteRewardStats({ invites });
}

function inviteRewardPanelEmbed(config) {
  const payoutText = formatDonutAmount(config.payoutPerInvite);
  return new EmbedBuilder()
    .setColor(0xffb02e)
    .setTitle('Invite Pay Rewards')
    .setDescription([
      `Earn **${payoutText}** per valid invite.`,
      '',
      'Rewards are paid automatically in queue order.',
      'Logs are sent to the invite reward logs channel.',
      '',
      '**How valid invites work**',
      'Only members who stay in the server count.',
      'Accounts created less than **30 days** ago are marked fake.',
      'Left, fake, and rejoin users are not paid.',
      '',
      '**Check Invites**',
      'See your total, left, rejoin, fake, and payable invites.',
      '**Claim Reward**',
      `Requires at least **${config.minimumInvites}** valid payable invites. Payout goes to the IGN you enter.`,
    ].join('\n'))
    .setFooter({ text: `${payoutText.toUpperCase()} per invite | Donut Delivery invite reward system` })
    .setTimestamp();
}

function inviteRewardPanelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(inviteRewardCheckCustomId)
        .setLabel('Check Invites')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(inviteRewardClaimCustomId)
        .setLabel('Claim Your Reward')
        .setStyle(ButtonStyle.Success),
    ),
  ];
}

function statsEmbed(stats, config) {
  const claimableAmount = stats.claimable * config.payoutPerInvite;
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('Invite Reward Stats')
    .addFields(
      { name: 'Total Invites', value: `\`${stats.total}\``, inline: true },
      { name: 'Left', value: `\`${stats.left}\``, inline: true },
      { name: 'Rejoin', value: `\`${stats.rejoin}\``, inline: true },
      { name: 'Fake', value: `\`${stats.fake}\``, inline: true },
      { name: 'Payable', value: `\`${stats.payable}\``, inline: true },
      { name: 'Claimable', value: `\`${stats.claimable}\``, inline: true },
      { name: 'Claimable Reward', value: `\`${formatDonutAmount(claimableAmount)}\``, inline: false },
    )
    .setDescription(`Minimum to claim: **${config.minimumInvites}** valid payable invites.`);
}

function errorEmbed(description) {
  return new EmbedBuilder().setColor(0xED4245).setDescription(description);
}

function successEmbed(description) {
  return new EmbedBuilder().setColor(0x57F287).setDescription(description);
}

async function handleInviteRewardCheck(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const settings = await getSettings();
  const config = getInviteRewardConfig(settings);
  const stats = await getInviteRewardStats(interaction.guildId, interaction.user.id);

  await logInfo(
    'Invite Reward Check',
    `<@${interaction.user.id}> checked invite reward stats.`,
    [
      { name: 'Claimable', value: `${stats.claimable}`, inline: true },
      { name: 'Payable', value: `${stats.payable}`, inline: true },
    ],
    { category: 'invite' },
  );

  return interaction.editReply({ embeds: [statsEmbed(stats, config)] });
}

function claimIgnModal(defaultIgn = '') {
  const input = new TextInputBuilder()
    .setCustomId('ign')
    .setLabel('Minecraft IGN')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(32)
    .setPlaceholder('e.g. YourUsername');

  if (defaultIgn) input.setValue(defaultIgn);

  return new ModalBuilder()
    .setCustomId(inviteRewardClaimModalCustomId)
    .setTitle('Claim Invite Reward')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

async function handleInviteRewardClaimButton(interaction) {
  const settings = await getUserSettings(interaction.user.id);
  if (!settings?.ign) {
    await logInfo('Invite Reward Claim Needs IGN', `<@${interaction.user.id}> opened the reward IGN modal.`, [], { category: 'invite' });
    return interaction.showModal(claimIgnModal());
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return processInviteRewardClaim(interaction, settings.ign);
}

async function handleInviteRewardClaimModal(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const ign = interaction.fields.getTextInputValue('ign').trim();
  return processInviteRewardClaim(interaction, ign);
}

async function processInviteRewardClaim(interaction, ign) {
  const settings = await getSettings();
  const config = getInviteRewardConfig(settings);
  const stats = await getInviteRewardStats(interaction.guildId, interaction.user.id);

  await logInfo(
    'Invite Reward Claim Attempt',
    `<@${interaction.user.id}> is claiming invite rewards for **${ign}**.`,
    [
      { name: 'Claimable Invites', value: `${stats.claimable}`, inline: true },
      { name: 'Minimum', value: `${config.minimumInvites}`, inline: true },
    ],
    { category: 'invite' },
  );

  if (stats.claimable < config.minimumInvites) {
    return interaction.editReply({
      embeds: [errorEmbed(`You need at least **${config.minimumInvites}** valid payable invites to claim. You currently have **${stats.claimable}**.`)],
    });
  }

  let ignResult;
  try {
    ignResult = await validateIgn(ign);
  } catch (err) {
    await logError('Invite Reward IGN Validation Failed', `${ign}: ${err.message}`, [], { category: 'invite' });
    return interaction.editReply({ embeds: [errorEmbed(`Couldn't validate IGN: ${err.message}`)] });
  }

  if (!ignResult.valid) {
    await logError('Invite Reward Invalid IGN', `${ign}: ${ignResult.reason}`, [], { category: 'invite' });
    return interaction.editReply({ embeds: [errorEmbed(ignResult.reason)] });
  }

  const lockId = randomUUID();
  const lockResult = await InviteRewardInvite.updateMany(
    {
      guildId: interaction.guildId,
      inviterId: interaction.user.id,
      memberId: { $in: stats.claimableMemberIds },
      fake: false,
      rejoin: false,
      leftAt: null,
      claimStatus: 'open',
      claimedAt: null,
    },
    { $set: { claimStatus: 'pending', claimLockId: lockId } },
  );

  const lockedInvites = await InviteRewardInvite.find({ claimLockId: lockId }).sort({ joinedAt: 1 });
  if (lockedInvites.length < config.minimumInvites) {
    await InviteRewardInvite.updateMany({ claimLockId: lockId }, { $set: { claimStatus: 'open', claimLockId: null } });
    return interaction.editReply({
      embeds: [errorEmbed('Your claimable invite count changed while claiming. Check invites and try again.')],
    });
  }

  const amount = lockedInvites.length * config.payoutPerInvite;
  const normalizedIgn = ignResult.normalized;
  const payCommand = buildPayCommand(normalizedIgn, amount);

  try {
    await sendDonutPayment(normalizedIgn, amount, parsePaymentChatMessage);
  } catch (err) {
    await InviteRewardInvite.updateMany({ claimLockId: lockId }, { $set: { claimStatus: 'open', claimLockId: null } });
    await InviteRewardClaim.create({
      guildId: interaction.guildId,
      inviterId: interaction.user.id,
      ign: normalizedIgn,
      memberIds: lockedInvites.map(invite => invite.memberId),
      inviteCount: lockedInvites.length,
      payoutPerInvite: config.payoutPerInvite,
      amount,
      payCommand,
      status: 'failed',
      error: err.message,
    }).catch(() => null);
    await logError(
      err.type === 'insufficient_balance' ? 'Invite Reward Insufficient Balance' : 'Invite Reward Payout Failed',
      `<@${interaction.user.id}> payout to **${normalizedIgn}** failed: ${err.message}`,
      [
        { name: 'Amount', value: formatDonutAmount(amount), inline: true },
        { name: 'Command', value: `\`${payCommand}\``, inline: false },
      ],
      { category: 'invite' },
    );
    return interaction.editReply({ embeds: [errorEmbed(`Payout failed: ${err.message}`)] });
  }

  const claim = await InviteRewardClaim.create({
    guildId: interaction.guildId,
    inviterId: interaction.user.id,
    ign: normalizedIgn,
    memberIds: lockedInvites.map(invite => invite.memberId),
    inviteCount: lockedInvites.length,
    payoutPerInvite: config.payoutPerInvite,
    amount,
    payCommand,
    status: 'paid',
  });

  await InviteRewardInvite.updateMany(
    { claimLockId: lockId },
    { $set: { claimStatus: 'paid', claimedAt: new Date(), claimId: claim._id, claimLockId: null } },
  );

  await logSuccess(
    'Invite Reward Paid',
    `<@${interaction.user.id}> was paid **${formatDonutAmount(amount)}** to **${normalizedIgn}**.`,
    [
      { name: 'Invites Paid', value: `${lockedInvites.length}`, inline: true },
      { name: 'Command', value: `\`${payCommand}\``, inline: false },
    ],
    { category: 'invite' },
  );

  return interaction.editReply({
    embeds: [successEmbed(`Paid **${formatDonutAmount(amount)}** to **${normalizedIgn}** for **${lockedInvites.length}** valid invites.`)],
  });
}

async function handleAdminInviteView(interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({ embeds: [errorEmbed('You do not have permission to use this command.')], flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const settings = await getSettings();
  const config = getInviteRewardConfig(settings);
  const user = interaction.options.getUser('user');
  const invites = await InviteRewardInvite.find({ guildId: interaction.guildId, inviterId: user.id }).sort({ joinedAt: 1 }).lean();
  const stats = calculateInviteRewardStats({ invites });
  const bonusCount = invites.filter(i => i.synthetic).length;
  const claimableAmount = stats.claimable * config.payoutPerInvite;

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`Invite Stats — ${user.username}`)
    .addFields(
      { name: 'Total', value: `\`${stats.total}\``, inline: true },
      { name: 'Left', value: `\`${stats.left}\``, inline: true },
      { name: 'Rejoin', value: `\`${stats.rejoin}\``, inline: true },
      { name: 'Fake', value: `\`${stats.fake}\``, inline: true },
      { name: 'Payable', value: `\`${stats.payable}\``, inline: true },
      { name: 'Claimable', value: `\`${stats.claimable}\``, inline: true },
      { name: 'Bonus (Admin)', value: `\`${bonusCount}\``, inline: true },
      { name: 'Claimable Reward', value: `\`${formatDonutAmount(claimableAmount)}\``, inline: false },
    )
    .setDescription(`Minimum to claim: **${config.minimumInvites}** valid payable invites.`);

  return interaction.editReply({ embeds: [embed] });
}

async function handleAdminInviteAdd(interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({ embeds: [errorEmbed('You do not have permission to use this command.')], flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const user = interaction.options.getUser('user');
  const count = interaction.options.getInteger('count');

  const records = Array.from({ length: count }, () => ({
    guildId: interaction.guildId,
    inviterId: user.id,
    inviterTag: user.tag || user.username || null,
    memberId: randomUUID(),
    memberTag: 'synthetic',
    inviteCode: 'admin',
    joinedAt: new Date(),
    accountCreatedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
    fake: false,
    rejoin: false,
    synthetic: true,
  }));

  await InviteRewardInvite.insertMany(records);

  await logSuccess(
    'Admin Invite Add',
    `<@${interaction.user.id}> added **${count}** bonus invite(s) to <@${user.id}>.`,
    [{ name: 'Added', value: `${count}`, inline: true }],
    { category: 'invite' },
  );

  return interaction.editReply({ embeds: [successEmbed(`Added **${count}** bonus invite(s) to <@${user.id}>.`)] });
}

async function handleAdminInviteSet(interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({ embeds: [errorEmbed('You do not have permission to use this command.')], flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const user = interaction.options.getUser('user');
  const target = interaction.options.getInteger('count');

  const existing = await InviteRewardInvite.find({
    guildId: interaction.guildId,
    inviterId: user.id,
    synthetic: true,
    claimStatus: 'open',
  }).lean();
  const current = existing.length;

  if (target > current) {
    const toAdd = target - current;
    const records = Array.from({ length: toAdd }, () => ({
      guildId: interaction.guildId,
      inviterId: user.id,
      inviterTag: user.tag || user.username || null,
      memberId: randomUUID(),
      memberTag: 'synthetic',
      inviteCode: 'admin',
      joinedAt: new Date(),
      accountCreatedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
      fake: false,
      rejoin: false,
      synthetic: true,
    }));
    await InviteRewardInvite.insertMany(records);
  } else if (target < current) {
    const ids = existing.slice(0, current - target).map(r => r._id);
    await InviteRewardInvite.deleteMany({ _id: { $in: ids } });
  }

  await logSuccess(
    'Admin Invite Set',
    `<@${interaction.user.id}> set bonus invites for <@${user.id}> to **${target}**.`,
    [
      { name: 'Previous', value: `${current}`, inline: true },
      { name: 'New', value: `${target}`, inline: true },
    ],
    { category: 'invite' },
  );

  return interaction.editReply({ embeds: [successEmbed(`Set bonus invites for <@${user.id}> to **${target}** (was **${current}**).`)] });
}

async function handleAdminInviteRemove(interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({ embeds: [errorEmbed('You do not have permission to use this command.')], flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const member = interaction.options.getUser('member');

  const invite = await InviteRewardInvite.findOne({
    guildId: interaction.guildId,
    memberId: member.id,
    leftAt: null,
    synthetic: false,
  }).lean();

  if (!invite) {
    const alreadyRemoved = await InviteRewardInvite.exists({ guildId: interaction.guildId, memberId: member.id, synthetic: false });
    const msg = alreadyRemoved
      ? `<@${member.id}>'s invite has already been removed.`
      : `No invite record found for <@${member.id}>.`;
    return interaction.editReply({ embeds: [errorEmbed(msg)] });
  }

  await InviteRewardInvite.updateOne({ _id: invite._id }, { $set: { leftAt: new Date() } });

  await logSuccess(
    'Admin Invite Remove',
    `<@${interaction.user.id}> removed the invite for <@${member.id}> (credited to <@${invite.inviterId}>).`,
    [{ name: 'Inviter', value: `<@${invite.inviterId}>`, inline: true }],
    { category: 'invite' },
  );

  return interaction.editReply({
    embeds: [successEmbed(`Removed invite for <@${member.id}>. They were credited to <@${invite.inviterId}> and cannot be credited again.`)],
  });
}

async function postInviteRewardPanel(interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({
      embeds: [errorEmbed('You do not have permission to use this command.')],
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const settings = await getSettings();
  const config = getInviteRewardConfig(settings);
  const message = await interaction.channel.send({
    embeds: [inviteRewardPanelEmbed(config)],
    components: inviteRewardPanelRows(),
  });

  await updateSettings({
    inviteRewardPanelChannelId: interaction.channel.id,
    inviteRewardPanelMessageId: message.id,
  });

  await logSuccess('Invite Reward Panel Posted', `<@${interaction.user.id}> posted the invite reward panel in <#${interaction.channel.id}>.`, [], { category: 'invite' });

  return interaction.editReply({ embeds: [successEmbed('Invite reward panel posted.')] });
}

async function configureInviteRewards(interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({
      embeds: [errorEmbed('You do not have permission to use this command.')],
      flags: MessageFlags.Ephemeral,
    });
  }

  const minimumInvites = interaction.options.getInteger('minimum_invites');
  const payoutPerInvite = interaction.options.getInteger('payout_per_invite');
  if (!Number.isInteger(minimumInvites) || minimumInvites <= 0 || !Number.isInteger(payoutPerInvite) || payoutPerInvite <= 0) {
    return interaction.reply({
      embeds: [errorEmbed('Minimum invites and payout per invite must both be positive whole numbers.')],
      flags: MessageFlags.Ephemeral,
    });
  }

  const settings = await updateSettings({
    inviteRewardMinimumInvites: minimumInvites,
    inviteRewardPayoutPerInvite: payoutPerInvite,
  });
  const config = getInviteRewardConfig(settings);

  await refreshInviteRewardPanel(interaction.client).catch(() => null);
  await logSuccess(
    'Invite Reward Settings Updated',
    `<@${interaction.user.id}> updated invite reward settings.`,
    [
      { name: 'Minimum Invites', value: `${minimumInvites}`, inline: true },
      { name: 'Payout Per Invite', value: formatDonutAmount(payoutPerInvite), inline: true },
    ],
    { category: 'invite' },
  );

  return interaction.reply({
    embeds: [successEmbed(`Invite rewards updated: **${formatDonutAmount(config.payoutPerInvite)}** per invite, minimum **${config.minimumInvites}** invites.`)],
    flags: MessageFlags.Ephemeral,
  });
}

async function refreshInviteRewardPanel(client) {
  const settings = await getSettings();
  if (!settings.inviteRewardPanelChannelId || !settings.inviteRewardPanelMessageId) return;
  const channel = await client.channels.fetch(settings.inviteRewardPanelChannelId).catch(() => null);
  if (!channel) return;
  const message = await channel.messages.fetch(settings.inviteRewardPanelMessageId).catch(() => null);
  if (!message) return;
  const config = getInviteRewardConfig(settings);
  await message.edit({ embeds: [inviteRewardPanelEmbed(config)], components: inviteRewardPanelRows() });
}

function cacheFromInvites(invites) {
  const next = new Map();
  for (const invite of invites.values()) {
    next.set(invite.code, {
      code: invite.code,
      uses: invite.uses || 0,
      inviterId: invite.inviter?.id || null,
      inviterTag: invite.inviter?.tag || invite.inviter?.username || null,
    });
  }
  return next;
}

async function refreshGuildInviteCache(guild) {
  const invites = await guild.invites.fetch();
  inviteCache.set(guild.id, cacheFromInvites(invites));
  return invites;
}

function findUsedInvite(before = new Map(), afterInvites) {
  for (const invite of afterInvites.values()) {
    const oldUses = before.get(invite.code)?.uses || 0;
    const newUses = invite.uses || 0;
    if (newUses > oldUses) return invite;
  }
  return null;
}

async function handleInviteRewardMemberAdd(member) {
  const before = inviteCache.get(member.guild.id) || new Map();
  let afterInvites;
  try {
    afterInvites = await refreshGuildInviteCache(member.guild);
  } catch (err) {
    await logError('Invite Reward Tracking Failed', `Could not fetch invites for **${member.guild.name}** after <@${member.id}> joined: ${err.message}`, [], { category: 'join' });
    return;
  }

  const usedInvite = findUsedInvite(before, afterInvites);
  if (!usedInvite?.inviter?.id) {
    await logError('Invite Reward Join Not Counted', `Could not determine which invite was used by <@${member.id}>.`, [], { category: 'join' });
    return;
  }

  const joinedAt = member.joinedAt || new Date();
  const accountCreatedAt = member.user.createdAt || new Date(0);
  const fake = joinedAt.getTime() - accountCreatedAt.getTime() < THIRTY_DAYS_MS;
  const previousInvite = await InviteRewardInvite.exists({ guildId: member.guild.id, memberId: member.id });
  const rejoin = Boolean(previousInvite);

  await InviteRewardInvite.create({
    guildId: member.guild.id,
    inviterId: usedInvite.inviter.id,
    inviterTag: usedInvite.inviter.tag || usedInvite.inviter.username || null,
    memberId: member.id,
    memberTag: member.user.tag || member.user.username || null,
    inviteCode: usedInvite.code,
    joinedAt,
    accountCreatedAt,
    fake,
    rejoin,
  });

  await logInfo(
    fake || rejoin ? 'Invite Reward Join Tracked As Invalid' : 'Invite Reward Join Tracked',
    `<@${member.id}> joined using invite **${usedInvite.code}** from <@${usedInvite.inviter.id}>.`,
    [
      { name: 'Fake', value: fake ? 'Yes' : 'No', inline: true },
      { name: 'Rejoin', value: rejoin ? 'Yes' : 'No', inline: true },
    ],
    { category: 'join' },
  );
}

async function handleInviteRewardMemberRemove(member) {
  const result = await InviteRewardInvite.updateMany(
    { guildId: member.guild.id, memberId: member.id, leftAt: null, claimStatus: { $ne: 'paid' } },
    { $set: { leftAt: new Date() } },
  );

  if (result.modifiedCount > 0) {
    await logInfo('Invite Reward Member Left', `<@${member.id}> left, so their invite is no longer payable.`, [], { category: 'join' });
  }
}

function initializeInviteRewardTracking(client) {
  client.once('clientReady', async () => {
    for (const guild of client.guilds.cache.values()) {
      try {
        await refreshGuildInviteCache(guild);
        await logInfo('Invite Reward Cache Ready', `Cached invites for **${guild.name}**.`, [], { category: 'invite' });
      } catch (err) {
        await logError('Invite Reward Cache Failed', `Could not cache invites for **${guild.name}**: ${err.message}`, [], { category: 'invite' });
      }
    }
  });

  client.on('inviteCreate', async invite => {
    try {
      await refreshGuildInviteCache(invite.guild);
    } catch (err) {
      await logError('Invite Reward Invite Cache Failed', `Could not refresh after invite create: ${err.message}`, [], { category: 'invite' });
    }
  });

  client.on('inviteDelete', async invite => {
    try {
      await refreshGuildInviteCache(invite.guild);
    } catch (err) {
      await logError('Invite Reward Invite Cache Failed', `Could not refresh after invite delete: ${err.message}`, [], { category: 'invite' });
    }
  });

  client.on('guildMemberAdd', member => {
    handleInviteRewardMemberAdd(member).catch(err => {
      console.error('[InviteRewards] Failed to track member join:', err);
      logError('Invite Reward Join Handler Failed', err.message, [], { category: 'join' }).catch(() => null);
    });
  });

  client.on('guildMemberRemove', member => {
    handleInviteRewardMemberRemove(member).catch(err => {
      console.error('[InviteRewards] Failed to track member leave:', err);
      logError('Invite Reward Leave Handler Failed', err.message, [], { category: 'join' }).catch(() => null);
    });
  });
}

module.exports = {
  DEFAULT_PAYOUT_PER_INVITE,
  DEFAULT_MINIMUM_INVITES,
  inviteRewardCheckCustomId,
  inviteRewardClaimCustomId,
  inviteRewardClaimModalCustomId,
  getInviteRewardConfig,
  formatDonutAmount,
  calculateInviteRewardStats,
  buildPayCommand,
  parsePaymentChatMessage,
  inviteRewardPanelEmbed,
  inviteRewardPanelRows,
  handleInviteRewardCheck,
  handleInviteRewardClaimButton,
  handleInviteRewardClaimModal,
  handleAdminInviteView,
  handleAdminInviteAdd,
  handleAdminInviteSet,
  handleAdminInviteRemove,
  postInviteRewardPanel,
  configureInviteRewards,
  initializeInviteRewardTracking,
  handleInviteRewardMemberAdd,
  handleInviteRewardMemberRemove,
};
