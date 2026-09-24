import {jest, describe, expect, it} from '@jest/globals';
import {Issue} from '../src/classes/issue.js';
import {IssuesProcessor} from '../src/classes/issues-processor.js';
import {IssueLogger} from '../src/classes/loggers/issue-logger.js';
import {IIssuesProcessorOptions} from '../src/interfaces/issues-processor-options.js';
import {IssuesProcessorMock} from './classes/issues-processor-mock.js';
import {alwaysFalseStateMock, StateMock} from './classes/state-mock.js';
import {DefaultProcessorOptions} from './constants/default-processor-options.js';
import {generateIssue} from './functions/generate-issue.js';

describe('pagination', (): void => {
  it('processes every initially open pull request when earlier pages close items', async (): Promise<void> => {
    const pageSize = 10;
    const options: IIssuesProcessorOptions = {
      ...DefaultProcessorOptions,
      closePrMessage: '',
      daysBeforePrClose: 0,
      operationsPerRun: 100
    };
    const initiallyOpenPullRequests: Issue[] = Array.from(
      {length: 25},
      (_, index): Issue =>
        generateIssue(
          options,
          index + 1,
          `Pull request #${index + 1}`,
          '2020-01-01T17:00:00Z',
          '2020-01-01T17:00:00Z',
          false,
          true,
          [options.stalePrLabel]
        )
    );

    const processorReference: {current?: IssuesProcessorMock} = {};
    const processor = new IssuesProcessorMock(
      options,
      alwaysFalseStateMock,
      async page => {
        const closedNumbers = new Set(
          processorReference.current?.closedIssues.map(issue => issue.number) ??
            []
        );
        const currentlyOpenPullRequests = initiallyOpenPullRequests.filter(
          issue => !closedNumbers.has(issue.number)
        );
        const pageStart = (page - 1) * pageSize;

        return currentlyOpenPullRequests.slice(pageStart, pageStart + pageSize);
      },
      async () => [],
      async () => '2020-01-01T17:00:00Z'
    );
    processorReference.current = processor;

    await processor.processIssues();

    expect(processor.closedIssues.map(issue => issue.number)).toEqual(
      initiallyOpenPullRequests.map(issue => issue.number)
    );
  });

  it('inspects every item when only some items in an earlier page close', async (): Promise<void> => {
    const pageSize = 10;
    const options: IIssuesProcessorOptions = {
      ...DefaultProcessorOptions,
      debugOnly: false,
      operationsPerRun: 100
    };
    const initiallyOpenPullRequests = Array.from(
      {length: 25},
      (_, index): Issue =>
        generateIssue(
          options,
          index + 1,
          `Pull request #${index + 1}`,
          '2020-01-01T17:00:00Z',
          '2020-01-01T17:00:00Z',
          false,
          true
        )
    );
    const inspectedNumbers: number[] = [];
    const requestedPages: number[] = [];
    const processedNumbers = new Set<number>();
    const state = new StateMock();
    state.addIssueToProcessed = issue => {
      processedNumbers.add(issue.number);
    };
    state.isIssueProcessed = issue => processedNumbers.has(issue.number);
    const processorReference: {current?: IssuesProcessorMock} = {};
    const processor = new IssuesProcessorMock(options, state, async page => {
      requestedPages.push(page);
      const closedNumbers = new Set(
        processorReference.current?.closedIssues.map(issue => issue.number) ??
          []
      );
      const currentlyOpenPullRequests = initiallyOpenPullRequests.filter(
        issue => !closedNumbers.has(issue.number)
      );
      const pageStart = (page - 1) * pageSize;

      return currentlyOpenPullRequests.slice(pageStart, pageStart + pageSize);
    });
    processorReference.current = processor;
    processor.processIssue = async issue => {
      inspectedNumbers.push(issue.number);
      if (issue.number <= 5) {
        processor.closedIssues.push(issue);
      }
    };

    await processor.processIssues();

    expect(inspectedNumbers).toEqual(
      initiallyOpenPullRequests.map(issue => issue.number)
    );
    expect(requestedPages).toEqual([1, 1, 2, 3]);
  });

  it('waits for repeated stale pages without processing items twice', async (): Promise<void> => {
    const options: IIssuesProcessorOptions = {
      ...DefaultProcessorOptions,
      debugOnly: false,
      operationsPerRun: 100
    };
    const pullRequests = Array.from({length: 14}, (_, index): Issue =>
      generateIssue(
        options,
        index + 1,
        `Pull request #${index + 1}`,
        '2020-01-01T17:00:00Z',
        '2020-01-01T17:00:00Z',
        false,
        true
      )
    );
    const requestedPages: number[] = [];
    const inspectedNumbers: number[] = [];
    const processedNumbers = new Set<number>();
    const state = new StateMock();
    state.addIssueToProcessed = issue => {
      processedNumbers.add(issue.number);
    };
    state.isIssueProcessed = issue => processedNumbers.has(issue.number);
    let pageOneRequests = 0;
    const processor = new IssuesProcessorMock(options, state, async page => {
      requestedPages.push(page);

      if (page !== 1) {
        return [];
      }

      pageOneRequests += 1;
      if (pageOneRequests === 1) {
        return pullRequests.slice(0, 10);
      }
      if (pageOneRequests <= 5) {
        return pullRequests.slice(2, 12);
      }

      return pullRequests.slice(4, 14);
    });
    processor.processIssue = async issue => {
      inspectedNumbers.push(issue.number);
      if (issue.number <= 4) {
        processor.closedIssues.push(issue);
      }
    };
    const waitCalls: number[] = [];
    processor.wait = async (milliseconds: number) => {
      waitCalls.push(milliseconds);
    };

    await processor.processIssues();

    expect(inspectedNumbers).toEqual(pullRequests.map(issue => issue.number));
    expect(requestedPages).toEqual([1, 1, 1, 1, 1, 1, 2]);
    // the first retry re-checks immediately (no wait, since those closes were
    // just made this pass); backoff only starts once a fresh fetch reconfirms
    // the same items persist, then increases on each further retry, capped at 5000ms
    expect(waitCalls).toEqual([500, 1000, 2000, 4000]);
  });

  it('does not wait in debugOnly mode even when a closure appears to persist', async (): Promise<void> => {
    const options: IIssuesProcessorOptions = {
      ...DefaultProcessorOptions,
      debugOnly: true,
      operationsPerRun: 100
    };
    const closableIssue = generateIssue(
      options,
      1,
      'Pull request #1',
      '2020-01-01T17:00:00Z',
      '2020-01-01T17:00:00Z',
      false,
      true
    );
    const staysOpenIssue = generateIssue(
      options,
      2,
      'Pull request #2',
      '2020-01-01T17:00:00Z',
      '2020-01-01T17:00:00Z',
      false,
      true
    );
    const processedNumbers = new Set<number>();
    const state = new StateMock();
    state.addIssueToProcessed = issue => {
      processedNumbers.add(issue.number);
    };
    state.isIssueProcessed = issue => processedNumbers.has(issue.number);
    const requestedPages: number[] = [];
    let pageOneRequests = 0;
    const processor = new IssuesProcessorMock(options, state, async page => {
      requestedPages.push(page);
      if (page !== 1) {
        return [];
      }
      pageOneRequests += 1;
      return pageOneRequests <= 2
        ? [closableIssue, staysOpenIssue]
        : [staysOpenIssue];
    });
    processor.processIssue = async issue => {
      if (issue.number === 1) {
        processor.closedIssues.push(issue);
      }
    };
    const waitCalls: number[] = [];
    processor.wait = async milliseconds => {
      waitCalls.push(milliseconds);
    };

    await processor.processIssues();

    // in debugOnly mode, the unchanged-page-signature fast-forward shortcut
    // advances past the page as soon as the raw fetch stops changing
    expect(requestedPages).toEqual([1, 1, 2]);
    expect(waitCalls).toEqual([]);
  });

  it('stops retrying a stale page when operationsPerRun is exhausted', async () => {
    const options: IIssuesProcessorOptions = {
      ...DefaultProcessorOptions,
      debugOnly: false,
      operationsPerRun: 3
    };

    // already processed/closed in a previous pass, but the fixture keeps
    // returning it forever to simulate GitHub never reflecting the closure
    const closedIssue = generateIssue(
      options,
      1,
      'Closed issue',
      '2020-01-01T17:00:00Z',
      '2020-01-01T17:00:00Z',
      false,
      true
    );
    const state = new StateMock();
    state.isIssueProcessed = issue => issue.number === 1;

    const requestedPages: number[] = [];
    const processor = new IssuesProcessorMock(options, state, async page => {
      requestedPages.push(page);
      // mirrors getIssues() consuming 1 operation per fetch in production, including retries
      processor.operations.consumeOperation();
      return page === 1 ? [closedIssue] : [];
    });

    // Simulate an item closed earlier in this run but still returned by GitHub.
    processor.closedIssues.push(closedIssue);

    const waitCalls: number[] = [];
    processor.wait = async milliseconds => {
      waitCalls.push(milliseconds);
    };

    const result = await processor.processIssues();

    expect(result).toBe(0);
    expect(requestedPages).toEqual([1, 1, 1]);
    expect(waitCalls).toEqual([500, 1000]);
  });

  it('processes every pull request when regular issues share the paginated result', async (): Promise<void> => {
    const pageSize = 10;
    const options: IIssuesProcessorOptions = {
      ...DefaultProcessorOptions,
      closePrMessage: '',
      daysBeforePrClose: 0,
      daysBeforeIssueStale: -1,
      daysBeforeIssueClose: -1,
      operationsPerRun: 100
    };
    const pullRequests = Array.from({length: 25}, (_, index): Issue =>
      generateIssue(
        options,
        index + 1,
        `Pull request #${index + 1}`,
        '2020-01-01T17:00:00Z',
        '2020-01-01T17:00:00Z',
        false,
        true,
        [options.stalePrLabel]
      )
    );
    const regularIssues = Array.from({length: 7}, (_, index): Issue =>
      generateIssue(
        options,
        100 + index,
        `Issue #${100 + index}`,
        '2020-01-01T17:00:00Z'
      )
    );
    const initiallyOpenItems = [
      ...pullRequests.slice(0, 18),
      ...regularIssues,
      ...pullRequests.slice(18)
    ];
    const processorReference: {current?: IssuesProcessorMock} = {};
    const processor = new IssuesProcessorMock(
      options,
      alwaysFalseStateMock,
      async page => {
        const closedNumbers = new Set(
          processorReference.current?.closedIssues.map(issue => issue.number) ??
            []
        );
        const currentlyOpenItems = initiallyOpenItems.filter(
          issue => !closedNumbers.has(issue.number)
        );
        const pageStart = (page - 1) * pageSize;

        return currentlyOpenItems.slice(pageStart, pageStart + pageSize);
      },
      async () => [],
      async () => '2020-01-01T17:00:00Z'
    );
    processorReference.current = processor;

    await processor.processIssues();

    expect(processor.closedIssues.map(issue => issue.number)).toEqual(
      pullRequests.map(issue => issue.number)
    );
  });

  it('processes items shifted into an earlier page by comment-based reordering', async (): Promise<void> => {
    const pageSize = 5;

    const options: IIssuesProcessorOptions = {
      ...DefaultProcessorOptions,
      sortBy: 'comments',
      ascending: true,
      debugOnly: false,
      operationsPerRun: 100
    };

    const allIssues: Issue[] = Array.from({length: 10}, (_, index): Issue =>
      generateIssue(
        options,
        index + 1,
        `Pull request #${index + 1}`,
        '2020-01-01T17:00:00Z',
        '2020-01-01T17:00:00Z',
        false,
        true
      )
    );

    // Initial ordering:
    // Page 1 -> #1(0) #2(0) #3(0) #4(1) #5(1)
    // Page 2 -> #6(1) #7(2) #8(3) #9(4) #10(5)
    const commentCounts = new Map<number, number>([
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 1],
      [5, 1],
      [6, 1],
      [7, 2],
      [8, 3],
      [9, 4],
      [10, 5]
    ]);

    const inspectedNumbers: number[] = [];
    const requestedPages: number[] = [];

    const state = new StateMock();
    const processedNumbers = new Set<number>();

    state.addIssueToProcessed = issue => {
      processedNumbers.add(issue.number);
    };

    state.isIssueProcessed = issue => processedNumbers.has(issue.number);

    const processor = new IssuesProcessorMock(options, state, async page => {
      requestedPages.push(page);

      const sorted = [...allIssues].sort((a, b) => {
        const diff =
          (commentCounts.get(a.number) ?? 0) -
          (commentCounts.get(b.number) ?? 0);

        return diff !== 0 ? diff : a.number - b.number;
      });

      const pageStart = (page - 1) * pageSize;

      return sorted.slice(pageStart, pageStart + pageSize);
    });

    processor.processIssue = async issue => {
      inspectedNumbers.push(issue.number);

      // Simulate marking #4 and #5 stale by adding a comment.
      if (issue.number === 4 || issue.number === 5) {
        commentCounts.set(
          issue.number,
          (commentCounts.get(issue.number) ?? 0) + 1
        );
      }
    };

    await processor.processIssues();

    // After processing Page 1:
    // Page 1 -> #1(0) #2(0) #3(0) #6(1) #7(2)
    //                         ↑       ↑
    //                     moved from Page 2

    expect(inspectedNumbers.slice().sort((a, b) => a - b)).toEqual(
      allIssues.map(issue => issue.number)
    );

    expect(requestedPages).toContain(1);
    expect(requestedPages).toContain(2);

    // No item was closed; the ordering changed only because comments changed.
    expect(processor.closedIssues).toHaveLength(0);
  });

  it('does not report an item shifted within this run as skipped from the previous run', async (): Promise<void> => {
    const pageSize = 5;

    const options: IIssuesProcessorOptions = {
      ...DefaultProcessorOptions,
      sortBy: 'comments',
      ascending: true,
      debugOnly: false,
      operationsPerRun: 100
    };

    const allIssues: Issue[] = Array.from({length: 10}, (_, index): Issue =>
      generateIssue(
        options,
        index + 1,
        `Pull request #${index + 1}`,
        '2020-01-01T17:00:00Z',
        '2020-01-01T17:00:00Z',
        false,
        true
      )
    );

    // #1 was genuinely processed/closed during a previous run.
    const processedNumbers = new Set<number>([1]);
    const state = new StateMock();
    state.addIssueToProcessed = issue => {
      processedNumbers.add(issue.number);
    };
    state.isIssueProcessed = issue => processedNumbers.has(issue.number);

    const commentCounts = new Map<number, number>(
      allIssues.map(issue => [issue.number, 0])
    );

    const processor = new IssuesProcessorMock(options, state, async page => {
      const sorted = [...allIssues].sort((a, b) => {
        const diff =
          (commentCounts.get(a.number) ?? 0) -
          (commentCounts.get(b.number) ?? 0);
        return diff !== 0 ? diff : a.number - b.number;
      });
      const pageStart = (page - 1) * pageSize;
      return sorted.slice(pageStart, pageStart + pageSize);
    });

    processor.processIssue = async issue => {
      // simulate every processed item getting a stale comment, which
      // reorders the ascending-by-comments list and shifts items forward
      commentCounts.set(
        issue.number,
        (commentCounts.get(issue.number) ?? 0) + 1
      );
    };

    const skippedNumbers: number[] = [];
    const infoSpy = jest
      .spyOn(IssueLogger.prototype, 'info')
      .mockImplementation(function (this: unknown, ...message: string[]) {
        if (
          message
            .join(' ')
            .includes('skipped due to being processed during the previous run')
        ) {
          skippedNumbers.push(
            (this as unknown as {_issue: Issue})._issue.number
          );
        }
      });

    await processor.processIssues();

    infoSpy.mockRestore();

    // #1 is genuinely restored from a previous run and must still be reported
    expect(skippedNumbers).toContain(1);

    // no item that was only processed earlier in this same run (and then
    // shifted pages via reordering) should be misreported as a previous-run skip
    expect(skippedNumbers.filter(number => number !== 1)).toHaveLength(0);
  });

  it('does not skip items when marking stale changes the updated-sorted list', async (): Promise<void> => {
    const pageSize = 5;
    const options: IIssuesProcessorOptions = {
      ...DefaultProcessorOptions,
      sortBy: 'updated',
      ascending: true,
      debugOnly: false,
      operationsPerRun: 100
    };

    const allIssues: Issue[] = Array.from({length: 10}, (_, index): Issue =>
      generateIssue(
        options,
        index + 1,
        `Pull request #${index + 1}`,
        '2020-01-01T17:00:00Z',
        '2020-01-01T17:00:00Z',
        false,
        true
      )
    );

    // Initial ordering (oldest updated first, ascending):
    // Page 1: #1, #2, #3, #4, #5
    // Page 2: #6, #7, #8, #9, #10
    //
    // Marking #1-#5 stale bumps their updated_at to "now" (real _markStale()
    // does exactly this), pushing them to the very end of the ascending
    // ordering. This simulates items from page 2 shifting into page 1.
    const updatedRank = new Map<number, number>(
      allIssues.map(issue => [issue.number, issue.number])
    );

    const inspectedNumbers: number[] = [];
    const requestedPages: number[] = [];
    const processedNumbers = new Set<number>();

    const state = new StateMock();
    state.addIssueToProcessed = issue => {
      processedNumbers.add(issue.number);
    };
    state.isIssueProcessed = issue => processedNumbers.has(issue.number);

    const processor = new IssuesProcessorMock(options, state, async page => {
      requestedPages.push(page);

      const sorted = [...allIssues].sort((a, b) => {
        const diff =
          (updatedRank.get(a.number) ?? 0) - (updatedRank.get(b.number) ?? 0);

        return diff !== 0 ? diff : a.number - b.number;
      });

      const pageStart = (page - 1) * pageSize;
      return sorted.slice(pageStart, pageStart + pageSize);
    });

    processor.processIssue = async issue => {
      inspectedNumbers.push(issue.number);

      // Simulate marking the item stale, bumping its updated_at to "now".
      // The issue remains open; nothing is added to closedIssues.
      if (issue.number <= 5) {
        updatedRank.set(issue.number, issue.number + 100);
      }
    };

    await processor.processIssues();

    // Every issue must be inspected despite the ordering changing
    // between page fetches.
    expect(inspectedNumbers.slice().sort((a, b) => a - b)).toEqual(
      allIssues.map(issue => issue.number)
    );

    // This scenario must not be caused by closure detection.
    expect(processor.closedIssues).toHaveLength(0);

    // Page 1 must be revisited if the ordering mutation is detected.
    expect(requestedPages.filter(page => page === 1).length).toBeGreaterThan(1);
  });

  it('re-checks a possibly-reordered page immediately, backing off only if reordering persists', async (): Promise<void> => {
    const options: IIssuesProcessorOptions = {
      ...DefaultProcessorOptions,
      sortBy: 'comments',
      debugOnly: false,
      operationsPerRun: 100
    };
    const issue1 = generateIssue(
      options,
      1,
      'Pull request #1',
      '2020-01-01T17:00:00Z',
      '2020-01-01T17:00:00Z',
      false,
      true
    );
    const issue2 = generateIssue(
      options,
      2,
      'Pull request #2',
      '2020-01-01T17:00:00Z',
      '2020-01-01T17:00:00Z',
      false,
      true
    );
    const processedNumbers = new Set<number>();
    const state = new StateMock();
    state.addIssueToProcessed = issue => {
      processedNumbers.add(issue.number);
    };
    state.isIssueProcessed = issue => processedNumbers.has(issue.number);
    const requestedPages: number[] = [];
    let pageOneRequests = 0;
    const processor = new IssuesProcessorMock(options, state, async page => {
      requestedPages.push(page);
      if (page !== 1) {
        return [];
      }
      pageOneRequests += 1;
      // #2 shifts into view on the 2nd fetch, simulating a second consecutive
      // reorder-worthy mutation; nothing new shifts in after that
      return pageOneRequests === 1 ? [issue1] : [issue1, issue2];
    });
    processor.processIssue = async () => {};
    const waitCalls: number[] = [];
    processor.wait = async milliseconds => {
      waitCalls.push(milliseconds);
    };

    await processor.processIssues();

    expect(requestedPages).toEqual([1, 1, 1, 2]);
    // no wait on the first reorder detection; backoff only once reordering
    // is flagged on two consecutive passes
    expect(waitCalls).toEqual([500]);
  });

  it('re-checks a fresh closure immediately with no wait even when the same pass may have reordered results', async (): Promise<void> => {
    const options: IIssuesProcessorOptions = {
      ...DefaultProcessorOptions,
      sortBy: 'comments',
      debugOnly: false,
      operationsPerRun: 100
    };
    const closableIssue = generateIssue(
      options,
      1,
      'Pull request #1',
      '2020-01-01T17:00:00Z',
      '2020-01-01T17:00:00Z',
      false,
      true
    );
    const staysOpenIssue = generateIssue(
      options,
      2,
      'Pull request #2',
      '2020-01-01T17:00:00Z',
      '2020-01-01T17:00:00Z',
      false,
      true
    );
    const processedNumbers = new Set<number>();
    const state = new StateMock();
    state.addIssueToProcessed = issue => {
      processedNumbers.add(issue.number);
    };
    state.isIssueProcessed = issue => processedNumbers.has(issue.number);
    const requestedPages: number[] = [];
    let pageOneRequests = 0;
    const processor = new IssuesProcessorMock(options, state, async page => {
      requestedPages.push(page);
      if (page !== 1) {
        return [];
      }
      pageOneRequests += 1;
      // GitHub reflects the closure only on the 3rd fetch of page 1
      return pageOneRequests <= 2
        ? [closableIssue, staysOpenIssue]
        : [staysOpenIssue];
    });
    processor.processIssue = async issue => {
      // closing #1 and processing #2 in the same pass makes this page both
      // "just closed" and "may have reordered" (sortBy: comments) at once
      if (issue.number === 1) {
        processor.closedIssues.push(issue);
      }
    };
    const waitCalls: number[] = [];
    processor.wait = async milliseconds => {
      waitCalls.push(milliseconds);
    };

    await processor.processIssues();

    expect(requestedPages).toEqual([1, 1, 1, 2]);
    // no wait on the fresh-closure pass despite the reorder flag also being
    // true; backoff only kicks in once the re-fetch still shows #1 present
    expect(waitCalls).toEqual([500]);
  });

  it('re-fetches an unstable page immediately before applying backoff', async (): Promise<void> => {
    const options: IIssuesProcessorOptions = {
      ...DefaultProcessorOptions,
      debugOnly: false,
      operationsPerRun: 100
    };

    const closableIssue = generateIssue(
      options,
      1,
      'Pull request #1',
      '2020-01-01T17:00:00Z',
      '2020-01-01T17:00:00Z',
      false,
      true
    );

    const processedNumbers = new Set<number>();
    const state = new StateMock();
    state.addIssueToProcessed = issue => {
      processedNumbers.add(issue.number);
    };
    state.isIssueProcessed = issue => processedNumbers.has(issue.number);

    const requestedPages: number[] = [];
    let fetchCount = 0;

    const processor = new IssuesProcessorMock(options, state, async page => {
      requestedPages.push(page);
      // mirrors getIssues() consuming 1 operation per fetch in production
      processor.operations.consumeOperation();
      fetchCount++;

      // Pass 1: item is fetched and closed during processing.
      // Pass 2: GitHub has not reflected the closure yet.
      // Pass 3: GitHub has reflected the closure.
      return fetchCount <= 2 ? [closableIssue] : [];
    });

    processor.processIssue = async issue => {
      processor.closedIssues.push(issue);
    };

    const waitCalls: number[] = [];
    processor.wait = async milliseconds => {
      waitCalls.push(milliseconds);
    };

    const result = await processor.processIssues();

    // pass 1 (close), pass 2 (re-fetch, still visible), pass 3 (confirmed gone)
    expect(requestedPages).toEqual([1, 1, 1]);

    // no wait on the immediate re-check right after closing; a single 500ms
    // wait once the fresh re-fetch still shows the closed item persisting
    expect(waitCalls).toEqual([500]);

    expect(result).toBe(options.operationsPerRun - 3);
  });

  it('does not skip items when a previously processed closure is still visible on the next run', async (): Promise<void> => {
    const pageSize = 5;

    const options: IIssuesProcessorOptions = {
      ...DefaultProcessorOptions,
      debugOnly: false,
      operationsPerRun: 100
    };

    const allIssues: Issue[] = Array.from({length: 10}, (_, index): Issue =>
      generateIssue(
        options,
        index + 1,
        `Pull request #${index + 1}`,
        '2020-01-01T17:00:00Z',
        '2020-01-01T17:00:00Z',
        false,
        true
      )
    );

    const processedNumbers = new Set<number>();
    const state = new StateMock();

    state.addIssueToProcessed = issue => {
      processedNumbers.add(issue.number);
    };

    state.isIssueProcessed = issue => processedNumbers.has(issue.number);

    // Simulate #1 being processed/closed during the previous run.
    processedNumbers.add(1);

    const requestedPages: number[] = [];
    let pageOneFetchCount = 0;

    const processor = new IssuesProcessorMock(options, state, async page => {
      requestedPages.push(page);

      if (page === 1) {
        pageOneFetchCount++;

        // First fetch of the new run: GitHub still returns the
        // previously closed #1.
        if (pageOneFetchCount === 1) {
          return allIssues.slice(0, 5);
        }

        // After GitHub catches up, #1 disappears and #6 shifts
        // into Page 1.
        return [
          allIssues[1],
          allIssues[2],
          allIssues[3],
          allIssues[4],
          allIssues[5]
        ];
      }

      if (page === 2) {
        return allIssues.slice(6, 10);
      }

      return [];
    });

    const inspectedNumbers: number[] = [];

    processor.processIssue = async issue => {
      inspectedNumbers.push(issue.number);
    };

    await processor.processIssues();

    // #1 was already processed in the previous run, but #6 shifted
    // into Page 1 after GitHub reflected the closure.
    expect(inspectedNumbers).toContain(6);

    // Page 1 must be re-fetched because a previously processed item
    // was still visible.
    expect(requestedPages.filter(page => page === 1).length).toBeGreaterThan(1);
  });

  it('does not skip items when a previously processed closure is still visible on a later page', async (): Promise<void> => {
    const pageSize = 5;
    const options: IIssuesProcessorOptions = {
      ...DefaultProcessorOptions,
      debugOnly: false,
      operationsPerRun: 100
    };

    const allIssues: Issue[] = Array.from({length: 15}, (_, index): Issue =>
      generateIssue(
        options,
        index + 1,
        `Pull request #${index + 1}`,
        '2020-01-01T17:00:00Z',
        '2020-01-01T17:00:00Z',
        false,
        true
      )
    );

    const processedNumbers = new Set<number>();

    const state = new StateMock();
    state.addIssueToProcessed = issue => {
      processedNumbers.add(issue.number);
    };
    state.isIssueProcessed = issue => processedNumbers.has(issue.number);

    // Simulate #6 being processed/closed during a previous run.
    processedNumbers.add(6);

    const requestedPages: number[] = [];
    let pageTwoFetchCount = 0;

    const processor = new IssuesProcessorMock(options, state, async page => {
      requestedPages.push(page);

      if (page === 1) {
        // Page 1 is stable and should not need a retry.
        return allIssues.slice(0, 5);
      }

      if (page === 2) {
        pageTwoFetchCount++;

        if (pageTwoFetchCount === 1) {
          // #6 is still visible from the previous run.
          return [
            allIssues[5], // #6 - previously processed
            allIssues[6], // #7
            allIssues[7], // #8
            allIssues[8], // #9
            allIssues[9] // #10
          ];
        }

        // Simulate GitHub reflecting the earlier closure.
        // #11 shifts into Page 2.
        return [
          allIssues[6], // #7
          allIssues[7], // #8
          allIssues[8], // #9
          allIssues[9], // #10
          allIssues[10] // #11 - shifted into Page 2
        ];
      }

      if (page === 3) {
        return allIssues.slice(11, 15); // #12-#15
      }

      return [];
    });

    const inspectedNumbers: number[] = [];

    processor.processIssue = async issue => {
      inspectedNumbers.push(issue.number);
    };

    await processor.processIssues();

    // #11 shifted into Page 2 after the previously processed #6 disappeared.
    expect(inspectedNumbers).toContain(11);

    // Page 2 must be re-fetched because a previously processed item
    // was still visible on the first fetch.
    expect(requestedPages.filter(page => page === 2).length).toBeGreaterThan(1);
  });

  it('does not skip items when a restored item disappears before the next page', async (): Promise<void> => {
    const pageSize = 5;

    const options: IIssuesProcessorOptions = {
      ...DefaultProcessorOptions,
      debugOnly: false,
      operationsPerRun: 100
    };

    const allIssues: Issue[] = Array.from({length: 10}, (_, index): Issue =>
      generateIssue(
        options,
        index + 1,
        `Pull request #${index + 1}`,
        '2020-01-01T17:00:00Z',
        '2020-01-01T17:00:00Z',
        false,
        true
      )
    );

    const processedNumbers = new Set<number>();

    const state = new StateMock();

    state.addIssueToProcessed = issue => {
      processedNumbers.add(issue.number);
    };

    state.isIssueProcessed = issue => processedNumbers.has(issue.number);

    // #1 was processed/closed during a previous run.
    processedNumbers.add(1);

    const requestedPages: number[] = [];
    let pageOneFetchCount = 0;

    const processor = new IssuesProcessorMock(options, state, async page => {
      requestedPages.push(page);

      if (page === 1) {
        pageOneFetchCount++;

        // Pass 1:
        // [1, 2, 3, 4, 5]
        if (pageOneFetchCount === 1) {
          return allIssues.slice(0, 5);
        }

        // Pass 2 (immediate re-check after closing #2 this pass):
        // [1, 3, 4, 5, 6]
        //
        // #2 has disappeared, but GitHub hasn't reflected #1's prior-run
        // closure yet, so #1 (restored) is still visible.
        if (pageOneFetchCount === 2) {
          return [
            allIssues[0], // #1 - previously processed, still visible
            allIssues[2], // #3
            allIssues[3], // #4
            allIssues[4], // #5
            allIssues[5] // #6
          ];
        }

        // Pass 3: GitHub finally reflects #1's closure too.
        // [3, 4, 5, 6, 7]
        return [
          allIssues[2], // #3
          allIssues[3], // #4
          allIssues[4], // #5
          allIssues[5], // #6
          allIssues[6] // #7 - shifted in now that #1 and #2 are both gone
        ];
      }

      if (page === 2) {
        // Simulate #1 disappearing before Page 2 is fetched.
        //
        // Current collection:
        // [3, 4, 5, 6, 7, 8, 9, 10]
        //
        // Page 2 starts at offset 5, so GitHub returns:
        // [8, 9, 10]
        //
        // #7 has shifted into Page 1 and would be skipped.
        return allIssues.slice(7, 10);
      }

      return [];
    });

    const inspectedNumbers: number[] = [];

    processor.processIssue = async issue => {
      inspectedNumbers.push(issue.number);

      // Simulate #2 being closed during the first pass.
      if (issue.number === 2) {
        processor.closedIssues.push(issue);
      }
    };

    await processor.processIssues();

    // #7 must not be skipped.
    expect(inspectedNumbers).toContain(7);

    // Page 1 should have been fetched more than once.
    expect(requestedPages.filter(page => page === 1).length).toBeGreaterThan(1);
  });

  it('stops retrying a restored item once the page stops changing, without waiting for operationsPerRun to run out', async (): Promise<void> => {
    const options: IIssuesProcessorOptions = {
      ...DefaultProcessorOptions,
      debugOnly: false,
      operationsPerRun: 12
    };

    const allIssues: Issue[] = Array.from({length: 8}, (_, index): Issue =>
      generateIssue(
        options,
        index + 1,
        `Pull request #${index + 1}`,
        '2020-01-01T17:00:00Z',
        '2020-01-01T17:00:00Z',
        false,
        true
      )
    );

    const processedNumbers = new Set<number>();
    const state = new StateMock();
    state.addIssueToProcessed = issue => {
      processedNumbers.add(issue.number);
    };
    state.isIssueProcessed = issue => processedNumbers.has(issue.number);

    // #1 was processed/closed during a previous run, but GitHub never
    // reflects that closure in this fixture - it stays visible forever,
    // as a normal previously-processed-but-still-open item would.
    processedNumbers.add(1);

    const requestedPages: number[] = [];
    let pageOneFetchCount = 0;

    const processor = new IssuesProcessorMock(options, state, async page => {
      requestedPages.push(page);
      // mirrors getIssues() consuming 1 operation per fetch in production
      processor.operations.consumeOperation();

      if (page === 1) {
        pageOneFetchCount++;

        // Pass 1: [1, 2, 3, 4, 5]
        if (pageOneFetchCount === 1) {
          return allIssues.slice(0, 5);
        }

        // Pass 2 onward: [1, 3, 4, 5, 6] forever - #1 (restored) never
        // disappears, simulating GitHub never reflecting the prior closure.
        return [
          allIssues[0], // #1 - restored, never disappears
          allIssues[2], // #3
          allIssues[3], // #4
          allIssues[4], // #5
          allIssues[5] // #6
        ];
      }

      if (page === 2) {
        return allIssues.slice(6, 8); // #7, #8
      }

      return [];
    });

    const processedCounts = new Map<number, number>();

    processor.processIssue = async issue => {
      processedCounts.set(
        issue.number,
        (processedCounts.get(issue.number) ?? 0) + 1
      );

      // Simulate #2 being closed during the first pass.
      if (issue.number === 2) {
        processor.closedIssues.push(issue);
      }
    };

    const waitCalls: number[] = [];
    processor.wait = async milliseconds => {
      waitCalls.push(milliseconds);
    };

    const result = await processor.processIssues();

    // page 1 is re-fetched while its contents are still changing (#2 closing,
    // then #6 shifting in), but once the fetch repeats identically - #1
    // (restored) is the only reason left - it stops retrying instead of
    // consuming the rest of the operations budget
    expect(requestedPages).toEqual([1, 1, 1, 2, 3]);
    expect(waitCalls).toEqual([500]);

    // operationsPerRun was never exhausted; the run finished normally
    expect(result).toBe(options.operationsPerRun - requestedPages.length);

    // every item is processed exactly once, including #7/#8 on page 2,
    // which would have been unreachable under the old operations-bound-only behavior
    expect([...processedCounts.keys()].sort((a, b) => a - b)).toEqual([
      2, 3, 4, 5, 6, 7, 8
    ]);
    for (const count of processedCounts.values()) {
      expect(count).toBe(1);
    }
  });

  it('retries a page when a close update fails ambiguously, without reporting it as a confirmed close', async (): Promise<void> => {
    const originalRepo = process.env.GITHUB_REPOSITORY;
    process.env.GITHUB_REPOSITORY = 'owner/repo';

    const options: IIssuesProcessorOptions = {
      ...DefaultProcessorOptions,
      debugOnly: false,
      closeIssueMessage: '',
      closePrMessage: '',
      operationsPerRun: 100
    };

    try {
      const allIssues: Issue[] = Array.from({length: 6}, (_, index): Issue =>
        generateIssue(
          options,
          index + 1,
          `Pull request #${index + 1}`,
          '2020-01-01T17:00:00Z',
          '2020-01-01T17:00:00Z',
          false,
          true
        )
      );

      const state = new StateMock();
      const processedNumbers = new Set<number>();
      state.addIssueToProcessed = issue => {
        processedNumbers.add(issue.number);
      };
      state.isIssueProcessed = issue => processedNumbers.has(issue.number);

      const requestedPages: number[] = [];
      let pageOneFetchCount = 0;

      const processor = new IssuesProcessorMock(options, state, async page => {
        requestedPages.push(page);
        if (page !== 1) {
          return [];
        }
        pageOneFetchCount++;
        // GitHub actually applied the close despite the ambiguous client-side
        // failure below: #2 is gone by the second fetch, and #6 has shifted
        // into page 1's range as a result.
        return pageOneFetchCount === 1
          ? allIssues.slice(0, 5) // [#1, #2, #3, #4, #5]
          : [
              allIssues[0], // #1
              allIssues[2], // #3
              allIssues[3], // #4
              allIssues[4], // #5
              allIssues[5] // #6 - becomes visible in page 1 after #2 disappears
            ];
      });

      // Simulate a network-level failure (no HTTP status at all) when closing
      // #2, so the client can't tell whether GitHub applied the close.
      (
        processor.client.rest.issues as unknown as {
          update: () => Promise<never>;
        }
      ).update = () => Promise.reject(new Error('socket hang up'));

      const processedCounts = new Map<number, number>();

      processor.processIssue = async issue => {
        processedCounts.set(
          issue.number,
          (processedCounts.get(issue.number) ?? 0) + 1
        );

        if (issue.number === 2) {
          await (
            processor as unknown as {
              _closeIssue: (issue: Issue) => Promise<void>;
            }
          )._closeIssue(issue);
        }
      };

      const waitCalls: number[] = [];
      processor.wait = async milliseconds => {
        waitCalls.push(milliseconds);
      };

      await processor.processIssues();

      // the ambiguous failure must not be reported as a confirmed close
      expect(processor.closedIssues).toHaveLength(0);

      // pagination still treats it as possibly-closed and re-checks the page
      // immediately; the second fetch confirms it's gone, so no wait is needed
      expect(requestedPages).toEqual([1, 1, 2]);
      expect(waitCalls).toEqual([]);

      // #6 becomes visible in page 1 once #2's ambiguous close is reflected;
      // it must be recovered and processed exactly once, not skipped
      expect(processedCounts.get(6)).toBe(1);

      // no item is double-processed across the retry
      expect([...processedCounts.keys()].sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6
      ]);
      for (const count of processedCounts.values()) {
        expect(count).toBe(1);
      }
    } finally {
      if (originalRepo === undefined) {
        delete process.env.GITHUB_REPOSITORY;
      } else {
        process.env.GITHUB_REPOSITORY = originalRepo;
      }
    }
  });
});

const isAmbiguousCloseFailure = (error: unknown): boolean =>
  (
    IssuesProcessor as unknown as {
      _isAmbiguousCloseFailure: (error: unknown) => boolean;
    }
  )._isAmbiguousCloseFailure(error);

describe('IssuesProcessor._isAmbiguousCloseFailure()', (): void => {
  it('treats a missing status (network-level failure) as ambiguous', (): void => {
    expect(isAmbiguousCloseFailure(new Error('socket hang up'))).toBe(true);
  });

  it.each([500, 502, 503])(
    'treats a %i status as ambiguous',
    (status): void => {
      expect(isAmbiguousCloseFailure({status})).toBe(true);
    }
  );

  it.each([400, 404, 422])(
    'treats a %i status as not ambiguous',
    (status): void => {
      expect(isAmbiguousCloseFailure({status})).toBe(false);
    }
  );
});
