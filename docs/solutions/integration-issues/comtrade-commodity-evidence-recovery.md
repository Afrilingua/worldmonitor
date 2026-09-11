---
title: Comtrade commodity evidence and cache recovery
module: supply-chain
problem_type: integration_issue
date: 2026-09-11
issue: 7990
---

# Scope and current evidence

This repair keeps numeric partner codes, stored shares, and source clocks intact. It does not certify procurement readiness. Issue #7990 must remain open for the live and route acceptance items below. Presentation work in PR #7985 is separate.

Read-only Redis GETs on 2026-09-11 reproduced the published issue observations through `loadEnvFile` and `readSeedSnapshot({strict:true})`. No seed, refresh, or cache write ran against production.

| Cache | Fetch timestamp UTC | Headings | Relevant evidence |
| --- | --- | --- | --- |
| JP | 2026-09-01 06:05:21 | 36 | HS2804, 2024; partner 842 has empty ISO and share 0.392 |
| US | 2026-09-01 06:03:36 | 36 | HS2804, 2024; partner 579 has empty ISO |
| DE | 2026-07-27 16:47:53 | 20 | HS2804/2836 absent; HS1001 year 2023 |

Aggregate metadata had `recordCount:160`, `status:ok`, and `preserveStreaks.DE:1`. This proves preservation, not the historical provider response. The September run's specific Germany failure cannot be reconstructed from these old metadata fields. Keep that historical cause unverified unless deployment-specific logs establish it.

# Reproduced causes and changes

- Both producers used a standard UN code lookup. The provider's [partner reference](https://comtradeapi.un.org/files/v1/app/reference/partnerAreas.json), retrieved 2026-09-11, explicitly maps 842 to US, 251 to FR and 579 to NO. Their customs areas include named territories; the exported partner scope retains that distinction. Code 490 is “Other Asia, nes” without a country ISO, so the Taiwan reporter override is not applied. Current provider entries take precedence over a standard-code fallback; historical, aggregate and special entries stay non-country rows.
- Scheduled ingestion requests 36 headings, while the lazy producer requested only the original 20. Both now use one catalogue and grouping implementation. A legacy 20-heading cache can therefore be investigated without waiting for expiry. This mismatch is a demonstrated recovery defect, not proof that the lazy producer created Germany's July record.
- Scheduled HTTP failures were returned as empty arrays. A successful first batch and failed second batch could publish a smaller country payload. HTTP errors and malformed/truncated data now reject the country attempt and preserve the previous payload. Valid empty results remain `no_records`, not provider failure or zero trade. Per-country attempt states and missing headings are recorded in seed metadata.
- Both producers retain the bounded two-request catalogue shape. The monthly freshness/quota gate is unchanged. Lazy recovery has a shared five-second provider deadline and no fallback year; an older valid annual observation can remain in the preserved cache. The public [preview cap is 500 records](https://uncomtrade.org/docs/what-is-data-preview/). A response at the explicit record limit is treated as incomplete. A short response still does not independently prove worldwide reporting completeness.
- The country-products reader normalizes old cached identities without rewriting shares. It passes the cache source/fetch timestamp, requested and missing headings, and refresh outcome into capture and exports. Requested headings with no returned positive rows are distinguished from unrequested legacy coverage. Cache read errors do not start a recovery write.
- Cold lazy writes use NX. Warm recovery uses the existing 24-hour lazy cache, so it cannot replace a newer scheduled canonical write. A warm result must retain every previous heading at an equal or later observation year. Obsolete warm results do not replace newer canonical evidence.
- `/api/seed-health` exposes preserved countries and per-country heading gaps even when the aggregate producer count is `ok`. Old metadata identifies preserved countries but cannot identify its missing headings. This is explicit, not inferred complete coverage.

The comparison's vulnerability context uses `seed-supply-vulnerability.mjs` -> `getCountryVulnerabilities`; its import concentration uses numeric shares without filtering on partner ISO, so this identity fix does not change that calculation. `get-route-impact` also normalizes legacy origins. Other derived exposure caches still require a normal authorized producer cycle before their legacy contents can be claimed recovered.

# Commodity scope

All exposed mappings now carry their HS2022 basket name from the [H6 reference](https://comtradeapi.un.org/files/v1/app/reference/H6.json), retrieved 2026-09-11. Existing stage-specific caveats remain.

- HS2804: hydrogen, rare gases and other non-metals. HS280429 is narrower but still covers rare gases other than argon, not helium alone. No helium-only internationally harmonized series was established in this investigation. Retain the proxy; do not derive helium shares from either basket.
- HS2836: carbonates/peroxocarbonates, not lithium alone. This is not battery-grade qualification or supplier capacity.
- HS1001: wheat and meslin. Customs calendar-year import values and marketing-year food balances are different observations.

Shares are import-value shares, not physical volume. Only leading partner rows are stored. Unresolved, duplicate-area, self, invalid and unlisted shares are not redistributed among displayed origins. New ingestion uses the reported World total for the same observation year when available, otherwise the sum of observed partner values; the basis is exported. World is excluded from ranked origins. A partner sum exceeding the World total by more than 0.1% rejects the attempt. The legacy denominator has not been independently reconciled to a complete World total. Capacity, vendor qualification, price, transport mode and lead time remain unknown.

# Route measurement and residual acceptance

Measured against the current route/port-cluster registries on 2026-09-11, using the actual cached candidate origins above:

| Selection | Candidate origins | Pairs with a model |
| --- | --- | --- |
| JP HS2804 | US, CN, DE, VN, QA | 4/5; US unknown |
| JP HS1001 | CA, US, AU, FR, NL | 3/5; CA and US unknown |
| US HS2804 | CA, BR, DE, AU, NO | 4/5; AU unknown |
| DE HS1001 | CZ, FR, SK, HU, AT | 5/5, not validated shipment paths |

Qatar-Japan intersects `qatar-asia-lng` with Hormuz and Malacca. US-Japan has no intersection. No route was invented to fill that gap. Shared route IDs can overstate pair coverage: e.g. Australia-Japan shares a Gulf route, and inland European pairs can share an Asia-Europe route. These matches require a separate geography/transport review; a count of models is not a count of validated transport paths. The comparison labels paths as models, treats unmodeled pairs as unknown, keeps chokepoints unordered, and does not treat a downstream Suez/Cape option as bypassing a Hormuz-blocked origin.

# Recovery, verification and rollback

1. After separate approval to merge/deploy, deploy the reader and scheduled producer together. The optional protobuf request/response fields are additive; existing cached rows remain readable. No destructive key migration is needed for identity recovery.
2. Use an authenticated `get-country-products?iso2=JP&hs4=2804` request, capture the comparison, and export HTML/JSON. Verify the stored US share remains 39.2%, code 842 and provider scope survive, and observation year differs from retrieval time. Compare the actual API payload with the source cache. A fixture screenshot is not this proof.
3. For Germany, requesting a missing heading permits bounded public recovery. A capped/error/older/incomplete result must keep the July payload and disclose the reason. A successful warm result is retained separately for 24h. Do not delete the old country key to force recovery.
4. Use the next natural scheduled run, or a separately authorized scoped refresh only after checking the remaining provider quota. Inspect `countryCoverage.DE`, its missing headings, source/fetch time, observation years and the authenticated API/UI. A green aggregate count alone is insufficient. Do not bypass the monthly gate to clear a health warning.
5. Compare `seed-meta:comtrade:bilateral-hs4`, `/api/seed-health`, country payloads, and actual exports. Fail acceptance if an unresolved origin disappears without disclosure, shares inflate, fetch time is presented as trade year, or incomplete recovery replaces last-good data.
6. Roll back application/worker revisions if these checks regress. Keep canonical country payloads. Warm recovery entries expire after 24h; any targeted deletion requires explicit authorization. No rollback should erase last-good records or force a quota-consuming seed.

Local proof includes failing-before-fix partner, catalogue, HTTP-failure, malformed-response and cap tests; real scheduled write-path tests; reader -> generated client/premium fetch -> capture -> builder -> DOM/embedded JSON; browser desktop/mobile captures and downloaded HTML/JSON parity. Browser responses are controlled fixtures using the shared ingestion normalization; they are not live Comtrade observations. The authenticated deployed API, natural post-deploy producer run, historical Germany failure and broader route validity remain open acceptance items under #7990.
