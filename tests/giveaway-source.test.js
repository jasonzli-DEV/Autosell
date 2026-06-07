const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('/giveaway end uses the winner-selection lifecycle instead of hard-closing active giveaways', () => {
  const commandSource = fs.readFileSync(path.join(__dirname, '../src/commands/giveaway.js'), 'utf8');

  assert.match(commandSource, /endGiveawayEntries/);
  assert.doesNotMatch(commandSource, /closeGiveaway\(giveaway\.id,\s*['"]Ended early by staff['"]\)/);
});

test('giveaway claim tickets use Aura-style payment confirmation buttons', () => {
  const giveawaySource = fs.readFileSync(path.join(__dirname, '../src/systems/giveaway.js'), 'utf8');
  const ticketsSource = fs.readFileSync(path.join(__dirname, '../src/systems/tickets.js'), 'utf8');
  const configSource = fs.readFileSync(path.join(__dirname, '../src/lib/autosellConfig.js'), 'utf8');
  const buttonSource = fs.readFileSync(path.join(__dirname, '../src/interactions/button.js'), 'utf8');

  assert.match(configSource, /btnGiveawayHostPaidPrefix/);
  assert.match(configSource, /btnGiveawayClaimerConfirmPrefix/);
  assert.match(configSource, /GIVEAWAY_CLAIM_FLOW_STATE/);
  assert.match(giveawaySource, /giveawayClaimFlowState/);
  assert.match(giveawaySource, /I Payed/);
  assert.doesNotMatch(giveawaySource, /setCustomId\(`\$\{btnClaimPrefix\}:\$\{ticket\.id\}`\)/);
  assert.match(ticketsSource, /btnGiveawayHostPaidPrefix/);
  assert.match(ticketsSource, /btnGiveawayClaimerConfirmPrefix/);
  assert.match(ticketsSource, /Only the giveaway claimer can confirm payment/);
  assert.match(ticketsSource, /Giveaway payment confirmed by claimer/);
  assert.match(buttonSource, /btnGiveawayHostPaidPrefix/);
  assert.match(buttonSource, /btnGiveawayClaimerConfirmPrefix/);
});
