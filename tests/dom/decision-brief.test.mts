import { initTestI18n } from './helpers/i18n.mts';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDecisionBriefOutput, renderDecisionBrief } from '@/components/CountryBriefOutput';
import { buildDecisionBrief, buildCommodityBrief } from '@/utils/decision-brief';
import type { DecisionBriefCapture, DecisionBriefSelection } from '@/types/decision-brief';

import { computeEnergyShockScenario } from '../../server/worldmonitor/intelligence/v1/compute-energy-shock';

const redis = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../server/_shared/redis', () => ({
  getCachedJson: async (key: string) => redis.get(key) ?? null,
  readCachedJson: async (key: string) => redis.has(key) ? {status:'hit',value:redis.get(key)} : {status:'miss'},
  setCachedJsonIfAbsent: async (key: string, value: unknown) => { if (redis.has(key)) return false; redis.set(key, value); return true; },
  setCachedJson: async (key: string, value: unknown) => { redis.set(key, value); return true; },
}));

beforeAll(initTestI18n);

const selection: DecisionBriefSelection = { countryCode: 'DE', countryName: 'Germany', chokepointId: 'hormuz_strait', fuelMode: 'gas', baselinePct: 50, comparisonPct: 100 };
function snapshot(missing = false) {
  const captures = [50, 100].map((disruptionPct, i) => ({ retrievedAt: '2026-09-10T10:00:00Z', response: {
    countryCode: 'DE', chokepointId: 'hormuz_strait', disruptionPct,
    gasSensitivity: missing ? undefined : { dataAvailable: true, lngImportsTj: 41318, totalDemandTj: 467224, lngDisruptionTj: [6197.7, 12395.4][i], deficitPct: [1.3, 2.7][i], modelBasis: 'assumed_route_sensitivity', dataMonth: '2026-05', dataSource: 'JODI' },
  } })) as [DecisionBriefCapture, DecisionBriefCapture];
  return buildDecisionBrief(selection, captures);
}
const click = (root: HTMLElement, text: string) => (Array.from(root.querySelectorAll('button')).find(b => b.textContent === text)!).click();
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it('keeps energy identity while invalid worksheet edits clear preview and exported operational results', async () => {
  const data = snapshot();
  const blobs: Blob[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:test'; });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const root = createDecisionBriefOutput({ code: 'DE', name: 'Germany' }, new AbortController().signal, async () => data, () => {});
  click(root, 'Capture / refresh both');
  await vi.waitFor(() => expect(root.querySelector('.cdp-decision-paper .operational-summary')!.textContent).toContain('Baseline first gap: Day 8'));
  const stock = root.querySelector<HTMLInputElement>('[aria-label="Starting usable stock"]')!;
  stock.value = ''; stock.dispatchEvent(new Event('input', { bubbles: true }));
  expect(root.querySelector('.cdp-decision-paper .operational-result')).toBeNull();
  expect(root.querySelector('.cdp-decision-paper')!.textContent).toContain('Operational worksheet incomplete or invalid');
  click(root, 'Download decision JSON');
  const exported = JSON.parse(await blobs[0]!.text());
  expect(exported.operationalWorksheet).toBeNull();
  const { operationalWorksheet, ...energy } = exported;
  expect(energy).toEqual(data);
  stock.value = '100'; stock.dispatchEvent(new Event('input', { bubbles: true }));
  expect(root.querySelector('.cdp-decision-paper .operational-summary')!.textContent).toContain('Baseline first gap: Day 8');
});


describe('decision brief preview and exports', () => {
  for (const missing of [false, true]) it(`renders exact snapshot and distinct action for missing=${missing}`, async () => {
    const data = snapshot(missing);
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:test'; });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const root = createDecisionBriefOutput({ code: 'DE', name: 'Germany' }, new AbortController().signal, async () => data, () => {});
    document.body.append(root);
    click(root, 'Capture / refresh both');
    await vi.waitFor(() => expect(root.querySelector('.cdp-decision-action')?.textContent).toBe(data.action.text));
    expect(root.textContent).toContain(data.action.constraint);
    expect(root.textContent).toContain(data.action.trigger);
    for (const ref of data.action.references) expect(root.textContent).toContain(ref);
    click(root, 'Download decision HTML'); click(root, 'Download decision JSON');
    const html = await blobs[0]!.text();
    const json = JSON.parse(await blobs[1]!.text());
    expect(json.operationalWorksheet.baseline.firstGapDay).toBe(8);
    const { operationalWorksheet: worksheet, ...energy } = json;
    expect(energy).toEqual(data);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(JSON.parse(doc.querySelector('#decision-brief-snapshot')!.textContent!)).toEqual(json);
    expect(doc.querySelector('.cdp-decision-action')!.textContent).toBe(data.action.text);
    expect(doc.body.textContent).toContain(data.action.constraint);
    expect(doc.body.textContent).toContain(data.action.trigger);
  });

  for (const missing of [true, false]) it(`exports real oil handler state with missing imports=${missing}`, async () => {
    redis.clear();
    redis.set('energy:chokepoint-flows:v1', { hormuz_strait: { flowRatio: 1 } });
    redis.set('energy:jodi-oil:v1:DE', { crude: { importsKbd: missing ? null : 100 }, diesel: { demandKbd: 80 } });
    redis.set('comtrade:flows:276:2709', [{ partnerCode: '000', tradeValueUsd: 100 }]);
    const oilSelection = { ...selection, fuelMode: 'oil' as const };
    const captures = await Promise.all([50, 100].map(async disruptionPct => ({
      retrievedAt: '2026-09-10T10:00:00Z',
      response: await computeEnergyShockScenario({} as never, { countryCode: 'DE', chokepointId: 'hormuz_strait', disruptionPct, fuelMode: 'oil' }),
    }))) as [DecisionBriefCapture, DecisionBriefCapture];
    const data = buildDecisionBrief(oilSelection, captures);
    expect(data.results.map(r => r.loss)).toEqual(missing ? [null, null] : [20, 40]);
    expect(data.evidence.find(e => e.id === 'baseline-route')!.value).toBeNull();
    expect(data.unknowns.join(' ')).toContain('fixed proxy');
    expect(data.action.text).toContain(missing ? 'Recover the oil import' : "Compare Germany's");
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:test'; });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const root = createDecisionBriefOutput({ code: 'DE', name: 'Germany' }, new AbortController().signal, async () => data, () => {});
    document.body.append(root);
    const fuel = root.querySelector('select')!;
    fuel.value = 'oil'; fuel.dispatchEvent(new Event('change'));
    click(root, 'Capture / refresh both');
    await vi.waitFor(() => expect(root.querySelector('.cdp-decision-action')?.textContent).toBe(data.action.text));
    expect(root.textContent).toContain('fixed proxy');
    click(root, 'Download decision HTML'); click(root, 'Download decision JSON');
    const exported = JSON.parse(await blobs[1]!.text());
    expect(exported.operationalWorksheet.baseline.firstGapDay).toBe(8);
    const { operationalWorksheet: worksheet, ...energy } = exported;
    expect(energy).toEqual(data);
    const doc = new DOMParser().parseFromString(await blobs[0]!.text(), 'text/html');
    expect(JSON.parse(doc.querySelector('#decision-brief-snapshot')!.textContent!)).toEqual(exported);
    expect(doc.querySelector('.cdp-decision-paper')!.textContent).toBe(root.querySelector('.cdp-decision-paper')!.textContent);
  });

  it('ignores late responses after selection changes, close and panel abort', async () => {
    for (const cause of ['change', 'close', 'abort']) {
      let resolve!: (value: ReturnType<typeof snapshot>) => void;
      const signal = new AbortController();
      const root = createDecisionBriefOutput({ code: 'DE', name: 'Germany' }, signal.signal, () => new Promise(r => { resolve = r; }), () => {});
      document.body.append(root); click(root, 'Capture / refresh both');
      if (cause === 'change') root.querySelector('select')!.dispatchEvent(new Event('change'));
      if (cause === 'close') click(root, '← Back to brief');
      if (cause === 'abort') signal.abort();
      resolve(snapshot()); await new Promise(r => setTimeout(r, 0));
      expect(root.querySelector('.cdp-decision-paper')).toBeNull();
      expect(root.querySelector<HTMLButtonElement>('button[disabled]')).not.toBeNull();
      root.remove();
    }
  });

  it('withholds exports on denied or failed request and allows refresh recovery', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('403')).mockRejectedValueOnce(new Error('503')).mockResolvedValue(snapshot());
    const root = createDecisionBriefOutput({ code: 'DE', name: 'Germany' }, new AbortController().signal, load, () => {});
    for (let i = 0; i < 2; i++) {
      click(root, 'Capture / refresh both');
      await vi.waitFor(() => expect(root.textContent).toContain('Check your access and retry'));
      expect(root.querySelector('.cdp-decision-paper')).toBeNull();
    }
    click(root, 'Capture / refresh both');
    await vi.waitFor(() => expect(root.textContent).toContain('6,197.7 TJ'));
  });

  it('keeps small positive modeled loss distinct from zero', () => {
    const data = snapshot(); data.results[0]!.loss = 0.001;
    expect(renderDecisionBrief(data).textContent).toContain('<0.1 TJ');
  });

  // The three states must stay visibly distinct: unavailable, too small to state, and
  // a genuine recorded zero. Collapsing fmt's `value !== 0 &&` guard would render a
  // measured zero as "<0.1" — the exact unknown-vs-zero confusion this feature exists
  // to prevent — and every other assertion in this file would still pass.
  it('renders a recorded zero as 0.0, not <0.1 or Unknown', () => {
    const data = snapshot(); data.results[0]!.loss = 0;
    const text = renderDecisionBrief(data).textContent!;
    expect(text).toContain('0.0 TJ');
    expect(text).not.toContain('<0.1 TJ');
  });

  it('renders an unavailable modeled loss as Unknown', () => {
    const data = snapshot(); data.results[0]!.loss = null;
    const text = renderDecisionBrief(data).textContent!;
    expect(text).toContain('Unknown');
    expect(text).not.toContain('0.0 TJ');
  });

  it('escapes embedded snapshot markup', () => {
    const data = snapshot(); data.action.text = '</script><img src=x onerror=alert(1)>';
    const paper = renderDecisionBrief(data);
    expect(paper.querySelector('img')).toBeNull();
    expect(paper.querySelector('script')!.textContent).not.toContain('<');
  });
});

describe('commodity snapshot lifecycle', () => {
  it('keeps preview details collapsible and the exported report complete with the same snapshot', async () => {
    const { renderCommodityBrief } = await import('@/components/CountryBriefOutput');
    const { buildCommodityBrief } = await import('@/utils/decision-brief');
    const data = buildCommodityBrief({ countryCode: 'JP', countryName: 'Japan', commodityId: 'helium', chokepointId: 'hormuz_strait' }, {
      retrievedAt: '2026-09-10', products: { iso2: 'JP', fetchedAt: '', products: [{ hs4: '2804', description: '', totalValue: 100, year: 2024,
        topExporters: [{ partnerCode: 634, partnerIso2: 'QA', share: 0.5, value: 50 }] }] },
      vulnerabilities: { iso2: 'JP', country: '', vulnerabilities: [], generatedAt: '', methodologyVersion: '', upstreamUnavailable: true },
    });
    const preview = renderCommodityBrief(data, true);
    const report = renderCommodityBrief(data);
    expect(preview.classList.contains('cdp-output-paper')).toBe(false);
    expect(preview.querySelectorAll('details[open]')).toHaveLength(0);
    expect(report.querySelectorAll('details:not([open])')).toHaveLength(0);
    expect(preview.querySelector('h3')!.textContent).toBe('Qatar');
    expect(preview.textContent).toContain('Strait of Hormuz');
    expect(preview.querySelector('.cdp-commodity-heading')!.textContent).toContain(data.caveats[0]);
    for (const view of [preview, report]) {
      expect(JSON.parse(view.querySelector('#commodity-brief-snapshot')!.textContent!)).toEqual(data);
      expect(view.textContent).toContain(data.action.constraint);
      expect(view.textContent).toContain(data.action.trigger);
    }
  });

  it('invalidates exports and ignores an old commodity capture after changing selection', async () => {
    const { createCommodityBriefOutput } = await import('@/components/CountryBriefOutput');
    const { buildCommodityBrief, COMMODITY_BRIEF_OPTIONS } = await import('@/utils/decision-brief');
    let resolve!: (value: ReturnType<typeof buildCommodityBrief>) => void;
    const controller = new AbortController();
    const root = createCommodityBriefOutput({ code: 'JP', name: 'Japan' }, controller.signal, COMMODITY_BRIEF_OPTIONS, () => new Promise(r => { resolve = r; }), () => {});
    document.body.append(root);
    click(root, 'Capture commodity comparison');
    const commodity = root.querySelector('select')!;
    commodity.value = 'wheat'; commodity.dispatchEvent(new Event('change'));
    resolve(buildCommodityBrief({ countryCode: 'JP', countryName: 'Japan', commodityId: 'helium', chokepointId: 'hormuz_strait' }, {
      retrievedAt: '2026-09-10', products: { iso2: 'JP', products: [], fetchedAt: '' }, vulnerabilities: { iso2: 'JP', country: '', vulnerabilities: [], generatedAt: '', methodologyVersion: '', upstreamUnavailable: true },
    }));
    await new Promise(r => setTimeout(r, 0));
    expect(root.querySelector('.cdp-commodity-paper')).toBeNull();
    expect(root.querySelector<HTMLButtonElement>('[aria-label="Download decision JSON"]')!.disabled).toBe(true);
    expect(Array.from(root.querySelectorAll('button')).find(b => b.textContent === 'Capture commodity comparison')!.disabled).toBe(false);
    controller.abort();
  });
});

it('commodity denied/failed captures withhold exports and recover with the real builder', async () => {
  const { createCommodityBriefOutput } = await import('@/components/CountryBriefOutput');
  const { buildCommodityBrief, COMMODITY_BRIEF_OPTIONS } = await import('@/utils/decision-brief');
  const load = vi.fn().mockRejectedValueOnce(new Error('403')).mockRejectedValueOnce(new Error('503')).mockImplementation(async selected => buildCommodityBrief(selected, {
    retrievedAt: '2026-09-10', products: { iso2: 'JP', products: [], fetchedAt: '' }, vulnerabilities: { iso2: 'JP', country: '', vulnerabilities: [], generatedAt: '', methodologyVersion: '', upstreamUnavailable: true },
  }));
  const root = createCommodityBriefOutput({ code: 'JP', name: 'Japan' }, new AbortController().signal, COMMODITY_BRIEF_OPTIONS, load, () => {});
  expect(root.querySelector('select')!.value).toBe('helium');
  for (let i = 0; i < 2; i++) {
    click(root, 'Capture commodity comparison');
    await vi.waitFor(() => expect(root.textContent).toContain('Check your access and retry'));
    expect(root.querySelector('.cdp-commodity-paper')).toBeNull();
    expect(root.querySelector<HTMLButtonElement>('[aria-label="Download decision JSON"]')!.disabled).toBe(true);
  }
  click(root, 'Capture commodity comparison');
  await vi.waitFor(() => expect(root.textContent).toContain('No recorded HS 2804 bilateral product evidence'));
});

import { getCountryProducts } from '../../server/worldmonitor/supply-chain/v1/get-country-products';
import { renderCommodityBrief } from '@/components/CountryBriefOutput';
vi.mock('../../server/_shared/premium-check', () => ({ isCallerPremium: async () => true }));

it('legacy JP842 survives real reader to builder to preview and embedded export without renormalization', async () => {
  redis.clear();
  redis.set('comtrade:bilateral-hs4:JP:v1', { iso2: 'JP', fetchedAt: new Date().toISOString(), products: [{
    hs4: '2804', description: 'Helium', year: 2024, totalValue: 1000,
    topExporters: [{partnerCode:842,partnerIso2:'',value:392,share:0.392},{partnerCode:490,partnerIso2:'',value:100,share:0.1}],
  }] });
  const products = await getCountryProducts({request:new Request('https://example.test')} as never, {iso2:'JP',hs4:'2804'});
  const data = buildCommodityBrief({countryCode:'JP',countryName:'Japan',commodityId:'helium',chokepointId:'hormuz_strait'}, {
    retrievedAt: new Date().toISOString(), products,
    vulnerabilities: {iso2:'JP',vulnerabilities:[],upstreamUnavailable:true} as never,
  });
  expect(data.candidates.find(c => c.origin === 'US')?.sharePct).toBe(39.2);
  const preview = renderCommodityBrief(data);
  const visible = preview.cloneNode(true) as HTMLElement;
  visible.querySelector('script')?.remove();
  expect(visible.textContent).toContain('39.2%');
  expect(visible.textContent).toContain('490');
  expect(visible.textContent).toContain('Hydrogen, rare gases and other non-metals');
  expect(visible.textContent).toContain(products.fetchedAt);
  expect(visible.textContent).toContain('2024');
  expect(JSON.parse(preview.querySelector('#commodity-brief-snapshot')!.textContent!)).toEqual(data);
  expect(products.products[0]!.topExporters[0]!.partnerCode).toBe(842);
});

for (const outcome of ['unavailable','no_records','malformed','incomplete_refresh','recovered']) it(`preserves or recovers Germany with refresh outcome ${outcome}`, async () => {
  redis.clear();
  const previous = {iso2:'DE', fetchedAt:'2026-07-27T16:47:53.750Z',products:[{hs4:'1001',description:'Wheat',year:2023,totalValue:100,topExporters:[{partnerCode:251,partnerIso2:'',value:100,share:1}]}]};
  redis.set('comtrade:bilateral-hs4:DE:v1',previous);
  vi.spyOn(globalThis,'fetch').mockImplementation(async (input) => {
    if(outcome==='unavailable') return new Response('upstream failure',{status:503});
    if(outcome==='malformed') return Response.json({unexpected:true});
    const codes = new URL(String(input)).searchParams.get('cmdCode')!.split(',');
    const rows = outcome==='no_records'?[]:[{cmdCode:'2804',partnerCode:842,primaryValue:392,period:2024},...(outcome==='recovered'?[{cmdCode:'1001',partnerCode:251,primaryValue:100,period:2024}]:[])];
    return Response.json({data:rows.filter(row=>codes.includes(row.cmdCode))});
  });
  const result = await getCountryProducts({request:new Request('https://example.test')} as never,{iso2:'DE',hs4:'2804'});
  if(outcome==='recovered') {
    expect(result.products.find(p=>p.hs4==='2804')?.topExporters[0]?.partnerIso2).toBe('US');
    expect(result.fetchedAt).not.toBe(previous.fetchedAt);
    expect(result.evidence?.requestedHs4s).toContain('2804');
  } else {
    expect(result.fetchedAt).toBe(previous.fetchedAt);
    expect(result.products[0]?.year).toBe(2023);
    expect(result.evidence?.state).toBe('stale_preserved');
    expect(result.evidence?.lastAttemptState).toBe(outcome);
    expect(redis.get('comtrade:bilateral-hs4:DE:v1')).toEqual(previous);
  }
});

it('service capture requests the selected heading and carries reader provenance into exports', async () => {
  redis.clear();
  redis.set('comtrade:bilateral-hs4:JP:v1',{iso2:'JP',fetchedAt:new Date().toISOString(),products:[{hs4:'2804',description:'Helium',year:2024,totalValue:1000,topExporters:[{partnerCode:842,partnerIso2:'',value:392,share:0.392}]}]});
  const requests: URL[]=[];
  vi.spyOn(globalThis,'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'https://example.test'); requests.push(url);
    if(url.pathname.endsWith('/get-country-products')) return Response.json(await getCountryProducts({request:new Request(url)} as never,{iso2:url.searchParams.get('iso2')!,hs4:url.searchParams.get('hs4')!}));
    return Response.json({iso2:'JP',vulnerabilities:[],upstreamUnavailable:true});
  });
  const {captureCommodityBrief}=await import('@/services/decision-brief');
  const selection={countryCode:'JP',countryName:'Japan',commodityId:'helium',chokepointId:'hormuz_strait'};
  const capture=await captureCommodityBrief(selection,new AbortController().signal);
  expect(requests.find(url=>url.pathname.endsWith('/get-country-products'))?.searchParams.get('hs4')).toBe('2804');
  const snapshot=buildCommodityBrief(selection,capture);
  expect(snapshot.candidates[0]?.sharePct).toBe(39.2);
  expect(snapshot.capture.products.evidence?.state).toBe('partial');
  const article=renderCommodityBrief(snapshot);
  expect(JSON.parse(article.querySelector('script')!.textContent!)).toEqual(snapshot);
});

it('valid empty recovery identifies requested headings and never implies zero exposure', async () => {
  redis.clear();
  vi.spyOn(globalThis,'fetch').mockImplementation(async () => Response.json({data:[]}));
  const products=await getCountryProducts({request:new Request('https://example.test')} as never,{iso2:'JP',hs4:'2804'});
  expect(products.evidence?.state).toBe('no_records');
  expect(products.evidence?.requestedHs4s).toContain('2804');
  const snapshot=buildCommodityBrief({countryCode:'JP',countryName:'Japan',commodityId:'helium',chokepointId:'hormuz_strait'}, {retrievedAt:new Date().toISOString(),products,vulnerabilities:{iso2:'JP',vulnerabilities:[],upstreamUnavailable:true} as never});
  expect(snapshot.coverage.join(' ')).toContain('requested, but no usable positive rows');
  expect(snapshot.candidates).toEqual([]);
  expect(snapshot.action.text).toContain('Recover');
});
