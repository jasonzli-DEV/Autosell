const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTranscriptHtml,
  buildTranscriptText,
  buildTranscriptFileAttachments,
  buildTranscriptSummaryPayload,
  buildForwardedTranscriptAttachmentPayload,
} = require('../src/lib/ticketTranscript');

function makeAttachment(fields) {
  return {
    id: fields.id || 'att-1',
    name: fields.name,
    url: fields.url,
    proxyURL: fields.proxyURL,
    contentType: fields.contentType,
    size: fields.size || 0,
  };
}

test('builds a Discord-like HTML transcript with authors, timestamps, avatars, content, and image attachments', () => {
  const messages = [
    {
      id: 'msg-1',
      createdTimestamp: Date.UTC(2026, 5, 4, 21, 15, 0),
      author: {
        id: 'user-1',
        tag: 'Homer#0001',
        username: 'Homer',
        displayName: 'Homer dropped his donut',
        displayAvatarURL: () => 'https://cdn.example/homer.png',
      },
      content: 'I want to sell 10b',
      embeds: [],
      components: [],
      attachments: new Map([
        ['att-1', makeAttachment({
          id: 'att-1',
          name: 'proof.png',
          url: 'https://cdn.example/proof.png',
          contentType: 'image/png',
          size: 1234,
        })],
      ]),
    },
    {
      id: 'msg-2',
      createdTimestamp: Date.UTC(2026, 5, 4, 21, 16, 30),
      author: {
        id: 'staff-1',
        tag: 'Jason#0001',
        username: 'Jason',
        displayName: 'Jason [OVH]',
        displayAvatarURL: () => 'https://cdn.example/jason.png',
      },
      content: 'I can help.',
      embeds: [{ title: 'Ticket Details', description: 'Amount: 10b' }],
      components: [],
      attachments: new Map(),
    },
  ];
  const ticket = {
    id: 'ticket-1',
    guildId: 'guild-1',
    channelId: 'channel-1',
    openerId: 'user-1',
    ticketType: 'sell_money',
  };

  const html = buildTranscriptHtml(messages, ticket, {
    guildName: 'Autosell',
    channelName: 'sell-money-homer',
    reason: 'Closed by staff',
    generatedAt: new Date(Date.UTC(2026, 5, 4, 22, 0, 0)),
  });

  assert.match(html, /class="discord-channel"/);
  assert.match(html, /class="channel-header"/);
  assert.match(html, /# sell-money-homer/);
  assert.doesNotMatch(html, /class="servers"/);
  assert.doesNotMatch(html, /Text Channels/);
  assert.match(html, /Autosell ticket transcript -/);
  assert.match(html, /Homer dropped his donut/);
  assert.match(html, /Jason \[OVH\]/);
  assert.match(html, /I want to sell 10b/);
  assert.match(html, /proof\.png/);
  assert.match(html, /https:\/\/cdn\.example\/proof\.png/);
  assert.match(html, /download="proof\.png"/);
  assert.match(html, /Ticket Details/);
  assert.match(html, /Amount: 10b/);
});

test('text transcript still includes message content and attachment names', () => {
  const text = buildTranscriptText([
    {
      id: 'msg-1',
      createdTimestamp: Date.UTC(2026, 5, 4, 21, 15, 0),
      author: { id: 'user-1', tag: 'Homer#0001' },
      content: 'payment sent',
      embeds: [],
      components: [],
      attachments: new Map([
        ['att-1', makeAttachment({ name: 'proof.png', url: 'https://cdn.example/proof.png' })],
      ]),
    },
  ], { id: 'ticket-1', guildId: 'guild-1', channelId: 'channel-1', openerId: 'user-1', ticketType: 'sell_money' }, 'Closed');

  assert.match(text, /payment sent/);
  assert.match(text, /proof\.png/);
});

test('transcript summary links the HTML Discord preview file without pinging duplicate users', () => {
  const files = buildTranscriptFileAttachments({
    text: 'plain transcript',
    html: '<!doctype html><title>preview</title>',
    baseName: 'sell-spawner-jason-transcript',
  });
  const payload = buildTranscriptSummaryPayload({
    ticket: {
      id: 'ticket-1',
      openerId: 'user-1',
      ticketType: 'sell_spawners',
    },
    channelName: 'sell-spawner-jason',
    reason: 'Closed by jasonzli',
    closedBy: 'user-1',
    files,
  });
  const componentJson = payload.components[0].toJSON();
  const fileUrls = componentJson.components
    .filter(component => component.type === 13)
    .map(component => component.file.url);

  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.equal(payload.files.length, 2);
  assert.deepEqual(fileUrls, [
    'attachment://sell-spawner-jason-transcript.txt',
    'attachment://sell-spawner-jason-transcript.html',
  ]);
});

test('forwarded transcript attachments render as Discord media or file components', () => {
  const imagePayload = buildForwardedTranscriptAttachmentPayload(
    {
      id: 'msg-1',
      createdTimestamp: Date.UTC(2026, 5, 4, 21, 15, 0),
      author: { id: 'user-1', tag: 'Homer#0001' },
    },
    makeAttachment({ name: 'proof.png', contentType: 'image/png' }),
    { name: 'proof.png' },
  );
  const filePayload = buildForwardedTranscriptAttachmentPayload(
    {
      id: 'msg-2',
      createdTimestamp: Date.UTC(2026, 5, 4, 21, 16, 0),
      author: { id: 'user-1', tag: 'Homer#0001' },
    },
    makeAttachment({ name: 'notes.txt', contentType: 'text/plain' }),
    { name: 'notes.txt' },
  );

  const imageComponents = imagePayload.components[0].toJSON().components;
  const fileComponents = filePayload.components[0].toJSON().components;

  assert.deepEqual(imagePayload.allowedMentions, { parse: [] });
  assert.equal(imageComponents.find(component => component.type === 12).items[0].media.url, 'attachment://proof.png');
  assert.equal(fileComponents.find(component => component.type === 13).file.url, 'attachment://notes.txt');
});
