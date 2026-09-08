/**
 * ListInternetDdosAttacks RPC -- reads seeded DDoS summary data from Railway seed cache.
 * All external Cloudflare Radar API calls happen in seed-internet-outages.mjs on Railway.
 */

import {
  ApiError,
  type ServerContext,
  type ListInternetDdosAttacksRequest,
  type ListInternetDdosAttacksResponse,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';

import { readCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'cf:radar:ddos:v1';

export async function listInternetDdosAttacks(
  _ctx: ServerContext,
  _req: ListInternetDdosAttacksRequest,
): Promise<ListInternetDdosAttacksResponse> {
  const cached = await readCachedJson(SEED_CACHE_KEY, true);
  const data = cached.status === 'hit' ? cached.value as Partial<ListInternetDdosAttacksResponse> | null : null;
  if (!data || !Array.isArray(data.protocol) || !Array.isArray(data.vector)
    || typeof data.dateRangeStart !== 'string' || typeof data.dateRangeEnd !== 'string'
    || !Array.isArray(data.topTargetLocations)) {
    throw new ApiError(503, 'DDoS summary cache unavailable', '');
  }
  return {
    protocol: data.protocol,
    vector: data.vector,
    dateRangeStart: data.dateRangeStart,
    dateRangeEnd: data.dateRangeEnd,
    topTargetLocations: data.topTargetLocations,
  };
}
