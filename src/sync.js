import { config } from './config.js';
import { listRecords } from './airtable.js';
import { resolveProfile, EXPORT_FIELDS } from './profiles.js';
import { WtbClient, parseList } from './wtbClient.js';
import { normalizeSize, normalizeSku, skuKey, pairKey } from './size.js';

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

/**
 * Bepaalt per SKU wat er moet gebeuren.
 *
 * WTB Market kan alleen optellen (`/add` verhoogt de quantity) en een hele SKU
 * wissen (`DELETE /delete`). Er is geen "verlaag met 1" en geen "verwijder één
 * maat". Dus:
 *
 *   aantal te laag  -> zo vaak `add` als nodig
 *   aantal te hoog  -> hele SKU wissen en in de juiste aantallen opnieuw opbouwen
 *   maat moet weg   -> zelfde rebuild
 *
 * Zonder `prune` wordt er alleen bijgeteld, nooit gewist.
 */
export function planChanges({ desired, currentEntries, prune }) {
  const bySku = new Map();

  const slot = (sku) => {
    const key = skuKey(sku);
    if (!bySku.has(key)) bySku.set(key, { sku, current: new Map(), desired: new Map() });
    return bySku.get(key);
  };

  for (const entry of currentEntries.values()) {
    slot(entry.sku).current.set(entry.size, entry.quantity);
  }

  for (const item of desired) {
    const group = slot(item.sku);
    group.sku = item.sku; // Airtable bepaalt de schrijfwijze die we versturen
    group.desired.set(item.size, { quantity: item.orders.length, orders: item.orders });
  }

  const rebuilds = [];
  const adds = [];

  for (const group of bySku.values()) {
    const teVeel = [...group.current.entries()].filter(
      ([size, qty]) => qty > (group.desired.get(size)?.quantity ?? 0)
    );

    if (teVeel.length > 0 && prune) {
      rebuilds.push({
        sku: group.sku,
        removed: teVeel.map(([size, quantity]) => ({
          size,
          quantity,
          wanted: group.desired.get(size)?.quantity ?? 0,
        })),
        sizes: [...group.desired.entries()].map(([size, d]) => ({
          size,
          quantity: d.quantity,
          orders: d.orders,
        })),
      });
      continue;
    }

    for (const [size, d] of group.desired) {
      const have = group.current.get(size) ?? 0;
      if (d.quantity > have) {
        adds.push({ sku: group.sku, size, times: d.quantity - have, orders: d.orders });
      }
    }
  }

  return { rebuilds, adds };
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
    listRaw: null,
    added: [],
    removed: [],
    readded: [],
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
    // Bewaard om de exacte vorm te kunnen inspecteren (bevat geen credentials).
    summary.listRaw = String(res.raw ?? '').slice(0, 2000);
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

  // Een leeg resultaat uit Airtable is bijna altijd een storing of een kapotte
  // formule, geen signaal dat de hele WTB-lijst leeg moet. Dus niet prunen,
  // tenzij expliciet toegestaan.
  const emptyPruneBlocked =
    prune && desired.length === 0 && current.pairs.size > 0 && !config.allowEmptyPrune;

  if (emptyPruneBlocked) {
    summary.errors.push(
      `Prunen overgeslagen: Airtable gaf 0 items terwijl er ${current.pairs.size} op de lijst staan. ` +
        'Zet WTB_ALLOW_EMPTY_PRUNE=true als dit wel de bedoeling is.'
    );
  }

  const { rebuilds, adds } = planChanges({
    desired,
    currentEntries: current.entries,
    prune: prune && current.recognized && !emptyPruneBlocked,
  });

  // Eerst de rebuilds. Die raken maten aan die anders daarna nog eens
  // toegevoegd zouden worden.
  for (const plan of rebuilds) {
    if (dryRun) {
      for (const r of plan.removed) {
        summary.removed.push({ sku: plan.sku, size: r.size, van: r.quantity, naar: r.wanted, dryRun: true });
      }
      for (const s of plan.sizes) {
        summary.readded.push({ sku: plan.sku, size: s.size, quantity: s.quantity, dryRun: true });
      }
      continue;
    }

    try {
      await client.deleteSku(plan.sku);
      for (const r of plan.removed) {
        summary.removed.push({ sku: plan.sku, size: r.size, van: r.quantity, naar: r.wanted });
      }
    } catch (err) {
      summary.errors.push(`delete ${plan.sku}: ${err.message}`);
      continue; // niets terugzetten als het wissen niet lukte
    }

    for (const s of plan.sizes) {
      try {
        for (let i = 0; i < s.quantity; i++) await client.addSize(plan.sku, s.size);
        summary.readded.push({ sku: plan.sku, size: s.size, quantity: s.quantity });
      } catch (err) {
        // Volgende run herstelt dit: de maat mist dan simpelweg op de lijst.
        summary.errors.push(`terugzetten ${plan.sku} ${s.size}: ${err.message}`);
      }
    }
  }

  for (const item of adds) {
    if (dryRun) {
      summary.added.push({ ...item, dryRun: true });
      continue;
    }
    try {
      for (let i = 0; i < item.times; i++) await client.addSize(item.sku, item.size);
      summary.added.push(item);
    } catch (err) {
      summary.errors.push(`add ${item.sku} ${item.size}: ${err.message}`);
    }
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}
