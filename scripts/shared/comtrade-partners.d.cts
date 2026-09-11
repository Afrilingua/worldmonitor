export interface ComtradePartner { iso2: string; kind: string; label: string; note: string }
export function normalizeComtradePartner(code: unknown): ComtradePartner;
export function normalizeComtradeProducts<T extends { topExporters: { partnerCode: number; partnerIso2: string }[] }>(products: T[]): T[];
