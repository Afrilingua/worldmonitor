import type { EmbedLayerId, EmbedPanelId } from '../../shared/embed-panels';
import type { EmbedMapFrameResponse } from '../../shared/embed-map-frame';

export interface EmbedGrant {
  token: string;
  expiresAt: number;
}

/**
 * Outcome of the key → grant exchange.
 *
 * `denied` and `unavailable` are deliberately different: a denial is terminal,
 * so the frame drops to the free tier, while an unavailable answer means we
 * could not find out and the frame keeps its last render rather than blanking
 * a customer's wall display over a transient billing lookup.
 */
export type EmbedGrantResult =
  | { status: 'granted'; grant: EmbedGrant }
  | { status: 'denied' }
  | { status: 'unavailable'; retryAfterMs: number };

const DEFAULT_GRANT_RETRY_MS = 60_000;
/** Re-mint slightly early so a poll never races the expiry. */
const GRANT_RENEW_SKEW_MS = 60_000;

export interface EmbedEntitlementResponse {
  allowed: boolean;
  panel?: EmbedPanelId;
  public?: boolean;
  accountId?: string;
  error?: string;
}

/**
 * Fetch wrapper for keyed embed RPCs. Always omits cookies so a logged-in
 * World Monitor viewer cannot authenticate the partner's embed as themselves.
 */
export function createKeyedEmbedFetch(apiKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers.set(key, value);
      });
    }
    headers.set('X-WorldMonitor-Key', apiKey);
    return globalThis.fetch(input, { ...init, headers, credentials: 'omit' });
  };
}

export async function fetchEmbedEntitlement(
  panel: EmbedPanelId,
  apiKey: string | null,
): Promise<{ ok: boolean; status: number; body: EmbedEntitlementResponse }> {
  const url = new URL('/api/embed/entitlement', window.location.origin);
  url.searchParams.set('panel', panel);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers['X-WorldMonitor-Key'] = apiKey;
  const resp = await globalThis.fetch(url.toString(), {
    method: 'GET',
    headers,
    credentials: 'omit',
  });
  let body: EmbedEntitlementResponse = { allowed: false };
  try {
    const parsed: unknown = await resp.json();
    if (parsed && typeof parsed === 'object') {
      body = parsed as EmbedEntitlementResponse;
    }
  } catch {
    body = { allowed: false, error: 'invalid_entitlement_response' };
  }
  return { ok: resp.ok && body.allowed === true, status: resp.status, body };
}

/**
 * Exchange the embedding account's `wme_` key for a short-lived, panel-scoped
 * grant. Called once at frame boot and again when the grant nears expiry, so
 * the key itself never rides a poll.
 */
export async function mintEmbedGrant(
  panel: EmbedPanelId,
  apiKey: string,
): Promise<EmbedGrantResult> {
  const url = new URL('/api/embed/session', window.location.origin);
  url.searchParams.set('panel', panel);

  let resp: Response;
  try {
    resp = await globalThis.fetch(url.toString(), {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-WorldMonitor-Key': apiKey },
      credentials: 'omit',
    });
  } catch {
    // A network failure says nothing about entitlement, so it must not be
    // read as a denial.
    return { status: 'unavailable', retryAfterMs: DEFAULT_GRANT_RETRY_MS };
  }

  if (resp.status === 503) {
    const header = Number(resp.headers.get('Retry-After'));
    return {
      status: 'unavailable',
      retryAfterMs: Number.isFinite(header) && header > 0 ? header * 1000 : DEFAULT_GRANT_RETRY_MS,
    };
  }
  if (!resp.ok) return { status: 'denied' };

  let body: { grant?: unknown; expiresAt?: unknown };
  try {
    body = await resp.json() as { grant?: unknown; expiresAt?: unknown };
  } catch {
    return { status: 'unavailable', retryAfterMs: DEFAULT_GRANT_RETRY_MS };
  }
  if (typeof body.grant !== 'string' || typeof body.expiresAt !== 'number') {
    return { status: 'unavailable', retryAfterMs: DEFAULT_GRANT_RETRY_MS };
  }
  return { status: 'granted', grant: { token: body.grant, expiresAt: body.expiresAt } };
}

export function isEmbedGrantExpiring(grant: EmbedGrant, now = Date.now()): boolean {
  return grant.expiresAt - now <= GRANT_RENEW_SKEW_MS;
}

/**
 * Fetch the composed map frame.
 *
 * With no grant the request carries the `public=1` marker, which is what makes
 * the response shared-cacheable — a header cannot do that job, because a CDN
 * hit is decided before the origin sees one.
 */
export async function fetchEmbedMapFrame(
  layerIds: readonly EmbedLayerId[],
  grant: EmbedGrant | null,
): Promise<EmbedMapFrameResponse> {
  const url = new URL('/api/embed/map-frame', window.location.origin);
  url.searchParams.set('layers', [...new Set(layerIds)].join(','));
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (grant) headers['X-WorldMonitor-Grant'] = grant.token;
  else url.searchParams.set('public', '1');

  const resp = await globalThis.fetch(url.toString(), {
    method: 'GET',
    headers,
    credentials: 'omit',
  });
  if (!resp.ok) throw new Error(`Embed map frame request failed: ${resp.status}`);
  return await resp.json() as EmbedMapFrameResponse;
}
