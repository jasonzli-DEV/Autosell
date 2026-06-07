const {
  AttachmentBuilder,
  ContainerBuilder,
  FileBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  TextDisplayBuilder,
} = require('discord.js');

function escapeHtml(value) {
  return `${value ?? ''}`
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeWhitespace(text) {
  return `${text || ''}`.replace(/\s+/g, ' ').trim();
}

function attachmentValues(attachments) {
  if (!attachments) return [];
  if (typeof attachments.values === 'function') return [...attachments.values()];
  if (Array.isArray(attachments)) return attachments;
  return [];
}

function collectComponentText(components) {
  const snippets = [];
  const visit = (component) => {
    if (!component || typeof component !== 'object') return;
    const content = normalizeWhitespace(component.content || component.label || component.placeholder);
    if (content) snippets.push(content);
    if (Array.isArray(component.components)) {
      for (const child of component.components) visit(child);
    }
  };
  for (const component of Array.isArray(components) ? components : []) visit(component);
  return snippets;
}

function getAuthorName(author) {
  return author?.displayName || author?.globalName || author?.username || author?.tag || 'Unknown User';
}

function getAuthorSubline(author) {
  return author?.tag || author?.id || 'unknown';
}

function getAvatarUrl(author) {
  if (!author) return '';
  if (typeof author.displayAvatarURL === 'function') {
    return author.displayAvatarURL({ extension: 'png', size: 128 });
  }
  return author.avatarURL || '';
}

function formatIso(timestamp) {
  return new Date(timestamp || Date.now()).toISOString();
}

function formatDisplayTime(timestamp) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp || Date.now()));
}

async function collectAllMessages(channel) {
  const all = [];
  let before;

  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;
    all.push(...batch.values());
    before = batch.last()?.id;
    if (!before || batch.size < 100) break;
  }

  all.sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0));
  return all;
}

function buildTranscriptText(messages, ticket, reason, options = {}) {
  const lines = [
    'Ticket Transcript',
    `Ticket ID: ${ticket.id}`,
    `Guild ID: ${ticket.guildId}`,
    `Channel ID: ${ticket.channelId}`,
    `Channel Name: ${options.channelName || 'unknown'}`,
    `Opened By: ${ticket.openerId}`,
    `Ticket Type: ${ticket.ticketType}`,
    `Closed Reason: ${reason || 'Closed'}`,
    `Generated At: ${formatIso(options.generatedAt)}`,
    '',
  ];

  for (const message of Array.isArray(messages) ? messages : []) {
    const timestamp = formatIso(message.createdTimestamp);
    const author = message.author ? `${getAuthorSubline(message.author)} (${message.author.id || 'unknown'})` : 'Unknown';
    const parts = [];

    if (message.content) parts.push(message.content);
    for (const embed of Array.isArray(message.embeds) ? message.embeds : []) {
      const title = embed.title ? `title=${embed.title}` : '';
      const desc = embed.description ? `description=${embed.description}` : '';
      parts.push(`[Embed: ${[title, desc].filter(Boolean).join(' | ') || 'Embed'}]`);
    }
    for (const snippet of collectComponentText(message.components)) {
      parts.push(`[Component: ${snippet}]`);
    }
    const attachments = attachmentValues(message.attachments);
    if (attachments.length) {
      parts.push(`[Attachments: ${attachments.map(a => a.name || 'attachment').join(', ')}]`);
    }
    lines.push(`[${timestamp}] ${author}: ${parts.join(' ') || '[No text content]'}`);
  }

  return lines.join('\n');
}

function buildAttachmentHtml(attachment) {
  const name = escapeHtml(attachment?.name || 'attachment');
  const url = escapeHtml(attachment?.url || attachment?.proxyURL || '');
  const contentType = `${attachment?.contentType || ''}`.toLowerCase();
  const isImage = contentType.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(name);
  const size = Number(attachment?.size || 0);
  const sizeText = size > 0 ? `${Math.ceil(size / 1024)} KB` : 'attachment';

  if (isImage && url) {
    return [
      '<figure class="attachment image-attachment">',
      `<a href="${url}" download="${name}"><img src="${url}" alt="${name}" loading="lazy"></a>`,
      `<figcaption><span>${name} - ${escapeHtml(sizeText)}</span><a href="${url}" download="${name}">Download</a></figcaption>`,
      '</figure>',
    ].join('');
  }

  return `<a class="attachment file-attachment" href="${url}" download="${name}"><span>${name}</span><small>${escapeHtml(sizeText)}</small></a>`;
}

function buildTranscriptHtml(messages, ticket, options = {}) {
  const generatedAt = options.generatedAt || new Date();
  const channelName = options.channelName || 'ticket';
  const guildName = options.guildName || 'Discord';
  const reason = options.reason || 'Closed';
  const messageHtml = (Array.isArray(messages) ? messages : []).map((message) => {
    const author = message.author || {};
    const avatar = getAvatarUrl(author);
    const avatarHtml = avatar
      ? `<img class="avatar" src="${escapeHtml(avatar)}" alt="">`
      : `<div class="avatar fallback">${escapeHtml(getAuthorName(author).slice(0, 1).toUpperCase())}</div>`;
    const content = escapeHtml(message.content || '').replace(/\n/g, '<br>');
    const embeds = (Array.isArray(message.embeds) ? message.embeds : []).map(embed => [
      '<div class="embed">',
      embed.title ? `<strong>${escapeHtml(embed.title)}</strong>` : '',
      embed.description ? `<p>${escapeHtml(embed.description).replace(/\n/g, '<br>')}</p>` : '',
      '</div>',
    ].join('')).join('');
    const components = collectComponentText(message.components)
      .map(text => `<div class="component">${escapeHtml(text)}</div>`)
      .join('');
    const attachments = attachmentValues(message.attachments).map(buildAttachmentHtml).join('');

    return [
      '<article class="message">',
      avatarHtml,
      '<div class="message-body">',
      '<div class="message-meta">',
      `<span class="author">${escapeHtml(getAuthorName(author))}</span>`,
      `<time datetime="${escapeHtml(formatIso(message.createdTimestamp))}">${escapeHtml(formatDisplayTime(message.createdTimestamp))}</time>`,
      '</div>',
      content ? `<div class="content">${content}</div>` : '',
      embeds,
      components,
      attachments ? `<div class="attachments">${attachments}</div>` : '',
      '</div>',
      '</article>',
    ].join('');
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>#${escapeHtml(channelName)} - Transcript</title>
<style>
:root { color-scheme: dark; --chat:#313338; --header:#313338; --line:#3f4147; --text:#dbdee1; --muted:#949ba4; --brand:#5865f2; --embed:#2b2d31; --hover:#2e3035; --input:#383a40; }
* { box-sizing: border-box; }
html, body { min-height: 100%; }
body { margin: 0; background: var(--chat); color: var(--text); font: 15px/1.45 "gg sans", "Noto Sans", "Helvetica Neue", Arial, sans-serif; }
.discord-channel { min-height: 100vh; display: flex; flex-direction: column; background: var(--chat); }
.channel-header { height: 48px; display: flex; align-items: center; gap: 10px; padding: 0 16px; background: var(--header); border-bottom: 1px solid var(--line); box-shadow: 0 1px 0 rgba(0,0,0,.2); position: sticky; top: 0; z-index: 2; }
h1 { margin: 0; font-size: 16px; font-weight: 700; color: #f2f3f5; }
.topic { min-width: 0; color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.messages { flex: 1; padding: 16px 0 24px; }
.summary { margin: 0 16px 16px 72px; padding: 14px 16px; border-radius: 4px; background: var(--input); color: var(--muted); font-size: 13px; display: grid; gap: 4px; max-width: 760px; }
.message { display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 0; padding: 2px 16px 2px 0; min-height: 44px; }
.message:hover { background: var(--hover); }
.avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; background: #5865f2; display: grid; place-items: center; color: white; font-weight: 800; }
.message > .avatar { margin: 2px 16px 0 16px; }
.message-meta { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.author { font-weight: 700; color: #f2f3f5; overflow-wrap: anywhere; }
time { color: var(--muted); font-size: 12px; white-space: nowrap; }
.content { margin-top: 2px; white-space: normal; overflow-wrap: anywhere; }
.embed { margin-top: 8px; max-width: 560px; padding: 10px 12px; border-left: 4px solid var(--brand); border-radius: 4px; background: var(--embed); }
.embed p { margin: 4px 0 0; color: #c9ccd1; }
.component { display: inline-block; margin-top: 8px; padding: 6px 9px; border: 1px solid var(--line); border-radius: 4px; color: #c9ccd1; background: #25272b; }
.attachments { display: grid; gap: 8px; margin-top: 8px; max-width: 560px; }
.image-attachment { margin: 0; overflow: hidden; border-radius: 5px; border: 1px solid var(--line); background: #25272b; }
.image-attachment img { display: block; max-width: 100%; max-height: 420px; object-fit: contain; background: #111214; }
figcaption { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 12px; padding: 7px 9px; }
figcaption a { color: #b5bac1; text-decoration: none; font-weight: 700; }
.file-attachment small { display: block; color: var(--muted); font-size: 12px; }
.file-attachment { display: block; width: fit-content; min-width: 220px; max-width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 5px; color: #dee0fc; background: #25272b; text-decoration: none; }
.file-attachment span { display: block; overflow-wrap: anywhere; font-weight: 700; }
@media (max-width: 760px) {
  .summary { margin-left: 16px; }
}
</style>
</head>
<body>
<section class="discord-channel">
<header class="channel-header"><h1># ${escapeHtml(channelName)}</h1><div class="topic">${escapeHtml(guildName)} ticket transcript - ${escapeHtml(formatDisplayTime(generatedAt))}</div></header>
<main class="messages">
<div class="summary">
<span>Ticket: ${escapeHtml(ticket.id)}</span>
<span>Type: ${escapeHtml(ticket.ticketType)}</span>
<span>Reason: ${escapeHtml(reason)}</span>
</div>
${messageHtml || '<p class="empty">No messages were captured.</p>'}
</main>
</section>
</body>
</html>`;
}

function safeFileStem(name) {
  return `${name || 'ticket-transcript'}`.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90) || 'ticket-transcript';
}

function buildTranscriptFileAttachments({ text, html, baseName }) {
  const stem = safeFileStem(baseName);
  return [
    new AttachmentBuilder(Buffer.from(`${text || ''}`, 'utf8'), { name: `${stem}.txt` }),
    new AttachmentBuilder(Buffer.from(`${html || ''}`, 'utf8'), { name: `${stem}.html` }),
  ];
}

function getFileName(file) {
  return `${file?.name || file?.attachment?.name || ''}`.trim();
}

function buildTranscriptSummaryPayload({ ticket, channelName, reason, closedBy, files }) {
  const transcriptFiles = Array.isArray(files) ? files : [];
  const container = new ContainerBuilder()
    .setAccentColor(0x3498db)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent([
        '📋 Closed ticket transcript',
        `Channel: ${channelName || ticket?.channelId || 'unknown'}`,
        `Ticket Type: ${ticket?.ticketType || 'unknown'}`,
        `Opened By: <@${ticket?.openerId || 'unknown'}>`,
        `Closed By: ${closedBy ? `<@${closedBy}>` : 'System'}`,
        `Reason: ${reason || 'Closed'}`,
        `Transcript Files: ${transcriptFiles.length}`,
      ].join('\n')),
    );

  for (const file of transcriptFiles) {
    const fileName = getFileName(file);
    if (fileName) container.addFileComponents(new FileBuilder().setURL(`attachment://${fileName}`));
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: [container],
    files: transcriptFiles,
  };
}

function buildClosedDmPayload({ guildName, channelName, ticket, reason, closedBy, files }) {
  const shortId = `${ticket?.id || ''}`.slice(-6).toUpperCase();
  const transcriptFiles = Array.isArray(files) ? files : [];
  const container = new ContainerBuilder()
    .setAccentColor(0x3498db)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent([
        '## 🔒 Your ticket has been closed',
        `**Server:** ${guildName || 'Discord'}`,
        `**Ticket:** ${channelName || 'deleted-ticket'}${shortId ? ` (\`#${shortId}\`)` : ''}`,
        `**Type:** ${ticket?.ticketType || 'unknown'}`,
        `**Closed by:** ${closedBy ? `<@${closedBy}>` : 'System'}`,
        `**Reason:** ${reason || 'Closed'}`,
        '',
        '**Transcript files are attached below.**',
      ].join('\n')),
    );

  for (const file of transcriptFiles) {
    const fileName = getFileName(file);
    if (fileName) container.addFileComponents(new FileBuilder().setURL(`attachment://${fileName}`));
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: [container],
    files: transcriptFiles,
  };
}

function getTranscriptAttachmentDownloadUrls(attachment) {
  return [...new Set([attachment?.url, attachment?.proxyURL].map(url => `${url || ''}`.trim()).filter(Boolean))];
}

async function downloadTranscriptAttachment(attachment) {
  const urls = getTranscriptAttachmentDownloadUrls(attachment);
  if (!urls.length) throw new Error('Attachment URL missing');
  const failures = [];
  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      failures.push(`${url}: HTTP ${response.status}`);
    } catch (error) {
      failures.push(`${url}: ${error.message || error}`);
    }
  }
  throw new Error(`Unable to download attachment (${failures.join('; ')})`);
}

function isImageAttachment(attachment) {
  const contentType = `${attachment?.contentType || ''}`.toLowerCase();
  const name = `${attachment?.name || ''}`;
  return contentType.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(name);
}

function buildForwardedTranscriptAttachmentPayload(message, attachment, forwardedFile) {
  const fileName = `${forwardedFile?.name || attachment?.name || 'attachment'}`.trim() || 'attachment';
  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent([
        `📎 Attachment from <@${message.author?.id || 'unknown'}>`,
        `Message Timestamp: <t:${Math.floor((message.createdTimestamp || Date.now()) / 1000)}:F>`,
        `File: ${attachment?.name || fileName}`,
      ].join('\n')),
    );

  if (isImageAttachment(attachment)) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(`attachment://${fileName}`),
      ),
    );
  } else {
    container.addFileComponents(new FileBuilder().setURL(`attachment://${fileName}`));
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: [container],
    files: [forwardedFile],
  };
}

async function forwardAttachments(transcriptChannel, messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const attachment of attachmentValues(message.attachments)) {
      try {
        const buffer = await downloadTranscriptAttachment(attachment);
        const fileName = `${attachment.name || `attachment-${attachment.id || message.id}`}`.trim() || 'attachment';
        const forwardedFile = new AttachmentBuilder(buffer, { name: fileName });
        await transcriptChannel.send(buildForwardedTranscriptAttachmentPayload(message, attachment, forwardedFile));
      } catch (error) {
        const fallbackUrl = getTranscriptAttachmentDownloadUrls(attachment)[0];
        await transcriptChannel.send({
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { parse: [] },
          components: [
            new ContainerBuilder()
              .setAccentColor(0xf1c40f)
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent([
                  `⚠️ Could not re-upload attachment from <@${message.author?.id || 'unknown'}>.`,
                  `Message Timestamp: <t:${Math.floor((message.createdTimestamp || Date.now()) / 1000)}:F>`,
                  `File: ${attachment.name || 'attachment'}`,
                  `Original URL: ${fallbackUrl || error.message}`,
                ].join('\n')),
              ),
          ],
        }).catch(() => null);
      }
    }
  }
}

module.exports = {
  collectAllMessages,
  buildTranscriptText,
  buildTranscriptHtml,
  buildTranscriptFileAttachments,
  buildTranscriptSummaryPayload,
  buildClosedDmPayload,
  getTranscriptAttachmentDownloadUrls,
  downloadTranscriptAttachment,
  buildForwardedTranscriptAttachmentPayload,
  forwardAttachments,
};
