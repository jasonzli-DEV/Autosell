const {
  ContainerBuilder,
  TextDisplayBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');
const {
  GIVEAWAY_STATUS,
  btnGiveawayJoinPrefix,
  btnGiveawayLeavePrefix,
  btnGiveawayClaimPrefix,
  giveawayClaimIgnModalPrefix,
} = require('../lib/autosellConfig');
const { Giveaway } = require('../lib/models');
const { giveawayEndTimers, giveawayClaimTimers } = require('../state');

let _client = null;
function setGiveawayClient(c) { _client = c; }

const WINNER_PING_DELETE_DELAY_MS = 4500;

// ── Component builders ────────────────────────────────────────────────────────

function buildGiveawayJoinRow(giveawayId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${btnGiveawayJoinPrefix}:${giveawayId}`)
      .setLabel('Enter Giveaway')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${btnGiveawayLeavePrefix}:${giveawayId}`)
      .setLabel('Leave')
      .setStyle(ButtonStyle.Danger),
  );
}

function buildGiveawayClaimRow(giveawayId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${btnGiveawayClaimPrefix}:${giveawayId}`)
      .setLabel('🎁 Claim Prize 🎁')
      .setStyle(ButtonStyle.Primary),
  );
}

function buildGiveawayContainer(giveaway) {
  const entrantsCount = giveaway.entrants?.length || 0;
  const winners = giveaway.winnerIds || [];
  const claimed = giveaway.claimedByIds || [];
  const prizeText = giveaway.prizeText || '—';

  if (giveaway.status === GIVEAWAY_STATUS.ACTIVE) {
    const entryEndsUnix = Math.floor(new Date(giveaway.entryEndsAt).getTime() / 1000);
    return new ContainerBuilder()
      .setAccentColor(0x2ecc71)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          [
            `## 🎁 ${prizeText} Giveaway`,
            `🏆 **Prize:** ${prizeText}`,
            `👑 **Winners:** ${giveaway.winnersCount}`,
            `🎟️ **Entries:** ${entrantsCount}`,
            `⏰ **Time Left:** <t:${entryEndsUnix}:R>`,
            '',
            'Press **Enter Giveaway** below to participate!',
            '',
            `-# ID: ${giveaway.id}`,
          ].join('\n'),
        ),
      );
  }

  if (giveaway.status === GIVEAWAY_STATUS.CLAIMABLE) {
    const claimEndsUnix = Math.floor(new Date(giveaway.claimEndsAt).getTime() / 1000);
    const winnerMentions = winners.length > 0 ? winners.map(id => `<@${id}>`).join(', ') : 'No winners';
    return new ContainerBuilder()
      .setAccentColor(0xf1c40f)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          [
            `## 🎉 ${prizeText} Giveaway Ended — Claim Your Prize!`,
            `🏆 **Prize:** ${prizeText}`,
            `🎊 **Winners:** ${winnerMentions}`,
            `✅ **Claimed:** ${claimed.length}/${winners.length}`,
            `⏰ **Claim Window Closes:** <t:${claimEndsUnix}:R>`,
            '',
            'If you are a winner, press **Claim Prize** below before the window expires!',
            '',
            `-# ID: ${giveaway.id}`,
          ].join('\n'),
        ),
      );
  }

  const winnerMentions = winners.length > 0 ? winners.map(id => `<@${id}>`).join(', ') : 'No winners';
  return new ContainerBuilder()
    .setAccentColor(0xe74c3c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `## 🔚 ${prizeText} Giveaway Ended`,
          `🏆 **Prize:** ${prizeText}`,
          `🎊 **Winners:** ${winnerMentions}`,
          `✅ **Claimed:** ${claimed.length}/${winners.length}`,
          `🎟️ **Entries:** ${entrantsCount}`,
          `📝 **Reason:** ${giveaway.closeReason || 'Giveaway finished'}`,
          '',
          `-# ID: ${giveaway.id}`,
        ].join('\n'),
      ),
    );
}

// ── Timer helpers ─────────────────────────────────────────────────────────────

function clearGiveawayEndTimer(id) {
  const t = giveawayEndTimers.get(id);
  if (t) { clearTimeout(t); giveawayEndTimers.delete(id); }
}

function clearGiveawayClaimTimer(id) {
  const t = giveawayClaimTimers.get(id);
  if (t) { clearTimeout(t); giveawayClaimTimers.delete(id); }
}

// ── Message refresh ───────────────────────────────────────────────────────────

async function refreshGiveawayMessage(giveaway) {
  if (!giveaway.messageId || !_client) return;
  const guild = await _client.guilds.fetch(giveaway.guildId).catch(() => null);
  if (!guild) return;
  const channel = await guild.channels.fetch(giveaway.channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
  if (!message) return;

  const actionRow = giveaway.status === GIVEAWAY_STATUS.ACTIVE
    ? buildGiveawayJoinRow(giveaway.id)
    : giveaway.status === GIVEAWAY_STATUS.CLAIMABLE
      ? buildGiveawayClaimRow(giveaway.id)
      : null;

  const components = actionRow ? [buildGiveawayContainer(giveaway), actionRow] : [buildGiveawayContainer(giveaway)];
  await message.edit({ components, flags: MessageFlags.IsComponentsV2 }).catch(() => null);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

async function closeGiveaway(giveawayId, reason) {
  const giveaway = await Giveaway.findById(giveawayId);
  if (!giveaway || giveaway.status === GIVEAWAY_STATUS.CLOSED) return;
  clearGiveawayEndTimer(giveaway.id);
  clearGiveawayClaimTimer(giveaway.id);
  giveaway.status = GIVEAWAY_STATUS.CLOSED;
  giveaway.closeReason = reason;
  await giveaway.save();
  await refreshGiveawayMessage(giveaway);
}

function scheduleGiveawayClaimEnd(giveaway) {
  clearGiveawayClaimTimer(giveaway.id);
  if (giveaway.status !== GIVEAWAY_STATUS.CLAIMABLE || !giveaway.claimEndsAt) return;
  const delay = new Date(giveaway.claimEndsAt).getTime() - Date.now();
  if (delay <= 0) { closeGiveaway(giveaway.id, 'Claim window expired').catch(console.error); return; }
  const t = setTimeout(() => closeGiveaway(giveaway.id, 'Claim window expired').catch(console.error), delay);
  giveawayClaimTimers.set(giveaway.id, t);
}

function selectWinners(pool, count) {
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

async function endGiveawayEntries(giveawayId) {
  const giveaway = await Giveaway.findOneAndUpdate(
    { _id: giveawayId, status: GIVEAWAY_STATUS.ACTIVE },
    { $set: { status: GIVEAWAY_STATUS.CLOSED, closeReason: 'rolling' } },
    { returnDocument: 'after' },
  );
  if (!giveaway) return;
  clearGiveawayEndTimer(giveaway.id);

  const entrants = [...new Set(giveaway.entrants || [])].filter(Boolean);
  if (entrants.length === 0) {
    const closed = await Giveaway.findByIdAndUpdate(giveaway.id, { $set: { status: GIVEAWAY_STATUS.CLOSED, closeReason: 'No valid entries' } }, { returnDocument: 'after' });
    await refreshGiveawayMessage(closed || giveaway);
    return;
  }

  const winners = selectWinners(entrants, giveaway.winnersCount);
  if (winners.length === 0) {
    const closed = await Giveaway.findByIdAndUpdate(giveaway.id, { $set: { status: GIVEAWAY_STATUS.CLOSED, closeReason: 'No valid entries' } }, { returnDocument: 'after' });
    await refreshGiveawayMessage(closed || giveaway);
    return;
  }

  const claimable = await Giveaway.findByIdAndUpdate(
    giveaway.id,
    {
      $set: {
        winnerIds: winners,
        claimedByIds: [],
        status: GIVEAWAY_STATUS.CLAIMABLE,
        claimEndsAt: new Date(Date.now() + giveaway.claimDurationMs),
      },
      $unset: { closeReason: '' },
    },
    { returnDocument: 'after' },
  );
  if (!claimable) return;
  await refreshGiveawayMessage(claimable);

  // Ping winners transiently
  if (_client) {
    const guild = await _client.guilds.fetch(claimable.guildId).catch(() => null);
    const channel = guild ? await guild.channels.fetch(claimable.channelId).catch(() => null) : null;
    if (channel) {
      const content = `🎉 Winners: ${winners.map(id => `<@${id}>`).join(', ')}`;
      const msg = await channel.send({ content, allowedMentions: { users: winners } }).catch(() => null);
      if (msg) setTimeout(() => msg.delete().catch(() => null), WINNER_PING_DELETE_DELAY_MS);
    }
  }

  scheduleGiveawayClaimEnd(claimable);
}

function scheduleGiveawayEnd(giveaway) {
  clearGiveawayEndTimer(giveaway.id);
  if (giveaway.status !== GIVEAWAY_STATUS.ACTIVE) return;
  const delay = new Date(giveaway.entryEndsAt).getTime() - Date.now();
  if (delay <= 0) { endGiveawayEntries(giveaway.id).catch(console.error); return; }
  const t = setTimeout(() => endGiveawayEntries(giveaway.id).catch(console.error), delay);
  giveawayEndTimers.set(giveaway.id, t);
}

async function createGiveawayPost({ guild, channel, prizeText, winnersCount, entryDurationMs, claimDurationMs, createdBy }) {
  const giveaway = await Giveaway.create({
    guildId: guild.id,
    channelId: channel.id,
    prizeText,
    winnersCount,
    entryEndsAt: new Date(Date.now() + entryDurationMs),
    claimDurationMs,
    createdBy,
    status: GIVEAWAY_STATUS.ACTIVE,
  });

  const message = await channel.send({
    components: [buildGiveawayContainer(giveaway), buildGiveawayJoinRow(giveaway.id)],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  });

  giveaway.messageId = message.id;
  await giveaway.save();
  scheduleGiveawayEnd(giveaway);
  return giveaway;
}

async function rerollGiveawayWinners(giveaway) {
  if (!giveaway || giveaway.status === GIVEAWAY_STATUS.ACTIVE) {
    return { ok: false, reason: 'Giveaway entries have not ended yet.' };
  }
  const entrants = [...new Set(giveaway.entrants || [])].filter(Boolean);
  if (entrants.length === 0) return { ok: false, reason: 'No entrants to reroll from.' };

  const winners = selectWinners(entrants, giveaway.winnersCount);
  if (winners.length === 0) return { ok: false, reason: 'Could not select winners.' };

  clearGiveawayEndTimer(giveaway.id);
  clearGiveawayClaimTimer(giveaway.id);

  giveaway.winnerIds = winners;
  giveaway.claimedByIds = [];
  giveaway.status = GIVEAWAY_STATUS.CLAIMABLE;
  giveaway.claimEndsAt = new Date(Date.now() + giveaway.claimDurationMs);
  giveaway.closeReason = undefined;
  await giveaway.save();

  await refreshGiveawayMessage(giveaway);
  scheduleGiveawayClaimEnd(giveaway);
  return { ok: true, winners };
}

async function resumeActiveGiveaways() {
  const active = await Giveaway.find({ status: GIVEAWAY_STATUS.ACTIVE });
  for (const g of active) scheduleGiveawayEnd(g);

  const claimable = await Giveaway.find({ status: GIVEAWAY_STATUS.CLAIMABLE });
  for (const g of claimable) scheduleGiveawayClaimEnd(g);

  console.log(`[Giveaway] Resumed ${active.length} active, ${claimable.length} claimable giveaways.`);
}

// ── Button handler ────────────────────────────────────────────────────────────

async function handleGiveawayButton(interaction) {
  const [action, giveawayId] = interaction.customId.split(':');

  if (action === btnGiveawayClaimPrefix) {
    const giveaway = await Giveaway.findById(giveawayId);
    if (!giveaway) {
      return interaction.reply({
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('This giveaway no longer exists.'))],
      });
    }
    if (giveaway.status !== GIVEAWAY_STATUS.CLAIMABLE) {
      return interaction.reply({
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('Claims are not open for this giveaway.'))],
      });
    }
    if (new Date(giveaway.claimEndsAt).getTime() <= Date.now()) {
      await closeGiveaway(giveaway.id, 'Claim window expired');
      return interaction.reply({
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('The claim window has already expired.'))],
      });
    }
    if (!(giveaway.winnerIds || []).includes(interaction.user.id)) {
      return interaction.reply({
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('Only selected winners can claim this giveaway.'))],
      });
    }
    if ((giveaway.claimedByIds || []).includes(interaction.user.id)) {
      return interaction.reply({
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('You already claimed this giveaway.'))],
      });
    }

    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(`${giveawayClaimIgnModalPrefix}:${giveawayId}`)
        .setTitle('Enter Your In-Game Name')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('ign_input')
              .setLabel('In-Game Name (IGN)')
              .setPlaceholder('Enter your IGN')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(50),
          ),
        ),
    );
    return;
  }

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => null);
  }

  const giveaway = await Giveaway.findById(giveawayId);
  if (!giveaway) {
    return interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('This giveaway no longer exists.'))],
    });
  }

  if (action === btnGiveawayJoinPrefix) {
    if (giveaway.status !== GIVEAWAY_STATUS.ACTIVE) {
      return interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('This giveaway is no longer open for entries.'))],
      });
    }
    if (new Date(giveaway.entryEndsAt).getTime() <= Date.now()) {
      await endGiveawayEntries(giveaway.id);
      return interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('Entry time has ended for this giveaway.'))],
      });
    }
    if ((giveaway.entrants || []).includes(interaction.user.id)) {
      return interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('You are already in the giveaway.'))],
      });
    }
    giveaway.entrants.push(interaction.user.id);
    await giveaway.save();
    await refreshGiveawayMessage(giveaway);
    return interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('You are now entered in this giveaway! 🎉'))],
    });
  }

  if (action === btnGiveawayLeavePrefix) {
    if (giveaway.status !== GIVEAWAY_STATUS.ACTIVE) {
      return interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('This giveaway is no longer open for entries.'))],
      });
    }
    if (!(giveaway.entrants || []).includes(interaction.user.id)) {
      return interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('You are not currently entered in this giveaway.'))],
      });
    }
    giveaway.entrants = giveaway.entrants.filter(id => id !== interaction.user.id);
    await giveaway.save();
    await refreshGiveawayMessage(giveaway);
    return interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('You have left the giveaway.'))],
    });
  }
}

// ── Claim IGN modal handler ───────────────────────────────────────────────────

async function handleGiveawayClaimIgnModal(interaction) {
  const [, giveawayId] = interaction.customId.split(':');
  const winnerIgn = interaction.fields.getTextInputValue('ign_input').trim();

  const giveaway = await Giveaway.findById(giveawayId);
  if (!giveaway) {
    return interaction.reply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('Giveaway not found.'))],
    });
  }

  // Create a support ticket for this claim
  const {
    TICKET_TYPES,
    GIVEAWAY_CLAIM_FLOW_STATE,
    btnGiveawayHostPaidPrefix,
  } = require('../lib/autosellConfig');
  const { ensureTicketCategory, getTicketByChannel } = require('./tickets');
  const { Ticket } = require('../lib/models');
  const { STATUS } = require('../lib/autosellConfig');
  const { getSettings } = require('../lib/botSettings');
  const { PermissionFlagsBits, ChannelType } = require('discord.js');

  const existing = await Ticket.findOne({
    guildId: interaction.guild.id,
    openerId: interaction.user.id,
    ticketType: TICKET_TYPES.SUPPORT,
    status: STATUS.OPEN,
    'details.giveawayId': giveawayId,
  });

  if (existing) {
    const existingChannel = await interaction.guild.channels.fetch(existing.channelId).catch(() => null);
    giveaway.claimedByIds.push(interaction.user.id);
    await giveaway.save();
    return interaction.reply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(
        existingChannel ? `Claim ticket already open: ${existingChannel}` : 'Claim ticket already open.',
      ))],
    });
  }

  const settings = await getSettings();
  const staffRoleId = `${process.env.TICKET_STAFF_ROLE_ID || ''}`.trim();
  const category = await ensureTicketCategory(interaction.guild, TICKET_TYPES.SUPPORT);

  const overrides = [
    { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...(staffRoleId ? [{
      id: staffRoleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks],
    }] : []),
    {
      id: interaction.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks],
    },
  ];

  const channel = await interaction.guild.channels.create({
    name: `gw-claim-${`${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: overrides,
  });

  const ticket = await Ticket.create({
    guildId: interaction.guild.id,
    channelId: channel.id,
    parentCategoryId: category.id,
    openerId: interaction.user.id,
    ticketType: TICKET_TYPES.SUPPORT,
    status: STATUS.OPEN,
    details: {
      giveawayId,
      giveawayPrize: giveaway.prizeText,
      winnerIgn,
      isGiveawayClaim: true,
      giveawayCreatedViaButton: true,
      giveawayClaimFlowState: GIVEAWAY_CLAIM_FLOW_STATE.AWAITING_HOST_PAID,
      giveawayHostUserId: giveaway.createdBy,
    },
  });

  const mentionContent = [`<@${interaction.user.id}>`, staffRoleId ? `<@&${staffRoleId}>` : null].filter(Boolean).join(' ');

  const { btnClosePrefix } = require('../lib/autosellConfig');

  const firstMessage = await channel.send({
    content: ' ',
    flags: MessageFlags.IsComponentsV2,
    components: [
      new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent(mentionContent),
      ),
      new ContainerBuilder()
        .setAccentColor(0x3498db)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            [
              '## 🎁 Giveaway Claim Ticket',
              'Staff will verify and process this giveaway claim.',
              '',
              `**Winner:** <@${interaction.user.id}>`,
              `**Prize:** ${giveaway.prizeText}`,
              `**Winner IGN:** ${winnerIgn}`,
            ].join('\n'),
          ),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${btnGiveawayHostPaidPrefix}:${ticket.id}`).setLabel('💸 I Payed').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`${btnClosePrefix}:${ticket.id}`).setLabel('🔒 Close').setStyle(ButtonStyle.Danger),
      ),
    ],
    allowedMentions: { users: [interaction.user.id], roles: staffRoleId ? [staffRoleId] : [] },
  });

  await firstMessage.pin().catch(() => null);
  ticket.details.mainMessageId = firstMessage.id;
  await ticket.save();

  giveaway.claimedByIds.push(interaction.user.id);
  await giveaway.save();

  if ((giveaway.claimedByIds || []).length >= (giveaway.winnerIds || []).length) {
    await closeGiveaway(giveaway.id, 'All winners claimed');
  } else {
    await refreshGiveawayMessage(giveaway);
  }

  await interaction.reply({
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `Claim verified. Your ticket is ready: ${channel}`,
    ))],
  });
}

module.exports = {
  setGiveawayClient,
  buildGiveawayContainer,
  buildGiveawayJoinRow,
  buildGiveawayClaimRow,
  scheduleGiveawayEnd,
  scheduleGiveawayClaimEnd,
  endGiveawayEntries,
  createGiveawayPost,
  rerollGiveawayWinners,
  handleGiveawayButton,
  handleGiveawayClaimIgnModal,
  refreshGiveawayMessage,
  closeGiveaway,
  resumeActiveGiveaways,
  selectWinners,
};
