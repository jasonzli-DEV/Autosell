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
  StringSelectMenuBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const {
  TICKET_TYPES,
  TICKET_CATEGORY_NAMES,
  STATUS,
  GIVEAWAY_CLAIM_FLOW_STATE,
  FLOW_TTL_MS,
  panelCategoryCustomId,
  flowPaymentMethodCustomId,
  flowSpawnerUnitCustomId,
  flowSellMoneyModal,
  flowSellSpawnersModal,
  flowBuyMoneyModal,
  flowBuySpawnersModal,
  flowBuyModal,
  flowSupportModal,
  flowConfirmYes,
  flowConfirmNo,
  flowTermsYes,
  flowTermsNo,
  flowCancelConfirmYes,
  flowCancelConfirmNo,
  btnClosePrefix,
  btnClaimPrefix,
  btnGiveawayHostPaidPrefix,
  btnGiveawayClaimerConfirmPrefix,
  flowKey,
  giveawayClaimIgnModalPrefix,
} = require('../lib/autosellConfig');
const { Ticket } = require('../lib/models');
const { getSettings, updateSettings } = require('../lib/botSettings');
const { flowSessions, closeLocks } = require('../state');
const { logInfo } = require('../lib/logger');
const { parseAmount, formatMoney } = require('../utils');
const {
  calculateSellEstimate,
  calculateTradeEstimate,
  formatTicketPanelPrices,
  formatUsd: formatSellUsd,
  getMoneyBuyPrice,
} = require('../lib/sellPricing');
const {
  collectAllMessages,
  buildTranscriptText,
  buildTranscriptHtml,
  buildTranscriptFileAttachments,
  buildTranscriptSummaryPayload,
  buildClosedDmPayload,
  forwardAttachments,
} = require('../lib/ticketTranscript');

// ── Flow session helpers ──────────────────────────────────────────────────────

function cleanOldFlows() {
  const now = Date.now();
  for (const [key, session] of flowSessions.entries()) {
    if (now - session.createdAt > FLOW_TTL_MS) flowSessions.delete(key);
  }
}

function startFlow(guildId, userId, type) {
  cleanOldFlows();
  const session = { guildId, userId, type, createdAt: Date.now(), details: {} };
  flowSessions.set(flowKey(guildId, userId), session);
  return session;
}

function getFlow(guildId, userId) {
  cleanOldFlows();
  return flowSessions.get(flowKey(guildId, userId)) || null;
}

function endFlow(guildId, userId) {
  flowSessions.delete(flowKey(guildId, userId));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sanitizeName(str) {
  return `${str || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 75);
}

function formatUsd(n) {
  return `$${Number(n).toFixed(2)}`;
}

const PAYMENT_METHODS = [
  { label: 'Crypto', value: 'Crypto', description: 'Get paid with crypto' },
  { label: 'PayPal', value: 'PayPal', description: 'Get paid through PayPal' },
  { label: 'Bank Transfer', value: 'Bank Transfer', description: 'Get paid through bank transfer' },
  { label: 'Gift Cards', value: 'Gift Cards', description: 'Get paid with gift cards' },
];

const PANEL_TICKET_OPTIONS = [
  { label: 'Sell Money', value: TICKET_TYPES.SELL_MONEY, description: 'Sell DonutSMP money to us', emoji: '💰', style: ButtonStyle.Success },
  { label: 'Sell Spawners', value: TICKET_TYPES.SELL_SPAWNERS, description: 'Sell skeleton spawners or shulkers', emoji: '💀', style: ButtonStyle.Success },
  { label: 'Buy Money', value: TICKET_TYPES.BUY_MONEY, description: 'Buy DonutSMP money from us', emoji: '🛒', style: ButtonStyle.Primary },
  { label: 'Buy Spawners', value: TICKET_TYPES.BUY_SPAWNERS, description: 'Buy skeleton spawners or shulkers', emoji: '📦', style: ButtonStyle.Primary },
  { label: 'Support', value: TICKET_TYPES.SUPPORT, description: 'Open a support ticket', emoji: '🆘', style: ButtonStyle.Secondary },
];

const SPAWNER_UNITS = {
  EACH: 'each',
  SHULKER: 'shulker',
};

function isSellFlow(type) {
  return type === TICKET_TYPES.SELL_MONEY || type === TICKET_TYPES.SELL_SPAWNERS;
}

function isBuyFlow(type) {
  return type === TICKET_TYPES.BUY_MONEY || type === TICKET_TYPES.BUY_SPAWNERS;
}

function isTradeFlow(type) {
  return isSellFlow(type) || isBuyFlow(type);
}

function isSpawnerFlow(type) {
  return type === TICKET_TYPES.SELL_SPAWNERS || type === TICKET_TYPES.BUY_SPAWNERS;
}

function getStaffRoleId() {
  return `${process.env.TICKET_STAFF_ROLE_ID || ''}`.trim();
}

function isStaff(interaction) {
  const adminIds = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const staffRoleId = getStaffRoleId();
  if (adminIds.includes(interaction.user.id)) return true;
  if (staffRoleId && interaction.member?.roles?.cache?.has(staffRoleId)) return true;
  return false;
}

// ── Category management ───────────────────────────────────────────────────────

async function ensureTicketCategory(guild, ticketType) {
  const settings = await getSettings();
  const savedId = settings.ticketCategoryIds?.[ticketType];

  if (savedId) {
    const saved = await guild.channels.fetch(savedId).catch(() => null);
    if (saved && saved.type === ChannelType.GuildCategory) return saved;
  }

  const name = TICKET_CATEGORY_NAMES[ticketType];
  let existing = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === name) || null;
  if (!existing) {
    const fetched = await guild.channels.fetch().catch(() => null);
    if (fetched) existing = fetched.find(c => c && c.type === ChannelType.GuildCategory && c.name === name) || null;
  }

  if (existing) {
    await updateSettings({ ticketCategoryIds: { ...(settings.ticketCategoryIds || {}), [ticketType]: existing.id } });
    return existing;
  }

  const staffRoleId = getStaffRoleId();
  const overrides = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...(staffRoleId ? [{ id: staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }] : []),
  ];

  const created = await guild.channels.create({ name, type: ChannelType.GuildCategory, permissionOverwrites: overrides });
  await updateSettings({ ticketCategoryIds: { ...(settings.ticketCategoryIds || {}), [ticketType]: created.id } });
  return created;
}

async function maybeDeleteEmptyCategory(guild, categoryId) {
  if (!categoryId) return;
  const category = await guild.channels.fetch(categoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) return;

  await guild.channels.fetch().catch(() => null);
  const children = guild.channels.cache.filter(c => c.parentId === categoryId);
  if (children.size > 0) return;

  await category.delete().catch(() => null);
  const settings = await getSettings();
  const updated = { ...(settings.ticketCategoryIds || {}) };
  for (const [k, v] of Object.entries(updated)) {
    if (v === categoryId) delete updated[k];
  }
  await updateSettings({ ticketCategoryIds: updated });
}

// ── Ticket DB helpers ─────────────────────────────────────────────────────────

async function ensureSingleOpenTicket(guildId, openerId, ticketType) {
  return Ticket.findOne({ guildId, openerId, ticketType, status: STATUS.OPEN });
}

async function getTicketByChannel(channelId) {
  return Ticket.findOne({ channelId, status: STATUS.OPEN });
}

// ── Embed / container builders ────────────────────────────────────────────────

function buildTicketOpeningContainer(member, ticketType, details) {
  const lines = [];

  if (ticketType === TICKET_TYPES.SELL_MONEY) {
    lines.push(
      '## 💰 Sell DonutSMP Money Ticket',
      'Staff will be with you shortly to complete your order.',
      '',
      `**Opener:** ${member}`,
      `**IGN:** ${details.ign || '—'}`,
      `**DonutSMP Money:** ${details.amountText || '—'}`,
      `**Payment Method:** ${details.paymentMethod || '—'}`,
      `**Estimated Value:** ${details.estimatedUsd ? formatSellUsd(details.estimatedUsd) : 'Ask in ticket'}`,
    );
  } else if (ticketType === TICKET_TYPES.SELL_SPAWNERS) {
    lines.push(
      '## 💀 Sell Skeleton Spawners Ticket',
      'Staff will be with you shortly to complete your order.',
      '',
      `**Opener:** ${member}`,
      `**IGN:** ${details.ign || '—'}`,
      `**Selling:** ${details.quantity || '—'} ${details.unitLabel || 'Skeleton Spawners'}`,
      `**Payment Method:** ${details.paymentMethod || '—'}`,
      `**Estimated Value:** ${details.estimatedUsd ? formatSellUsd(details.estimatedUsd) : 'Ask in ticket'}`,
    );
  } else if (ticketType === TICKET_TYPES.BUY_MONEY) {
    lines.push(
      '## 🛒 Buy DonutSMP Money Ticket',
      'Staff will be with you shortly to complete your order.',
      '',
      `**Opener:** ${member}`,
      `**DonutSMP Money:** ${details.amountText || '—'}`,
      `**Payment Method:** ${details.paymentMethod || '—'}`,
      `**Estimated Price:** ${details.estimatedUsd ? formatSellUsd(details.estimatedUsd) : 'Ask in ticket'}`,
    );
  } else if (ticketType === TICKET_TYPES.BUY_SPAWNERS) {
    lines.push(
      '## 🛒 Buy Skeleton Spawners Ticket',
      'Staff will be with you shortly to complete your order.',
      '',
      `**Opener:** ${member}`,
      `**Buying:** ${details.quantity || '—'} ${details.unitLabel || 'Skeleton Spawners'}`,
      `**Payment Method:** ${details.paymentMethod || '—'}`,
      `**Estimated Price:** ${details.estimatedUsd ? formatSellUsd(details.estimatedUsd) : 'Ask in ticket'}`,
    );
  } else {
    lines.push(
      '## 🆘 General Support Ticket',
      'Staff will be with you shortly.',
      '',
      `**Opener:** ${member}`,
      `**Issue:** ${details.issue || '—'}`,
    );
  }

  return new ContainerBuilder()
    .setAccentColor(0x3498db)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(lines.join('\n')),
    );
}

function buildTicketButtons(ticketId, claimedBy = null) {
  const claimLabel = claimedBy ? 'Unclaim' : 'Claim';
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${btnClaimPrefix}:${ticketId}`)
        .setLabel(claimLabel)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`${btnClosePrefix}:${ticketId}`)
        .setLabel('🔒 Close')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function buildGiveawayClaimButtons(ticket) {
  const flowState = `${ticket.details?.giveawayClaimFlowState || ''}` || GIVEAWAY_CLAIM_FLOW_STATE.AWAITING_HOST_PAID;
  const buttons = [];

  if (flowState === GIVEAWAY_CLAIM_FLOW_STATE.AWAITING_CLAIMER_CONFIRM) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`${btnGiveawayClaimerConfirmPrefix}:${ticket.id}`)
        .setLabel('✅ I Confirm Payment')
        .setStyle(ButtonStyle.Success),
    );
  } else if (flowState === GIVEAWAY_CLAIM_FLOW_STATE.AWAITING_HOST_PAID) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`${btnGiveawayHostPaidPrefix}:${ticket.id}`)
        .setLabel('💸 I Payed')
        .setStyle(ButtonStyle.Primary),
    );
  } else {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`giveaway_completed:${ticket.id}`)
        .setLabel('✅ Payment Confirmed')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
    );
  }

  buttons.push(
    new ButtonBuilder()
      .setCustomId(`${btnClosePrefix}:${ticket.id}`)
      .setLabel('🔒 Close')
      .setStyle(ButtonStyle.Danger),
  );

  return [new ActionRowBuilder().addComponents(buttons)];
}

async function applyClaimPermissions(channel, ticket, previousClaimedBy = null) {
  const staffRoleId = getStaffRoleId();

  if (!ticket.claimedBy) {
    if (staffRoleId) {
      await channel.permissionOverwrites.edit(staffRoleId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
        EmbedLinks: true,
      }).catch(() => null);
    }

    if (previousClaimedBy) {
      await channel.permissionOverwrites.delete(previousClaimedBy).catch(() => null);
    }
    return;
  }

  if (staffRoleId) {
    await channel.permissionOverwrites.edit(staffRoleId, {
      ViewChannel: false,
      SendMessages: null,
      ReadMessageHistory: null,
    }).catch(() => null);
  }

  await channel.permissionOverwrites.edit(ticket.openerId, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    AttachFiles: true,
    EmbedLinks: true,
  }).catch(() => null);

  await channel.permissionOverwrites.edit(ticket.claimedBy, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    AttachFiles: true,
    EmbedLinks: true,
  }).catch(() => null);
}

function buildConfirmOrderContainer(flow) {
  const { type, details } = flow;
  const lines = [];

  if (type === TICKET_TYPES.SELL_MONEY) {
    lines.push(
      '## 📋 Confirm Your Order',
      '',
      `**Type:** Sell DonutSMP Money`,
      `**IGN:** ${details.ign}`,
      `**DonutSMP Money:** ${details.amountText}`,
      `**Payment Method:** ${details.paymentMethod || '—'}`,
      `**Estimated Value:** ${details.estimatedUsd ? formatSellUsd(details.estimatedUsd) : 'Ask in ticket'}`,
      '',
      'Accept this calculated price to continue to terms.',
    );
  } else if (type === TICKET_TYPES.SELL_SPAWNERS) {
    lines.push(
      '## 📋 Confirm Your Order',
      '',
      `**Type:** Sell Skeleton Spawners`,
      `**IGN:** ${details.ign}`,
      `**Selling:** ${details.quantity} ${details.unitLabel}`,
      `**Payment Method:** ${details.paymentMethod || '—'}`,
      `**Estimated Value:** ${details.estimatedUsd ? formatSellUsd(details.estimatedUsd) : 'Ask in ticket'}`,
      '',
      'Accept this calculated price to continue to terms.',
    );
  } else if (type === TICKET_TYPES.BUY_MONEY) {
    lines.push(
      '## 📋 Confirm Your Order',
      '',
      `**Type:** Buy DonutSMP Money`,
      `**DonutSMP Money:** ${details.amountText}`,
      `**Payment Method:** ${details.paymentMethod || '—'}`,
      `**Estimated Price:** ${details.estimatedUsd ? formatSellUsd(details.estimatedUsd) : 'Ask in ticket'}`,
      '',
      'Accept this calculated price to continue to terms.',
    );
  } else if (type === TICKET_TYPES.BUY_SPAWNERS) {
    lines.push(
      '## 📋 Confirm Your Order',
      '',
      `**Type:** Buy Skeleton Spawners`,
      `**Buying:** ${details.quantity} ${details.unitLabel}`,
      `**Payment Method:** ${details.paymentMethod || '—'}`,
      `**Estimated Price:** ${details.estimatedUsd ? formatSellUsd(details.estimatedUsd) : 'Ask in ticket'}`,
      '',
      'Accept this calculated price to continue to terms.',
    );
  }

  return new ContainerBuilder()
    .setAccentColor(0xf1c40f)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(lines.join('\n')),
    );
}

function buildConfirmRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(flowConfirmYes).setLabel('Accept Price & Continue').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(flowConfirmNo).setLabel('❌ Cancel').setStyle(ButtonStyle.Danger),
  );
}

function buildTermsDescription(flow) {
  const lines = [
    'Confirm your order details before agreeing to terms.',
    '• Prices can be negotiated unless marked non-negotiable',
    '• Be respectful and provide clear details',
    '• Scam attempts or abuse can lead to blacklisting',
    '• Not vouching can lead to blacklisting',
  ];

  if (isTradeFlow(flow.type)) {
    lines.push('• Staff will confirm the payment method and final amount in the ticket');
  }

  return lines.join('\n');
}

function buildTermsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(flowTermsYes).setLabel('✅ I Agree').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(flowTermsNo).setLabel('❌ Cancel').setStyle(ButtonStyle.Danger),
  );
}

function buildCancelConfirmRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(flowCancelConfirmYes).setLabel('✅ Yes, Cancel').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(flowCancelConfirmNo).setLabel('❌ No, Go Back').setStyle(ButtonStyle.Secondary),
  );
}

function buildPaymentMethodRow(flow) {
  const buying = isBuyFlow(flow.type);
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(flowPaymentMethodCustomId)
      .setPlaceholder(buying ? 'Select how you are paying' : 'Select how you want to be paid')
      .addOptions(PAYMENT_METHODS.map(method => ({
        ...method,
        description: buying ? method.description.replace('Get paid', 'Pay') : method.description,
      }))),
  );
}

function buildSpawnerUnitRow(flow) {
  const buying = isBuyFlow(flow.type);
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(flowSpawnerUnitCustomId)
      .setPlaceholder(buying ? 'Select what you are buying' : 'Select what you are selling')
      .addOptions([
        {
          label: 'Skeleton Spawner',
          value: SPAWNER_UNITS.EACH,
          description: buying ? 'Buy individual skeleton spawners' : 'Sell individual skeleton spawners',
          emoji: '💀',
        },
        {
          label: 'Shulkers of Skeleton Spawners',
          value: SPAWNER_UNITS.SHULKER,
          description: buying ? 'Buy shulkers of skeleton spawners' : 'Sell shulkers of skeleton spawners',
          emoji: '📦',
        },
      ]),
  );
}

async function promptPaymentMethod(interaction, flow) {
  const buying = isBuyFlow(flow.type);
  await interaction.reply({
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    components: [
      new ContainerBuilder()
        .setAccentColor(0x3498db)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            [
              '## 💳 Payment Method',
              buying ? '**Step 2/4:** Select how you are paying.' : '**Step 2/4:** Select how you want to be paid.',
              '',
              `Estimated ${buying ? 'price' : 'total'}: **${flow.details.estimatedUsd ? formatSellUsd(flow.details.estimatedUsd) : 'Ask in ticket'}**`,
              '',
              '-# Made by jasonzli',
            ].join('\n'),
          ),
        ),
      buildPaymentMethodRow(flow),
    ],
  });
}

async function promptTerms(interaction, flow, mode = 'update') {
  const step = flow.type === TICKET_TYPES.SUPPORT ? 'Step 2/2' : 'Step 4/4';
  const payload = {
    flags: MessageFlags.IsComponentsV2,
    components: [
      new ContainerBuilder()
        .setAccentColor(0xf1c40f)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            [
              '## 📜 Terms & Conditions',
              `**${step}:** Agree to terms before creating this ticket.`,
              '',
              buildTermsDescription(flow),
              '',
              '-# Made by jasonzli',
            ].join('\n'),
          ),
        ),
      buildTermsRow(),
    ],
  };

  if (mode === 'reply') {
    await interaction.reply({ ...payload, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    return;
  }

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
  } else {
    await interaction.update(payload);
  }
}

// ── Panel ─────────────────────────────────────────────────────────────────────

function buildTicketPanel(moneyPrice, spawnerEachPrice = 0.16, moneySellPrice = 0.05, spawnerSellEachPrice = 0.2) {
  const priceText = formatTicketPanelPrices({
    moneyBuyPricePerMillion: moneyPrice,
    spawnerBuyPriceEach: spawnerEachPrice,
    moneySellPricePerMillion: moneySellPrice,
    spawnerSellPriceEach: spawnerSellEachPrice,
  });

  return new ContainerBuilder()
    .setAccentColor(0x2b2d31)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          '## 🎫 Ticket Panel',
          '',
          '**We Buy**',
          `🔥 DonutSMP Money at **${priceText.moneyPerBillion}**`,
          `🔥 Skeleton Spawners at **${priceText.spawnerEach}** / **${priceText.spawnerShulker}**`,
          '',
          '**We Sell**',
          `🛒 DonutSMP Money at **${priceText.moneySellPerBillion}**`,
          `🛒 Skeleton Spawners at **${priceText.spawnerSellEach}** / **${priceText.spawnerSellShulker}**`,
          '',
          '⚡ Fast & smooth transactions',
          '⚡ Serious buyer and seller',
          '',
          '💳 **Payment Methods:**',
          '• Crypto',
          '• PayPal',
          '• Bank Transfer',
          '• Gift Cards',
          '',
          'Choose a ticket type below to open a ticket.',
        ].join('\n'),
      ),
    );
}

function buildPanelButtonRow() {
  return new ActionRowBuilder().addComponents(
    PANEL_TICKET_OPTIONS.map(option =>
      new ButtonBuilder()
        .setCustomId(`${panelCategoryCustomId}:${option.value}`)
        .setLabel(option.label)
        .setEmoji(option.emoji)
        .setStyle(option.style),
    ),
  );
}

function buildPanelSelectRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(panelCategoryCustomId)
      .setPlaceholder('Select a category...')
      .addOptions(PANEL_TICKET_OPTIONS.map(option => ({
        label: option.label,
        value: option.value,
        description: option.description,
        emoji: option.emoji,
      }))),
  );
}

// ── Panel choice handlers ─────────────────────────────────────────────────────

async function handlePanelCategoryChoice(interaction, selected) {
  const { guild, user } = interaction;

  if (
    selected !== TICKET_TYPES.SELL_MONEY &&
    selected !== TICKET_TYPES.SELL_SPAWNERS &&
    selected !== TICKET_TYPES.BUY_MONEY &&
    selected !== TICKET_TYPES.BUY_SPAWNERS &&
    selected !== TICKET_TYPES.SUPPORT
  ) {
    await interaction.reply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [
        new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(
          new TextDisplayBuilder().setContent('## ❌ Unsupported Ticket Type\nUse the ticket panel to select a supported category.'),
        ),
      ],
    });
    return;
  }

  startFlow(guild.id, user.id, selected);

  if (selected === TICKET_TYPES.SELL_MONEY) {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(flowSellMoneyModal)
        .setTitle('💰 Sell DonutSMP Details')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('ign').setLabel('Your Minecraft IGN').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(32),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('amount').setLabel('DonutSMP money amount').setPlaceholder('Example: 10b or 500m').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20),
          ),
        ),
    );
    return;
  }

  if (selected === TICKET_TYPES.BUY_MONEY) {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(flowBuyMoneyModal)
        .setTitle('🛒 Buy DonutSMP Details')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('amount').setLabel('DonutSMP money amount').setPlaceholder('Example: 10b or 500m').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20),
          ),
        ),
    );
    return;
  }

  if (selected === TICKET_TYPES.SELL_SPAWNERS) {
    await interaction.reply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [
        new ContainerBuilder()
          .setAccentColor(0x3498db)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              [
                '## 💀 Sell Skeleton Spawners',
                '**Step 1/4:** Select what you are selling.',
                '',
                '-# Made by jasonzli',
              ].join('\n'),
            ),
          ),
        buildSpawnerUnitRow({ type: selected }),
      ],
    });
    return;
  }

  if (selected === TICKET_TYPES.BUY_SPAWNERS) {
    await interaction.reply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [
        new ContainerBuilder()
          .setAccentColor(0x3498db)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              [
                '## 🛒 Buy Skeleton Spawners',
                '**Step 1/4:** Select what you are buying.',
                '',
                '-# Made by jasonzli',
              ].join('\n'),
            ),
          ),
        buildSpawnerUnitRow({ type: selected }),
      ],
    });
    return;
  }

  if (selected === TICKET_TYPES.SUPPORT) {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(flowSupportModal)
        .setTitle('🆘 General Support')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('issue').setLabel('What do you need help with?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500),
          ),
        ),
    );
  }
}

async function handlePanelCategorySelect(interaction) {
  await handlePanelCategoryChoice(interaction, interaction.values?.[0]);
}

async function handlePanelCategoryButton(interaction) {
  const prefix = `${panelCategoryCustomId}:`;
  const selected = `${interaction.customId || ''}`.startsWith(prefix)
    ? interaction.customId.slice(prefix.length)
    : '';

  await handlePanelCategoryChoice(interaction, selected);
}

// ── Flow modal handlers ───────────────────────────────────────────────────────

async function handleFlowModal(interaction) {
  const { customId, guild, user, member } = interaction;
  const flow = getFlow(guild.id, user.id);

  if (!flow) {
    await interaction.reply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [
        new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(
          new TextDisplayBuilder().setContent('## ⏰ Session Expired\nUse the panel again.'),
        ),
      ],
    });
    return;
  }

  if (customId === flowSellMoneyModal) {
    const ign = interaction.fields.getTextInputValue('ign').trim();
    const amountRaw = interaction.fields.getTextInputValue('amount').trim();

    const amountRawMoney = parseAmount(amountRaw);
    const settings = await getSettings();
    const estimate = calculateSellEstimate({
      moneyAmount: amountRawMoney || 0,
      moneyBuyPricePerMillion: getMoneyBuyPrice(settings) || 0.038,
      spawnerBuyPriceEach: settings.spawnerBuyPriceEach || 0,
    });

    flow.details = {
      ign,
      amountText: amountRaw,
      amountRaw: amountRawMoney,
      estimatedUsd: estimate.totalUsd,
      estimate,
    };

    await promptPaymentMethod(interaction, flow);
    return;
  }

  if (customId === flowBuyMoneyModal) {
    const amountRaw = interaction.fields.getTextInputValue('amount').trim();

    const amountRawMoney = parseAmount(amountRaw);
    const settings = await getSettings();
    const estimate = calculateTradeEstimate({
      moneyAmount: amountRawMoney || 0,
      moneyPricePerMillion: settings.moneySellPricePerMillion || 0.05,
      spawnerPriceEach: settings.spawnerSellPriceEach || 0,
    });

    flow.details = {
      amountText: amountRaw,
      amountRaw: amountRawMoney,
      estimatedUsd: estimate.totalUsd,
      estimate,
    };

    await promptPaymentMethod(interaction, flow);
    return;
  }

  if (customId === flowSellSpawnersModal) {
    const ign = interaction.fields.getTextInputValue('ign').trim();
    const quantityRaw = interaction.fields.getTextInputValue('quantity').trim();
    const quantity = Math.max(0, parseInt(quantityRaw, 10) || 0);
    const unit = flow.details?.spawnerUnit === SPAWNER_UNITS.SHULKER ? SPAWNER_UNITS.SHULKER : SPAWNER_UNITS.EACH;
    const settings = await getSettings();
    const estimate = calculateSellEstimate({
      skeletonSpawners: unit === SPAWNER_UNITS.EACH ? quantity : 0,
      skeletonShulkers: unit === SPAWNER_UNITS.SHULKER ? quantity : 0,
      moneyBuyPricePerMillion: getMoneyBuyPrice(settings) || 0.038,
      spawnerBuyPriceEach: settings.spawnerBuyPriceEach || 0,
    });

    flow.details = {
      ...flow.details,
      ign,
      quantity,
      quantityText: quantityRaw,
      unitLabel: unit === SPAWNER_UNITS.SHULKER ? 'Shulkers of Skeleton Spawners' : 'Skeleton Spawners',
      estimatedUsd: estimate.totalUsd,
      estimate,
    };

    await promptPaymentMethod(interaction, flow);
    return;
  }

  if (customId === flowBuySpawnersModal) {
    const quantityRaw = interaction.fields.getTextInputValue('quantity').trim();
    const quantity = Math.max(0, parseInt(quantityRaw, 10) || 0);
    const unit = flow.details?.spawnerUnit === SPAWNER_UNITS.SHULKER ? SPAWNER_UNITS.SHULKER : SPAWNER_UNITS.EACH;
    const settings = await getSettings();
    const estimate = calculateTradeEstimate({
      skeletonSpawners: unit === SPAWNER_UNITS.EACH ? quantity : 0,
      skeletonShulkers: unit === SPAWNER_UNITS.SHULKER ? quantity : 0,
      moneyPricePerMillion: settings.moneySellPricePerMillion || 0.05,
      spawnerPriceEach: settings.spawnerSellPriceEach || 0,
    });

    flow.details = {
      ...flow.details,
      quantity,
      quantityText: quantityRaw,
      unitLabel: unit === SPAWNER_UNITS.SHULKER ? 'Shulkers of Skeleton Spawners' : 'Skeleton Spawners',
      estimatedUsd: estimate.totalUsd,
      estimate,
    };

    await promptPaymentMethod(interaction, flow);
    return;
  }

  if (customId === flowBuyModal) {
    const request = interaction.fields.getTextInputValue('request').trim();
    const notes = interaction.fields.getTextInputValue('notes').trim();
    flow.details = { request, notes };

    await interaction.reply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [buildConfirmOrderContainer(flow), buildConfirmRow()],
    });
    return;
  }

  if (customId === flowSupportModal) {
    const issue = interaction.fields.getTextInputValue('issue').trim();
    flow.details = { issue };
    await promptTerms(interaction, flow, 'reply');
  }
}

// ── Flow confirm button handlers ──────────────────────────────────────────────

async function handleFlowConfirm(interaction) {
  const { customId, guild, user } = interaction;

  if (customId === flowConfirmNo) {
    endFlow(guild.id, user.id);
    await interaction.update({
      flags: MessageFlags.IsComponentsV2,
      components: [
        new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(
          new TextDisplayBuilder().setContent('## ❌ Cancelled\nTicket creation cancelled.'),
        ),
      ],
    });
    return;
  }

  if (customId === flowConfirmYes) {
    const flow = getFlow(guild.id, user.id);
    if (!flow) {
      await interaction.update({
        flags: MessageFlags.IsComponentsV2,
        components: [
          new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(
            new TextDisplayBuilder().setContent('## ⏰ Session Expired\nUse the panel again.'),
          ),
        ],
      });
      return;
    }
    await promptTerms(interaction, flow, 'update');
  }
}

async function handleFlowTerms(interaction) {
  const { customId, guild, user } = interaction;
  const flow = getFlow(guild.id, user.id);

  if (!flow) {
    const payload = {
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [
        new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(
          new TextDisplayBuilder().setContent('## ⏰ Session Expired\nUse the panel again.'),
        ),
      ],
    };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply(payload);
    return;
  }

  if (customId === flowTermsNo) {
    await interaction.update({
      flags: MessageFlags.IsComponentsV2,
      components: [
        new ContainerBuilder()
          .setAccentColor(0xf39c12)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              ['## ⚠️ Cancel Setup?', 'Do you want to cancel this ticket setup?', '', '-# Made by jasonzli'].join('\n'),
            ),
          ),
        buildCancelConfirmRow(),
      ],
    });
    return;
  }

  if (customId === flowCancelConfirmYes) {
    endFlow(guild.id, user.id);
    await interaction.update({
      flags: MessageFlags.IsComponentsV2,
      components: [
        new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(
          new TextDisplayBuilder().setContent('## ❌ Order Cancelled\nYou cancelled your ticket setup.\n\n-# Made by jasonzli'),
        ),
      ],
    });
    return;
  }

  if (customId === flowCancelConfirmNo) {
    await promptTerms(interaction, flow, 'update');
    return;
  }

  if (customId === flowTermsYes) {
    await createTicketFromFlow(interaction, flow, 'update');
  }
}

async function handleFlowPaymentMethod(interaction) {
  const flow = getFlow(interaction.guild.id, interaction.user.id);
  if (!flow || !isTradeFlow(flow.type)) {
    await interaction.reply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [
        new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(
          new TextDisplayBuilder().setContent('## ⏰ Session Expired\nUse the panel again.'),
        ),
      ],
    });
    return;
  }

  const selected = `${interaction.values?.[0] || ''}`.trim();
  const valid = PAYMENT_METHODS.some(method => method.value === selected);
  if (!valid) {
    await interaction.reply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [
        new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(
          new TextDisplayBuilder().setContent('## ❌ Invalid Payment Method\nSelect one of the payment methods from the menu.'),
        ),
      ],
    });
    return;
  }

  flow.details.paymentMethod = selected;
  await interaction.update({
    flags: MessageFlags.IsComponentsV2,
    components: [buildConfirmOrderContainer(flow), buildConfirmRow()],
  });
}

async function handleFlowSpawnerUnit(interaction) {
  const flow = getFlow(interaction.guild.id, interaction.user.id);
  if (!flow || !isSpawnerFlow(flow.type)) {
    await interaction.reply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [
        new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(
          new TextDisplayBuilder().setContent('## ⏰ Session Expired\nUse the panel again.'),
        ),
      ],
    });
    return;
  }

  const unit = `${interaction.values?.[0] || ''}`.trim();
  if (unit !== SPAWNER_UNITS.EACH && unit !== SPAWNER_UNITS.SHULKER) {
    await interaction.reply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [
        new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(
          new TextDisplayBuilder().setContent('## ❌ Invalid Selection\nSelect Skeleton Spawner or Shulkers of Skeleton Spawners.'),
        ),
      ],
    });
    return;
  }

  flow.details.spawnerUnit = unit;
  const unitLabel = unit === SPAWNER_UNITS.SHULKER ? 'Shulkers of Skeleton Spawners' : 'Skeleton Spawners';
  flow.details.unitLabel = unitLabel;

  const isBuy = isBuyFlow(flow.type);
  const modalComponents = [
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('quantity')
        .setLabel(unit === SPAWNER_UNITS.SHULKER ? 'How many shulkers?' : 'How many skeleton spawners?')
        .setPlaceholder('Example: 3')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(12),
    ),
  ];
  if (!isBuy) {
    modalComponents.unshift(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('ign').setLabel('Your Minecraft IGN').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(32),
      ),
    );
  }

  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(isBuy ? flowBuySpawnersModal : flowSellSpawnersModal)
      .setTitle(
        isBuy
          ? (unit === SPAWNER_UNITS.SHULKER ? '📦 Buy Skeleton Shulkers' : '🛒 Buy Skeleton Spawners')
          : (unit === SPAWNER_UNITS.SHULKER ? '📦 Sell Skeleton Shulkers' : '💀 Sell Skeleton Spawners'),
      )
      .addComponents(...modalComponents),
  );
}

// ── Ticket creation from flow ─────────────────────────────────────────────────

async function createTicketFromFlow(interaction, flow, mode) {
  const { guild, member } = interaction;

  const acknowledge = async () => {
    if (mode === 'update') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => null);
    } else {
      if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => null);
    }
  };

  const sendResponse = async (components) => {
    const payload = { flags: MessageFlags.IsComponentsV2, components };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => null);
    } else if (mode === 'update') {
      await interaction.update(payload).catch(() => null);
    } else {
      await interaction.reply({ ...payload, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral }).catch(() => null);
    }
  };

  await acknowledge();

  const existing = await ensureSingleOpenTicket(guild.id, member.id, flow.type);
  if (existing) {
    const existingChannel = await guild.channels.fetch(existing.channelId).catch(() => null);
    endFlow(guild.id, member.id);
    await sendResponse([
      new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `## 🎫 Ticket Already Open\n${existingChannel ? `You already have an open ticket: ${existingChannel}` : 'You already have an open ticket in this category.'}`,
        ),
      ),
    ]);
    return;
  }

  const category = await ensureTicketCategory(guild, flow.type);
  const staffRoleId = getStaffRoleId();
  const username = sanitizeName(member.displayName || member.user.username);
  const typePrefix = {
    [TICKET_TYPES.SELL_MONEY]: 'sell-money',
    [TICKET_TYPES.SELL_SPAWNERS]: 'sell-spawner',
    [TICKET_TYPES.BUY_MONEY]: 'buy-money',
    [TICKET_TYPES.BUY_SPAWNERS]: 'buy-spawner',
    [TICKET_TYPES.BUY]: 'buy',
    [TICKET_TYPES.SUPPORT]: 'support',
  }[flow.type] || flow.type;
  const channelName = `${typePrefix}-${username}`.slice(0, 100);

  const overrides = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...(staffRoleId ? [{
      id: staffRoleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks],
    }] : []),
    {
      id: member.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks],
    },
  ];

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: overrides,
  });

  const ticket = await Ticket.create({
    guildId: guild.id,
    channelId: channel.id,
    parentCategoryId: category.id,
    openerId: member.id,
    ticketType: flow.type,
    status: STATUS.OPEN,
    details: flow.details || {},
  });

  endFlow(guild.id, member.id);

  const mentionContent = [`<@${member.id}>`, '@everyone'].join(' ');

  const firstMessage = await channel.send({
    content: ' ',
    flags: MessageFlags.IsComponentsV2,
    components: [
      new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent(mentionContent),
      ),
      buildTicketOpeningContainer(member, flow.type, flow.details),
      ...buildTicketButtons(ticket.id),
    ],
    allowedMentions: { users: [member.id], parse: ['everyone'] },
  });

  await firstMessage.pin().catch(() => null);
  ticket.details.mainMessageId = firstMessage.id;
  await ticket.save();

  logInfo('Ticket Opened', `<@${member.id}> opened a **${flow.type}** ticket`, [
    { name: 'Channel', value: channel.toString(), inline: true },
  ], { category: 'ticket' }).catch(() => null);

  await sendResponse([
    new ContainerBuilder().setAccentColor(0x57F287).addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ✅ Ticket Created\nYour ticket is ready: ${channel}`),
    ),
  ]);
}

async function ensureTranscriptChannel(guild, ticket) {
  const configuredIds = [
    ticket?.details?.isGiveawayClaim ? process.env.GIVEAWAY_LOGS_CHANNEL_ID : '',
    process.env.TICKET_TRANSCRIPTS_CHANNEL_ID,
    process.env.TICKET_LOGS_CHANNEL_ID,
    process.env.LOGS_CHANNEL_ID,
  ].map(v => `${v || ''}`.trim()).filter(Boolean);

  for (const channelId of configuredIds) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (channel && channel.type === ChannelType.GuildText) return channel;
  }

  await guild.channels.fetch().catch(() => null);
  const existing = guild.channels.cache.find(ch =>
    ch &&
    ch.type === ChannelType.GuildText &&
    `${ch.name || ''}`.trim().toLowerCase() === 'ticket-transcripts',
  );
  if (existing) return existing;

  const staffRoleId = getStaffRoleId();
  let botMember = guild.members?.me || null;
  if (!botMember && guild.members?.fetchMe) {
    botMember = await guild.members.fetchMe().catch(() => null);
  }
  const permissionOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...(staffRoleId ? [{
      id: staffRoleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks],
    }] : []),
    ...(botMember ? [{
      id: botMember.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks],
    }] : []),
  ];

  return guild.channels.create({
    name: 'ticket-transcripts',
    type: ChannelType.GuildText,
    permissionOverwrites,
  }).catch(() => null);
}

async function closeTicketWithTranscript({ interaction, ticket, reason = 'Closed', closedBy }) {
  if (!ticket || ticket.status !== STATUS.OPEN) return;

  const guild = interaction.guild;
  const channel = await guild.channels.fetch(ticket.channelId).catch(() => interaction.channel || null);
  const categoryId = channel?.parentId || null;
  let messages = [];

  if (channel?.messages?.fetch) {
    messages = await collectAllMessages(channel).catch(error => {
      console.error(`[Transcript] Failed to collect messages for ticket ${ticket.id}:`, error);
      return [];
    });
  }

  const generatedAt = new Date();
  const transcriptOptions = {
    guildName: guild.name,
    channelName: channel?.name || `ticket-${ticket.id}`,
    reason,
    generatedAt,
  };
  const transcriptText = buildTranscriptText(messages, ticket, reason, transcriptOptions);
  const transcriptHtml = buildTranscriptHtml(messages, ticket, transcriptOptions);
  const baseName = `${channel?.name || `ticket-${ticket.id}`}-transcript`;
  const transcriptFiles = () => buildTranscriptFileAttachments({
    text: transcriptText,
    html: transcriptHtml,
    baseName,
  });

  const transcriptChannel = await ensureTranscriptChannel(guild, ticket);
  if (transcriptChannel) {
    await transcriptChannel.send(buildTranscriptSummaryPayload({
      ticket,
      channelName: channel?.name || ticket.channelId,
      reason,
      closedBy,
      files: transcriptFiles(),
    })).catch(error => console.error(`[Transcript] Failed to post ticket transcript ${ticket.id}:`, error));

    await forwardAttachments(transcriptChannel, messages).catch(error =>
      console.error(`[Transcript] Failed to forward attachments for ticket ${ticket.id}:`, error),
    );
  } else {
    console.error(`[Transcript] No transcript channel available for ticket ${ticket.id}.`);
  }

  const opener = await guild.client.users.fetch(ticket.openerId).catch(() => null);
  if (opener) {
    await opener.send(buildClosedDmPayload({
      guildName: guild.name,
      channelName: channel?.name || 'deleted-ticket',
      ticket,
      reason,
      closedBy,
      files: transcriptFiles(),
    })).catch(() => null);
  }

  ticket.status = STATUS.CLOSED;
  ticket.closedAt = new Date();
  ticket.closedBy = closedBy || null;
  await ticket.save();

  logInfo('Ticket Closed', `Closed by ${closedBy ? `<@${closedBy}>` : 'System'}`, [
    { name: 'Opener', value: `<@${ticket.openerId}>`, inline: true },
    { name: 'Type', value: ticket.ticketType, inline: true },
    { name: 'Transcript', value: transcriptChannel ? `${transcriptChannel}` : 'Unavailable', inline: true },
  ], { category: 'ticket' }).catch(() => null);

  if (channel?.delete) {
    await channel.delete(`Ticket closed: ${reason}`).catch(() => null);
  } else {
    await guild.channels.delete(ticket.channelId).catch(() => null);
  }
  await maybeDeleteEmptyCategory(guild, categoryId);
}

// ── Ticket button handlers ────────────────────────────────────────────────────

async function handleTicketButton(interaction) {
  const [action, ticketId] = interaction.customId.split(':');

  if (action === btnGiveawayHostPaidPrefix) {
    const ticket = await Ticket.findById(ticketId);
    if (!ticket || ticket.status !== STATUS.OPEN) {
      return interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('Ticket not found or already closed.'))] });
    }
    if (!ticket.details?.isGiveawayClaim || !ticket.details?.giveawayCreatedViaButton) {
      return interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(new TextDisplayBuilder().setContent('❌ This workflow is only available for claim-button giveaway tickets.'))] });
    }

    const hostUserId = `${ticket.details?.giveawayHostUserId || ''}`.trim();
    const canMarkPaid = isStaff(interaction) || (hostUserId && interaction.user.id === hostUserId);
    if (!canMarkPaid) {
      return interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(new TextDisplayBuilder().setContent('❌ Only the giveaway host or staff can press **I Payed**.'))] });
    }

    const flowState = `${ticket.details?.giveawayClaimFlowState || ''}` || GIVEAWAY_CLAIM_FLOW_STATE.AWAITING_HOST_PAID;
    if (flowState !== GIVEAWAY_CLAIM_FLOW_STATE.AWAITING_HOST_PAID) {
      return interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('ℹ️ This step was already completed for this ticket.'))] });
    }

    ticket.details.giveawayClaimFlowState = GIVEAWAY_CLAIM_FLOW_STATE.AWAITING_CLAIMER_CONFIRM;
    ticket.details.giveawayHostPaidAt = new Date();
    ticket.details.giveawayHostPaidBy = interaction.user.id;
    ticket.markModified('details');
    await ticket.save();

    const mainMessage = ticket.details?.mainMessageId
      ? await interaction.channel.messages.fetch(ticket.details.mainMessageId).catch(() => null)
      : null;
    if (mainMessage) {
      await mainMessage.edit({ components: [...mainMessage.components.slice(0, -1), ...buildGiveawayClaimButtons(ticket)] }).catch(() => null);
    }

    await interaction.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        new ContainerBuilder().setAccentColor(0x57f287).addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`✅ Payment marked as sent by <@${interaction.user.id}>. <@${ticket.openerId}>, press **I Confirm Payment** once you received it.`),
        ),
      ],
      allowedMentions: { users: [interaction.user.id, ticket.openerId] },
    });
    return;
  }

  if (action === btnGiveawayClaimerConfirmPrefix) {
    const ticket = await Ticket.findById(ticketId);
    if (!ticket || ticket.status !== STATUS.OPEN) {
      return interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('Ticket not found or already closed.'))] });
    }
    if (!ticket.details?.isGiveawayClaim || !ticket.details?.giveawayCreatedViaButton) {
      return interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(new TextDisplayBuilder().setContent('❌ This workflow is only available for claim-button giveaway tickets.'))] });
    }
    if (interaction.user.id !== ticket.openerId) {
      return interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(new TextDisplayBuilder().setContent('❌ Only the giveaway claimer can confirm payment.'))] });
    }
    if (`${ticket.details?.giveawayClaimFlowState || ''}` !== GIVEAWAY_CLAIM_FLOW_STATE.AWAITING_CLAIMER_CONFIRM) {
      return interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(new TextDisplayBuilder().setContent('❌ You can only confirm after payment is marked sent.'))] });
    }

    ticket.details.giveawayClaimFlowState = GIVEAWAY_CLAIM_FLOW_STATE.COMPLETED;
    ticket.details.giveawayConfirmedAt = new Date();
    ticket.details.giveawayConfirmedBy = interaction.user.id;
    ticket.markModified('details');
    await ticket.save();

    await interaction.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        new ContainerBuilder().setAccentColor(0x57f287).addTextDisplayComponents(
          new TextDisplayBuilder().setContent('✅ Giveaway claimer confirmed payment. Closing ticket now.'),
        ),
      ],
      allowedMentions: { parse: [] },
    });

    await closeTicketWithTranscript({
      interaction,
      ticket,
      reason: 'Giveaway payment confirmed by claimer',
      closedBy: interaction.user.id,
    });
    return;
  }

  if (action === btnClaimPrefix) {
    const ticket = await Ticket.findById(ticketId);
    if (!ticket || ticket.status !== STATUS.OPEN) {
      return interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('Ticket not found or already closed.'))] });
    }

    if (!isStaff(interaction)) {
      return interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('Only staff can claim tickets.'))] });
    }

    const channel = interaction.channel;
    if (!channel) return;

    if (ticket.claimedBy && ticket.claimedBy !== interaction.user.id) {
      return interaction.reply({
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        components: [
          new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(
            new TextDisplayBuilder().setContent('❌ This ticket is already claimed by another team member.'),
          ),
        ],
      });
    }

    if (!ticket.claimedBy) {
      const claimResult = await Ticket.findOneAndUpdate(
        { _id: ticket._id, claimedBy: null },
        { $set: { claimedBy: interaction.user.id } },
        { returnDocument: 'after' },
      );
      if (!claimResult) {
        return interaction.reply({
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          components: [
            new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(
              new TextDisplayBuilder().setContent('❌ This ticket was just claimed by another team member.'),
            ),
          ],
        });
      }
      ticket.claimedBy = claimResult.claimedBy;
      await applyClaimPermissions(channel, ticket);
    } else {
      const previousClaimedBy = ticket.claimedBy;
      const unclaimResult = await Ticket.findOneAndUpdate(
        { _id: ticket._id, claimedBy: interaction.user.id },
        { $unset: { claimedBy: 1 } },
        { returnDocument: 'after' },
      );
      if (!unclaimResult) {
        return interaction.reply({
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          components: [
            new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(
              new TextDisplayBuilder().setContent('❌ This ticket is no longer claimed by you.'),
            ),
          ],
        });
      }
      ticket.claimedBy = null;
      await applyClaimPermissions(channel, ticket, previousClaimedBy);
    }

    // Update the ticket message buttons
    const mainMessage = ticket.details?.mainMessageId
      ? await channel.messages.fetch(ticket.details.mainMessageId).catch(() => null)
      : null;

    if (mainMessage) {
      const newButtons = buildTicketButtons(ticket.id, ticket.claimedBy);
      await mainMessage.edit({ components: [...mainMessage.components.slice(0, -1), ...newButtons] }).catch(() => null);
    }

    await interaction.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        new ContainerBuilder().setAccentColor(ticket.claimedBy ? 0x3498db : 0x95a5a6).addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            ticket.claimedBy
              ? `🔒 ${interaction.member || interaction.user} claimed this ticket. Only ${interaction.member || interaction.user} and the opener can type now.`
              : `🔓 ${interaction.member || interaction.user} unclaimed this ticket. Team role typing has been restored.`,
          ),
        ),
      ],
      allowedMentions: { users: [interaction.user.id] },
    });
    return;
  }

  if (action === btnClosePrefix) {
    const ticket = await Ticket.findById(ticketId);
    if (!ticket || ticket.status !== STATUS.OPEN) {
      return interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('Ticket not found or already closed.'))] });
    }

    const canClose = isStaff(interaction) || ticket.openerId === interaction.user.id;
    if (!canClose) {
      return interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('Only staff or the ticket opener can close this ticket.'))] });
    }

    if (closeLocks.has(ticket.id)) return;
    closeLocks.add(ticket.id);

    try {
      await interaction.reply({
        flags: MessageFlags.IsComponentsV2,
        components: [new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(new TextDisplayBuilder().setContent('## 🔒 Closing ticket...'))],
      });

      await closeTicketWithTranscript({
        interaction,
        ticket,
        reason: `Closed by ${interaction.user.tag || interaction.user.username || interaction.user.id}`,
        closedBy: interaction.user.id,
      });
    } finally {
      closeLocks.delete(ticket.id);
    }
  }
}

// ── Slash command handlers (close / add / remove) ─────────────────────────────

async function handleTicketClose(interaction) {
  const ticket = await getTicketByChannel(interaction.channel.id);
  if (!ticket) {
    return interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('This channel is not an open ticket.'))] });
  }

  const canClose = isStaff(interaction) || ticket.openerId === interaction.user.id;
  if (!canClose) {
    return interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('Only staff or the ticket opener can close this ticket.'))] });
  }

  if (closeLocks.has(ticket.id)) return;
  closeLocks.add(ticket.id);

  try {
    await interaction.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(new TextDisplayBuilder().setContent('## 🔒 Closing ticket...'))],
    });

    await closeTicketWithTranscript({
      interaction,
      ticket,
      reason: `Closed by ${interaction.user.tag || interaction.user.username || interaction.user.id}`,
      closedBy: interaction.user.id,
    });
  } finally {
    closeLocks.delete(ticket.id);
  }
}

async function handleTicketAdd(interaction, targetUser) {
  if (!isStaff(interaction)) {
    return interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('Only staff can add users to tickets.'))] });
  }

  const ticket = await getTicketByChannel(interaction.channel.id);
  if (!ticket) {
    return interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('This channel is not an open ticket.'))] });
  }

  await interaction.channel.permissionOverwrites.edit(targetUser.id, {
    ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true,
  });

  if (!ticket.addedUsers.includes(targetUser.id)) {
    ticket.addedUsers.push(targetUser.id);
    await ticket.save();
  }

  await interaction.reply({
    flags: MessageFlags.IsComponentsV2,
    components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`✅ Added ${targetUser} to this ticket.`))],
  });
}

async function handleTicketRemove(interaction, targetUser) {
  if (!isStaff(interaction)) {
    return interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('Only staff can remove users from tickets.'))] });
  }

  const ticket = await getTicketByChannel(interaction.channel.id);
  if (!ticket) {
    return interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('This channel is not an open ticket.'))] });
  }

  if (targetUser.id === ticket.openerId) {
    return interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('Cannot remove the ticket opener.'))] });
  }

  await interaction.channel.permissionOverwrites.delete(targetUser.id).catch(() => null);
  ticket.addedUsers = ticket.addedUsers.filter(id => id !== targetUser.id);
  await ticket.save();

  await interaction.reply({
    flags: MessageFlags.IsComponentsV2,
    components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`✅ Removed ${targetUser} from this ticket.`))],
  });
}

module.exports = {
  handlePanelCategorySelect,
  handlePanelCategoryButton,
  handleFlowPaymentMethod,
  handleFlowSpawnerUnit,
  handleFlowModal,
  handleFlowConfirm,
  handleFlowTerms,
  handleTicketButton,
  handleTicketClose,
  handleTicketAdd,
  handleTicketRemove,
  buildTicketPanel,
  buildPanelButtonRow,
  buildPanelSelectRow,
  buildTermsDescription,
  promptTerms,
  closeTicketWithTranscript,
  getTicketByChannel,
  ensureTicketCategory,
};
