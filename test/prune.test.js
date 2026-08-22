import test from 'node:test';
import assert from 'node:assert/strict';
import { parseList } from '../src/wtbClient.js';
import { pairKey } from '../src/size.js';

/** Bootst de diff-berekening uit sync.js na, zonder netwerk. */
function diff({ desiredPairs, listPayload, prune, allowEmptyPrune = false }) {
  const current = parseList(listPayload);
  const desiredKeys = new Set(desiredPairs.map(([sku, size]) => pairKey(sku, size)));

  const emptyPruneBlocked =
    prune && desiredKeys.size === 0 && current.pairs.size > 0 && !allowEmptyPrune;

  const toAdd = [...desiredKeys].filter((k) => !current.pairs.has(k));
  const toRemove =
    prune && current.recognized && !emptyPruneBlocked
      ? [...current.pairs].filter((k) => !desiredKeys.has(k))
      : [];

  return { toAdd, toRemove, emptyPruneBlocked };
}

const lijstMet = (...paren) => ({
  ok: true,
  data: paren.map(([sku, ...sizes]) => ({
    sku,
    sizes: sizes.map((size) => ({ size, quantity: 1 })),
  })),
  meta: {},
  error: null,
});

test('prune haalt weg wat niet meer gewenst is', () => {
  const r = diff({
    desiredPairs: [['IF1787-100', '39']],
    listPayload: lijstMet(['IF1787-100', '39', '40'], ['CV1659-001', '42']),
    prune: true,
  });
  assert.deepEqual(r.toAdd, []);
  assert.deepEqual(r.toRemove.sort(), ['CV1659-001|42', 'IF1787-100|40']);
});

test('zonder prune wordt er nooit iets verwijderd', () => {
  const r = diff({
    desiredPairs: [['IF1787-100', '39']],
    listPayload: lijstMet(['CV1659-001', '42']),
    prune: false,
  });
  assert.deepEqual(r.toAdd, ['IF1787-100|39']);
  assert.deepEqual(r.toRemove, []);
});

test('een leeg Airtable-resultaat wist niet de hele lijst', () => {
  // Het scenario dat pijn doet: kapotte formule of Airtable-storing.
  const r = diff({
    desiredPairs: [],
    listPayload: lijstMet(['IF1787-100', '39'], ['CV1659-001', '42']),
    prune: true,
  });
  assert.equal(r.emptyPruneBlocked, true);
  assert.deepEqual(r.toRemove, []);
});

test('leeg prunen mag wel met expliciete toestemming', () => {
  const r = diff({
    desiredPairs: [],
    listPayload: lijstMet(['IF1787-100', '39']),
    prune: true,
    allowEmptyPrune: true,
  });
  assert.deepEqual(r.toRemove, ['IF1787-100|39']);
});

test('een onherkenbare response blokkeert prunen', () => {
  const r = diff({
    desiredPairs: [['IF1787-100', '39']],
    listPayload: { ok: false, data: null, error: { code: 'NOT_FOUND' } },
    prune: true,
  });
  assert.deepEqual(r.toRemove, []);
  assert.deepEqual(r.toAdd, ['IF1787-100|39']);
});
