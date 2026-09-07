/**
 * The structured half of GetCountryCoverage (#7526).
 *
 * The country panel reconciles its news coverage against five first-party
 * caches it already holds in the browser. This module reads the same five on
 * the server and shapes them into the same `CountryTimelineIncident` records,
 * so `reconcileCountryTimelineIncidents` can give a structured record precedence
 * over the news reprint that describes it.
 *
 * Every producer reports its own state. A producer that failed, or that this
 * surface cannot reach at all, is never allowed to look like a quiet one — an
 * agent reading `events: []` must be able to tell "nothing happened" from
 * "the protest seeder is down".
 *
 * Containment: the browser tests the loaded country polygon and falls back to a
 * hand-tuned box; the server has no polygon, so it uses the generated
 * shared/country-bboxes.js box for every country. That is reported to the
 * caller in the response's `containment` field rather than hidden.
 */

import COUNTRY_BBOXES from '../../../../shared/country-bboxes.js';
import { resolveCountryCode } from '../../../../shared/country-code-resolve';
import type {
  CountryTimelineIncident,
  CountryTimelineSeverity,
} from '../../../../shared/country-timeline-events';
import { readCachedEnvelopeJson } from '../../../_shared/redis';
import { listUnrestEvents } from '../../unrest/v1/list-unrest-events';
import { listEarthquakes } from '../../seismology/v1/list-earthquakes';
import { listAcledEvents } from '../../conflict/v1/list-acled-events';
import { listIranEvents } from '../../conflict/v1/list-iran-events';
import { listMilitaryFlights } from '../../military/v1/list-military-flights';
import type { ServerContext } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

export type CoverageSourceState = 'ok' | 'empty' | 'stale' | 'failed' | 'unavailable';

export interface StructuredSourceResult {
  source: string;
  state: CoverageSourceState;
  detail: string;
  /** Unix ms the producer's snapshot was gathered, or 0 when unknown. */
  fetchedAtMs: number;
  incidents: CountryTimelineIncident[];
}

/** Seed keys whose envelope carries the `_seed.fetchedAt` stamp we age against. */
const UNREST_SEED_KEY = 'unrest:events:v1';
const EARTHQUAKE_SEED_KEY = 'seismology:earthquakes:v1';
const ACLED_SEED_KEY = 'conflict:acled-events:v1';

/**
 * Per-producer freshness budget. Exceeding it downgrades the producer to
 * "stale" — it still contributes, exactly as the panel still renders whatever
 * its cache holds, but the caller is told.
 */
const STALE_AFTER_MS: Record<string, number> = {
  'structured:protests': 24 * 60 * 60 * 1000,
  'structured:earthquakes': 6 * 60 * 60 * 1000,
  'structured:conflicts': 48 * 60 * 60 * 1000,
};

export interface CountryBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** shared/country-bboxes.js stores [south_lat, west_lon, north_lat, east_lon]. */
export function countryBox(code: string): CountryBox | null {
  const bbox = COUNTRY_BBOXES[code.toUpperCase()];
  if (!bbox) return null;
  const [south, west, north, east] = bbox;
  return { south, west, north, east };
}

export function inBox(
  box: CountryBox | null,
  lat: number | undefined,
  lon: number | undefined,
): boolean {
  if (!box || !Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return lat! >= box.south && lat! <= box.north && lon! >= box.west && lon! <= box.east;
}

/** Read a seed key's envelope stamp without disturbing the handler's own read. */
async function seedFetchedAt(key: string): Promise<number> {
  try {
    const read = await readCachedEnvelopeJson(key, true);
    if (read.status !== 'hit') return 0;
    const envelope = read.value as { _seed?: { fetchedAt?: unknown } } | null;
    const fetchedAt = envelope?._seed?.fetchedAt;
    return typeof fetchedAt === 'number' && Number.isFinite(fetchedAt) ? fetchedAt : 0;
  } catch {
    return 0;
  }
}

function settle(
  source: string,
  incidents: CountryTimelineIncident[],
  fetchedAtMs: number,
  now: number,
): StructuredSourceResult {
  const budget = STALE_AFTER_MS[source];
  if (budget && fetchedAtMs > 0 && now - fetchedAtMs > budget) {
    const hours = Math.round((now - fetchedAtMs) / 3_600_000);
    return {
      source,
      state: 'stale',
      detail: `Snapshot is ${hours}h old, past this producer's ${Math.round(budget / 3_600_000)}h budget. Events are still included.`,
      fetchedAtMs,
      incidents,
    };
  }
  if (incidents.length > 0) {
    return { source, state: 'ok', detail: '', fetchedAtMs, incidents };
  }
  // An empty producer says so in words too. "Read `sources` before concluding
  // anything from an empty events list" is only actionable if every non-ok
  // state carries its reason, and `empty` is the one a caller is most likely
  // to misread as healthy silence.
  return {
    source,
    state: 'empty',
    detail: 'The producer responded; nothing in it matched this country inside the window.',
    fetchedAtMs,
    incidents,
  };
}

function failed(source: string, detail: string): StructuredSourceResult {
  return { source, state: 'failed', detail, fetchedAtMs: 0, incidents: [] };
}

function unavailable(source: string, detail: string): StructuredSourceResult {
  return { source, state: 'unavailable', detail, fetchedAtMs: 0, incidents: [] };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : 'Upstream read failed.';
}

/** Mirrors the panel's protest severity ternary. */
function unrestSeverity(severity: string): CountryTimelineSeverity {
  if (severity === 'SEVERITY_LEVEL_HIGH') return 'high';
  if (severity === 'SEVERITY_LEVEL_MEDIUM') return 'medium';
  return 'low';
}

/** `UNREST_EVENT_TYPE_CIVIL_UNREST` reads as `civil unrest` in a label. */
function unrestEventLabel(eventType: string): string {
  return eventType.replace(/^UNREST_EVENT_TYPE_/, '').toLowerCase().replace(/_/g, ' ');
}

/** Mirrors mapProtoEventType in src/services/conflict/index.ts. */
function acledEventType(eventType: string): string {
  const lower = eventType.toLowerCase();
  if (lower.includes('battle')) return 'battle';
  if (lower.includes('explosion')) return 'explosion';
  if (lower.includes('remote violence')) return 'remote_violence';
  if (lower.includes('violence against')) return 'violence_against_civilians';
  return 'battle';
}

export interface StructuredDependencies {
  listUnrestEvents: typeof listUnrestEvents;
  listEarthquakes: typeof listEarthquakes;
  listAcledEvents: typeof listAcledEvents;
  listIranEvents: typeof listIranEvents;
  listMilitaryFlights: typeof listMilitaryFlights;
  seedFetchedAt: (key: string) => Promise<number>;
}

export const defaultStructuredDependencies: StructuredDependencies = {
  listUnrestEvents,
  listEarthquakes,
  listAcledEvents,
  listIranEvents,
  listMilitaryFlights,
  seedFetchedAt,
};

export interface StructuredRequest {
  ctx: ServerContext;
  code: string;
  countryName: string;
  cutoffMs: number;
  now: number;
  deps?: StructuredDependencies;
}

async function collectProtests(req: StructuredRequest, box: CountryBox | null): Promise<StructuredSourceResult> {
  const source = 'structured:protests';
  const deps = req.deps ?? defaultStructuredDependencies;
  try {
    const [response, fetchedAtMs] = await Promise.all([
      // country: '' — the seed's own filter is a name substring match, which
      // would miss an event geolocated inside the country but labelled with a
      // neighbouring one. Filter here instead, the way the panel does.
      deps.listUnrestEvents(req.ctx, {
        country: '',
        start: 0,
        end: 0,
        pageSize: 0,
        cursor: '',
        minSeverity: 'SEVERITY_LEVEL_UNSPECIFIED',
        neLat: 0,
        neLon: 0,
        swLat: 0,
        swLon: 0,
      }),
      deps.seedFetchedAt(UNREST_SEED_KEY),
    ]);
    const countryLower = req.countryName.toLowerCase();
    const incidents: CountryTimelineIncident[] = [];
    for (const event of response.events) {
      const matches = event.country?.toLowerCase() === countryLower
        || inBox(box, event.location?.latitude, event.location?.longitude);
      if (!matches) continue;
      if (!Number.isFinite(event.occurredAt) || event.occurredAt < req.cutoffMs) continue;
      incidents.push({
        timestamp: event.occurredAt,
        lane: 'protest',
        label: event.title
          || `${unrestEventLabel(event.eventType)} in ${event.city || event.country}`,
        severity: unrestSeverity(event.severity),
      });
    }
    return settle(source, incidents, fetchedAtMs, req.now);
  } catch (error) {
    return failed(source, errorDetail(error));
  }
}

async function collectEarthquakes(req: StructuredRequest, box: CountryBox | null): Promise<StructuredSourceResult> {
  const source = 'structured:earthquakes';
  const deps = req.deps ?? defaultStructuredDependencies;
  try {
    const [response, fetchedAtMs] = await Promise.all([
      deps.listEarthquakes(req.ctx, { start: 0, end: 0, pageSize: 0, cursor: '', minMagnitude: 0 }),
      deps.seedFetchedAt(EARTHQUAKE_SEED_KEY),
    ]);
    const countryLower = req.countryName.toLowerCase();
    const incidents: CountryTimelineIncident[] = [];
    for (const quake of response.earthquakes) {
      const matches = inBox(box, quake.location?.latitude, quake.location?.longitude)
        || quake.place?.toLowerCase().includes(countryLower) === true;
      if (!matches) continue;
      if (!Number.isFinite(quake.occurredAt) || quake.occurredAt < req.cutoffMs) continue;
      incidents.push({
        timestamp: quake.occurredAt,
        lane: 'natural',
        label: `M${quake.magnitude.toFixed(1)} ${quake.place}`,
        severity: quake.magnitude >= 6
          ? 'critical'
          : quake.magnitude >= 5 ? 'high' : quake.magnitude >= 4 ? 'medium' : 'low',
      });
    }
    return settle(source, incidents, fetchedAtMs, req.now);
  } catch (error) {
    return failed(source, errorDetail(error));
  }
}

async function collectConflicts(req: StructuredRequest): Promise<StructuredSourceResult> {
  const source = 'structured:conflicts';
  const deps = req.deps ?? defaultStructuredDependencies;
  try {
    const [response, fetchedAtMs] = await Promise.all([
      deps.listAcledEvents(req.ctx, { country: '', start: 0, end: 0, pageSize: 0, cursor: '' }),
      deps.seedFetchedAt(ACLED_SEED_KEY),
    ]);
    const incidents: CountryTimelineIncident[] = [];
    for (const event of response.events) {
      // The panel groups ACLED rows with the CII name->code map. This surface
      // uses the canonical server resolver, so a name ACLED spells differently
      // still lands on the right country.
      if (resolveCountryCode(event.country) !== req.code) continue;
      if (!Number.isFinite(event.occurredAt) || event.occurredAt < req.cutoffMs) continue;
      incidents.push({
        timestamp: event.occurredAt,
        lane: 'conflict',
        // Mirrors the panel's `${eventType}: ${location || country}` — the
        // client adapter always sets `location` to '', so this is the country.
        label: `${acledEventType(event.eventType)}: ${event.country}`,
        severity: event.fatalities > 0 ? 'critical' : 'high',
      });
    }
    return settle(source, incidents, fetchedAtMs, req.now);
  } catch (error) {
    return failed(source, errorDetail(error));
  }
}

async function collectMilitaryFlights(
  req: StructuredRequest,
  box: CountryBox | null,
): Promise<StructuredSourceResult> {
  const source = 'structured:military-flights';
  const deps = req.deps ?? defaultStructuredDependencies;
  if (!box) {
    return unavailable(source, `No bounding box for ${req.code}; military flights are matched geographically only.`);
  }
  try {
    const response = await deps.listMilitaryFlights(req.ctx, {
      pageSize: 0,
      cursor: '',
      neLat: box.north,
      neLon: box.east,
      swLat: box.south,
      swLon: box.west,
      operator: 'MILITARY_OPERATOR_UNSPECIFIED',
      aircraftType: 'MILITARY_AIRCRAFT_TYPE_UNSPECIFIED',
    });
    const incidents: CountryTimelineIncident[] = [];
    for (const flight of response.flights) {
      if (!Number.isFinite(flight.lastSeenAt) || flight.lastSeenAt < req.cutoffMs) continue;
      incidents.push({
        timestamp: flight.lastSeenAt,
        lane: 'military',
        label: `${flight.callsign} (${flight.aircraftModel || flight.aircraftType})`,
        severity: flight.isInteresting ? 'high' : 'low',
      });
    }
    // The flights RPC serves a live snapshot and reports no gather time, so
    // there is no fetchedAt to claim. Reporting the newest position instead
    // would read as "gathered then", which is a different fact.
    return settle(source, incidents, 0, req.now);
  } catch (error) {
    return failed(source, errorDetail(error));
  }
}

async function collectStrikes(req: StructuredRequest, box: CountryBox | null): Promise<StructuredSourceResult> {
  const source = 'structured:strikes';
  const deps = req.deps ?? defaultStructuredDependencies;
  try {
    const response = await deps.listIranEvents(req.ctx, {});
    // Both sides of this lane sit behind a default-off flag after the 2026-07
    // sunset: VITE_ENABLE_IRAN_ATTACKS in the browser, IRAN_EVENTS_ENABLED
    // here. The disabled handler returns the `scrapedAt: '0'` sentinel, which
    // is what distinguishes "retired" from "enabled but quiet" — an empty list
    // alone means neither, and reading it as retired would mislabel a healthy
    // quiet week.
    if (response.scrapedAt === '0') {
      return unavailable(source, 'Middle East strike tracking is retired (IRAN_EVENTS_ENABLED off).');
    }
    const seen = new Set<string>();
    const incidents: CountryTimelineIncident[] = [];
    for (const event of response.events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      if (!inBox(box, event.latitude, event.longitude)) continue;
      // The panel normalizes a seconds-precision stamp to milliseconds.
      const raw = Number(event.timestamp) || 0;
      const timestamp = raw < 1e12 ? raw * 1000 : raw;
      if (timestamp < req.cutoffMs) continue;
      incidents.push({
        timestamp,
        lane: 'conflict',
        label: event.title || `Strike: ${event.locationName}`,
        severity: (event.severity.toLowerCase() === 'high' || event.severity.toLowerCase() === 'critical')
          ? 'critical'
          : 'high',
      });
    }
    return settle(source, incidents, 0, req.now);
  } catch (error) {
    return failed(source, errorDetail(error));
  }
}

/**
 * The browser builds this lane from a live AIS WebSocket it holds open for the
 * session (src/services/military-vessels.ts keeps `trackedVessels` in memory).
 * No server surface holds that stream, and the maritime vessel snapshot RPC
 * serves density zones rather than per-vessel positions, so there is nothing
 * equivalent to read. Declared explicitly so the gap is visible in the response
 * instead of showing up as a silently shorter military lane.
 */
function militaryVesselsUnavailable(): StructuredSourceResult {
  return unavailable(
    'structured:military-vessels',
    'The vessel lane comes from a browser-held live AIS stream that has no server-side equivalent.',
  );
}

export async function collectStructuredIncidents(
  req: StructuredRequest,
): Promise<StructuredSourceResult[]> {
  const box = countryBox(req.code);
  const [protests, earthquakes, conflicts, flights, strikes] = await Promise.all([
    collectProtests(req, box),
    collectEarthquakes(req, box),
    collectConflicts(req),
    collectMilitaryFlights(req, box),
    collectStrikes(req, box),
  ]);
  return [protests, earthquakes, conflicts, flights, militaryVesselsUnavailable(), strikes];
}
