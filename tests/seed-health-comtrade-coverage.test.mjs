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
for(const details of [{preserveStreaks:{DE:1}}, {countryCoverage:{DE:{state:'observed',missingHs4s:['2804']}}}]) {
  test('aggregate ok does not hide a preserved country or missing heading', async () => {
    const now=Date.now();
    globalThis.fetch=async (_url,init) => Response.json(JSON.parse(init.body).map(([op,key]) => ({result:op==='EXISTS'?1:JSON.stringify({fetchedAt:now,recordCount:10000,status:'ok',...(key==='seed-meta:comtrade:bilateral-hs4'?details:{})})})));
    const response=await handleSeedHealth(new Request('https://example.test/api/seed-health',{headers:{'X-WorldMonitor-Key':'test-key'}}),{now});
    const entry=(await response.json()).seeds['comtrade:bilateral-hs4'];
    assert.equal(entry.status,'coverage_partial');
    assert(entry.bilateralCoverage);
  });
}
