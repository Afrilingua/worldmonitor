import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fetchCwfisFires, CWFIS_ACTIVE_LAYER } from '../scripts/wildfire/cwfis-wfs.mjs';
import { mergeWildfireSourcesWithBc, canadianWildfireAfterPublish } from '../scripts/wildfire/bc-fire-points.mjs';
import { __testing__ as health } from '../api/health.js';

process.env.WM_SEED_RETRY_DELAY_MS = '1';
const NOW = Date.parse('2026-09-07T06:20:00Z');
const MIN = 60_000;
const active = JSON.parse(readFileSync(new URL('fixtures/wildfire/cwfis-national-activefires.json', import.meta.url), 'utf8'));
const empty = { type: 'FeatureCollection', features: [], numberMatched: 0, numberReturned: 0 };
const goodFetch = async (url) => Response.json(new URL(url).searchParams.get('typeNames') === CWFIS_ACTIVE_LAYER
  ? { ...active, numberMatched: active.features.length, numberReturned: active.features.length, links: [] } : empty);
const fail = () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }) }); };

async function run({ previousSnapshot, nowMs = NOW, fetchFn = goodFetch } = {}) {
  return mergeWildfireSourcesWithBc({
    fetchFirms: async () => ({ fireDetections: [{ id: 'firms:fixture', source: 'firms' }], _firmsFulfilledCalls: 27, _firmsFailedCalls: 0 }),
    fetchCwfis: () => fetchCwfisFires({ previousSnapshot, nowMs, fetchFn }),
    fetchBcWildfire: async () => ({ fireDetections: [] }),
  });
}

function verdict(data, now = NOW, metaOverrides = {}) {
  const key = health.BOOTSTRAP_KEYS.wildfires;
  const meta = { fetchedAt: now, recordCount: data.fireDetections.length,
    ...canadianWildfireAfterPublish(data).freshnessMetaPatch, ...metaOverrides };
  return health.classifyKey('wildfires', key, { allowOnDemand: false }, {
    keyStrens: new Map([[key, 1000]]), keyErrors: new Map(), keyMetaErrors: new Map(),
    keyMetaValues: new Map([[health.SEED_META.wildfires.key, JSON.stringify(meta)]]), now,
  });
}

test('CWFIS retries the failed active request once without replaying prescribed', async () => {
  const calls = { active: 0, prescribed: 0 };
  const data = await run({ fetchFn: async (url) => {
    const key = new URL(url).searchParams.get('typeNames') === CWFIS_ACTIVE_LAYER ? 'active' : 'prescribed';
    if (++calls[key] === 1 && key === 'active') return fail();
    return goodFetch(url);
  } });
  assert.deepEqual(calls, { active: 2, prescribed: 1 });
  assert.equal(data._cwfisState, 'ok');
  assert.equal(verdict(data).status, 'OK');
});

test('CWFIS retains source rows and their clock on the first miss, warns on repeat, and recovers', async () => {
  const good = await run();
  assert.equal(good._cwfisSnapshot.fetchedAt, NOW);
  const first = await run({ previousSnapshot: good._cwfisSnapshot, nowMs: NOW + 10 * MIN, fetchFn: fail });
  assert.equal(first._cwfisCount, good._cwfisCount);
  assert.equal(first._cwfisSnapshot.fetchedAt, NOW);
  assert.equal(first._cwfisSnapshot.consecutiveFailures, 1);
  assert.equal(first.fireDetections.some(row => row.source === 'firms'), true);
  const entry = verdict(first, NOW + 10 * MIN);
  assert.equal(entry.sourceFailurePendingUntil, new Date(NOW + 25 * MIN).toISOString());
  assert.equal(verdict(first, NOW + 25 * MIN).sourceFailurePendingUntil, undefined);
  const second = await run({ previousSnapshot: first._cwfisSnapshot, nowMs: NOW + 20 * MIN, fetchFn: fail });
  assert.equal(second._cwfisSnapshot.consecutiveFailures, 2);
  assert.equal(second._cwfisSnapshot.firstFailureAt, NOW + 10 * MIN);
  assert.equal(verdict(second, NOW + 20 * MIN).status, 'SEED_ERROR');
  assert.equal(verdict(second, NOW + 20 * MIN).sourceFailurePendingUntil, undefined);
  const recovered = await run({ previousSnapshot: second._cwfisSnapshot, nowMs: NOW + 21 * MIN });
  assert.equal(recovered._cwfisSnapshot.consecutiveFailures, 0);
  assert.equal(recovered._cwfisSnapshot.fetchedAt, NOW + 21 * MIN);
  assert.equal(verdict(recovered, NOW + 21 * MIN).status, 'OK');
});

test('CWFIS missing, expired, malformed, future or unknown-streak snapshots earn no grace', async () => {
  const good = await run();
  for (const previousSnapshot of [
    null, {}, { ...good._cwfisSnapshot, fetchedAt: NOW - 20 * MIN },
    { ...good._cwfisSnapshot, fetchedAt: NOW + 11 * MIN },
    { ...good._cwfisSnapshot, fireDetections: [{}] },
    { ...good._cwfisSnapshot, consecutiveFailures: undefined },
  ]) {
    const data = await run({ previousSnapshot, nowMs: NOW + 10 * MIN, fetchFn: fail });
    const entry = verdict(data, NOW + 10 * MIN);
    assert.equal(entry.status, 'SEED_ERROR');
    assert.equal(entry.sourceFailurePendingUntil, undefined);
  }
});

test('CWFIS retention expires at its original 30-minute limit even during a pending episode', async () => {
  const good = await run();
  const data = await run({ previousSnapshot: good._cwfisSnapshot, nowMs: NOW + 29 * MIN, fetchFn: fail });
  assert.equal(verdict(data, NOW + 29 * MIN).sourceFailurePendingUntil, new Date(NOW + 30 * MIN).toISOString());
  assert.equal(verdict(data, NOW + 30 * MIN).sourceFailurePendingUntil, undefined);
  const expired = await run({ previousSnapshot: data._cwfisSnapshot, nowMs: NOW + 30 * MIN, fetchFn: fail });
  assert.equal(expired._cwfisCount, 0);
});

test('a complete empty CWFIS response clears previous fires and remains a valid last-good snapshot', async () => {
  const good = await run();
  const zero = await run({ previousSnapshot: good._cwfisSnapshot, nowMs: NOW + MIN, fetchFn: async () => Response.json(empty) });
  assert.equal(zero._cwfisCount, 0);
  assert.deepEqual(zero._cwfisSnapshot.fireDetections, []);
  assert.equal(verdict(zero, NOW + MIN).status, 'OK');
  const failed = await run({ previousSnapshot: zero._cwfisSnapshot, nowMs: NOW + 10 * MIN, fetchFn: fail });
  assert.equal(failed._cwfisCount, 0);
  assert.equal(failed._cwfisSnapshot.fetchedAt, NOW + MIN);
  assert.ok(verdict(failed, NOW + 10 * MIN).sourceFailurePendingUntil);
});

test('CWFIS contract failures do not retry or receive pending even with recent source data', async () => {
  const good = await run();
  let calls = 0;
  const data = await run({ previousSnapshot: good._cwfisSnapshot, nowMs: NOW + MIN, fetchFn: async () => {
    calls++;
    return Response.json({ broken: true });
  } });
  assert.equal(calls, 2);
  assert.equal(verdict(data, NOW + MIN).status, 'SEED_ERROR');
  assert.equal(verdict(data, NOW + MIN).sourceFailurePendingUntil, undefined);
});

test('exhausted CWFIS transport errors keep their bounded native cause and attempt count', async () => {
  let calls = 0;
  await assert.rejects(fetchCwfisFires({ fetchFn: async () => { calls++; return fail(); } }), error => {
    assert.equal(error.cause?.cause?.code, 'ECONNRESET');
    assert.equal(error.cause?.attempts, 2);
    return true;
  });
  assert.equal(calls, 4);
});
