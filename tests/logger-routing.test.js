const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveLogChannelIds } = require('../src/lib/logger');

function withEnv(values, fn) {
  const previous = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    if (values[key] == null) delete process.env[key];
    else process.env[key] = values[key];
  }

  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('routes categorized payment and transcript logs to specific channels before the fallback log channel', () => {
  withEnv({
    LOGS_CHANNEL_ID: 'logs',
    DONUT_PAYMENT_LOGS_CHANNEL_ID: 'donut',
    LTC_PAYMENT_LOGS_CHANNEL_ID: 'ltc',
    TICKET_TRANSCRIPTS_CHANNEL_ID: 'transcripts',
  }, () => {
    assert.deepEqual(resolveLogChannelIds({ category: 'donut' }), ['donut', 'logs']);
    assert.deepEqual(resolveLogChannelIds({ category: 'ltc' }), ['ltc', 'logs']);
    assert.deepEqual(resolveLogChannelIds({ category: 'giveaway' }), ['transcripts', 'logs']);
  });
});

test('routes ticket, transcript, invite, join, and autosell logs through separate env channels', () => {
  withEnv({
    LOGS_CHANNEL_ID: 'logs',
    AUTOSELL_LOGS_CHANNEL_ID: 'autosell',
    DONUT_PAYMENT_LOGS_CHANNEL_ID: '',
    INVITE_LOGS_CHANNEL_ID: 'invites',
    JOIN_LOGS_CHANNEL_ID: 'joins',
    TICKET_LOGS_CHANNEL_ID: 'tickets',
    TICKET_TRANSCRIPTS_CHANNEL_ID: 'transcripts',
  }, () => {
    assert.deepEqual(resolveLogChannelIds({ category: 'ticket' }), ['tickets', 'logs']);
    assert.deepEqual(resolveLogChannelIds({ category: 'transcript' }), ['transcripts', 'tickets', 'logs']);
    assert.deepEqual(resolveLogChannelIds({ category: 'invite' }), ['invites', 'logs']);
    assert.deepEqual(resolveLogChannelIds({ category: 'join' }), ['joins', 'invites', 'logs']);
    assert.deepEqual(resolveLogChannelIds({ category: 'autosell' }), ['autosell', 'logs']);
    assert.deepEqual(resolveLogChannelIds({ category: 'donut' }), ['autosell', 'logs']);
  });
});
