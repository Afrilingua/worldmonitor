import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EMBED_PANEL_ID,
  EMBED_FREE_REFRESH_MS,
  EMBED_KEYED_REFRESH_MS,
  EMBED_LAYER_IDS,
  EMBED_PANEL_IDS,
  getEmbedPanelAccess,
  getEmbedPanelFreeTier,
  isEmbedLayerId,
  listEmbeddablePanels,
  parseEmbedPanelId,
} from '../shared/embed-panels';

describe('embed panel allowlist', () => {
  it('starts with the live map plus two existing dashboard panels', () => {
    assert.deepEqual([...EMBED_PANEL_IDS], ['map', 'chokepoint-strip', 'fear-greed']);
    assert.equal(DEFAULT_EMBED_PANEL_ID, 'map');
  });

  it('gives the map a free tier and keeps the other two paid-only', () => {
    assert.equal(getEmbedPanelAccess('map').kind, 'tiered');
    assert.equal(getEmbedPanelAccess('chokepoint-strip').kind, 'paid-only');
    assert.equal(getEmbedPanelAccess('fear-greed').kind, 'paid-only');
    assert.equal(getEmbedPanelFreeTier('chokepoint-strip'), null);
    assert.equal(getEmbedPanelFreeTier('fear-greed'), null);
  });

  it("publishes the map's free tier as three layers refreshed hourly", () => {
    const free = getEmbedPanelFreeTier('map');
    assert.ok(free, 'map must expose a free tier');
    assert.deepEqual([...free.layers], ['conflicts', 'earthquakes', 'weather']);
    assert.equal(free.refreshMs, EMBED_FREE_REFRESH_MS);
    assert.equal(EMBED_FREE_REFRESH_MS, 60 * 60 * 1000);
    assert.equal(EMBED_KEYED_REFRESH_MS, 10 * 60 * 1000);
  });

  it('draws every free-tier layer from the shared layer allowlist', () => {
    for (const panel of listEmbeddablePanels()) {
      const free = getEmbedPanelFreeTier(panel.id);
      if (!free) continue;
      for (const layer of free.layers) {
        assert.ok(isEmbedLayerId(layer), `${layer} is not an embeddable layer`);
      }
    }
  });

  it('allowlists exactly the fourteen embeddable layers', () => {
    assert.equal(EMBED_LAYER_IDS.length, 14);
    assert.equal(new Set(EMBED_LAYER_IDS).size, 14);
    assert.equal(isEmbedLayerId('conflicts'), true);
    assert.equal(isEmbedLayerId('gulfInvestments'), true);
    assert.equal(isEmbedLayerId('nuclear'), false);
    assert.equal(isEmbedLayerId('__proto__'), false);
  });

  it('parses canonical ids and aliases, and rejects unknown panels', () => {
    assert.equal(parseEmbedPanelId(null), 'map');
    assert.equal(parseEmbedPanelId(''), 'map');
    assert.equal(parseEmbedPanelId('live-map'), 'map');
    assert.equal(parseEmbedPanelId('Chokepoints'), 'chokepoint-strip');
    assert.equal(parseEmbedPanelId('fear_greed'), 'fear-greed');
    assert.equal(parseEmbedPanelId('x-feed'), null);
    assert.equal(parseEmbedPanelId('intel'), null);
  });

  it('does not allowlist an X / tweet-body panel', () => {
    const ids = listEmbeddablePanels().map((panel) => panel.id);
    assert.equal(ids.some((id) => /x-|twitter|tweet/.test(id)), false);
  });
});
