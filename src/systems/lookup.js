const {
  AttachmentBuilder,
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
} = require('discord.js');

const { Ticket } = require('../lib/models');

const LOOKUP_MAX_DB_SCAN = 3000;

function normalizeLookupCode(raw) {
  return `${raw || ''}`.trim().replace(/^#/, '').replace(/\s+/g, ' ').toUpperCase();
}

function parseSearchQuery(query) {
  const raw = `${query || ''}`.trim();
  const userIdMatch = raw.match(/^<@!?(\d{17,20})>$|^(\d{17,20})$/);
  if (userIdMatch) return { type: 'user_id', value: userIdMatch[1] || userIdMatch[2] };
  if (/^[0-9a-fA-F]{24}$/.test(raw)) return { type: 'ticket_id_full', value: raw };
  if (/^[0-9a-fA-F]{3,}$/.test(raw) && !/\s/.test(raw)) return { type: 'ticket_id_suffix', value: raw.toUpperCase() };
  return { type: 'text_search', value: raw };
}

function truncate(value, max = 1000) {
  const text = `${value || ''}`;
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function formatTimestamp(dateLike) {
  if (!dateLike) return 'N/A';
  const unix = Math.floor(new Date(dateLike).getTime() / 1000);
  if (!Number.isFinite(unix) || unix <= 0) return 'N/A';
  return `<t:${unix}:F> (<t:${unix}:R>)`;
}

function attachmentValues(attachments) {
  if (!attachments) return [];
  if (typeof attachments.values === 'function') return [...attachments.values()];
  if (Array.isArray(attachments)) return attachments;
  return [];
}

function componentValues(components) {
  return (Array.isArray(components) ? components : []).map(component => {
    if (component && typeof component.toJSON === 'function') return component.toJSON();
    return component;
  });
}

function collectMessageComponentText(components) {
  const snippets = [];
  const visit = (component) => {
    if (!component || typeof component !== 'object') return;
    const content = `${component.content || component.label || component.placeholder || ''}`.trim();
    if (content) snippets.push(content);
    if (Array.isArray(component.components)) {
      for (const child of component.components) visit(child);
    }
  };
  for (const component of componentValues(components)) visit(component);
  return snippets.join('\n');
}

function isTranscriptSummaryMessage(message) {
  const text = [
    `${message?.content || ''}`,
    collectMessageComponentText(message?.components),
    ...(Array.isArray(message?.embeds) ? message.embeds.map(embed => `${embed?.title || ''}\n${embed?.description || ''}`) : []),
  ].join('\n').toLowerCase();
  return text.includes('closed ticket transcript');
}

function isTranscriptFileAttachment(attachment) {
  const name = `${attachment?.name || ''}`.toLowerCase();
  return name.endsWith('-transcript.txt') || name.endsWith('-transcript.html') || /-transcript-part-\d+-of-\d+\.txt$/i.test(name);
}

function resolveComponentFileUrl(rawUrl, attachmentsByName) {
  const url = `${rawUrl || ''}`.trim();
  if (!url) return '';
  if (!url.startsWith('attachment://')) return url;
  return attachmentsByName.get(url.slice('attachment://'.length)) || '';
}

function collectMessageFileUrls(message, options = {}) {
  const includeTranscriptFiles = options.includeTranscriptFiles === true;
  const urls = [];
  const attachmentsByName = new Map();

  for (const attachment of attachmentValues(message?.attachments)) {
    if (attachment?.name && attachment?.url) attachmentsByName.set(attachment.name, attachment.url);
    if (!attachment?.url) continue;
    if (!includeTranscriptFiles && isTranscriptFileAttachment(attachment)) continue;
    urls.push(attachment.url);
  }

  const visit = (component) => {
    if (!component || typeof component !== 'object') return;
    if (component.type === 13 && component.file?.url) {
      const resolved = resolveComponentFileUrl(component.file.url, attachmentsByName);
      if (resolved) urls.push(resolved);
    }
    if (component.type === 12 && Array.isArray(component.items)) {
      for (const item of component.items) {
        const resolved = resolveComponentFileUrl(item?.media?.url, attachmentsByName);
        if (resolved) urls.push(resolved);
      }
    }
    if (Array.isArray(component.components)) {
      for (const child of component.components) visit(child);
    }
  };

  for (const component of componentValues(message?.components)) visit(component);
  return [...new Set(urls)];
}

function summarizeTicketDetails(details) {
  const source = details && typeof details === 'object' ? details : {};
  const entries = Object.entries(source);
  if (!entries.length) return 'No extra details stored.';
  return entries.slice(0, 20).map(([key, value]) => {
    if (value === null || value === undefined || value === '') return `- ${key}: null`;
    if (typeof value === 'object') return `- ${key}: ${truncate(JSON.stringify(value), 120)}`;
    return `- ${key}: ${truncate(String(value), 120)}`;
  }).join('\n');
}

function buildTicketLookupContainer(ticket, lookupCode, transcriptResult = null) {
  const ticketId = `${ticket?.id || ''}`;
  const shortId = ticketId ? ticketId.slice(-6).toUpperCase() : 'N/A';
  const core = [
    `Type: ${ticket?.ticketType || 'N/A'}`,
    `Status: ${ticket?.status || 'N/A'}`,
    `Opener: ${ticket?.openerId ? `<@${ticket.openerId}>` : 'N/A'}`,
    `Closed By: ${ticket?.closedBy ? `<@${ticket.closedBy}>` : ticket?.details?.closedBy ? `<@${ticket.details.closedBy}>` : 'N/A'}`,
    `Claimed By: ${ticket?.claimedBy ? `<@${ticket.claimedBy}>` : 'N/A'}`,
  ].join('\n');
  const timeline = [
    `Created: ${formatTimestamp(ticket?.createdAt)}`,
    `Updated: ${formatTimestamp(ticket?.updatedAt)}`,
    `Closed: ${formatTimestamp(ticket?.closedAt)}`,
  ].join('\n');

  const container = new ContainerBuilder()
    .setAccentColor(0x3498db)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent([
        '## Ticket Lookup Result',
        `Lookup: \`${lookupCode}\``,
        `Matched Ticket: \`#${shortId}\``,
      ].join('\n')),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent([
        `**Identifiers**\nFull ID: \`${ticketId || 'N/A'}\`\nShort ID: \`#${shortId}\`\nGuild ID: \`${ticket?.guildId || 'N/A'}\``,
        '',
        `**Core**\n${core}`,
        '',
        `**Channel**\nChannel ID: \`${ticket?.channelId || 'N/A'}\`\nParent Category ID: \`${ticket?.parentCategoryId || 'N/A'}\``,
        '',
        `**Timeline**\n${timeline}`,
      ].join('\n')),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**Known Details**\n${truncate(summarizeTicketDetails(ticket?.details), 1024)}`),
    );

  if (transcriptResult) {
    const transcriptLinks = transcriptResult.transcriptFileUrls?.length
      ? truncate(transcriptResult.transcriptFileUrls.join('\n'), 1024)
      : 'No transcript file links found.';
    const relatedLinks = transcriptResult.relatedAttachmentUrls?.length
      ? truncate(transcriptResult.relatedAttachmentUrls.join('\n'), 1024)
      : 'No related attachment file links found.';
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent([
        '**Transcript Search**',
        `Found: ${transcriptResult.found ? 'yes' : 'no'}`,
        `Transcript Files:\n${transcriptLinks}`,
        `Related Attachment Files:\n${relatedLinks}`,
      ].join('\n')),
    );
  }

  return container;
}

function buildTicketJsonAttachment(ticket) {
  const payload = JSON.stringify(ticket?.toObject?.() || ticket || {}, null, 2);
  return new AttachmentBuilder(Buffer.from(payload, 'utf8'), {
    name: `lookup-${ticket?.id || 'ticket'}.json`,
  });
}

async function searchTicketsByUserId(guildId, userId) {
  return Ticket.find({
    guildId,
    $or: [
      { openerId: userId },
      { claimedBy: userId },
      { addedUsers: userId },
    ],
  }).sort({ updatedAt: -1 }).limit(LOOKUP_MAX_DB_SCAN);
}

async function searchTicketsByTextInDetails(guildId, searchText) {
  const lowerText = `${searchText || ''}`.toLowerCase();
  const matches = await Ticket.find({ guildId }).sort({ updatedAt: -1 }).limit(LOOKUP_MAX_DB_SCAN);
  return matches.filter(ticket => {
    if (`${ticket.ticketType || ''}`.toLowerCase().includes(lowerText)) return true;
    if (`${ticket.status || ''}`.toLowerCase().includes(lowerText)) return true;
    if (`${ticket.channelId || ''}`.toLowerCase().includes(lowerText)) return true;
    if (ticket.details && JSON.stringify(ticket.details).toLowerCase().includes(lowerText)) return true;
    return false;
  });
}

async function findTicketByLookupCode(guildId, lookupCode) {
  const query = parseSearchQuery(lookupCode);

  if (query.type === 'ticket_id_full') {
    const byId = await Ticket.findById(query.value);
    if (byId && `${byId.guildId}` === `${guildId}`) return { ticket: byId, matches: [], searchType: query.type };
    return { ticket: null, matches: [], searchType: query.type };
  }

  if (query.type === 'user_id') {
    const matches = await searchTicketsByUserId(guildId, query.value);
    return { ticket: matches.length === 1 ? matches[0] : null, matches, searchType: query.type };
  }

  if (query.type === 'ticket_id_suffix') {
    const recentTickets = await Ticket.find({ guildId }).sort({ createdAt: -1 }).limit(LOOKUP_MAX_DB_SCAN);
    const matches = recentTickets.filter(ticket => `${ticket.id || ''}`.toUpperCase().endsWith(query.value));
    if (matches.length) return { ticket: matches.length === 1 ? matches[0] : null, matches, searchType: query.type };
    const textMatches = await searchTicketsByTextInDetails(guildId, query.value);
    return { ticket: textMatches.length === 1 ? textMatches[0] : null, matches: textMatches, searchType: 'text_search' };
  }

  const textMatches = await searchTicketsByTextInDetails(guildId, query.value);
  return { ticket: textMatches.length === 1 ? textMatches[0] : null, matches: textMatches, searchType: query.type };
}

async function getTranscriptChannel(guild) {
  const ids = [
    process.env.TICKET_TRANSCRIPTS_CHANNEL_ID,
    process.env.TICKET_LOGS_CHANNEL_ID,
    process.env.LOGS_CHANNEL_ID,
  ].map(v => `${v || ''}`.trim()).filter(Boolean);

  for (const id of ids) {
    const channel = await guild.channels.fetch(id).catch(() => null);
    if (channel?.type === ChannelType.GuildText) return channel;
  }

  await guild.channels.fetch().catch(() => null);
  return guild.channels.cache.find(ch =>
    ch?.type === ChannelType.GuildText &&
    `${ch.name || ''}`.trim().toLowerCase() === 'ticket-transcripts',
  ) || null;
}

async function extractTicketIdFromTranscriptAttachment(message) {
  const transcriptAttachment = attachmentValues(message?.attachments).find(attachment =>
    `${attachment?.name || ''}`.toLowerCase().endsWith('.txt') &&
    isTranscriptFileAttachment(attachment),
  );
  if (!transcriptAttachment?.url) return '';
  const response = await fetch(transcriptAttachment.url).catch(() => null);
  if (!response?.ok) return '';
  const text = await response.text().catch(() => '');
  return `${text.match(/^Ticket ID:\s*(.+)$/m)?.[1] || ''}`.trim();
}

async function findTranscriptByTicketId(transcriptChannel, ticketId) {
  const targetId = `${ticketId || ''}`.trim().toUpperCase();
  let before;
  let scannedMessages = 0;
  let scannedCandidates = 0;

  while (true) {
    const batch = await transcriptChannel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) {
      return { found: false, transcriptFileUrls: [], relatedAttachmentUrls: [], scannedMessages, scannedCandidates };
    }

    for (const message of batch.values()) {
      scannedMessages += 1;
      if (!isTranscriptSummaryMessage(message)) continue;
      scannedCandidates += 1;
      const transcriptTicketId = await extractTicketIdFromTranscriptAttachment(message);
      if (`${transcriptTicketId}`.toUpperCase() !== targetId) continue;
      return {
        found: true,
        transcriptTicketId,
        transcriptFileUrls: collectMessageFileUrls(message, { includeTranscriptFiles: true }),
        relatedAttachmentUrls: collectMessageFileUrls(message),
        scannedMessages,
        scannedCandidates,
      };
    }

    before = batch.last()?.id;
  }
}

async function searchTranscriptsByKeyword(transcriptChannel, keyword) {
  const lowerKeyword = `${keyword || ''}`.toLowerCase();
  const matches = [];
  let before;

  while (true) {
    const batch = await transcriptChannel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;
    for (const message of batch.values()) {
      if (!isTranscriptSummaryMessage(message)) continue;
      const transcriptAttachment = attachmentValues(message.attachments).find(attachment =>
        `${attachment?.name || ''}`.toLowerCase().endsWith('.txt') &&
        isTranscriptFileAttachment(attachment),
      );
      if (!transcriptAttachment?.url) continue;
      const response = await fetch(transcriptAttachment.url).catch(() => null);
      if (!response?.ok) continue;
      const text = await response.text().catch(() => '');
      if (!text.toLowerCase().includes(lowerKeyword)) continue;
      const ticketId = `${text.match(/^Ticket ID:\s*(.+)$/m)?.[1] || ''}`.trim();
      if (ticketId) matches.push(ticketId);
    }
    before = batch.last()?.id;
  }

  return [...new Set(matches)];
}

function isStaff(interaction) {
  const adminIds = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const staffRoleId = `${process.env.TICKET_STAFF_ROLE_ID || ''}`.trim();
  if (adminIds.includes(interaction.user.id)) return true;
  if (staffRoleId && interaction.member?.roles?.cache?.has(staffRoleId)) return true;
  return false;
}

function buildAmbiguousContainer(matches, lookupCode) {
  const lines = matches.slice(0, 10).map((ticket, index) =>
    `${index + 1}. #${`${ticket.id || ''}`.slice(-6).toUpperCase()} (${ticket.ticketType} - ${ticket.status})`,
  );
  return new ContainerBuilder()
    .setAccentColor(0xf1c40f)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent([
        `## Multiple Tickets Found`,
        `Lookup: \`${lookupCode}\``,
        '',
        lines.join('\n') || 'No displayable matches.',
        '',
        'Use more of the ticket ID for a unique match.',
      ].join('\n')),
    );
}

async function handleLookupCommand(interaction) {
  if (!isStaff(interaction)) {
    return interaction.reply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [
        new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(
          new TextDisplayBuilder().setContent('❌ Only staff can use /lookup.'),
        ),
      ],
    });
  }

  const raw = interaction.options.getString('ticket', true);
  const searchTranscripts = interaction.options.getBoolean('search_transcripts');
  const lookupCode = normalizeLookupCode(raw);
  if (!lookupCode || (lookupCode.length < 3 && !/^\d{17,20}$/.test(lookupCode))) {
    return interaction.reply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [
        new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(
          new TextDisplayBuilder().setContent('❌ Search by ticket code, full ticket ID, user mention/ID, or ticket detail text.'),
        ),
      ],
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let lookupResult = await findTicketByLookupCode(interaction.guild.id, lookupCode);
  if (!lookupResult.ticket && searchTranscripts !== false) {
    const transcriptChannel = await getTranscriptChannel(interaction.guild);
    if (transcriptChannel) {
      const ids = await searchTranscriptsByKeyword(transcriptChannel, lookupCode).catch(() => []);
      const transcriptMatches = (await Promise.all(ids.map(id => Ticket.findById(id).catch(() => null))))
        .filter(ticket => ticket && `${ticket.guildId}` === `${interaction.guild.id}`);
      if (transcriptMatches.length) {
        lookupResult = {
          ticket: transcriptMatches.length === 1 ? transcriptMatches[0] : null,
          matches: transcriptMatches,
          searchType: 'transcript_search',
        };
      }
    }
  }

  if (!lookupResult.ticket && lookupResult.matches?.length > 1) {
    return interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [buildAmbiguousContainer(lookupResult.matches, lookupCode)],
      allowedMentions: { parse: [] },
    });
  }

  if (!lookupResult.ticket) {
    return interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        new ContainerBuilder().setAccentColor(0xe74c3c).addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`❌ No ticket found for \`${lookupCode}\`.`),
        ),
      ],
      allowedMentions: { parse: [] },
    });
  }

  let transcriptResult = null;
  const transcriptChannel = await getTranscriptChannel(interaction.guild);
  if (transcriptChannel) {
    transcriptResult = await findTranscriptByTicketId(transcriptChannel, lookupResult.ticket.id).catch(() => null);
  }

  return interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [buildTicketLookupContainer(lookupResult.ticket, lookupCode, transcriptResult)],
    files: [buildTicketJsonAttachment(lookupResult.ticket)],
    allowedMentions: { parse: [] },
  });
}

module.exports = {
  collectMessageFileUrls,
  findTicketByLookupCode,
  findTranscriptByTicketId,
  handleLookupCommand,
  isTranscriptSummaryMessage,
  normalizeLookupCode,
  parseSearchQuery,
};
