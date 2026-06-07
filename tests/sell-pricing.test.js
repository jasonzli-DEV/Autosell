const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateSellEstimate,
  calculateTradeEstimate,
  formatTicketPanelPrices,
  getSpawnerShulkerPrice,
} = require('../src/lib/sellPricing');

test('calculates money per billion from the existing per-million price', () => {
  assert.deepEqual(formatTicketPanelPrices({
    moneyBuyPricePerMillion: 0.038,
    spawnerBuyPriceEach: 0.16,
  }), {
    moneyPerBillion: '$38 USD per 1b',
    spawnerEach: '$0.16 USD each',
    spawnerShulker: '$276.48 USD a shulker',
    moneySellPerBillion: 'Ask in ticket',
    spawnerSellEach: 'Ask in ticket',
    spawnerSellShulker: 'Ask in ticket',
  });
});

test('ticket panel money price falls back to the autosell per-million price', () => {
  assert.deepEqual(formatTicketPanelPrices({
    pricePerMillionUsd: 0.038,
    moneyBuyPricePerMillion: 0.01,
    spawnerBuyPriceEach: 0.16,
  }), {
    moneyPerBillion: '$38 USD per 1b',
    spawnerEach: '$0.16 USD each',
    spawnerShulker: '$276.48 USD a shulker',
    moneySellPerBillion: 'Ask in ticket',
    spawnerSellEach: 'Ask in ticket',
    spawnerSellShulker: 'Ask in ticket',
  });
});

test('calculates skeleton shulker price from per-spawner price', () => {
  assert.equal(getSpawnerShulkerPrice(0.16), 276.48);
  assert.equal(getSpawnerShulkerPrice(1), 1728);
});

test('combines DonutSMP money, single skeleton spawners, and shulkers into one sell estimate', () => {
  const result = calculateSellEstimate({
    moneyAmount: 10_000_000_000,
    skeletonSpawners: 10,
    skeletonShulkers: 2,
    moneyBuyPricePerMillion: 0.038,
    spawnerBuyPriceEach: 0.16,
  });

  assert.equal(result.moneyUsd, 380);
  assert.equal(result.spawnerUsd, 554.56);
  assert.equal(result.totalUsd, 934.56);
});

test('calculates standalone skeleton spawner ticket estimates from set prices', () => {
  assert.equal(calculateSellEstimate({
    skeletonSpawners: 25,
    moneyBuyPricePerMillion: 0.038,
    spawnerBuyPriceEach: 0.16,
  }).totalUsd, 4);

  assert.equal(calculateSellEstimate({
    skeletonShulkers: 3,
    moneyBuyPricePerMillion: 0.038,
    spawnerBuyPriceEach: 0.16,
  }).totalUsd, 829.44);
});

test('calculates buy ticket estimates from configured sell prices', () => {
  assert.equal(calculateTradeEstimate({
    moneyAmount: 2_000_000_000,
    skeletonSpawners: 5,
    skeletonShulkers: 1,
    moneyPricePerMillion: 0.05,
    spawnerPriceEach: 0.2,
  }).totalUsd, 446.6);
});
