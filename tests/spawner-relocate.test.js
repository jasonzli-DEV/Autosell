const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Vec3 } = require('vec3');

const { relocateUntilMoved } = require(path.join(__dirname, '../src/systems/spawnerSell.js'));

// A bot whose position only changes once /rtp east has been issued `movesAfter` times,
// simulating /rtp cooldown failures before a successful teleport.
function makeBot(movesAfter) {
  const bot = {
    chats: [],
    entity: { position: new Vec3(0, 64, 0) },
    chat(msg) {
      bot.chats.push(msg);
      if (bot.chats.length >= movesAfter) bot.entity.position = new Vec3(500, 70, -500);
    },
  };
  return bot;
}

test('relocateUntilMoved retries /rtp east until the position changes', async () => {
  const bot = makeBot(3); // first two /rtp do nothing, third teleports
  const moved = await relocateUntilMoved(bot, { intervalMs: 1 });

  assert.equal(moved, true);
  assert.equal(bot.chats.length, 3, 'should retry until the bot actually moves');
  assert.ok(bot.chats.every(c => c === '/rtp east'));
});

test('relocateUntilMoved gives up after the safety cap if it never moves', async () => {
  const bot = makeBot(Infinity); // never moves
  const moved = await relocateUntilMoved(bot, { intervalMs: 1, maxAttempts: 5 });

  assert.equal(moved, false);
  assert.equal(bot.chats.length, 5, 'should stop at maxAttempts');
});
