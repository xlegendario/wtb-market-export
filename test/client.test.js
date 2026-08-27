import test from 'node:test';
import assert from 'node:assert/strict';
import { WtbClient } from '../src/wtbClient.js';

/** Vangt de fetch-aanroepen op zodat we methode, pad en body kunnen controleren. */
function metStubFetch(antwoord, fn) {
  const echt = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: JSON.parse(init.body ?? 'null') });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(antwoord),
    };
  };
  return fn(calls).finally(() => {
    globalThis.fetch = echt;
  });
}

const client = () =>
  new WtbClient({
    baseUrl: 'https://api.wtbmarket.eu',
    apiKey: 'sleutel',
    apiKeyHeader: 'key',
    userId: '123',
    requestDelayMs: 0,
    maxRetries: 0,
    timeoutMs: 5000,
  });

test('deleteSku gebruikt DELETE, niet POST', async () => {
  // POST geeft "Cannot POST /user/list/manage/delete" (Express 404), ondanks
  // wat de docs van WTB Market beweren. Geverifieerd 2026-08-22.
  await metStubFetch({ ok: true, data: { message: 'item deleted' } }, async (calls) => {
    await client().deleteSku('IF1787-100');
    assert.equal(calls[0].method, 'DELETE');
    assert.equal(calls[0].url, 'https://api.wtbmarket.eu/user/list/manage/delete');
    assert.deepEqual(calls[0].body, { sku: 'IF1787-100' });
  });
});

test('deleteSku stuurt geen size mee', async () => {
  // Met size erbij antwoordt de API NOT_FOUND.
  await metStubFetch({ ok: true, data: {} }, async (calls) => {
    await client().deleteSku('IF1787-100');
    assert.equal('size' in calls[0].body, false);
  });
});

test('addSize post sku, size en method', async () => {
  await metStubFetch({ ok: true, data: null }, async (calls) => {
    await client().addSize('IF1787-100', '39');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, 'https://api.wtbmarket.eu/user/list/manage/add');
    assert.deepEqual(calls[0].body, { sku: 'IF1787-100', size: '39', method: 'add' });
  });
});

test('auth gaat mee als key- en user_id-header', async () => {
  await metStubFetch({ ok: true, data: [] }, async (calls) => {
    await client().getList();
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].headers.key, 'sleutel');
    assert.equal(calls[0].headers.user_id, '123');
  });
});

test('een 200 met ok:false telt als fout, niet als succes', async () => {
  await metStubFetch(
    { ok: false, data: null, error: { code: 'NOT_FOUND', message: 'item not found' } },
    async () => {
      await assert.rejects(() => client().deleteSku('IF1787-100'), /NOT_FOUND: item not found/);
    }
  );
});

test('een 429 wordt herhaald en vertraagt de rest van de run', async () => {
  // 42 adds in ~11s leverde HTTP 429 op. Backoff van 2s was te kort.
  const echt = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: { get: () => '0' },
        text: async () => '{"status":429,"message":"Rate limit exceeded"}',
      };
    }
    return { ok: true, status: 200, statusText: 'OK', text: async () => '{"ok":true,"data":null}' };
  };

  const c = new WtbClient({
    baseUrl: 'https://api.wtbmarket.eu',
    apiKey: 'k',
    apiKeyHeader: 'key',
    userId: '1',
    requestDelayMs: 0,
    maxRequestDelayMs: 10000,
    rateLimitBackoffMs: 0,
    maxRetries: 2,
    timeoutMs: 5000,
  });

  try {
    await c.addSize('IF1787-100', '39');
    assert.equal(calls, 2, 'had opnieuw moeten proberen na de 429');
    assert.equal(c.rateLimitHits, 1);
    assert.ok(c.requestDelayMs > 0, 'de vertraging tussen requests hoort omhoog te gaan');
  } finally {
    globalThis.fetch = echt;
  }
});

test('NOT_FOUND krijgt een code mee zodat sync het apart kan afhandelen', async () => {
  const echt = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    statusText: 'Not Found',
    headers: { get: () => null },
    text: async () => '{"ok":false,"data":null,"error":{"code":"NOT_FOUND","message":"item not found"}}',
  });

  const c = new WtbClient({
    baseUrl: 'https://api.wtbmarket.eu',
    apiKey: 'k',
    apiKeyHeader: 'key',
    userId: '1',
    requestDelayMs: 0,
    maxRequestDelayMs: 10000,
    rateLimitBackoffMs: 0,
    maxRetries: 1,
    timeoutMs: 5000,
  });

  try {
    await assert.rejects(
      () => c.addSize('A05FW702-BLK', '43'),
      (err) => err.code === 'NOT_FOUND'
    );
  } finally {
    globalThis.fetch = echt;
  }
});
