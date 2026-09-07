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
