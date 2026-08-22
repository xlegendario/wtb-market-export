import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDailyProfiles,
  weekdayIn,
  profileForToday,
  localTimeIn,
  isRunHour,
  parseRunHours,
} from '../src/dailySchedule.js';

const TZ = 'Europe/Amsterdam';

test('parseDailyProfiles accepteert engelse, nederlandse en korte dagnamen', () => {
  const map = parseDailyProfiles('mon=fresh-24h, woensdag=aging-72h, VR=high-value, default=ready');
  assert.equal(map.get('mon'), 'fresh-24h');
  assert.equal(map.get('wed'), 'aging-72h');
  assert.equal(map.get('fri'), 'high-value');
  assert.equal(map.get('default'), 'ready');
});

test('parseDailyProfiles weigert onzin i.p.v. stil te negeren', () => {
  assert.throws(() => parseDailyProfiles('maandagg=fresh-24h'), /Ongeldige/);
  assert.throws(() => parseDailyProfiles('mon'), /Ongeldige/);
});

test('weekdag wordt in de juiste tijdzone bepaald, niet in UTC', () => {
  // Maandag 00:30 in Amsterdam = zondag 22:30 UTC.
  const date = new Date('2026-08-24T22:30:00Z');
  assert.equal(weekdayIn('UTC', date), 'mon');
  assert.equal(weekdayIn(TZ, date), 'tue');
});

test('profileForToday pakt de dag, valt terug op default', () => {
  const monday = new Date('2026-08-24T10:00:00Z');
  assert.equal(profileForToday('mon=fresh-24h, wed=aging-72h', TZ, monday).profile, 'fresh-24h');

  const tuesday = new Date('2026-08-25T10:00:00Z');
  assert.equal(profileForToday('mon=fresh-24h, wed=aging-72h', TZ, tuesday).profile, null);
  assert.equal(profileForToday('mon=fresh-24h, default=ready', TZ, tuesday).profile, 'ready');
});

test('lege config = niets draaien', () => {
  assert.equal(profileForToday('', TZ).profile, null);
});

test('12:30 NL blijft 12:30 NL, ook na de overgang naar wintertijd', () => {
  // Cron staat op "30 10,11 * * *" (UTC). Precies één van de twee mag door.
  const zomer = { utc1030: new Date('2026-08-24T10:30:00Z'), utc1130: new Date('2026-08-24T11:30:00Z') };
  assert.equal(localTimeIn('Europe/Amsterdam', zomer.utc1030).hour, 12);
  assert.equal(isRunHour('12', 'Europe/Amsterdam', zomer.utc1030), true);
  assert.equal(isRunHour('12', 'Europe/Amsterdam', zomer.utc1130), false);

  const winter = { utc1030: new Date('2026-12-14T10:30:00Z'), utc1130: new Date('2026-12-14T11:30:00Z') };
  assert.equal(isRunHour('12', 'Europe/Amsterdam', winter.utc1030), false);
  assert.equal(isRunHour('12', 'Europe/Amsterdam', winter.utc1130), true);
});

test('isRunHour tolereert een late cron binnen hetzelfde uur', () => {
  const laat = new Date('2026-08-24T10:55:00Z'); // 12:55 NL
  assert.equal(isRunHour('12', 'Europe/Amsterdam', laat), true);
});

test('lege WTB_RUN_LOCAL_HOUR = geen tijdslot-check', () => {
  assert.equal(isRunHour('', 'Europe/Amsterdam', new Date('2026-08-24T03:00:00Z')), true);
  assert.equal(isRunHour(null, 'Europe/Amsterdam', new Date()), true);
});

test('isRunHour weigert onzin i.p.v. stil altijd te draaien', () => {
  assert.throws(() => isRunHour('half een', 'Europe/Amsterdam'), /Ongeldige/);
  assert.throws(() => isRunHour('25', 'Europe/Amsterdam'), /Ongeldige/);
});

test('meerdere uren: een ochtend- en een avondrun', () => {
  // Cron "30 10,11,18,19 * * *" met WTB_RUN_LOCAL_HOUR=12,20
  const zomer = '2026-08-24T';
  const draait = (u) => isRunHour('12,20', TZ, new Date(zomer + u + ':00Z'));
  assert.equal(draait('10:30'), true); // 12:30 NL
  assert.equal(draait('11:30'), false); // 13:30 NL
  assert.equal(draait('18:30'), true); // 20:30 NL
  assert.equal(draait('19:30'), false); // 21:30 NL

  const winter = '2026-12-14T';
  const draaitW = (u) => isRunHour('12,20', TZ, new Date(winter + u + ':00Z'));
  assert.equal(draaitW('10:30'), false); // 11:30 NL
  assert.equal(draaitW('11:30'), true); // 12:30 NL
  assert.equal(draaitW('18:30'), false); // 19:30 NL
  assert.equal(draaitW('19:30'), true); // 20:30 NL
});

test('spaties rond de uren zijn toegestaan', () => {
  assert.deepEqual(parseRunHours(' 12 , 20 '), [12, 20]);
  assert.deepEqual(parseRunHours(''), []);
});

test('een ongeldig uur in de lijst wordt geweigerd', () => {
  assert.throws(() => parseRunHours('12,25'), /Ongeldige/);
});
