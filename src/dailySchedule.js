const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const ALIASES = {
  ma: 'mon', maandag: 'mon', monday: 'mon',
  di: 'tue', dinsdag: 'tue', tuesday: 'tue',
  wo: 'wed', woensdag: 'wed', wednesday: 'wed',
  do: 'thu', donderdag: 'thu', thursday: 'thu',
  vr: 'fri', vrijdag: 'fri', friday: 'fri',
  za: 'sat', zaterdag: 'sat', saturday: 'sat',
  zo: 'sun', zondag: 'sun', sunday: 'sun',
};

function canonicalDay(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (key === 'default' || key === '*') return 'default';
  if (DAYS.includes(key)) return key;
  return ALIASES[key] || null;
}

/**
 * "mon=fresh-24h, wed=aging-72h, default=ready" -> Map { mon -> fresh-24h, ... }
 */
export function parseDailyProfiles(spec) {
  const map = new Map();
  for (const part of String(spec || '').split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const [rawDay, profile] = entry.split('=').map((s) => (s || '').trim());
    const day = canonicalDay(rawDay);
    if (!day || !profile) {
      throw new Error(`Ongeldige WTB_DAILY_PROFILES entry: "${entry}" (verwacht "mon=profiel")`);
    }
    map.set(day, profile);
  }
  return map;
}

/** Weekdag in de opgegeven tijdzone, niet in Render's UTC. */
export function weekdayIn(timezone, date = new Date()) {
  const short = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: timezone })
    .format(date)
    .toLowerCase();
  return DAYS.includes(short) ? short : DAYS[date.getUTCDay()];
}

/** Lokale klok (uur/minuut) in de opgegeven tijdzone. */
export function localTimeIn(timezone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { hour: get('hour') % 24, minute: get('minute') };
}

/**
 * Render's cron schedules staan in UTC, dus een vast schema verschuift een uur
 * met de zomertijd. Oplossing: plan de cron op beide kandidaat-UTC-tijden en
 * laat alleen de run doorgaan waarbij het lokaal het juiste uur is.
 *
 * Accepteert meerdere uren: "12,20" voor een ochtend- en een avondrun.
 * Leeg = altijd draaien (geen tijdslot-check).
 */
export function parseRunHours(spec) {
  const raw = String(spec ?? '').trim();
  if (!raw) return [];
  return raw.split(',').map((part) => {
    const hour = Number(part.trim());
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new Error(`Ongeldige WTB_RUN_LOCAL_HOUR: "${part.trim()}" (verwacht 0-23)`);
    }
    return hour;
  });
}

export function isRunHour(spec, timezone, date = new Date()) {
  const hours = parseRunHours(spec);
  if (hours.length === 0) return true;
  return hours.includes(localTimeIn(timezone, date).hour);
}

/**
 * Welk profiel hoort bij vandaag? `null` = vandaag niets doen.
 */
export function profileForToday(spec, timezone, date = new Date()) {
  const map = parseDailyProfiles(spec);
  if (map.size === 0) return { day: null, profile: null };
  const day = weekdayIn(timezone, date);
  return { day, profile: map.get(day) ?? map.get('default') ?? null };
}
