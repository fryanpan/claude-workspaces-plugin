import { describe, expect, it } from 'bun:test';
import type { Thread } from '@claude-workspaces/core';
import {
  PRIOR_ASK_MAX,
  PRIOR_ASK_WINDOW_MS,
  type PriorAskSource,
  formatAskedAt,
  priorAsksFor,
} from '../src/review-items/prior-asks.ts';
import type { Task } from '../src/tasks.ts';

/** All fixtures are synthetic — invented names, ids and questions throughout. */

const NOW = Date.UTC(2026, 8, 6, 20, 0, 0);
const HOUR = 3_600_000;

function taskWith(reviews: unknown[]): Task {
  return { id: 't-1', reviews } as unknown as Task;
}

function threadWith(comments: Array<{ id: string; ts: number; review?: unknown }>): Thread {
  return { id: 'th-1', status: 'open', comments } as unknown as Thread;
}

function source(over: Partial<PriorAskSource>): PriorAskSource {
  return { getTask: () => undefined, listThreads: () => [], ...over };
}

describe('the two filing channels see each other', () => {
  // The measured failure: the same question reached the reader through the
  // ticket channel, was answered, and reached him again two hours later
  // through the thread channel, which the ticket store cannot read.
  const TICKET_ITEM = {
    id: 'r-first',
    createdAt: NOW - 5 * HOUR,
    review: { headline: 'Eleven documents have no address — archive or rehome?' },
    answer: { text: 'Archive them', by: 'Reader', ts: NOW - 4 * HOUR },
  };

  it('hands an item filed on a THREAD the question already answered on the TICKET', () => {
    const asks = priorAsksFor(
      { kind: 'task', taskId: 't-1', exceptCommentId: 'c-new' },
      source({ getTask: () => taskWith([TICKET_ITEM]) }),
      NOW,
    );
    expect(asks).toHaveLength(1);
    expect(asks[0]?.headline).toBe('Eleven documents have no address — archive or rehome?');
    expect(asks[0]?.answer).toBe('Archive them');
  });

  it('hands an item filed on the TICKET a question asked on one of its threads', () => {
    const asks = priorAsksFor(
      { kind: 'task', taskId: 't-1', exceptItemId: 'r-new' },
      source({
        listThreads: (docId) =>
          docId === 'task:t-1'
            ? [
                threadWith([
                  {
                    id: 'c-1',
                    ts: NOW - 3 * HOUR,
                    review: { shape: 'decision', headline: 'Same question, other words' },
                  },
                ]),
              ]
            : [],
      }),
      NOW,
    );
    expect(asks.map((a) => a.headline)).toEqual(['Same question, other words']);
  });

  it("reads a ticket thread under the ticket's own doc id, not some other doc", () => {
    const seen: string[] = [];
    priorAsksFor(
      { kind: 'task', taskId: 't-1' },
      source({
        listThreads: (docId) => {
          seen.push(docId);
          return [];
        },
      }),
      NOW,
    );
    expect(seen).toEqual(['task:t-1']);
  });

  it('leaves the item being judged out of its own history', () => {
    const asks = priorAsksFor(
      { kind: 'task', taskId: 't-1', exceptItemId: 'r-first' },
      source({ getTask: () => taskWith([TICKET_ITEM]) }),
      NOW,
    );
    expect(asks).toEqual([]);
  });

  it('leaves the comment being judged out of its own history', () => {
    const asks = priorAsksFor(
      { kind: 'doc', docId: 'd-1', exceptCommentId: 'c-1' },
      source({
        listThreads: () => [
          threadWith([{ id: 'c-1', ts: NOW - HOUR, review: { headline: 'This very item' } }]),
        ],
      }),
      NOW,
    );
    expect(asks).toEqual([]);
  });

  it('says nothing about a row with no history, which leaves the judge as it was', () => {
    expect(priorAsksFor({ kind: 'task', taskId: 't-gone' }, source({}), NOW)).toEqual([]);
  });

  it('ignores a comment that carries no review payload', () => {
    const asks = priorAsksFor(
      { kind: 'doc', docId: 'd-1' },
      source({ listThreads: () => [threadWith([{ id: 'c-1', ts: NOW - HOUR }])] }),
      NOW,
    );
    expect(asks).toEqual([]);
  });
});

describe('which history is worth the prompt tokens', () => {
  it('drops a question older than the window', () => {
    const old = {
      id: 'r-old',
      createdAt: NOW - PRIOR_ASK_WINDOW_MS - HOUR,
      review: { headline: 'Settled last quarter' },
      answer: { text: 'Yes', by: 'Reader', ts: NOW },
    };
    const fresh = {
      id: 'r-new',
      createdAt: NOW - PRIOR_ASK_WINDOW_MS + HOUR,
      review: { headline: 'Settled just inside the window' },
    };
    const asks = priorAsksFor(
      { kind: 'task', taskId: 't-1' },
      source({ getTask: () => taskWith([old, fresh]) }),
      NOW,
    );
    expect(asks.map((a) => a.headline)).toEqual(['Settled just inside the window']);
  });

  it('caps the list, and keeps the ANSWERED ones when it has to cut', () => {
    const open = Array.from({ length: PRIOR_ASK_MAX }, (_, i) => ({
      id: `r-open-${i}`,
      // Newest of all, so a cut that ignored answers would keep only these.
      createdAt: NOW - 60_000 * (i + 1),
      review: { headline: `open ${i}` },
    }));
    const answered = {
      id: 'r-answered',
      createdAt: NOW - 4 * HOUR,
      review: { headline: 'the one that makes a repeat a repeat' },
      answer: { text: 'Archive them', by: 'Reader', ts: NOW - 3 * HOUR },
    };
    const asks = priorAsksFor(
      { kind: 'task', taskId: 't-1' },
      source({ getTask: () => taskWith([...open, answered]) }),
      NOW,
    );
    expect(asks).toHaveLength(PRIOR_ASK_MAX);
    expect(asks[0]?.headline).toBe('the one that makes a repeat a repeat');
  });

  it('orders what it keeps newest first', () => {
    const asks = priorAsksFor(
      { kind: 'task', taskId: 't-1' },
      source({
        getTask: () =>
          taskWith([
            { id: 'r-a', createdAt: NOW - 5 * HOUR, review: { headline: 'older' } },
            { id: 'r-b', createdAt: NOW - HOUR, review: { headline: 'newer' } },
          ]),
      }),
      NOW,
    );
    expect(asks.map((a) => a.headline)).toEqual(['newer', 'older']);
  });

  it('marks an unanswered question as carrying no answer', () => {
    const asks = priorAsksFor(
      { kind: 'task', taskId: 't-1' },
      source({
        getTask: () =>
          taskWith([{ id: 'r-a', createdAt: NOW - HOUR, review: { headline: 'still open' } }]),
      }),
      NOW,
    );
    expect(asks[0]?.answer).toBeUndefined();
  });
});

describe('the date is written the way the reader would say it', () => {
  it('gives day and month inside the current year', () => {
    expect(formatAskedAt(Date.UTC(2026, 8, 6, 12), NOW)).toBe('6 September');
  });

  it('adds the year once it is a different one', () => {
    expect(formatAskedAt(Date.UTC(2025, 11, 31, 12), NOW)).toContain('2025');
  });
});
