function roundUsd(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function formatUsd(value) {
  const rounded = roundUsd(value);
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}

const SPAWNERS_PER_SHULKER = 27 * 64;

function getSpawnerShulkerPrice(spawnerBuyPriceEach) {
  return roundUsd(Number(spawnerBuyPriceEach || 0) * SPAWNERS_PER_SHULKER);
}

function calculateTradeEstimate({
  moneyAmount,
  skeletonSpawners,
  skeletonShulkers,
  moneyPricePerMillion,
  spawnerPriceEach,
}) {
  const moneyUsd = roundUsd((Number(moneyAmount || 0) / 1_000_000) * Number(moneyPricePerMillion || 0));
  const eachPrice = Number(spawnerPriceEach || 0);
  const shulkerPrice = getSpawnerShulkerPrice(eachPrice);
  const spawnerUsd = roundUsd(
    (Number(skeletonSpawners || 0) * eachPrice) +
    (Number(skeletonShulkers || 0) * shulkerPrice),
  );
  return {
    moneyUsd,
    spawnerUsd,
    totalUsd: roundUsd(moneyUsd + spawnerUsd),
  };
}

function calculateSellEstimate({
  moneyAmount,
  skeletonSpawners,
  skeletonShulkers,
  moneyBuyPricePerMillion,
  spawnerBuyPriceEach,
}) {
  return calculateTradeEstimate({
    moneyAmount,
    skeletonSpawners,
    skeletonShulkers,
    moneyPricePerMillion: moneyBuyPricePerMillion,
    spawnerPriceEach: spawnerBuyPriceEach,
  });
}

function getMoneyBuyPrice(settings = {}) {
  const autosellPrice = Number(settings.pricePerMillionUsd);
  if (Number.isFinite(autosellPrice) && autosellPrice > 0) return autosellPrice;

  const ticketPrice = Number(settings.moneyBuyPricePerMillion);
  if (Number.isFinite(ticketPrice) && ticketPrice > 0) return ticketPrice;

  const envPrice = parseFloat(process.env.PRICE_PER_MILLION_USD);
  if (Number.isFinite(envPrice) && envPrice > 0) return envPrice;

  return 0;
}

function formatTicketPanelPrices(settings = {}) {
  const moneyPerBillion = getMoneyBuyPrice(settings) * 1000;
  const spawnerEach = Number(settings.spawnerBuyPriceEach || 0);
  const spawnerShulker = getSpawnerShulkerPrice(spawnerEach);
  const moneySellPerBillion = Number(settings.moneySellPricePerMillion || 0) * 1000;
  const spawnerSellEach = Number(settings.spawnerSellPriceEach || 0);
  const spawnerSellShulker = getSpawnerShulkerPrice(spawnerSellEach);

  return {
    moneyPerBillion: `${formatUsd(moneyPerBillion)} USD per 1b`,
    spawnerEach: spawnerEach > 0 ? `${formatUsd(spawnerEach)} USD each` : 'Ask in ticket',
    spawnerShulker: spawnerShulker > 0 ? `${formatUsd(spawnerShulker)} USD a shulker` : 'Ask in ticket',
    moneySellPerBillion: moneySellPerBillion > 0 ? `${formatUsd(moneySellPerBillion)} USD per 1b` : 'Ask in ticket',
    spawnerSellEach: spawnerSellEach > 0 ? `${formatUsd(spawnerSellEach)} USD each` : 'Ask in ticket',
    spawnerSellShulker: spawnerSellShulker > 0 ? `${formatUsd(spawnerSellShulker)} USD a shulker` : 'Ask in ticket',
  };
}

module.exports = {
  SPAWNERS_PER_SHULKER,
  calculateSellEstimate,
  calculateTradeEstimate,
  formatTicketPanelPrices,
  formatUsd,
  getMoneyBuyPrice,
  getSpawnerShulkerPrice,
  roundUsd,
};
