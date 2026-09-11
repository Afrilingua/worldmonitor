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

import { parseRecords } from '../scripts/shared/comtrade-bilateral.cjs';
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
