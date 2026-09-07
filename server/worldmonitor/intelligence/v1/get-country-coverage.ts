/**
 * GetCountryCoverage (#7526) — the country panel's visible coverage set, for
 * agents.
 *
 * The panel already decides which news articles belong to a country, which of
 * them describe an incident, how reprints of one incident collapse, and when a
 * first-party record should take precedence over the news reporting it. Agents
 * had to rebuild all four from broader news operations, so their answers drifted
 * from the UI. This serves the same result from the same rules.
 *
 * Rule ownership, none of it re-implemented here:
 *   country matching   shared/country-headline-match.ts
 *   threat labelling   shared/threat-keyword-classifier.ts
 *   clustering/expiry  shared/country-timeline-events.ts
 *   coverage fetch     ./_country-coverage-feeds.ts (mirrors src/services/country-coverage.ts)
 *   structured records ./_country-coverage-structured.ts
 *
 * Access: Pro, matching the nearest intelligence reads (GetCountryIntelBrief,
 * GetCountryRisk). Only GetSources is anonymous.
 */

import type {
  ServerContext,
  GetCountryCoverageRequest,
  GetCountryCoverageResponse,
  CountryCoverageEvent,
  CountryCoverageHeadline,
  CountryCoverageSourceStatus,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { TIER1_COUNTRIES } from '../../../../src/config/countries';
import { countryDisplayName } from '../../../../shared/country-mention.js';
import { getCountrySearchTerms } from '../../../../shared/country-headline-match';
import {
  reconcileCountryTimelineIncidents,
  type CountryTimelineIncident,
} from '../../../../shared/country-timeline-events';
import { fetchCountryCoverageFeeds } from './_country-coverage-feeds';
import {
  collectStructuredIncidents,
  type StructuredDependencies,
  type StructuredSourceResult,
} from './_country-coverage-structured';

/** The window the country panel renders, and the ceiling the proto enforces. */
export const DEFAULT_WINDOW_HOURS = 168;
export const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 500;

/**
 * Ceiling on the two upstream feed fetches. The panel has no deadline because a
 * browser tab can wait; a request handler cannot. Exceeding it degrades the
 * coverage producers to "failed" rather than failing the whole response — the
 * structured half is still worth serving.
 */
const COVERAGE_FETCH_TIMEOUT_MS = 8_000;

/**
 * The browser tests the loaded country polygon first and falls back to a
 * hand-tuned box. This surface has no polygon, so it uses the generated box for
 * every country. Reported on every response.
 */
const CONTAINMENT = 'bbox';

function isoOrEmpty(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms).toISOString();
}

/** Mirrors CountryIntelManager.resolveCountryName without the browser Intl path. */
export function resolveCountryName(code: string): string {
  const tier1 = TIER1_COUNTRIES[code];
  if (tier1) return tier1;
  const display = countryDisplayName(code);
  return display || code;
}

function toStatus(result: StructuredSourceResult, now: number): CountryCoverageSourceStatus {
  return {
    source: result.source,
    state: result.state,
    detail: result.detail,
    fetchedAt: isoOrEmpty(result.fetchedAtMs),
    ageSeconds: result.fetchedAtMs > 0
      ? Math.max(0, Math.round((now - result.fetchedAtMs) / 1000))
      : 0,
    contributed: result.incidents.length,
  };
}

/**
 * Classify one coverage feed's parse result. `parsedTotal === 0` with a
 * recorded fetch failure is an upstream problem; `parsedTotal > 0` with nothing
 * left after filtering is genuinely quiet coverage.
 */
function coverageStatus(
  source: string,
  result: {
    parsedTotal: number;
    droppedUndated?: number;
    attempt?: { failure: string | null };
  } | null,
  contributed: number,
  failure: string | null,
): CountryCoverageSourceStatus {
  if (failure) {
    return { source, state: 'failed', detail: failure, fetchedAt: '', ageSeconds: 0, contributed: 0 };
  }
  const attemptFailure = result?.attempt?.failure ?? null;
  if (attemptFailure) {
    return {
      source,
      state: 'failed',
      detail: `Coverage feed fetch failed (${attemptFailure}).`,
      fetchedAt: '',
      ageSeconds: 0,
      contributed: 0,
    };
  }
  if (contributed > 0) {
    return { source, state: 'ok', detail: '', fetchedAt: '', ageSeconds: 0, contributed };
  }
  // Every item parsed but every one was dropped for an unusable date. That is a
  // broken feed, not a quiet country — the digest logs the same condition as
  // FEED_HEALTH_WARNING all-undated — so it must not report as `empty`.
  const droppedUndated = result?.droppedUndated ?? 0;
  if (result && result.parsedTotal > 0 && droppedUndated >= result.parsedTotal) {
    return {
      source,
      state: 'failed',
      detail: `The feed responded but all ${droppedUndated} of its items carried an unusable publication date and were dropped. This is not evidence of a quiet period.`,
      fetchedAt: '',
      ageSeconds: 0,
      contributed: 0,
    };
  }
  return {
    source,
    state: result && result.parsedTotal === 0 ? 'unknown' : 'empty',
    detail: result && result.parsedTotal === 0
      ? 'The feed responded but contained no recognizable items, which an upstream block page also looks like. Treat this as unconfirmed rather than quiet.'
      : 'The feed responded with items; none of them matched this country inside the window.',
    fetchedAt: '',
    ageSeconds: 0,
    contributed: 0,
  };
}

function toEvent(
  incident: CountryTimelineIncident,
  origin: 'coverage' | 'structured',
  source: string,
): CountryCoverageEvent {
  return {
    timestampMs: incident.timestamp,
    occurredAt: isoOrEmpty(incident.timestamp),
    lane: incident.lane,
    label: incident.label,
    severity: incident.severity,
    origin,
    source,
  };
}

export interface CountryCoverageDependencies {
  fetchCoverage: typeof fetchCountryCoverageFeeds;
  collectStructured: typeof collectStructuredIncidents;
  structuredDeps?: StructuredDependencies;
  now: () => number;
}

export const defaultCountryCoverageDependencies: CountryCoverageDependencies = {
  fetchCoverage: fetchCountryCoverageFeeds,
  collectStructured: collectStructuredIncidents,
  now: () => Date.now(),
};

export async function getCountryCoverage(
  ctx: ServerContext,
  req: GetCountryCoverageRequest,
  deps: CountryCoverageDependencies = defaultCountryCoverageDependencies,
): Promise<GetCountryCoverageResponse> {
  // The gateway applies the proto's buf.validate rules, but this handler is
  // also called directly (tests, batch). Re-assert the shape here so an
  // unvalidated caller gets the same structured 400 rather than a key-space
  // walk over 1.1M possible strings.
  const code = req.countryCode?.trim().toUpperCase() ?? '';
  if (!/^[A-Z]{2}$/.test(code)) {
    throw new ValidationError([{
      field: 'country_code',
      description: 'country_code must be an ISO 3166-1 alpha-2 code, e.g. "IQ".',
    }]);
  }
  const requestedWindow = Number.isFinite(req.windowHours) ? req.windowHours : 0;
  if (requestedWindow < 0 || requestedWindow > DEFAULT_WINDOW_HOURS) {
    throw new ValidationError([{
      field: 'window_hours',
      description: `window_hours must be between 0 and ${DEFAULT_WINDOW_HOURS}. The upstream coverage query is pinned to 7 days.`,
    }]);
  }
  const requestedLimit = Number.isFinite(req.limit) ? req.limit : 0;
  if (requestedLimit < 0 || requestedLimit > MAX_EVENT_LIMIT) {
    throw new ValidationError([{
      field: 'limit',
      description: `limit must be between 0 and ${MAX_EVENT_LIMIT}.`,
    }]);
  }

  const windowHours = requestedWindow > 0 ? requestedWindow : DEFAULT_WINDOW_HOURS;
  const limit = requestedLimit > 0 ? requestedLimit : DEFAULT_EVENT_LIMIT;
  const now = deps.now();
  const cutoffMs = now - windowHours * 3_600_000;
  const countryName = resolveCountryName(code);
  const searchTerms = getCountrySearchTerms(countryName, code);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COVERAGE_FETCH_TIMEOUT_MS);
  const coveragePromise = deps
    .fetchCoverage(countryName, code, searchTerms, cutoffMs, controller.signal)
    .finally(() => clearTimeout(timer));

  const [coverageSettled, structured] = await Promise.all([
    coveragePromise.then(
      value => ({ ok: true as const, value }),
      error => ({ ok: false as const, error }),
    ),
    deps.collectStructured({
      ctx,
      code,
      countryName,
      cutoffMs,
      now,
      deps: deps.structuredDeps,
    }),
  ]);

  const coverageFailure = coverageSettled.ok
    ? null
    : (coverageSettled.error instanceof Error
      ? `Coverage feeds unavailable: ${coverageSettled.error.message}`
      : 'Coverage feeds unavailable.');
  const coverage = coverageSettled.ok ? coverageSettled.value : null;

  const structuredIncidents: CountryTimelineIncident[] = [];
  const incidentSource = new Map<CountryTimelineIncident, string>();
  for (const result of structured) {
    for (const incident of result.incidents) {
      structuredIncidents.push(incident);
      incidentSource.set(incident, result.source);
    }
  }

  // The panel's visibility gate, applied to both halves before reconciliation:
  // an event with no finite timestamp, or one that fell out of the window, is
  // not visible. Applying it to the structured half BEFORE reconcile is what
  // stops an expired structured record from suppressing a visible coverage
  // event that describes the same incident.
  const isVisible = (event: CountryTimelineIncident): boolean =>
    Number.isFinite(event.timestamp) && event.timestamp >= cutoffMs;

  const visibleStructured = structuredIncidents.filter(isVisible);
  const visibleCoverage = (coverage?.incidents ?? []).filter(isVisible);
  const reconciled = reconcileCountryTimelineIncidents(visibleCoverage, visibleStructured);

  const events: CountryCoverageEvent[] = reconciled.slice(-limit).map((incident) => {
    const source = incidentSource.get(incident);
    return source
      ? toEvent(incident, 'structured', source)
      : toEvent(incident, 'coverage', 'coverage:events');
  });

  const headlines: CountryCoverageHeadline[] = (coverage?.headlines ?? []).map(item => ({
    title: item.title,
    url: item.url,
    source: item.source,
    publishedAt: isoOrEmpty(item.publishedAtMs),
    publishedAtMs: item.publishedAtMs,
  }));

  const sources: CountryCoverageSourceStatus[] = [
    coverageStatus('coverage:headlines', coverage?.headlineResult ?? null, headlines.length, coverageFailure),
    coverageStatus('coverage:events', coverage?.eventResult ?? null, visibleCoverage.length, coverageFailure),
    ...structured.map(result => toStatus(result, now)),
  ];

  return {
    countryCode: code,
    countryName,
    windowHours,
    generatedAt: new Date(now).toISOString(),
    headlines,
    events,
    sources,
    // `unknown` degrades too. It means a producer returned nothing and this
    // surface could not confirm its upstream was reachable — precisely the case
    // an agent would otherwise read as a quiet week.
    degraded: sources.some(s => s.state !== 'ok' && s.state !== 'empty'),
    containment: CONTAINMENT,
  };
}
