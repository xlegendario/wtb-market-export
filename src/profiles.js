/**
 * Filterprofielen. Elk profiel = een Airtable filterformule op
 * `Unfulfilled Orders Log`. Een run draait altijd precies één profiel,
 * zodat je per dag/tijdstip een ander profiel kunt inplannen.
 */

const HIGH_VALUE_MIN = Number(process.env.WTB_HIGH_VALUE_MIN || 150);

// Wat we sowieso nooit willen exporteren: alles wat geen open outsource-order is.
const OPEN_OUTSOURCE = `
  {Fulfillment Status} = "Outsource",
  {Outsourced?} = 0,
  {SKU} != BLANK(),
  {Size} != BLANK()
`;

function and(...clauses) {
  return `AND(${clauses.filter(Boolean).join(',\n')})`;
}

/** Waarde veilig in een Airtable-formule zetten. */
function quote(value) {
  // JSON-escaping dekt precies wat Airtable nodig heeft: quotes en backslashes.
  return JSON.stringify(String(value));
}

// Testprofiel: één bekend item, om de koppeling te verifiëren zonder de echte
// lijst vol te zetten. Overschrijfbaar via env, zonder code te wijzigen.
const TEST_SKU = process.env.WTB_TEST_SKU || 'IF1787-100';
const TEST_SIZE = process.env.WTB_TEST_SIZE || '39';

/** Velden die we uit Airtable ophalen (klein houden = sneller). */
export const EXPORT_FIELDS = [
  'Order ID',
  'SKU',
  'Size',
  'Brand',
  'Product Name',
  'Quantity',
  'Order Date',
  'Outsource Start Time',
  'Fulfillment Status',
  'Final Outsource Buying Price',
];

export const PROFILES = {
  'all-open': {
    description: 'Alle open Outsource-orders, zonder extra filter.',
    formula: and(OPEN_OUTSOURCE),
  },

  ready: {
    description:
      'Open Outsource-orders waarvan de client-delay verstreken is ({Ready for Outsource} = 1).',
    formula: and(OPEN_OUTSOURCE, '{Ready for Outsource} = 1'),
  },

  'fresh-24h': {
    description: 'Open Outsource-orders die in de laatste 24 uur binnenkwamen.',
    formula: and(
      OPEN_OUTSOURCE,
      `DATETIME_DIFF(NOW(), {Order Date}, 'hours') <= 24`
    ),
  },

  'aging-72h': {
    description:
      'Open Outsource-orders die al 72+ uur in outsource staan — de moeilijke pairs.',
    formula: and(
      OPEN_OUTSOURCE,
      '{Outsource Start Time} != BLANK()',
      `DATETIME_DIFF(NOW(), {Outsource Start Time}, 'hours') >= 72`
    ),
  },

  'test-single': {
    description: `Test: alleen SKU ${TEST_SKU} maat ${TEST_SIZE} in Outsource. Niet voor productie.`,
    formula: and(
      '{Fulfillment Status} = "Outsource"',
      `{SKU} = ${quote(TEST_SKU)}`,
      `{Size} = ${quote(TEST_SIZE)}`
    ),
  },

  'high-value': {
    description: `Open Outsource-orders met een inkoopprijs vanaf €${HIGH_VALUE_MIN}.`,
    formula: and(
      OPEN_OUTSOURCE,
      `{Final Outsource Buying Price} >= ${HIGH_VALUE_MIN}`
    ),
  },
};

const PRUNE_PROFILES = new Set(
  String(process.env.WTB_PRUNE_PROFILES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

export function resolveProfile(name) {
  const profile = PROFILES[name];
  if (!profile) {
    throw new Error(
      `Onbekend profiel "${name}". Beschikbaar: ${Object.keys(PROFILES).join(', ')}`
    );
  }
  return {
    name,
    ...profile,
    // Standaard NIET prunen: dan raken we nooit per ongeluk handmatig
    // toegevoegde items op de WTB Market lijst kwijt.
    prune: PRUNE_PROFILES.has(name),
  };
}

export function listProfiles() {
  return Object.entries(PROFILES).map(([name, p]) => ({
    name,
    description: p.description,
    prune: PRUNE_PROFILES.has(name),
    formula: p.formula,
  }));
}
