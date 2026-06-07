const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  calculateInviteRewardStats,
  formatDonutAmount,
  getInviteRewardConfig,
  buildPayCommand,
  parsePaymentChatMessage,
} = require('../src/systems/inviteRewards');

test('invite reward defaults are 10m per invite with 5 payable invites required', () => {
  const config = getInviteRewardConfig({});

  assert.equal(config.payoutPerInvite, 10_000_000);
  assert.equal(config.minimumInvites, 5);
});

test('invite reward config accepts positive database overrides', () => {
  const config = getInviteRewardConfig({
    inviteRewardPayoutPerInvite: 25_000_000,
    inviteRewardMinimumInvites: 7,
  });

  assert.equal(config.payoutPerInvite, 25_000_000);
  assert.equal(config.minimumInvites, 7);
});

test('invite reward stats exclude left, fake, rejoin, and already claimed invites', () => {
  const stats = calculateInviteRewardStats({
    invites: [
      { memberId: '1', fake: false, rejoin: false, leftAt: null },
      { memberId: '2', fake: false, rejoin: false, leftAt: null },
      { memberId: '3', fake: true, rejoin: false, leftAt: null },
      { memberId: '4', fake: false, rejoin: true, leftAt: null },
      { memberId: '5', fake: false, rejoin: false, leftAt: new Date() },
      { memberId: '6', fake: false, rejoin: false, leftAt: null },
    ],
    claimedMemberIds: ['2'],
  });

  assert.deepEqual(stats, {
    total: 6,
    left: 1,
    fake: 1,
    rejoin: 1,
    payable: 3,
    claimed: 1,
    claimable: 2,
    claimableMemberIds: ['1', '6'],
  });
});

test('formats donut reward amounts like the panel copy', () => {
  assert.equal(formatDonutAmount(10_000_000), '10m');
  assert.equal(formatDonutAmount(1_500_000_000), '1.5b');
});

test('builds a DonutSMP pay command and detects insufficient balance chat', () => {
  assert.equal(buildPayCommand('JohnDoe', 50_000_000), '/pay JohnDoe 50000000');

  assert.deepEqual(parsePaymentChatMessage('You do not have enough money to do that.'), {
    type: 'insufficient_balance',
  });
  assert.deepEqual(parsePaymentChatMessage('Paid $50,000,000 to JohnDoe.'), {
    type: 'paid',
  });
  assert.equal(parsePaymentChatMessage('Welcome to DonutSMP'), null);
});

test('invite reward command and interaction handlers are registered', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  const panelSource = fs.readFileSync(path.join(__dirname, '../src/commands/panel.js'), 'utf8');
  const buttonSource = fs.readFileSync(path.join(__dirname, '../src/interactions/button.js'), 'utf8');
  const modalSource = fs.readFileSync(path.join(__dirname, '../src/interactions/modal.js'), 'utf8');
  const settingsSource = fs.readFileSync(path.join(__dirname, '../src/commands/set.js'), 'utf8');
  const rewardsSource = fs.readFileSync(path.join(__dirname, '../src/systems/inviteRewards.js'), 'utf8');
  const exampleEnv = fs.readFileSync(path.join(__dirname, '../example.env'), 'utf8');

  assert.match(indexSource, /initializeInviteRewardTracking/);
  assert.match(indexSource, /startMinecraftPayer/);
  assert.match(indexSource, /GatewayIntentBits\.GuildInvites/);
  assert.match(indexSource, /GatewayIntentBits\.GuildMembers/);
  assert.match(panelSource, /\.setName\('invite-rewards'\)/);
  assert.match(buttonSource, /inviteRewardCheckCustomId/);
  assert.match(buttonSource, /inviteRewardClaimCustomId/);
  assert.match(modalSource, /inviteRewardClaimModalCustomId/);
  assert.match(settingsSource, /\.setName\('invite-rewards'\)/);
  assert.match(rewardsSource, /category: 'invite'/);
  assert.doesNotMatch(exampleEnv, /MINECRAFT_|INVITE_REWARDS_DISABLED|INVITE_REWARD_LOGS_CHANNEL_ID/);
});

test('minecraft payer uses one fixed token-cache profile without prompting for email', () => {
  const { buildMinecraftBotOptions, getMinecraftAuthProfile, formatPacketTraceForLog } = require('../src/lib/minecraftPayer');

  assert.equal(getMinecraftAuthProfile(), 'invite-reward-payer');

  assert.deepEqual(buildMinecraftBotOptions({
    config: {
      host: 'donutsmp.net',
      port: 25565,
      auth: 'microsoft',
      profilesFolder: '.minecraft-auth',
    },
    mineflayer: { latestSupportedVersion: '1.21.11' },
  }), {
    host: 'donutsmp.net',
    port: 25565,
    username: 'invite-reward-payer',
    auth: 'microsoft',
    profilesFolder: '.minecraft-auth',
    version: '1.21.11',
    hideErrors: true,
    plugins: { physics: false },
  });

  const trace = formatPacketTraceForLog([
    { direction: 'in', state: 'configuration', name: 'finish_configuration', size: 3, hex: '030102' },
    { direction: 'out', state: 'configuration', name: 'finish_configuration', size: 0 },
    { direction: 'in', state: 'play', name: 'kick_disconnect', size: 29, summary: '{"type":"string","value":"Invalid sequence"}' },
  ]);

  assert.match(trace, /clientbound configuration\.finish_configuration/);
  assert.match(trace, /serverbound configuration\.finish_configuration/);
  assert.match(trace, /kick_disconnect/);
});
