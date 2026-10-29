/**
 * Voice comments on the review doc: tap the mic, talk about the document, and
 * each note lands as a comment on the passage it is about.
 *
 * Everything that is not about a document is the widget's voice mode, reused
 * rather than copied: `VoiceSession` streams the microphone to the server's
 * voice relay (`/workspaces/<ws>/docs/<id>/voice`), which decides where one
 * note ends, tidies the words and picks the passage; the session keeps each
 * note in step with a thread through the same thread routes a typed comment
 * uses (`threadPoster`). What is here is the document's half: its passages as
 * the catalog the relay picks from (`doc-voice-targets.ts`), pointing — a tap
 * on a paragraph or a selection while talking pins the next note there — and
 * the live card (`doc-voice-view.ts`).
 *
 * Mounted only for a reader who can write: a voice note is a comment, and the
 * relay spends the owner's transcription engine.
 */
import type { User } from '@claude-workspaces/core';
import { startPcmCapture } from '@claude-workspaces/widget/voice-audio';
import { threadPoster } from '@claude-workspaces/widget/voice-post';
import {
  type SocketLike,
  type VoiceComment,
  VoiceSession,
  type VoiceSessionDeps,
} from '@claude-workspaces/widget/voice-session';
import { createQuestionSpeaker } from '@claude-workspaces/widget/voice-speak';
import { api } from '../doc-path.ts';
import type { EditorHandle } from '../editor.ts';
import type { MountScope } from '../mount-scope.ts';
import { docVoiceTargets } from './doc-voice-targets.ts';
import { DocVoiceView, NOTHING_HEARD } from './doc-voice-view.ts';

/** How long a recording may hear nothing before the card says so. */
export const SILENCE_MS = 5000;
export const NOTHING_POSTED = 'Nothing was heard, so nothing was posted.';
/** A selection dragged out on a touch screen settles before it points. */
const SELECTION_SETTLE_MS = 400;

type Timers = NonNullable<VoiceSessionDeps['timers']>;

export interface DocVoiceOptions {
  docId: string;
  user: User;
  editor: EditorHandle;
  editorMount: HTMLElement;
  scope: MountScope;
  /** Injected by a test: the relay's socket, the microphone, the clock and
   *  the thread writes. */
  openSocket?: (url: string) => SocketLike;
  startCapture?: VoiceSessionDeps['startCapture'];
  timers?: Timers;
  send?: (url: string, body: unknown) => Promise<Response>;
}

export interface DocVoice {
  session: VoiceSession;
  view: DocVoiceView;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const postJson = (url: string, body: unknown): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

export function mountDocVoice(opts: DocVoiceOptions): DocVoice {
  const { docId, user, editor, editorMount, scope } = opts;
  const timers = opts.timers ?? realTimers;
  const enc = encodeURIComponent;
  const targets = docVoiceTargets(editor);
  const view = new DocVoiceView(editorMount);
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  /** The relay's socket, so leaving the page can close it at once. */
  let socket: SocketLike | null = null;
  /** Says a question aloud; its context is made in the mic's tap. */
  const speaker = createQuestionSpeaker(() => {
    const Ctor = window.AudioContext;
    return Ctor ? new Ctor() : null;
  });

  const session = new VoiceSession({
    url: `${wsProto}://${location.host}${api(`docs/${enc(docId)}/voice`)}`,
    openSocket: (u) => {
      socket = opts.openSocket ? opts.openSocket(u) : (new WebSocket(u) as unknown as SocketLike);
      return socket;
    },
    startCapture: opts.startCapture ?? startPcmCapture,
    poster: threadPoster(
      () => api(`docs/${enc(docId)}/threads`),
      opts.send ?? postJson,
      () => user,
    ),
    author: () => user,
    catalog: () => targets.catalog(),
    anchorFor: (t) => targets.anchorFor(t),
    speaker,
    onChange: () => draw(),
    timers,
  });

  // --- what the card says ----------------------------------------------------

  let picking: string | null = null;
  let heardAny = false;
  let silent = false;
  let silenceTimer: unknown = null;
  let notice: string | null = null;
  let lastState = session.state;
  /** Record Audio's buttons, disabled while this has the microphone. */
  let held: HTMLButtonElement[] = [];

  /** The note the card shows: one reopened to add to, else the newest still growing. */
  const openNote = (): VoiceComment | null => {
    let open: VoiceComment | null = null;
    for (const c of session.comments.values()) {
      if (c.take !== session.recording) continue;
      if (c.reopening) return c;
      if (!c.final) open = c;
    }
    return open;
  };

  function transition(from: typeof lastState, to: typeof lastState): void {
    if (from === 'idle' && to !== 'idle') {
      heardAny = false;
      silent = false;
      notice = null;
      holdRecordAudio(true);
    }
    if (to === 'recording' && from !== 'recording') {
      silenceTimer = timers.set(() => {
        silenceTimer = null;
        silent = true;
        draw();
      }, SILENCE_MS);
    }
    if (to === 'idle' && from !== 'idle') {
      if (silenceTimer !== null) timers.clear(silenceTimer);
      silenceTimer = null;
      picking = null;
      editor.markPending(null);
      holdRecordAudio(false);
      if (!heardAny && !session.note) notice = NOTHING_POSTED;
    }
  }

  function draw(): void {
    // A socket closing after the page was left reports to a gone editor.
    if (scope.disposed) return;
    const state = session.state;
    if (state !== lastState) transition(lastState, state);
    lastState = state;
    const open = openNote();
    if (session.heard.trim() || session.pending.trim() || open) heardAny = true;
    const pinned = session.pinned;
    const target = picking
      ? (session.comments.get(picking)?.target ?? null)
      : pinned !== undefined
        ? pinned
        : (open?.target ?? null);
    const passage = targets.element(target);
    const hint = silent && !heardAny;
    const where = picking
      ? 'Tap where this belongs'
      : session.reconnecting
        ? 'Reconnecting…'
        : state === 'connecting'
          ? 'Starting…'
          : state === 'stopping'
            ? 'Finishing…'
            : passage
              ? targets.name(target)
              : 'Listening…';
    // The words pointed at stay marked until the note on them is said.
    const sel = target === null ? undefined : targets.selection(target);
    editor.markPending(state !== 'idle' && sel ? editor.resolveRel(sel.start, sel.end) : null);
    view.draw({
      on: state !== 'idle',
      where,
      seeking: !picking && !passage,
      picking: picking !== null,
      text: hint ? NOTHING_HEARD : pinned !== undefined ? '' : (open?.text ?? ''),
      hint,
      pending: session.pending,
      canMove: !!open && open.target !== null && !picking && state === 'recording',
      passage,
      notice: session.note ?? notice,
      ask: session.ask,
    });
  }

  function holdRecordAudio(on: boolean): void {
    if (!on) {
      for (const b of held) b.disabled = false;
      held = [];
      return;
    }
    // A meeting already recording keeps its Stop button.
    held = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.meeting-record, .meeting-record-options'),
    ).filter((b) => !b.disabled && !b.classList.contains('is-live'));
    for (const b of held) b.disabled = true;
  }

  // --- pointing while talking ------------------------------------------------

  const live = (): boolean => session.state === 'recording' || session.state === 'connecting';
  const prose = (): HTMLElement => editor.editor.view.dom as HTMLElement;

  /** Where a tap or a selection points, as a target; null when it points nowhere. */
  function pointed(node: EventTarget | null): number | null {
    const dom = window.getSelection();
    if (dom && !dom.isCollapsed && dom.anchorNode && prose().contains(dom.anchorNode)) {
      const sel = editor.getSelectionRel();
      if (sel?.snippet.trim()) {
        const i = targets.point(sel, dom.anchorNode);
        session.refreshTargets();
        return i;
      }
    }
    if (node instanceof Element && node.closest('.thread, .cw-inline-card')) return null;
    let block = targets.blockAt(node);
    if (block === null) {
      // A passage written since the catalog was last read.
      session.refreshTargets();
      block = targets.blockAt(node);
    }
    return block;
  }

  function pointAt(node: EventTarget | null): void {
    const target = pointed(node);
    if (target === null) return;
    if (picking) {
      const key = picking;
      picking = null;
      session.move(key, target);
    } else {
      session.pin(target);
    }
    draw();
  }

  let settle: unknown = null;
  scope.listen(prose(), 'pointerup', (ev) => {
    if (!live()) return;
    pointAt(ev.target);
  });
  // A long-press selection on a touch screen ends with no pointerup on the
  // prose; the selection settling is the only word that it is done.
  scope.listen(document, 'selectionchange', () => {
    if (!live()) return;
    const dom = window.getSelection();
    if (!dom || dom.isCollapsed || !dom.anchorNode || !prose().contains(dom.anchorNode)) return;
    if (settle !== null) timers.clear(settle);
    settle = timers.set(() => {
      settle = null;
      if (live()) pointAt(dom.anchorNode);
    }, SELECTION_SETTLE_MS);
  });
  scope.listen(window, 'keydown', (ev) => {
    if ((ev as KeyboardEvent).key !== 'Escape' || !picking) return;
    picking = null;
    draw();
  });

  // --- controls ---------------------------------------------------------------

  scope.listen(view.mic, 'click', () => {
    if (session.state === 'idle') {
      speaker.wake();
      void session.start();
    } else {
      picking = null;
      session.stop();
    }
  });
  scope.listen(view.ask, 'click', (ev) => {
    const b = (ev.target as Element).closest<HTMLButtonElement>('button');
    if (b) session.answer(b.dataset.i === undefined ? null : Number(b.dataset.i));
  });
  scope.listen(view.move, 'click', () => {
    const open = openNote();
    if (!open) return;
    picking = open.key;
    draw();
  });
  scope.listen(view.live.querySelector('.doc-voice-where') as HTMLElement, 'click', () => {
    const target = session.pinned ?? openNote()?.target ?? null;
    targets.element(target)?.scrollIntoView({ block: 'center' });
  });
  scope.listen(editorMount, 'scroll', () => view.place(), { passive: true });
  scope.listen(window, 'resize', () => view.place());
  scope.onCleanup(() => {
    if (settle !== null) timers.clear(settle);
    if (silenceTimer !== null) timers.clear(silenceTimer);
    holdRecordAudio(false);
    // Stop lets go of the microphone; closing the socket ends the relay's
    // engine now rather than when it has tidied the last words.
    session.stop();
    socket?.close(1000);
    view.remove();
  });
  draw();
  return { session, view };
}
