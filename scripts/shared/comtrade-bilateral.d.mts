import type { ComtradePartner } from './comtrade-partners.mjs';
export interface ComtradeRecord { cmdCode: string; partnerCode: string; primaryValue: number; year: number }
export function createComtradeBilateralCatalogue(
 strategic: {products: {bilateralHs4Code?: string; bilateralLabel?: string; label: string}[]},
 commodities: {commodities: {hs4: string[]; basketLabel: string}[]},
 normalizeComtradePartner: (code: unknown) => ComtradePartner,
): {
 HS4_CODES: string[]; HS4_LABELS: Record<string, string>; MAX_HS4_CODES_PER_BATCH: number; HS4_BATCHES: string[][];
 parseRecords(data: unknown, maxRecords?: number): ComtradeRecord[];
 groupByProduct(records: ComtradeRecord[], fallbackYear?: number): {
  hs4: string; description: string; totalValue: number; year: number; denominatorBasis: string;
  topExporters: {partnerCode: number; partnerIso2: string; value: number; share: number}[];
 }[];
};
