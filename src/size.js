const UNICODE_FRACTIONS = [
  [/⅓/g, ' 1/3'],
  [/⅔/g, ' 2/3'],
  [/½/g, ' 1/2'],
];

// Airtable's `Dewu Size Normalized` veld somt deze maten expliciet op als
// "1/3 -> heel getal". Alleen relevant in mode 'dewu'.
const DEWU_WHOLE_THIRDS = new Set(['37', '39', '43', '45']);

/**
 * Het `Size` veld in `Unfulfilled Orders Log` is altijd al een geldige EU-maat,
 * dus standaard sturen we hem letterlijk door (mode 'raw', alleen getrimd).
 *
 * De andere modes zijn een noodklep voor als WTB Market breuknotatie
 * ("41 1/3") niet accepteert:
 *   'eu'    adidas-derdematen -> Nike-decimalen (41 1/3 -> 41, 42 2/3 -> 42.5)
 *   'dewu'  exact hetzelfde als het `Dewu Size Normalized` formulaveld
 *
 * @returns {{ ok: boolean, size: string|null, reason: string|null }}
 */
export function normalizeSize(raw, mode = 'raw') {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { ok: false, size: null, reason: 'lege maat' };

  if (mode === 'raw') return { ok: true, size: trimmed, reason: null };

  let s = trimmed;
  for (const [re, rep] of UNICODE_FRACTIONS) s = s.replace(re, rep);
  s = s.replace(/,/g, '.').replace(/\s+/g, ' ').trim();
  s = s.replace(/^eur?\s*[-:]?\s*/i, '').trim();

  let out = s;
  const third = s.match(/^(\d+)\s*1\/3$/);
  const twoThird = s.match(/^(\d+)\s*2\/3$/);
  const half = s.match(/^(\d+)\s*1\/2$/);

  if (third) {
    // adidas 41 1/3 = US 8 = EU 41. Alle derdematen zakken naar het hele getal.
    out =
      mode === 'dewu' && !DEWU_WHOLE_THIRDS.has(third[1]) ? `${third[1]}.5` : third[1];
  } else if (twoThird) {
    // adidas 42 2/3 = US 9 = EU 42.5
    out = `${twoThird[1]}.5`;
  } else if (half) {
    out = `${half[1]}.5`;
  } else if (/\d\s*\/\s*\d/.test(s)) {
    return { ok: false, size: null, reason: `onbekende breuknotatie: "${trimmed}"` };
  }

  out = out.replace(/^(\d+)\.0$/, '$1'); // "42.0" -> "42"

  if (!/^\d+(\.5)?$/.test(out)) {
    return { ok: false, size: null, reason: `onverwacht maatformaat: "${trimmed}"` };
  }

  return { ok: true, size: out, reason: null };
}

/**
 * Het `SKU` formulaveld levert altijd de juiste SKU, dus we sturen hem
 * letterlijk door. Alleen trimmen.
 */
export function normalizeSku(raw) {
  const s = String(raw ?? '').trim();
  return s || null;
}

/**
 * Sleutel om onze lijst te vergelijken met wat er al op WTB Market staat.
 * Hoofdletter-ongevoelig zodat een casing-verschil in hun response geen
 * dubbele push oplevert. Wordt nooit verstuurd — alleen om te diffen.
 */
export function skuKey(raw) {
  const s = normalizeSku(raw);
  return s ? s.toUpperCase() : null;
}

export function pairKey(sku, size) {
  return `${skuKey(sku)}|${String(size).trim()}`;
}
