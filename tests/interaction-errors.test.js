const test = require('node:test');
const assert = require('node:assert/strict');

const { isStaleInteractionError } = require('../src/lib/interactionErrors');

test('treats expired Discord interactions as stale response errors', () => {
  assert.equal(isStaleInteractionError({ code: 10062 }), true);
  assert.equal(isStaleInteractionError({ rawError: { code: 10062 } }), true);
});

test('treats already acknowledged Discord interactions as stale response errors', () => {
  assert.equal(isStaleInteractionError({ code: 40060 }), true);
  assert.equal(isStaleInteractionError({ rawError: { code: 40060 } }), true);
});

test('does not hide unrelated interaction errors', () => {
  assert.equal(isStaleInteractionError(new Error('boom')), false);
  assert.equal(isStaleInteractionError({ code: 50013 }), false);
});
