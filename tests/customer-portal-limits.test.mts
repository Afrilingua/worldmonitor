import assert from 'node:assert/strict';
import { after, it } from 'node:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

process.env.CLERK_JWT_ISSUER_DOMAIN = 'https://clerk.portal.test';
process.env.CONVEX_SITE_URL = 'https://portal.convex.site';
process.env.RELAY_SHARED_SECRET = 'synthetic-relay-secret';
process.env.UPSTASH_REDIS_REST_URL = 'https://portal-redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic-redis-token';
const { default: handler } = await import('../api/customer-portal.ts');
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

it('limits portal sessions per authenticated user before the relay, across tokens and IPs', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'portal-test', alg: 'RS256' };
  let relayCalls = 0;
  const buckets = new Map<string, number>();
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://clerk.portal.test')) return Response.json({ keys: [jwk] });
    if (url.startsWith('https://portal-redis.test')) {
      const commands = JSON.parse(String(init?.body));
      return Response.json(commands.map((command: unknown[]) => {
        const key = String(command[3]);
        const count = (buckets.get(key) ?? 0) + 1;
        buckets.set(key, count);
        return { result: [5 - count, 5] };
      }));
    }
    assert.equal(url, 'https://portal.convex.site/relay/customer-portal');
    relayCalls++;
    return Response.json({ url: 'https://billing.test/session' });
  };
  for (let i = 0; i < 7; i++) {
    const token = await new SignJWT({ sub: 'user_portal', plan: 'pro', jti: String(i) })
      .setProtectedHeader({ alg: 'RS256', kid: 'portal-test' })
      .setIssuer('https://clerk.portal.test').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const res = await handler(new Request('https://worldmonitor.app/api/customer-portal', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'x-real-ip': `192.0.2.${i + 1}` },
    }));
    assert.equal(res.status, i < 5 ? 200 : 429);
    if (i >= 5) assert.ok(res.headers.get('Retry-After'));
  }
  assert.equal(relayCalls, 5);
  const healthyFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith('https://portal-redis.test')) throw new Error('Redis unavailable');
    return healthyFetch(input, init);
  };
  const token = await new SignJWT({ sub: 'other_user', plan: 'pro' })
    .setProtectedHeader({ alg: 'RS256', kid: 'portal-test' })
    .setIssuer('https://clerk.portal.test').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const unavailable = await handler(new Request('https://worldmonitor.app/api/customer-portal', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  }));
  // The limiter caches its configured client; an unavailable Redis still fails closed.
  assert.equal(relayCalls, 5);
  assert.ok([429, 503].includes(unavailable.status));
});
