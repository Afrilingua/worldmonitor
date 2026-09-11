import type {
  ServerContext, GetCountryProductsRequest, GetCountryProductsResponse, CountryProduct,
  ProductExporter, ExporterScale,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { normalizeComtradeProducts, HS4_CODES, HS4_LABELS } from '../../../../scripts/shared/comtrade';
import { isCallerPremium } from '../../../_shared/premium-check';
import { getCachedJson, readCachedJson } from '../../../_shared/redis';
import { lazyFetchBilateralHs4, lazyFetchHeading } from './_bilateral-hs4-lazy';
import type { PartnerRow, PartnersProduct } from './_bilateral-hs4-lazy';

export interface BilateralHs4Payload {
  iso2: string;
  products: CountryProduct[];
  fetchedAt?: string;
  source?: string;
  requestedHs4s?: string[];
}

/** Sibling detail key (KTD1): the threshold origins the canonical key omits. */
interface BilateralHs4PartnersPayload {
  iso2: string;
  products: PartnersProduct[];
  fetchedAt?: string;
}

/**
 * One world-exports snapshot: every reporter's exports of each heading. The
 * producer writes `reporterCode` as a number, the same space as a canonical
 * row's `partnerCode`, which is what the join is keyed on.
 */
interface WorldExportsPayload {
  fetchedAt?: string;
  headings?: Record<string, { year?: number; exporters?: Array<{ reporterCode?: number; valueUsd?: number; netWeightKg?: number | null }> }>;
}

const PARTNERS_KEY = (iso2: string): string => `comtrade:bilateral-hs4-partners:${iso2}:v1`;
const WORLD_EXPORTS_KEY = 'comtrade:world-exports-hs4:v1';

// Matches the bulk seeder's 35-day health staleness window.
const MAX_PAYLOAD_AGE_MS = 35 * 86_400_000;
const isStale = (fetchedAt?: string): boolean => {
  const age = Date.now() - Date.parse(fetchedAt ?? '');
  return !Number.isFinite(age) || age < 0 || age > MAX_PAYLOAD_AGE_MS;
};

/**
 * Drop null and undefined entries. Every new field is proto3 `optional`, and an
 * unreported weight must be absent rather than 0 — "not reported" and "ships
 * nothing" are different claims and the brief renders them differently (KTD4).
 */
function defined<T extends object>(row: T): T {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value != null)) as T;
}

const toExporter = (partner: PartnerRow): ProductExporter => defined({
  partnerCode: partner.partnerCode,
  partnerIso2: partner.partnerIso2,
  value: partner.value,
  share: partner.share,
  netWeightKg: partner.netWeightKg ?? undefined,
  // Only meaningful next to a weight: "estimated: false" with no weight would
  // read as a confirmed zero.
  netWeightEstimated: partner.netWeightKg != null ? partner.netWeightEstimated === true : undefined,
  quantity: partner.quantity ?? undefined,
  quantityUnitCode: partner.quantityUnitCode ?? undefined,
}) as ProductExporter;

/** A sibling-shaped heading as a response row: threshold origins with volume. */
const fromPartnersProduct = (product: PartnersProduct): CountryProduct => defined({
  hs4: product.hs4,
  description: HS4_LABELS[product.hs4] ?? product.hs4,
  totalValue: product.totalValue,
  topExporters: product.partners.map(toExporter),
  year: product.year,
  denominatorBasis: product.denominatorBasis,
  partnerBasis: 'share_threshold',
  omittedPartnerCount: product.omittedCount,
  omittedPartnerShare: product.omittedShare,
}) as CountryProduct;

/**
 * Threshold partner rows by heading. An unreadable or malformed sibling key is
 * treated as absent, never as a cache failure: it is supplementary evidence, so
 * losing it degrades the row to the canonical leading 5 rather than blanking
 * the response the canonical key can still answer.
 */
function readSiblingProducts(read: { status: string; value?: unknown }, iso2: string): Map<string, PartnersProduct> {
  const rows = new Map<string, PartnersProduct>();
  const payload = (read.status === 'hit' ? read.value : null) as BilateralHs4PartnersPayload | null;
  if (!payload || payload.iso2 !== iso2 || !Array.isArray(payload.products)) return rows;
  for (const product of payload.products) {
    if (product && typeof product.hs4 === 'string' && Array.isArray(product.partners)
      && product.partners.every(p => p && typeof p.partnerCode === 'number')) {
      rows.set(product.hs4, product);
    }
  }
  return rows;
}

/**
 * World-export scale per heading, keyed by exporter code. The producer already
 * ranked `exporters` by value, so rank is the position in that list.
 *
 * A heading whose year is unusable is skipped: a supplier's world exports can
 * only be read against an import share of the same observation year, and a
 * scale labelled with a fabricated year would invite exactly that comparison.
 */
function readWorldExports(value: unknown): { fetchedAt?: string; byHeading: Map<string, Map<number, ExporterScale>> } {
  const payload = (value ?? null) as WorldExportsPayload | null;
  const byHeading = new Map<string, Map<number, ExporterScale>>();
  for (const [hs4, heading] of Object.entries(payload?.headings ?? {})) {
    const year = Number(heading?.year);
    if (!Array.isArray(heading?.exporters) || !Number.isInteger(year)) continue;
    const byCode = new Map<number, ExporterScale>();
    heading.exporters.forEach((exporter, index) => {
      const code = Number(exporter?.reporterCode);
      const worldExportsUsd = Number(exporter?.valueUsd);
      if (!Number.isFinite(code) || !Number.isFinite(worldExportsUsd)) return;
      const worldExportsKg = Number(exporter?.netWeightKg);
      byCode.set(code, defined({
        worldExportsUsd,
        worldExportsKg: Number.isFinite(worldExportsKg) && worldExportsKg > 0 ? worldExportsKg : undefined,
        rank: index + 1,
        year,
      }) as ExporterScale);
    });
    byHeading.set(hs4, byCode);
  }
  return { fetchedAt: typeof payload?.fetchedAt === 'string' ? payload.fetchedAt : undefined, byHeading };
}

/**
 * One response row. The sibling's threshold origins replace the canonical
 * leading 5 only when they describe the same or a later observation year — an
 * older sibling would relabel the row with a year it no longer holds. When the
 * sibling wins, its own year, denominator and total travel with it, so the
 * shares and the denominator they were computed against always agree.
 */
function mergeProduct(canonical: CountryProduct, sibling?: PartnersProduct): CountryProduct {
  if (!sibling || !(Number(sibling.year) >= Number(canonical.year))) {
    return { ...canonical, partnerBasis: 'leading_5' };
  }
  return { ...fromPartnersProduct(sibling), description: canonical.description };
}

/** Supplier scale for each shown origin; an origin the snapshot omits gets none. */
function attachScale(product: CountryProduct, byCode?: Map<number, ExporterScale>): CountryProduct {
  if (!byCode?.size) return product;
  return {
    ...product,
    topExporters: product.topExporters.map(exporter => {
      const scale = byCode.get(exporter.partnerCode);
      return scale ? { ...exporter, scale } : exporter;
    }),
  };
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
  // Status-aware reads for the two country keys so a read error stays
  // distinguishable from a miss; the canonical one decides cache_unavailable,
  // the sibling one only decides how deep the origins go.
  const [cached, siblingRead, worldExportsValue, meta] = await Promise.all([
    readCachedJson(key, true),
    readCachedJson(PARTNERS_KEY(iso2), true),
    getCachedJson(WORLD_EXPORTS_KEY, true).catch(() => null),
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
  // "No product row for this heading" — the producing request's requestedHs4s
  // says the heading was asked for, not that an answer came back.
  const missingRequested = Boolean(hs4) && !payload?.products.some(p => p.hs4 === hs4);
  let recovered: PartnersProduct | undefined;
  let recoveredFetchedAt: string | undefined;
  let headingAttempted = false;

  // Cache read failure is not a cache miss. Do not overwrite unseen last-good data.
  if (!cacheFailed && (!payload || isStale(payload.fetchedAt))) {
    // Nothing stored, or the whole payload is past its freshness window: the
    // full catalogue is refetched, exactly as get-route-impact does.
    const refreshed = await lazyFetchBilateralHs4(iso2, payload ?? undefined);
    attempt = { state: refreshed?.state ?? 'busy', attemptedAt: refreshed?.attemptedAt ?? '' };
    if (refreshed?.payload) payload = refreshed.payload;
  } else if (!cacheFailed && missingRequested) {
    // A fresh payload that simply lacks this one heading. Refetching the
    // catalogue would republish 35 headings we already hold and would fill the
    // preview route's row cap for a large importer, so only the requested
    // heading is fetched, against its own sentinel (KTD5). One recovery attempt
    // per request keeps the upstream cost bounded at one heading.
    headingAttempted = true;
    const heading = await lazyFetchHeading(iso2, hs4!);
    attempt = { state: heading?.state ?? 'busy', attemptedAt: heading?.attemptedAt ?? '' };
    recovered = heading?.product;
    recoveredFetchedAt = heading?.fetchedAt;
  }

  const sibling = readSiblingProducts(siblingRead, iso2);
  const { fetchedAt: worldExportsFetchedAt, byHeading } = readWorldExports(worldExportsValue);
  const merged = (payload?.products ?? []).map(product => mergeProduct(product, sibling.get(product.hs4)));
  if (recovered) {
    // Appended rather than re-ranked: the stored order is the producing run's
    // ranking, and this heading was never part of it. Its own fetch time rides
    // along, because it is not the payload's.
    merged.push(defined({ ...fromPartnersProduct(recovered), fetchedAt: recoveredFetchedAt }));
  }
  const products = normalizeComtradeProducts(merged).map((p: CountryProduct) => attachScale(
    { ...p, description: HS4_LABELS[p.hs4] ?? p.description },
    byHeading.get(p.hs4),
  ));

  const fetchedAt = payload?.fetchedAt ?? '';
  const missingHs4s = HS4_CODES.filter(code => !products.some((p: CountryProduct) => p.hs4 === code));
  let state = 'observed';
  if (cacheFailed) state = 'cache_unavailable';
  else if (!payload) state = attempt?.state ?? 'missing';
  else if (isStale(fetchedAt)) state = 'stale_preserved';
  else if (missingHs4s.length) state = 'partial';
  return {
    iso2, products, fetchedAt,
    evidence: defined({
      state,
      source: payload?.source ?? 'UN Comtrade bilateral HS4 (legacy cache; retrieval method unknown)',
      // A single-heading attempt requested exactly that heading, so an empty
      // result reads as "requested and empty" rather than "coverage unverified".
      requestedHs4s: headingAttempted
        ? [...new Set([...(payload?.requestedHs4s ?? []), hs4!])]
        : attempt?.state === 'no_records' ? HS4_CODES : payload?.requestedHs4s ?? [],
      missingHs4s,
      lastAttemptAt: attempt?.attemptedAt ?? '',
      lastAttemptState: attempt?.state ?? (meta?.preserveStreaks?.[iso2] ? 'preserved_reason_unknown' : 'unknown'),
      recoveredHs4s: recovered ? [recovered.hs4] : [],
      worldExportsFetchedAt,
    }),
  };
}
