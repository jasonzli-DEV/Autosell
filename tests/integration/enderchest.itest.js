// Integration test, modelled on PrismarineJS/mineflayer's own server tests: it
// downloads a real vanilla server, boots it locally (offline mode, flat world),
// connects a bot (physics enabled, like the production payer), places an enderchest
// next to it, and verifies the bot can open it through the raycast face/cursor path
// in src/systems/spawnerSell.js.
//
// NOTE: a vanilla server does NOT run Grim/anticheat, so this cannot reproduce the
// DonutSMP-specific rejection. It proves our interaction stack (lookAt override,
// position packets, raycast face + cursor) actually opens a container on a real
// server — a necessary condition and a regression guard. Final verification of the
// anticheat behaviour has to happen on DonutSMP itself.
//
// Run with:  npm run test:integration
// Heavy: needs Java + downloads a ~50MB server jar. Skipped if SKIP_INTEGRATION=1.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { once } = require('node:events');

const mineflayer = require('mineflayer');
const { WrapServer, download } = require('minecraft-wrap');

const { depositIntoEnderchest } = require('../../src/systems/spawnerSell');

const VERSION = process.env.MC_TEST_VERSION || '1.21.4';
const PORT = Number(process.env.MC_TEST_PORT || 25569);
const WORK_DIR = path.join(os.tmpdir(), `autosell-mc-${VERSION}`);
const JAR_PATH = path.join(WORK_DIR, 'server.jar');
const SERVER_DIR = path.join(WORK_DIR, 'server');

function promisify(fn) {
  return (...args) => new Promise((resolve, reject) => {
    fn(...args, (err, ...rest) => (err ? reject(err) : resolve(...rest)));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('bot opens an enderchest via the raycast path on a real server', { timeout: 600_000 }, async (t) => {
  if (process.env.SKIP_INTEGRATION === '1') return t.skip('SKIP_INTEGRATION=1');

  fs.mkdirSync(WORK_DIR, { recursive: true });

  try {
    await promisify(download)(VERSION, JAR_PATH);
  } catch (err) {
    return t.skip(`could not download server jar (${err.message})`);
  }

  const server = new WrapServer(JAR_PATH, SERVER_DIR, { maxMem: 1024 });
  let bot;
  try {
    await new Promise((resolve, reject) => {
      const onErr = (e) => reject(e instanceof Error ? e : new Error(String(e)));
      server.on('error', onErr);
      server.startServer({
        'online-mode': 'false',
        'server-port': PORT,
        gamemode: 'creative',
        difficulty: 'peaceful',
        'spawn-monsters': 'false',
        'spawn-protection': '0',
        'level-type': 'minecraft:flat',
        'generate-structures': 'false',
        'view-distance': '6',
      }, (err) => (err ? reject(err) : resolve()));
    });

    bot = mineflayer.createBot({
      host: '127.0.0.1',
      port: PORT,
      username: 'EnderTestBot',
      auth: 'offline',
      version: VERSION,
      // Physics enabled, mirroring production.
    });

    const serverLines = [];
    server.on('line', (line) => { serverLines.push(line); });

    await once(bot, 'spawn');
    // Let chunks + entity position settle.
    await sleep(3000);
    assert.ok(bot.entity?.position, 'bot should have a position after spawn');
    console.log('[itest] spawn pos', bot.entity.position, 'gamemode', bot.game?.gameMode, 'dim', bot.game?.dimension);

    // Place an enderchest one block to the +x side of the bot, at feet level.
    const base = bot.entity.position.floored();
    const ecPos = base.offset(1, 0, 0);
    console.log('[itest] feet block', bot.blockAt(base)?.name, '| below', bot.blockAt(base.offset(0, -1, 0))?.name, '| ecPos target', bot.blockAt(ecPos)?.name);
    // writeServer does not append a newline, so the command is never submitted without one.
    server.writeServer(`setblock ${ecPos.x} ${ecPos.y} ${ecPos.z} minecraft:ender_chest\n`);

    // Wait for the client to receive the block.
    let ecBlock = null;
    for (let i = 0; i < 30; i++) {
      const b = bot.blockAt(ecPos);
      if (b && b.name === 'ender_chest') { ecBlock = b; break; }
      await sleep(500);
    }
    if (!ecBlock) {
      console.log('[itest] blockAt(ecPos) =', bot.blockAt(ecPos)?.name);
      console.log('[itest] recent server lines:\n' + serverLines.filter(l => /setblock|ender|Changed|error|Error|Unknown/i.test(l)).slice(-8).join('\n'));
    }
    assert.ok(ecBlock, `enderchest should be visible to the bot at ${ecPos}`);

    // Exercise the real production deposit path. With nothing to deposit it just has
    // to successfully OPEN the chest (and find zero spawners), returning success.
    const result = await depositIntoEnderchest(bot, ecBlock);
    assert.deepEqual(result, { success: true, remaining: 0 });
  } finally {
    try { bot?.quit(); } catch {}
    await new Promise((resolve) => server.stopServer(() => resolve()));
    await new Promise((resolve) => server.deleteServerData(() => resolve()));
  }
});
