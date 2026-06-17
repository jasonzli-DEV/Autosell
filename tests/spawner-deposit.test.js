const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { depositIntoEnderchest } = require(path.join(__dirname, '../src/systems/spawnerSell.js'));

function makeEcBlock() {
  return { name: 'ender_chest', position: { offset: () => ({ x: 0, y: 0, z: 0 }) } };
}

function makeBot(overrides = {}) {
  const order = [];
  const bot = {
    order,
    heldItem: { name: 'spawner' },
    entity: { position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 },
    sendServerPosition: () => order.push('sendServerPosition'),
    _client: { on: () => {}, removeListener: () => {} },
    unequip: async (dest) => { order.push(`unequip:${dest}`); bot.heldItem = null; },
    openBlock: async () => { order.push('openBlock'); return { inventoryStart: 0, slots: [], close: () => {} }; },
    clickWindow: async () => {},
    ...overrides,
  };
  return bot;
}

test('depositIntoEnderchest empties the hand before opening the chest', async () => {
  const bot = makeBot();
  await depositIntoEnderchest(bot, makeEcBlock());

  const unequipIdx = bot.order.indexOf('unequip:hand');
  const openIdx = bot.order.indexOf('openBlock');
  assert.ok(unequipIdx !== -1, 'should empty the hand');
  assert.ok(openIdx !== -1, 'should open the chest');
  assert.ok(unequipIdx < openIdx, 'must empty the hand before opening the chest');
});

test('depositIntoEnderchest does not try to empty an already-empty hand', async () => {
  const bot = makeBot({ heldItem: null });
  await depositIntoEnderchest(bot, makeEcBlock());

  assert.ok(!bot.order.some(c => c.startsWith('unequip')), 'should not unequip when hand is empty');
  assert.ok(bot.order.includes('openBlock'), 'should still open the chest');
});
