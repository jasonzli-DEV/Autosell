const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveLogChannelIds } = require('../src/lib/logger');

test('routes categorized payment and transcript logs to specific channels before the fallback log channel', () => {
  const previous = {
    LOGS_CHANNEL_ID: process.env.LOGS_CHANNEL_ID,
    DONUT_PAYMENT_LOGS_CHANNEL_ID: process.env.DONUT_PAYMENT_LOGS_CHANNEL_ID,
    LTC_PAYMENT_LOGS_CHANNEL_ID: process.env.LTC_PAYMENT_LOGS_CHANNEL_ID,
    TICKET_TRANSCRIPTS_CHANNEL_ID: process.env.TICKET_TRANSCRIPTS_CHANNEL_ID,
  };

  process.env.LOGS_CHANNEL_ID = 'logs';
  process.env.DONUT_PAYMENT_LOGS_CHANNEL_ID = 'donut';
  process.env.LTC_PAYMENT_LOGS_CHANNEL_ID = 'ltc';
  process.env.TICKET_TRANSCRIPTS_CHANNEL_ID = 'transcripts';

  try {
    assert.deepEqual(resolveLogChannelIds({ category: 'donut' }), ['donut', 'logs']);
    assert.deepEqual(resolveLogChannelIds({ category: 'ltc' }), ['ltc', 'logs']);
    assert.deepEqual(resolveLogChannelIds({ category: 'giveaway' }), ['transcripts', 'logs']);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
