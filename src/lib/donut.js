const STATS_BASE_URL = 'https://api.donutsmp.net/v1/stats';
const TIMEOUT_MS = 10_000;
const RETRY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_200;
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504, 520, 522, 523, 524]);

class DonutError extends Error {
  constructor(message, { transient = false, userNotFound = false } = {}) {
    super(message);
    this.name = 'DonutError';
    this.transient = transient;
    this.userNotFound = userNotFound;
  }
}

function parseDonutMoney(raw) {
  const str = `${raw ?? ''}`.trim().replace(/,/g, '');
  const num = parseFloat(str);
  return Number.isFinite(num) && num >= 0 ? Math.round(num) : null;
}

async function fetchDonutStats(ign) {
  if (!process.env.DONUTSMP_API_KEY) throw new DonutError('DONUTSMP_API_KEY is not set.');

  const username = `${ign || ''}`.trim();
  if (!username) throw new DonutError('Username is required.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${STATS_BASE_URL}/${encodeURIComponent(username)}`, {
      headers: { Authorization: process.env.DONUTSMP_API_KEY },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') {
      throw new DonutError(`Request timed out for ${username}.`, { transient: true });
    }
    throw new DonutError(`Network error for ${username}.`, { transient: true });
  }
  clearTimeout(timer);

  const text = await response.text().catch(() => '');
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { }

  if (!response.ok) {
    const msg = `${payload?.reason || ''} ${payload?.message || ''}`.toLowerCase();
    if (msg.includes('does not exist') || msg.includes('specified user/page/item')) {
      throw new DonutError(`User not found: ${username}`, { userNotFound: true });
    }
    const transient = TRANSIENT_STATUS.has(response.status);
    throw new DonutError(`DonutSMP error (${response.status}) for ${username}.`, { transient });
  }

  if (!payload?.result) {
    throw new DonutError(`No stats returned for ${username}.`, { transient: true });
  }

  const money = parseDonutMoney(payload.result.money);
  if (money === null) throw new DonutError(`Invalid money value for ${username}.`);

  return { username, money };
}

async function fetchDonutStatsWithRetry(ign, attempts = RETRY_ATTEMPTS) {
  let lastError;
  for (let i = 0; i <= attempts; i++) {
    try {
      return await fetchDonutStats(ign);
    } catch (err) {
      lastError = err;
      if (!(err instanceof DonutError) || !err.transient || i >= attempts) throw err;
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (i + 1)));
    }
  }
  throw lastError;
}

async function validateIgn(ign) {
  const username = `${ign || ''}`.trim();
  if (!username) return { valid: false, reason: 'IGN is required.' };

  try {
    await fetchDonutStatsWithRetry(username, 1);
    return { valid: true, normalized: username };
  } catch (err) {
    if (err instanceof DonutError && err.userNotFound) {
      return { valid: false, reason: 'This username was not found on DonutSMP.' };
    }
    throw err;
  }
}

module.exports = { fetchDonutStatsWithRetry, validateIgn, DonutError };
