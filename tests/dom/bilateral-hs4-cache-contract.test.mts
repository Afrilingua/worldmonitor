// Cache contract for the bilateral HS4 lazy fetch and the country-products
// reader: what each outcome writes, what a second request reads back, and that
// warm recovery never replaces the canonical key. Redis is an in-memory stub
// so repeated requests see the state the first one left behind.

import { beforeEach, expect, it, vi } from 'vitest';

const redis = vi.hoisted(() => ({ store: new Map<string, unknown>(), ttl: new Map<string, number>(), errors: new Set<string>() }));
vi.mock('../../server/_shared/redis', () => ({
  getCachedJson: async (key: string) => redis.store.get(key) ?? null,
  readCachedJson: async (key: string) => redis.errors.has(key) ? { status: 'error' }
    : redis.store.has(key) ? { status: 'hit', value: redis.store.get(key) } : { status: 'miss' },
  setCachedJsonIfAbsent: async (key: string, value: unknown, ttl: number) => {
    if (redis.store.has(key)) return false;
    redis.store.set(key, value); redis.ttl.set(key, ttl); return true;
  },
  setCachedJson: async (key: string, value: unknown, ttl: number) => { redis.store.set(key, value); redis.ttl.set(key, ttl); return true; },
}));
vi.mock('../../server/_shared/premium-check', () => ({ isCallerPremium: async () => true }));

import { lazyFetchBilateralHs4 } from '../../server/worldmonitor/supply-chain/v1/_bilateral-hs4-lazy';
import { getCountryProducts } from '../../server/worldmonitor/supply-chain/v1/get-country-products';
import { ValidationError } from '../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

const SENTINEL = (iso2: string) => `comtrade:bilateral-hs4-lazy-sentinel:${iso2}:v1`;
const CANONICAL = (iso2: string) => `comtrade:bilateral-hs4:${iso2}:v1`;
const DAY = 86_400;

let upstreamCalls = 0;
function upstream(respond: (url: URL) => Response | Promise<Response>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'comtradeapi.un.org') upstreamCalls++;
    return respond(url);
  });
}
const rows = (url: URL, data: Array<Record<string, unknown>>) =>
  Response.json({ data: data.filter(row => url.searchParams.get('cmdCode')!.split(',').includes(String(row.cmdCode))) });
const read = (ctx: { iso2: string; hs4?: string }) => getCountryProducts({ request: new Request('https://example.test') } as never, ctx);

beforeEach(() => {
  redis.store.clear(); redis.ttl.clear(); redis.errors.clear();
  upstreamCalls = 0;
});

for (const [iso2, state] of [['DE', 'no_records'], ['ZZ', 'unsupported_reporter']] as const) {
  it(`${state} stays a permanent empty when the sentinel is read back`, async () => {
    upstream(url => rows(url, []));
    const first = await lazyFetchBilateralHs4(iso2);
    const second = await lazyFetchBilateralHs4(iso2);
    expect(first).toMatchObject({ comtradeSource: 'empty', state });
    // Route impact caches 'empty' for 24h and renders "no strategic products";
    // 'lazy' would render "Loading trade data" until the sentinel expires.
    expect(second).toMatchObject({ comtradeSource: 'empty', state });
  });
}

for (const [label, respond, state] of [
  ['HTTP 503', () => new Response('down', { status: 503 }), 'unavailable'],
  ['HTTP 400', () => new Response('bad', { status: 400 }), 'unavailable'],
  ['a body without a data array', () => Response.json({ unexpected: true }), 'malformed'],
] as const) {
  it(`${label} is suppressed briefly instead of refetched on every request`, async () => {
    upstream(respond);
    const first = await lazyFetchBilateralHs4('DE');
    const callsAfterFirst = upstreamCalls;
    const second = await lazyFetchBilateralHs4('DE');
    expect(first).toMatchObject({ comtradeSource: 'lazy', state });
    expect(second).toMatchObject({ comtradeSource: 'lazy', state });
    expect(upstreamCalls).toBe(callsAfterFirst);
    const ttl = redis.ttl.get(SENTINEL('DE'))!;
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThan(DAY);
    expect(redis.store.has(CANONICAL('DE'))).toBe(false);
  });
}

it('a response filling the requested cap is incomplete and publishes nothing', async () => {
  upstream(url => Response.json({ data: Array.from({ length: Number(url.searchParams.get('maxRecords')) }, (_, i) => (
    { cmdCode: url.searchParams.get('cmdCode')!.split(',')[0], partnerCode: 1 + (i % 890), primaryValue: 1, period: 2024 })) }));
  const result = await lazyFetchBilateralHs4('DE');
  expect(result).toMatchObject({ comtradeSource: 'lazy', state: 'incomplete' });
  expect(redis.store.has(CANONICAL('DE'))).toBe(false);
  expect((redis.store.get(SENTINEL('DE')) as { state: string }).state).toBe('incomplete');
});

it('a cold success publishes the canonical key with NX and reports observed', async () => {
  upstream(url => rows(url, [{ cmdCode: '2804', partnerCode: 842, primaryValue: 392, period: 2024 }]));
  const result = await lazyFetchBilateralHs4('JP');
  expect(result).toMatchObject({ comtradeSource: 'bilateral-hs4', state: 'observed' });
  expect(redis.ttl.get(CANONICAL('JP'))).toBe(40 * DAY);
  expect((redis.store.get(CANONICAL('JP')) as { products: Array<{ hs4: string }> }).products.map(p => p.hs4)).toEqual(['2804']);
});

it('a scheduled write that lands during a cold fetch is not overwritten', async () => {
  const scheduled = { iso2: 'JP', fetchedAt: new Date().toISOString(), products: [] };
  upstream(url => {
    redis.store.set(CANONICAL('JP'), scheduled);
    return rows(url, [{ cmdCode: '2804', partnerCode: 842, primaryValue: 392, period: 2024 }]);
  });
  const result = await lazyFetchBilateralHs4('JP');
  expect(result?.state).toBe('cache_write_failed');
  expect(redis.store.get(CANONICAL('JP'))).toBe(scheduled);
});

const previous = { iso2: 'DE', fetchedAt: '2026-07-27T16:47:53.750Z', products: [{ hs4: '1001', description: 'Wheat', year: 2023, totalValue: 100,
  topExporters: [{ partnerCode: 251, partnerIso2: '', value: 100, share: 1 }] }] };
for (const [label, recovered] of [
  ['an older year for a held heading', { ...previous, fetchedAt: '2026-08-01T00:00:00.000Z', products: [{ ...previous.products[0], year: 2022 }] }],
  ['an older fetch time', { ...previous, fetchedAt: '2026-07-01T00:00:00.000Z', products: [{ ...previous.products[0], year: 2024 }] }],
] as const) {
  it(`an observed sentinel with ${label} is rejected and refetched`, async () => {
    redis.store.set(SENTINEL('DE'), { state: 'observed', attemptedAt: recovered.fetchedAt, payload: recovered });
    upstream(url => rows(url, [{ cmdCode: '1001', partnerCode: 251, primaryValue: 100, period: 2024 }]));
    const result = await lazyFetchBilateralHs4('DE', previous);
    expect(upstreamCalls).toBeGreaterThan(0);
    expect(result?.payload).not.toBe(recovered);
    expect(result?.payload?.products[0]?.year).toBe(2024);
  });
}

it('a cache read error is reported and never triggers a provider fetch', async () => {
  redis.errors.add(CANONICAL('DE'));
  upstream(url => rows(url, []));
  const result = await read({ iso2: 'DE', hs4: '2804' });
  expect(result.evidence?.state).toBe('cache_unavailable');
  expect(upstreamCalls).toBe(0);
});

it('a cached payload for another country is treated as unreadable, not as data', async () => {
  redis.store.set(CANONICAL('DE'), { ...previous, iso2: 'FR', fetchedAt: new Date().toISOString() });
  upstream(url => rows(url, []));
  const result = await read({ iso2: 'DE', hs4: '2804' });
  expect(result.evidence?.state).toBe('cache_unavailable');
  expect(result.products).toEqual([]);
  expect(upstreamCalls).toBe(0);
});

it('an unsupported heading is rejected before any cache or provider access', async () => {
  upstream(url => rows(url, []));
  await expect(read({ iso2: 'DE', hs4: '9999' })).rejects.toBeInstanceOf(ValidationError);
  expect(upstreamCalls).toBe(0);
});
