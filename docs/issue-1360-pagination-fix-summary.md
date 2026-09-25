# Issue #1360 — Pagination Skip Bug: Fix Summary

This branch (`fix/pagination-1360`) fixes [actions/stale#1360](https://github.com/actions/stale/issues/1360):
closing or otherwise mutating issues/PRs mid-run can shift pagination, causing later pages to skip items
that were never actually inspected.

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

### 3.2 Items already processed in a previous run

```
Processing page #1: 93 new items out of 100 fetched (7 previously processed)...
$$type skipped due being processed during the previous run
...
Page #1 processed.
Page #1 is stable. Advancing to page #2.
```

The previous-run skip messages are only emitted on the first fetch of the page.

### 3.3 Core #1360 scenario — items are closed

```
Processing page #3: 10 new items out of 10 fetched (0 previously processed)...
Page #3 processed.

4 items just closed on page #3. Re-checking this page immediately to confirm GitHub reflects it.
```

There is **no wait** on this first re-check — a same-pass closure isn't evidence GitHub is behind.

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

### 3.5 GitHub finally reflects the closures

```
GitHub now reflects the closures on page #3.
Page #3 is stable. Advancing to page #4.
```

### 3.6 Page shrinks after closures

On a visible pass where the fetched page is smaller than its first fetch:

```
Page #3 shrank as GitHub reflected the closures.
```

### 3.7 `sort-by: updated`

```
Processing page #3: 10 new items out of 10 fetched (0 previously processed)...
Page #3 processed.

Items were just processed on page #3, which can reorder results when sorting by "updated". Re-checking this page immediately to confirm GitHub reflects it.

Page #3 is stable. Advancing to page #4.
```

### 3.8 `sort-by: comments`

Same behavior:

```
Items were just processed on page #3, which can reorder results when sorting by "comments". Re-checking this page immediately to confirm GitHub reflects it.
```

Both are covered by the same production condition (`sortKeyIsMutable`).

### 3.9 Closure + reorder on the same pass

The closure message wins, since the closure branch is evaluated before the reorder branch:

```
4 items just closed on page #3. Re-checking this page immediately to confirm GitHub reflects it.
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

### 3.11 No more issues

```
No more issues found to process. Exiting...
```

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

## 5. What to Test Manually

- A run with `operations-per-run` low enough to close several items across pages — confirm no issue/PR is
  skipped and the "still visible / waiting" and "now reflects" log lines appear as expected.
- A run with `sort-by: comments` or `sort-by: updated` where several items get marked stale on the same
  page — confirm items don't get processed twice and none are skipped.
- A run with a small `per_page`/many stale items to force multiple pages, to watch the backoff and page
  advancement logs end-to-end.
