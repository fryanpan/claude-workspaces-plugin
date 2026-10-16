/**
 * The plan lead's feed of new asks: asks from several boards arrive as one
 * addressed frame when the window closes, carrying board, row, key, headline
 * and createdAt and nothing else. A board the coach may not hear from never
 * reaches it, and neither does an ask the lead already hears or filed.
 *
 * Fixtures are invented; the repo is public.
 */
import { describe, expect, it } from 'bun:test';
import type { Thread } from '@claude-workspaces/core';
import {
  ASK_WINDOW_MS,
  AskFeed,
  type AskFrame,
  MAX_HEADLINE,
  type OfferedAsk,
  askFromReviewItemAdded,
  asksFromThreadEvent,
} from '../src/ask-feed.ts';
import { boardPrivacyFrom, placeIsOff } from '../src/coach/exclusion.ts';

/** A clock and a timer the test moves by hand. */
function fakeTime(start = 1_000_000) {
  let now = start;
  const timers: { due: number; fn: () => void; live: boolean }[] = [];
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      const t = { due: now + ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = timers.filter((t) => t.live && t.due <= end).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        now = next.due;
        next.live = false;
        next.fn();
      }
      now = end;
    },
  };
}

const PLAN = 'w-saltmarsh';
const LEAD = 'agent-team-lead';

function feed(opts: { locked?: Set<string>; connected?: boolean } = {}) {
  const time = fakeTime();
  const sent: [string, string, AskFrame][] = [];
  const locked = opts.locked ?? new Set<string>();
  const privacy = boardPrivacyFrom({
    isLocalOnlySet: () => false,
    setOfDoc: () => undefined,
    repoKeyOf: () => undefined,
    projectIsLocalOnly: () => false,
    docIdsOf: () => [],
    isBoardLocked: (id) => locked.has(id),
    boardsOfDoc: () => [],
  });
  const f = new AskFeed({
    lead: () => ({ workspaceId: PLAN, agentId: LEAD }),
    isOff: (place) => placeIsOff(place, privacy, new Set()),
    send: (ws, agent, frame) => {
      sent.push([ws, agent, frame]);
      return 1;
    },
    connected: () => opts.connected ?? true,
    now: time.now,
    schedule: time.schedule,
  });
  return { f, sent, time, locked };
}

const ticketAsk = (workspaceId: string, taskId: string, headline: string, ts: number) =>
  askFromReviewItemAdded(
    {
      workspaceId,
      taskId,
      reviewItemId: `r-${taskId}`,
      headline,
      actor: { id: 'agent-harbor' },
      ts,
    },
    workspaceId === 'w-harbor' ? 'Harborlight' : 'Riverbend',
  );

describe('AskFeed', () => {
  it('sends asks from two boards to the plan lead as one batched frame', () => {
    const { f, sent, time } = feed();
    expect(f.offer(ticketAsk('w-harbor', 't-1', 'Which tide table?', 1_000_100))).toBe(true);
    time.advance(60_000);
    expect(f.offer(ticketAsk('w-river', 't-2', 'Ship the ferry times?', 1_060_000))).toBe(true);
    expect(sent).toHaveLength(0);

    time.advance(ASK_WINDOW_MS);
    expect(sent).toHaveLength(1);
    const [ws, agent, frame] = sent[0] ?? [];
    expect(ws).toBe(PLAN);
    expect(agent).toBe(LEAD);
    expect(frame).toEqual({
      event: 'workspace.new_asks',
      workspaceId: PLAN,
      at: 1_000_000 + ASK_WINDOW_MS,
      from: 1_000_000,
      to: 1_000_000 + ASK_WINDOW_MS,
      items: [
        {
          workspaceId: 'w-harbor',
          board: 'Harborlight',
          row: { kind: 'task-review', taskId: 't-1', reviewItemId: 'r-t-1' },
          key: 'w-harbor:task-review:t-1:r-t-1',
          headline: 'Which tide table?',
          createdAt: 1_000_100,
        },
        {
          workspaceId: 'w-river',
          board: 'Riverbend',
          row: { kind: 'task-review', taskId: 't-2', reviewItemId: 'r-t-2' },
          key: 'w-river:task-review:t-2:r-t-2',
          headline: 'Ship the ferry times?',
          createdAt: 1_060_000,
        },
      ],
    });

    // A quiet window sends nothing.
    time.advance(ASK_WINDOW_MS * 3);
    expect(sent).toHaveLength(1);
  });

  it('never sends an ask on a locked board', () => {
    const { f, sent, time } = feed({ locked: new Set(['w-river']) });
    expect(f.offer(ticketAsk('w-river', 't-2', 'Private ferry question', 1_000_100))).toBe(false);
    expect(f.offer(ticketAsk('w-harbor', 't-1', 'Which tide table?', 1_000_300))).toBe(true);
    time.advance(ASK_WINDOW_MS);
    const frame = sent[0]?.[2];
    expect(frame?.items.map((i) => i.workspaceId)).toEqual(['w-harbor']);
    expect(JSON.stringify(sent)).not.toContain('Private ferry question');
  });

  it('drops an ask whose board was locked while its window was open', () => {
    const { f, sent, time, locked } = feed();
    f.offer(ticketAsk('w-river', 't-2', 'Ferry question', 1_000_100));
    f.offer(ticketAsk('w-harbor', 't-1', 'Tide question', 1_000_200));
    locked.add('w-river');
    time.advance(ASK_WINDOW_MS);
    expect(sent[0]?.[2].items.map((i) => i.workspaceId)).toEqual(['w-harbor']);
  });

  it('does not echo the plan board’s own asks, nor an ask the lead filed', () => {
    const { f, sent, time } = feed();
    expect(f.offer(ticketAsk(PLAN, 't-plan', 'Plan board ask', 1_000_100))).toBe(false);
    const mine: OfferedAsk = {
      ...ticketAsk('w-harbor', 't-4', 'Lead filed this', 1),
      actorId: LEAD,
    };
    expect(f.offer(mine)).toBe(false);
    time.advance(ASK_WINDOW_MS);
    expect(sent).toHaveLength(0);
  });

  it('holds nothing while the lead holds no stream', () => {
    const { f, sent, time } = feed({ connected: false });
    expect(f.offer(ticketAsk('w-harbor', 't-1', 'Tide question', 1))).toBe(false);
    time.advance(ASK_WINDOW_MS);
    expect(sent).toHaveLength(0);
  });

  it('clips a long headline', () => {
    const { f, sent, time } = feed();
    f.offer(ticketAsk('w-harbor', 't-1', 'x'.repeat(MAX_HEADLINE * 2), 1));
    time.advance(ASK_WINDOW_MS);
    expect(sent[0]?.[2].items[0]?.headline.length).toBe(MAX_HEADLINE);
  });
});

describe('asksFromThreadEvent', () => {
  const thread = (review: boolean): Thread =>
    ({
      id: 'th-1',
      status: 'open',
      comments: [
        {
          id: 'c-1',
          author: { id: 'agent-river', name: 'Riverbend Agent' },
          text: 'The long detail the lead must never see.',
          ts: 42,
          ...(review ? { review: { shape: 'review', headline: 'Does this read right?' } } : {}),
        },
      ],
    }) as unknown as Thread;

  it('files one ask per board for a declared review item, without the detail', () => {
    const asks = asksFromThreadEvent(
      {
        event: 'thread.created',
        docId: 'd-ferry',
        threadId: 'th-1',
        thread: thread(true),
        comment: thread(true).comments[0],
      },
      [
        { workspaceId: 'w-river', board: 'Riverbend', kind: 'doc-thread' },
        { workspaceId: 'w-harbor', kind: 'doc-thread' },
      ],
    );
    expect(asks.map((a) => a.key)).toEqual([
      'w-river:doc-thread:d-ferry:th-1',
      'w-harbor:doc-thread:d-ferry:th-1',
    ]);
    expect(asks[0]).toMatchObject({
      headline: 'Does this read right?',
      createdAt: 42,
      actorId: 'agent-river',
      row: { kind: 'doc-thread', docId: 'd-ferry', threadId: 'th-1' },
    });
    expect(JSON.stringify(asks)).not.toContain('long detail');
  });

  it('files nothing for an ordinary comment or a resolve', () => {
    const plain = thread(false);
    const homes = [{ workspaceId: 'w-river', kind: 'doc-thread' as const }];
    const base = { docId: 'd', threadId: 'th-1', thread: plain, comment: plain.comments[0] };
    expect(asksFromThreadEvent({ ...base, event: 'thread.created' }, homes)).toEqual([]);
    expect(
      asksFromThreadEvent({ ...base, thread: thread(true), event: 'thread.resolved' }, homes),
    ).toEqual([]);
  });
});
