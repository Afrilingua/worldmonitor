import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { BrowserClient, Scope } from '@sentry/browser';
import { getSentryBuildMetadata, isolateNonProductionSentryEvent } from '../shared/sentry-build-metadata';

const originalEnv = { ...process.env };
const sha = '0123456789abcdef0123456789abcdef01234567';
let scratch: string;
let loadDashboard: Function;
let marketingConfigUrl: string;

before(async () => {
  const cache = resolve('pro-test/node_modules/.cache');
  await mkdir(cache, { recursive: true });
  scratch = await mkdtemp(join(cache, 'sentry-release-test-'));
  // Execute both real configs, replacing only the upload boundary. No token
  // or network access is needed to observe what we pass to the Sentry plugin.
  for (const [name, entry] of [['dashboard', 'vite.config.ts'], ['marketing', 'pro-test/vite.config.ts']]) {
    await build({
      entryPoints: [entry], outfile: join(scratch, `${name}.mjs`),
      bundle: true, platform: 'node', format: 'esm', packages: 'external',
      define: { __dirname: JSON.stringify(resolve(name === 'dashboard' ? '.' : 'pro-test')) },
      plugins: [{
        name: 'capture-sentry-upload-options',
        setup(bundler) {
          bundler.onResolve({ filter: /^@sentry\/vite-plugin$/ }, () => ({ path: 'sentry-upload', namespace: 'test' }));
          bundler.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
            contents: 'export const sentryVitePlugin = options => ({ name: "sentry-upload", options });',
          }));
        },
      }],
    });
  }
  loadDashboard = (await import(pathToFileURL(join(scratch, 'dashboard.mjs')).href)).default;
  marketingConfigUrl = pathToFileURL(join(scratch, 'marketing.mjs')).href;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});
after(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

describe('Sentry build and event release contract', () => {
  for (const target of ['production', 'preview', 'development']) {
    it(`aligns both bundles and source-map uploads in ${target}`, async () => {
      process.env.SENTRY_AUTH_TOKEN = 'test-only-never-sent';
      process.env.VERCEL_GIT_COMMIT_SHA = sha;
      process.env.VERCEL_ENV = target;
      const configs = [
        await loadDashboard({ mode: 'production', command: 'build' }),
        (await import(`${marketingConfigUrl}?target=${target}`)).default,
      ];
      for (const [index, config] of configs.entries()) {
        const metadata = getSentryBuildMetadata(
          JSON.parse(config.define.__APP_VERSION__), JSON.parse(config.define.__BUILD_HASH__),
          target,
        );
        const upload = config.plugins.flat(Infinity).find((p: any) => p?.name === 'sentry-upload').options;
        assert.equal(metadata.release, target === 'production' ? sha : undefined);
        assert.equal(upload.release.name, sha);
        assert.equal(upload.release.dist, sha);
        assert.equal(upload.release.inject, false);
        const publishes = index === 0 && target === 'production';
        assert.equal(upload.release.create, publishes);
        assert.equal(upload.release.finalize, publishes);
        assert.equal(upload.release.setCommits, publishes ? undefined : false);
        assert.equal(upload.release.deploy, publishes ? undefined : false);

        // A real SDK client produces the event envelope. Only delivery is
        // replaced; release, dist and scope tags pass through Sentry itself.
        const envelopes: any[] = [];
        const client = new BrowserClient({
          ...metadata, dsn: 'https://public@example.invalid/1',
          integrations: [], stackParser: () => [],
          beforeSend: event => { isolateNonProductionSentryEvent(event, target); return event; },
          transport: () => ({
            send: async (envelope) => { envelopes.push(envelope); return { statusCode: 200 }; },
            flush: async () => true,
          }),
        });
        const scope = new Scope();
        scope.update(metadata.initialScope);
        client.captureEvent({ message: 'synthetic release contract check' }, {}, scope);
        await client.flush(1000);
        assert.equal(envelopes.length, 1);
        const event = envelopes[0][1][0][1];
        assert.equal(event.release, target === 'production' ? sha : undefined);
        assert.equal(event.dist, target === 'production' ? sha : undefined);
        assert.deepEqual(event.fingerprint, target === 'production' ? undefined : ['{{ default }}', `worldmonitor:${target}`]);
        assert.equal(event.tags.app_version, JSON.parse(config.define.__APP_VERSION__));
        assert.equal(event.tags.build_sha, sha);
        await client.close();
      }
    });
  }

  it('does not publish a production release with a missing deployment SHA', async () => {
    process.env.SENTRY_AUTH_TOKEN = 'test-only-never-sent';
    process.env.VERCEL_ENV = 'production';
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    const config = await loadDashboard({ mode: 'production', command: 'build' });
    const upload = config.plugins.flat(Infinity).find((p: any) => p?.name === 'sentry-upload').options;
    assert.equal(upload.release.create, false);
    assert.equal(upload.release.finalize, false);
    assert.equal(upload.release.setCommits, false);
  });
});
