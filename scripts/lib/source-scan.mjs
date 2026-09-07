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
 * Tracks five states in one pass — code, line comment, block comment, quoted
 * string, and template literal (honoring backslash escapes), with a stack of
 * open `${…}` interpolations so nested templates resume the right one — so a
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
/**
 * Keywords after which a `/` begins a REGEX, not a division. `return /re/` is
 * the common one; the rest complete the operator-position set.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw',
]);

/**
 * Is the `/` at `index` the start of a regex literal rather than a division?
 *
 * The classic JS lexing ambiguity, resolved the classic way: look back at the
 * last significant character. After a value (identifier, number, `)`, `]`, or a
 * closing quote) a `/` divides; after an operator, a punctuator, or one of the
 * keywords above it opens a regex. This is a heuristic, not a parse — which is
 * why `lexSource` still reports an untrustworthy terminal state, so anything it
 * gets wrong surfaces loudly instead of silently blanking code.
 */
function startsRegex(source, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(source[i])) i--;
  if (i < 0) return true;
  const prev = source[i];
  if (/[)\]}]/.test(prev)) return prev === '}';
  if (/[A-Za-z0-9_$]/.test(prev)) {
    let end = i;
    while (i >= 0 && /[A-Za-z0-9_$]/.test(source[i])) i--;
    return REGEX_PRECEDING_KEYWORDS.has(source.slice(i + 1, end + 1));
  }
  if (prev === "'" || prev === '"' || prev === '`') return false;
  return true;
}

export function lexSource(source) {
  const out = source.split('');
  let mode = 'code';
  let quote = '';
  // Inside a regex, `/` within a `[...]` class does not terminate it.
  let regexInClass = false;
  // Brace depth per OPEN template interpolation. A template can contain `${…}`
  // whose expression contains another template, so a single in-string flag is
  // not enough: it treats the inner opening backtick as the outer closing one,
  // drops back to code mid-string, and a `/*` in the remaining text then opens
  // a comment that blanks everything to EOF. Review caught the panel gate
  // passing green over a newly added direct content write that way.
  const interpolations = [];

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (mode === 'code') {
      if (ch === '/' && next === '/') { mode = 'line'; out[i] = ' '; out[i + 1] = ' '; i++; continue; }
      if (ch === '/' && next === '*') { mode = 'block'; out[i] = ' '; out[i + 1] = ' '; i++; continue; }
      if (ch === '/' && startsRegex(source, i)) { mode = 'regex'; regexInClass = false; continue; }
      if (ch === "'" || ch === '"') { mode = 'string'; quote = ch; continue; }
      if (ch === '`') { mode = 'template'; continue; }
      if (interpolations.length > 0) {
        if (ch === '{') {
          interpolations[interpolations.length - 1] += 1;
        } else if (ch === '}') {
          if (interpolations[interpolations.length - 1] === 0) {
            interpolations.pop();
            mode = 'template';
          } else {
            interpolations[interpolations.length - 1] -= 1;
          }
        }
      }
      continue;
    }

    if (mode === 'regex') {
      // A regex body is not code and not a string: `/^'[^']*'$/` has an odd
      // number of apostrophes, and reading them as quotes de-synced the lexer
      // for the whole rest of the file. That is live in src/main.ts:454.
      if (ch === '\\') { i++; continue; }
      if (ch === '[') { regexInClass = true; continue; }
      if (ch === ']') { regexInClass = false; continue; }
      if (ch === '/' && !regexInClass) mode = 'code';
      continue;
    }

    if (mode === 'string') {
      // Consume the escaped character wholesale: a trailing backslash before
      // the closing quote (`'\\'`) would otherwise swallow it and run the
      // string state on into real code.
      if (ch === '\\') { i++; continue; }
      if (ch === quote) { mode = 'code'; quote = ''; }
      continue;
    }

    if (mode === 'template') {
      if (ch === '\\') { i++; continue; }
      if (ch === '$' && next === '{') { interpolations.push(0); mode = 'code'; i++; continue; }
      if (ch === '`') mode = 'code';
      continue;
    }

    if (mode === 'line') {
      // Newlines are never blanked, in any mode, so line numbers hold.
      if (ch === '\n') mode = 'code';
      else out[i] = ' ';
      continue;
    }

    // mode === 'block'
    if (ch === '*' && next === '/') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i++;
      mode = 'code';
    } else if (ch !== '\n') {
      out[i] = ' ';
    }
  }

  // A correctly-lexed file ends back in code. Ending anywhere else means the
  // scanner lost track — an untracked regex literal whose brace or slash was
  // read as syntax is the known way — and the damage is always the same shape:
  // a spurious open region blanking real code to EOF, which a gate then reports
  // as a clean scan. Regex-vs-division cannot be disambiguated without parser
  // context, so rather than pretend to close that, callers get to see it: a
  // non-`code` terminal state makes the gate fail LOUDLY instead of quietly
  // scanning less than it claims (#7833 review, fifth round).
  return { code: out.join(''), ok: mode === 'code' && interpolations.length === 0, terminalMode: mode };
}

/**
 * Comment-stripped source only. Prefer `lexSource` in a gate: it also reports
 * whether the lex is trustworthy, and a gate that ignores that can scan far
 * less than it thinks while still passing.
 */
export function stripComments(source) {
  return lexSource(source).code;
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
