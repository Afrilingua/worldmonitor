import { HS4_CODES, HS4_BATCHES, parseRecords, groupByProduct } from '../../../../scripts/shared/comtrade';
/**
 * Lazy-fetch fallback for the bilateral-hs4 store.
 *
 * When `comtrade:bilateral-hs4:{iso2}:v1` is missing in Redis, this module
 * fetches the same Comtrade endpoint that `seed-comtrade-bilateral-hs4.mjs`
 * uses, writes the result to Redis with a 40-day TTL, and returns the
 * products for immediate use by `get-route-impact`.
 *
 * Constraints:
 *   - Concurrency cap: 1 fetch at a time (Comtrade public rate ~1 req/sec)
 *   - Timeout: 5s shared across both provider batches
 *   - Cache both success (40d) and known-empty (24h)
 *   - On 429: return the rate-limited state and cache it for 24h
 */

import type { BilateralHs4Payload } from './get-country-products';
import { readCachedJson, setCachedJson, setCachedJsonIfAbsent } from '../../../_shared/redis';
import UN_TO_ISO2 from '../../../../scripts/shared/un-to-iso2.json';
import COMTRADE_REPORTER_OVERRIDES from '../../../../scripts/shared/comtrade-reporter-overrides.json';

import { recentPeriod } from '../../../../scripts/shared/comtrade-period.mjs';

const COMTRADE_BASE = 'https://comtradeapi.un.org/public/v1/preview/C/A/HS';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const KEY_PREFIX = 'comtrade:bilateral-hs4:';
const LAZY_SENTINEL_PREFIX = 'comtrade:bilateral-hs4-lazy-sentinel:';
const SUCCESS_TTL = 3456000; // 40 days
const EMPTY_TTL = 86400; // 24h
const FETCH_TIMEOUT_MS = 5000;


// Unlike scripts/seed-comtrade-bilateral-hs4.mjs, this path does NOT fall back
// to (y-3) when (y-2) is empty: this runs synchronously inside a live request
// (get-route-impact) under the FETCH_TIMEOUT_MS budget above, and a second
// sequential round trip would risk doubling response latency for every miss.
// The 24h EMPTY_TTL sentinel below already bounds the staleness from a
// reporter that has not yet filed (y-2) — far tighter than the bulk seeder's
// 40-day cache, which is why that path carries the fallback instead.

// UN M49 mostly matches UN Comtrade reporterCodes, except the shared override
// list. Using M49 codes for those reporters silently yields count:0.
const ISO2_TO_UN: Record<string, string> = Object.fromEntries(
  Object.entries(UN_TO_ISO2 as Record<string, string>).map(([un, iso]) => [iso, un]),
);
for (const [iso2, code] of Object.entries(COMTRADE_REPORTER_OVERRIDES as Record<string, string>)) {
  ISO2_TO_UN[iso2] = code;
}

let fetchInFlight = false;

interface ProductExporter {
  partnerCode: number;
  partnerIso2: string;
  value: number;
  share: number;
}

interface CountryProduct {
  hs4: string;
  description: string;
  totalValue: number;
  topExporters: ProductExporter[];
  year: number;
}

interface ComtradeResult {
  products: CountryProduct[];
  rateLimited: boolean;
  serverError: boolean;
}

export async function fetchComtradeBilateral(reporterCode: string): Promise<ComtradeResult> {
  const records = [];
  // Both batches share one request deadline. No partial result is published.
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  for (const [index, codes] of HS4_BATCHES.entries()) {
    if (index > 0) await new Promise(resolve => setTimeout(resolve, 1100));
    const url = new URL(COMTRADE_BASE);
    url.searchParams.set('reporterCode', reporterCode);
    url.searchParams.set('cmdCode', codes.join(','));
    url.searchParams.set('flowCode', 'M');
    url.searchParams.set('period', recentPeriod());
    url.searchParams.set('maxRecords', '500');
    const resp = await fetch(url.toString(), {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' }, signal,
    });
    if (resp.status === 429) return { products: [], rateLimited: true, serverError: false };
    if (!resp.ok) return { products: [], rateLimited: false, serverError: true };
    records.push(...parseRecords(await resp.json(), 500));
  }
  return { products: groupByProduct(records), rateLimited: false, serverError: false };
}

export interface LazyFetchResult {
  products: CountryProduct[];
  comtradeSource: 'bilateral-hs4' | 'lazy' | 'empty';
  rateLimited?: boolean;
  state?: string;
  attemptedAt?: string;
  payload?: BilateralHs4Payload;
}

/**
 * Attempt a lazy fetch for a destination country's bilateral HS4 data.
 * Returns null only for truly transient states (concurrent fetch in-flight).
 * When a sentinel exists, returns the sentinel's encoded reason so callers
 * can distinguish permanent empties from transient rate-limits.
 */
export async function lazyFetchBilateralHs4(iso2: string, previous?: BilateralHs4Payload): Promise<LazyFetchResult | null> {
  const sentinelKey = `${LAZY_SENTINEL_PREFIX}${iso2}:v1`;
  const cached = await readCachedJson(sentinelKey, true);
  if (cached.status === 'error') return { products: [], comtradeSource: 'lazy', state: 'cache_unavailable' };
  const sentinel = (cached.status === 'hit' ? cached.value : null) as { empty?: boolean; rateLimited?: boolean; state?: string; attemptedAt?: string; payload?: BilateralHs4Payload } | null;
  if (sentinel?.state === 'observed') {
    const recovered = sentinel.payload;
    if (recovered?.iso2 === iso2 && Array.isArray(recovered.products)
      && (!previous || Date.parse(recovered.fetchedAt ?? '') >= Date.parse(previous.fetchedAt ?? '')
        && previous.products.every(old => recovered.products.some(p => p.hs4 === old.hs4 && p.year >= old.year)))) {
      return { products: recovered.products, comtradeSource: 'bilateral-hs4', state: 'observed', attemptedAt: sentinel.attemptedAt, payload: recovered };
    }
  } else if (sentinel) {
    if (sentinel.state) return { products: [], comtradeSource: 'lazy', state: sentinel.state, attemptedAt: sentinel.attemptedAt };
    if (sentinel.rateLimited) {
      return { products: [], comtradeSource: 'lazy', rateLimited: true, state: 'rate_limited', attemptedAt: sentinel.attemptedAt };
    }
    return { products: [], comtradeSource: 'empty', state: 'legacy_no_records' };
  }

  if (fetchInFlight) return null;
  fetchInFlight = true;

  const unCode = ISO2_TO_UN[iso2];
  if (!unCode) {
    fetchInFlight = false;
    await setCachedJson(sentinelKey, { state: 'unsupported_reporter' }, EMPTY_TTL, true);
    return { products: [], comtradeSource: 'empty', state: 'unsupported_reporter' };
  }

  const attemptedAt = new Date().toISOString();
  try {
    const result = await fetchComtradeBilateral(unCode);

    if (result.rateLimited) {
      await setCachedJson(sentinelKey, { rateLimited: true, attemptedAt }, EMPTY_TTL, true);
      return { products: [], comtradeSource: 'empty', rateLimited: true, state: 'rate_limited', attemptedAt };
    }

    // Transient server error (500/503): don't write a 24h sentinel, just return
    // empty so the next request retries instead of being suppressed for a day
    if (result.serverError) {
      return { products: [], comtradeSource: 'lazy', state: 'unavailable', attemptedAt };
    }

    if (result.products.length === 0) {
      await setCachedJson(sentinelKey, { state: 'no_records', attemptedAt }, EMPTY_TTL, true);
      return { products: [], comtradeSource: 'empty', state: 'no_records', attemptedAt };
    }

    const cacheKey = `${KEY_PREFIX}${iso2}:v1`;
    if (previous?.products.some(old => !result.products.some(p => p.hs4 === old.hs4 && p.year >= old.year))) {
      await setCachedJson(sentinelKey, { state: 'incomplete_refresh', attemptedAt }, EMPTY_TTL, true);
      return { products: [], comtradeSource: 'lazy', state: 'incomplete_refresh', attemptedAt };
    }
    const payload = { iso2, products: result.products, fetchedAt: attemptedAt, source: 'UN Comtrade public preview', requestedHs4s: HS4_CODES };
    // A scheduled write may have advanced the canonical key during this fetch.
    // Keep warm recovery separate; cold publication uses NX instead of replacing it.
    const written = previous
      ? await setCachedJson(sentinelKey, { state: 'observed', attemptedAt, payload }, EMPTY_TTL, true)
      : await setCachedJsonIfAbsent(cacheKey, payload, SUCCESS_TTL, true);
    if (!written) return { products: result.products, comtradeSource: 'lazy', state: 'cache_write_failed', attemptedAt };
    return { products: result.products, comtradeSource: 'bilateral-hs4', state: 'observed', attemptedAt, payload };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Incomplete')) {
      await setCachedJson(sentinelKey, { state: 'incomplete_refresh', attemptedAt }, EMPTY_TTL, true);
      return { products: [], comtradeSource: 'lazy', state: 'incomplete_refresh', attemptedAt };
    }
    const state = error instanceof Error && error.message.startsWith('Malformed') ? 'malformed' : 'unavailable';
    return { products: [], comtradeSource: 'lazy', state, attemptedAt };
  } finally {
    fetchInFlight = false;
  }
}
