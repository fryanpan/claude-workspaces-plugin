/**
 * A voice feedback session: audio in, comments out.
 *
 * The page streams the meeting path's PCM over its own socket; this relays it
 * to the same transcription engines a meeting uses, keeps the audio and every
 * settled word beside the mock (`voice-feedback-store.ts`), and on a tick
 * hands the new words to the tidier (`voice-feedback-tidy.ts`), which says
 * whether they grow the open comment or start a new one, and which element
 * each is about. The page posts what comes back as ordinary threads, under
 * its own identity — the socket never writes a comment.
 *
 * WHEN A TICK RUNS. Words land within `cadenceMs` of the first one heard, and
 * sooner at a pause: an engine that settles a turn has heard the speaker
 * stop, and `pauseMs` after that is a tick. One tick at a time; words heard
 * during a tick wait for the next.
 *
 * WHO MAY OPEN ONE. The upgrade refuses share visitors outright, because a
 * session spends a transcription engine and the model on the owner's keys;
 * a page that could not sign in to write arrives `readOnly` and is told so.
 */
import {
  MAX_VOICE_RAW,
  MEETING_SAMPLE_RATE,
  type VoiceClientMessage,
  type VoiceCommentFrame,
  type VoiceServerMessage,
  type VoiceTarget,
  parseVoiceClientMessage,
} from '@claude-workspaces/core';
import type { EngineTurn, TranscriptionEngine, TranscriptionSession } from './transcribe.ts';
import { VoiceLog, type WavWriter, openNextSegment, stamp } from './voice-feedback-store.ts';
import {
  type TidyComment,
  type TidyComplete,
  type TidyInput,
  buildTidyPrompt,
  normWord,
  parseTidyReply,
  splitTick,
  tidyDollars,
  unusedWords,
} from './voice-feedback-tidy.ts';

/** The slice of a Bun `ServerWebSocket` this module needs. */
export interface VoiceWs {
  data: { docId: string; workspaceId?: string; readOnly?: boolean };
  send(payload: string): void;
  close(code?: number, reason?: string): void;
}

export interface VoiceTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface VoiceFeedbackDeps {
  engines: readonly TranscriptionEngine[];
  tidy: TidyComplete | null;
  dataDir: string;
  /** Longest a heard word waits to become a comment. */
  cadenceMs?: number;
  /** How long after a settled turn the tick runs. */
  pauseMs?: number;
  timers?: VoiceTimers;
  /** Wall clock, for the log's section heading. */
  now?: () => number;
  log?: (line: string) => void;
}

export const VOICE_CADENCE_MS = 8_000;
export const VOICE_PAUSE_MS = 600;
/** PCM16 mono at the meeting rate: bytes per millisecond of audio. */
const BYTES_PER_MS = (MEETING_SAMPLE_RATE * 2) / 1000;

interface Turn {
  text: string;
  final: boolean;
  settled: string;
  /** Normalised words of this turn already handed to a tick. */
  used: string[];
}

interface LiveComment {
  key: string;
  text: string;
  target: number | null;
  raw: string;
  startMs: number;
  endMs: number;
  fixed: boolean;
  final: boolean;
  /** The thread the page posted it as, once the page says. */
  threadId?: string;
}

interface Session {
  ws: VoiceWs;
  engine: TranscriptionSession | null;
  wav: WavWriter;
  log: VoiceLog;
  segment: number;
  targets: VoiceTarget[];
  turns: Map<number, Turn>;
  comments: Map<string, LiveComment>;
  open: LiveComment | null;
  pinned: number | null | undefined;
  seq: number;
  /** Audio position (ms) where the words not yet ticked begin. */
  cursorMs: number;
  timer: unknown;
  due: number;
  /** The tick in flight, if any — one at a time. */
  inflight: Promise<void> | null;
  /** The one ending: a Stop and a close that race share it. */
  ending: Promise<void> | null;
  closed: boolean;
  usd: number;
  ticks: number;
}

export class VoiceFeedbackRelay {
  private readonly sessions = new WeakMap<VoiceWs, Session>();
  private readonly live = new Set<Session>();
  private readonly timers: VoiceTimers;
  private readonly cadenceMs: number;
  private readonly pauseMs: number;

  constructor(private readonly deps: VoiceFeedbackDeps) {
    this.timers = deps.timers ?? {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    this.cadenceMs = deps.cadenceMs ?? VOICE_CADENCE_MS;
    this.pauseMs = deps.pauseMs ?? VOICE_PAUSE_MS;
  }

  private send(ws: VoiceWs, msg: VoiceServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // A socket that closed mid-send has its close handler coming.
    }
  }

  onText(ws: VoiceWs, raw: string): void {
    const msg = parseVoiceClientMessage(raw);
    if (!msg) {
      this.send(ws, { type: 'error', message: 'unreadable frame' });
      return;
    }
    const s = this.sessions.get(ws);
    if (msg.type === 'start') {
      if (!s) void this.start(ws, msg.targets);
      return;
    }
    if (!s || s.closed) return;
    this.apply(s, msg);
  }

  onAudio(ws: VoiceWs, pcm: Uint8Array): void {
    const s = this.sessions.get(ws);
    if (!s || s.closed || s.ending) return;
    s.wav.write(pcm);
    s.engine?.send(pcm);
  }

  onClose(ws: VoiceWs): void {
    const s = this.sessions.get(ws);
    if (s) void this.finish(s, false);
  }

  /** Every open session, ended. Awaited by the server's shutdown. */
  async dispose(): Promise<void> {
    await Promise.all([...this.live].map((s) => this.finish(s, false)));
  }

  private async start(ws: VoiceWs, targets: VoiceTarget[]): Promise<void> {
    if (ws.data.readOnly) {
      this.send(ws, { type: 'unavailable', reason: 'sign_in_required' });
      return;
    }
    const engine = this.deps.engines[0];
    if (!engine) {
      this.send(ws, { type: 'unavailable', reason: 'not_configured' });
      return;
    }
    const { dataDir } = this.deps;
    const { docId } = ws.data;
    const { segment, wav } = openNextSegment(dataDir, docId, MEETING_SAMPLE_RATE);
    const s: Session = {
      ws,
      engine: null,
      wav,
      log: new VoiceLog(dataDir, docId),
      segment,
      targets,
      turns: new Map(),
      comments: new Map(),
      open: null,
      pinned: undefined,
      seq: 0,
      cursorMs: 0,
      timer: null,
      due: 0,
      inflight: null,
      ending: null,
      closed: false,
      usd: 0,
      ticks: 0,
    };
    // Registered before the engine opens, so audio sent during the handshake
    // lands in the recording; the engine hears from its first frame on.
    this.sessions.set(ws, s);
    this.live.add(s);
    const at = new Date((this.deps.now ?? Date.now)()).toISOString();
    s.log.write(`\n## Recording ${segment} — ${at}\n\nAudio: seg-${segment}.wav\n\n`);
    try {
      s.engine = await engine.open({
        sampleRate: MEETING_SAMPLE_RATE,
        detectSpeakers: false,
        onTurn: (turn) => this.onTurn(s, turn),
        onError: (message) => this.send(ws, { type: 'error', message }),
      });
    } catch (err) {
      this.deps.log?.(`[voice-feedback] engine failed to open: ${String(err)}`);
      this.send(ws, { type: 'unavailable', reason: 'engine_failed' });
      await this.finish(s, false);
      return;
    }
    if (s.closed) {
      void s.engine.close();
      return;
    }
    this.send(ws, { type: 'ready', segment });
  }

  private audioMs(s: Session): number {
    return s.wav.bytes / BYTES_PER_MS;
  }

  private onTurn(s: Session, t: EngineTurn): void {
    const prev = s.turns.get(t.turn);
    const turn: Turn = {
      text: t.text,
      final: t.final,
      settled: t.final ? t.text : (t.settledText ?? ''),
      used: prev?.used ?? [],
    };
    s.turns.set(t.turn, turn);
    if (t.final && t.text.trim() && !prev?.final) {
      s.log.heardAt(this.audioMs(s), t.text.trim());
    }
    const tail = [...s.turns.values()]
      .map((x) => x.text)
      .join(' ')
      .slice(-240);
    this.send(s.ws, { type: 'heard', text: tail });
    if (this.pending(s).length > 0) {
      this.schedule(s, t.final ? this.pauseMs : this.cadenceMs);
    }
  }

  /** Words settled by the engine that no tick has taken yet, in order. */
  private pending(s: Session): string[] {
    const out: string[] = [];
    for (const turn of s.turns.values()) {
      out.push(...unusedWords(turn.settled.split(/\s+/).filter(Boolean), turn.used));
    }
    return out;
  }

  /** Run a tick in `ms`, unless one is already due sooner. The cadence is
   *  counted from the FIRST waiting word, so steady talk cannot push it. */
  private schedule(s: Session, ms: number): void {
    const due = (this.deps.now ?? Date.now)() + ms;
    if (s.timer !== null && s.due <= due) return;
    if (s.timer !== null) this.timers.clear(s.timer);
    s.due = due;
    s.timer = this.timers.set(() => {
      s.timer = null;
      void this.tick(s);
    }, ms);
  }

  private take(s: Session): string {
    const words: string[] = [];
    for (const turn of s.turns.values()) {
      const all = turn.settled.split(/\s+/).filter(Boolean);
      const fresh = unusedWords(all, turn.used);
      words.push(...fresh);
      turn.used = all.map(normWord);
    }
    return words.join(' ');
  }

  private tick(s: Session): Promise<void> {
    if (s.inflight) return s.inflight;
    const words = this.take(s);
    if (!words) return Promise.resolve();
    s.inflight = this.runTick(s, words).finally(() => {
      s.inflight = null;
      if (!s.closed && this.pending(s).length > 0) this.schedule(s, this.pauseMs);
    });
    return s.inflight;
  }

  private async runTick(s: Session, words: string): Promise<void> {
    const startMs = s.cursorMs;
    const endMs = this.audioMs(s);
    s.cursorMs = endMs;
    const input: TidyInput = {
      targets: s.targets,
      open: s.open ? { text: s.open.text, target: s.open.target, fixed: s.open.fixed } : null,
      ...(s.pinned !== undefined ? { pinned: s.pinned } : {}),
      words,
    };
    let comments: TidyComment[] | null = null;
    if (this.deps.tidy) {
      try {
        const reply = await this.deps.tidy(buildTidyPrompt(input));
        s.usd += tidyDollars(reply.usage);
        comments = parseTidyReply(reply.text, input);
      } catch (err) {
        this.deps.log?.(`[voice-feedback] tidy failed: ${String(err)}`);
      }
    }
    s.ticks++;
    // No model, or no answer: the words still land, as said, where the
    // person last pointed. Losing them is the one outcome this must not have.
    comments ??= [
      {
        continues: s.open !== null && s.pinned === undefined,
        text: words,
        target: s.open?.target ?? null,
      },
    ];
    // Each comment gets its own stretch of the tick, so no two share a clip or words.
    const parts = splitTick(words, comments, startMs, endMs);
    comments.forEach((c, k) => {
      const p = parts[k];
      if (p) this.place(s, c, p.words, p.startMs, p.endMs);
    });
  }

  private place(s: Session, c: TidyComment, words: string, startMs: number, endMs: number): void {
    const open = s.open;
    if (c.continues && open && s.pinned === undefined) {
      open.text = c.text;
      if (!open.fixed) open.target = c.target;
      open.raw = `${open.raw} ${words}`.trim().slice(-MAX_VOICE_RAW);
      open.endMs = endMs;
      this.emit(s, open);
      return;
    }
    if (open) this.settle(s, open);
    const pinned = s.pinned;
    s.pinned = undefined;
    const next: LiveComment = {
      key: `v${++s.seq}`,
      text: c.text,
      target: pinned !== undefined ? pinned : c.target,
      raw: words.slice(-MAX_VOICE_RAW),
      startMs,
      endMs,
      fixed: pinned !== undefined,
      final: false,
    };
    s.comments.set(next.key, next);
    s.open = next;
    this.emit(s, next);
  }

  private settle(s: Session, c: LiveComment): void {
    if (c.final) return;
    c.final = true;
    if (s.open === c) s.open = null;
    this.emit(s, c);
    const where = c.target === null ? 'the page' : this.describe(s, c.target);
    const thread = c.threadId ? ` (thread ${c.threadId})` : '';
    s.log.comment(
      c.endMs,
      `- ${stamp(c.startMs)}–${stamp(c.endMs)} Comment ${c.key}${thread} on ${where}: ${c.text}\n`,
    );
  }

  private describe(s: Session, i: number): string {
    const t = s.targets.find((x) => x.i === i);
    if (!t) return `element ${i}`;
    return `${t.tag}${t.text ? ` “${t.text.slice(0, 40)}”` : t.hint ? ` ${t.hint}` : ''}`;
  }

  private clip(s: Session, c: LiveComment): string {
    const ws = encodeURIComponent(s.ws.data.workspaceId ?? '');
    const doc = encodeURIComponent(s.ws.data.docId);
    const sec = (ms: number) => (Math.round(ms / 100) / 10).toFixed(1);
    return `/workspaces/${ws}/docs/${doc}/voice-feedback/seg-${s.segment}.wav#t=${sec(c.startMs)},${sec(c.endMs)}`;
  }

  private emit(s: Session, c: LiveComment): void {
    const frame: VoiceCommentFrame = {
      type: 'comment',
      key: c.key,
      text: c.text,
      target: c.target,
      raw: c.raw,
      clip: this.clip(s, c),
      final: c.final,
    };
    this.send(s.ws, frame);
  }

  private apply(s: Session, msg: Exclude<VoiceClientMessage, { type: 'start' }>): void {
    switch (msg.type) {
      case 'targets':
        s.targets = msg.targets;
        return;
      case 'pin':
        // The next words go to the tapped element: whatever was open is done.
        if (s.open) this.settle(s, s.open);
        s.pinned = msg.target;
        return;
      case 'move': {
        const c = s.comments.get(msg.key);
        if (!c) return;
        c.target = msg.target;
        c.fixed = true;
        this.emit(s, c);
        return;
      }
      case 'posted': {
        // A comment is posted on its first words and logged when it settles,
        // so its thread rides on that line; only a comment that settled before
        // the post came back gets a line of its own.
        const c = s.comments.get(msg.key);
        if (c && !c.final) {
          c.threadId = msg.threadId;
          return;
        }
        s.log.write(`- Comment ${msg.key} posted as thread ${msg.threadId}\n`);
        return;
      }
      case 'stop':
        void this.finish(s, true);
        return;
    }
  }

  /**
   * End a session. With `flush`, the engine's last turn and one more tick run
   * first, so the sentence being said when Stop was pressed still becomes a
   * comment — the sentence most likely to matter.
   */
  private finish(s: Session, flush: boolean): Promise<void> {
    s.ending ??= this.end(s, flush);
    return s.ending;
  }

  private async end(s: Session, flush: boolean): Promise<void> {
    if (!flush) {
      // A tidy call already under way still becomes a settled, logged comment.
      if (s.timer !== null) this.timers.clear(s.timer);
      if (s.inflight) await s.inflight;
    }
    if (flush && s.engine) {
      await s.engine.close();
      if (s.timer !== null) this.timers.clear(s.timer);
      s.timer = null;
      if (s.inflight) await s.inflight;
      await this.tick(s);
    }
    s.closed = true;
    if (s.timer !== null) this.timers.clear(s.timer);
    if (s.open) this.settle(s, s.open);
    if (!flush) void s.engine?.close();
    s.wav.close();
    this.live.delete(s);
    const secs = Math.round(this.audioMs(s) / 1000);
    s.log.flush();
    s.log.write(
      `\n_Recording ${s.segment} ended at ${stamp(this.audioMs(s))}; ${s.ticks} tidy calls, $${s.usd.toFixed(4)}._\n`,
    );
    this.deps.log?.(
      `[voice-feedback] ${s.ws.data.docId} seg-${s.segment}: ${secs}s audio, ${s.ticks} ticks, $${s.usd.toFixed(4)} model`,
    );
    if (flush) {
      this.send(s.ws, { type: 'stopped' });
      s.ws.close(1000, 'stopped');
    }
  }
}
