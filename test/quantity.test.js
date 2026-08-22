import test from 'node:test';
import assert from 'node:assert/strict';
import { planChanges } from '../src/sync.js';
import { parseList } from '../src/wtbClient.js';

/** Bouwt de huidige WTB-lijst na: ['SKU', ['39', 2], ['40', 1]] */
const lijst = (...items) =>
  parseList({
    ok: true,
    data: items.map(([sku, ...sizes]) => ({
      sku,
      sizes: sizes.map(([size, quantity]) => ({ size, quantity })),
    })),
    meta: {},
    error: null,
  }).entries;

/** Bouwt het gewenste resultaat na: ['SKU', '39', 2] = 2 openstaande orders */
const wil = (...items) =>
  items.map(([sku, size, aantal]) => ({
    sku,
    size,
    orders: Array.from({ length: aantal }, (_, i) => `ORD-${i}`),
  }));

test('twee orders op dezelfde SKU+maat worden twee keer toegevoegd', () => {
  const { adds, rebuilds } = planChanges({
    desired: wil(['1202A056-109', '39', 2]),
    currentEntries: lijst(),
    prune: true,
  });
  assert.deepEqual(rebuilds, []);
  assert.equal(adds.length, 1);
  assert.equal(adds[0].times, 2);
});

test('staat er al 1 en wil je er 2, dan wordt er precies 1 bijgeteld', () => {
  const { adds, rebuilds } = planChanges({
    desired: wil(['1202A056-109', '39', 2]),
    currentEntries: lijst(['1202A056-109', ['39', 1]]),
    prune: true,
  });
  assert.deepEqual(rebuilds, []);
  assert.equal(adds[0].times, 1);
});

test('klopt het aantal al, dan gebeurt er niets', () => {
  const plan = planChanges({
    desired: wil(['1202A056-109', '39', 2]),
    currentEntries: lijst(['1202A056-109', ['39', 2]]),
    prune: true,
  });
  assert.deepEqual(plan.adds, []);
  assert.deepEqual(plan.rebuilds, []);
});

test('aantal omlaag kan alleen via een rebuild', () => {
  // Er is geen "verlaag met 1" in hun API, dus: SKU wissen en juist opbouwen.
  const { rebuilds, adds } = planChanges({
    desired: wil(['1202A056-109', '39', 1]),
    currentEntries: lijst(['1202A056-109', ['39', 3]]),
    prune: true,
  });
  assert.deepEqual(adds, []);
  assert.equal(rebuilds.length, 1);
  assert.deepEqual(rebuilds[0].removed, [{ size: '39', quantity: 3, wanted: 1 }]);
  assert.deepEqual(rebuilds[0].sizes, [
    { size: '39', quantity: 1, orders: ['ORD-0'] },
  ]);
});

test('rebuild zet de andere maten in hun eigen aantallen terug', () => {
  const { rebuilds } = planChanges({
    desired: wil(['JS1588', '40', 2], ['JS1588', '42', 1]),
    currentEntries: lijst(['JS1588', ['40', 2], ['42', 1], ['44', 1]]),
    prune: true,
  });
  assert.equal(rebuilds.length, 1);
  assert.deepEqual(rebuilds[0].removed, [{ size: '44', quantity: 1, wanted: 0 }]);
  assert.deepEqual(
    rebuilds[0].sizes.map((s) => [s.size, s.quantity]).sort(),
    [['40', 2], ['42', 1]]
  );
});

test('zonder prune wordt er alleen bijgeteld, nooit gewist', () => {
  const { rebuilds, adds } = planChanges({
    desired: wil(['JS1588', '40', 2]),
    currentEntries: lijst(['JS1588', ['40', 1], ['44', 5]]),
    prune: false,
  });
  assert.deepEqual(rebuilds, []);
  assert.equal(adds.length, 1);
  assert.equal(adds[0].size, '40');
  assert.equal(adds[0].times, 1);
});

test('een SKU die helemaal weg moet wordt gewist zonder iets terug te zetten', () => {
  const { rebuilds } = planChanges({
    desired: [],
    currentEntries: lijst(['IF1787-100', ['39', 2]]),
    prune: true,
  });
  assert.equal(rebuilds.length, 1);
  assert.deepEqual(rebuilds[0].sizes, []);
  assert.deepEqual(rebuilds[0].removed, [{ size: '39', quantity: 2, wanted: 0 }]);
});

test('alleen de afwijkende SKU wordt aangeraakt', () => {
  const { rebuilds, adds } = planChanges({
    desired: wil(['IF1787-100', '39', 1], ['JS1588', '40', 1]),
    currentEntries: lijst(['IF1787-100', ['39', 1]], ['JS1588', ['40', 2]]),
    prune: true,
  });
  assert.deepEqual(adds, []);
  assert.equal(rebuilds.length, 1);
  assert.equal(rebuilds[0].sku, 'JS1588');
});
