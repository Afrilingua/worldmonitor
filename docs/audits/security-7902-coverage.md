# Security tracker 7902: coverage and closure inventory

Inventory revision: `8442418e86420df015c1ff9187395c55ad2cacff`. Evidence refreshed on 2026-09-08.

This is an administrative evidence reconciliation, not a source audit. Keep [#7902](https://github.com/koala73/worldmonitor/issues/7902) open. Merged repairs, reported local tests, CI, deployment and production acceptance are separate states. No scan was started or resumed for this inventory.

## Coverage rules and current paths

`git ls-tree -r` enumerated **6878 tracked paths** at the revision above. Each path is recorded with its Git blob ID in the local `path-inventory.csv`. All 6878 have status **unreviewed** for complete-file security coverage; reviewed = 0. This does not discard prior narrow checks. It prevents a patch, search hit, selected boundary review or PR file list from becoming a whole-file audit claim.

Status rules:

- **Reviewed:** exact existing evidence establishes complete security review of that path and matches the inventoried content. No supplied evidence meets this rule.
- **Unreviewed:** no such evidence exists, including paths with narrower PR or source-boundary evidence.
- **Excluded with reason:** material outside this Git-tree inventory is listed below. Exclusion from this inventory is not exclusion from parent acceptance.

Entrypoint hints in the CSV come only from path conventions. They are not a discovered call graph or proof of exported route reachability. Explicit historical entrypoints appear in the lead table below.

| Tracked area | Paths | Whole-file status |
| --- | ---: | --- |
| `(root)` | 54 | Unreviewed |
| `.agents` | 17 | Unreviewed |
| `.audit` | 1 | Unreviewed |
| `.github` | 58 | Unreviewed |
| `.husky` | 2 | Unreviewed |
| `api` | 232 | Unreviewed |
| `blog-site` | 236 | Unreviewed |
| `cli` | 7 | Unreviewed |
| `consumer-prices-core` | 133 | Unreviewed |
| `convex` | 147 | Unreviewed |
| `data` | 6 | Unreviewed |
| `deploy` | 1 | Unreviewed |
| `docker` | 26 | Unreviewed |
| `docs` | 713 | Unreviewed |
| `e2e` | 152 | Unreviewed |
| `pro-test` | 106 | Unreviewed |
| `proto` | 317 | Unreviewed |
| `public` | 142 | Unreviewed |
| `scripts` | 798 | Unreviewed |
| `sdk` | 16 | Unreviewed |
| `server` | 469 | Unreviewed |
| `shared` | 189 | Unreviewed |
| `skills` | 25 | Unreviewed |
| `src` | 903 | Unreviewed |
| `src-tauri` | 69 | Unreviewed |
| `tests` | 2043 | Unreviewed |
| `workers` | 16 | Unreviewed |

| Outside-tree surface | Inventory status and reason | Closure owner |
| --- | --- | --- |
| Git history and deleted content | Excluded: current tree enumeration cannot inspect historical exposure | Parent audit owner, after supported access recovery |
| Built bundles and image layers/secrets | Excluded: no build or image contents collected in this lane | Release acceptance owner |
| Live configuration, secrets and customer records | Excluded: metadata inventory has no production access evidence; records are outside scope | Release owner and account/provider owners |
| Installed dependency contents/advisory databases | Excluded: tracked lockfiles are inventoried, installed trees and database results are separate evidence | Dependency/CI lane; existing Rust #5935 owner |

## Retained families and narrow existing evidence

The failed deep run retained 16 finding entries and 52 deferred/checkpoint records. The local `retained-records.csv` preserves all 68 original IDs, row indexes, payload digests and reported severity values. One record can map to both email and Telegram; a scan-stopped record maps to #7902. These are not counts of distinct vulnerabilities. Seven npm snapshots are a separate package-evidence set owned by #7901.

Repeated Docker records share the public administration authority defect; the local secret-validation probe is a sibling operation with different impact. Docker RSS active content, cloud RSS allowlist control, mapped-address classification and URL-object handling remain distinct mechanisms. Email and Telegram share some records but require different destination proofs. Original low/medium/high rating differences are retained locally; this reconciliation does not assign a new severity.

| Owner / entrypoint family | Existing PR | Evidence disposition and remaining requirement |
| --- | --- | --- |
| [#7889](https://github.com/koala73/worldmonitor/issues/7889) (OPEN) — Docker /api/local-*; relay dispatch | [7910](https://github.com/koala73/worldmonitor/pull/7910) | Administration authority repair reported; private-network validation sibling covered by synthetic denied-transport regression; production exposure remains unknown. |
| [#7891](https://github.com/koala73/worldmonitor/issues/7891) (CLOSED) — Docker /api/rss-proxy navigation/frame | [7913](https://github.com/koala73/worldmonitor/pull/7913) | Docker active-document repair and browser fixture reported; image ingress acceptance pending. Keep separate from cloud allowlist. |
| [#7892](https://github.com/koala73/worldmonitor/issues/7892) (CLOSED) — sidecar outbound IP guard; URL-object wrapper | [7913](https://github.com/koala73/worldmonitor/pull/7913) | Mapped-address repair reported; URL-object wrapper follow-up remains undisposed. |
| [#7893](https://github.com/koala73/worldmonitor/issues/7893) (OPEN) — gateway classify-event, get-country-intel-brief, analyze-stock | [7907](https://github.com/koala73/worldmonitor/pull/7907) | Quota repair reported for three AI routes; sibling gateway tests do not prove full provider paths. |
| [#7894](https://github.com/koala73/worldmonitor/issues/7894) (OPEN) — notification setters; email relay/digest | [7908](https://github.com/koala73/worldmonitor/pull/7908) | Email ownership repair and real-time/digest mocks reported; custom-content impact must stay bounded by recipient ownership, not arbitrary-message claims. |
| [#7895](https://github.com/koala73/worldmonitor/issues/7895) (CLOSED) — registerInterest backing mutation; HTTP bridge | [7911](https://github.com/koala73/worldmonitor/pull/7911) | Internal mutation and uniform retry response repair reported; direct mutation, referral and membership controls covered in PR evidence. |
| [#7896](https://github.com/koala73/worldmonitor/issues/7896) (OPEN) — Telegram setters; pairing-token redemption; callback | [7909](https://github.com/koala73/worldmonitor/pull/7909) | Setter and token-redemption repair reported; callback proof and legacy destination rejection tested with mocked delivery. |
| [#7897](https://github.com/koala73/worldmonitor/issues/7897) (OPEN) — checkout customer reuse; customer portal | [7906](https://github.com/koala73/worldmonitor/pull/7906) | Blocked hypothesis: provider mailbox proof before customer reuse and actual shared portal scope missing. |
| [#7898](https://github.com/koala73/worldmonitor/issues/7898) (CLOSED) — safeHtml promoted descendants | [7914](https://github.com/koala73/worldmonitor/pull/7914) | Traversal bug repaired as hardening; reviewed callers had no established attacker-controlled input. Do not generalize to all callers. |
| [#7899](https://github.com/koala73/worldmonitor/issues/7899) (OPEN) — cloud /api/rss-proxy allowlist and MIME | No earlier linked PR; active lane owns refresh | Blocked cloud hypothesis: allowlisted publisher control and real response execution evidence missing; cloud lane owns refresh. |
| [#7900](https://github.com/koala73/worldmonitor/issues/7900) (OPEN) — checkout product ID; signed subscription webhook | [7916](https://github.com/koala73/worldmonitor/pull/7916) | Fallback characterized, not repaired; provider and deployed-configuration evidence remains with the payments owner. No production reachability disposition is established by this inventory. |
| [#7901](https://github.com/koala73/worldmonitor/issues/7901) (OPEN) — seven npm lockfiles; Cargo; Umami pnpm | [7912](https://github.com/koala73/worldmonitor/pull/7912) | Package matches only; dependency lane owns current advisory and reachability evidence. |

All ten listed PR heads are ancestors of the inventory revision. Their exact heads, changed files and current descriptions are retained in local `prs.json`. Test results above are prior PR reports; this lane did not rerun application tests. Closed child state does not dispose of an omitted lead or prove rollout. In particular, #7892 closure does not establish URL-object handling.

## Access and evidence limits

The [parent tracker](https://github.com/koala73/worldmonitor/issues/7902) records a platform policy refusal before the broader audit completed. Resolve that recorded control through its supported access process. This inventory does not establish resolution or successful completion of the failed scan. Scan identifiers, account-access results, diagnostic details and private service evidence remain in the local evidence packet.

No new scan was started or resumed. Existing selected-path review evidence is retained locally with its provenance and limits; an empty findings list does not establish complete coverage.

## Closure checklist and owners

- [ ] **Account owner:** resolve the recorded policy refusal through its supported process; preserve the exact outcome.
- [ ] **Parent audit owner:** reconcile the existing source-review evidence and all original records; complete the unreviewed source boundaries under the supported workflow, including API/server/Convex account, billing, OAuth/cache, worker/admin, browser sinks, CI/release/updater/native, Docker/blog/pro-test, and generated/public contracts.
- [ ] **Release acceptance lane:** verify each repair’s exact revision, positive/negative regression evidence and CI; record gaps separately from merge. Complete Docker ingress, quota, waitlist bridge and sanitizer runtime acceptance.
- [ ] **Release acceptance lane / #7892 owner:** explicitly disposition the retained URL-object wrapper follow-up; mapped-IPv6 tests alone do not close it.
- [ ] **Cloud RSS lane / #7899:** establish publisher control, response headers and actual harmless browser behavior, or record the limiting control and exact missing evidence.
- [ ] **Dependencies/CI lane / #7901 and existing #5935 owner:** disposition each advisory-to-caller path, complete Cargo and vendored pnpm evidence, coordinate scanner ownership and expiring suppressions. Preserve database failures as missing evidence.
- [ ] **Payments lane / #7897 and #7900:** complete provider mailbox-reuse, portal-scope and deployed product-reachability evidence; end each hypothesis as confirmed, rejected with its control, or blocked with exact evidence needed.
- [ ] **Release owner / notification owners:** approve the email re-verification plan, provision required access, deploy in the documented order, require Telegram re-pairing, and perform separately authorized owned-destination acceptance. No real delivery is authorized by this inventory.
- [ ] **Release and parent audit owners:** record history, built-bundle, image-secret and deployed-configuration coverage or an explicit accepted limit.
- [ ] **Parent tracker owner:** integrate child dispositions without inflating duplicates, refresh final revision and PR state, and reassess all acceptance criteria. Keep #7902 open until every unresolved requirement is completed or explicitly accepted by its owner.

## Reproduction and verification

Local evidence bundle: `worldmonitor-7902-coverage` in the task temporary evidence directory. Raw scan and provider evidence is not committed. The bundle includes `build.py`, `path-inventory.csv`, `retained-records.csv`, `evidence-index.json`, `issue.json`, `children.json`, `prs.json` and `preflight.json`.

The inventory builder checks exact tracked-path membership, one record per tracked path, all 68 retained-record mappings, and ancestry of the ten merged PR heads. Documentation checks cover Markdown, public-document references and whitespace only. They do not test application security.
