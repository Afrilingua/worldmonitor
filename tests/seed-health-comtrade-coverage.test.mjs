import { test, after } from 'node:test';
import assert from 'node:assert/strict';
const originalFetch = globalThis.fetch;
const keys = ['UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN','WORLDMONITOR_VALID_KEYS'];
const originalEnv = Object.fromEntries(keys.map(k => [k,process.env[k]]));
process.env.UPSTASH_REDIS_REST_URL='https://redis.example.test';
process.env.UPSTASH_REDIS_REST_TOKEN='test-only';
process.env.WORLDMONITOR_VALID_KEYS='test-key';
const {handleSeedHealth} = await import('../api/seed-health.js');
after(() => { globalThis.fetch=originalFetch; for(const [k,v] of Object.entries(originalEnv)) {if(v===undefined) delete process.env[k]; else process.env[k]=v;} });

async function bilateralEntry(details) {
  const now=Date.now();
  globalThis.fetch=async (_url,init) => Response.json(JSON.parse(init.body).map(([op,key]) => ({result:op==='EXISTS'?1:JSON.stringify({fetchedAt:now,recordCount:10000,status:'ok',...(key==='seed-meta:comtrade:bilateral-hs4'?details:{})})})));
  const response=await handleSeedHealth(new Request('https://example.test/api/seed-health',{headers:{'X-WorldMonitor-Key':'test-key'}}),{now});
  return (await response.json()).seeds['comtrade:bilateral-hs4'];
}

const failures = [
  ['a preserved country', {preserveStreaks:{DE:1}}],
  ...['unavailable','malformed','incomplete','not_attempted'].map(state => [`a ${state} country`, {countryCoverage:{DE:{state}}}]),
];
for (const [label, details] of failures) {
  test(`aggregate ok does not hide ${label}`, async () => {
    const entry = await bilateralEntry(details);
    assert.equal(entry.status,'coverage_partial');
    assert.equal(entry.coveragePartial,true);
  });
}

// Valid observations: an importer that does not trade every reviewed heading,
// and a reporter with no positive rows. Flagging them would keep the domain
// partial on every healthy run and hide the failures above.
const healthy = {countryCoverage:{
  DE:{state:'observed',missingHs4s:['2612','2804'],rowCounts:[412,308]},
  JP:{state:'observed',missingHs4s:[]},
  TV:{state:'no_records',missingHs4s:['1001','2804']},
  bad:{state:'unavailable'},
}};
test('observed heading gaps and valid empty reporters keep the domain ok while staying visible', async () => {
  const entry = await bilateralEntry(healthy);
  assert.equal(entry.status,'ok');
  assert.equal(entry.coveragePartial,undefined);
  assert.deepEqual(Object.keys(entry.bilateralCoverage.countryCoverage).sort(),['DE','JP','TV']);
  assert.deepEqual(entry.bilateralCoverage.countryCoverage.DE.missingHs4s,['2612','2804']);
  assert.equal(entry.bilateralCoverage.productCoverageKnown,true);
});

// R9: the per-batch row counts are diagnostic only. They must reach the operator
// intact, and a reporter that returned rows must not be reclassified for it.
test('per-batch row counts reach the health payload without changing status', async () => {
  const entry = await bilateralEntry(healthy);
  assert.deepEqual(entry.bilateralCoverage.countryCoverage.DE.rowCounts,[412,308]);
  assert.equal(entry.bilateralCoverage.countryCoverage.JP.rowCounts,undefined,
    'a country recorded before rowCounts existed stays readable');
  assert.equal(entry.status,'ok');
});
