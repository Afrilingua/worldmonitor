import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeScenario, physicalImpact } from '../scripts/scenario-worker.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let cache;
let batches;
const manifest = (countryIds = ['DE', 'JP'], hs2Codes = ['27', '29']) => ({
  manifestVersion: 1, status: 'ok', countryIds, hs2Codes, fetchedAt: 1789000000000,
});
const record = (iso2, hs2, score = 40, coverage = 'flow_weighted') => ({
  iso2, hs2, coverage, fetchedAt: '2026-09-09T00:00:00Z', vulnerabilityIndex: score,
  exposures: [{ chokepointId: 'hormuz_strait', exposureScore: score }],
});
const key = (iso2, hs2) => `supply-chain:exposure:${iso2}:${hs2}:v1`;

beforeEach(() => {
  cache = new Map([['seed-meta:supply_chain:chokepoint-exposure', manifest()]]);
  batches = [];
  process.env.UPSTASH_REDIS_REST_URL = 'https://fixture.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/pipeline')) {
      const commands = JSON.parse(init.body);
      batches.push(commands);
      return Response.json(commands.map(([, k]) => ({ result: cache.has(k) ? JSON.stringify(cache.get(k)) : null })));
    }
    const k = decodeURIComponent(String(url).split('/get/')[1]);
    return Response.json({ result: cache.has(k) ? JSON.stringify(cache.get(k)) : null });
  };
});
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; });

describe('scenario worker manifest and evidence', () => {
  it('scales raw score 40 to 20 at half severity and 40 at full severity with multiplier 1', () => {
    assert.equal(physicalImpact(40, 50, 1), 20);
    assert.equal(physicalImpact(40, 100, 1), 40);
  });
  it('includes Germany and Japan, preserves zero, fallback, missing and malformed records', async () => {
    cache.set(key('DE', '27'), record('DE', '27', 40));
    cache.set(key('DE', '29'), record('DE', '29', 0, 'country_route_fallback'));
    cache.set(key('JP', '27'), { ...record('JP', '27'), exposures: [] });
    const result = await computeScenario('hormuz-tanker-blockade', null, 50);
    assert.deepEqual(result.coverage.countryIds, ['DE', 'JP']);
    assert.deepEqual(result.coverage.records.map(r => r.state), ['evaluated', 'evaluated', 'malformed', 'missing']);
    assert.deepEqual(result.coverage.records.map(r => r.rawImpact), [42, 0, undefined, undefined]);
    assert.equal(result.coverage.records[1].basis, 'country_route_fallback');
    assert.equal(result.coverage.status, 'partial');
    assert.equal(result.topImpactCountries[0].iso2, 'DE');
    assert.equal(result.topImpactCountries[0].totalImpact, 42);
    cache.set(key('JP', '27'), record('JP', '27', 20));
    cache.set(key('JP', '29'), record('JP', '29', 0));
    const full = await computeScenario('hormuz-tanker-blockade', null, 100);
    assert.equal(full.coverage.status, 'complete');
    assert.deepEqual(full.topImpactCountries.map(c => [c.iso2, c.totalImpact]), [['DE', 84], ['JP', 42]]);
    assert.equal(full.topImpactCountries[0].impactPct, result.topImpactCountries[0].impactPct);
  });

  it('uses template defaults and accepts explicit zero severity', async () => {
    cache.set(key('DE', '27'), record('DE', '27'));
    cache.set(key('DE', '29'), record('DE', '29', 0));
    const defaults = await computeScenario('hormuz-tanker-blockade', 'DE');
    const zero = await computeScenario('hormuz-tanker-blockade', 'DE', 0);
    assert.equal(defaults.template.disruptionPct, 100);
    assert.equal(defaults.topImpactCountries[0].totalImpact, 84);
    assert.equal(zero.template.disruptionPct, 0);
    assert.equal(zero.topImpactCountries[0].totalImpact, 0);
    assert.equal(zero.coverage.status, 'complete');
    assert.equal(zero.scopedIso2, 'DE');
  });

  it('distinguishes raw invalid JSON from missing records and evaluated zero', async () => {
    const fetchFixture = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (!String(url).endsWith('/pipeline')) return fetchFixture(url, init);
      batches.push(JSON.parse(init.body));
      return Response.json([
        { result: '{invalid JSON' },
        { result: null },
        { result: JSON.stringify(record('JP', '27', 0)) },
        { result: JSON.stringify(record('JP', '29', 0)) },
      ]);
    };
    const result = await computeScenario('hormuz-tanker-blockade', null);
    assert.deepEqual(result.coverage.records.map(r => [r.iso2, r.hs2, r.state, r.rawImpact]), [
      ['DE', '27', 'malformed', undefined],
      ['DE', '29', 'missing', undefined],
      ['JP', '27', 'evaluated', 0],
      ['JP', '29', 'evaluated', 0],
    ]);
    assert.equal(result.coverage.status, 'partial');
    assert.deepEqual(result.topImpactCountries, [{ iso2: 'JP', totalImpact: 0, impactPct: 0 }]);
  });

  it('reports unknown coverage after manifest GET rejection without pipeline reads', async () => {
    const fetchFixture = globalThis.fetch;
    const reads = [];
    globalThis.fetch = async (url, init) => {
      reads.push(String(url));
      if (String(url).includes('/get/')) throw new Error('manifest transport unavailable');
      return fetchFixture(url, init);
    };
    const result = await computeScenario('hormuz-tanker-blockade', null);
    assert.equal(reads.length, 1);
    assert.match(decodeURIComponent(reads[0]), /\/get\/seed-meta:supply_chain:chokepoint-exposure$/);
    assert.equal(result.coverage.status, 'unknown');
    assert.deepEqual(result.coverage.records, []);
    assert.deepEqual(result.topImpactCountries, []);
    assert.equal(batches.length, 0);
  });

  it('reports unknown coverage for absent, old, invalid or failed manifest without guessing keys', async () => {
    for (const value of [null, {}, { ...manifest(), status: 'error' }, { ...manifest(), countryIds: ['DE', 'DE'] }, { ...manifest(), hs2Codes: ['../../key'] }]) {
      cache.set('seed-meta:supply_chain:chokepoint-exposure', value);
      const result = await computeScenario('hormuz-tanker-blockade', null);
      assert.equal(result.coverage.status, 'unknown');
      assert.deepEqual(result.topImpactCountries, []);
    }
    assert.equal(batches.length, 0);
  });

  it('distinguishes a country or sector outside the manifest from a missing seeded key', async () => {
    cache.set('seed-meta:supply_chain:chokepoint-exposure', manifest(['DE'], ['27']));
    const result = await computeScenario('hormuz-tanker-blockade', 'DE');
    assert.deepEqual(result.coverage.records.map(r => r.state), ['missing', 'not_seeded']);
    const outside = await computeScenario('hormuz-tanker-blockade', 'JP');
    assert.deepEqual(outside.coverage.records.map(r => r.state), ['not_seeded', 'not_seeded']);
  });

  it('keeps tariff vulnerability math and rejects physical overrides on tariffs', async () => {
    cache.set('seed-meta:supply_chain:chokepoint-exposure', manifest(['DE'], ['85']));
    cache.set(key('DE', '85'), record('DE', '85', 40));
    const result = await computeScenario('us-tariff-escalation-electronics', 'DE');
    assert.equal(result.topImpactCountries[0].totalImpact, 60);
    assert.equal(result.template.disruptionPct, 0);
    await assert.rejects(computeScenario('us-tariff-escalation-electronics', 'DE', 0), /Invalid disruption/);
    for (const severity of [-1, 101, 0.5, NaN, Infinity, null, '50']) {
      await assert.rejects(computeScenario('hormuz-tanker-blockade', 'DE', severity), /Invalid disruption/);
    }
  });

  it('bounds reads to 100 keys per batch', async () => {
    const countries = Array.from({ length: 12 }, (_, i) => `A${String.fromCharCode(65 + i)}`);
    const sectors = Array.from({ length: 11 }, (_, i) => String(i + 1).padStart(2, '0'));
    cache.set('seed-meta:supply_chain:chokepoint-exposure', manifest(countries, sectors));
    const result = await computeScenario('panama-drought-50pct', null);
    assert.deepEqual(batches.map(b => b.length), [100, 32]);
    assert.equal(result.coverage.records.length, 132);
  });

  it('fails on Redis transport errors instead of declaring missing evidence', async () => {
    globalThis.fetch = async url => String(url).endsWith('/pipeline')
      ? new Response('unavailable', { status: 503 }) : Response.json({ result: JSON.stringify(manifest()) });
    await assert.rejects(computeScenario('hormuz-tanker-blockade', null), /HTTP 503/);
  });
});
