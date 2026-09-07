import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchNaturalEvents } from '../scripts/seed-natural-events.mjs';

const NOW = Date.parse('2026-09-07T10:00:00.000Z');
process.env.WM_SEED_RETRY_DELAY_MS = '1';

const retainedStorm = {
  id: 'nhc-AL01-7',
  title: 'Tropical Storm Alpha',
  description: 'Tropical Storm Alpha, Max wind 45 kt',
  category: 'severeStorms',
  categoryTitle: 'Tropical Cyclone',
  lat: 20,
  lon: -60,
  date: NOW - 60_000,
  magnitude: 45,
  magnitudeUnit: 'kt',
  sourceUrl: 'https://www.nhc.noaa.gov/',
  sourceName: 'NHC',
  closed: false,
  stormId: 'nhc-AL01-7',
  stormName: 'Alpha',
  basin: 'AL',
  stormCategory: 0,
  classification: 'Tropical Storm',
  windKt: 45,
  forecastTrack: [],
  conePolygon: [],
  pastTrack: [],
};

const previousNhcSnapshot = {
  version: 1,
  fetchedAt: NOW,
  retainedUntil: NOW + 540 * 60_000,
  events: [retainedStorm],
  lastAttemptAt: NOW,
  consecutiveFailures: 0,
  firstFailureAt: null,
  errorCode: null,
};

function hkoCoverage() {
  return {
    warnings: [],
    dataAvailable: true,
    sourceDecision: {
      source: 'HKO warning summary',
      host: 'data.weather.gov.hk',
      status: 'used',
      reason: 'VALID_EMPTY',
      optional: false,
      requestCount: 1,
    },
  };
}

test('retains validated NHC coverage after required point requests fail without replaying healthy providers', async () => {
  const calls = { eonet: 0, gdacs: 0, nhc: 0, hko: 0 };
  const payload = await fetchNaturalEvents({
    now: NOW + 5 * 60_000,
    previousNhcSnapshot,
    fetchHkoWarningsFn: async () => {
      calls.hko += 1;
      return hkoCoverage();
    },
    fetchFn: async (input) => {
      const url = String(input);
      if (url.includes('eonet.gsfc.nasa.gov')) {
        calls.eonet += 1;
        return Response.json({
          events: [{
            id: 'eonet-volcano-1',
            title: 'Volcano fixture',
            description: '',
            categories: [{ id: 'volcanoes', title: 'Volcanoes' }],
            geometry: [{
              date: new Date(NOW).toISOString(),
              type: 'Point',
              coordinates: [1, 2],
            }],
            sources: [],
            closed: null,
          }],
        });
      }
      if (url.includes('gdacs.org')) {
        calls.gdacs += 1;
        return Response.json({ features: [] });
      }
      if (url.includes('mapservices.weather.noaa.gov')) {
        calls.nhc += 1;
        return new Response('temporarily unavailable', { status: 503 });
      }
      throw new Error(`unexpected request ${url}`);
    },
  });

  assert.ok(payload);
  assert.deepEqual(
    payload.events.filter((event) => event.sourceName === 'NHC'),
    [retainedStorm],
  );
  assert.deepEqual(calls, { eonet: 1, gdacs: 1, nhc: 30, hko: 1 });
});
