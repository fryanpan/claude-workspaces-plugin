import type { Comment, Thread, User } from '@claude-workspaces/core';
import { createThread, postReply, setCommentDelivered } from '@claude-workspaces/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { widgetStyles } from '../src/styles.ts';
import { renderThreadsInto, showThreadPopover } from '../src/widget-threads.ts';
import type { FeedbackWidgetEl } from '../src/widget.ts';

/**
 * "Did anyone get that?", answered on the page the widget is a guest on.
 *
 * The board, the review editor and the widget all draw comments, and the mark
 * beside one is the same question on each. The app's four surfaces got it in
 * PR 1046; the widget drew no mark at all, which is the failure the shared
 * decision exists to stop — a feature added to "comments" that appears on
 * some of them.
 *
 * So both places the widget draws a comment are driven here through their own
 * real renderers: the thread popover (the comment itself) and the panel row
 * (the latest one). A single test through a helper would pass while a surface
 * that never calls it showed nothing.
 *
 * The DECISION is `packages/core/src/comment-receipt.ts` and is tested there.
 * What these say is that the widget asks it, on both surfaces, about the right
 * comment — and that the stylesheet the widget installs actually reveals the
 * second tick, because a `data-receipt` attribute no rule reads is a mark
 * nobody sees.
 *
 * Fictional names throughout. The repo is public.
 */

const reader: User = { id: 'u-reader', name: 'Riverbend', kind: 'known', color: '#2e7dd7' };
const agent: User = { id: 'u-agent', name: 'Harborlight', kind: 'known', color: '#b25e09' };

/** A clock that always moves: `receiptState` asks whether somebody spoke
 *  SINCE, and two comments written in one millisecond have no since. */
let tick = 1_700_000_000_000;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockImplementation(() => (tick += 1000));
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------- the popover

function popoverWidget(user: User | null = reader): FeedbackWidgetEl {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  document.body.append(host);
  return Object.assign(host, {
    shadow,
    user,
    opts: { serverUrl: 'ws://host:8787', workspaceId: 'w-1', docId: 'd-1' },
    postReply: async () => true,
    setStatus: async () => {},
  }) as unknown as FeedbackWidgetEl;
}

function plainThread(comments: Array<Partial<Comment>>): Thread {
  let at = 1_000;
  return {
    id: 't1',
    status: 'open',
    anchor: { kind: 'subject' },
    createdBy: reader,
    comments: comments.map((c, i) => ({
      id: `c${i}`,
      author: reader,
      text: 'anyone there?',
      ts: (at += 1000),
      ...c,
    })),
  } as unknown as Thread;
}

const marks = (root: ParentNode): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>('.cw-receipt'));

function popoverMarks(t: Thread, user: User | null = reader): string[] {
  const el = popoverWidget(user);
  showThreadPopover(el, t, 10, 10);
  return marks(el.shadow).map((m) => m.dataset.receipt ?? '');
}

describe('the thread popover', () => {
  it('marks a comment the reader wrote sent, and received once it was handed on', () => {
    expect(popoverMarks(plainThread([{}]))).toEqual(['sent']);
    expect(popoverMarks(plainThread([{ deliveredAt: 2_500 }]))).toEqual(['received']);
  });

  it('puts the mark beside the clock, where the board and the editor put it', () => {
    const el = popoverWidget();
    showThreadPopover(el, plainThread([{ deliveredAt: 2_500 }]), 10, 10);
    const author = el.shadow.querySelector('.thread-popover .comment .author') as HTMLElement;
    const kids = Array.from(author.children).map((k) => k.className);
    expect(kids).toEqual(['swatch', 'time', 'cw-receipt']);
    expect(author.querySelector('.cw-receipt')?.getAttribute('title')).toBe('Received');
  });

  it('draws nothing once somebody else has replied — the reply is the answer', () => {
    expect(popoverMarks(plainThread([{ deliveredAt: 2_500 }, { author: agent }]))).toEqual([]);
  });

  it('draws nothing on a comment the reader did not write', () => {
    expect(popoverMarks(plainThread([{ author: agent, deliveredAt: 2_500 }]))).toEqual([]);
  });

  it('draws nothing for a visitor the page never named', () => {
    expect(popoverMarks(plainThread([{ deliveredAt: 2_500 }]), null)).toEqual([]);
  });

  it('marks the reader own reply in a thread an agent opened', () => {
    const t = plainThread([{ author: agent, text: 'a question for you' }, { deliveredAt: 9_000 }]);
    expect(popoverMarks(t)).toEqual(['received']);
  });
});

// -------------------------------------------------------------- the panel row

/** The widget element the panel render needs, over a real Yjs doc — the same
 *  store the running widget reads, so the row is built by the real reader. */
function panelWidget(ydoc: Y.Doc, user: User | null = reader): FeedbackWidgetEl {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<div class="panel-threads"></div>';
  document.body.append(host);
  const pinLayer = document.createElement('div');
  document.body.append(pinLayer);
  return Object.assign(host, {
    shadow,
    user,
    pinLayer,
    threadPositions: new Map(),
    currentContext: undefined,
    showResolved: false,
    activeThread: null,
    client: { ydoc },
    scheduleRender: () => {},
  }) as unknown as FeedbackWidgetEl;
}

/** A doc holding one subject thread, and the id of its first comment. */
function docWithThread(author: User = reader): { ydoc: Y.Doc; commentId: string } {
  const ydoc = new Y.Doc();
  createThread(ydoc, {
    threadId: 'th-1',
    anchor: { kind: 'subject' },
    createdBy: author,
    firstComment: { id: 'cm-1', text: 'anyone there?' },
  });
  return { ydoc, commentId: 'cm-1' };
}

function rowMarks(ydoc: Y.Doc, user: User | null = reader): string[] {
  const el = panelWidget(ydoc, user);
  renderThreadsInto(el);
  const list = el.shadow.querySelector('.panel-threads') as HTMLElement;
  return marks(list).map((m) => m.dataset.receipt ?? '');
}

describe('the panel row', () => {
  it('marks the latest comment when the reader wrote it', () => {
    const { ydoc } = docWithThread();
    expect(rowMarks(ydoc)).toEqual(['sent']);
  });

  it('reads the delivery the server stamped onto the stored comment', () => {
    const { ydoc, commentId } = docWithThread();
    // The stamp time out of the expect: the verdict is what is asserted, and
    // `test:audit` reads a now() inside an expect as a wall-clock assertion.
    const at = Date.now();
    expect(setCommentDelivered(ydoc, 'th-1', commentId, at)).toBe('stamped');
    expect(rowMarks(ydoc)).toEqual(['received']);
    // CONTROL: the same stamp, read by anyone else, draws nothing.
    expect(rowMarks(ydoc, agent)).toEqual([]);
  });

  it('clears once an agent has replied on the thread', () => {
    const { ydoc, commentId } = docWithThread();
    setCommentDelivered(ydoc, 'th-1', commentId, Date.now());
    expect(rowMarks(ydoc), 'CONTROL: marked before the reply').toEqual(['received']);
    postReply(ydoc, 'th-1', { id: 'cm-2', author: agent, text: 'on it' });
    expect(rowMarks(ydoc)).toEqual([]);
  });

  it('keeps the mark when the reader is the one who spoke again', () => {
    const { ydoc, commentId } = docWithThread();
    setCommentDelivered(ydoc, 'th-1', commentId, Date.now());
    postReply(ydoc, 'th-1', { id: 'cm-2', author: reader, text: 'and also' });
    // The row shows the LATEST comment, which is the reader's own and unstamped.
    expect(rowMarks(ydoc)).toEqual(['sent']);
  });
});

// ------------------------------------------------------------- what is on screen

describe('the stylesheet the widget installs', () => {
  /** The mark, in a document wearing the widget's own sheet. */
  function painted(state: 'sent' | 'received'): { back: string; front: string } {
    const style = document.createElement('style');
    style.textContent = widgetStyles;
    document.head.append(style);
    const el = popoverWidget();
    showThreadPopover(el, plainThread([state === 'received' ? { deliveredAt: 2_500 } : {}]), 5, 5);
    // The rules are installed in the DOCUMENT here, not the shadow root, so
    // move the mark into the document to be judged by them — the running
    // widget puts the same sheet inside its own root.
    const mark = el.shadow.querySelector('.cw-receipt') as HTMLElement;
    document.body.append(mark);
    const back = mark.querySelector('.cw-tick-back') as Element;
    const front = Array.from(mark.querySelectorAll('path')).filter((p) => p !== back)[0] as Element;
    const read = (n: Element) => getComputedStyle(n).opacity;
    const out = { back: read(back), front: read(front) };
    style.remove();
    return out;
  }

  it('hides the second tick on a sent comment and reveals it on a received one', () => {
    const sent = painted('sent');
    const received = painted('received');
    expect(sent.front, 'CONTROL: the first tick is painted in both states').not.toBe('0');
    expect(received.front).toBe(sent.front);
    expect(sent.back).toBe('0');
    expect(received.back).toBe('1');
  });
});
