const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('ticket panel opens buy/sell DonutSMP money, buy/sell skeleton spawners, or general support tickets', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/systems/tickets.js'), 'utf8');
  const panelOptions = source.slice(source.indexOf('const PANEL_TICKET_OPTIONS'), source.indexOf('const SPAWNER_UNITS'));
  const panelBuilder = source.slice(source.indexOf('function buildPanelButtonRow'), source.indexOf('function buildPanelSelectRow'));

  assert.match(panelBuilder, /ButtonBuilder/);
  assert.match(panelBuilder, /panelCategoryCustomId/);
  assert.match(panelOptions, /Sell Money/);
  assert.match(panelOptions, /Sell Spawners/);
  assert.match(panelOptions, /Buy Money/);
  assert.match(panelOptions, /Buy Spawners/);
  assert.match(panelOptions, /Support/);
  assert.doesNotMatch(panelBuilder, /StringSelectMenuBuilder/);
});

test('sell ticket flows have payment-method and spawner-unit selects without manual giveaway claims', () => {
  const ticketSource = fs.readFileSync(path.join(__dirname, '../src/systems/tickets.js'), 'utf8');
  const configSource = fs.readFileSync(path.join(__dirname, '../src/lib/autosellConfig.js'), 'utf8');

  assert.match(configSource, /flowPaymentMethodCustomId/);
  assert.match(configSource, /flowSpawnerUnitCustomId/);
  assert.match(ticketSource, /Skeleton Spawner/);
  assert.match(ticketSource, /Shulkers of Skeleton Spawners/);
  assert.match(ticketSource, /Crypto/);
  assert.match(ticketSource, /PayPal/);
  assert.match(ticketSource, /Bank Transfer/);
  assert.match(ticketSource, /Gift Cards/);
  assert.doesNotMatch(ticketSource, /Giveaway Claims/);
});

test('sell flows only ask price acceptance after showing calculated estimate', () => {
  const ticketSource = fs.readFileSync(path.join(__dirname, '../src/systems/tickets.js'), 'utf8');

  assert.doesNotMatch(ticketSource, /price_agreement/);
  assert.doesNotMatch(ticketSource, /shown price/i);
  assert.doesNotMatch(ticketSource, /Need to negotiate/i);
  assert.doesNotMatch(ticketSource, /Agreed With Price/);
  assert.match(ticketSource, /Accept Price & Continue/);
  assert.match(ticketSource, /Estimated Value/);
});

test('buy ticket flows reverse the sell wording and use the same estimate-confirm-terms pipeline', () => {
  const ticketSource = fs.readFileSync(path.join(__dirname, '../src/systems/tickets.js'), 'utf8');
  const configSource = fs.readFileSync(path.join(__dirname, '../src/lib/autosellConfig.js'), 'utf8');

  assert.match(configSource, /BUY_MONEY:\s*'buy_money'/);
  assert.match(configSource, /BUY_SPAWNERS:\s*'buy_spawners'/);
  assert.match(ticketSource, /Buy DonutSMP Money Ticket/);
  assert.match(ticketSource, /Buy Skeleton Spawners Ticket/);
  assert.match(ticketSource, /Select how you are paying/);
  assert.match(ticketSource, /\*\*Step 2\/4:\*\* Select how you are paying\./);
  assert.match(ticketSource, /Accept this calculated price to continue to terms/);
  assert.match(ticketSource, /moneySellPricePerMillion/);
  assert.match(ticketSource, /spawnerSellPriceEach/);
});

test('DonutSMP money tickets do not ask about skeleton spawners', () => {
  const ticketSource = fs.readFileSync(path.join(__dirname, '../src/systems/tickets.js'), 'utf8');
  const moneyPanelBranch = ticketSource.slice(
    ticketSource.indexOf('if (selected === TICKET_TYPES.SELL_MONEY)'),
    ticketSource.indexOf('if (selected === TICKET_TYPES.SELL_SPAWNERS)'),
  );
  const moneyModalHandler = ticketSource.slice(
    ticketSource.indexOf('if (customId === flowSellMoneyModal)'),
    ticketSource.indexOf('if (customId === flowSellSpawnersModal)'),
  );
  const moneyOpeningBranch = ticketSource.slice(
    ticketSource.indexOf('if (ticketType === TICKET_TYPES.SELL_MONEY)'),
    ticketSource.indexOf('} else if (ticketType === TICKET_TYPES.SELL_SPAWNERS)'),
  );
  const moneyConfirmBranch = ticketSource.slice(
    ticketSource.indexOf('if (type === TICKET_TYPES.SELL_MONEY)'),
    ticketSource.indexOf('} else if (type === TICKET_TYPES.SELL_SPAWNERS)'),
  );

  assert.match(moneyPanelBranch, /DonutSMP money amount/);
  assert.doesNotMatch(moneyPanelBranch, /skeleton_spawners|skeleton_shulkers|Skeleton spawners|Shulkers of skeleton spawners/i);
  assert.doesNotMatch(moneyModalHandler, /skeletonSpawners|skeletonShulkers|skeleton_spawners|skeleton_shulkers/);
  assert.doesNotMatch(moneyOpeningBranch, /Skeleton Spawners|Skeleton Shulkers/);
  assert.doesNotMatch(moneyConfirmBranch, /Skeleton Spawners|Skeleton Shulkers/);
});

test('ticket claim flow follows Aura ownership rules', () => {
  const ticketSource = fs.readFileSync(path.join(__dirname, '../src/systems/tickets.js'), 'utf8');
  const claimBranch = ticketSource.slice(
    ticketSource.indexOf('if (action === btnClaimPrefix)'),
    ticketSource.indexOf('if (action === btnClosePrefix)'),
  );

  assert.match(ticketSource, /function buildTicketButtons\(ticketId,\s*claimedBy/);
  assert.match(ticketSource, /claimedBy \? 'Unclaim' : 'Claim'/);
  assert.match(claimBranch, /ticket\.claimedBy && ticket\.claimedBy !== interaction\.user\.id/);
  assert.match(claimBranch, /already claimed by another team member/);
  assert.match(claimBranch, /Ticket\.findOneAndUpdate\(\s*\{ _id: ticket\._id, claimedBy: null \}/);
  assert.match(claimBranch, /Ticket\.findOneAndUpdate\(\s*\{ _id: ticket\._id, claimedBy: interaction\.user\.id \}/);
  assert.match(ticketSource, /permissionOverwrites\s*\.\s*delete\(previousClaimedBy\)/);
});
