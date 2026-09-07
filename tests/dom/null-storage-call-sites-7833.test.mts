/**
 * #7833 — call sites that still crash on a NULL `localStorage`.
 *
 * Android WebView with DOM storage disabled exposes `window.localStorage` as
 * `null`, so an unguarded `localStorage.getItem(…)` is a TypeError rather than
 * a thrown SecurityError. #7832 fixed the sites with production evidence
 * (`WORLDMONITOR-122`); these are the ones a survey found afterwards, including
 * two that LOOK guarded and are not:
 *
 *   - `cloud-prefs-sync.applyCloudBlob` wraps its storage writes in
 *     `try { … } finally { … }`. A `finally` restores the patch-suppression
 *     flag but catches nothing, so the TypeError still propagates.
 *   - `persistent-cache.deleteFromLocalStorageByPrefix` opens with
 *     `if (typeof localStorage === 'undefined') return;`. `typeof null` is
 *     `'object'`, so that gate never fires for the null shape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Android WebView with DOM storage disabled: the property itself is null. */
function stubNullStorage(): void {
  vi.stubGlobal('localStorage', null);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('cloud-prefs-sync under a null localStorage', () => {
  beforeEach(() => {
    // `ENABLED` is captured from import.meta.env at module load, so the stub
    // has to be in place before the dynamic import below.
    vi.stubEnv('VITE_CLOUD_PREFS_ENABLED', 'true');
  });

  it('reads sync metadata without throwing', async () => {
    const sync = await import('@/utils/cloud-prefs-sync');
    stubNullStorage();

    expect(sync.getSyncVersion()).toBe(0);
    expect(sync.getSyncState()).toBe('signed-out');
    expect(sync.getLastSyncAt()).toBe(0);
  });

  it('reconciles a sign-in without throwing (boot-path ownership sidecars)', async () => {
    const sync = await import('@/utils/cloud-prefs-sync');
    expect(sync.isCloudSyncEnabled()).toBe(true);
    stubNullStorage();

    // onSignIn does its ownership-sidecar reconciliation synchronously before
    // returning the async attempt; the throw we care about is the sync one.
    expect(() => { void sync.onSignIn('user-1', 'full').catch(() => {}); }).not.toThrow();
  });

  it('clears sync metadata on sign-out without throwing', async () => {
    const sync = await import('@/utils/cloud-prefs-sync');
    stubNullStorage();

    expect(() => sync.onSignOut()).not.toThrow();
  });
});

describe('settings export under a null localStorage', () => {
  it('exports an empty settings payload instead of throwing', async () => {
    const { exportSettings } = await import('@/utils/settings-persistence');
    // Spy rather than stubGlobal: replacing `URL` wholesale leaves happy-dom
    // without a URL constructor, and the anchor click below then blows up
    // inside its navigator instead of inside the code under test.
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stub');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    // The download anchor is clicked for real; happy-dom would try to navigate.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    stubNullStorage();

    expect(() => exportSettings()).not.toThrow();

    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(JSON.parse(await blob.text()).data).toEqual({});
  });
});

describe('persistent-cache prefix invalidation under a null localStorage', () => {
  it('returns without throwing instead of falling through the undefined-only gate', async () => {
    const { __testing__ } = await import('@/services/persistent-cache');
    stubNullStorage();

    expect(() => __testing__.deleteFromLocalStorageByPrefix('news')).not.toThrow();
  });
});
