const AIRTABLE_API = 'https://api.airtable.com/v0';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Haalt alle records op die aan de filterformule voldoen (met paginatie).
 */
export async function listRecords({
  token,
  baseId,
  table,
  filterByFormula,
  fields = [],
  sort = [],
  maxRecords = null,
  pageSize = 100,
}) {
  const all = [];
  let offset;

  do {
    const url = new URL(`${AIRTABLE_API}/${baseId}/${encodeURIComponent(table)}`);
    url.searchParams.set('pageSize', String(pageSize));
    if (filterByFormula) url.searchParams.set('filterByFormula', filterByFormula);
    if (offset) url.searchParams.set('offset', offset);
    for (const f of fields) url.searchParams.append('fields[]', f);
    sort.forEach((s, i) => {
      url.searchParams.set(`sort[${i}][field]`, s.field);
      url.searchParams.set(`sort[${i}][direction]`, s.direction || 'asc');
    });

    const page = await fetchWithRetry(url, token);
    all.push(...(page.records || []));
    offset = page.offset;

    if (maxRecords && all.length >= maxRecords) return all.slice(0, maxRecords);
  } while (offset);

  return all;
}

async function fetchWithRetry(url, token, attempt = 0) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 429 && attempt < 5) {
    await sleep(1000 * (attempt + 1));
    return fetchWithRetry(url, token, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Airtable ${res.status} ${res.statusText}: ${body.slice(0, 400)}`);
  }

  return res.json();
}
