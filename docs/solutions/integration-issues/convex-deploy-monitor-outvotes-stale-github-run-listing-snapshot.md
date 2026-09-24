---
title: The post-merge deploy monitor false-alarmed on a stale GitHub run-listing snapshot, not a dead workflow
date: 2026-09-24
category: integration-issues
module: check-postmerge-deploys
problem_type: integration_issue
component: development_workflow
symptoms:
  - "`postmerge-deploy ERROR: Convex Deploy [NO_RUN_IN_WINDOW] the newest run of convex-deploy.yml on main (34136482776) predates the 168h window — the workflow may have stopped running`"
  - "Post-merge Deploy Monitor failed 21 of its last 120 ticks between 2026-09-23T07:34Z and 2026-09-24T09:54Z, naming the same run id every time"
  - "Convex Deploy ran and succeeded on every push to main throughout the window, and the `convex-deployed` tag showed production current"
  - "The same script run locally against the same `main` was green on every attempt"
  - "`GET /repos/{repo}/actions/workflows/convex-deploy.yml/runs?branch=main&per_page=100` answers HTTP 200 with `total_count` 1366 against a true 3168 and a 17-day-old run as the newest, interleaved with correct answers to the identical URL"
root_cause: async_timing
resolution_type: code_fix
severity: high
related_components: [tooling, development_workflow]
tags: [github-actions, postmerge-monitor, stale-api-response, eventual-consistency, false-alarm, convex-deploy, run-listing, scheduled-workflow]
---

# The post-merge deploy monitor false-alarmed on a stale GitHub run-listing snapshot, not a dead workflow

## Problem

Post-merge Deploy Monitor (`.github/workflows/postmerge-deploy-monitor.yml`, cron `'*/10 * * * *'` at line 20) began failing intermittently on 2026-09-23, always with the same claim: Convex Deploy had not run on `main` inside its 168-hour window, so "the workflow may have stopped running". It had. Convex Deploy fires on every push to `main` and had succeeded minutes before several of the failing ticks.

The alarm rested on a single read of one GitHub REST endpoint, and that endpoint intermittently answers with an index snapshot weeks out of date — as an HTTP 200, indistinguishable from a correct answer.

## Symptoms

21 of the monitor's last 120 ticks failed, starting 2026-09-23T07:34:07Z (run 35832392267) and continuing through 2026-09-24T09:54:09Z (run 35984056173). Every failure named the identical run id, which is what ruled out ordinary replica lag:

```
postmerge-deploy ERROR: Convex Deploy [NO_RUN_IN_WINDOW] the newest run of
convex-deploy.yml on main (34136482776) predates the 168h window — the
workflow may have stopped running
```

The contradicting evidence, all gathered while the monitor was red:

| check | result |
| --- | --- |
| `gh run list --workflow=convex-deploy.yml --branch main` | 10 runs on 2026-09-24 alone, newest `35984047603` at 09:54:04Z, `success` |
| the run the monitor named, `34136482776` | real, `success`, created **2026-09-07T15:05:43Z** — the 520th-newest run, not the newest |
| `git ls-remote --tags origin convex-deployed` | `054bce8ba2…`, with no bundled path changed since — production current |
| `node scripts/check-postmerge-deploys.mjs` locally | `ok: Convex Deploy [DEPLOY_SKIPPED_LEGIT]`, exit 0, every attempt |
| workflow entities matching `convex` | exactly one, id `267207599`, state `active` — not a deleted-and-recreated workflow |

The two other monitored workflows reported fresh runs in the same failing ticks, so nothing was globally wrong with the runner's view of the Actions API.

## What Didn't Work

- **Believing the message.** "The workflow may have stopped running" is the monitor's own hypothesis, not an observation. The observation is only "the listing I read names this run as newest".
- **Reproducing locally.** 25 unauthenticated and 40 authenticated reads of the exact URL, all fresh, all `total_count=3168`. Local reproduction was never going to happen; this only appears from GitHub-hosted runners.
- **Blaming the token.** The workflow declares `permissions: contents: read`, so `GITHUB_TOKEN` carries `actions: none`. It was a plausible cause and it is not the cause — the same job read the other two workflows' listings correctly.
- **Looking for a second workflow entity.** A deleted-and-recreated `convex-deploy.yml` would resolve by filename to an older workflow id. There is only one, and the file has never been deleted (`git log --follow --diff-filter=ADR`).
- **Suspecting a pagination cap.** The named run sits at index 519 of the listing, nowhere near the 1000-result ceiling that endpoint is known for.
- **Suspecting a recent code change.** `scripts/check-postmerge-deploys.mjs` was last touched by #8311 on 2026-09-22, which only appended `shared/checkout-errors.ts` to `skipProofPaths` — a code path evaluated *after* the verdict that was failing.

## Solution

The reproduction had to happen in CI, so a throwaway workflow was pushed to a side branch (no `push:` trigger in this repo matches a non-main branch — every branch-scoped one is `branches: [main]` and the rest fire only on tags — so a side branch runs nothing else) that looped the exact request 30 times in one job. Attempt 2 of 30:

```
1  total=3168 n=100 first_id=35984047603 first_created=2026-09-24T09:54:04Z
2  total=1366 n=100 first_id=34136482776 first_created=2026-09-07T15:05:43Z
3  total=3168 n=100 first_id=35984047603 first_created=2026-09-24T09:54:04Z
```

`total_count` 1366 against a true 3168. GitHub served a **stale index snapshot** — an older view of the same run history — with HTTP 200 and no header distinguishing it from the correct answer (`cache-control: private, max-age=60, s-maxage=60` on both, distinct `x-github-request-id` on every call).

The fix, proposed in PR #8613 and unmerged as of this writing, samples the listing instead of trusting one read. `readRunListingOnce` keeps the old single-read validation; `readNewestRun` (`scripts/check-postmerge-deploys.mjs:359` on the fix branch) is changed to loop:

```js
export function readNewestRun({
  gh,
  repository,
  workflowFile,
  now,
  noRunWindowMs = DEFAULT_NO_RUN_WINDOW_MS,
  samples = RUN_LISTING_SAMPLES,
}) {
  let newest = null;
  for (let sample = 0; sample < samples; sample += 1) {
    const candidate = readRunListingOnce({ gh, repository, workflowFile })[0];
    if (!candidate) continue;
    if (newest === null || parseTimestamp(candidate.created_at) > parseTimestamp(newest.created_at)) {
      newest = candidate;
    }
  }
  // ...window and verdict logic unchanged
}
```

`RUN_LISTING_SAMPLES` is set to 3 by that PR (`scripts/check-postmerge-deploys.mjs:172`); neither it nor the sampling loop exists on `main` until the PR merges, so every line number cited here is branch-local. Everything downstream — the window check against `noRunWindowMs`, the skip proof, the job reads — is untouched.

Two tests pin it (`tests/check-postmerge-deploys.test.mjs`), both confirmed red before the change:

- `outvotes a stale run-listing snapshot instead of alarming on it` — stale samples in all six position combinations across three reads must not win over a fresh one.
- `still alarms when every sample of the run listing agrees the newest run is old` — a genuine "workflow stopped running" still alarms, and asserts `reads > 1` so a future refactor cannot quietly collapse back to a single read.

## Why This Works

Taking the maximum across samples is safe in the only direction that matters. A stale snapshot is an *older view of the same history* — every run in it is a real run that really happened. It can omit recent runs; it cannot invent one. So the newest run across N samples is always a real run, and it is the true newest whenever at least one sample is fresh.

`createRetryingGh` could never have helped. It classifies failures by whether GitHub *answered* — a 404 is an answer, a timeout is not. The stale snapshot is an answer, and a successful one. Nothing in the response body or headers marks it; only comparison against another read does.

The measured stale rate was ~1 read in 30. Three independent samples move a false alarm from roughly 3% per read to roughly 0.003% per tick. Cost is 9 listing reads per tick instead of 3, at one tick per 10 minutes — far inside both the job's `timeout-minutes: 10` and the `GITHUB_TOKEN` hourly budget.

The same defect had a second, worse direction that the fix also closes once merged. Convex Deploy's window is 7 days (`scripts/check-postmerge-deploys.mjs:98`), so a 17-day-old stale run fell outside it and produced a loud false alarm. The other two monitored workflows use 14-day windows, where a stale snapshot can land *inside* the window — and the monitor would then have judged an old green run and reported `DEPLOYED` while a recent deploy actually failed. A false green on precisely the alarm this monitor exists to raise, and one nobody would have noticed.

## Prevention

- **Never derive an alarm — or a green — from one read of the Actions run-listing API.** Sample it and reduce. This generalises past this endpoint: any read whose "nothing here" answer is indistinguishable from "I could not see it" needs corroboration before it becomes a verdict.
- **A monitor's message is a hypothesis; the read is the observation.** When a monitor contradicts directly observable reality, suspect the monitor's input before its logic. The tell here was that it named the *same* run every time — genuine replica lag drifts, a pinned value means a reproducible bad answer.
- **A CI-only anomaly needs a CI-side reproduction.** Push a throwaway workflow to a side branch that loops the exact request 30× and prints the discriminating fields (`total_count` and the first run id). No `push:` trigger in this repo matches a non-main branch — the branch-scoped ones are all `branches: [main]`, the rest are tag-scoped — so a side branch costs one job. Delete the branch afterwards.
- **Print the field that would have revealed it.** The monitor read `total_count` on every call and never looked at it. A one-line assertion that `total_count` is non-decreasing across samples would have named this in the first failing tick instead of the thirtieth.
- **This is the same shape as a silently partial upstream answer**, which this project has hit before in other systems: an API that returns fewer rows than exist, successfully, and a consumer that treats "what I got" as "what there is".

## Related

- [`umami-answers-http-200-when-it-drops-a-bot-write.md`](./umami-answers-http-200-when-it-drops-a-bot-write.md) — the closest root-cause twin: a vendor endpoint answers HTTP 200 while silently dropping the substance, and the alarm built on it inherits the lie.
- [`upstash-max-request-size-counts-one-command-and-answers-http-200.md`](./upstash-max-request-size-counts-one-command-and-answers-http-200.md) — same family, and the same lesson that a diagnostic script built on a successful-looking read names the wrong cause.
- [`actions-cannot-open-a-review-pr-and-the-monitor-realerts-after-the-fix.md`](./actions-cannot-open-a-review-pr-and-the-monitor-realerts-after-the-fix.md) — the other scheduled monitor in this repo that alarmed on a stale view of GitHub state rather than on reality.
- [`../best-practices/checks-must-fail-closed-when-they-lose-their-target.md`](../best-practices/checks-must-fail-closed-when-they-lose-their-target.md) — the mirror image. That doctrine covers a check that can no longer see its target; this one covers a check that sees a *wrong* target and believes it.

## Related Issues

- #6376 — the issue that created Post-merge Deploy Monitor, after `main` went green while a production deploy failed.
- #6479 — the first time this same monitor needed hardening against GitHub API unreliability, that time a transport blip; fixed by adding `createRetryingGh` and an UNKNOWN vocabulary distinct from ALARM. That retry budget is exactly what cannot see the failure documented here, because a stale snapshot is a success.
- #8613 — the PR carrying this fix.
