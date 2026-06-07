function parseAmount(str) {
  const s = `${str || ''}`.trim().toLowerCase().replace(/,/g, '');
  if (!s) return null;

  let multiplier = 1;
  let numStr = s;

  if (s.endsWith('b')) {
    multiplier = 1_000_000_000;
    numStr = s.slice(0, -1);
  } else if (s.endsWith('m')) {
    multiplier = 1_000_000;
    numStr = s.slice(0, -1);
  } else if (s.endsWith('k')) {
    multiplier = 1_000;
    numStr = s.slice(0, -1);
  }

  const num = parseFloat(numStr);
  if (!Number.isFinite(num) || num <= 0) return null;

  const result = Math.round(num * multiplier);
  if (result < 1_000_000) return null;

  return result;
}

function formatMoney(amount) {
  if (amount >= 1_000_000_000) {
    const n = amount / 1_000_000_000;
    return `${parseFloat(n.toFixed(3))}b`;
  }
  if (amount >= 1_000_000) {
    const n = amount / 1_000_000;
    return `${parseFloat(n.toFixed(3))}m`;
  }
  return amount.toLocaleString();
}

module.exports = { parseAmount, formatMoney };
