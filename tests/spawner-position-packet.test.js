const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildPositionLookPacket } = require(path.join(__dirname, '../src/lib/minecraftPayer.js'));

// With physics disabled the bot never sends a serverbound position packet, so
// DonutSMP drops block interactions (enderchest never opens). buildPositionLookPacket
// produces the packet we send to establish our position + rotation on the server.

test('buildPositionLookPacket reports the bot position and on-ground state', () => {
  const entity = { position: { x: 10, y: 64, z: -20 }, eyeHeight: 1.62, yaw: 0, pitch: 0 };
  const packet = buildPositionLookPacket(entity, null);

  assert.equal(packet.x, 10);
  assert.equal(packet.y, 64);
  assert.equal(packet.z, -20);
  assert.equal(packet.onGround, true);
  assert.deepEqual(packet.flags, { onGround: true, hasHorizontalCollision: false });
});

test('buildPositionLookPacket aims the rotation at the look target (north / -z)', () => {
  const entity = { position: { x: 0, y: 64, z: 0 }, eyeHeight: 1.62, yaw: 0, pitch: 0 };
  // Looking at a block one tile to the north (-z) and slightly below eye level.
  const packet = buildPositionLookPacket(entity, { x: 0, y: 64, z: -1 });

  // Notchian yaw: 0=south(+z), 180=north(-z).
  assert.ok(Math.abs(packet.yaw - 180) < 0.01, `yaw ${packet.yaw} should be ~180`);
  // Chest sits below eye level, so we look downward (positive notch pitch).
  assert.ok(packet.pitch > 0, `pitch ${packet.pitch} should be positive (looking down)`);
});

test('buildPositionLookPacket falls back to the entity rotation without a look target', () => {
  const entity = { position: { x: 1, y: 2, z: 3 }, eyeHeight: 1.62, yaw: Math.PI, pitch: 0 };
  const packet = buildPositionLookPacket(entity, null);
  // yaw = PI -> notch (PI - PI) * 180/PI = 0 (facing south)
  assert.ok(Math.abs(packet.yaw - 0) < 0.01, `yaw ${packet.yaw} should be ~0`);
});
