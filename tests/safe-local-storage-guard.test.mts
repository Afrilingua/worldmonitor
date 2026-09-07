import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  GUARD_EXEMPT_FILES,
  LEGACY_RAW_LOCAL_STORAGE,
  MIN_SCANNED_FILES,
  RAW_STORAGE_PATTERNS,
  rawStorageUsesIn,
  scanRepo,
} from '../scripts/enforce-safe-local-storage.mjs';
import { stripComments } from '../scripts/lib/source-scan.mjs';

// ---------------------------------------------------------------------------
// Why this test exists (#7833)
// ---------------------------------------------------------------------------
//
// The scan lives in scripts/enforce-safe-local-storage.mjs so it can run from
// .husky/pre-push on any `src/` change — the edit it must catch is "someone
// touched a service or a panel", which touches nothing under tests/, and
// scripts/prepush-changed-tests.sh only selects a test file when that test
// file is itself in the changed set.
//
// This file is the other half: it proves the scanner has TEETH. A guard whose
// patterns quietly stopped matching would report a clean tree forever, which
// is indistinguishable from success and worse than no guard at all.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('raw localStorage guard (#7833)', () => {
  const scan = scanRepo(REPO_ROOT);

  it('sees the whole src population', () => {
    // Without this the scan could silently match nothing (a moved directory, a
    // changed extension filter) and every assertion below would pass vacuously.
    assert.ok(
      scan.scannedFiles.length >= MIN_SCANNED_FILES,
      `expected >= ${MIN_SCANNED_FILES} scanned files under src/ (860 at #7833), found ${scan.scannedFiles.length} — the scan or the source layout has drifted`,
    );
    assert.ok(
      scan.observed.length > 0,
      'the raw-storage patterns matched nothing — the patterns have gone stale',
    );
  });

  it('catches every receiver prefix that names the same Storage object', () => {
    // Negative coverage, and the reason it exists: "every pattern matches its
    // own probe" is circular — it cannot see an idiom class no probe covers.
    // All three of these returned [] in the first draft of this gate, while the
    // SAFE `globalThis.localStorage?.getItem(k)` was the one form it caught, so
    // the crashing variant was one deleted character away with CI green.
    for (const src of [
      'globalThis.localStorage.getItem(k);',
      'self.localStorage.setItem(k, v);',
      'window?.localStorage.getItem(k);',
      'window.localStorage.removeItem(k);',
      'top.localStorage.getItem(k);',
      'parent.localStorage.getItem(k);',
    ]) {
      assert.notDeepEqual(rawStorageUsesIn(src), [], `${src} is not caught by any pattern`);
    }
  });

  it('catches lexical variants of the dereference itself', () => {
    // A bare `localStorage\.` pattern anchors on the dot immediately following
    // the identifier, so ordinary spacing defeated it. The wrapped form is what
    // makes this more than adversarial — a formatter produces it for a long
    // chain — and `stripComments` turns the inline-comment form into exactly
    // the spaced one.
    for (const src of [
      'localStorage .getItem(k);',
      'localStorage\n  .getItem(k);',
      '(localStorage).getItem(k);',
      '( localStorage ) ?. getItem(k);',
      'localStorage [k] = v;',
    ]) {
      assert.notDeepEqual(
        rawStorageUsesIn(stripComments(src)),
        [],
        `${JSON.stringify(src)} is not caught by any pattern`,
      );
    }
  });

  it('every pattern matches its own probe', () => {
    // Asserting something like `re.source.length > 0` would be a tautology:
    // even `new RegExp('').source` is the 4-character string "(?:)". Matching
    // a fixture is the only assertion that goes red on a typo'd pattern.
    for (const { label, re, probe, extraProbes = [] } of RAW_STORAGE_PATTERNS) {
      assert.ok(re.test(probe), `${label} no longer matches its own probe — the pattern has drifted`);
      for (const extra of extraProbes) {
        assert.ok(re.test(extra), `${label} no longer matches its recorded variant: ${extra}`);
      }
      assert.deepEqual(
        rawStorageUsesIn(probe).filter((entry) => entry.startsWith(`${label} `)),
        [`${label} x1`],
        `${label} did not count its own probe exactly once`,
      );
    }
  });

  it('counts a repeated dereference rather than collapsing it to a boolean', () => {
    // The regression shape this guard exists for: new code lands in the files
    // that ALREADY read storage. A per-file boolean would pass green on a
    // second call site, so the count is what makes the ratchet real.
    assert.deepEqual(
      rawStorageUsesIn('localStorage.getItem(a); localStorage.setItem(b, c);'),
      ['localStorage.<member> x2'],
    );
  });

  it('treats a bare identifier as legal and a dereference as not', () => {
    // `this === localStorage` inside the cloud-prefs setItem patch is an
    // identity comparison; it cannot throw on a null. Flagging it would push
    // callers to "fix" working code, and an inventory nobody trusts gets
    // rubber-stamped.
    assert.deepEqual(rawStorageUsesIn('if (this === localStorage) return;'), []);
    assert.deepEqual(rawStorageUsesIn("vi.stubGlobal('localStorage', null);"), []);
    assert.deepEqual(
      rawStorageUsesIn('const v = localStorage.getItem(k);'),
      ['localStorage.<member> x1'],
    );
  });

  it('preserves real code that merely LOOKS like a comment boundary', () => {
    // The bug that made this gate blind on 1826 lines of panel-layout.ts: the
    // old two-regex stripper ran its block-comment pass over RAW source, so a
    // `/*` inside a line comment or a string opened a bogus region that ran to
    // the next `*/` and swallowed everything between. Asserting only that
    // comments are REMOVED cannot catch that; this asserts code SURVIVES.
    const tricky = [
      "// see the panels declared in src/components/*Panel.ts for the list",
      "const glob = '../locales/*.json';",
      "const url = 'https://example.com/x'; localStorage.getItem('a');",
      "localStorage.setItem('b', '1');",
      "/* a real block comment mentioning localStorage.getItem */",
      "localStorage.removeItem('c');",
    ].join('\n');
    assert.deepEqual(rawStorageUsesIn(stripComments(tricky)), ['localStorage.<member> x3']);
  });

  it('does not count a dereference that only appears in a comment', () => {
    // Scanning raw text would both false-fail a migrated file that documents
    // the rule, and — worse, because it is silent — keep a legacy entry
    // "observed" after its last real call is gone, so `stale` never fires.
    const documented = stripComments(
      ['// call localStorage.getItem(k) here', '/* or localStorage.setItem(k, v) */', 'safeStorageGet(k);'].join('\n'),
    );
    assert.deepEqual(rawStorageUsesIn(documented), []);
  });

  it('exempts the canonical helper and nothing else', () => {
    assert.deepEqual([...GUARD_EXEMPT_FILES], ['src/utils/safe-storage.ts']);
    // The helper is the one file that MUST dereference storage, so its
    // exemption has to be real — if the scan started including it, the
    // inventory would grow an entry nobody can ever remove.
    assert.equal(
      scan.scannedFiles.some((abs) => abs.endsWith('src/utils/safe-storage.ts')),
      false,
    );
  });

  it('keeps the recorded inventory matching the tree', () => {
    assert.deepEqual(
      scan.unlisted,
      [],
      'new raw localStorage dereferences — route them through @/utils/safe-storage, or record them with a reason',
    );
    assert.deepEqual(
      scan.stale,
      [],
      'recorded dereferences that no longer exist — lower the count or delete the line in LEGACY_RAW_LOCAL_STORAGE',
    );
  });

  it('records every entry with a count so the ratchet can only tighten', () => {
    for (const entry of LEGACY_RAW_LOCAL_STORAGE) {
      assert.match(
        entry,
        / :: .+ x[1-9]\d*$/,
        `${entry} is missing a positive occurrence count`,
      );
    }
    assert.deepEqual(
      [...LEGACY_RAW_LOCAL_STORAGE].sort(),
      LEGACY_RAW_LOCAL_STORAGE,
      'inventory must stay sorted so diffs stay readable',
    );
    assert.equal(
      new Set(LEGACY_RAW_LOCAL_STORAGE).size,
      LEGACY_RAW_LOCAL_STORAGE.length,
      'a duplicated entry would let one of the pair go stale unnoticed',
    );
  });

  it('keeps the sites #7833 migrated off raw storage', () => {
    // These had genuinely unguarded, reachable dereferences before #7833.
    // Re-listing one here would silence the guard on a regression.
    for (const file of [
      'src/services/runtime.ts',
      'src/services/tv-mode.ts',
      'src/settings-main.ts',
      // Re-listing this one would mean the private rawGet/rawSet/rawRemove
      // trio came back. It was added by #7833 itself and removed in review:
      // its justification (bypassing an own-property override of
      // `localStorage`) described a threat that exists nowhere in this repo.
      'src/utils/cloud-prefs-sync.ts',
    ]) {
      assert.equal(
        LEGACY_RAW_LOCAL_STORAGE.some((entry) => entry.startsWith(`${file} ::`)),
        false,
        `${file} was migrated off raw localStorage by #7833 and must not return to the inventory`,
      );
    }
  });
});
