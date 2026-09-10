import { initTestI18n } from './helpers/i18n.mts';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDecisionBriefOutput, renderDecisionBrief } from '@/components/CountryBriefOutput';
import { buildDecisionBrief } from '@/utils/decision-brief';
import type { DecisionBriefCapture, DecisionBriefSelection } from '@/types/decision-brief';

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
    expect(json).toEqual(data);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(JSON.parse(doc.querySelector('#decision-brief-snapshot')!.textContent!)).toEqual(json);
    expect(doc.querySelector('.cdp-decision-action')!.textContent).toBe(data.action.text);
    expect(doc.body.textContent).toContain(data.action.constraint);
    expect(doc.body.textContent).toContain(data.action.trigger);
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

  it('escapes embedded snapshot markup', () => {
    const data = snapshot(); data.action.text = '</script><img src=x onerror=alert(1)>';
    const paper = renderDecisionBrief(data);
    expect(paper.querySelector('img')).toBeNull();
    expect(paper.querySelector('script')!.textContent).not.toContain('<');
  });
});
