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

/**
 * Welk profiel hoort bij vandaag? `null` = vandaag niets doen.
 */
export function profileForToday(spec, timezone, date = new Date()) {
  const map = parseDailyProfiles(spec);
  if (map.size === 0) return { day: null, profile: null };
  const day = weekdayIn(timezone, date);
  return { day, profile: map.get(day) ?? map.get('default') ?? null };
}
