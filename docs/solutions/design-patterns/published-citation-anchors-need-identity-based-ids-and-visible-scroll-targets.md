---
title: "Published citation anchors need identity-based ids and visible scroll targets"
date: 2026-09-08
category: design-patterns
module: crawlable corpus, sources page generator
problem_type: design_pattern
component: frontend
severity: medium
applies_when:
  - "Publishing fragment URLs as machine-readable citations — JSON-LD ListItem.url, speakable selectors, sitemap fragments, or an llms.txt pointer"
  - "Disambiguating a slug collision by iteration order over a collection that is displayed sorted, so an insertion or rename can reorder it"
  - "Adding scroll-to-anchor navigation to a page carrying sticky or fixed chrome above the anchored region"
  - "Writing a test that asserts an anchor id exists in the rendered HTML"
tags:
  - citation-integrity
  - stable-anchors
  - scroll-margin
  - json-ld
  - structured-data
  - vacuous-guard
  - seo
  - geo
related_components:
  - testing_framework
---

# Published citation anchors need identity-based ids and visible scroll targets

## Context

`/sources/` is a generated static page listing World Monitor's whole provider catalog. Round 7 of the GEO audit found its schema.org `ItemList` announcing all of the catalog's elements as **bare strings**, with 43 of the display names repeated (`scripts/crawlable-sources-page.mjs:702-708`). The repeats were not duplicate data: they are one publisher reached through several hosts — Yahoo Finance through three, Euronews through eight language editions — each of which is a distinct catalog entry that a display name alone cannot tell apart. A parser reading that list had 748 opaque labels, no way to key on them, and no way to distinguish the eight Euronews entries from each other.

The fix (issue #7869, PR #7881 — open and unmerged as of this writing) gave every provider card a stable `id` and gave every `ListItem` a `url` addressing one specific card:

- `sourceCardAnchors()` at `scripts/crawlable-sources-page.mjs:742-770` builds the per-provider anchor map, keyed on `provider` (the catalog's own unique key), not on the display name.
- The card markup interpolates the id at `scripts/crawlable-sources-page.mjs:816`.
- The JSON-LD emits `url: \`${pageUrl}#${cardAnchors.get(provider.provider)}\`` at `scripts/crawlable-sources-page.mjs:1126`, alongside `'@type': 'ListItem'` and a 1-based `position` (`:1123-1125`).

That work is where the lesson lives. Adding the ids turned two properties that had been purely cosmetic — *where* a fragment lands on screen, and *which* card a given fragment names — into correctness properties. Both broke in the first version, both were caught in code review, and both are now pinned by tests proven to fail before the fix.

## Guidance

**When you publish an HTML fragment URL as machine-readable data, you have published a citation. Test it as a citation, not as an id.**

Concretely, three claims must hold, and none of them follows from "the id exists in the rendered HTML":

### 1. The fragment must resolve to the *right* thing, not merely to something

Two provider keys can slugify alike — `a.b` and `a-b` both reduce to `a-b` under the generator's `[^a-zA-Z0-9]+` transform (`scripts/crawlable-sources-page.mjs:749-754`) — so the anchor scheme needs a disambiguator. **Three shapes were written before one was correct, and the first two failed the same way for reasons that look different.**

**Shape 1 — an arrival-ordered counter** (`provider-a-b`, `provider-a-b-2`). The counter handed the bare id to whichever collider the loop reached first, and the catalog is sorted by `displayName`, so renaming any unrelated provider could reshuffle which collider owned it. Caught in the pre-merge code review.

**Shape 2 — suffix only a base with more than one claimant.** Count the claimants of each base in a first pass; hand out the bare id when a base has exactly one, a key digest when it has several. This removes the *ordering* dependence, and it is what the fix for shape 1 shipped as. It is still wrong, and subtly enough that a full reviewer roster passed it: publish `a.b` while it is the only claimant and it gets the bare `provider-a-b`; add `a-b` to the catalog a month later and the base now has two claimants, so **the anchor already indexed for `a.b` changes**. Caught by an automated reviewer on the pull request itself, after the human-authored review had signed off.

**Shape 3 — an unconditional digest**, which is what shipped (`scripts/crawlable-sources-page.mjs:757-766`):

```js
const key = String(provider.provider ?? '');
const preferred = `provider-${slugBase(key)}-${createHash('sha1').update(key).digest('hex').slice(0, 6)}`;
```

The `used`/`suffix` loop below it is a backstop that fires only on a digest collision, so the "no two cards share an id" invariant holds regardless.

The through-line is worth stating plainly, because it is the part that generalizes: **shapes 1 and 2 both let the rest of the catalog leak into an individual anchor.** Shape 1 leaked iteration order; shape 2 leaked catalog membership. Each fix removed one channel and left the other open. The property you actually need is stronger than "deterministic" or "order-independent" — it is that the anchor is a pure function of its own key and reads nothing else, which is a claim you can test directly rather than enumerate exceptions to. Paying seven characters on every anchor is what buys it; conditioning the suffix on anything about the catalog is what keeps re-opening the hole.

### 2. The fragment must land somewhere the reader can actually see

Two stacked `position: sticky` elements sit above the card grid:

- `.sources-page header` — `position: sticky; top: 0`, 146px tall (`scripts/crawlable-sources-page.mjs:925`)
- `.catalog-controls` — `position: sticky; top: 68px`, bottom edge at 167px (`scripts/crawlable-sources-page.mjs:997`)

A provider card is `min-height: 180px` (`scripts/crawlable-sources-page.mjs:1008`). Following `#provider-x` scrolled the card to viewport y = -0.06 — measured in Chromium against the generated page before the offset landed — leaving 167 of its 180px buried under chrome. The fix is `scroll-margin-top: 176px` on `.provider-card`, in the same rule (`scripts/crawlable-sources-page.mjs:1008`). Below 720px `.catalog-controls` goes `static` and only the header stickies, so 176px is generous there rather than wrong (`scripts/crawlable-sources-page.mjs:1030`).

### 3. Anchors must survive every change to the rest of the catalog

Same root property as (1), stated as the invariant you can actually run. Not one check but a family, because each member catches a different leak: generate over the catalog and over its reverse (ordering); generate with a colliding entry present and absent (membership — the one shape 2 fails); generate the same key alone and among neighbours (everything else). A single "is deterministic" assertion passes on all three broken shapes, because each of them *is* deterministic — given the same catalog.

### The test shape that catches all three

The obvious test — and the one the first version of this test wrote — asserts that every ListItem url's fragment appears somewhere in the page. That test passes on a permuted anchor map, on a buried card, and on an order-dependent counter. The stronger assertions actually shipped:

- **Right card, not just some card.** `tests/crawlable-corpus.test.mjs:3620-3634` builds a `cardProviderByAnchor` map from the rendered `<article class="provider-card" id="..." data-provider="...">` markup and asserts each anchor's `data-provider` equals `corpusData.sourceCatalog[index].provider`. The comment at `:3606-3612` states why: "an anchor map that permuted its urls across the catalog would satisfy 'every fragment resolves' while sending every citation to the wrong source."
- **Rendered stylesheet clears the chrome.** `tests/crawlable-corpus.test.mjs:6270-6289` reads the `extraStyles` the page generator *returns* — not the module's source text — matches the `.provider-card { ... }` rule, and asserts `scroll-margin-top` is `>= 167`. Reading the rendered style block is what makes a future header resize that re-buries the anchors fail.
- **Independence from the rest of the catalog.** `tests/crawlable-corpus.test.mjs:6290-6341` pins each way an anchor must not move, as separate assertions: colliding keys stay distinct; reversing the catalog changes nothing; adding a *later* collider changes nothing (the assertion that shape 2 fails); and the same key alone versus among neighbours yields the same string. Writing them as four named claims rather than one "is deterministic" check is what made the shape-2 gap visible as a specific missing assertion.
- **Character class.** `tests/crawlable-corpus.test.mjs:6252-6268` pins every anchor to `/^provider-[a-z0-9-]+$/`. The card markup interpolates the id without `escapeHtml`, unlike every sibling attribute on that element (`scripts/crawlable-sources-page.mjs:816`), so the slug's character class — not the caller — is what makes that safe.

## Why This Matters

An anchor in a nav menu is cosmetic. A human who lands in the wrong place scrolls, and nothing is lost.

An anchor published in JSON-LD is a **citation an assistant or a search index will store and repeat**. At that point "resolves" and "resolves to the right thing, visibly" stop being the same claim, and the failure modes stop being self-correcting:

- A **repointed anchor** is worse than a dead one. A 404-ish dead fragment degrades to the top of the page; a fragment that now names a *different* provider attributes one publisher's data to another, in a citation that has already been crawled and stored. Nothing in the build, the tests, or the browser reports an error.
- A **buried anchor** defeats the entire purpose of adding the url. The reason the ItemList carries a url at all is so `numberOfItems` "publishes a count of things a reader can go and look at" (`scripts/crawlable-sources-page.mjs:707-708`). A citation that scrolls a reader to 13 visible pixels of a 180px card has technically resolved and practically failed.
- **Ordering coupling is invisible until it bites.** The collision branch is unreachable through the real catalog today — the generated-corpus run over the live catalog produces 748 keys, 748 distinct anchors and zero suffixed ones, asserted at `tests/crawlable-corpus.test.mjs:3617-3619` — so an arrival-ordered counter would have sat there passing every test until the day a new provider key collided, at which point the damage would be silent and already indexed.

The unifying point: adding a machine-readable url to something moves it from the "presentation" budget to the "data contract" budget. Presentation defects are absorbed by the human; data-contract defects propagate.

## When to Apply

- **You are adding `url` values to `ListItem`, `ItemList`, `FAQPage`, `HowTo`, `speakable`, or any other JSON-LD node that points at an in-page fragment.** Everything above applies verbatim.
- **You are generating ids from slugs and need a collision disambiguator.** Never use arrival order, index position, or a counter. Derive the suffix from the entity's own stable key (hash it) so the id is a pure function of identity. Keep a uniqueness backstop for hash collisions.
- **Your page has any `position: sticky` chrome above the anchored region.** Sum the sticky stack's bottom edge, set `scroll-margin-top` above it, and assert the value in a test that reads rendered CSS.
- **You are about to write a test that asserts an anchor exists.** That is the weak form. Ask what a *permuted* anchor map, a *reordered* input, or a *taller header* would do to it — and if the answer is "still passes", the test has no teeth.
- **Not needed** for anchors that are purely internal navigation (a table-of-contents jump within an article, a tab deep-link) and are never emitted as machine-readable data. Those stay in the cosmetic budget.

## Examples

### Order-dependent counter → identity-derived digest

**Rejected shape 1** — order-dependent; `provider-a-b` migrates between providers when the sort order changes:

```js
const seen = new Map();
const n = (seen.get(base) ?? 0) + 1;
seen.set(base, n);
const anchor = n === 1 ? `provider-${base}` : `provider-${base}-${n}`;
```

**Rejected shape 2** — order-independent but membership-dependent; the bare id is reassigned the day a second claimant appears:

```js
const claimants = new Map();
for (const provider of sourceCatalog) {
  const base = slugBase(provider.provider);
  claimants.set(base, (claimants.get(base) ?? 0) + 1);
}
// ...later, per provider:
const preferred = claimants.get(base) === 1
  ? `provider-${base}`                       // <- changes when a collider joins
  : `provider-${base}-${digest(provider.provider)}`;
```

**Shipped** (`scripts/crawlable-sources-page.mjs:757-766`) — no first pass, no conditional, no reference to any other entry:

```js
const anchors = new Map();
const used = new Set();
for (const provider of sourceCatalog) {
  const key = String(provider.provider ?? '');
  const preferred = `provider-${slugBase(key)}-${createHash('sha1').update(key).digest('hex').slice(0, 6)}`;
  let anchor = preferred;
  for (let suffix = 2; used.has(anchor); suffix += 1) anchor = `${preferred}-${suffix}`;
  used.add(anchor);
  anchors.set(provider.provider, anchor);
}
```

The loop body reads `provider` and nothing else — that is the whole property, and it is visible at a glance in a way "we handle collisions correctly" never is.

### Weak anchor test → citation-grade test

**Weak** (passes on a permuted map, a buried card, and an order-dependent counter):

```js
for (const url of urls) {
  assert.ok(body.includes(`id="${url.slice(url.indexOf('#') + 1)}"`));
}
```

**Strong, (i) right card** (`tests/crawlable-corpus.test.mjs:3618-3634`):

```js
const cardProviderByAnchor = new Map(
  [...sourcesPage.matchAll(/<article class="provider-card" id="([^"]+)" data-provider="([^"]*)"/g)]
    .map((match) => [match[1], unescapeAttribute(match[2])]),
);
providerAnchors.forEach((anchor, index) => {
  const expected = corpusData.sourceCatalog[index].provider;
  assert.ok(cardProviderByAnchor.has(anchor), `${anchor} must name a card in the rendered page, ...`);
  assert.equal(cardProviderByAnchor.get(anchor), expected,
    `the ListItem for ${expected} must point at that provider's own card`);
});
```

The test decodes the rendered attribute rather than re-escaping the expected value, because the generator's `escapeHtml` also covers `'` (L'Orient Today) and a second copy of that table in the test would be one more thing to keep in step (`tests/crawlable-corpus.test.mjs:3613-3617`).

**Strong, (ii) visible landing** (`tests/crawlable-corpus.test.mjs:6280-6289`) — reads the returned `extraStyles`, not the module source:

```js
const { jsonLd, extraStyles } = await renderCatalog(CATALOG);
assert.ok(itemListOf(jsonLd).itemListElement.every((element) => element.url.includes('#provider-')));
const rule = extraStyles.match(/\.provider-card \{([^}]*)\}/);
assert.ok(rule, 'the page must still ship a .provider-card rule');
const offset = rule[1].match(/scroll-margin-top:\s*(\d+)px/);
assert.ok(offset, '.provider-card must set scroll-margin-top or every ListItem url lands under the sticky bars');
assert.ok(Number(offset[1]) >= 167,
  `scroll-margin-top must clear the sticky bars' 167px, got ${offset[1]}px`);
```

**Strong, (iii) independence from the rest of the catalog** (`tests/crawlable-corpus.test.mjs:6290-6341`). The two assertions that matter most are the ones about *change over time*, not about a single render:

```js
// reordering moves nothing
const reversed = sourceCardAnchors([...colliders].reverse());
for (const { provider } of colliders) {
  assert.equal(reversed.get(provider), forward.get(provider),
    `${provider} must keep its anchor when the catalog is reordered`);
}

// adding a LATER collider moves nothing either — the case shape 2 gets wrong
const alone = sourceCardAnchors([{ provider: 'a.b' }]);
assert.equal(forward.get('a.b'), alone.get('a.b'),
  'adding a colliding provider must not change an anchor that was already published');

// and an anchor does not depend on the catalog at all
assert.equal(
  sourceCardAnchors([{ provider: 'finance.yahoo.com' }]).get('finance.yahoo.com'),
  sourceCardAnchors([{ provider: 'zzz' }, { provider: 'finance.yahoo.com' }, { provider: 'aaa' }]).get('finance.yahoo.com'),
  'an anchor must not depend on which other providers are present',
);
```

The same block pins the degenerate case too: two unsluggable keys (`'---'`, `'!!!'`) both fall back to the `source` base and still get distinct anchors, because the digest distinguishes them.

### The JSON-LD the anchors feed

`scripts/crawlable-sources-page.mjs:1118-1129` — every element is a `ListItem` with a dense 1-based `position` and a fragment url, and `numberOfItems` now counts addressable things:

```js
mainEntity: {
  '@type': 'ItemList',
  numberOfItems: sourceCatalog.length,
  itemListOrder: 'https://schema.org/ItemListUnordered',
  itemListElement: sourceCatalog.map((provider, index) => ({
    '@type': 'ListItem',
    position: index + 1,
    name: provider.displayName,
    url: `${pageUrl}#${cardAnchors.get(provider.provider)}`,
  })),
},
```

The fixture at `tests/crawlable-corpus.test.mjs:6205-6225` deliberately uses two catalog entries sharing the display name "Yahoo Finance" (`finance.yahoo.com` and `query1.finance.yahoo.com`), and the assertion at `tests/crawlable-corpus.test.mjs:6345-6358` requires one distinct name but two distinct urls — the case the whole change exists to serve.

## Related

- Issue #7869 — round-7 GEO residue (uncached sitemaps, `/sources` ItemList strings, YouTube gap, measurement notes)
- PR #7881 — `fix(seo): cache the root sitemaps, close the /sources ItemList, cite the press (#7869)` (open, unmerged as of 2026-09-08)
- `scripts/crawlable-sources-page.mjs:699-770` — `sourceCardAnchors()` and its docstring, which records the same reasoning at the call site
- `tests/crawlable-corpus.test.mjs:6197-6359` — the `GEO residue #7869 (sources ItemList)` describe block

## Related learnings

- [`unique-match-is-not-identity-verify-attribution-against-an-authoritative-field`](../conventions/unique-match-is-not-identity-verify-attribution-against-an-authoritative-field.md) — the closest conceptual sibling. Different domain (SEC EDGAR company resolution), same abstract fix: derive the identifying value from an authoritative source rather than an incidental one. Not prior art for this defect.
- [`pinned-value-allowlist-freezes-a-snapshot-not-the-invariant`](./pinned-value-allowlist-freezes-a-snapshot-not-the-invariant.md) — same anti-pattern family. "A guard that pins today's known-wrong values is not the invariant" rhymes with "an id-exists test is not the invariant"; that one is about JSON-LD `@id` contract gates across surfaces, this one about anchor identity on a single page.
- [`closed-world-classification-gate-for-config-completeness`](./closed-world-classification-gate-for-config-completeness.md) — same producer file (`scripts/crawlable-sources-page.mjs`), unrelated concern (catalog domain classification). Context only.

A fresh search of all 119 docs under `docs/solutions/` found no existing entry governing anchor-suffix determinism or scroll-offset behaviour under sticky chrome; both halves of this learning are new ground.
