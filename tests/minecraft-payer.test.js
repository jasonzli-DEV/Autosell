const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('minecraft payer logs the first five server messages after sending a payment command', async () => {
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
        for (let i = 1; i <= 6; i += 1) {
          payer.emit('serverMessage', {
            message: `server reply ${i}`,
            position: i % 2 === 0 ? 'game_info' : 'system',
          });
        }
      });
    },
  });

  await assert.rejects(
    payer.sendPaymentNow('Walksy_1', 50_000_000, () => null, 25),
    /No DonutSMP payment confirmation was received/,
  );

  const replyLogs = infoLogs.filter(args => /^Invite Reward Minecraft Reply \d\/5$/.test(args[0]));
  assert.equal(replyLogs.length, 5);
  assert.deepEqual(replyLogs.map(args => args[1]), [
    'server reply 1',
    'server reply 2',
    'server reply 3',
    'server reply 4',
    'server reply 5',
  ]);
  assert.deepEqual(replyLogs[0][2], [
    { name: 'Command', value: '`/pay Walksy_1 50000000`', inline: false },
    { name: 'Position', value: '`system`', inline: true },
  ]);
  assert.deepEqual(replyLogs[1][2], [
    { name: 'Command', value: '`/pay Walksy_1 50000000`', inline: false },
    { name: 'Position', value: '`game_info`', inline: true },
  ]);
  assert.deepEqual(replyLogs[0][3], { category: 'invite' });
});
