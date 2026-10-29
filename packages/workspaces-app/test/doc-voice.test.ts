import { prose } from '@claude-workspaces/core';
import type { SocketLike } from '@claude-workspaces/widget/voice-session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { NOTHING_HEARD } from '../src/doc/doc-voice-view.ts';
import { NOTHING_POSTED, SILENCE_MS, mountDocVoice } from '../src/doc/doc-voice.ts';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { MountScope } from '../src/mount-scope.ts';

/**
 * Voice comments on the review doc (doc/doc-voice.ts), driven end to end with
 * the three things a recording talks to faked: the relay's socket (a test
 * speaks for the server), the microphone, and the thread routes. The editor
 * is the real one over a real Y.Doc, so an anchor is proved by resolving it
 * back to the words it covers — not by reading its bytes. The clock is
 * injected; nothing here waits on a wall clock.
 */

const CLIP = '/workspaces/w-1/docs/d-1/voice-feedback/seg-1.wav#t=0,4';
const DOC = [
  '# Harborlight launch plan',
  '',
  'Week one is Riverbend only.',
  '',
  'Week two adds reminders for Saltmarsh.',
  '',
].join('\n');

class FakeSocket implements SocketLike {
  binaryType = '';
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: unknown[] = [];
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  recv(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  /** The connection went away without anyone asking — a server restart. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  json(): Array<Record<string, unknown>> {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as Record<string, unknown>);
  }
}

/** A clock the test moves by hand. */
function manualClock() {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    set: (fn: () => void, ms: number): unknown => {
      seq += 1;
      due.set(seq, { at: now + ms, fn });
      return seq;
    },
    clear: (h: unknown): void => {
      due.delete(h as number);
    },
    advance(ms: number): void {
      now += ms;
      for (const [id, t] of [...due].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now) continue;
        due.delete(id);
        t.fn();
      }
    },
  };
}

const cleanups: Array<() => void> = [];
beforeEach(() => {
  history.replaceState(null, '', '/workspaces/w-1/docs/d-1');
  document.body.innerHTML = '<main id="editor-pane"><div id="editor"></div></main>';
});
afterEach(() => {
  for (const f of cleanups.splice(0).reverse()) f();
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

function mount() {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(DOC));
  const editorMount = document.getElementById('editor') as HTMLElement;
  const editor: EditorHandle = createEditor({
    parent: editorMount,
    ydoc,
    awareness: new Awareness(ydoc),
  });
  const scope = new MountScope();
  const clock = manualClock();
  const sockets: FakeSocket[] = [];
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const voice = mountDocVoice({
    docId: 'd-1',
    user: { id: 'u-1', name: 'Bryan', kind: 'known', color: '#2e7dd7' },
    editor,
    editorMount,
    scope,
    timers: clock,
    openSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    startCapture: async () => ({ ok: true, capture: { stop: () => {} } }),
    send: async (url, body) => {
      posts.push({ url, body: body as Record<string, unknown> });
      return new Response(
        JSON.stringify({
          thread: { id: 'th-1', comments: [{ id: 'c-1', author: { name: 'Bryan' } }] },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  cleanups.push(() => {
    scope.dispose();
    editor.destroy();
  });
  const paragraph = (words: string): HTMLElement => {
    const p = Array.from(editor.editor.view.dom.querySelectorAll('p')).find((el) =>
      el.textContent?.includes(words),
    );
    if (!p) throw new Error(`no paragraph with ${words}`);
    return p as HTMLElement;
  };
  const socket = (): FakeSocket => {
    const s = sockets.at(-1);
    if (!s) throw new Error('no socket opened');
    return s;
  };
  /** Tap the mic, and the server opens and says it is listening. */
  async function startRecording(): Promise<FakeSocket> {
    voice.view.mic.click();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    socket().open();
    await vi.waitFor(() => expect(voice.session.state).toBe('connecting'));
    socket().recv({ type: 'ready', segment: 1 });
    expect(voice.session.state).toBe('recording');
    return socket();
  }
  /** The words the posted anchor covers, read back through the live doc. */
  const anchoredWords = (anchor: unknown): string => {
    const a = anchor as { kind: string; startRel: number[]; endRel: number[] };
    expect(a.kind).toBe('text-range');
    const r = editor.resolveRel(Uint8Array.from(a.startRel), Uint8Array.from(a.endRel));
    if (!r) throw new Error('anchor does not resolve');
    return editor.editor.state.doc.textBetween(r.from, r.to, ' ');
  };
  const where = (): string => voice.view.live.querySelector('.doc-voice-where')?.textContent ?? '';
  const cardText = (): string =>
    voice.view.live.querySelector('.doc-voice-text')?.textContent ?? '';
  return {
    voice,
    clock,
    posts,
    sockets,
    paragraph,
    startRecording,
    anchoredWords,
    where,
    cardText,
  };
}

const pointerUp = (el: Element): void => {
  el.dispatchEvent(new Event('pointerup', { bubbles: true }));
};

describe('voice comments on a review doc — pointing at a passage', () => {
  it('a note said while pointing at a paragraph lands on that paragraph, with its clip and raw words', async () => {
    const t = mount();
    const socket = await t.startRecording();
    const start = socket.json().find((m) => m.type === 'start') as {
      targets: Array<{ i: number; tag: string; text: string }>;
    };
    const target = start.targets.find((x) => x.text === 'Week two adds reminders for Saltmarsh.');
    expect(target?.tag).toBe('p');

    pointerUp(t.paragraph('Week two'));
    expect(socket.json()).toContainEqual({ type: 'pin', target: target?.i });
    expect(t.where()).toContain('Week two adds reminders');

    socket.recv({
      type: 'heard',
      text: 'um this one needs a date',
      pending: 'um this one needs a date',
    });
    socket.recv({
      type: 'comment',
      key: 'v1',
      text: 'Give this a date.',
      raw: 'um this one needs a date',
      clip: CLIP,
      target: target?.i ?? null,
      final: true,
    });

    await vi.waitFor(() => expect(t.posts).toHaveLength(1));
    const [post] = t.posts;
    expect(post?.url).toBe('/workspaces/w-1/docs/d-1/threads');
    expect(post?.body.text).toBe('Give this a date.');
    expect(post?.body.voice).toEqual({ clip: CLIP, raw: 'um this one needs a date' });
    expect(t.anchoredWords(post?.body.anchor)).toBe('Week two adds reminders for Saltmarsh.');
    // The relay is told who is speaking, and which thread the note became:
    // for its log, and to write the note itself if this page goes first.
    expect(socket.json()[0]).toMatchObject({ type: 'start', author: { id: 'u-1' } });
    await vi.waitFor(() =>
      expect(socket.json()).toContainEqual({
        type: 'posted',
        key: 'v1',
        threadId: 'th-1',
      }),
    );
  });

  it('a selection made while talking anchors the note to exactly the words selected', async () => {
    const t = mount();
    const socket = await t.startRecording();
    const text = t.paragraph('Week one').firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 'Week one is '.length);
    range.setEnd(text, 'Week one is Riverbend'.length);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    pointerUp(t.paragraph('Week one'));
    const pin = socket.json().find((m) => m.type === 'pin') as { target: number };
    // The selection went to the relay as a target of its own, inside its paragraph.
    const refreshed = socket
      .json()
      .filter((m) => m.type === 'targets')
      .at(-1) as {
      targets: Array<{ i: number; tag: string; text: string }>;
    };
    expect(refreshed.targets.find((x) => x.i === pin.target)).toMatchObject({
      tag: 'mark',
      text: 'Riverbend',
    });
    expect(t.where()).toBe('“Riverbend”');

    socket.recv({
      type: 'comment',
      key: 'v1',
      text: 'Name the other offices too.',
      raw: 'name the other offices too',
      clip: CLIP,
      target: pin.target,
      final: false,
    });
    await vi.waitFor(() => expect(t.posts).toHaveLength(1));
    expect(t.anchoredWords(t.posts[0]?.body.anchor)).toBe('Riverbend');
  });

  it('a note nobody pointed at goes where the transcriber placed it', async () => {
    const t = mount();
    const socket = await t.startRecording();
    const start = socket.json().find((m) => m.type === 'start') as {
      targets: Array<{ i: number; text: string }>;
    };
    const target = start.targets.find((x) => x.text === 'Week one is Riverbend only.');
    socket.recv({
      type: 'comment',
      key: 'v1',
      text: 'Say who runs it.',
      raw: 'say who runs it',
      clip: CLIP,
      target: target?.i ?? null,
      final: true,
    });
    await vi.waitFor(() => expect(t.posts).toHaveLength(1));
    expect(socket.json().some((m) => m.type === 'pin')).toBe(false);
    expect(t.anchoredWords(t.posts[0]?.body.anchor)).toBe('Week one is Riverbend only.');
  });
});

describe('voice comments on a review doc — nothing heard', () => {
  it('says "Nothing heard" once five seconds pass with no words, and not before', async () => {
    const t = mount();
    await t.startRecording();
    t.clock.advance(SILENCE_MS - 1);
    expect(t.cardText()).not.toBe(NOTHING_HEARD);
    t.clock.advance(1);
    expect(t.cardText()).toBe(NOTHING_HEARD);
  });

  it('stays quiet about silence when words arrived inside the five seconds', async () => {
    const t = mount();
    const socket = await t.startRecording();
    t.clock.advance(SILENCE_MS / 2);
    socket.recv({ type: 'heard', text: 'the rollout', pending: 'the rollout' });
    t.clock.advance(SILENCE_MS);
    expect(t.cardText()).not.toBe(NOTHING_HEARD);
  });

  it('says nothing was posted when a silent recording stops', async () => {
    const t = mount();
    const socket = await t.startRecording();
    t.voice.view.mic.click();
    socket.recv({ type: 'stopped' });
    expect(t.voice.session.state).toBe('idle');
    expect(t.voice.view.readout.hidden).toBe(false);
    expect(t.voice.view.readout.textContent).toBe(NOTHING_POSTED);
    expect(t.posts).toHaveLength(0);
  });
});

describe('voice comments on a review doc — the server restarts mid-recording', () => {
  it('shows one steady Reconnecting… and no error, then listens again on the new socket', async () => {
    const t = mount();
    const first = await t.startRecording();
    first.drop();
    expect(t.voice.session.state).toBe('recording');
    expect(t.where()).toBe('Reconnecting…');
    expect(t.voice.view.readout.hidden, 'no error is shown').toBe(true);
    // Every attempt that fails while the server is down leaves the card as it was.
    for (const ms of [250, 500, 1000]) {
      t.clock.advance(ms);
      t.sockets.at(-1)?.drop();
      expect(t.where()).toBe('Reconnecting…');
      expect(t.voice.view.readout.hidden).toBe(true);
    }
    t.clock.advance(2000);
    const next = t.sockets.at(-1);
    next?.open();
    next?.recv({ type: 'ready', segment: 2 });
    expect(t.where()).toBe('Listening…');
    expect(t.voice.view.readout.hidden).toBe(true);
  });
});

describe('voice comments on a review doc — the one clarifying question', () => {
  it('shows the question by the live card, and a tapped answer edits the same comment', async () => {
    const t = mount();
    const socket = await t.startRecording();
    const start = socket.json().find((m) => m.type === 'start') as {
      targets: Array<{ i: number; text: string }>;
    };
    const one = start.targets.find((x) => x.text.startsWith('Week one'))?.i ?? null;
    const two = start.targets.find((x) => x.text.startsWith('Week two'))?.i ?? null;
    const frame = (target: number | null) => ({
      type: 'comment',
      key: 'v1',
      text: 'This week needs a date.',
      raw: 'this week needs a date',
      clip: CLIP,
      target,
      final: false,
    });
    socket.recv(frame(one));
    await vi.waitFor(() => expect(t.posts).toHaveLength(1));
    expect(t.voice.view.ask.hidden, 'CONTROL: no question yet').toBe(true);

    socket.recv({
      type: 'ask',
      key: 'v1',
      question: 'Which week?',
      choices: ['Week one', 'Week two'],
      about: 'anchor',
    });
    expect(t.voice.view.ask.hidden).toBe(false);
    expect(t.voice.view.ask.textContent).toBe('Which week?Week oneWeek twoKeep as is');
    (t.voice.view.ask.querySelector('[data-i="1"]') as HTMLElement).click();
    expect(socket.json().at(-1)).toEqual({ type: 'answer', key: 'v1', choice: 1 });
    expect(t.voice.view.ask.hidden).toBe(true);

    // The server sends the same note again, on the chosen passage.
    socket.recv(frame(two));
    await vi.waitFor(() => expect(t.posts).toHaveLength(2));
    expect(t.posts[1]?.url).toMatch(/\/threads\/th-1\/reanchor$/);
    expect(t.anchoredWords(t.posts[1]?.body.anchor)).toBe('Week two adds reminders for Saltmarsh.');
    expect(
      t.posts.filter((p) => p.url.endsWith('/threads')),
      'one comment, not two',
    ).toHaveLength(1);
  });
});
