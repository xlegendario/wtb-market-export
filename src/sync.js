import { config } from './config.js';
import { listRecords } from './airtable.js';
import { resolveProfile, EXPORT_FIELDS } from './profiles.js';
import { WtbClient, parseList } from './wtbClient.js';
import { normalizeSize, normalizeSku, pairKey } from './size.js';

/**
 * Zet Airtable-records om naar unieke {sku, size} paren.
 * Records met een onbruikbare SKU/maat komen in `skipped` terecht,
 * zodat je ze in de run-log terugziet i.p.v. dat ze stil verdwijnen.
 */
export function buildDesiredPairs(records, sizeMode) {
  const pairs = new Map();
  const skipped = [];

  for (const record of records) {
    const f = record.fields || {};
    const sku = normalizeSku(f['SKU']);
    const orderId = f['Order ID'] || record.id;

    if (!sku) {
      skipped.push({ recordId: record.id, orderId, reason: 'geen SKU' });
      continue;
    }

    const size = normalizeSize(f['Size'], sizeMode);
    if (!size.ok) {
      skipped.push({ recordId: record.id, orderId, sku, raw: f['Size'], reason: size.reason });
      continue;
    }

    const key = pairKey(sku, size.size);
    if (!pairs.has(key)) {
      pairs.set(key, {
        key,
        sku,
        size: size.size,
        rawSize: f['Size'],
        brand: f['Brand'] || null,
        product: f['Product Name'] || null,
        orders: [],
      });
    }
    pairs.get(key).orders.push(orderId);
  }

  return { pairs, skipped };
}

export async function runProfile(profileName, options = {}) {
  const startedAt = new Date().toISOString();
  const dryRun = options.dryRun ?? config.dryRunDefault;
  const profile = resolveProfile(profileName);
  const prune = options.prune ?? profile.prune;
  const maxItems = options.maxItems ?? null;

  const summary = {
    profile: profile.name,
    dryRun,
    prune,
    startedAt,
    finishedAt: null,
    records: 0,
    desired: 0,
    currentOnList: 0,
    listRecognized: null,
    added: [],
    removed: [],
    skipped: [],
    errors: [],
  };

  const records = await listRecords({
    token: config.airtable.token,
    baseId: config.airtable.baseId,
    table: config.airtable.table,
    filterByFormula: profile.formula,
    fields: EXPORT_FIELDS,
    sort: [{ field: 'Order Date', direction: 'desc' }],
  });
  summary.records = records.length;

  const { pairs, skipped } = buildDesiredPairs(records, config.sizeMode);
  summary.skipped = skipped;

  let desired = [...pairs.values()];
  if (maxItems && desired.length > maxItems) {
    summary.errors.push(`Afgekapt op ${maxItems} items (${desired.length} gevonden).`);
    desired = desired.slice(0, maxItems);
  }
  summary.desired = desired.length;

  const client = new WtbClient(config.wtb);

  // Huidige lijst ophalen zodat we alleen het verschil pushen.
  let current = { recognized: false, pairs: new Set(), skus: new Set(), entries: new Map() };
  try {
    const res = await client.getList();
    current = parseList(res.json ?? res.raw);
    summary.listRecognized = current.recognized;
    if (!current.recognized) {
      summary.errors.push(
        'Response van /user/list/manage/get niet herkend — er wordt alleen toegevoegd, niet verwijderd.'
      );
    }
  } catch (err) {
    summary.errors.push(`Ophalen huidige lijst mislukt: ${err.message}`);
  }
  summary.currentOnList = current.pairs.size;

  const toAdd = desired.filter((p) => !current.pairs.has(p.key));

  const desiredKeys = new Set(desired.map((p) => p.key));
  const toRemove =
    prune && current.recognized
      ? [...current.pairs].filter((key) => !desiredKeys.has(key))
      : [];

  for (const item of toAdd) {
    if (dryRun) {
      summary.added.push({ sku: item.sku, size: item.size, orders: item.orders, dryRun: true });
      continue;
    }
    try {
      await client.addSize(item.sku, item.size);
      summary.added.push({ sku: item.sku, size: item.size, orders: item.orders });
    } catch (err) {
      summary.errors.push(`add ${item.sku} ${item.size}: ${err.message}`);
    }
  }

  for (const key of toRemove) {
    // Stuur exact terug wat WTB Market zelf teruggaf, niet onze diff-sleutel.
    const { sku, size } = current.entries.get(key);
    if (dryRun) {
      summary.removed.push({ sku, size, dryRun: true });
      continue;
    }
    try {
      await client.removeSize(sku, size);
      summary.removed.push({ sku, size });
    } catch (err) {
      summary.errors.push(`remove ${sku} ${size}: ${err.message}`);
    }
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}
