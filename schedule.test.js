import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDailyProfiles, weekdayIn, profileForToday } from '../src/dailySchedule.js';

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
