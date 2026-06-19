const mongoose = require('mongoose');

const botSettingsSchema = new mongoose.Schema({
  _id: { type: String, default: 'singleton' },
  pricePerMillionUsd: { type: Number, default: null },
  isKilled: { type: Boolean, default: false },
  panelChannelId: { type: String, default: null },
  panelMessageId: { type: String, default: null },
  ticketPanelChannelId: { type: String, default: null },
  ticketPanelMessageId: { type: String, default: null },
  ticketCategoryIds: { type: Object, default: {} },
  // Prices for the ticket panel sell flow (USD)
  moneyBuyPricePerMillion: { type: Number, default: 0.038 },   // we pay $X per 1m
  spawnerBuyPriceEach: { type: Number, default: 0.16 },         // we pay $X per skeleton spawner
  moneySellPricePerMillion: { type: Number, default: 0.05 },    // customer pays $X per 1m
  spawnerSellPriceEach: { type: Number, default: 0.2 },          // customer pays $X per skeleton spawner
  inviteRewardPayoutPerInvite: { type: Number, default: 10_000_000 },
  inviteRewardMinimumInvites: { type: Number, default: 5 },
  invitesEnabled: { type: Boolean, default: true },
  inviteRewardPanelChannelId: { type: String, default: null },
  inviteRewardPanelMessageId: { type: String, default: null },
  spawnerSellPanelChannelId: { type: String, default: null },
  spawnerSellPanelMessageId: { type: String, default: null },
});

const BotSettings = mongoose.model('BotSettings', botSettingsSchema);

async function getSettings() {
  let settings = await BotSettings.findById('singleton');
  if (!settings) {
    settings = await BotSettings.create({ _id: 'singleton' });
  }
  return settings;
}

async function updateSettings(fields) {
  return BotSettings.findByIdAndUpdate('singleton', { $set: fields }, { upsert: true, returnDocument: 'after' });
}

async function getPricePerMillionUsd() {
  const settings = await getSettings();
  if (settings.pricePerMillionUsd != null && settings.pricePerMillionUsd > 0) {
    return settings.pricePerMillionUsd;
  }
  const envPrice = parseFloat(process.env.PRICE_PER_MILLION_USD);
  if (Number.isFinite(envPrice) && envPrice > 0) return envPrice;
  if (settings.moneyBuyPricePerMillion != null && settings.moneyBuyPricePerMillion > 0) {
    return settings.moneyBuyPricePerMillion;
  }
  throw new Error('PRICE_PER_MILLION_USD is not configured.');
}

async function getBotKilled() {
  const settings = await getSettings();
  return settings.isKilled === true;
}

module.exports = { getSettings, updateSettings, getPricePerMillionUsd, getBotKilled };
