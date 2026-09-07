#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Raw localStorage guard (#7833)
// ---------------------------------------------------------------------------
//
// Android WebView with DOM storage disabled exposes `window.localStorage` as
// NULL rather than throwing, so an unguarded `localStorage.getItem(…)` is a
// TypeError, not a catchable SecurityError. That shape has produced three
// separate Sentry issues (WORLDMONITOR-122, -11X, -XG). `-11X` was resolved in
// Sentry on 2026-09-04 with no code change, which is why it came back.
//
// Nothing mechanical stood between those crashes and a green CI: `biome.json`
// has no matching rule, the repo has no eslint config, and none of the other
// `enforce-*.mjs` checks look at storage. Every guard was a hand-rolled
// convention — and conventions are exactly what produced the two call sites
// that LOOK guarded and are not:
//
//   - `cloud-prefs-sync.applyCloudBlob` wrapped its writes in
//     `try { … } finally { … }`. A `finally` catches nothing.
//   - `persistent-cache.deleteFromLocalStorageByPrefix` opened with
//     `typeof localStorage === 'undefined'`, and `typeof null` is `'object'`.
//
// Both are fixed; this guard is what stops the class from coming back a fourth
// time. It runs as a `lint:*` script rather than a test because the edit it
// must catch is "someone touched a service or a panel", which touches nothing
// under tests/ — and `scripts/prepush-changed-tests.sh` only runs a test file
// when that test file is itself in the changed set, so a test-only guard would
// first surface in CI with the PR already open.
//
// WHAT IS BANNED: a DEREFERENCE of `localStorage` outside the sanctioned
// helper. Dereferencing is what throws, so that is what the guard measures. A
// bare mention of the identifier is deliberately legal — `this === localStorage`
// inside the cloud-prefs setItem patch is an identity comparison that cannot
// throw on a null, and `vi.stubGlobal('localStorage', null)` is a string.
//
// Note what a green run does and does not mean. It means "no NEW dereference
// outside `safe-storage.ts`, and the recorded legacy population still matches
// the tree". It does NOT mean storage access is safe everywhere. Known gaps,
// all of which need an AST pass rather than a wider regex to close:
//
//   - a local alias (`const ls = globalThis.localStorage; ls.getItem(k)`) or a
//     destructure (`const { getItem } = localStorage`);
//   - a `sessionStorage` deref, which has the identical null shape;
//   - a count-NEUTRAL swap inside an already-inventoried file: deleting one
//     dereference and adding another keeps N the same and passes green.
//
// Widen the patterns when a new idiom appears rather than reading silence as
// proof. The review that shipped this gate found three separate bypasses in its
// own first draft, which is the honest calibration for how much a green run
// buys you.

import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainModule } from './lib/main-module.mjs';
import { collectTsFiles, stripComments } from './lib/source-scan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Ways to reach through `localStorage` to something that can throw on a null.
 *
 * `probe` is the fixture the self-test matches each pattern against, so a
 * pattern that silently stops matching fails loudly instead of going quiet.
 *
 * `localStorage?.foo()` is listed even though optional chaining survives the
 * NULL shape: it does nothing for the THROWING shape (a sandboxed iframe or
 * blocked cookies make the property access itself throw), so on its own it is
 * still a hand-rolled half-guard. Inside `safe-storage.ts` it is paired with a
 * try/catch, which is why that file — and only that file — is exempt.
 */
// Whitespace is permitted between the identifier, the accessor and the member
// throughout: `localStorage .getItem(k)` and a formatter-wrapped
//
//     localStorage
//       .getItem(k)
//
// are ordinary code a bare `localStorage\.` pattern misses entirely, and
// `stripComments` turns `localStorage /* c */.getItem(k)` into exactly the
// spaced form. `[^\S\n]` rather than `\s` on the identifier side of a bare
// dot would forbid the wrapped shape, so `\s` it is — the cost is that a
// `localStorage` on one line and an unrelated `.foo` on the next can pair up,
// which over-counts (a LOUD inventory mismatch) rather than under-counting.
//
// Whitespace is tolerated at EVERY accessor position in EVERY pattern below —
// both sides of the receiver dot, not just the identifier's. Review found the
// receiver side still unhandled after the identifier side was fixed, and
// patching one position per round is the whack-a-mole this note exists to stop.
// Note what closing it does and does not buy: a plain AST walk would cover
// exactly this same syntactic class, because the gaps that actually survive —
// aliasing, destructuring — need symbol/type resolution, not a parser. That is
// why this stays a regex with the limits named in the header rather than
// growing a TypeScript dependency for no additional coverage.
export const RAW_STORAGE_PATTERNS = [
  {
    label: 'localStorage.<member>',
    re: /(?<![.?])\blocalStorage\s*\.\s*\w/,
    probe: 'localStorage.getItem(key);',
    extraProbes: [
      'localStorage .getItem(key);',
      'localStorage\n  .getItem(key);',
    ],
  },
  {
    label: 'localStorage?.<member>',
    re: /\blocalStorage\s*\?\.\s*\w/,
    probe: 'localStorage?.getItem(key);',
  },
  {
    label: 'localStorage[<expr>]',
    re: /\blocalStorage\s*(?:\?\.)?\s*\[/,
    probe: 'localStorage[key] = value;',
  },
  {
    // `(localStorage).getItem(k)` reads as deliberate obfuscation more than as
    // an accident, but it is valid code that crashes identically, and the
    // parenthesised receiver defeats every identifier-anchored pattern above.
    label: '(localStorage).<member>',
    re: /\(\s*localStorage\s*\)\s*\??\.\s*\w/,
    probe: '(localStorage).getItem(key);',
  },
  {
    // Every global that names the same Storage object. The receiver prefix is
    // load-bearing for two reasons: `(?<![.?])` above deliberately refuses to
    // match a dotted `X.localStorage`, so WITHOUT this alternation
    // `globalThis.localStorage.getItem(k)` matched nothing at all — and the
    // repo already ships the safe `globalThis.localStorage?.getItem(k)` at
    // ChatAnalystPanel.ts:133, so the crashing variant was one deleted
    // character away with CI green.
    //
    // The optional chain is `\??\.`, not `(?:\?\.)?\.` — the latter demanded
    // `window?..localStorage` (two dots) and could never match anything.
    label: '<global>.localStorage',
    re: /\b(?:window|globalThis|self|top|parent)\s*\??\.\s*localStorage\b/,
    probe: 'const ls = window.localStorage;',
    extraProbes: [
      'globalThis.localStorage.getItem(key);',
      'self.localStorage.setItem(key, value);',
      'window?.localStorage.getItem(key);',
      'window .localStorage.getItem(key);',
      'window\n  .localStorage.getItem(key);',
    ],
  },
  {
    // A computed receiver defeats every identifier-anchored pattern above.
    label: "<global>['localStorage']",
    re: /\b(?:window|globalThis|self|top|parent)\s*(?:\?\.)?\s*\[\s*['"`]localStorage['"`]\s*\]/,
    probe: "window['localStorage'].getItem(key);",
  },
  {
    // `Storage.prototype.setItem.call(localStorage, …)` throws exactly the same
    // TypeError on a null receiver, and reads as deliberate enough that a
    // reviewer waves it through.
    label: 'Storage.prototype.<member>.call(…)',
    re: /\bStorage\s*\.\s*prototype\s*\.\s*\w+\s*\.\s*call\s*\(/,
    probe: 'Storage.prototype.setItem.call(localStorage, key, value);',
  },
];

/**
 * The canonical helper. Exempt BY NAME, not by the incidental fact that it
 * currently lives at this path — move it and this entry has to move with it,
 * which is the point.
 *
 * Nothing else is exempt. The remaining "safe storage" implementations
 * (`loadFromStorage`/`saveToStorage` in `src/utils/index.ts`, the file-private
 * helpers in `browser-key-session.ts`, and `safeLocalStorage()` in
 * `passkey-offer-state.ts`) are counted in the inventory below rather than
 * waved through, so the duplication stays visible and a further implementation
 * cannot land quietly. #7833 review caught this file's own author adding one:
 * cloud-prefs-sync grew a private rawGet/rawSet/rawRemove trio justified by a
 * threat (an own-property override of `localStorage`) that exists nowhere in
 * this repo. It now uses the shared helper.
 */
export const GUARD_EXEMPT_FILES = new Set(['src/utils/safe-storage.ts']);

/**
 * Every `<file> :: <idiom> xN` triple outside the helper, as of #7833.
 *
 * Recorded with an OCCURRENCE COUNT, not a per-file or per-(file, idiom)
 * boolean, for the reason `enforce-panel-content-writes.mjs` learned the hard
 * way: a boolean cannot see a SECOND deref of an idiom the file already
 * carries, so a fresh `localStorage.getItem` in `App.ts` — which already has
 * dozens — would pass green. That is the highest-traffic regression shape
 * there is, because new code lands in the files that already read storage.
 * With counts, a new deref bumps N and fails `unlisted`; a migration lowers N
 * and fails `stale`.
 *
 * This list is a ratchet, not a permission slip:
 *   - a NEW pair, or a HIGHER count, fails the guard — route the access
 *     through `@/utils/safe-storage` instead;
 *   - a pair that shrank or vanished MUST be updated here, so the inventory
 *     can never quietly outlive the drift it records.
 *
 * Counts are measured on COMMENT-STRIPPED source, so documenting the rule in a
 * comment neither inflates an entry nor keeps a migrated one alive.
 *
 * An entry here is NOT automatically a bug. Three populations are mixed in,
 * and the CLI cannot tell them apart — read the call site before "fixing" one:
 *
 *   1. Genuinely unguarded, and reachable. These are the #7833 backlog. Boot
 *      path first.
 *   2. Guarded by a surrounding try/catch or a capability probe that really
 *      does fire. `src/App.ts` is the large one: its constructor probes with a
 *      write/remove inside a try and drops to `storageAvailable = false`, and
 *      every migration below it sits behind that flag. Its entry exists to
 *      catch a NEW deref landing OUTSIDE the probe, not because the cascade
 *      is broken.
 *   3. Deliberately raw, because the helper's contract is wrong for the site.
 *      `persistent-cache` needs the QuotaExceededError to distinguish a full
 *      disk (`markStorageQuotaExceeded`) from an unusable store, and
 *      `settings-persistence.importSettings` must fail LOUDLY rather than
 *      report "0 keys imported" as success. These are terminal states, not
 *      unfinished migrations.
 *
 * The CLI derives and reports the entry and call-site totals from this
 * registry; do not duplicate those shrinking counts in this comment.
 */
export const LEGACY_RAW_LOCAL_STORAGE = [
  'src/App.ts :: localStorage.<member> x74',
  'src/app/event-handlers.ts :: localStorage.<member> x5',
  'src/app/map-dimension-control.ts :: localStorage.<member> x1',
  'src/app/panel-layout.ts :: localStorage.<member> x9',
  'src/app/pro-activation-controller.ts :: <global>.localStorage x8',
  'src/bootstrap/sw-update.ts :: localStorage.<member> x1',
  'src/components/AviationCommandBar.ts :: localStorage.<member> x1',
  'src/components/ChatAnalystPanel.ts :: <global>.localStorage x2',
  'src/components/ChatAnalystPanel.ts :: localStorage?.<member> x2',
  'src/components/ConsumerPricesPanel.ts :: localStorage.<member> x2',
  'src/components/GlobeMap.ts :: localStorage.<member> x2',
  'src/components/InsightsPanel.ts :: localStorage.<member> x1',
  'src/components/NewsPanel.ts :: localStorage.<member> x6',
  'src/components/ProActivationChip.ts :: localStorage.<member> x4',
  'src/components/ProBanner.ts :: localStorage.<member> x5',
  'src/components/ProPreviewSection.ts :: localStorage.<member> x2',
  'src/components/SearchModal.ts :: localStorage.<member> x2',
  'src/components/StrategicPosturePanel.ts :: localStorage.<member> x2',
  'src/components/WorldClockPanel.ts :: localStorage.<member> x1',
  'src/config/basemap.ts :: localStorage.<member> x2',
  'src/config/beta.ts :: localStorage.<member> x1',
  'src/config/variant.ts :: localStorage.<member> x1',
  'src/main.ts :: localStorage.<member> x4',
  'src/mcp-grant-main.ts :: localStorage.<member> x1',
  'src/services/ai-flow-settings.ts :: localStorage.<member> x4',
  'src/services/analytics.ts :: <global>.localStorage x3',
  'src/services/anonymous-identity-storage.ts :: localStorage.<member> x5',
  'src/services/aviation/watchlist.ts :: localStorage.<member> x2',
  'src/services/breaking-news-alerts.ts :: localStorage.<member> x4',
  'src/services/browser-key-session.ts :: localStorage.<member> x2',
  'src/services/cached-risk-scores.ts :: localStorage.<member> x5',
  'src/services/cached-theater-posture.ts :: localStorage.<member> x4',
  'src/services/followed-countries.ts :: localStorage.<member> x3',
  'src/services/font-scale-settings.ts :: localStorage.<member> x2',
  'src/services/font-settings.ts :: localStorage.<member> x2',
  'src/services/globe-render-settings.ts :: localStorage.<member> x6',
  'src/services/i18n.ts :: localStorage.<member> x3',
  'src/services/live-stream-settings.ts :: localStorage.<member> x2',
  'src/services/map-mode-preference.ts :: localStorage.<member> x1',
  'src/services/market-watchlist.ts :: localStorage.<member> x6',
  'src/services/mission-presets.ts :: localStorage.<member> x7',
  'src/services/persistent-cache.ts :: localStorage.<member> x3',
  'src/services/referral-capture.ts :: localStorage.<member> x7',
  'src/services/runtime-config.ts :: localStorage.<member> x2',
  'src/services/sentiment-gate.ts :: localStorage.<member> x1',
  'src/services/tab-store.ts :: localStorage.<member> x2',
  'src/services/telegram-watchlist.ts :: localStorage.<member> x2',
  'src/services/trending-keywords.ts :: <global>.localStorage x1',
  'src/services/trending-keywords.ts :: localStorage.<member> x2',
  'src/services/webcams/pinned-store.ts :: localStorage.<member> x2',
  'src/services/widget-store.ts :: localStorage.<member> x4',
  'src/utils/followed-only-chip.ts :: localStorage.<member> x4',
  'src/utils/index.ts :: localStorage.<member> x2',
  'src/utils/panel-storage.ts :: localStorage.<member> x3',
  'src/utils/settings-persistence.ts :: localStorage.<member> x1',
  'src/utils/theme-manager.ts :: localStorage.<member> x5',
];

/**
 * Floor for the scanned population, derived from the file count at #7833. A
 * moved directory or a changed extension filter would otherwise shrink the
 * scan toward zero and let every assertion pass vacuously — the silent
 * failure mode this guard exists to prevent.
 */
export const MIN_SCANNED_FILES = 700;

/** `<idiom> xN` for every raw-storage idiom present in `code`, with counts. */
export function rawStorageUsesIn(code) {
  return RAW_STORAGE_PATTERNS.flatMap(({ label, re }) => {
    const n = (code.match(new RegExp(re.source, 'g')) ?? []).length;
    return n === 0 ? [] : [`${label} x${n}`];
  });
}

/** Scan the tree and return everything the assertions and the CLI both need. */
export function scanRepo(root = REPO_ROOT) {
  const allFiles = collectTsFiles(path.join(root, 'src'), { readdirSync, lstatSync, join: path.join });
  const scanned = allFiles.filter(
    (abs) => !GUARD_EXEMPT_FILES.has(path.relative(root, abs)),
  );

  const observed = scanned
    .flatMap((abs) =>
      rawStorageUsesIn(stripComments(readFileSync(abs, 'utf8'))).map(
        (label) => `${path.relative(root, abs)} :: ${label}`,
      ),
    )
    .sort();

  const allowed = new Set(LEGACY_RAW_LOCAL_STORAGE);
  const observedSet = new Set(observed);

  return {
    scannedFiles: scanned,
    observed,
    unlisted: observed.filter((pair) => !allowed.has(pair)),
    stale: LEGACY_RAW_LOCAL_STORAGE.filter((pair) => !observedSet.has(pair)),
  };
}

function main() {
  const result = scanRepo();
  const problems = [];

  if (result.scannedFiles.length < MIN_SCANNED_FILES) {
    problems.push(
      `Expected >= ${MIN_SCANNED_FILES} scanned files under src/ (860 at #7833), found ${result.scannedFiles.length} — the scan or the source layout has drifted.`,
    );
  }

  if (result.unlisted.length > 0) {
    problems.push(
      'These dereference localStorage directly. Android WebView with DOM storage disabled exposes it as null, so each one is a TypeError on those devices (#7833, the WORLDMONITOR-122 class):',
      ...result.unlisted.map(
        (pair) =>
          `  - ${pair}\n      read/write through safeStorageGet / safeStorageSet / safeStorageRemove / safeStorageKeys from @/utils/safe-storage`,
      ),
      'If the helper is genuinely wrong for the site — you need the QuotaExceededError, or the failure must be loud — say so in a comment at the call site and add the entry to LEGACY_RAW_LOCAL_STORAGE with its count.',
    );
  }

  if (result.stale.length > 0) {
    problems.push(
      'These recorded dereferences no longer match the tree. Update LEGACY_RAW_LOCAL_STORAGE in scripts/enforce-safe-local-storage.mjs (lower the count, or delete the line) so the inventory keeps matching reality.',
      ...result.stale.map((pair) => `  - ${pair}`),
    );
  }

  if (problems.length > 0) {
    console.error('Raw localStorage guard failed (#7833).');
    for (const line of problems) console.error(line);
    process.exitCode = 1;
    return;
  }

  const sites = LEGACY_RAW_LOCAL_STORAGE.reduce(
    (sum, pair) => sum + Number(pair.split(' x').pop()),
    0,
  );
  console.log(
    `Raw localStorage guard passed (${result.scannedFiles.length} files scanned; ${LEGACY_RAW_LOCAL_STORAGE.length} legacy entries / ${sites} dereferences tracked).`,
  );
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main();
}
