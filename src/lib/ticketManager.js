const {
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const { Ticket } = require('./models');
const { getSettings, updateSettings } = require('./botSettings');
const { logInfo } = require('./logger');

const TICKET_TYPES = { sell: 'sell', buy: 'buy', support: 'support' };

const CATEGORY_NAMES = {
  sell: '「Sell Tickets」',
  buy: '「Buy Tickets」',
  support: '「Support Tickets」',
};

const TICKET_TYPE_LABELS = {
  sell: 'Sell',
  buy: 'Buy',
  support: 'Support',
};

function sanitizeName(str) {
  return `${str || ''}`.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

function buildTicketCloseRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_close')
      .setLabel('Close Ticket')
      .setStyle(ButtonStyle.Danger),
  );
}

function buildTicketOpeningEmbed(member, type) {
  const typeLabel = TICKET_TYPE_LABELS[type] || type;
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`${typeLabel} Ticket`)
    .setDescription([
      `**Opened by:** ${member}`,
      `**Type:** ${typeLabel}`,
      '',
      type === 'sell' ? 'Please describe what you would like to sell and the quantity.' : '',
      type === 'buy' ? 'Please describe what you would like to buy and the quantity.' : '',
      type === 'support' ? 'Please describe your issue and staff will assist you shortly.' : '',
    ].filter(l => l !== '').join('\n'))
    .setTimestamp();
}

async function ensureCategory(guild, type) {
  const settings = await getSettings();
  const savedId = settings.ticketCategoryIds?.[type];

  if (savedId) {
    const saved = await guild.channels.fetch(savedId).catch(() => null);
    if (saved && saved.type === ChannelType.GuildCategory) return saved;
  }

  const name = CATEGORY_NAMES[type];
  let existing = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === name) || null;

  if (!existing) {
    const fetched = await guild.channels.fetch().catch(() => null);
    if (fetched) {
      existing = fetched.find(c => c && c.type === ChannelType.GuildCategory && c.name === name) || null;
    }
  }

  if (existing) {
    const updated = { ...(settings.ticketCategoryIds || {}), [type]: existing.id };
    await updateSettings({ ticketCategoryIds: updated });
    return existing;
  }

  const staffRoleId = `${process.env.TICKET_STAFF_ROLE_ID || ''}`.trim();
  const permissionOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...(staffRoleId
      ? [{
          id: staffRoleId,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
        }]
      : []),
  ];

  const created = await guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    permissionOverwrites,
  });

  const updated = { ...(settings.ticketCategoryIds || {}), [type]: created.id };
  await updateSettings({ ticketCategoryIds: updated });
  return created;
}

async function maybeDeleteEmptyCategory(guild, categoryId) {
  if (!categoryId) return;
  const category = await guild.channels.fetch(categoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) return;

  // Re-fetch channels to get fresh list
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

async function ensureSingleOpenTicket(guildId, openerId, type) {
  return Ticket.findOne({ guildId, openerId, ticketType: type, status: 'open' });
}

async function getTicketByChannel(channelId) {
  return Ticket.findOne({ channelId, status: 'open' });
}

async function createTicket(guild, member, type) {
  const existing = await ensureSingleOpenTicket(guild.id, member.id, type);
  if (existing) {
    const existingChannel = await guild.channels.fetch(existing.channelId).catch(() => null);
    return { ticket: existing, channel: existingChannel, wasExisting: true };
  }

  const category = await ensureCategory(guild, type);
  const staffRoleId = `${process.env.TICKET_STAFF_ROLE_ID || ''}`.trim();
  const username = sanitizeName(member.displayName || member.user.username);
  const channelName = `${type}-${username}`.slice(0, 100);

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      ...(staffRoleId
        ? [{
            id: staffRoleId,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.EmbedLinks,
            ],
          }]
        : []),
      {
        id: member.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      },
    ],
  });

  const ticket = await Ticket.create({
    guildId: guild.id,
    channelId: channel.id,
    openerId: member.id,
    ticketType: type,
    status: 'open',
  });

  const staffMention = staffRoleId ? `<@&${staffRoleId}>` : '';
  const greeting = [`<@${member.id}>`, staffMention].filter(Boolean).join(' ');

  await channel.send({
    content: greeting,
    embeds: [buildTicketOpeningEmbed(member, type)],
    components: [buildTicketCloseRow()],
    allowedMentions: {
      users: [member.id],
      roles: staffRoleId ? [staffRoleId] : [],
    },
  });

  logInfo('Ticket Opened', `<@${member.id}> opened a **${TICKET_TYPE_LABELS[type]}** ticket`, [
    { name: 'Channel', value: channel.toString(), inline: true },
    { name: 'Type', value: TICKET_TYPE_LABELS[type], inline: true },
  ]).catch(() => null);

  return { ticket, channel, wasExisting: false };
}

async function closeTicket(guild, ticket, closedById) {
  // Get category before deleting channel
  const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
  const categoryId = channel?.parentId || null;

  logInfo('Ticket Closed', `Ticket closed by <@${closedById}>`, [
    { name: 'Opener', value: `<@${ticket.openerId}>`, inline: true },
    { name: 'Type', value: TICKET_TYPE_LABELS[ticket.ticketType] || ticket.ticketType, inline: true },
  ]).catch(() => null);

  await guild.channels.delete(ticket.channelId).catch(() => null);

  ticket.status = 'closed';
  ticket.closedAt = new Date();
  ticket.closedBy = closedById;
  await ticket.save();

  await maybeDeleteEmptyCategory(guild, categoryId);
}

async function addUserToTicket(guild, ticket, userId) {
  const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
  if (!channel) return false;

  await channel.permissionOverwrites.edit(userId, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    AttachFiles: true,
    EmbedLinks: true,
  });

  if (!ticket.addedUsers.includes(userId)) {
    ticket.addedUsers.push(userId);
    await ticket.save();
  }
  return true;
}

async function removeUserFromTicket(guild, ticket, userId) {
  if (userId === ticket.openerId) return false;
  const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
  if (!channel) return false;

  await channel.permissionOverwrites.delete(userId).catch(() => null);
  ticket.addedUsers = ticket.addedUsers.filter(id => id !== userId);
  await ticket.save();
  return true;
}

module.exports = {
  TICKET_TYPES,
  CATEGORY_NAMES,
  createTicket,
  closeTicket,
  ensureSingleOpenTicket,
  getTicketByChannel,
  addUserToTicket,
  removeUserFromTicket,
  buildTicketCloseRow,
};
