import { config } from './config.js';
import { listRecords } from './airtable.js';
import { resolveProfile, EXPORT_FIELDS } from './profiles.js';
import { WtbClient, parseList } from './wtbClient.js';
import { normalizeSize, normalizeSku, skuKey, pairKey } from './size.js';

// Rusttijd tussen de laatste add en de controle erop. Zie verifieerAfgewezen.
const SETTLE_MS = 10000;

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
    unavailable: [],
    // Afgewezen met NOT_FOUND maar bij de nacontrole toch op de lijst.
    landdeAlsnog: 0,
    // Ontbrak echt en kwam er na de tweede poging alsnog op.
    geslaagdNaRetry: 0,
    // Ontbrak, maar zonder prunen wordt er geen tweede poging gedaan.
    retryOvergeslagen: 0,
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
      if (err.code !== 'NOT_FOUND') {
        summary.errors.push(`delete ${plan.sku}: ${err.message}`);
        continue; // niets terugzetten als het wissen niet lukte
      }
      // NOT_FOUND = stond er al niet meer. Gewoon doorgaan met opbouwen.
    }

    for (const s of plan.sizes) {
      try {
        for (let i = 0; i < s.quantity; i++) await client.addSize(plan.sku, s.size);
        summary.readded.push({ sku: plan.sku, size: s.size, quantity: s.quantity });
      } catch (err) {
        if (err.code === 'NOT_FOUND') {
          summary.unavailable.push({ sku: plan.sku, size: s.size, reden: err.message });
        } else {
          // Volgende run herstelt dit: de maat mist dan simpelweg op de lijst.
          summary.errors.push(`terugzetten ${plan.sku} ${s.size}: ${err.message}`);
        }
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
      if (err.code === 'NOT_FOUND') {
        // NOT_FOUND betekent NIET "deze SKU staat niet in hun catalogus".
        // Hier stond die uitleg wel, en die was fout: JS1589 maat 42 kreeg
        // NOT_FOUND terwijl die maat gewoon op hun productpagina staat
        // (gecontroleerd op 2026-08-27). Dezelfde code komt ook terug op een
        // delete met een `size` in de body - een verzoek dat prima had gekund
        // als de body anders was. NOT_FOUND is bij deze API dus een algemene
        // afwijzing, geen uitspraak over hun catalogus.
        //
        // Waarom deze maat wordt afgewezen is nog onbekend. De reden gaat mee
        // in de samenvatting zodat de volgende run meer vertelt dan alleen
        // het feit dat het misging.
        summary.unavailable.push({
          sku: item.sku,
          size: item.size,
          orders: item.orders,
          reden: err.message,
        });
      } else {
        summary.errors.push(`add ${item.sku} ${item.size}: ${err.message}`);
      }
    }
  }

  await verifieerAfgewezen({ client, summary, dryRun, prune });

  summary.finishedAt = new Date().toISOString();
  return summary;
}

/*
 * Een NOT_FOUND op /add betekent niet dat de add mislukt is.
 *
 * Gemeten op 2026-08-27, twee runs achter elkaar: negen maten werden met
 * NOT_FOUND afgewezen, en zes daarvan stonden daarna gewoon op de lijst met
 * quantity 1. De add landde dus, alleen zei het antwoord van niet. De andere
 * drie ontbraken echt, en die faalden in beide runs.
 *
 * Dat zijn twee verschillende dingen, en het rapport gooide ze op een hoop:
 * het meldde negen mislukkingen waarvan er zes prima waren gegaan.
 *
 * Daarom wordt de lijst na afloop opnieuw opgehaald en per afgewezen maat
 * gekeken wat er werkelijk staat. Wat er staat verhuist naar `added`. Wat
 * er niet staat krijgt nog een poging, en daarna nog een controle.
 *
 * WAAROM EERST KIJKEN EN DAN PAS OPNIEUW PROBEREN:
 *
 * /add kent geen "zet op 1" - elke aanroep telt er een bij op. Meteen opnieuw
 * proberen zou die zes op quantity 2 zetten, en dan koopt de rotatie er twee
 * in plaats van een. De controle vooraf is geen extra zorgvuldigheid maar de
 * voorwaarde om uberhaupt te mogen herhalen.
 *
 * Blijft een maat na de tweede poging weg, dan is dat een echte afwijzing.
 * Die lijst is nu klein en betrouwbaar genoeg om iets mee te doen.
 */
async function verifieerAfgewezen({ client, summary, dryRun, prune }) {
  if (dryRun || !summary.unavailable.length) return;

  // De add lijkt niet altijd meteen zichtbaar. Even wachten voordat we
  // vaststellen dat iets ontbreekt, anders noemen we een trage add een
  // mislukte add en tellen we er straks een tweede bovenop.
  await new Promise((r) => setTimeout(r, SETTLE_MS));

  // Zonder herkende lijst kunnen we niets vaststellen. Dan liever niets doen
  // dan op goed geluk opnieuw toevoegen.
  if (summary.listRecognized === false) {
    summary.errors.push(
      'Afgewezen maten niet geverifieerd: de lijst-response werd niet herkend.'
    );
    return;
  }

  const opLijst = async () => {
    const res = await client.getList();
    const lijst = parseList(res.json ?? res.raw);

    if (!lijst.recognized) return null;

    return lijst.pairs;
  };

  let pairs;
  try {
    pairs = await opLijst();
  } catch (err) {
    summary.errors.push(`Controle na afwijzingen mislukt: ${err.message}`);
    return;
  }

  if (!pairs) return;

  const echtWeg = [];

  for (const u of summary.unavailable) {
    if (pairs.has(pairKey(u.sku, u.size))) {
      summary.added.push({ sku: u.sku, size: u.size, orders: u.orders, times: 1, alsnog: true });
    } else {
      echtWeg.push(u);
    }
  }

  summary.landdeAlsnog = summary.unavailable.length - echtWeg.length;
  summary.unavailable = echtWeg;

  if (!echtWeg.length) return;

  // Alleen opnieuw proberen als prunen aanstaat.
  //
  // De controle hierboven is goed maar niet waterdicht: komt een geslaagde
  // add pas later op de lijst, dan hebben we hem net gemist en maakt de
  // tweede poging er quantity 2 van. Met prunen corrigeert de volgende run
  // dat vanzelf - te veel van een maat is precies wat een rebuild oplost.
  // Zonder prunen blijft die 2 staan, en dan koopt de rotatie er twee. Die
  // gok is het niet waard voor een maat die er over een dag alsnog op komt.
  if (!prune) {
    summary.retryOvergeslagen = echtWeg.length;
    return;
  }

  // Tweede poging, alleen voor wat aantoonbaar ontbreekt.
  for (const u of echtWeg) {
    try {
      await client.addSize(u.sku, u.size);
    } catch (err) {
      u.reden2 = err.message;
    }
  }

  let naRetry;
  try {
    naRetry = await opLijst();
  } catch (err) {
    summary.errors.push(`Controle na tweede poging mislukt: ${err.message}`);
    return;
  }

  if (!naRetry) return;

  const blijftWeg = [];

  for (const u of echtWeg) {
    if (naRetry.has(pairKey(u.sku, u.size))) {
      summary.added.push({ sku: u.sku, size: u.size, orders: u.orders, times: 1, tweedePoging: true });
    } else {
      blijftWeg.push(u);
    }
  }

  summary.geslaagdNaRetry = echtWeg.length - blijftWeg.length;
  summary.unavailable = blijftWeg;
}
