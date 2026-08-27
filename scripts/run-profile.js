#!/usr/bin/env node
import { config, assertConfig } from '../src/config.js';
import { listProfiles } from '../src/profiles.js';
import { runProfile } from '../src/sync.js';
import { profileForToday, isRunHour, localTimeIn } from '../src/dailySchedule.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('-')));
const dryRun = flags.has('--dry-run');
const prune = flags.has('--prune') ? true : flags.has('--no-prune') ? false : undefined;
const useToday = flags.has('--today');
const force = flags.has('--force');
const showList = flags.has('--show-list');

let profileName = args.find((a) => !a.startsWith('-'));

if (useToday) {
  // Render's cron staat in UTC. We plannen beide kandidaat-tijden en laten
  // alleen de run doorgaan die lokaal in het juiste uur valt.
  if (!force && !isRunHour(config.runLocalHour, config.timezone)) {
    const now = localTimeIn(config.timezone);
    const clock = `${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`;
    console.log(
      `Lokaal is het ${clock} (${config.timezone}), geplande uren zijn ${config.runLocalHour} — niets te doen.`
    );
    process.exit(0);
  }

  // Eén Render Cron Job kan zo elke dag een ander profiel draaien.
  const { day, profile } = profileForToday(config.dailyProfiles, config.timezone);
  if (!profile) {
    console.log(`Geen profiel ingesteld voor ${day || 'vandaag'} — niets te doen.`);
    process.exit(0);
  }
  console.log(`Vandaag (${day}) -> profiel "${profile}"`);
  profileName = profile;
}

if (!profileName) {
  console.log('Gebruik: node scripts/run-profile.js <profiel> [--dry-run] [--prune|--no-prune]');
  console.log('         node scripts/run-profile.js --today          # profiel uit WTB_DAILY_PROFILES\n');
  console.log('Profielen:');
  for (const p of listProfiles()) console.log(`  ${p.name.padEnd(14)} ${p.description}`);
  process.exit(1);
}

assertConfig();

const summary = await runProfile(profileName, { dryRun, prune });

console.log(`\nProfiel:        ${summary.profile}${summary.dryRun ? '  (DRY RUN)' : ''}`);
console.log(`Airtable hits:  ${summary.records}`);
console.log(`Unieke items:   ${summary.desired}`);
console.log(`Al op lijst:    ${summary.currentOnList} (herkend: ${summary.listRecognized})`);
const som = (rows, veld) => rows.reduce((n, r) => n + (r[veld] ?? 1), 0);
console.log(`Toegevoegd:     ${som(summary.added, 'times')} paar over ${summary.added.length} maten`);
console.log(`Verwijderd:     ${summary.removed.length} maten`);
if (summary.readded.length) {
  console.log(
    `Teruggezet:     ${som(summary.readded, 'quantity')} paar over ${summary.readded.length} maten` +
      '  (na een SKU-rebuild)'
  );
}
console.log(`Overgeslagen:   ${summary.skipped.length}`);
// Een NOT_FOUND op /add zegt niets: de add landt vaak alsnog. Deze twee
// regels laten zien hoeveel van de afwijzingen loos alarm waren, zodat het
// getal eronder alleen nog over echte mislukkingen gaat.
if (summary.landdeAlsnog) {
  console.log(`Toch gelukt (404 was loos): ${summary.landdeAlsnog}`);
}
if (summary.geslaagdNaRetry) {
  console.log(`Gelukt bij tweede poging:  ${summary.geslaagdNaRetry}`);
}
if (summary.retryOvergeslagen) {
  console.log(`Geen 2e poging (geen prune): ${summary.retryOvergeslagen}`);
}
if (summary.unavailable.length) {
  console.log(`Echt niet gelukt:          ${summary.unavailable.length}`);
}

if (showList) {
  console.log('');
  console.log('--- ruwe /user/list/manage/get response ---');
  console.log(summary.listRaw || '(leeg)');
  console.log('--- einde response ---');
}

if (summary.skipped.length) {
  console.log('\nOvergeslagen records:');
  for (const s of summary.skipped.slice(0, 25)) {
    console.log(`  ${s.orderId} ${s.sku || ''} -> ${s.reason}`);
  }
}

if (summary.unavailable.length) {
  console.log('');
  console.log('Staat na twee pogingen nog steeds niet op de lijst:');
  for (const u of summary.unavailable) {
    console.log(`  ${u.sku} maat ${u.size} -> ${u.reden || 'geen melding'}`);
  }
}

if (summary.errors.length) {
  console.log('\nFouten:');
  for (const e of summary.errors) console.log(`  ${e}`);
  process.exitCode = 1;
}
