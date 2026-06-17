const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Vec3 } = require('vec3');

const { depositIntoEnderchest, raycastBlockFace, FACE_VECTORS } =
  require(path.join(__dirname, '../src/systems/spawnerSell.js'));

function makeEcBlock() {
  return { name: 'ender_chest', position: new Vec3(0, 0, 0) };
}

// A bot whose world.raycast hits the chest's south face, like a bot standing on
// the +z side looking at it. raycastBlockFace should translate that into the
// south unit normal and the cursor position on that face.
function makeBot(raycastResult, overrides = {}) {
  const order = [];
  const bot = {
    order,
    openBlockArgs: null,
    entity: { position: new Vec3(0.5, 0, 2), eyeHeight: 1.62, yaw: 0, pitch: 0 },
    world: { raycast: () => raycastResult },
    sendServerPosition: () => order.push('sendServerPosition'),
    _client: { on: () => {}, removeListener: () => {} },
    openBlock: async (...args) => { order.push('openBlock'); bot.openBlockArgs = args; return { inventoryStart: 0, slots: [], close: () => {} }; },
    clickWindow: async () => {},
    ...overrides,
  };
  return bot;
}

test('raycastBlockFace maps the hit face to its unit normal and the cursor on that face', () => {
  const block = makeEcBlock();
  const hit = { position: new Vec3(0, 0, 0), face: 3 /* south */, intersect: new Vec3(0.5, 0.5, 1) };
  const bot = makeBot(hit);

  const aim = raycastBlockFace(bot, block);
  assert.ok(aim, 'should return an aim');
  assert.deepEqual(aim.faceVec, FACE_VECTORS[3]);
  assert.deepEqual(aim.faceVec, new Vec3(0, 0, 1));
  // cursor is the intersect relative to the block origin, on the +z face (z=1).
  assert.deepEqual(aim.cursor, new Vec3(0.5, 0.5, 1));
});

test('raycastBlockFace returns null when the ray misses the target block', () => {
  const block = makeEcBlock();
  // Ray hits a different block (a wall in front of the chest).
  const hit = { position: new Vec3(0, 0, 1), face: 3, intersect: new Vec3(0.5, 0.5, 2) };
  assert.equal(raycastBlockFace(makeBot(hit), block), null);
  // Ray hits nothing.
  assert.equal(raycastBlockFace(makeBot(null), block), null);
});

test('depositIntoEnderchest opens the chest with the raycast face and cursor', async () => {
  const block = makeEcBlock();
  const hit = { position: new Vec3(0, 0, 0), face: 3, intersect: new Vec3(0.5, 0.5, 1) };
  const bot = makeBot(hit);

  await depositIntoEnderchest(bot, block);

  assert.ok(bot.order.includes('openBlock'), 'should open the chest');
  const [openedBlock, faceVec, cursor] = bot.openBlockArgs;
  assert.equal(openedBlock, block);
  assert.deepEqual(faceVec, new Vec3(0, 0, 1), 'should pass the south face normal');
  assert.deepEqual(cursor, new Vec3(0.5, 0.5, 1), 'should pass the cursor on that face');
});

test('depositIntoEnderchest falls back to default openBlock when the raycast misses', async () => {
  const block = makeEcBlock();
  const bot = makeBot(null); // raycast miss

  await depositIntoEnderchest(bot, block);

  assert.ok(bot.order.includes('openBlock'), 'should still open the chest');
  assert.equal(bot.openBlockArgs.length, 1, 'should call openBlock with only the block (mineflayer default face)');
});
