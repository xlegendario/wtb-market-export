import 'dotenv/config';

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: num(process.env.PORT, 10000),

  airtable: {
    // De automation engine gebruikt AIRTABLE_TOKEN, de discord bots AIRTABLE_API_KEY.
    token: process.env.AIRTABLE_TOKEN || process.env.AIRTABLE_API_KEY || '',
    baseId: process.env.AIRTABLE_BASE_ID || '',
    table: process.env.AIRTABLE_ORDERS_TABLE || 'Unfulfilled Orders Log',
  },

  wtb: {
    baseUrl: (process.env.WTB_API_BASE_URL || 'https://api.wtbmarket.eu').replace(/\/+$/, ''),
    apiKey: process.env.WTB_API_KEY || '',
    // Postman "API Key" auth met key-naam `key` -> header `key: <value>`.
    apiKeyHeader: process.env.WTB_API_KEY_HEADER || 'key',
    // `user_id` header = jouw Discord ID.
    userId: process.env.WTB_USER_ID || '',
    requestDelayMs: num(process.env.WTB_REQUEST_DELAY_MS, 250),
    maxRetries: num(process.env.WTB_MAX_RETRIES, 3),
    timeoutMs: num(process.env.WTB_TIMEOUT_MS, 15000),
  },

  // Het Airtable `Size` veld is altijd al een geldige EU-maat -> letterlijk doorsturen.
  // 'raw' = ongewijzigd (default) | 'eu' = 41 1/3 -> 41 | 'dewu' = als Dewu Size Normalized
  sizeMode: (process.env.WTB_SIZE_MODE || 'raw').toLowerCase(),

  // Veiligheidsklep: prunen terwijl er niets gewenst is zou de hele WTB-lijst
  // wissen. Dat is bijna altijd een Airtable-storing, geen echte lege lijst.
  allowEmptyPrune: bool(process.env.WTB_ALLOW_EMPTY_PRUNE, false),

  runSecret: process.env.RUN_SECRET || '',
  dryRunDefault: bool(process.env.DRY_RUN, false),

  // Alleen voor de long-running server: "0 12 * * 1|fresh-24h; 0 12 * * 3|aging-72h"
  schedule: process.env.WTB_SCHEDULE || '',

  // Voor `run-profile.js --today` (Render Cron Job): "mon=fresh-24h, wed=aging-72h, default=ready"
  dailyProfiles: process.env.WTB_DAILY_PROFILES || '',

  // Zomertijd-vangnet: draai alleen als het lokaal dit uur is. Zie isRunHour().
  runLocalHour: process.env.WTB_RUN_LOCAL_HOUR ?? '',
  timezone: process.env.TZ || 'Europe/Amsterdam',
};

export function assertConfig({ requireWtb = true } = {}) {
  const missing = [];
  if (!config.airtable.token) missing.push('AIRTABLE_TOKEN (of AIRTABLE_API_KEY)');
  if (!config.airtable.baseId) missing.push('AIRTABLE_BASE_ID');
  if (requireWtb) {
    if (!config.wtb.apiKey) missing.push('WTB_API_KEY');
    if (!config.wtb.userId) missing.push('WTB_USER_ID');
  }
  if (missing.length) {
    throw new Error(`Ontbrekende env vars: ${missing.join(', ')}`);
  }
}
