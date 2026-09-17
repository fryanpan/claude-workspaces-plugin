/**
 * A person asked something on a doc and NO AGENT EVER REPLIED.
 *
 * The board already notices the other direction — an agent asked Bryan
 * something and he has not answered — through `review-queue.ts`'s two bands.
 * This direction was invisible, and the first half of this file is the
 * positive control that says so: the same thread, with the two authors
 * swapped, produces a queue row one way round and nothing the other.
 *
 * The predicate is STRUCTURAL on purpose. `ask-detection.ts` reads the words,
 * and measured over this board's 86 agent comments it misses two questions in
 * every three; "a person spoke and no agent has spoken since" needs no
 * reading, and the one it is built for — a comment with no question mark in
 * it at all — is exactly the one the text pass drops.
 *
 * Fixtures are synthetic and the names are the house fixtures; the repo is
 * public.
 */
import { describe, expect, it } from 'bun:test';
import type { Comment, Thread, User } from '@claude-workspaces/core';
import { reviewThreadItems } from '../src/review-queue.ts';
import { type StallNudgeFrame, StallNudger, type StallSnapshot } from '../src/stall-nudge.ts';
import {
  UNANSWERED_THREAD_DEFAULT_MS,
  type UnansweredThreadRow,
  overdueUnansweredThreads,
  personAwaitingReply,
} from '../src/unanswered-thread.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const now = 1_760_000_000_000;

/**
 * An author exactly as one is STORED, which is not always a `User`.
 *
 * The casts through `unknown` are the honest spelling, not a shortcut: the
 * type says `User` and the corpus does not, and the two malformed rows below
 * exist precisely to drive shapes the type forbids. Narrowing the fixture to
 * what compiles would delete the cases the test is for.
 */
function comment(
  over: Omit<Partial<Comment>, 'author'> & { author: unknown; ts: number },
): Comment {
  return {
    id: `c-${over.ts}`,
    text: 'Are the hinges on the Harborlight door left or right handed?',
    ...over,
    author: over.author as User,
  } as Comment;
}

function thread(over: Partial<Thread> & { comments: Comment[] }): Thread {
  const last = over.comments[over.comments.length - 1];
  return {
    id: 'th-door',
    status: 'open',
    anchor: { blockId: 'b1' } as unknown as Thread['anchor'],
    commentCount: over.comments.length,
    lastActivity: last?.ts ?? now,
    createdBy: over.comments[0]?.author as unknown as User,
    ...over,
  } as Thread;
}

const BRYAN = { id: 'known-bryan', name: 'Bryan', kind: 'known' } as unknown as User;
const AGENT = {
  id: 'agent-riverbend',
  name: 'Riverbend Assistant',
  kind: 'agent',
} as unknown as User;

/** The whole finding in one thread: Bryan asked, nobody answered, 17 days. */
function personLastThread(): Thread {
  return thread({
    comments: [
      comment({ id: 'c-ask', author: BRYAN, ts: now - 17 * 24 * HOUR }),
      comment({ id: 'c-nudge', author: BRYAN, ts: now - 16 * 24 * HOUR, text: 'Still open?' }),
    ],
  });
}

const DOC = { docId: 'doc-harborlight', title: 'Harborlight door hardware' };

function queueRows(t: Thread) {
  return reviewThreadItems({
    tasks: [],
    docs: [{ docId: DOC.docId, title: DOC.title }],
    source: { threadsOf: () => [t], allThreadsOf: () => [t] },
  });
}

describe('the gap: a person-last thread reaches no existing surface', () => {
  it('CONTROL — swap the authors and the Home queue does produce a row', () => {
    const agentAsked = thread({
      comments: [
        comment({ id: 'c-ask', author: BRYAN, ts: now - 18 * 24 * HOUR }),
        comment({
          id: 'c-reply',
          author: AGENT,
          ts: now - 17 * 24 * HOUR,
          // Addressed BY NAME, because that is what `asksPerson` requires —
          // three conditions, all necessary. The narrowness is the point: it
          // is why the structural predicate below exists rather than a second
          // text pass.
          text: 'Bryan: should I draft round 2 of the Harborlight hardware now?',
        }),
      ],
    });
    const rows = queueRows(agentAsked);
    expect(rows.map((r) => r.band)).toEqual(['unreplied']);
  });

  it('…but the person-last thread emits nothing in either band', () => {
    expect(queueRows(personLastThread())).toEqual([]);
  });

  it('and this is the predicate that does catch it', () => {
    const ask = personAwaitingReply(personLastThread());
    expect(ask?.commentId).toBe('c-ask');
    expect(ask?.askedBy).toBe('Bryan');
    // The wait began with the FIRST comment of the trailing person run, not
    // the last: that is when the answer became owed.
    expect(ask?.askedAt).toBe(now - 17 * 24 * HOUR);
    // …and the newest carries its own stamp, so a fresh comment on an old
    // conversation is news rather than a repeat the lead never hears.
    expect(ask?.latestAt).toBe(now - 16 * 24 * HOUR);
  });
});

describe('what is NOT a person waiting', () => {
  it('an agent spoke last — that is the direction the review queue already has', () => {
    const t = thread({
      comments: [
        comment({ id: 'c-ask', author: BRYAN, ts: now - 3 * 24 * HOUR }),
        comment({ id: 'c-reply', author: AGENT, ts: now - 2 * 24 * HOUR }),
      ],
    });
    expect(personAwaitingReply(t)).toBeUndefined();
  });

  it('a resolved thread is a conversation somebody ended', () => {
    expect(
      personAwaitingReply(thread({ ...personLastThread(), status: 'resolved' })),
    ).toBeUndefined();
  });

  it('an empty thread asks nobody anything', () => {
    expect(personAwaitingReply(thread({ comments: [] }))).toBeUndefined();
  });

  it('comments out of clock order still resolve to the real last speaker', () => {
    // A CRDT array is in insertion order, which is not time order. Reading
    // `comments[length - 1]` would call this thread person-last and wake the
    // lead over an answer the agent had already given.
    const t = thread({
      comments: [
        comment({ id: 'c-reply', author: AGENT, ts: now - 2 * 24 * HOUR }),
        comment({ id: 'c-ask', author: BRYAN, ts: now - 3 * 24 * HOUR }),
      ],
    });
    expect(personAwaitingReply(t)).toBeUndefined();
  });
});

describe('author shapes — classify by what an AGENT is, never by what a person looks like', () => {
  // Measured on one huddle doc, 2026-09-16: people appear under three
  // different id shapes on a single document. A predicate that tested for
  // `user-` read 0 of 28 threads as person-last when the answer was 3.
  const people: Array<[string, unknown]> = [
    ['a signed-in browser id', { id: 'user-1h6o7qo0ih5ggd', name: 'Bryan', kind: 'known' }],
    ['an anonymous visitor', { id: 'anon-e5sfr4', name: 'Saltmarsh guest', kind: 'anon' }],
    ['the owner under his stable id', { id: 'known-bryan', name: 'Bryan', kind: 'known' }],
  ];
  for (const [label, author] of people) {
    it(`${label} is a person waiting`, () => {
      const t = thread({ comments: [comment({ id: 'c-ask', author, ts: now - 3 * 24 * HOUR })] });
      expect(personAwaitingReply(t)?.commentId).toBe('c-ask');
    });
  }

  it('an agent id is not', () => {
    const t = thread({
      comments: [comment({ id: 'c-ask', author: AGENT, ts: now - 3 * 24 * HOUR })],
    });
    expect(personAwaitingReply(t)).toBeUndefined();
  });

  // The two malformed shapes, pinned as KNOWN MISSES rather than left to be
  // discovered. About 1.4% of stored comments (26 of 1,825) carry one, and
  // `classifyActor` reads both as an agent by design — an agent filed as a
  // person launders the audit log, so the tie breaks that way. The cost here
  // is a thread we stay quiet about; the alternative is waking the lead over
  // an agent's own comment, which is worse. If `classifyActor` ever changes
  // its mind these two cases fail, which is the point of writing them down.
  it('an author with no `kind` field reads as an agent, so we say nothing', () => {
    const t = thread({
      comments: [
        comment({
          id: 'c-ask',
          author: { id: 'known-bryan', name: 'Bryan' },
          ts: now - 3 * 24 * HOUR,
        }),
      ],
    });
    expect(personAwaitingReply(t)).toBeUndefined();
  });

  it('an author stored as a bare string reads as an agent, so we say nothing', () => {
    const t = thread({
      comments: [comment({ id: 'c-ask', author: 'Bryan', ts: now - 3 * 24 * HOUR })],
    });
    expect(personAwaitingReply(t)).toBeUndefined();
  });
});

describe('the window, and the rows the lead is handed', () => {
  const ask = () => {
    const found = personAwaitingReply(personLastThread());
    if (!found) throw new Error('fixture no longer produces an ask');
    return { ...found, id: DOC.docId, docId: DOC.docId, title: DOC.title, threadId: 'th-door' };
  };

  it('a day is the floor: a question asked an hour ago is somebody still typing', () => {
    const fresh = { ...ask(), askedAt: now - HOUR, latestAt: now - HOUR };
    expect(overdueUnansweredThreads([fresh], now)).toEqual([]);
  });

  it('past the window it becomes a row, with the age the lead can act on', () => {
    const rows = overdueUnansweredThreads([ask()], now);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.askedMs).toBe(17 * 24 * HOUR);
    expect(rows[0]?.docId).toBe(DOC.docId);
    // Paste-ready, so the lead's remedy is not a lookup.
    expect(rows[0]?.reply).toContain('post_reply(');
    expect(rows[0]?.reply).toContain('th-door');
  });

  it('oldest first — the one most at risk of never being answered leads', () => {
    const older = { ...ask(), threadId: 'th-old', askedAt: now - 30 * 24 * HOUR };
    const newer = { ...ask(), threadId: 'th-new', askedAt: now - 2 * 24 * HOUR };
    expect(overdueUnansweredThreads([newer, older], now).map((r) => r.threadId)).toEqual([
      'th-old',
      'th-new',
    ]);
  });

  it('the default window is a day', () => {
    expect(UNANSWERED_THREAD_DEFAULT_MS).toBe(24 * HOUR);
  });
});

describe('the lead is woken — and Bryan is not reached at all', () => {
  function harness(boards: () => StallSnapshot[]) {
    const sent: Array<{ agentId: string; frame: StallNudgeFrame }> = [];
    let clock = now;
    const nudger = new StallNudger({
      now: () => clock,
      snapshot: boards,
      canReach: () => true,
      attachedAgents: () => ['agent-lead'],
      send: (_workspaceId, agentId, frame) => {
        sent.push({ agentId, frame });
        return 1;
      },
      sendToFiler: () => 1,
      report: () => {},
    });
    return { sent, nudger, advance: (ms: number) => (clock += ms) };
  }

  function board(unanswered: readonly UnansweredThreadRow[]): StallSnapshot {
    return {
      workspaceId: 'w-harbour',
      leadAgentId: 'agent-lead',
      retired: false,
      stalled: [],
      unfiled: [],
      considered: 4,
      undetermined: [],
      ...(unanswered.length > 0 ? { unanswered } : {}),
    };
  }

  const waiting = (latestAt: number): UnansweredThreadRow[] =>
    overdueUnansweredThreads(
      [
        {
          id: DOC.docId,
          docId: DOC.docId,
          title: DOC.title,
          threadId: 'th-door',
          commentId: 'c-ask',
          askedBy: 'Bryan',
          askedAt: now - 17 * 24 * HOUR,
          latestAt,
          excerpt: 'Are the hinges left or right handed?',
        },
      ],
      now,
    );

  it('a board whose ONLY finding is a waiting question still wakes its lead', () => {
    // Nothing is stalled, nothing unfiled, nothing held — a board that read
    // completely clean before this row existed.
    const { sent, nudger } = harness(() => [board(waiting(now - 16 * 24 * HOUR))]);
    nudger.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.agentId).toBe('agent-lead');
    expect(sent[0]?.frame.unanswered?.map((r) => r.threadId)).toEqual(['th-door']);
    // The lead, and the lead only. Bryan is the one WAITING; telling him his
    // own question is unanswered is the one message this must never send.
    expect(sent.every((s) => s.agentId === 'agent-lead')).toBe(true);
  });

  it('…and is not woken again while the conversation stands unchanged', () => {
    const { sent, nudger, advance } = harness(() => [board(waiting(now - 16 * 24 * HOUR))]);
    nudger.tick();
    advance(90 * MIN);
    nudger.tick();
    expect(sent).toHaveLength(1);
  });

  it('but a NEW comment from the person is news, not a repeat', () => {
    let latest = now - 16 * 24 * HOUR;
    const { sent, nudger, advance } = harness(() => [board(waiting(latest))]);
    nudger.tick();
    expect(sent).toHaveLength(1);
    // Bryan comes back and asks again. `askedAt` has not moved — the wait
    // still began seventeen days ago — so a stamp keyed on it alone would
    // swallow this, which is the exact silence the finding exists to end.
    latest = now - 10 * MIN;
    advance(10 * MIN);
    nudger.tick();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.frame.changed?.unanswered?.map((r) => r.threadId)).toEqual(['th-door']);
    // The age the lead is shown is still the true one.
    expect(sent[1]?.frame.unanswered?.[0]?.askedMs).toBe(17 * 24 * HOUR);
  });

  it('a retired board says nothing', () => {
    const { sent, nudger } = harness(() => [
      { ...board(waiting(now - 16 * 24 * HOUR)), retired: true },
    ]);
    nudger.tick();
    expect(sent).toHaveLength(0);
  });
});
