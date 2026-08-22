import { normalizeSku, skuKey, pairKey } from './size.js';

const ENDPOINTS = {
  add: '/user/list/manage/add',
  get: '/user/list/manage/get',
  delete: '/user/list/manage/delete',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WtbClient {
  constructor(cfg) {
    this.baseUrl = cfg.baseUrl;
    this.apiKey = cfg.apiKey;
    this.apiKeyHeader = cfg.apiKeyHeader;
    this.userId = cfg.userId;
    this.requestDelayMs = cfg.requestDelayMs;
    this.maxRetries = cfg.maxRetries;
    this.timeoutMs = cfg.timeoutMs;
    this.lastRequestAt = 0;
  }

  headers() {
    return {
      [this.apiKeyHeader]: this.apiKey,
      user_id: String(this.userId),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  async throttle() {
    const wait = this.requestDelayMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  async request(path, { method = 'GET', body } = {}) {
    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.throttle();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: this.headers(),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });

        const text = await res.text().catch(() => '');

        if (res.status === 429 || res.status >= 500) {
          lastError = new Error(`WTB ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
          await sleep(500 * 2 ** attempt);
          continue;
        }

        if (!res.ok) {
          // 4xx = onze fout, geen retry.
          throw new Error(`WTB ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
        }

        if (!text) return { ok: true, raw: '', json: null };
        try {
          return { ok: true, raw: text, json: JSON.parse(text) };
        } catch {
          return { ok: true, raw: text, json: null };
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          lastError = new Error(`WTB timeout na ${this.timeoutMs}ms op ${path}`);
          await sleep(500 * 2 ** attempt);
          continue;
        }
        if (String(err.message).startsWith('WTB 4')) throw err;
        lastError = err;
        await sleep(500 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError || new Error(`WTB request faalde: ${path}`);
  }

  /** Huidige store list ophalen. */
  async getList() {
    return this.request(ENDPOINTS.get, { method: 'GET' });
  }

  /** Eén maat van een SKU toevoegen. */
  async addSize(sku, size) {
    return this.request(ENDPOINTS.add, {
      method: 'POST',
      body: { sku: normalizeSku(sku), size: String(size), method: 'add' },
    });
  }

  /** Eén maat van een SKU verwijderen (SKU blijft staan als er andere maten zijn). */
  async removeSize(sku, size) {
    return this.request(ENDPOINTS.add, {
      method: 'POST',
      body: { sku: normalizeSku(sku), size: String(size), method: 'delete' },
    });
  }

  /** Hele SKU (alle maten) van de lijst halen. */
  async deleteSku(sku) {
    return this.request(ENDPOINTS.delete, {
      method: 'POST',
      body: { sku: normalizeSku(sku) },
    });
  }
}

/**
 * De docs geven geen response-voorbeeld voor /get, dus we parsen tolerant.
 * Ondersteunde vormen:
 *   [{ sku, size }]
 *   [{ sku, sizes: [..] }]
 *   { list|data|items|result: <een van bovenstaande> }
 *   { "CV1659-001": ["39", "40"] }
 * Herkent de client de vorm niet, dan geeft hij `recognized: false` terug —
 * de sync draait dan add-only en pruned niet, zodat we niets slopen.
 *
 * `entries` bewaart per sleutel de originele sku/size zoals WTB Market ze
 * teruggeeft, zodat we bij verwijderen exact diezelfde waarden terugsturen.
 */
export function parseList(payload) {
  const pairs = new Set();
  const skus = new Set();
  const entries = new Map();

  const add = (sku, size) => {
    const key = pairKey(sku, size);
    pairs.add(key);
    if (!entries.has(key)) entries.set(key, { sku: normalizeSku(sku), size: String(size).trim() });
  };

  const root = unwrap(payload);
  if (root == null) return { recognized: false, pairs, skus, entries };

  if (Array.isArray(root)) {
    let recognized = root.length === 0;
    for (const entry of root) {
      if (!entry || typeof entry !== 'object') continue;
      const sku = normalizeSku(entry.sku ?? entry.SKU ?? entry.styleId ?? entry.style_id);
      if (!sku) continue;
      recognized = true;
      skus.add(skuKey(sku));
      for (const size of collectSizes(entry)) add(sku, size);
    }
    return { recognized, pairs, skus, entries };
  }

  if (typeof root === 'object') {
    let recognized = false;
    for (const [key, value] of Object.entries(root)) {
      const sku = normalizeSku(key);
      if (!sku || !Array.isArray(value)) continue;
      recognized = true;
      skus.add(skuKey(sku));
      for (const size of value) add(sku, normalizeListSize(size));
    }
    return { recognized, pairs, skus, entries };
  }

  return { recognized: false, pairs, skus, entries };
}

function unwrap(payload) {
  if (payload == null) return null;
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== 'object') return null;
  for (const key of ['list', 'data', 'items', 'result', 'results', 'products']) {
    if (payload[key] != null) return payload[key];
  }
  return payload;
}

function collectSizes(entry) {
  const raw = entry.sizes ?? entry.size ?? entry.Size ?? entry.Sizes;
  if (raw == null) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map(normalizeListSize).filter(Boolean);
}

function normalizeListSize(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    return String(value.size ?? value.name ?? value.value ?? '').trim();
  }
  return String(value).trim();
}
