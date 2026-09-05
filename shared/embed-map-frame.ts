/**
 * Wire contract for `GET /api/embed/map-frame` — the one endpoint the partner
 * map frame polls, replacing four separate anonymous RPC calls.
 *
 * One endpoint rather than four because a credential published in partner HTML
 * has a blast radius equal to the set of paths that accept it. Keep this module
 * free of browser and server imports: the edge composes the response and the
 * embed entry consumes it.
 */

import type { EmbedLayerId } from './embed-panels';

/**
 * Per-layer outcome.
 *
 * `partial` exists because the earthquakes layer draws on two upstreams
 * (seismic events and natural events); reporting it as `ok` would claim data
 * the frame did not receive, and as `unavailable` would hide data it did.
 */
export type EmbedMapFrameLayerState = 'ok' | 'partial' | 'unavailable' | 'not-entitled';

/**
 * Upstream payloads, verbatim.
 *
 * Each is the exact wire shape its RPC already returns, so the composed
 * endpoint is a fan-out over the SAME handlers rather than a second
 * implementation of the data path, and the client keeps the mappers it
 * already has. Typed loosely here only because element types live in
 * `src/generated/`, which this module must not reach into; the edge produces
 * them fully typed and the client narrows them at the parse boundary.
 */
export interface EmbedMapFrameData {
  conflicts?: readonly unknown[];
  earthquakes?: readonly unknown[];
  naturalEvents?: readonly unknown[];
  protests?: readonly unknown[];
  weatherAlerts?: readonly unknown[];
}

export interface EmbedMapFrameResponse {
  /** Which policy produced this body — the client does not infer it. */
  tier: 'free' | 'keyed';
  /** Poll interval for this tier, so the cadence is server-owned. */
  refreshMs: number;
  generatedAt: number;
  /**
   * State for every layer the caller asked for, entitled or not. A partial
   * upstream failure ships here as data rather than failing the whole frame:
   * a wall display showing three of four layers beats a blank one.
   */
  layers: Partial<Record<EmbedLayerId, EmbedMapFrameLayerState>>;
  data: EmbedMapFrameData;
}
