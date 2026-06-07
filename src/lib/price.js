const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd';

async function getLtcUsdPrice() {
  const res = await fetch(COINGECKO_URL);
  if (!res.ok) throw new Error(`CoinGecko error: ${res.status}`);
  const data = await res.json();
  const price = data?.litecoin?.usd;
  if (typeof price !== 'number' || price <= 0) throw new Error('Invalid price data from CoinGecko.');
  return price;
}

async function calculateLtcAmount(donutAmount) {
  const { getPricePerMillionUsd } = require('./botSettings');
  const pricePerMillionUsd = await getPricePerMillionUsd();

  const ltcUsd = await getLtcUsdPrice();
  const millions = donutAmount / 1_000_000;
  const usdValue = millions * pricePerMillionUsd;
  const ltcAmount = usdValue / ltcUsd;

  // Round to 8 decimal places (satoshi precision)
  return {
    ltcAmount: Math.floor(ltcAmount * 1e8) / 1e8,
    ltcUsd,
    usdValue,
  };
}

module.exports = { getLtcUsdPrice, calculateLtcAmount };
