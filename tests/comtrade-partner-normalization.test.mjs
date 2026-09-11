import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByProduct } from '../scripts/seed-comtrade-bilateral-hs4.mjs';

for (const [code, iso] of [[842, 'US'], [251, 'FR'], [579, 'NO'], [840, 'US'], [250, 'FR'], [578, 'NO'], [124, 'CA'], [490, ''], [899, ''], [9999, '']]) {
  test(`bilateral projection retains provider partner ${code} as ${iso || 'unresolved'}`, () => {
    const [product] = groupByProduct([{ cmdCode: '2804', partnerCode: String(code), primaryValue: 392, year: 2024 }]);
    assert.equal(product.topExporters[0].partnerIso2, iso);
    assert.equal(product.topExporters[0].partnerCode, code);
    assert.equal(product.topExporters[0].value, 392);
  });
}
test('world total is not a country candidate', () => {
  assert.deepEqual(groupByProduct([{cmdCode:'2804',partnerCode:'0',primaryValue:100,year:2024}]), []);
});

import { parseRecords } from '../scripts/shared/comtrade.mjs';
for (const body of [{}, {data:{}}, {data:[{cmdCode:'2804',partnerCode:842,primaryValue:'not-a-number',period:2024}]}]) {
  test('malformed upstream data cannot be recorded as valid empty', () => assert.throws(() => parseRecords(body), /Malformed/));
}

test('a capped provider response is incomplete, not a complete country snapshot', () => {
  const row={cmdCode:'2804',partnerCode:842,primaryValue:392,period:2024};
  assert.throws(()=>parseRecords({data:[row,row]},2),/Incomplete/);
});

test('new ingestion uses the World denominator without double-counting aggregate partners', () => {
  const records=[['0',1000],['899',100],['842',392],['634',100]].map(([partnerCode,primaryValue])=>({cmdCode:'2804',partnerCode,primaryValue,year:2024}));
  const product=groupByProduct(records)[0];
  assert.equal(product.totalValue,1000);
  assert.equal(product.topExporters.find(p=>p.partnerCode===842).share,0.392);
  assert(!product.topExporters.some(p=>p.partnerCode===0));
  assert.equal(product.denominatorBasis,'reported_world');
});

test('new ingestion rejects partner values exceeding the World denominator', () => {
  assert.throws(() => groupByProduct([
    { cmdCode: '2804', partnerCode: '0', primaryValue: 100, year: 2024 },
    { cmdCode: '2804', partnerCode: '842', primaryValue: 150, year: 2024 },
  ]), /partner values exceed World total/);
});

test('without a World row the denominator is the observed partner sum', () => {
  const [product] = groupByProduct([
    { cmdCode: '2804', partnerCode: '842', primaryValue: 300, year: 2024 },
    { cmdCode: '2804', partnerCode: '634', primaryValue: 100, year: 2024 },
  ]);
  assert.equal(product.denominatorBasis, 'observed_partners');
  assert.equal(product.totalValue, 400);
  assert.equal(product.topExporters.find(p => p.partnerCode === 842).share, 0.75);
});

test('a World row from an older year is not used as the denominator', () => {
  const [product] = groupByProduct([
    { cmdCode: '2804', partnerCode: '0', primaryValue: 10_000, year: 2023 },
    { cmdCode: '2804', partnerCode: '842', primaryValue: 300, year: 2024 },
    { cmdCode: '2804', partnerCode: '634', primaryValue: 100, year: 2024 },
  ]);
  assert.equal(product.denominatorBasis, 'observed_partners');
  assert.equal(product.totalValue, 400);
  assert.equal(product.year, 2024);
});

import { comtradeFailureState, PREVIEW_MAX_RECORDS } from '../scripts/shared/comtrade.mjs';
import { createComtradeBilateralCatalogue } from '../scripts/shared/comtrade-bilateral.mjs';

const thrown = (fn) => { try { fn(); } catch (error) { return error; } assert.fail('expected a throw'); };

test('response failures are classified by type, not by message text', () => {
  const row = { cmdCode: '2804', partnerCode: 842, primaryValue: 392, period: 2024 };
  assert.equal(comtradeFailureState(thrown(() => parseRecords({}))), 'malformed');
  assert.equal(comtradeFailureState(thrown(() => parseRecords({ data: [row, row] }, 2))), 'incomplete');
  assert.equal(comtradeFailureState(thrown(() => groupByProduct([
    { cmdCode: '2804', partnerCode: '0', primaryValue: 100, year: 2024 },
    { cmdCode: '2804', partnerCode: '842', primaryValue: 150, year: 2024 },
  ]))), 'incomplete');
  // A network or budget error that happens to start with the same word must
  // not be reported as a provider data defect.
  assert.equal(comtradeFailureState(new Error('Malformed proxy response')), 'unavailable');
  assert.equal(comtradeFailureState(new Error('Incomplete TLS handshake')), 'unavailable');
});

test('the preview record cap matches the documented public-route limit', () => {
  assert.equal(PREVIEW_MAX_RECORDS, 500);
});

test('catalogue batches derive from the per-request cap and never include an empty request', () => {
  const identity = (code) => ({ iso2: '', kind: 'unknown', label: String(code), note: '' });
  const codes = (n) => Array.from({ length: n }, (_, i) => String(1000 + i));
  const catalogue = (n) => createComtradeBilateralCatalogue(
    { products: codes(n).map(code => ({ bilateralHs4Code: code, label: code })) },
    { commodities: [] },
    identity,
  );
  assert.deepEqual(catalogue(3).HS4_BATCHES, [codes(3)]);
  const split = catalogue(25);
  assert.deepEqual(split.HS4_BATCHES.map(batch => batch.length), [split.MAX_HS4_CODES_PER_BATCH, 25 - split.MAX_HS4_CODES_PER_BATCH]);
  assert.throws(() => catalogue(split.MAX_HS4_CODES_PER_BATCH * 2 + 1), /two-request budget/);
});
