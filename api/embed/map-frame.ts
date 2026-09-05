/**
 * GET /api/embed/map-frame?layers=…
 *
 * The single endpoint the partner map frame polls, replacing four separate
 * anonymous RPC calls. A credential published in partner HTML has a blast
 * radius equal to the set of paths that accept it, so there is one path and it
 * accepts one parameter.
 *
 * Two tiers, and the URL — not a header — decides which:
 *
 *   `?public=1`   keyless. Three layers, hourly, shared-cacheable, per-IP
 *                 rate limited. Attached credentials are IGNORED on this URL,
 *                 because a CDN hit happens before this function sees them and
 *                 a cached body must mean the same thing for every caller.
 *                 Same marker convention as the public bootstrap read (#5386).
 *   no marker     keyed. Requires a valid `wmg_` grant for the map panel;
 *                 all fourteen layers at the ten-minute cadence, and the
 *                 response is `private` so no shared cache can hold it.
 *
 * The keyless tier is a deliberate growth surface, not a degraded error state:
 * it must keep working with no credential at all.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from '../_cors.js';
import { checkEndpointRateLimit } from '../../server/_shared/rate-limit';
import { getCachedJson } from '../../server/_shared/redis';
import { BOOTSTRAP_CACHE_KEYS } from '../../shared/bootstrap-tier-keys.js';
import { verifyEmbedGrant } from '../../server/_shared/embed-grant';
import {
  composeEmbedMapFrame,
  parseRequestedLayers,
  refreshMsForTier,
  type EmbedMapFrameSources,
  type EmbedMapFrameTier,
} from '../../server/_shared/embed-map-frame';
import { listAcledEvents } from '../../server/worldmonitor/conflict/v1/list-acled-events';
import { listEarthquakes } from '../../server/worldmonitor/seismology/v1/list-earthquakes';
import { listNaturalEvents } from '../../server/worldmonitor/natural/v1/list-natural-events';
import { listUnrestEvents } from '../../server/worldmonitor/unrest/v1/list-unrest-events';

const MAP_FRAME_PATH = '/api/embed/map-frame';
const WEATHER_CACHE_KEY = BOOTSTRAP_CACHE_KEYS.weatherAlerts;

/**
 * Handlers ignore their context — every one of them takes `_ctx` — but the
 * generated signatures require it, so build the minimum that satisfies them.
 */
function handlerContext(req: Request) {
  return { request: req, pathParams: {}, headers: Object.fromEntries(req.headers) };
}

function buildSources(req: Request): EmbedMapFrameSources {
  const ctx = handlerContext(req);
  // Each upstream is called with ITS OWN defaults — zeros mean "handler
  // default" across these generated requests. Forwarding a caller-supplied
  // window or page size here would hand a stolen credential the knobs this
  // endpoint exists to remove.
  return {
    listConflicts: async () =>
      (await listAcledEvents(ctx, { start: 0, end: 0, pageSize: 0, cursor: '', country: '' })).events,
    listEarthquakes: async () =>
      (await listEarthquakes(ctx, { minMagnitude: 0, start: 0, end: 0, pageSize: 0, cursor: '' })).earthquakes,
    listNaturalEvents: async () => (await listNaturalEvents(ctx, { days: 30 })).events,
    listProtests: async () =>
      (await listUnrestEvents(ctx, {
        country: '',
        start: 0,
        end: 0,
        pageSize: 0,
        cursor: '',
        // The handler reads neither the bbox nor minSeverity; these are here
        // only to satisfy the generated request type. Kept at their zero values
        // so that if it ever starts reading them, the embed asks for no filter
        // rather than silently inheriting one.
        minSeverity: 'SEVERITY_LEVEL_UNSPECIFIED',
        neLat: 0,
        neLon: 0,
        swLat: 0,
        swLon: 0,
      })).events,
    listWeatherAlerts: async () => {
      const cached = await getCachedJson(WEATHER_CACHE_KEY, true) as { alerts?: unknown[] } | null;
      return cached?.alerts ?? [];
    },
  };
}

function grantFromHeaders(headers: Headers): string | null {
  const grant = (headers.get('X-WorldMonitor-Grant') ?? '').trim();
  return grant || null;
}

export default async function handler(req: Request): Promise<Response> {
  const cors = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Allow: 'GET, HEAD, OPTIONS' },
    });
  }

  const url = new URL(req.url);
  const isPublicUrl = url.searchParams.get('public') === '1';

  let tier: EmbedMapFrameTier = 'free';
  if (!isPublicUrl) {
    const claims = await verifyEmbedGrant(grantFromHeaders(req.headers));
    // An absent or expired grant is not an error: it drops to the free tier,
    // which is what the frame renders while it re-mints. A grant minted for a
    // different panel does not unlock this one.
    if (claims && claims.panel === 'map') tier = 'keyed';
  }

  // Per-IP budget on the keyless path only. A keyed frame polls on a
  // grant-scoped cadence and shares an egress IP with every other viewer of
  // the same partner page, so metering it per IP would throttle the customer
  // rather than an abuser.
  if (tier === 'free') {
    const limited = await checkEndpointRateLimit(req, MAP_FRAME_PATH, cors);
    if (limited) return limited;
  }

  const layers = parseRequestedLayers(url.searchParams.get('layers'));
  const frame = await composeEmbedMapFrame(layers, tier, buildSources(req));

  const cacheControl = tier === 'free'
    // Shared-cacheable for the full hourly window, with a stale-serve grace so
    // a wall display keeps rendering through an origin blip. These responses
    // are `cf-cache-status: DYNAMIC` today precisely because nothing declared
    // a shared lifetime.
    ? `public, max-age=60, s-maxage=${Math.floor(refreshMsForTier('free') / 1000)}, stale-while-revalidate=600`
    // Never shared: the URL without the marker is the one a credential rides,
    // and a shared cache keyed on it would serve fourteen layers to a caller
    // who presented nothing.
    : `private, max-age=${Math.floor(refreshMsForTier('keyed') / 1000)}`;

  return new Response(JSON.stringify(frame), {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/json',
      'Cache-Control': cacheControl,
      // The tier is part of what makes this body correct; make it visible to
      // caches and to anyone debugging a partner page.
      Vary: 'X-WorldMonitor-Grant',
    },
  });
}
