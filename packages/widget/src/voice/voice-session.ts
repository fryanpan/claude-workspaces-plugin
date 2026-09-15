import {
  type Anchor,
  MAX_VOICE_RAW,
  type VoiceCommentFrame,
  type VoiceNote,
  type VoiceTarget,
  parseVoiceServerMessage,
} from '@claude-workspaces/core';
import type { PcmCaptureOpts, PcmCaptureStart } from './voice-audio.ts';
import type { PostedComment, VoicePoster } from './voice-post.ts';

/**
 * One recording: the microphone streamed to the server's voice relay, and
 * what the relay says back turned into comments on the page.
 *
 * The server decides WHAT the comments are — where one topic ends, the tidied
 * words, which element each is about (`voice-feedback-relay.ts`). This decides
 * nothing of that. It keeps each comment the server named in step with a
 * thread: the first frame for a key creates it, a later one edits its words or
 * moves its anchor. The server sends a comment's words only when a note is
 * finished — at a pause, or a switch — so a thread is edited once per
 * finished note, never word by word; the words in between are `pending`.
 * A tap on an earlier note of the recording opens it again (`reopen`), and
 * the next words add to it. Writing through
 * the thread routes rather than having the server post means a spoken comment
 * carries the identity and sign-in of the widget that heard it, exactly as a
 * typed one does.
 *
 * No DOM here beyond the socket, so a test drives it with a fake socket, a
 * fake microphone and a recording poster (`voice-ui.ts` draws what it holds).
 */

export type SessionState = 'idle' | 'connecting' | 'recording' | 'stopping';

export interface VoiceComment {
  /** Unique for the page's life: the recording, then the server's name. */
  key: string;
  /** The server's name for it, which starts again at `v1` every recording. */
  wire: string;
  /** Which recording said it. */
  take: number;
  text: string;
  raw: string;
  clip: string;
  target: number | null;
  final: boolean;
  /** The thread it became, once the create answered. */
  posted?: PostedComment;
  /** The last write the server refused; retried by `retryRefused`. */
  refused?: boolean;
  /** Undone — resolved — by the person. */
  resolved?: boolean;
  /** Tapped to add to, and the server has not answered yet: it is the note
   *  being talked about already. */
  reopening?: boolean;
}

export interface SocketLike {
  binaryType: string;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number): void;
}

export interface VoiceSessionDeps {
  /** `ws(s)://…/workspaces/<ws>/docs/<doc>/voice`. */
  url: string;
  openSocket: (url: string) => SocketLike;
  startCapture: (opts: PcmCaptureOpts) => Promise<PcmCaptureStart>;
  poster: VoicePoster;
  /** The page, described — `collectTargets`, with the recording's numbering. */
  catalog: () => VoiceTarget[];
  /** A target index to an anchor; `null`, or an element gone, is the page. */
  anchorFor: (target: number | null) => Anchor;
  /** Anything worth redrawing changed. */
  onChange: () => void;
  /** A write was refused; the words to show, or null to say nothing. */
  refusedNote?: () => string | null;
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
}

/** Frames held while the server opens its engine — about ten seconds. */
const MAX_BUFFERED = 200;
/** How long Stop waits for the last words to be tidied before it gives up. */
const STOP_WAIT_MS = 30_000;

const UNAVAILABLE: Record<string, string> = {
  sign_in_required: 'Sign in to give voice feedback on this page.',
  not_configured: 'Voice feedback is not set up on this server.',
  engine_failed: 'The transcriber could not start. Try again in a moment.',
};

export class VoiceSession {
  state: SessionState = 'idle';
  /** In the order the server named them. */
  readonly comments = new Map<string, VoiceComment>();
  /** The last few seconds of raw words. */
  heard = '';
  /** The words said since the last pause that no note holds yet. */
  pending = '';
  /** A tapped element the next comment starts on; `undefined` for none. */
  pinned: number | null | undefined = undefined;
  /** Something to tell the person — a refusal, a failure. */
  note: string | null = null;

  private ws: SocketLike | null = null;
  private capture: { stop(): void } | null = null;
  private buffered: Int16Array[] = [];
  private ready = false;
  private chains = new Map<string, Promise<void>>();
  private sent = new Map<
    string,
    { text: string; raw: string; clip: string; target: number | null }
  >();
  private stopTimer: unknown = null;
  /** Recordings started; the server's comment names repeat across them. */
  private take = 0;

  constructor(private readonly deps: VoiceSessionDeps) {}

  /** Which recording is the current one; a comment's `take` says if it is from it. */
  get recording(): number {
    return this.take;
  }

  private get timers() {
    return (
      this.deps.timers ?? {
        set: (fn: () => void, ms: number) => setTimeout(fn, ms),
        clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
      }
    );
  }

  private change(): void {
    this.deps.onChange();
  }

  /** `context`: an AudioContext made inside the tap — see `createAudioPump`. */
  async start(context?: AudioContext): Promise<void> {
    if (this.state !== 'idle') return;
    this.state = 'connecting';
    this.take += 1;
    this.note = null;
    this.heard = '';
    this.pending = '';
    this.pinned = undefined;
    this.ready = false;
    this.buffered = [];
    this.change();
    const ws = this.deps.openSocket(this.deps.url);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () =>
      this.sendJson({ type: 'start', sampleRate: 16_000, targets: this.deps.catalog() });
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => {};
    ws.onclose = () => this.closed();
    const started = await this.deps.startCapture({
      onFrame: (pcm) => this.frame(pcm),
      ...(context ? { context } : {}),
    });
    if (!started.ok) {
      this.finish(started.message);
      return;
    }
    // Stopped, or refused by the server, while the microphone was opening.
    if (this.ws !== ws) {
      started.capture.stop();
      return;
    }
    this.capture = started.capture;
  }

  /** Stop: the microphone now, the last words once the server has tidied them. */
  stop(): void {
    if (this.state === 'idle' || this.state === 'stopping') return;
    this.capture?.stop();
    this.capture = null;
    // Nothing said yet: nothing to wait for.
    if (!this.ready && this.buffered.length === 0) {
      this.finish(null);
      return;
    }
    this.state = 'stopping';
    // Words said while the engine was still opening wait for it: `ready`
    // sends them, then the stop.
    if (this.ready) this.sendJson({ type: 'stop' });
    this.stopTimer = this.timers.set(() => this.finish(null), STOP_WAIT_MS);
    this.change();
  }

  /** The person tapped an element: the next words go there — into the note
   *  this recording already has on it, or a new one. */
  pointAt(target: number | null): void {
    const notes = [...this.comments.values()].reverse();
    const had = notes.find((c) => c.take === this.take && target !== null && c.target === target);
    if (had) this.reopen(had.key);
    else this.pin(target);
  }

  /** The next words start a new note on `target`. */
  pin(target: number | null): void {
    if (this.state !== 'recording' && this.state !== 'connecting') return;
    for (const c of this.comments.values()) c.reopening = false;
    this.pinned = target;
    this.sendJson({ type: 'pin', target });
    this.change();
  }

  /** The person tapped an earlier note: the next words add to it. A note from
   *  an earlier recording is past the server's reach, so its element takes a
   *  new one. */
  reopen(key: string): void {
    const c = this.comments.get(key);
    if (!c || (this.state !== 'recording' && this.state !== 'connecting')) return;
    if (c.take !== this.take) {
      this.pin(c.target);
      return;
    }
    if (!c.final || c.reopening) return;
    for (const o of this.comments.values()) o.reopening = false;
    c.reopening = true;
    this.pinned = undefined;
    this.sendJson({ type: 'reopen', key: c.wire });
    this.change();
  }

  /** The person moved a comment to the element they meant. */
  move(key: string, target: number | null): void {
    const c = this.comments.get(key);
    if (!c) return;
    c.target = target;
    // A settled comment, or one from an earlier recording, is past the
    // server's reach; its thread moves here.
    if (!c.final && c.take === this.take) this.sendJson({ type: 'move', key: c.wire, target });
    this.sync(c);
    this.change();
  }

  /** The page changed under the speaker. */
  /** Describe the page again — locally always, to the server once it is listening. */
  refreshTargets(): void {
    const targets = this.deps.catalog();
    if (this.ready) this.sendJson({ type: 'targets', targets });
  }

  async setResolved(key: string, resolved: boolean): Promise<void> {
    const c = this.comments.get(key);
    if (!c?.posted) return;
    if (await this.deps.poster.setResolved(c.posted.threadId, resolved)) {
      c.resolved = resolved;
      this.change();
    }
  }

  /** Write again everything a refusal held back — after a sign-in. */
  retryRefused(): void {
    for (const c of this.comments.values()) {
      if (c.refused) {
        c.refused = false;
        this.sync(c);
      }
    }
  }

  private sendJson(msg: unknown): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  private frame(pcm: Int16Array): void {
    if (!this.ws || (this.state !== 'recording' && this.state !== 'connecting')) return;
    if (!this.ready) {
      if (this.buffered.length < MAX_BUFFERED) this.buffered.push(pcm);
      return;
    }
    if (this.ws.readyState === 1) this.ws.send(pcm);
  }

  private onMessage(data: unknown): void {
    const m = parseVoiceServerMessage(data);
    if (!m) return;
    switch (m.type) {
      case 'ready':
        this.ready = true;
        if (this.state === 'connecting') this.state = 'recording';
        for (const pcm of this.buffered) this.ws?.send(pcm);
        this.buffered = [];
        if (this.state === 'stopping') this.sendJson({ type: 'stop' });
        this.change();
        return;
      case 'unavailable':
        this.finish(UNAVAILABLE[m.reason] ?? 'Voice feedback is not available here.');
        return;
      case 'heard':
        this.heard = m.text;
        this.pending = m.pending;
        this.change();
        return;
      case 'comment':
        this.comment(m);
        return;
      case 'error':
        this.note = m.message;
        this.change();
        return;
      case 'stopped':
        this.finish(null);
        return;
    }
  }

  private comment(f: VoiceCommentFrame): void {
    const key = `${this.take}.${f.key}`;
    const had = this.comments.get(key);
    const c: VoiceComment = had ?? {
      key,
      wire: f.key,
      take: this.take,
      text: '',
      raw: '',
      clip: '',
      target: null,
      final: false,
    };
    c.text = f.text;
    c.raw = f.raw;
    c.clip = f.clip;
    c.target = f.target;
    c.final = f.final;
    c.reopening = false;
    // A new comment has taken the pinned element; the pin is spent. One the
    // words said before the tap made, elsewhere, leaves it waiting.
    if (!had && this.pinned !== undefined && f.target === this.pinned) this.pinned = undefined;
    this.comments.set(c.key, c);
    this.sync(c);
    this.change();
  }

  /** One write at a time per comment, each reading the comment as it is then. */
  private sync(c: VoiceComment): void {
    const prev = this.chains.get(c.key) ?? Promise.resolve();
    this.chains.set(
      c.key,
      prev.then(() => this.push(c)).catch(() => this.refuse(c)),
    );
  }

  private async push(c: VoiceComment): Promise<void> {
    if (c.refused || !c.text.trim()) return;
    const voice: VoiceNote = { clip: c.clip, raw: c.raw.slice(-MAX_VOICE_RAW) };
    const was = this.sent.get(c.key);
    const now = { text: c.text, raw: voice.raw, clip: c.clip, target: c.target };
    if (!c.posted) {
      const posted = await this.deps.poster.create(this.deps.anchorFor(c.target), c.text, voice);
      if (!posted) return this.refuse(c);
      c.posted = posted;
      this.sent.set(c.key, now);
      // A create that answers after its recording ended must not name a
      // comment of the next one.
      if (c.take === this.take) {
        this.sendJson({ type: 'posted', key: c.wire, threadId: posted.threadId });
      }
      this.change();
      return;
    }
    if (!was) return;
    if (was.target !== now.target) {
      if (!(await this.deps.poster.reanchor(c.posted.threadId, this.deps.anchorFor(c.target)))) {
        return this.refuse(c);
      }
      was.target = now.target;
    }
    if (was.text !== now.text || was.raw !== now.raw || was.clip !== now.clip) {
      if (!(await this.deps.poster.edit(c.posted, c.text, voice))) return this.refuse(c);
      Object.assign(was, { text: now.text, raw: now.raw, clip: now.clip });
    }
  }

  private refuse(c: VoiceComment): void {
    c.refused = true;
    this.note = this.deps.refusedNote?.() ?? 'A comment could not be saved. Its words are kept.';
    this.change();
  }

  private closed(): void {
    if (this.state === 'idle') return;
    this.finish(this.state === 'stopping' ? null : 'Voice feedback lost its connection.');
  }

  private finish(note: string | null): void {
    if (this.stopTimer !== null) this.timers.clear(this.stopTimer);
    this.stopTimer = null;
    this.capture?.stop();
    this.capture = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      if (ws.readyState <= 1) ws.close(1000);
    }
    this.state = 'idle';
    this.ready = false;
    this.buffered = [];
    this.pinned = undefined;
    this.pending = '';
    for (const c of this.comments.values()) c.reopening = false;
    if (note) this.note = note;
    this.change();
  }
}
