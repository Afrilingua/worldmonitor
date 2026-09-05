/**
 * Partner-embed entitlement: keyed to the embedding account's API key, never
 * to the page visitor's World Monitor session.
 */

import {
  parseEmbedPanelId,
  getEmbedPanelFreeTier,
  type EmbedPanelId,
} from '../../shared/embed-panels';
import { hasAccountEmbedAccess, hasEmbedAccess } from '../../shared/embed-access';
import type { ClerkPlanLookupResult } from '../auth-session';
import type { CachedEntitlements } from './entitlement-check';
import { isUserApiKeyUnavailableError } from './user-api-key';

export interface EmbedEntitlementBody {
  allowed: boolean;
  panel?: EmbedPanelId;
  public?: boolean;
  accountId?: string;
  error?: string;
}

export interface EmbedEntitlementResult {
  status: 200 | 401 | 403 | 404 | 503;
  body: EmbedEntitlementBody;
}

export interface EmbedEntitlementDeps {
  getValidEnterpriseKeys: () => string[];
  timingSafeIncludes: (candidate: string, keys: readonly string[]) => Promise<boolean>;
  validateUserApiKey: (key: string) => Promise<{ userId: string } | null>;
  getEntitlements: (userId: string) => Promise<CachedEntitlements | null>;
  getAccountPlan: (userId: string) => Promise<ClerkPlanLookupResult>;
  isEntitlementBackendConfigured: () => boolean;
}

export function parseEnterpriseApiKeys(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((key) => key.trim()).filter(Boolean);
}

export async function evaluateEmbedEntitlement(
  panelParam: string | null,
  apiKey: string | null,
  deps: EmbedEntitlementDeps,
): Promise<EmbedEntitlementResult> {
  const panel = parseEmbedPanelId(panelParam);
  if (!panel) {
    return { status: 404, body: { allowed: false, error: 'unknown_panel' } };
  }

  // A panel with a free tier clears its own floor keylessly, so this endpoint
  // answers `public` without touching the credential — including when one was
  // supplied. Upgrading to the paid tier is `POST /api/embed/session`'s job,
  // which keeps key validation and lapse handling on ONE path; answering it
  // here too would mean a partner whose key lapsed loses the free render they
  // are still entitled to.
  if (getEmbedPanelFreeTier(panel) !== null) {
    return { status: 200, body: { allowed: true, panel, public: true } };
  }

  if (!apiKey) {
    return { status: 401, body: { allowed: false, error: 'embedding_api_key_required' } };
  }
  if (apiKey.startsWith('wms_')) {
    return { status: 401, body: { allowed: false, error: 'session_token_not_allowed' } };
  }

  const enterpriseKeys = deps.getValidEnterpriseKeys();
  if (enterpriseKeys.length > 0 && await deps.timingSafeIncludes(apiKey, enterpriseKeys)) {
    return { status: 200, body: { allowed: true, panel, public: false, accountId: 'enterprise' } };
  }

  try {
    const userKey = await deps.validateUserApiKey(apiKey);
    if (!userKey) {
      return { status: 401, body: { allowed: false, error: 'invalid_embedding_api_key' } };
    }
    const entitlements = await deps.getEntitlements(userKey.userId);
    const now = Date.now();
    if (hasEmbedAccess(entitlements, now)) {
      return { status: 200, body: { allowed: true, panel, public: false, accountId: userKey.userId } };
    }

    const accountPlan = await deps.getAccountPlan(userKey.userId);
    if (accountPlan === 'unavailable') {
      return { status: 503, body: { allowed: false, error: 'account_verification_unavailable' } };
    }
    if (hasAccountEmbedAccess(accountPlan, entitlements, now)) {
      return { status: 200, body: { allowed: true, panel, public: false, accountId: userKey.userId } };
    }
    if (entitlements?.verificationUnavailable || (!entitlements && !deps.isEntitlementBackendConfigured())) {
      return { status: 503, body: { allowed: false, error: 'entitlement_verification_unavailable' } };
    }
    return { status: 403, body: { allowed: false, error: 'embed_not_entitled' } };
  } catch (error) {
    if (isUserApiKeyUnavailableError(error)) {
      return { status: 503, body: { allowed: false, error: 'key_validation_unavailable' } };
    }
    throw error;
  }
}
