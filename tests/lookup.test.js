const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  collectMessageFileUrls,
  isTranscriptSummaryMessage,
  normalizeLookupCode,
  parseSearchQuery,
} = require('../src/systems/lookup');

test('/lookup command is registered like Aura', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  const lookupSource = fs.readFileSync(path.join(__dirname, '../src/commands/lookup.js'), 'utf8');

  assert.match(indexSource, /lookupCommand/);
  assert.match(indexSource, /lookup: lookupCommand/);
  assert.match(lookupSource, /\.setName\('lookup'\)/);
  assert.match(lookupSource, /\.setName\('ticket'\)/);
  assert.match(lookupSource, /\.setName\('search_transcripts'\)/);
});

test('lookup parses ticket codes, user IDs, and free text', () => {
  assert.equal(normalizeLookupCode('#abc123'), 'ABC123');
  assert.deepEqual(parseSearchQuery('<@123456789012345678>'), {
    type: 'user_id',
    value: '123456789012345678',
  });
  assert.deepEqual(parseSearchQuery('64 skellys'), {
    type: 'text_search',
    value: '64 skellys',
  });
});

test('lookup resolves transcript file components and image components to downloadable URLs', () => {
  const message = {
    content: '',
    embeds: [],
    attachments: new Map([
      ['txt', { name: 'sell-spawner-transcript.txt', url: 'https://cdn.example/transcript.txt' }],
      ['html', { name: 'sell-spawner-transcript.html', url: 'https://cdn.example/transcript.html' }],
      ['proof', { name: 'proof.png', url: 'https://cdn.example/proof.png' }],
    ]),
    components: [
      {
        type: 17,
        components: [
          { type: 10, content: '📋 Closed ticket transcript' },
          { type: 13, file: { url: 'attachment://sell-spawner-transcript.html' } },
          { type: 12, items: [{ media: { url: 'attachment://proof.png' } }] },
        ],
      },
    ],
  };

  assert.equal(isTranscriptSummaryMessage(message), true);
  assert.deepEqual(collectMessageFileUrls(message, { includeTranscriptFiles: true }), [
    'https://cdn.example/transcript.txt',
    'https://cdn.example/transcript.html',
    'https://cdn.example/proof.png',
  ]);
});
