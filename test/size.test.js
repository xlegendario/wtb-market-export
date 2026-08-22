import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSize, normalizeSku, skuKey, pairKey } from '../src/size.js';
import { parseList } from '../src/wtbClient.js';

test('Size wordt standaard letterlijk doorgestuurd', () => {
  // Het Airtable `Size` veld is altijd al een geldige EU-maat.
  for (const input of ['42', '42.5', '41 1/3', '36 2/3', '27', '44½']) {
    const result = normalizeSize(input);
    assert.equal(result.ok, true);
    assert.equal(result.size, input);
  }
  assert.equal(normalizeSize('  43  ').size, '43');
});

test('lege maat wordt geweigerd i.p.v. gegokt', () => {
  for (const input of ['', '   ', null, undefined]) {
    assert.equal(normalizeSize(input).ok, false);
  }
});

test('eu-mode zet adidas-derdematen om (noodklep)', () => {
  const cases = [
    ['41 1/3', '41'],
    ['37 1/3', '37'],
    ['47 1/3', '47'],
    ['42 2/3', '42.5'],
    ['36 2/3', '36.5'],
    ['44½', '44.5'],
    ['EU 44', '44'],
    ['44,5', '44.5'],
    ['42', '42'],
  ];
  for (const [input, expected] of cases) {
    const result = normalizeSize(input, 'eu');
    assert.equal(result.ok, true, `${input}: ${result.reason}`);
    assert.equal(result.size, expected, `${input} -> ${result.size}, verwacht ${expected}`);
  }
});

test('dewu-mode spiegelt het Airtable formulaveld', () => {
  assert.equal(normalizeSize('41 1/3', 'dewu').size, '41.5');
  assert.equal(normalizeSize('39 1/3', 'dewu').size, '39');
});

test('SKU gaat letterlijk mee, diffen is hoofdletter-ongevoelig', () => {
  assert.equal(normalizeSku(' CV1659-001 '), 'CV1659-001');
  assert.equal(normalizeSku(''), null);
  assert.equal(skuKey('cv1659-001'), 'CV1659-001');
  assert.equal(pairKey('cv1659-001', '39'), 'CV1659-001|39');
});

test('parseList herkent meerdere response-vormen', () => {
  const shapes = [
    [{ sku: 'CV1659-001', size: '39' }],
    [{ sku: 'CV1659-001', sizes: ['39'] }],
    { list: [{ sku: 'CV1659-001', sizes: [{ size: '39' }] }] },
    { 'CV1659-001': ['39'] },
  ];
  for (const shape of shapes) {
    const parsed = parseList(shape);
    assert.equal(parsed.recognized, true);
    assert.ok(parsed.pairs.has('CV1659-001|39'));
  }
});

test('parseList bewaart de originele sku/size om mee te verwijderen', () => {
  const parsed = parseList([{ sku: 'cv1659-001', sizes: ['41 1/3'] }]);
  assert.deepEqual(parsed.entries.get('CV1659-001|41 1/3'), {
    sku: 'cv1659-001',
    size: '41 1/3',
    quantity: 1,
  });
});

test('parseList geeft recognized=false bij een onbekende vorm', () => {
  assert.equal(parseList({ status: 'ok' }).recognized, false);
  assert.equal(parseList(null).recognized, false);
  assert.equal(parseList('').recognized, false);
});

test('parseList begrijpt WTB Market\'s { ok, data } envelope', () => {
  const parsed = parseList({
    ok: true,
    data: [{ sku: 'CV1659-001', sizes: ['39', '40'] }],
    meta: {},
    error: null,
  });
  assert.equal(parsed.recognized, true);
  assert.ok(parsed.pairs.has('CV1659-001|39'));
  assert.ok(parsed.pairs.has('CV1659-001|40'));
});

test('parseList behandelt ok:false niet als een lege lijst', () => {
  // Anders zou een auth-fout eruitzien als "lijst is leeg" en zou prunen
  // de hele WTB-lijst wissen.
  const parsed = parseList({
    ok: false,
    data: null,
    meta: {},
    error: { code: 'NOT_FOUND', message: 'API credentials not found' },
  });
  assert.equal(parsed.recognized, false);
  assert.equal(parsed.pairs.size, 0);
});

test('parseList leest de echte WTB Market response (vastgelegd 2026-08-22)', () => {
  // Letterlijk gekopieerd uit een Render-run. sizes is een array van objecten
  // met size + quantity, niet een array van strings.
  const echt = {
    ok: true,
    data: [
      {
        sku: 'IF1787-100',
        slug: 'nike-p-6000-gold-womens',
        name: "Nike P-6000 Gold (Women's)",
        image: 'https://images.stockx.com/images/Nike-P-6000-Gold-Womens-Product.jpg',
        brand: 'nike',
        sizes: [{ size: '39', quantity: 1 }],
      },
    ],
    meta: {},
    error: null,
  };

  const parsed = parseList(echt);
  assert.equal(parsed.recognized, true);
  assert.deepEqual([...parsed.pairs], ['IF1787-100|39']);
  assert.deepEqual(parsed.entries.get('IF1787-100|39'), {
    sku: 'IF1787-100',
    size: '39',
    quantity: 1,
  });
});

test('parseList pakt meerdere maten per SKU', () => {
  const parsed = parseList({
    ok: true,
    data: [{ sku: 'IF1787-100', sizes: [{ size: '39', quantity: 1 }, { size: '42.5', quantity: 2 }] }],
    meta: {},
    error: null,
  });
  assert.deepEqual([...parsed.pairs].sort(), ['IF1787-100|39', 'IF1787-100|42.5']);
});
