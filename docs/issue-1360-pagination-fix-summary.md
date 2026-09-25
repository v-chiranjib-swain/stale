# Issue #1360 — Pagination Skip Bug: Fix Summary

This branch (`fix/pagination-1360`) fixes [actions/stale#1360](https://github.com/actions/stale/issues/1360):
closing or otherwise mutating issues/PRs mid-run can shift pagination, causing later pages to skip items
that were never actually inspected.

**Live testing branch:** [`v-chiranjib-swain/stale@test/pagination-1360-per-page-10`](https://github.com/v-chiranjib-swain/stale/tree/test/pagination-1360-per-page-10) —
identical to `fix/pagination-1360` except `per_page` is reduced to `10`, making it practical to reproduce
multi-page scenarios on a live test repo without needing 100+ issues/PRs.

## 1. The Bug

The action fetches issues page by page (`per_page: 100`) and closes stale items as it goes. GitHub's
`issues.listForRepo` only returns **open** items, so as soon as an item on an earlier page is closed, every
item after it shifts up one position. If the action has already moved on to the next page by the time that
happens, the item that shifted into the previous page's last slot is **never fetched again** and is silently
skipped for the rest of the run.

The same kind of shift can also happen without any closures at all: if `days-before-stale`/`sort-by` is set
to `updated` or `comments`, simply processing an item (adding a stale label/comment) changes its sort key
and can move other items across page boundaries too.

## 2. The Fix

Two independent, minimal mechanisms were added to `IssuesProcessor.processIssues`:

### 2.1 Closure-aware retry with backoff (the core #1360 fix)

After processing a page, the action checks whether any of the items closed **this run** are still present
in that page's fetch:

- If items were closed **during this pass**, the page is re-fetched **immediately** (no wait) — a same-run
  closure is not evidence GitHub is behind, it's just the pre-close snapshot.
- If a **previously-closed** item (closed on an earlier pass) is *still* showing up in a fresh fetch, that
  means GitHub hasn't yet reflected the closure. The action backs off with exponential wait
  (`500ms → 1000ms → 2000ms → 4000ms → 5000ms`, capped at 5s) before re-checking the same page again.
- Once a fetch confirms the closed item is finally gone, an explicit `GitHub now reflects the closures on
  page #N.` message is logged and the run advances to the next page.

This "free first check, then back off" behavior means a run that closes items but never hits GitHub's
read-after-write lag pays **zero extra wait time** — the backoff only kicks in when actually needed.

### 2.2 Simple reorder detection for mutable sort keys

When `sort-by` is `updated` or `comments`, any pass that processed at least one new item on a page is
treated as a potential reorder and triggers one **immediate, no-wait** re-check of that same page before
advancing. This is a deliberately simple heuristic — it doesn't try to detect whether the sort key
*actually* changed, so it can trigger a few unnecessary re-checks. That trade-off keeps the logic and its
tests easy to reason about, at the cost of a few extra (free, non-blocking) API calls.

## 3. Log Output — Scenario Reference

### 3.1 Normal page

```
Processing page #1: 100 new items out of 100 fetched (0 previously processed)...
Page #1 processed.
Page #1 is stable. Advancing to page #2.
```

The processing log appears on the first fetch/new items, followed by the stable-page message.

**Live validation:** [run 36132738672](https://github.com/v-chiranjib-swain/labeler-test/actions/runs/36132738672)
on `test/pagination-1360-per-page-10` (`debug-only: true`, `per_page: 10`, 27 open items across 3 pages):

```
Processing page  #1 :  10 new items out of  10 fetched (0 previously processed)...
Page  #1  processed.
Page  #1  is stable. Advancing to page  #2.
Processing page  #2 :  10 new items out of  10 fetched (0 previously processed)...
Page  #2  processed.
Page  #2  is stable. Advancing to page  #3.
Processing page  #3 :  7 new items out of  7 fetched (0 previously processed)...
Page  #3  processed.
Page  #3  is stable. Advancing to page  #4.
```

### 3.2 Items already processed in a previous run

```
Processing page #1: 93 new items out of 100 fetched (7 previously processed)...
$$type skipped due being processed during the previous run
...
Page #1 processed.
Page #1 is stable. Advancing to page #2.
```

The previous-run skip messages are only emitted on the first fetch of the page.

**Live validation:** two sequential runs on `test/pagination-1360-per-page-10`, using the GitHub Actions
cache-backed state so "previous run" means a separate workflow dispatch. First,
[run 36134471777](https://github.com/v-chiranjib-swain/labeler-test/actions/runs/36134471777) with
`operations-per-run: 6` marked 2 PRs (#34, #35) stale before exhausting its budget. Then
[run 36134517863](https://github.com/v-chiranjib-swain/labeler-test/actions/runs/36134517863), a fresh
dispatch with a full budget, skipped exactly those two on its first fetch of page 1:

```
Processing page  #1 :  8 new items out of  10 fetched (2 previously processed)...
[#35]            pull request skipped due being processed during the previous run
[#34]            pull request skipped due being processed during the previous run
Page  #1  processed.
Page  #1  is stable. Advancing to page  #2.
```

### 3.3 Core #1360 scenario — items are closed

```
Processing page #3: 10 new items out of 10 fetched (0 previously processed)...
Page #3 processed.

4 items just closed on page #3. Re-checking this page immediately to confirm GitHub reflects it.
```

There is **no wait** on this first re-check — a same-pass closure isn't evidence GitHub is behind.

**Live validation:** [run 36132864977](https://github.com/v-chiranjib-swain/labeler-test/actions/runs/36132864977)
closed all 20 `pagination-1360` PRs with `days-before-pr-close: 0`. This is the flagship #1360
demonstration: every item kept shifting into page 1 across three same-page re-checks (10, then 8, then 2
more closed) instead of being skipped once the run moved past page 1 — exactly the bug this branch fixes:

```
Processing page  #1 :  10 new items out of  10 fetched (0 previously processed)...
Page  #1  processed.
10 items just closed on page  #1. Re-checking this page immediately to confirm GitHub reflects it.
Processing page  #1 :  8 new items out of  10 fetched (2 previously processed)...
Page  #1  processed.
8 items just closed on page  #1. Re-checking this page immediately to confirm GitHub reflects it.
Processing page  #1 :  9 new items out of  10 fetched (1 previously processed)...
Page  #1  processed.
2 items just closed on page  #1. Re-checking this page immediately to confirm GitHub reflects it.
```

### 3.4 GitHub still shows the closed items

```
4 previously closed items still visible on page #3. Waiting 500ms for GitHub to catch up with closures.
```

Then the next fetch consumes another operation. If the same closed items are still visible, the wait
backs off exponentially:

```
4 previously closed items still visible on page #3. Waiting 1000ms for GitHub to catch up with closures.

4 previously closed items still visible on page #3. Waiting 2000ms for GitHub to catch up with closures.

4 previously closed items still visible on page #3. Waiting 4000ms for GitHub to catch up with closures.

4 previously closed items still visible on page #3. Waiting 5000ms for GitHub to catch up with closures.
```

The delay is capped at 5000ms.

**Live validation (same run, continued):** the last 2 closures on page 1 needed the real backoff sequence
before GitHub reflected them — 500ms, 1000ms, 2000ms, 4000ms (never needed the 5000ms cap in this run):

```
3 previously closed items still visible on page  #1. Waiting 500ms for GitHub to catch up with closures.
1 previously closed item still visible on page  #1. Waiting 1000ms for GitHub to catch up with closures.
1 previously closed item still visible on page  #1. Waiting 2000ms for GitHub to catch up with closures.
1 previously closed item still visible on page  #1. Waiting 4000ms for GitHub to catch up with closures.
GitHub now reflects the closures on page  #1.
Page  #1  is stable. Advancing to page  #2.
No more issues found to process. Exiting...
```

### 3.5 GitHub finally reflects the closures

```
GitHub now reflects the closures on page #3.
Page #3 is stable. Advancing to page #4.
```

**Live validation:** confirmed by the same [run 36132864977](https://github.com/v-chiranjib-swain/labeler-test/actions/runs/36132864977) excerpt above (`GitHub now reflects the closures on page  #1.`).

### 3.6 Page shrinks after closures

On a visible pass where the fetched page is smaller than its first fetch:

```
Page #3 shrank as GitHub reflected the closures.
```

**Live validation:** [run 36133984673](https://github.com/v-chiranjib-swain/labeler-test/actions/runs/36133984673)
(closure + `sort-by: comments` combined, see 3.9) hit this on its final re-check of page 1, once the pool of
replacement items ran out:

```
Processing page  #1 :  1 new item out of  9 fetched (8 previously processed)...
Page  #1  shrank as GitHub reflected the closures.
Page  #1  processed.
GitHub now reflects the closures on page  #1.
Page  #1  is stable. Advancing to page  #2.
```

### 3.7 `sort-by: updated`

```
Processing page #3: 10 new items out of 10 fetched (0 previously processed)...
Page #3 processed.

Items were just processed on page #3, which can reorder results when sorting by "updated". Re-checking this page immediately to confirm GitHub reflects it.

Page #3 is stable. Advancing to page #4.
```

**Live validation:** [run 36133519456](https://github.com/v-chiranjib-swain/labeler-test/actions/runs/36133519456)
(`sort-by: comments`, no closures, `stale-pr-message: ''` so this exercises the heuristic in isolation from
any real comment-count change):

```
Processing page  #1 :  10 new items out of  10 fetched (0 previously processed)...
Page  #1  processed.
Items were just processed on page  #1, which can reorder results when sorting by "comments". Re-checking this page immediately to confirm GitHub reflects it.
Page  #1  is stable. Advancing to page  #2.
```

### 3.8 `sort-by: comments`

Same behavior:

```
Items were just processed on page #3, which can reorder results when sorting by "comments". Re-checking this page immediately to confirm GitHub reflects it.
```

Both are covered by the same production condition (`sortKeyIsMutable`). Live validation for this is the same
run as 3.7 above (`sort-by: comments`), which repeated identically across all 3 pages of that run.

### 3.9 Closure + reorder on the same pass

The closure message wins, since the closure branch is evaluated before the reorder branch:

```
4 items just closed on page #3. Re-checking this page immediately to confirm GitHub reflects it.
```

**Live validation:** [run 36133984673](https://github.com/v-chiranjib-swain/labeler-test/actions/runs/36133984673)
ran with `sort-by: comments` **and** `days-before-pr-close: 0` together. Across 8 same-page re-checks on
page 1, every single one logged the closure message — the reorder message never appeared, even though new
items were processed on every pass:

```
4 items just closed on page  #1. Re-checking this page immediately to confirm GitHub reflects it.
1 item just closed on page  #1. Re-checking this page immediately to confirm GitHub reflects it.
3 items just closed on page  #1. Re-checking this page immediately to confirm GitHub reflects it.
2 items just closed on page  #1. Re-checking this page immediately to confirm GitHub reflects it.
```

### 3.10 Operations exhausted during retries

```
No more operations left! Exiting...
If you think that not enough issues were processed you could try to increase the quantity related to the operations-per-run option which is currently set to 3
```

A dedicated test verifies that retries consume operations:

```
requestedPages = [1, 1, 1]
waitCalls = [500, 1000]
```

**Live validation:** [run 36133684801](https://github.com/v-chiranjib-swain/labeler-test/actions/runs/36133684801)
with `operations-per-run: 6` and `days-before-pr-close: 0`. Real-world finding: the budget ran out **inside**
the `unprocessedIssues` loop, closing 2 PRs before the check fired — so the run exits immediately via
`No more operations left! Exiting...` without ever reaching the closure/backoff logging block, even though
closes did happen:

```
Processing page  #1 :  10 new items out of  10 fetched (0 previously processed)...
No more operations left! Exiting...
If you think that not enough issues were processed you could try to increase the quantity related to the  operations-per-run  option which is currently set to  6
```

### 3.11 No more issues

```
No more issues found to process. Exiting...
```

**Live validation:** appeared at the end of every run above (e.g. [run 36132864977](https://github.com/v-chiranjib-swain/labeler-test/actions/runs/36132864977) once page 2 had nothing left to fetch).

## 4. Test Coverage

Added/updated in [`__tests__/pagination.spec.ts`](../__tests__/pagination.spec.ts):

- `processes every initially open pull request when earlier pages close items`
- `inspects every item when only some items in an earlier page close`
- `retries stale pages until closures are reflected without processing items twice`
- `stops retrying a stale page when operationsPerRun is exhausted`
- `processes every pull request when regular issues share the paginated result`
- `processes items shifted into an earlier page by comment-based reordering`

Run locally:

```sh
node --experimental-vm-modules ./node_modules/jest/bin/jest.js pagination.spec.ts
```

## 5. Live Test Setup (for re-running any scenario)

All scenarios in section 3 were validated on `v-chiranjib-swain/labeler-test`, using
[`.github/workflows/test-pagination-1360-perpage10.yml`](https://github.com/v-chiranjib-swain/labeler-test/blob/main/.github/workflows/test-pagination-1360-perpage10.yml),
which points at the `test/pagination-1360-per-page-10` branch and exposes `operations-per-run`,
`days-before-pr-stale`, `days-before-pr-close`, `sort-by`, `ascending`, and `debug-only` as `workflow_dispatch`
inputs. The 20 fixture PRs (#16–#35) are labeled `pagination-1360` and are safe to stale/close/reopen
repeatedly for testing — after each run, reset with:

```sh
gh pr reopen <n> -R v-chiranjib-swain/labeler-test
gh pr edit <n> -R v-chiranjib-swain/labeler-test --add-label pagination-1360 --remove-label "U:Stale"
```

Trigger a scenario with, e.g.:

```sh
gh workflow run test-pagination-1360-perpage10.yml -R v-chiranjib-swain/labeler-test \
  -f operations-per-run=1000 -f days-before-pr-stale=0 -f days-before-pr-close=0 \
  -f sort-by=created -f ascending=false -f debug-only=false
```
