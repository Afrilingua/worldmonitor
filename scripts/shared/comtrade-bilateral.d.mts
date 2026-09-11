export const HS4_CODES: string[];
export const HS4_LABELS: Record<string, string>;
export const MAX_HS4_CODES_PER_BATCH: number;
export const HS4_BATCHES: string[][];
export interface ComtradeRecord { cmdCode: string; partnerCode: string; primaryValue: number; year: number }
export function parseRecords(data: unknown, maxRecords?: number): ComtradeRecord[];
export function groupByProduct(records: ComtradeRecord[], fallbackYear?: number): {
  hs4: string; description: string; totalValue: number; year: number; denominatorBasis: string;
  topExporters: { partnerCode: number; partnerIso2: string; value: number; share: number }[];
}[];
