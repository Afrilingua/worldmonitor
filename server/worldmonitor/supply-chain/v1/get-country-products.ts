import type {
  ServerContext, GetCountryProductsRequest, GetCountryProductsResponse, CountryProduct,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { normalizeComtradeProducts } from '../../../../scripts/shared/comtrade-partners.mjs';
import { HS4_CODES, HS4_LABELS } from '../../../../scripts/shared/comtrade-bilateral.mjs';
import { isCallerPremium } from '../../../_shared/premium-check';
import { getCachedJson, readCachedJson } from '../../../_shared/redis';
import { lazyFetchBilateralHs4 } from './_bilateral-hs4-lazy';

export interface BilateralHs4Payload {
  iso2: string;
  products: CountryProduct[];
  fetchedAt?: string;
  source?: string;
  requestedHs4s?: string[];
}

export async function getCountryProducts(
  ctx: ServerContext,
  req: GetCountryProductsRequest,
): Promise<GetCountryProductsResponse> {
  const iso2 = (req.iso2 ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(iso2)) {
    throw new ValidationError([{ field: 'iso2', description: 'iso2 must be a 2-letter uppercase ISO country code' }]);
  }
  const hs4 = req.hs4?.trim();
  if (hs4 && !HS4_CODES.includes(hs4)) {
    throw new ValidationError([{ field: 'hs4', description: 'hs4 must be a supported four-digit heading' }]);
  }
  const isPro = await isCallerPremium(ctx.request);
  const empty: GetCountryProductsResponse = { iso2, products: [], fetchedAt: '' };
  if (!isPro) return empty;

  const key = `comtrade:bilateral-hs4:${iso2}:v1`;
  const [cached, meta] = await Promise.all([
    readCachedJson(key, true),
    getCachedJson('seed-meta:comtrade:bilateral-hs4', true).catch(() => null) as Promise<{
      countryCoverage?: Record<string, { state?: string; attemptedAt?: string }>;
      preserveStreaks?: Record<string, number>;
    } | null>,
  ]);
  let cacheFailed = cached.status === 'error';
  let payload = (cached.status === 'hit' ? cached.value : null) as BilateralHs4Payload | null;
  let attempt = meta?.countryCoverage?.[iso2];
  if (payload && (!Array.isArray(payload.products) || payload.iso2 !== iso2
    || payload.products.some(p => !p || typeof p.hs4 !== 'string' || !Array.isArray(p.topExporters) || p.topExporters.some(e => !e || typeof e.partnerCode !== 'number')))) {
    cacheFailed = true;
    payload = null;
  }
  const age = Date.now() - Date.parse(payload?.fetchedAt ?? '');
  const stale = !Number.isFinite(age) || age < 0 || age > 35 * 86400_000;
  const missingRequested = hs4 && !payload?.products.some(p => p.hs4 === hs4) && !payload?.requestedHs4s?.includes(hs4);
  // Cache read failure is not a cache miss. Do not overwrite unseen last-good data.
  if (!cacheFailed && (!payload || stale || missingRequested)) {
    const recovered = await lazyFetchBilateralHs4(iso2, payload ?? undefined);
    attempt = { state: recovered?.state ?? 'busy', attemptedAt: recovered?.attemptedAt ?? '' };
    if (recovered?.payload) payload = recovered.payload;
  }
  const products = normalizeComtradeProducts(payload?.products ?? []).map((p: CountryProduct) => ({ ...p, description: HS4_LABELS[p.hs4] ?? p.description }));
  const fetchedAt = payload?.fetchedAt ?? '';
  const finalAge = Date.now() - Date.parse(fetchedAt);
  const missingHs4s = HS4_CODES.filter(code => !products.some((p: CountryProduct) => p.hs4 === code));
  const old = !Number.isFinite(finalAge) || finalAge < 0 || finalAge > 35 * 86400_000;
  let state = 'observed';
  if (cacheFailed) state = 'cache_unavailable';
  else if (!payload) state = attempt?.state ?? 'missing';
  else if (old) state = 'stale_preserved';
  else if (missingHs4s.length) state = 'partial';
  return {
    iso2, products, fetchedAt,
    evidence: {
      state,
      source: payload?.source ?? 'UN Comtrade bilateral HS4 (legacy cache; retrieval method unknown)',
      requestedHs4s: attempt?.state === 'no_records' ? HS4_CODES : payload?.requestedHs4s ?? [], missingHs4s,
      lastAttemptAt: attempt?.attemptedAt ?? '',
      lastAttemptState: attempt?.state ?? (meta?.preserveStreaks?.[iso2] ? 'preserved_reason_unknown' : 'unknown'),
    },
  };
}
