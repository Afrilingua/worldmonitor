import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  composeEmbedMapFrame,
  entitledLayersForTier,
  parseRequestedLayers,
  refreshMsForTier,
  type EmbedMapFrameSources,
} from '../server/_shared/embed-map-frame';
import { EMBED_LAYER_IDS, EMBED_KEYED_REFRESH_MS, EMBED_FREE_REFRESH_MS } from '../shared/embed-panels';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOW = 1_700_000_000_000;

function sources(overrides: Partial<EmbedMapFrameSources> = {}): EmbedMapFrameSources {
  return {
    listConflicts: async () => [{ id: 'c1' }],
    listEarthquakes: async () => [{ id: 'q1' }],
    listNaturalEvents: async () => [{ id: 'n1' }],
    listProtests: async () => [{ id: 'p1' }],
    listWeatherAlerts: async () => [{ id: 'w1' }],
    ...overrides,
  };
}

/** Counts calls so a test can prove an upstream was never touched. */
function countingSources(overrides: Partial<EmbedMapFrameSources> = {}) {
  const calls: string[] = [];
  const base = sources();
  const wrapped = Object.fromEntries(
    (Object.keys(base) as (keyof EmbedMapFrameSources)[]).map((key) => [
      key,
      async () => {
        calls.push(key);
        return (overrides[key] ?? base[key])();
      },
    ]),
  ) as EmbedMapFrameSources;
  return { calls, sources: wrapped };
}

describe('embed map frame', () => {
  describe('requested layers', () => {
    it('accepts the allowlist and drops everything else', () => {
      assert.deepEqual(
        parseRequestedLayers('conflicts,weather,cables'),
        ['conflicts', 'weather', 'cables'],
      );
      assert.deepEqual(parseRequestedLayers('conflicts,nuclear,military,ais'), ['conflicts']);
      assert.deepEqual(parseRequestedLayers('__proto__,constructor'), []);
    });

    it('normalises duplicates and whitespace so the cache key does not fragment', () => {
      assert.deepEqual(
        parseRequestedLayers(' conflicts , conflicts,  weather '),
        ['conflicts', 'weather'],
      );
    });

    it('falls back to the free trio when the parameter is absent or blank', () => {
      assert.deepEqual(parseRequestedLayers(null), ['conflicts', 'earthquakes', 'weather']);
      assert.deepEqual(parseRequestedLayers(''), ['conflicts', 'earthquakes', 'weather']);
      assert.deepEqual(parseRequestedLayers('   '), ['conflicts', 'earthquakes', 'weather']);
    });
  });

  describe('tiers', () => {
    it('entitles three layers free and all fourteen keyed', () => {
      assert.deepEqual([...entitledLayersForTier('free')], ['conflicts', 'earthquakes', 'weather']);
      assert.deepEqual([...entitledLayersForTier('keyed')], [...EMBED_LAYER_IDS]);
    });

    it('takes each cadence from the registry', () => {
      assert.equal(refreshMsForTier('free'), EMBED_FREE_REFRESH_MS);
      assert.equal(refreshMsForTier('keyed'), EMBED_KEYED_REFRESH_MS);
    });

    it('serves the three free layers to a keyless caller', async () => {
      const frame = await composeEmbedMapFrame(
        ['conflicts', 'earthquakes', 'weather'],
        'free',
        sources(),
        NOW,
      );
      assert.equal(frame.tier, 'free');
      assert.equal(frame.refreshMs, EMBED_FREE_REFRESH_MS);
      assert.equal(frame.generatedAt, NOW);
      assert.deepEqual(frame.layers, { conflicts: 'ok', earthquakes: 'ok', weather: 'ok' });
      assert.deepEqual(frame.data.conflicts, [{ id: 'c1' }]);
      assert.deepEqual(frame.data.earthquakes, [{ id: 'q1' }]);
      assert.deepEqual(frame.data.naturalEvents, [{ id: 'n1' }]);
      assert.deepEqual(frame.data.weatherAlerts, [{ id: 'w1' }]);
      assert.equal(frame.data.protests, undefined);
    });

    it('marks a paid layer not-entitled for a keyless caller and withholds its data', async () => {
      const frame = await composeEmbedMapFrame(
        ['conflicts', 'protests', 'cables'],
        'free',
        sources(),
        NOW,
      );
      assert.equal(frame.layers.conflicts, 'ok');
      assert.equal(frame.layers.protests, 'not-entitled');
      assert.equal(frame.layers.cables, 'not-entitled');
      assert.equal(frame.data.protests, undefined);
    });

    it('does not spend an upstream read on an unentitled layer', async () => {
      const { calls, sources: counting } = countingSources();
      await composeEmbedMapFrame(['conflicts', 'protests'], 'free', counting, NOW);
      assert.deepEqual(calls, ['listConflicts']);
      assert.equal(
        calls.includes('listProtests'),
        false,
        'the free tier must not fund a paid layer’s upstream',
      );
    });

    it('serves every requested layer to a keyed caller', async () => {
      const frame = await composeEmbedMapFrame([...EMBED_LAYER_IDS], 'keyed', sources(), NOW);
      assert.equal(frame.tier, 'keyed');
      assert.equal(frame.refreshMs, EMBED_KEYED_REFRESH_MS);
      for (const id of EMBED_LAYER_IDS) {
        assert.equal(frame.layers[id], 'ok', `${id} should be served to a keyed caller`);
      }
      assert.deepEqual(frame.data.protests, [{ id: 'p1' }]);
    });

    it('answers static layers without an upstream read', async () => {
      const { calls } = countingSources();
      const { sources: counting, calls: staticCalls } = countingSources();
      const frame = await composeEmbedMapFrame(['cables', 'pipelines'], 'keyed', counting, NOW);
      assert.deepEqual(frame.layers, { cables: 'ok', pipelines: 'ok' });
      assert.deepEqual(staticCalls, []);
      assert.deepEqual(calls, []);
      assert.deepEqual(frame.data, {});
    });
  });

  describe('partial upstream failure', () => {
    it('ships one failed layer as state rather than failing the frame', async () => {
      const frame = await composeEmbedMapFrame(
        ['conflicts', 'earthquakes', 'weather'],
        'free',
        sources({ listWeatherAlerts: async () => { throw new Error('redis down'); } }),
        NOW,
      );
      assert.equal(frame.layers.conflicts, 'ok');
      assert.equal(frame.layers.earthquakes, 'ok');
      assert.equal(frame.layers.weather, 'unavailable');
      assert.deepEqual(frame.data.conflicts, [{ id: 'c1' }]);
      assert.equal(frame.data.weatherAlerts, undefined);
    });

    it('reports a two-source layer as partial when only one upstream answers', async () => {
      const frame = await composeEmbedMapFrame(
        ['earthquakes'],
        'free',
        sources({ listNaturalEvents: async () => { throw new Error('seed missing'); } }),
        NOW,
      );
      assert.equal(frame.layers.earthquakes, 'partial');
      assert.deepEqual(frame.data.earthquakes, [{ id: 'q1' }]);
      assert.equal(frame.data.naturalEvents, undefined);
    });

    it('reports a two-source layer as unavailable only when both upstreams fail', async () => {
      const frame = await composeEmbedMapFrame(
        ['earthquakes'],
        'free',
        sources({
          listEarthquakes: async () => { throw new Error('down'); },
          listNaturalEvents: async () => { throw new Error('down'); },
        }),
        NOW,
      );
      assert.equal(frame.layers.earthquakes, 'unavailable');
      assert.deepEqual(frame.data, {});
    });

    it('still returns a well-formed frame when every upstream fails', async () => {
      const boom = async () => { throw new Error('everything is down'); };
      const frame = await composeEmbedMapFrame(
        ['conflicts', 'earthquakes', 'weather'],
        'free',
        sources({
          listConflicts: boom,
          listEarthquakes: boom,
          listNaturalEvents: boom,
          listWeatherAlerts: boom,
        }),
        NOW,
      );
      assert.equal(frame.tier, 'free');
      assert.equal(frame.refreshMs, EMBED_FREE_REFRESH_MS);
      assert.deepEqual(frame.layers, {
        conflicts: 'unavailable',
        earthquakes: 'unavailable',
        weather: 'unavailable',
      });
      assert.deepEqual(frame.data, {});
    });
  });

  describe('edge handler', () => {
    const source = readFileSync(resolve(__dirname, '../api/embed/map-frame.ts'), 'utf-8');

    it('selects the tier from the URL marker, not from a header alone', () => {
      // A CDN hit happens before the function sees a header, so the public URL
      // must mean one thing for every caller.
      assert.match(source, /searchParams\.get\('public'\) === '1'/);
      assert.match(source, /verifyEmbedGrant/);
      assert.match(source, /claims\.panel === 'map'/);
    });

    it('gives the free tier a shared lifetime and the keyed tier a private one', () => {
      assert.match(source, /public, max-age=60, s-maxage=/);
      assert.match(source, /stale-while-revalidate/);
      assert.match(source, /`private, max-age=/);
    });

    it('accepts no knob other than layers', () => {
      for (const forbidden of ['sw_lat', 'ne_lat', 'bbox', 'page_size', 'pageSize:', 'start:', 'cursor:']) {
        const uses = source.split('\n').filter(
          (line) => line.includes(forbidden) && line.includes('searchParams'),
        );
        assert.deepEqual(uses, [], `${forbidden} must not be read from the request`);
      }
      const reads = [...source.matchAll(/searchParams\.get\('([^']+)'\)/g)].map((m) => m[1]);
      assert.deepEqual([...new Set(reads)].sort(), ['layers', 'public']);
    });

    it('rate limits the keyless path', () => {
      assert.match(source, /checkEndpointRateLimit/);
      assert.match(source, /tier === 'free'/);
    });

    it('accepts only the grant, never a wm_ key or a viewer cookie', () => {
      assert.match(source, /X-WorldMonitor-Grant/);
      assert.equal(source.includes('validateUserApiKey'), false);
      assert.equal(source.includes('user-api-key'), false);
      assert.equal(source.includes('X-WorldMonitor-Key'), false);
      assert.equal(source.includes('getCookie'), false);
      assert.equal(source.includes("headers.get('cookie')"), false);
    });
  });
});
