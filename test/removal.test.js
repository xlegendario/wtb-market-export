import test from 'node:test';
import assert from 'node:assert/strict';
import { planRemovals } from '../src/sync.js';
import { parseList } from '../src/wtbClient.js';
import { pairKey } from '../src/size.js';

const lijst = (...items) =>
  parseList({
    ok: true,
    data: items.map(([sku, ...sizes]) => ({
      sku,
      sizes: sizes.map((size) => ({ size, quantity: 1 })),
    })),
    meta: {},
    error: null,
  });

const gewenst = (...paren) => new Set(paren.map(([sku, size]) => pairKey(sku, size)));

test('SKU waarvan alles weg moet: geen maten terugzetten', () => {
  const plans = planRemovals(lijst(['IF1787-100', '39', '40']).entries, gewenst());
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].remove.sort(), ['39', '40']);
  assert.deepEqual(plans[0].keep, []);
});

test('SKU waarvan één maat weg moet: de rest wordt teruggezet', () => {
  // Dit is de reden dat we niet zomaar /delete kunnen aanroepen en klaar zijn.
  const plans = planRemovals(
    lijst(['IF1787-100', '39', '40', '42']).entries,
    gewenst(['IF1787-100', '39'], ['IF1787-100', '42'])
  );
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].remove, ['40']);
  assert.deepEqual(plans[0].keep.sort(), ['39', '42']);
});

test('SKU die helemaal klopt wordt niet aangeraakt', () => {
  const plans = planRemovals(
    lijst(['IF1787-100', '39']).entries,
    gewenst(['IF1787-100', '39'])
  );
  assert.deepEqual(plans, []);
});

test('alleen de SKU met een afwijking wordt herbouwd', () => {
  const plans = planRemovals(
    lijst(['IF1787-100', '39'], ['CV1659-001', '42', '43']).entries,
    gewenst(['IF1787-100', '39'], ['CV1659-001', '42'])
  );
  assert.equal(plans.length, 1);
  assert.equal(plans[0].sku, 'CV1659-001');
  assert.deepEqual(plans[0].remove, ['43']);
  assert.deepEqual(plans[0].keep, ['42']);
});

test('SKU met een streepje raakt niet in de war bij het splitsen', () => {
  const plans = planRemovals(lijst(['DD1391-100', '42.5']).entries, gewenst());
  assert.equal(plans[0].sku, 'DD1391-100');
  assert.deepEqual(plans[0].remove, ['42.5']);
});
