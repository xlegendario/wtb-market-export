import test from 'node:test';
import assert from 'node:assert/strict';
import { PROFILES, listProfiles } from '../src/profiles.js';

const rotating = PROFILES.rotating.formula;

test('rotating filtert op Outsource en sluit SneakerAsk uit', () => {
  assert.match(rotating, /\{Fulfillment Status\} = "Outsource"/);
  // Store Name is een lookup (array), dus ARRAYJOIN i.p.v. een kale !=.
  assert.match(rotating, /ARRAYJOIN\(\{Store Name\}\) != "SneakerAsk"/);
});

test('rotating gebruikt Created Time met de vensters 48 / 72 / 96', () => {
  assert.match(rotating, /DATETIME_DIFF\(NOW\(\), \{Created Time\}, 'hours'\) < 48/);
  assert.match(rotating, /DATETIME_DIFF\(NOW\(\), \{Created Time\}, 'hours'\) >= 72/);
  assert.match(rotating, /DATETIME_DIFF\(NOW\(\), \{Created Time\}, 'hours'\) < 96/);
});

test('rotating slaat records zonder SKU of maat over', () => {
  assert.match(rotating, /\{SKU\} != BLANK\(\)/);
  assert.match(rotating, /\{Size\} != BLANK\(\)/);
});

test('de vensters vormen een aaneengesloten aan/uit/aan-cyclus', () => {
  // Uit de formule terugleiden zodat een verkeerd gezette env-var opvalt:
  // een gat tussen A-eind en B-start hoort er te zijn (dat is de "uit"-dag).
  const [aEind] = rotating.match(/'hours'\) < (\d+)/).slice(1).map(Number);
  const [bStart] = rotating.match(/'hours'\) >= (\d+)/).slice(1).map(Number);
  const bEind = Number(rotating.match(/'hours'\) < (\d+)\n?\s*\)\s*\)$/)?.[1] ?? 96);

  assert.ok(aEind < bStart, 'venster A moet eindigen voordat B begint');
  assert.ok(bStart < bEind, 'venster B moet een positieve lengte hebben');
  assert.equal(bStart - aEind, 24, 'de pauze hoort 24 uur te zijn');
});

test('elk profiel heeft een omschrijving en een formule', () => {
  for (const p of listProfiles()) {
    assert.ok(p.description, `${p.name} mist een omschrijving`);
    assert.match(p.formula, /^AND\(/, `${p.name} heeft geen geldige formule`);
  }
});
