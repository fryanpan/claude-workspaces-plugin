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
 * moves its anchor, and the frame marked final is the last. Writing through
 * the thread routes rather than having the server post means a spoken comment
 * carries the identity and sign-in of the widget that heard it, exactly as a
 * typed one does.
 *
 * No DOM here beyond the socket, so a test drives it with a fake socket, a
 * fake microphone and a recording poster (`voice-ui.ts` draws what it holds).
 */

export type SessionState = 'idle' | 'connecting' | 'recording' | 'stopping';

export interface VoiceComment {
  key: string;
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
  onLevel?: (level: number) => void;
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

  constructor(private readonly deps: VoiceSessionDeps) {}

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
    this.note = null;
    this.heard = '';
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
      ...(this.deps.onLevel ? { onLevel: this.deps.onLevel } : {}),
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
    if (!this.ready) {
      this.finish(null);
      return;
    }
    this.state = 'stopping';
    this.sendJson({ type: 'stop' });
    this.stopTimer = this.timers.set(() => this.finish(null), STOP_WAIT_MS);
    this.change();
  }

  /** The person tapped an element: the next words go there. */
  pin(target: number | null): void {
    if (this.state !== 'recording' && this.state !== 'connecting') return;
    this.pinned = target;
    this.sendJson({ type: 'pin', target });
    this.change();
  }

  /** The person moved a comment to the element they meant. */
  move(key: string, target: number | null): void {
    const c = this.comments.get(key);
    if (!c) return;
    c.target = target;
    // A settled comment is past the server's reach; its thread moves here.
    if (!c.final) this.sendJson({ type: 'move', key, target });
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
        this.change();
        return;
      case 'unavailable':
        this.finish(UNAVAILABLE[m.reason] ?? 'Voice feedback is not available here.');
        return;
      case 'heard':
        this.heard = m.text;
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
    const had = this.comments.get(f.key);
    const c: VoiceComment = had ?? {
      key: f.key,
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
    // A new comment has taken the pinned element; the pin is spent.
    if (!had && this.pinned !== undefined) this.pinned = undefined;
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
      this.sendJson({ type: 'posted', key: c.key, threadId: posted.threadId });
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
    if (note) this.note = note;
    this.change();
  }
}
