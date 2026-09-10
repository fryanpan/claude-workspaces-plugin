import type { Comment, ReviewPayload, Thread, User } from '@claude-workspaces/core';
import { createThread } from '@claude-workspaces/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dockItems, dockRounds } from '../src/widget-dock.ts';
import type { FeedbackWidgetEl } from '../src/widget.ts';

/**
 * The review-item DOCK: an ask, on the page it is about, answerable there.
 *
 * Two halves. `dockItems` / `dockRounds` are pure over threads, so WHICH asks
 * a page docks and how many rounds one has are driven without a browser. The
 * rest renders the real element into happy-dom and drives it the way a reader
 * does — a tap on the bar, a tap on an option — and asserts what went over
 * the wire, because "answered" is a fact on the server, not on screen.
 *
 * All fixtures are synthetic — invented ids and a lemonade stand. The repo is
 * public.
 */

const T0 = 1_700_000_000_000;
let seq = 0;

const AGENT: User = {
  id: 'agent-cartographer',
  name: 'Cartographer',
  kind: 'known',
  color: '#888888',
};

function payload(over: Partial<ReviewPayload> = {}): ReviewPayload {
  return {
    shape: 'decision',
    headline: 'Which price does day one ship with?',
    detail: 'A dollar a cup is the most expensive stand on the street.',
    options: [
      { id: 'o-75', label: 'Ship at 75c' },
      { id: 'o-50', label: 'Keep 50c' },
    ],
    ...over,
  };
}

function comment(over: Partial<Comment> = {}): Comment {
  seq += 1;
  return { id: `c-${seq}`, author: AGENT, text: 'Priced day one.', ts: T0 + seq, ...over };
}

function thread(over: Partial<Thread> = {}): Thread {
  seq += 1;
  return {
    id: `th-${seq}`,
    status: 'open',
    anchor: { kind: 'subject' },
    commentCount: 1,
    lastActivity: T0,
    createdBy: AGENT,
    comments: [],
    ...over,
  };
}

describe('which asks a page docks', () => {
  it('docks a thread whose comment declares one', () => {
    const items = dockItems([thread({ comments: [comment({ review: payload() })] })]);
    expect(items).toHaveLength(1);
    expect(items[0]?.review.headline).toBe('Which price does day one ship with?');
    expect(items[0]?.answered).toBe(false);
  });

  it('docks nothing for an ordinary comment', () => {
    expect(dockItems([thread({ comments: [comment()] })])).toEqual([]);
  });

  it('drops a HELD item — its filer is being told nobody can see it', () => {
    const held = payload({ judge: { at: T0, verdict: 'held', reason: 'no stakes named' } });
    expect(dockItems([thread({ comments: [comment({ review: held })] })])).toEqual([]);
    // CONTROL: the same payload with a passing verdict does dock, so the
    // assertion above is about the HOLD and not about `judge` existing.
    const ok = payload({ judge: { at: T0, verdict: 'ok', reason: '' } });
    expect(dockItems([thread({ comments: [comment({ review: ok })] })])).toHaveLength(1);
  });

  it('drops a WITHDRAWN one, and a resolved thread retires its ask', () => {
    const gone = payload({ withdrawnAt: T0, withdrawnBy: 'Cartographer' });
    expect(dockItems([thread({ comments: [comment({ review: gone })] })])).toEqual([]);
    expect(
      dockItems([thread({ status: 'resolved', comments: [comment({ review: payload() })] })]),
    ).toEqual([]);
  });

  it('keeps an ANSWERED item docked, and ranks it below one still waiting', () => {
    const answered = payload({
      headline: 'Settled already',
      answeredAt: T0,
      answeredBy: 'Jordan',
      answerText: 'Ship at 75c.',
    });
    // The answered one is the NEWER declaration, so newest-first alone would
    // put it on top. Only the answered-last rule can produce this order —
    // without the newer timestamp the assertion passes on a dock that has no
    // such rule at all.
    const waiting = thread({ comments: [comment({ review: payload(), ts: T0 + 1 })] });
    const settled = thread({ comments: [comment({ review: answered, ts: T0 + 2 })] });
    const items = dockItems([settled, waiting]);
    expect(items.map((i) => i.answered)).toEqual([false, true]);
    expect(items[1]?.review.headline).toBe('Settled already');
  });
});

describe('the rounds of one ask', () => {
  it('reads a revision as an earlier round of the same item, oldest first', () => {
    const revised = payload({
      detail: 'Now fifty cents, and it sells out before noon.',
      revisions: [
        { at: T0, by: 'Cartographer', headline: 'Which price?', detail: 'A dollar a cup.' },
      ],
    });
    const rounds = dockRounds(revised);
    expect(rounds.map((r) => r.n)).toEqual([1, 2]);
    expect(rounds[0]?.detail).toBe('A dollar a cup.');
    expect(rounds[1]?.detail).toBe('Now fifty cents, and it sells out before noon.');
    // The round standing now has not been superseded, so it carries no `at`.
    expect(rounds[1]?.at).toBeUndefined();
  });

  it('an item nobody has revised is one round', () => {
    expect(dockRounds(payload()).map((r) => r.n)).toEqual([1]);
  });
});

/**
 * The rendered dock. The widget is driven the way a reader drives it — seed
 * the doc's threads into the same CRDT the server syncs into, render, tap —
 * and the answer is read off the REQUEST the widget made, never off the
 * screen, because answered is a fact on the server.
 */
interface Mounted {
  el: FeedbackWidgetEl;
  posts: Array<{ url: string; body: Record<string, unknown> }>;
}

function fakeSockets(): void {
  class FakeWS {
    static OPEN = 1;
    readyState = 1;
    binaryType = 'arraybuffer';
    addEventListener(): void {}
    removeEventListener(): void {}
    send(): void {}
    close(): void {}
  }
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS;
}

async function mountWidget(docId: string, answerStatus = 200): Promise<Mounted> {
  const posts: Mounted['posts'] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = (async (
    url: string,
    init?: RequestInit,
  ) => {
    const isAnswer = String(url).endsWith('/answer');
    if (init?.method === 'POST') {
      posts.push({ url: String(url), body: JSON.parse(String(init.body ?? '{}')) });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: isAnswer ? answerStatus : 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  fakeSockets();
  const mod = await import('../src/widget.ts');
  const el = mod.FeedbackWidget.init({ workspaceId: 'w-1', docId, user: 'jordan' });
  return { el, posts };
}

/** Write a thread into the widget's own Yjs doc, the way a sync would. */
function seedAsk(
  el: FeedbackWidgetEl,
  args: { threadId: string; commentId: string; review: ReviewPayload },
): void {
  const doc = el.client?.ydoc;
  if (!doc) throw new Error('widget has no doc to seed');
  createThread(doc, {
    threadId: args.threadId,
    anchor: { kind: 'subject' },
    createdBy: AGENT,
    firstComment: { id: args.commentId, text: 'Priced day one.', review: args.review },
  });
}

/** Let the click handler's fetch and its await settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

const q = (el: FeedbackWidgetEl, sel: string): HTMLElement | null =>
  el.shadow.querySelector(sel) as HTMLElement | null;

describe('the dock on the page', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main><button id="hello">Hello</button></main>';
    history.replaceState(null, '', '/');
  });
  afterEach(() => {
    document.querySelectorAll('claude-feedback-widget').forEach((el) => el.remove());
    document.querySelectorAll('.cfw-overlay, #cfw-light-styles').forEach((el) => el.remove());
  });

  it('shows the standing ask and its round count, and nothing when there is none', async () => {
    const { el } = await mountWidget('d-dock-1');
    el.renderThreads();
    // CONTROL for every assertion below: a page with no ask docks no bar, so
    // "the bar is there" is about the ask and not about the widget booting.
    expect(q(el, '.cw-dock')).toBeNull();

    seedAsk(el, {
      threadId: 'th-dock',
      commentId: 'c-dock',
      review: payload({
        revisions: [{ at: T0, by: 'Cartographer', headline: 'Which price?', detail: 'A dollar.' }],
      }),
    });
    el.renderThreads();
    const bar = q(el, '.cw-dock');
    expect(bar, 'a standing ask should dock').toBeTruthy();
    expect(bar?.querySelector('.cw-dock-text')?.textContent).toContain('Which price does day one');
    expect(bar?.querySelector('.cw-dock-round')?.textContent).toBe('Round 2');
  });

  it('opens the item with every round readable, and answers it in place', async () => {
    const { el, posts } = await mountWidget('d-dock-2');
    seedAsk(el, {
      threadId: 'th-answer',
      commentId: 'c-answer',
      review: payload({
        revisions: [
          {
            at: T0,
            by: 'Cartographer',
            headline: 'Which price?',
            detail: 'A dollar a cup, and nobody buys one.',
          },
        ],
      }),
    });
    el.renderThreads();
    (q(el, '.cw-dock-item') as HTMLButtonElement).click();
    const modal = q(el, '.cw-modal');
    expect(modal, 'tapping the bar should open the item').toBeTruthy();
    // Both rounds are on screen: the earlier one is history, not a deletion.
    expect(modal?.textContent).toContain('A dollar a cup, and nobody buys one.');
    expect(modal?.textContent).toContain('the most expensive stand on the street');

    (modal?.querySelector('.cw-answer-text') as HTMLTextAreaElement).value =
      'let the weather be the twist';
    (modal?.querySelector('.cw-answer-opt') as HTMLButtonElement).click();
    await settle();

    const answer = posts.find((p) => p.url.endsWith('/answer'));
    expect(answer, 'the answer should reach the doc thread route').toBeTruthy();
    expect(answer?.url).toContain('/workspaces/w-1/docs/d-dock-2/threads/th-answer/answer');
    // The LABEL is the verbatim answer and `optionId` says which candidate it
    // came from — the route's contract. A reason typed alongside rides with
    // the words rather than replacing them.
    expect(answer?.body.commentId).toBe('c-answer');
    expect(answer?.body.optionId).toBe('o-75');
    expect(String(answer?.body.text)).toContain('Ship at 75c');
    expect(String(answer?.body.text)).toContain('let the weather be the twist');
    expect(q(el, '.cw-modal'), 'an accepted answer closes the item').toBeNull();
  });

  it('CONTROL: a REFUSED answer keeps the item open and says so', async () => {
    // Without this, "the modal closed" above would pass on a dock that closed
    // whatever the server said — which would silently eat a lost answer.
    const { el, posts } = await mountWidget('d-dock-3', 500);
    seedAsk(el, { threadId: 'th-refuse', commentId: 'c-refuse', review: payload() });
    el.renderThreads();
    (q(el, '.cw-dock-item') as HTMLButtonElement).click();
    (q(el, '.cw-answer-opt') as HTMLButtonElement).click();
    await settle();
    expect(posts.some((p) => p.url.endsWith('/answer'))).toBe(true);
    expect(q(el, '.cw-modal'), 'a refused answer must not close the item').toBeTruthy();
    const err = q(el, '.cw-answer-err');
    expect(err?.hidden).toBe(false);
    expect(err?.textContent).toContain('try again');
    // And the one-at-a-time guard released, so the item can be answered
    // again. A guard that never released would leave the reader looking at
    // an open item whose buttons do nothing.
    (q(el, '.cw-answer-opt') as HTMLButtonElement).click();
    await settle();
    expect(posts.filter((p) => p.url.endsWith('/answer'))).toHaveLength(2);
  });

  it('a double tap on an option answers ONCE', async () => {
    // Nothing here is disabled on click, so on a slow connection the second
    // tap would answer the same item again — and whichever option landed last
    // would overwrite the first answer.
    const { el, posts } = await mountWidget('d-twice');
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const seen = posts;
    (globalThis as unknown as { fetch: unknown }).fetch = (async (
      url: string,
      init?: RequestInit,
    ) => {
      if (init?.method === 'POST') {
        seen.push({ url: String(url), body: JSON.parse(String(init.body ?? '{}')) });
      }
      await gate;
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    seedAsk(el, { threadId: 'th-twice', commentId: 'c-twice', review: payload() });
    el.renderThreads();
    (q(el, '.cw-dock-item') as HTMLButtonElement).click();
    const opts = Array.from(el.shadow.querySelectorAll('.cw-answer-opt')) as HTMLButtonElement[];
    opts[0]?.click();
    opts[1]?.click();
    await settle();
    expect(seen.filter((p) => p.url.endsWith('/answer'))).toHaveLength(1);
    release();
    await settle();
  });

  it('an answered item reads as answered rather than still asking', async () => {
    const { el } = await mountWidget('d-dock-4');
    seedAsk(el, {
      threadId: 'th-done',
      commentId: 'c-done',
      review: payload({
        answeredAt: T0,
        answeredBy: 'Jordan',
        answeredWith: 'o-75',
        answerText: 'Ship at 75c.',
      }),
    });
    el.renderThreads();
    expect(q(el, '.cw-dock-text')?.textContent).toContain('answered');
    (q(el, '.cw-dock-item') as HTMLButtonElement).click();
    expect(q(el, '.cw-modal-answered')?.textContent).toContain('Ship at 75c.');
    // Nothing left to answer with — the item is settled, not re-openable by
    // whoever taps it next.
    expect(q(el, '.cw-answer-opt')).toBeNull();
  });

  it('a ?thread= deep link lands with the item already open', async () => {
    history.replaceState(null, '', '/workspaces/w-1/mockups/d-deep?thread=th-deep');
    const { el } = await mountWidget('d-deep');
    seedAsk(el, {
      threadId: 'th-deep',
      commentId: 'c-deep',
      review: payload({ headline: 'Deep-linked ask' }),
    });
    el.renderThreads();
    expect(q(el, '.cw-modal')?.textContent).toContain('Deep-linked ask');
  });

  it('CONTROL: the link opens the item it NAMES, not whichever is on top', async () => {
    // A dock that opened its FIRST item whenever any thread was named would
    // pass the test above and would hand the reader the wrong ask. The named
    // thread is deliberately the one the bar ranks second.
    history.replaceState(null, '', '/workspaces/w-1/mockups/d-two?thread=th-zulu');
    const { el } = await mountWidget('d-two');
    seedAsk(el, {
      threadId: 'th-alpha',
      commentId: 'c-alpha',
      review: payload({ headline: 'The ask on top of the bar' }),
    });
    seedAsk(el, {
      threadId: 'th-zulu',
      commentId: 'c-zulu',
      review: payload({ headline: 'The ask the link names' }),
    });
    el.renderThreads();
    const open = q(el, '.cw-modal')?.textContent ?? '';
    expect(open).toContain('The ask the link names');
    expect(open).not.toContain('The ask on top of the bar');
  });

  it('CONTROL: without the query the same page lands with the item shut', async () => {
    // The deep link has to be the REASON the item is open — a dock that
    // opened every ask on load would pass the test above and be unusable.
    const { el } = await mountWidget('d-shut');
    seedAsk(el, { threadId: 'th-shut', commentId: 'c-shut', review: payload() });
    el.renderThreads();
    expect(q(el, '.cw-modal')).toBeNull();
    expect(q(el, '.cw-dock')).toBeTruthy();
  });
});
