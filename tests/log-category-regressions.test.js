const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function source(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

test('ticket lifecycle logs are tagged for the ticket logs channel', () => {
  assert.match(source('src/systems/tickets.js'), /Ticket Opened[\s\S]*category: 'ticket'/);
  assert.match(source('src/systems/tickets.js'), /Ticket Closed[\s\S]*category: 'ticket'/);
  assert.match(source('src/lib/ticketManager.js'), /Ticket Opened[\s\S]*category: 'ticket'/);
  assert.match(source('src/lib/ticketManager.js'), /Ticket Closed[\s\S]*category: 'ticket'/);
});

test('member join and leave invite-reward logs are tagged for the join logs channel', () => {
  assert.match(source('src/systems/inviteRewards.js'), /Invite Reward Tracking Failed[\s\S]*category: 'join'/);
  assert.match(source('src/systems/inviteRewards.js'), /Invite Reward Join Tracked[\s\S]*category: 'join'/);
  assert.match(source('src/systems/inviteRewards.js'), /Invite Reward Member Left[\s\S]*category: 'join'/);
  assert.match(source('src/systems/inviteRewards.js'), /Invite Reward Join Handler Failed[\s\S]*category: 'join'/);
  assert.match(source('src/systems/inviteRewards.js'), /Invite Reward Leave Handler Failed[\s\S]*category: 'join'/);
});
