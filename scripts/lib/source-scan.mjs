// ---------------------------------------------------------------------------
// Shared source-text scanning for the enforce-*.mjs gates
// ---------------------------------------------------------------------------
//
// `enforce-panel-content-writes.mjs` and `enforce-safe-local-storage.mjs` both
// count idioms in comment-stripped source. They carried byte-identical copies
// of the two helpers below, and the copy carried a hole that made both gates
// silently blind to real code (#7833 review).
//
// THE HOLE: the old implementation ran two regexes over RAW source, block
// comments first:
//
//     .replace(/\/\*[\s\S]*?\*\//g, blank)   // then
//     .replace(/\/\/[^\n]*/g, blank)
//
// A `/*` inside a LINE comment or a STRING is not a block-comment opener, but
// that first regex cannot tell. `src/app/panel-layout.ts` contains the line
// comment
//
//     // `className: 'panel-wide'`, declared in src/components/*Panel.ts). A deferred
//
// whose `/*` opened a bogus comment region that ran to the next `*/` and blanked
// 1826 of the file's 4554 lines. Two live `localStorage` dereferences sat inside
// that region, so the guard measured 7 where the file has 9 — and any NEW
// dereference landing in those 1826 lines would have passed CI green. For a
// merge-blocking gate that is the worst failure available: not a crash, a
// confident all-clear over unread code.
//
// The fix is a single left-to-right pass with explicit state, because comment
// and string starts are only meaningful when you already know which one you are
// inside — which is exactly the context two independent regexes throw away.

/**
 * Blank out comments while preserving offsets and line count.
 *
 * Tracks four states in one pass — code, line comment, block comment, and
 * string (`'`, `"`, and template literals, honoring backslash escapes) — so a
 * `/*` or `//` inside a string or another comment can never open a region.
 * Comment characters become spaces and newlines survive, so byte offsets and
 * line numbers still line up with the original for error reporting.
 *
 * String CONTENTS are deliberately preserved rather than blanked. These gates
 * count code idioms, and blanking strings would be the same silent-blindness
 * trade in another coat; a scanner that keeps them can over-count an idiom
 * quoted in a string, which fails LOUDLY as an inventory mismatch instead.
 *
 * KNOWN LIMIT: regex literals are not tracked, so a regex containing `//`
 * (e.g. `/https:\/\//`) can still open a spurious line comment. That shape does
 * not occur in the scanned trees today, and unlike the bug above it is visible
 * as an inventory mismatch rather than a silent pass on the common case. Track
 * regex state here if it ever appears, rather than reverting to regex stripping.
 */
export function stripComments(source) {
  const out = source.split('');
  let state = 'code';
  let quote = '';

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line';
        out[i] = ' ';
        out[i + 1] = ' ';
        i++;
      } else if (ch === '/' && next === '*') {
        state = 'block';
        out[i] = ' ';
        out[i + 1] = ' ';
        i++;
      } else if (ch === "'" || ch === '"' || ch === '`') {
        state = 'string';
        quote = ch;
      }
      continue;
    }

    if (state === 'string') {
      // Consume the escaped character wholesale: a trailing backslash before
      // the closing quote (`'\\'`) would otherwise swallow it and run the
      // string state on into real code.
      if (ch === '\\') { i++; continue; }
      if (ch === quote) { state = 'code'; quote = ''; }
      continue;
    }

    if (state === 'line') {
      // Newlines are never blanked, in any state, so line numbers hold.
      if (ch === '\n') state = 'code';
      else out[i] = ' ';
      continue;
    }

    // state === 'block'
    if (ch === '*' && next === '/') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i++;
      state = 'code';
    } else if (ch !== '\n') {
      out[i] = ' ';
    }
  }

  return out.join('');
}

/**
 * Every `.ts` file under `dir`, recursively, sorted for stable output.
 *
 * Uses `lstatSync` rather than `statSync` so a symlinked directory is skipped
 * instead of followed — a link pointing outside the repo (or at an ancestor)
 * would otherwise let a gate scan foreign files or recurse until it hangs.
 */
export function collectTsFiles(dir, { readdirSync, lstatSync, join }) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) out.push(...collectTsFiles(abs, { readdirSync, lstatSync, join }));
    else if (abs.endsWith('.ts')) out.push(abs);
  }
  return out.sort();
}
