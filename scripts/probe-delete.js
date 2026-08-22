#!/usr/bin/env node
/**
 * Diagnostisch: zoekt uit of er ergens een werkend delete-endpoint zit.
 *
 * `POST /user/list/manage/delete` geeft "Cannot POST" (Express 404), en
 * `/add` met method:"delete" telt de quantity juist op. Dit script probeert
 * een paar varianten en rapporteert wat elk endpoint teruggeeft.
 *
 * Gebruik: node scripts/probe-delete.js <SKU> [maat]
 */
import { config, assertConfig } from '../src/config.js';

assertConfig();

const sku = process.argv[2];
const size = process.argv[3] || '39';

if (!sku) {
  console.log('Gebruik: node scripts/probe-delete.js <SKU> [maat]');
  process.exit(1);
}

const VARIANTEN = [
  { method: 'DELETE', path: '/user/list/manage/delete', body: { sku } },
  { method: 'DELETE', path: '/user/list/manage/delete', body: { sku, size } },
  { method: 'POST', path: '/user/list/manage/remove', body: { sku } },
  { method: 'DELETE', path: '/user/list/manage/add', body: { sku, size } },
  { method: 'DELETE', path: '/user/list/manage', body: { sku } },
  { method: 'POST', path: '/user/list/delete', body: { sku } },
];

const headers = {
  [config.wtb.apiKeyHeader]: config.wtb.apiKey,
  user_id: String(config.wtb.userId),
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

console.log(`Zoekt een werkend delete-endpoint voor ${sku} maat ${size}\n`);

for (const v of VARIANTEN) {
  const label = `${v.method} ${v.path} ${JSON.stringify(v.body)}`;
  try {
    const res = await fetch(`${config.wtb.baseUrl}${v.path}`, {
      method: v.method,
      headers,
      body: JSON.stringify(v.body),
    });
    const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120);
    const bestaat = !/Cannot (POST|DELETE|GET|PUT)/i.test(text);
    console.log(`${bestaat ? '>>' : '  '} ${res.status}  ${label}`);
    if (bestaat) console.log(`      ${text || '(lege body)'}`);
  } catch (err) {
    console.log(`   ERR  ${label} -> ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 300));
}

console.log('\nRegels met >> zijn endpoints die wél bestaan. Check daarna met');
console.log('`--show-list` of de SKU echt van de lijst is.');
