# Issue #1360 — Pagination Skip Bug: Investigation, Fix, and Validation

**Issue:** [actions/stale#1360](https://github.com/actions/stale/issues/1360)
**Branch:** `test/issue-1360-pagination` (fork: `chiranjib-swain/stale`)
**Final commit:** `10f6df38bfe1ae062d6cb4de35e189bb69bd1276`
**Test repository:** `chiranjib-swain/labeler-test`

---

## 1. The Bug

`IssuesProcessor.processIssues()` always advanced to `page + 1` after processing a page,
regardless of whether closures had shrunk the underlying paginated list.

GitHub's `state: open` list is a live view. Closing items on one page removes them from
that view, which shifts later items forward into earlier positions. If the action blindly
requests `page + 1`, it skips whatever shifted into the range it already consumed.

### Real-world example

25 open PRs, page size 10:

```
Page 1: PR #35 ... PR #26   (closes 16 of them across the run)
Page 2: requested next, but the list has shrunk — items that should
        still be on page 2 have shifted backward into page 1's range
Result: those shifted items are never fetched again
```

### Original reproduction (unfixed `main` + reduced page size for testing)

Run: https://github.com/chiranjib-swain/labeler-test/actions/runs/32324478607

```
25 initially eligible PRs
Closed: 16
Skipped (never inspected): 9
Operations budget: 1000 (only 51 used)
Action reported: "No more issues found to process. Exiting..."
```

The action declared completion while 9 eligible PRs were still open and never inspected —
despite having 949 operations left in budget. This is the bug.

---

## 2. Root Cause

```ts
// original code
return this.processIssues(page + 1);
```

There was no check for whether the current page had changed as a result of processing.
The recursive call always advanced, unconditionally.

---

## 3. The Fix

File: `src/classes/issues-processor.ts`

### 3.1 Same-page retry

After processing a page, check whether any item **closed during this run** is still
visible in that page's fetched result. If so, re-fetch the **same page number** instead
of advancing — because GitHub's list hasn't yet reflected all the closures, and items
may still be shifting into view.

```ts
return this.processIssues(pageContainsClosedIssue ? page : page + 1);
```

### 3.2 Deduplication via state

Items already processed (this run, from a previous retry of the same page, or from a
previous run's persisted cache) are tracked via `state.isIssueProcessed()` and skipped,
so nothing is double-processed across retries.

### 3.3 Exponential backoff

Same-page retries wait between attempts instead of polling immediately:

```
retry 1: 500ms
retry 2: 1000ms
retry 3: 2000ms
retry 4: 4000ms
retry 5+: 5000ms (capped)
```

This reduces API call frequency while GitHub's backend catches up (eventual consistency).

### 3.4 Cross-run skip visibility

If items were already marked processed in a **previous run** (restored from the
persisted state cache), this is logged once per page, on that page's first fetch this run:

```
[#35]            pull request skipped due being processed during the previous run
```

Same-run retries (waiting on GitHub) do **not** repeat this per item — only the
aggregate counts change.

### 3.5 Fetch-shrink clarification

When a page's fetched item count drops below its own first-fetch count within the same
run (because GitHub has now reflected more closures), a dedicated line explains why:

```
Page #3 shrank as GitHub reflected the closures.
```

Without this, a smaller count on a later retry could look like a bug rather than expected
eventual-consistency behavior.

### 3.6 Simplified, gapless logs

Earlier iterations displayed a raw retry-attempt number (`pass #1`, `pass #2`, `pass #4` —
with gaps when a silent retry was suppressed). This looked broken. The final design
removes the pass number entirely — repeated announcements are already self-explanatory
from their position in the log and their `(N previously processed)` counts.

---

## 4. Final Log Format

```
Processing page  #3 :  10 new items out of  10 fetched (0 previously processed)...
[#14] Closing pull request for being stale
[#13] Closing pull request for being stale
[#12] Closing pull request for being stale
[#11] Closing pull request for being stale
Page  #3  processed.
4 previously closed items still visible on page  #3. Waiting 500ms for GitHub to catch up with closures.

Processing page  #3 :  2 new items out of  9 fetched (7 previously processed)...
Page  #3  shrank as GitHub reflected the closures.
Page  #3  processed.
1 previously closed item still visible on page  #3. Waiting 1000ms for GitHub to catch up with closures.

Page  #3  is stable. Advancing to page  #4.
```

### Comparison with `main`

| | `main` (unfixed) | Fixed branch |
|---|---|---|
| Line 1 | `Processing the batch of issues #1 containing 10 issues...` | `Processing page #1 : 10 new items out of 10 fetched (0 previously processed)...` |
| Line 2 | `Batch #1 processed.` | `Page #1 processed.` |
| Line 3 | *(none — advances unconditionally)* | `Page #1 is stable. Advancing to page #2.` |
| Line 4 | `Processing the batch of issues #2 containing 10 issues...` | `Processing page #2 : ...` |

**Explanation for reviewers:**

1. **Terminology** — "batch" → "page" is just clearer naming (it's a paginated API request).
   No functional change.
2. **New breakdown** ("X new items out of Y fetched (Z previously processed)") — main never
   exposed whether a fetch contained duplicates or already-handled items. This number is
   what makes the bug (and the fix) auditable.
3. **New line** ("Page #N is stable. Advancing to page #N+1.") — this is the fix, made
   visible. Main advanced **silently and unconditionally**; that's the root cause of #1360.
   This line only appears once the safety check (no closed items still visible) passes.

When nothing is being closed, the two versions are **functionally identical** — same
items, same completion, same cache behavior. That is intentional: it proves the fix
introduces no regression when there's nothing to fix. The extra logging becomes critical
specifically in the scenario the bug occurs in (active closures), where `main` would
advance blindly and skip items while the fixed version proves it's safe first.

---

## 5. Local Validation

```
Test Suites: 30 passed, 30 total
Tests:       1364 passed, 1364 total
```

Dedicated pagination regressions added in `__tests__/pagination.spec.ts`:
- Full-page closures — later pages still fully processed
- Partial-page closures — page correctly refreshes before advancing
- Repeated stale pages (simulated GitHub eventual consistency) — no double-processing
- Mixed issues/PRs sharing the same paginated result

Format/lint/build all pass on every commit.

---

## 6. Live Validation (`chiranjib-swain/labeler-test`)

Fixture: 25 real PRs (+ 7 unrelated regular issues also returned by GitHub's combined
`issues.listForRepo` endpoint), `per_page` temporarily reduced to 10 to make pagination
observable with a small fixture.

### 6.1 Baseline reproduction (unfixed `main` + `per_page: 10` only, commit `da02705`)

| Scenario | Run |
|---|---|
| Original bug reproduction (25 PRs, 16 closed, 9 skipped) | https://github.com/chiranjib-swain/labeler-test/actions/runs/32324478607 |
| Caching run 1 (ops=2) | https://github.com/chiranjib-swain/labeler-test/actions/runs/32988399715 |
| Caching run 2 (ops=3) | https://github.com/chiranjib-swain/labeler-test/actions/runs/32988524874 |
| Caching run 3 (ops=4) | https://github.com/chiranjib-swain/labeler-test/actions/runs/32988687698 |
| Caching run 4 (ops=5, completion) | https://github.com/chiranjib-swain/labeler-test/actions/runs/32990122451 |

### 6.2 Fixed branch — partial closure on page 1 (original #1360 scenario)

4 closable PRs (`#32–#35`) + 21 exempt PRs. Result: exactly 4 closed, 21 untouched.

- First validation: https://github.com/chiranjib-swain/labeler-test/actions/runs/33134637509
- Retest on final commit `10f6df3`: https://github.com/chiranjib-swain/labeler-test/actions/runs/33380823284

### 6.3 Fixed branch — partial closure on page 3

Proves the retry mechanism is not page-1-specific. 4 closable PRs (`#11–#14`, landing on
page 3) + 21 exempt. Pages 1–2 traverse with zero retries (nothing closes there); page 3
exhibits the retry/backoff pattern. Also demonstrated the total-item-count shrinking
below a page boundary, causing page 4 to come back empty naturally.

- Initial run: https://github.com/chiranjib-swain/labeler-test/actions/runs/33366466738
- Rerun with corrected fixture (all 4 PRs' stale label refreshed after reopen): https://github.com/chiranjib-swain/labeler-test/actions/runs/33370831384
- Rerun on shrink-clarification commit: https://github.com/chiranjib-swain/labeler-test/actions/runs/33370074776 → https://github.com/chiranjib-swain/labeler-test/actions/runs/33370831384
- Retest on final commit `10f6df3` (simplified log format): https://github.com/chiranjib-swain/labeler-test/actions/runs/33376103180

### 6.4 Fixed branch — operations-per-run + caching (4-run sequence)

Same 25 PRs, no staling (`days-before-pr-stale: -1`), page size 10, operations-per-run
tuned per run to land exactly on page boundaries:

| Run | ops-per-run | Result |
|---|---|---|
| 1 | 2 | Page 1 (10) processed, cached, blocked page 2 |
| 2 | 3 | Skip 10, page 2 (10) processed, cache→20, blocked page 3 |
| 3 | 4 | Skip 20, page 3 (10: 4 PRs+6 issues) processed, cache→30, blocked page 4 |
| 4 | 5 | Skip 30, page 4 (2) processed, page 5 empty → completed, cache reset |

- First pass (log-order fix): https://github.com/chiranjib-swain/labeler-test/actions/runs/32994156207 · https://github.com/chiranjib-swain/labeler-test/actions/runs/32994359597 · https://github.com/chiranjib-swain/labeler-test/actions/runs/32994582089 · https://github.com/chiranjib-swain/labeler-test/actions/runs/32994861599
- Final retest on commit `10f6df3`: https://github.com/chiranjib-swain/labeler-test/actions/runs/33383586955 · https://github.com/chiranjib-swain/labeler-test/actions/runs/33383681613 · https://github.com/chiranjib-swain/labeler-test/actions/runs/33383770213 · https://github.com/chiranjib-swain/labeler-test/actions/runs/33383873772

### 6.5 Low `operations-per-run` cutting a run off mid-page, then resuming

A remaining open question after 6.4: those cache tests never had closures happening
*while* the run got cut off — they landed cleanly on page boundaries. This test
deliberately picks an `operations-per-run` value that stops the run **mid-page**, partway
through closing items, then dispatches a follow-up run to confirm nothing gets skipped
and nothing is double-processed. Run against both `main` and the fixed branch for
comparison, using the same fixture (4 closable PRs on page 3 + 21 exempt).

| | Baseline (`da02705`) | Fixed (`10f6df3`) |
|---|---|---|
| Run 1 (ops=11) | Closed `#14,#13,#12`, stopped before `#11`, cache=23 | Identical |
| Run 2 (ops=1000) | Page 3 refetched with 9 items (GitHub already caught up), closed `#11`, completed | Page 3 refetched with 9 items, detected 1 previously-closed item still visible, waited 500ms, confirmed stable, closed `#11`, completed |
| Final result | `Closed: 11,12,13,14` — no skips | Identical — no skips |

- Baseline run 1: https://github.com/v-chiranjib-swain/labeler-test/actions/runs/33501481729
- Baseline run 2 (resume): https://github.com/v-chiranjib-swain/labeler-test/actions/runs/33501851492
- Fixed run 1: https://github.com/v-chiranjib-swain/labeler-test/actions/runs/33502616076
- Fixed run 2 (resume): https://github.com/v-chiranjib-swain/labeler-test/actions/runs/33502857561

**Finding:** `main` avoids the pagination bug in this specific combo only because it
always restarts at page 1 on every fresh run — it never carries any notion of "which
page was I on" across runs, so the same-run advancement flaw simply doesn't apply here.
The fixed branch behaves identically for the steady-state outcome, but additionally
proved it can detect and wait out a *previous* run's closures still lingering in a
freshly fetched page (the `1 previously closed item still visible` line on run 2) —
strictly more defensive than `main`, not less.

### 6.6 Low `operations-per-run` cutting a run off mid-*retry* pass, then resuming

6.5 cut a run off during a page's **first** pass. This test targets a narrower case:
the cutoff happens during a **retry** pass, after items have already shifted into view
that weren't visible on the first fetch of that page. The fixture adds a 5th closable
PR (`#3`), positioned beyond page 3's original boundary so it only becomes reachable
once earlier closures shrink the page — i.e. it can only be discovered on a retry, not
the initial pass. `operations-per-run=16` is tuned so pass 1 fully closes `#11`-`#14`
(15 ops) and the run is cut off while processing `#3` during pass 2's retry.

**Baseline (`main`, commit `da02705`) — run 1 only, ops=16:**

```text
Processing the batch of issues #3 containing 10 issues...
[#14] Closing pull request for being stale
[#13] Closing pull request for being stale
[#12] Closing pull request for being stale
[#11] Closing pull request for being stale
Batch #3 processed.
Processing the batch of issues #4 containing 0 issues...
No more issues found to process. Exiting...
Closed PRs: 4
Operations performed: 16
```

`main` closes `#11`-`#14`, then immediately advances to page 4 (blind `page + 1`).
Because GitHub's read-after-write consistency happened to be fast enough that page 4
came back empty, `main` treated this as "no more pages" and exited — **`#3` was never
fetched, never seen, and silently skipped.** No error, no warning, no wasted
operations (`16` used out of `16` budget, so nothing even looked like it ran out). This
is arguably the cleanest, most concerning reproduction of the bug found in this whole
investigation: it doesn't require operations exhaustion at all, just page-shrinkage
timing racing against the blind page-advance.

- Baseline run (bug reproduced, `#3` skipped): https://github.com/v-chiranjib-swain/labeler-test/actions/runs/33505567164

**Fixed branch (`10f6df3`) — run 1 (ops=16), then run 2 (resume, ops=1000):**

```text
Processing page  #3 :  10 new items out of  10 fetched (0 previously processed)...
[#14] Closing pull request for being stale
[#13] Closing pull request for being stale
[#12] Closing pull request for being stale
[#11] Closing pull request for being stale
Page  #3  processed.
4 previously closed items still visible on page  #3. Waiting 500ms for GitHub to catch up with closures.

Processing page  #3 :  2 new items out of  8 fetched (6 previously processed)...
Page  #3  shrank as GitHub reflected the closures.
[#3] Closing pull request for being stale
::warning::You have exceeded the number of operations per run, exiting...
Operations performed: 16
```

The retry pass (pass 2) fetches the now-shrunk page 3, discovers `#3` for the first
time (it was beyond the original page-3 boundary), starts closing it — and the
operations budget runs out mid-close. The run stops. Cache persists 30 processed IDs
so the next run knows exactly what's already been handled.

- Fixed run 1 (cutoff mid-retry, `#3` in flight): https://github.com/v-chiranjib-swain/labeler-test/actions/runs/33507976772

Resume run (ops=1000) picks up from the persisted cache, re-fetches pages 1-2 (all
previously processed, skip-logged), reaches page 3 with `2 new items out of 8 fetched
(6 previously processed)`, skips the 6 already-handled issues, and closes `#3`:

```text
Processing page  #3 :  2 new items out of  8 fetched (6 previously processed)...
[#3] Closing pull request for being stale
Page  #3  processed.
1 previously closed item still visible on page  #3. Waiting 500ms for GitHub to catch up with closures.
Page  #3  is stable. Advancing to page  #4.
No more issues found to process. Exiting...
Closed PRs: 1
Operations performed: 11
state: persisting info about 0 issue(s)
```

- Fixed run 2 (resume, completes correctly): https://github.com/v-chiranjib-swain/labeler-test/actions/runs/33508583047

**Final state after resume:** `Closed: 3,11,12,13,14` (all 5 intended closable PRs),
`Open: 20` (all exempt PRs untouched), cache reset to empty on natural completion.

| | Baseline (`main`) | Fixed branch |
|---|---|---|
| `#3` reachable only via retry | Never discovered — skipped silently | Discovered on retry pass 2 |
| Cutoff mid-retry | N/A (bug already manifested before any cutoff) | Handled — state persisted, resume closes `#3`, no skips |
| Operations wasted on bug | 0 (didn't even need to run out) | N/A — no bug to begin with |

**Finding:** This is the strongest evidence yet for the fix. `main`'s failure mode here
requires *no* operations exhaustion whatsoever — just ordinary eventual-consistency
timing on GitHub's side combined with the blind `page + 1` advance. The fixed branch's
same-page retry logic is what allows `#3` to be discovered at all, and its
cache/state persistence is what allows a mid-retry cutoff to resume correctly instead
of re-skipping or double-processing anything.

---

## 7. Notable Findings During Testing

- **Reopening a PR bumps its `updated_at`.** If a PR's stale label was applied *before*
  a reopen, the action correctly treats it as "updated since marked stale" and removes
  the stale label instead of closing it. This is correct `stale` action behavior, not a
  pagination bug — but it means test fixtures must refresh the stale label *after*
  reopening a PR, not before.
- **GitHub eventual consistency causes real run-to-run variance** in exactly how many
  items a retry fetch returns (e.g., one run showed `8 fetched` where another showed
  `9 fetched` for an equivalent retry) — this reflects backend replication lag at the
  moment of the API call, not a bug in the fix. The shrink-detection logic only checks
  "fewer than this page's own baseline," which is robust to this variance.
- **`operations-per-run` interacts with the retry mechanism**: every page fetch
  (including same-page consistency retries) consumes 1 operation. With staling disabled,
  each item itself costs 0 operations, so `operations-per-run` acts purely as "how many
  page-fetches are allowed" in that scenario — useful for designing deterministic
  multi-run cache tests.
- **The GitHub account/fork owner was renamed** partway through testing
  (`chiranjib-swain` → `v-chiranjib-swain`). Git remotes and every workflow `uses:`
  reference had to be updated to the new owner; GitHub's redirect kept old links working
  temporarily, but new commits/pushes should always target the canonical name.

---

## 8. PR Review: Operations-Budget Boundary (Copilot)

GitHub's automated PR reviewer flagged a concern on
[PR #25](https://github.com/v-chiranjib-swain/stale/pull/25): `processIssues()` could
retry a page indefinitely if it keeps showing an already-closed item with nothing new
to process, since `operations-per-run` might never be consulted in that path.

**Investigation:** traced into `getIssues()` and found it unconditionally consumes 1
operation on *every* fetch, including same-page retries:

```ts
async getIssues(page: number): Promise<Issue[]> {
  try {
    this.operations.consumeOperation();   // charged on every call, retry or not
    const issueResult = await this.client.rest.issues.listForRepo({...});
```

Since every recursive call to `processIssues()` starts with `await this.getIssues(page)`,
the existing post-loop `hasRemainingOperations()` check (which runs unconditionally,
regardless of how many items were actually processed) will always eventually catch a
stuck page and exit via the existing `No more operations left! Exiting...` path.
**Conclusion: no code change was needed** — the retry loop was already bounded.

**Verified two ways:**

1. **Regression test** (`__tests__/pagination.spec.ts`) simulating a page that never
   stops showing an already-closed item, with `operationsPerRun: 3`. The existing,
   unmodified code exits cleanly after exactly 3 fetches.
2. **Live test** against `v-chiranjib-swain/labeler-test`, using a temporary,
   throwaway-branch-only hack (`experiment/boundary-test-1360`, never merged) that
   forced page 1 to *never* stabilize — a worse case than could occur naturally. With
   `operations-per-run: 40`, the action retried silently with growing backoff
   (`500ms → 1000ms → 2000ms → ... → capped 5000ms`) for ~165 seconds, then exited
   cleanly via the same warning once the budget was exhausted. State persisted
   correctly (32 issues cached) for the next run to resume.
   - Run: https://github.com/v-chiranjib-swain/labeler-test/actions/runs/34092735309

**Side-finding:** the live test's `Fetched items: 1020` statistic looked surprising at
first, but is fully explained: each retry against the stuck page makes a *real* GitHub
API call (since `getIssues()` always performs the actual fetch), and ~34 retries ×
~30 items per fetch ≈ 1020. This confirms a stuck page costs one real API call per
retry — harmless under normal operation (real eventual-consistency delays resolve in
seconds), but worth being aware of as a minor rate-limit consideration in extreme
cases. Not significant enough to warrant a README change; captured here instead.

---

## 9. Conclusion

- No eligible PR was skipped in any live test, across three different closure
  positions (page 1, page 3, and a full-list closure scenario).
- Operations-per-run and state-caching semantics are unchanged from `main` when no
  closures occur (verified across a full 4-run cache lifecycle, twice) **and when
  closures happen while a run is cut off mid-page by a low operations budget**
  (verified against both `main` and the fixed branch — see §6.5).
- Logs are accurate, non-noisy, and self-explanatory for every scenario tested: stable
  pages, same-page retries, shrinking pages, and cross-run resumption.
- A PR review concern about an unbounded retry loop was investigated, confirmed to be
  a non-issue (the existing `operations-per-run` accounting already bounds it), and
  backed by both a new regression test and a live worst-case validation (see §8).
- All 30 local test suites (1364 tests) pass; format, lint, and build are clean at the
  final commit.

**Status: fix complete, validated locally and live. Ready for PR submission against
upstream `actions/stale`.**
