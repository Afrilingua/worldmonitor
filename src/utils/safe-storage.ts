/**
 * `localStorage` accessors that survive a browser without usable storage.
 *
 * Two distinct failure shapes. Android WebView with DOM storage disabled
 * exposes `localStorage` as NULL, so the call itself is a TypeError
 * (WORLDMONITOR-122). Sandboxed iframes and blocked cookies make the property
 * THROW on access, and a full disk makes the write throw. `typeof localStorage
 * !== 'undefined'` guards against neither, because `typeof null` is `'object'`.
 *
 * The try/catch is what makes every shape safe. The optional chain is there
 * because on an affected device null is a permanent steady state rather than an
 * error, and branching beats throwing and catching on every single access.
 *
 * Reads degrade to "key absent" and writes to a no-op, so callers treat storage
 * as best-effort rather than branching on availability. These are for small
 * flags. A caller storing anything big enough to hit the quota wants
 * `saveToStorage` from `@/utils`, which reports via `markStorageQuotaExceeded`.
 */

export function safeStorageGet(key: string): string | null {
  try {
    return localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function safeStorageSet(key: string, value: string): void {
  try {
    localStorage?.setItem(key, value);
  } catch {
    /* storage unavailable or full */
  }
}

export function safeStorageRemove(key: string): void {
  try {
    localStorage?.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

/**
 * Whether storage is reachable at all right now.
 *
 * For the callers that must tell "storage is empty" apart from "storage is
 * unusable". Most callers should not need this — degrading to "key absent" is
 * the whole point of the accessors above — but a caller whose UI reports
 * SUCCESS does: settings export handed the user an empty file and a green
 * "Exported" toast on a browser where nothing could be read (#7833 review).
 */
export function isStorageAvailable(): boolean {
  try {
    return !!localStorage;
  } catch {
    return false;
  }
}

/**
 * Like `safeStorageSet`, but reports whether the value actually landed.
 *
 * Swallowing every failure is right for a best-effort flag and WRONG for a
 * caller that goes on to record durable state describing what it just wrote.
 * Cloud-prefs applies a downloaded blob and then advances the local sync
 * version; when a `QuotaExceededError` silently dropped one of those writes the
 * version advanced anyway, so the next upload posted the STALE local value back
 * over good cloud data. That is silent data loss, and it is why this variant
 * exists (#7833 review).
 *
 * Returns `false` ONLY when a usable store rejected the write. A browser with
 * no usable storage at all returns `true`: nothing was written, but nothing
 * durable disagrees either — the version marker the caller writes next is
 * equally inert, so the profile simply re-reconciles from scratch next load.
 * The dangerous case is precisely the mixed one, where the small marker fits
 * and the large value does not.
 */
export function safeStorageSetChecked(key: string, value: string): boolean {
  try {
    if (!localStorage) return true;
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** `safeStorageRemove` with the same landed/not-landed report as above. */
export function safeStorageRemoveChecked(key: string): boolean {
  try {
    if (!localStorage) return true;
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every key currently in storage, or `[]` when storage is unusable.
 *
 * Snapshotting up front is deliberate: `localStorage.key(i)` is index-based
 * over a live collection, so a caller that removes while iterating shifts the
 * indices under itself and silently skips keys. Both callers here scan for a
 * prefix and then delete or read the matches, which is exactly that shape.
 */
export function safeStorageKeys(): string[] {
  try {
    if (!localStorage) return [];
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}
