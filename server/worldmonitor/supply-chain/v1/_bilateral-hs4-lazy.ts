import {
  HS4_CODES, HS4_BATCHES, PREVIEW_MAX_RECORDS, parseRecords, groupByProduct, comtradeFailureState,
} from '../../../../scripts/shared/comtrade';
/**
 * Lazy-fetch fallback for the bilateral-hs4 store.
 *
 * Callers: get-route-impact when `comtrade:bilateral-hs4:{iso2}:v1` is missing,
 * and get-country-products when the payload is missing, older than its
 * freshness window, or lacks a requested heading. Both request the same shared
 * catalogue as `seed-comtrade-bilateral-hs4.mjs`, from the public preview route.
 *
 * Writes:
 *   - Cold success (no previous payload): the canonical key via SET NX with a
 *     40-day TTL, so a scheduled write that lands mid-fetch is never replaced.
 *   - Warm success (a previous payload exists): the sentinel key only, as
 *     {state:'observed', payload} for 24h. The canonical key stays untouched.
 *   - Valid empty, unsupported reporter, 429, capped or regressed refresh: a
 *     24h sentinel.
 *   - Unavailable (HTTP error, timeout) or malformed: a short sentinel, so a
 *     failing provider is not re-requested on every read.
 *
 * Constraints:
 *   - Concurrency cap: 1 fetch at a time per instance (Comtrade public rate ~1 req/sec)
 *   - Timeout: 5s shared across both provider batches and the pause between them
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
const FAILURE_TTL = 600; // 10 min: bounds retries against a failing provider
const FETCH_TIMEOUT_MS = 5000;


// Unlike scripts/seed-comtrade-bilateral-hs4.mjs, this path does NOT fall back
// to (y-3) when (y-2) is empty: it runs inside a live request, and the two
// catalogue batches already share the whole FETCH_TIMEOUT_MS budget. The 24h
// no_records sentinel bounds the staleness from a reporter that has not yet
// filed (y-2) — far tighter than the bulk seeder's 40-day cache, which is why
// that path carries the fallback instead.

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
  failed: boolean;
}

export type LazyAttemptState =
  | 'observed' | 'no_records' | 'unsupported_reporter' | 'legacy_no_records' | 'rate_limited'
  | 'unavailable' | 'malformed' | 'incomplete' | 'regression_rejected'
  | 'cache_unavailable' | 'cache_write_failed';

// Read back as the same permanent `empty` source the first response returned.
const PERMANENT_EMPTY_STATES = new Set<string>(['no_records', 'unsupported_reporter']);

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
    url.searchParams.set('maxRecords', String(PREVIEW_MAX_RECORDS));
    const resp = await fetch(url.toString(), {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' }, signal,
    });
    if (resp.status === 429) return { products: [], rateLimited: true, failed: false };
    // Any other non-OK status is a provider failure, never a valid empty result.
    if (!resp.ok) return { products: [], rateLimited: false, failed: true };
    records.push(...parseRecords(await resp.json(), PREVIEW_MAX_RECORDS));
  }
  return { products: groupByProduct(records), rateLimited: false, failed: false };
}

export interface LazyFetchResult {
  products: CountryProduct[];
  comtradeSource: 'bilateral-hs4' | 'lazy' | 'empty';
  rateLimited?: boolean;
  state?: LazyAttemptState;
  attemptedAt?: string;
  payload?: BilateralHs4Payload;
}

/**
 * Attempt a lazy fetch for a destination country's bilateral HS4 data.
 * Returns null only while another fetch is in flight on this instance.
 * A sentinel short-circuits the fetch: an `observed` sentinel returns its
 * recovered payload unless it is older than `previous` or drops a heading or
 * year that `previous` holds; any other sentinel returns its recorded state,
 * with no_records and unsupported_reporter reported as the permanent `empty`
 * source so callers can tell them from transient failures.
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
    if (sentinel.state) {
      return {
        products: [],
        comtradeSource: PERMANENT_EMPTY_STATES.has(sentinel.state) ? 'empty' : 'lazy',
        state: sentinel.state as LazyAttemptState,
        attemptedAt: sentinel.attemptedAt,
      };
    }
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

    // Provider failure: a short sentinel stops every read from re-requesting a
    // failing provider, without suppressing recovery for a day.
    if (result.failed) {
      await setCachedJson(sentinelKey, { state: 'unavailable', attemptedAt }, FAILURE_TTL, true);
      return { products: [], comtradeSource: 'lazy', state: 'unavailable', attemptedAt };
    }

    if (result.products.length === 0) {
      await setCachedJson(sentinelKey, { state: 'no_records', attemptedAt }, EMPTY_TTL, true);
      return { products: [], comtradeSource: 'empty', state: 'no_records', attemptedAt };
    }

    const cacheKey = `${KEY_PREFIX}${iso2}:v1`;
    // A refresh that drops a held heading or regresses its year is rejected;
    // the previous payload stays authoritative.
    if (previous?.products.some(old => !result.products.some(p => p.hs4 === old.hs4 && p.year >= old.year))) {
      await setCachedJson(sentinelKey, { state: 'regression_rejected', attemptedAt }, EMPTY_TTL, true);
      return { products: [], comtradeSource: 'lazy', state: 'regression_rejected', attemptedAt };
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
    const state = comtradeFailureState(error);
    // Capped or World-inconsistent data will not change within the day; a
    // malformed body, timeout or network failure may, so it is only briefly suppressed.
    await setCachedJson(sentinelKey, { state, attemptedAt }, state === 'incomplete' ? EMPTY_TTL : FAILURE_TTL, true);
    return { products: [], comtradeSource: 'lazy', state, attemptedAt };
  } finally {
    fetchInFlight = false;
  }
}
