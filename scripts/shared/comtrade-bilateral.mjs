import { recentPeriod } from './comtrade-period.mjs';

export function createComtradeBilateralCatalogue(strategic, commodities, normalizeComtradePartner) {
  const labels = new Map();
  for (const p of strategic.products) {
    if (p.bilateralHs4Code) labels.set(p.bilateralHs4Code, p.bilateralLabel ?? p.label);
  }
  for (const c of commodities.commodities) {
    for (const hs4 of c.hs4) labels.set(hs4, c.basketLabel);
  }
  const HS4_CODES = [...labels.keys()];
  const HS4_LABELS = Object.fromEntries(labels);
  const MAX_HS4_CODES_PER_BATCH = 20;
  const HS4_BATCHES = [HS4_CODES.slice(0, 20), HS4_CODES.slice(20)];
  if (HS4_CODES.length > MAX_HS4_CODES_PER_BATCH * 2) throw new Error('Bilateral catalogue exceeds the two-request budget');

  /**
   * @param {unknown} data
   * @returns {Array<{cmdCode: string, partnerCode: string, primaryValue: number, year: number}>}
   */
  function parseRecords(data, maxRecords = Infinity) {
    const records = /** @type {any} */ (data)?.data;
    if (!Array.isArray(records)) throw new Error('Malformed Comtrade data array');
    if (records.length >= maxRecords) throw new Error('Incomplete Comtrade response: record limit reached');
    return records.map(r => {
      const value = Number(r?.primaryValue);
      const year = Number(r?.period ?? r?.refYear);
      const partnerCode = String(r?.partnerCode ?? '');
      const cmdCode = String(r?.cmdCode ?? '');
      if (!r || r.primaryValue == null || !Number.isFinite(value) || value < 0
        || !/^\d{4}$/.test(cmdCode) || !/^\d{1,3}$/.test(partnerCode)
        || !Number.isInteger(year) || year < 1900 || year > 2100) {
        throw new Error('Malformed Comtrade trade row');
      }
      return { cmdCode, partnerCode, primaryValue: value, year };
    }).filter(r => r.primaryValue > 0);
  }

  /**
   * @param {Array<{cmdCode: string, partnerCode: string, primaryValue: number, year: number}>} records
   * @param {number} [fallbackYear] year to report when no record carries a usable period/refYear
   * @returns {Array<{hs4: string, description: string, totalValue: number, topExporters: Array<{partnerCode: number, partnerIso2: string, value: number, share: number}>, year: number}>}
   */
  function groupByProduct(records, fallbackYear = Number(recentPeriod())) {
    /** @type {Map<string, Map<string, {value: number, year: number}>>} */
    const byCode = new Map();
    for (const r of records) {
      if (!byCode.has(r.cmdCode)) byCode.set(r.cmdCode, new Map());
      const partners = byCode.get(r.cmdCode);
      const existing = partners.get(r.partnerCode);
      // Newest year first, then largest value within it. With a single-period
      // response every r.year is equal, so this reduces to the previous
      // largest-value behaviour.
      if (!existing || r.year > existing.year
        || (r.year === existing.year && r.primaryValue > existing.value)) {
        partners.set(r.partnerCode, { value: r.primaryValue, year: r.year });
      }
    }

    const products = [];
    for (const [hs4, partners] of byCode) {
      const ranked = [...partners.entries()]
        .sort((a, b) => b[1].value - a[1].value)
        .filter(([pc]) => pc !== '0' && pc !== '000');

      // Collapse the product to ONE year before aggregating. Newest-year-per-
      // partner is not enough on the multi-year window: a partner that traded in
      // an older window year but not the newest would otherwise be summed into
      // totalValue and ranked into topExporters, so a lapsed relationship could
      // hold most of the share of a snapshot labelled a year it did not trade in.
      // A late filer is unaffected — all its rows sit at the same older year.
      const years = ranked.map(([, v]) => v.year).filter(y => y > 0);
      // Math.max(...[]) is -Infinity, which is TRUTHY — so `latestYear || fallback`
      // would return -Infinity and serialize as null, never reaching the fallback.
      const latestYear = years.length > 0 ? Math.max(...years) : 0;
      const sorted = latestYear > 0
        ? ranked.filter(([, v]) => v.year === latestYear)
        : ranked;

      const observedValue = sorted.reduce((s, [, v]) => s + v.value, 0);
      const world = partners.get('0') ?? partners.get('000');
      const hasWorld = world?.year === latestYear && world.value > 0;
      if (hasWorld && observedValue > world.value * 1.001) {
        throw new Error('Incomplete Comtrade response: partner values exceed World total');
      }
      const totalValue = hasWorld ? world.value : observedValue;
      if (totalValue <= 0) continue;
      const top5 = sorted.slice(0, 5);
      products.push({
        hs4,
        description: HS4_LABELS[hs4] ?? hs4,
        totalValue,
        denominatorBasis: hasWorld ? 'reported_world' : 'observed_partners',
        topExporters: top5.map(([pc, v]) => ({
          partnerCode: Number(pc),
          partnerIso2: normalizeComtradePartner(pc).iso2,
          value: v.value,
          share: Math.round((v.value / totalValue) * 1000) / 1000,
        })),
        year: latestYear > 0 ? latestYear : fallbackYear,
      });
    }
    return products.sort((a, b) => b.totalValue - a.totalValue);
  }

  return { HS4_CODES, HS4_LABELS, MAX_HS4_CODES_PER_BATCH, HS4_BATCHES, parseRecords, groupByProduct };

}
