const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('minecraft payer logs the first server message after sending a payment command', async () => {
  const loggerPath = path.join(__dirname, '../src/lib/logger.js');
  const payerPath = path.join(__dirname, '../src/lib/minecraftPayer.js');
  delete require.cache[require.resolve(loggerPath)];
  delete require.cache[require.resolve(payerPath)];

  const infoLogs = [];
  require.cache[require.resolve(loggerPath)] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: {
      logInfo: (...args) => {
        infoLogs.push(args);
        return Promise.resolve();
      },
      logSuccess: () => Promise.resolve(),
      logError: () => Promise.resolve(),
    },
  };

  const { DonutMinecraftPayer } = require(payerPath);
  const payer = new DonutMinecraftPayer();
  payer.ensureConnected = async () => ({
    chat: () => {
      setImmediate(() => {
        payer.emit('serverMessage', {
          message: 'You cannot pay while in the lobby.',
          position: 'system',
        });
      });
    },
  });

  await assert.rejects(
    payer.sendPaymentNow('Walksy_1', 50_000_000, () => null, 25),
    /No DonutSMP payment confirmation was received/,
  );

  const replyLog = infoLogs.find(args => args[0] === 'Invite Reward Minecraft Reply');
  assert.ok(replyLog, 'expected the first Minecraft reply to be logged');
  assert.match(replyLog[1], /You cannot pay while in the lobby/);
  assert.deepEqual(replyLog[2], [
    { name: 'Command', value: '`/pay Walksy_1 50000000`', inline: false },
    { name: 'Position', value: '`system`', inline: true },
  ]);
  assert.deepEqual(replyLog[3], { category: 'invite' });
});
