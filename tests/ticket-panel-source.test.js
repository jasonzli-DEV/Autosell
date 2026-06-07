const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('ticket panel is posted from /ticket panel instead of a sellme command', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  const ticketSource = fs.readFileSync(path.join(__dirname, '../src/commands/ticket.js'), 'utf8');

  assert.doesNotMatch(indexSource, /sellmeCommand/);
  assert.doesNotMatch(indexSource, /sellme:/);
  assert.match(ticketSource, /\.setName\('panel'\)/);
  assert.match(ticketSource, /handleTicketPanel/);
});

test('ticket panel uses ticket-panel naming and tracking', () => {
  const ticketsSource = fs.readFileSync(path.join(__dirname, '../src/systems/tickets.js'), 'utf8');
  const settingsSource = fs.readFileSync(path.join(__dirname, '../src/lib/botSettings.js'), 'utf8');

  assert.match(ticketsSource, /function buildTicketPanel/);
  assert.doesNotMatch(ticketsSource, /buildSellMePanel/);
  assert.match(settingsSource, /ticketPanelChannelId/);
  assert.match(settingsSource, /ticketPanelMessageId/);
});

test('/set price opens one admin-only ephemeral price panel', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  const panelSource = fs.readFileSync(path.join(__dirname, '../src/commands/panel.js'), 'utf8');
  const setSource = fs.readFileSync(path.join(__dirname, '../src/commands/set.js'), 'utf8');
  const priceSettingsSource = fs.readFileSync(path.join(__dirname, '../src/systems/priceSettings.js'), 'utf8');
  const settingsSource = fs.readFileSync(path.join(__dirname, '../src/lib/botSettings.js'), 'utf8');

  assert.doesNotMatch(panelSource, /\.setName\('config'\)/);
  assert.match(setSource, /\.setName\('set'\)/);
  assert.match(setSource, /\.setName\('price'\)/);
  assert.match(setSource, /handleSetPricePanel/);
  assert.match(priceSettingsSource, /MessageFlags\.Ephemeral/);
  assert.match(priceSettingsSource, /getAdminIds\(\)\.includes\(interaction\.user\.id\)/);
  assert.match(indexSource, /setCommand\.data\.toJSON\(\)/);
  assert.match(indexSource, /set:\s*setCommand/);
  assert.doesNotMatch(indexSource, /setpriceCommand/);
  assert.match(settingsSource, /settings\.moneyBuyPricePerMillion/);
});

test('/set price central panel configures every ticket price from per-item prices', () => {
  const priceSettingsSource = fs.readFileSync(path.join(__dirname, '../src/systems/priceSettings.js'), 'utf8');
  const ticketsSource = fs.readFileSync(path.join(__dirname, '../src/systems/tickets.js'), 'utf8');
  const pricingSource = fs.readFileSync(path.join(__dirname, '../src/lib/sellPricing.js'), 'utf8');

  assert.match(priceSettingsSource, /moneyBuyPricePerMillion/);
  assert.match(priceSettingsSource, /moneySellPricePerMillion/);
  assert.match(priceSettingsSource, /spawnerBuyPriceEach/);
  assert.match(priceSettingsSource, /spawnerSellPriceEach/);
  assert.match(priceSettingsSource, /pricePerMillionUsd:\s*price/);
  assert.match(priceSettingsSource, /moneyBuyPricePerMillion:\s*price/);
  assert.match(priceSettingsSource, /refreshPanel/);
  assert.doesNotMatch(priceSettingsSource, /spawner_shulker/);
  assert.doesNotMatch(ticketsSource, /spawnerBuyPricePerShulker/);
  assert.doesNotMatch(pricingSource, /spawnerBuyPricePerShulker/);
  assert.match(pricingSource, /SPAWNERS_PER_SHULKER\s*=\s*27\s*\*\s*64/);
});
