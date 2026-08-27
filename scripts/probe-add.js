#!/usr/bin/env node
/**
 * Diagnostisch: waarom wijst /user/list/manage/add een maat af met NOT_FOUND?
 *
 * De aanleiding: JS1589 maat 42 kreeg NOT_FOUND terwijl die maat gewoon op de
 * productpagina van WTB Market staat (gecontroleerd op 2026-08-27). De export
 * noemde dat "niet in hun catalogus"; dat klopte dus niet, en waarom het
 * werkelijk misgaat weten we niet.
 *
 * NOT_FOUND is bij deze API niet specifiek: een delete met een `size` in de
 * body geeft dezelfde code, terwijl daar niets ontbreekt. De code zegt dus
 * "dit verzoek kon ik niet plaatsen", niet "dit product bestaat niet". Dit
 * script varieert daarom precies één ding per poging en laat het antwoord
 * zien, zodat zichtbaar wordt welk veld de afwijzing veroorzaakt.
 *
 * LET OP: dit schrijft. Een geslaagde add telt de quantity met 1 op - het
 * endpoint kent geen "zet op". Daarom stopt het script bij de eerste variant
 * die werkt, en meldt het wat je erbij hebt gezet. Op het rotating-profiel
 * ruimt de eerstvolgende run dat zelf op: die verwijdert de SKU en bouwt hem
 * terug op de gewenste aantallen.
 *
 * Gebruik:
 *   node scripts/probe-add.js JS1589 42          # eerst alleen lezen
 *   node scripts/probe-add.js JS1589 42 --write  # ook echt proberen
 */
import { config, assertConfig } from '../src/config.js';

assertConfig();

const sku = process.argv[2];
const size = process.argv[3];
const write = process.argv.includes('--write');

if (!sku || !size) {
  console.log('Gebruik: node scripts/probe-add.js <SKU> <maat> [--write]');
  process.exit(1);
}

const url = (path) => `${config.wtb.baseUrl}${path}`;

const headers = {
  [config.wtb.apiKeyHeader]: config.wtb.apiKey,
  user_id: String(config.wtb.userId),
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body) {
  // Dezelfde vertraging als de export, anders lopen we in hun rate limit en
  // is een 429 niet te onderscheiden van een echte afwijzing.
  await sleep(config.wtb.requestDelayMs);

  const res = await fetch(url(path), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* geen JSON - dan is de ruwe tekst het antwoord */
  }

  return { status: res.status, text, json };
}

console.log(`SKU ${sku}, maat ${size}`);
console.log(`base ${config.wtb.baseUrl}, user_id ${config.wtb.userId}\n`);

// Stap 1 - staat de maat er misschien al op? Dan is de add overbodig en
// vertelt NOT_FOUND iets heel anders dan we dachten.
const list = await call('GET', '/user/list/manage/get');
console.log(`GET lijst -> HTTP ${list.status}`);

const hit = list.text.toUpperCase().includes(String(sku).toUpperCase());
console.log(`  ${sku} komt ${hit ? 'WEL' : 'niet'} voor in de huidige lijst\n`);

if (!write) {
  console.log('Alleen gelezen. Voeg --write toe om de varianten te proberen.');
  process.exit(0);
}

// Elke variant verschilt op één punt van wat de export nu stuurt. Wat als
// eerste slaagt, is meteen het antwoord op de vraag.
const varianten = [
  ['zoals de export het stuurt', { sku, size: String(size), method: 'add' }],
  ['zonder method', { sku, size: String(size) }],
  ['maat als getal', { sku, size: Number(size), method: 'add' }],
  ['sku in hoofdletters', { sku: String(sku).toUpperCase(), size: String(size), method: 'add' }],
  ['quantity erbij', { sku, size: String(size), quantity: 1, method: 'add' }],
];

for (const [naam, body] of varianten) {
  const res = await call('POST', '/user/list/manage/add', body);
  const ok = res.status < 400 && res.json?.ok !== false;

  console.log(`${ok ? 'GELUKT ' : 'afgewezen'}  ${naam}`);
  console.log(`   body     ${JSON.stringify(body)}`);
  console.log(`   antwoord HTTP ${res.status} ${res.text.slice(0, 200)}\n`);

  if (ok) {
    console.log('Hierop reageert de API wel. Dit is dus het verschil dat telt.');
    console.log('De quantity van deze maat staat nu 1 hoger.');
    process.exit(0);
  }
}

console.log('Geen enkele variant werkt. Dan ligt het niet aan de body.');
