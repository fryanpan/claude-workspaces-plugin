/**
 * A voice feedback session: audio in, comments out.
 *
 * The page streams the meeting path's PCM over its own socket; this relays it
 * to the same transcription engines a meeting uses, keeps the audio and every
 * settled word beside the mock (`voice-feedback-store.ts`), and on a tick
 * hands the new words, with everything already said for the open note, to
 * the tidier (`voice-feedback-tidy.ts`), which says whether they grow that
 * note or start a new one, and which element each is about. The page posts
 * what comes back as ordinary threads, under its own identity — the socket
 * never writes a comment.
 *
 * WHEN A TICK RUNS. At a pause — `pauseMs` after the last word heard — so a
 * note is written once a thought is finished, not rewritten mid-sentence; the
 * page shows the words themselves until then (`heard.pending`). `cadenceMs`
 * is a ceiling for talk that never pauses. A tap on another element (`pin`) or
 * an earlier note (`reopen`) is a pause too: the words said before it go to
 * the old note, and the ones after wait for the new. One tick at a time.
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
import type { EngineTurn, TranscriptionEngine } from './transcribe.ts';
import type { LiveComment, Session, VoiceTimers, VoiceWs } from './voice-feedback-session.ts';
import {
  VoiceLog,
  clipPath,
  describeTarget,
  openNextSegment,
  stamp,
} from './voice-feedback-store.ts';
import {
  type TidyComment,
  type TidyComplete,
  type TidyInput,
  apportionTick,
  buildTidyPrompt,
  parseTidyReply,
  tidyDollars,
} from './voice-feedback-tidy.ts';
import { VoiceTurns } from './voice-feedback-turns.ts';

export type { VoiceTimers, VoiceWs } from './voice-feedback-session.ts';

export interface VoiceFeedbackDeps {
  engines: readonly TranscriptionEngine[];
  tidy: TidyComplete | null;
  dataDir: string;
  /** Longest a heard word waits to become a note when the talk never pauses. */
  cadenceMs?: number;
  /** How long the speaker is quiet before what they said becomes a note. */
  pauseMs?: number;
  timers?: VoiceTimers;
  /** Wall clock, for the log's section heading. */
  now?: () => number;
  log?: (line: string) => void;
}

export const VOICE_CADENCE_MS = 30_000;
/** The pause the owner approved on the mock: long enough to be a breath, not a comma. */
export const VOICE_PAUSE_MS = 1_400;
/** PCM16 mono at the meeting rate: bytes per millisecond of audio. */
const BYTES_PER_MS = (MEETING_SAMPLE_RATE * 2) / 1000;

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
      turns: new VoiceTurns(),
      comments: new Map(),
      open: null,
      pinned: undefined,
      seq: 0,
      cursorMs: 0,
      timer: null,
      since: null,
      inflight: null,
      switching: Promise.resolve(),
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
    const { settled, grew } = s.turns.update(t);
    if (settled) s.log.heardAt(this.audioMs(s), t.text.trim());
    // A frame repeated with no new word is not talk: it must not hold the pause off.
    if (grew) this.heard(s);
    if ((grew || s.timer === null) && s.turns.untaken().length > 0) this.schedule(s);
  }

  private heard(s: Session): void {
    this.send(s.ws, { type: 'heard', text: s.turns.tail(), pending: s.turns.waiting() });
  }

  /** A tick once the speaker has been quiet `pauseMs` (each word restarts it), or at the ceiling. */
  private schedule(s: Session): void {
    const now = (this.deps.now ?? Date.now)();
    s.since ??= now;
    const ms = Math.max(0, Math.min(this.pauseMs, s.since + this.cadenceMs - now));
    if (s.timer !== null) this.timers.clear(s.timer);
    s.timer = this.timers.set(() => {
      s.timer = null;
      void this.tick(s);
    }, ms);
  }

  private tick(s: Session): Promise<void> {
    if (s.inflight) return s.inflight;
    return this.run(s, s.turns.take(), this.audioMs(s));
  }

  private run(s: Session, words: string, endMs: number): Promise<void> {
    s.since = null;
    if (!words) return Promise.resolve();
    s.inflight = this.runTick(s, words, endMs).finally(() => {
      s.inflight = null;
      s.turns.done(words);
      this.next(s);
    });
    return s.inflight;
  }

  private next(s: Session): void {
    if (s.closed) return;
    this.heard(s);
    if (s.turns.untaken().length > 0) this.schedule(s);
  }

  /** A tap that changes which note the next words are for. The words said up
   *  to it, settled or not, are taken now and go to the note they were about,
   *  without the pause, however long a tidy call already out takes. */
  private switchTo(s: Session, apply: () => void): void {
    const words = s.turns.take(true);
    const endMs = this.audioMs(s);
    s.switching = s.switching
      .then(async () => {
        if (s.inflight) await s.inflight;
        await this.run(s, words, endMs);
        if (!s.closed) apply();
      })
      .catch((err) => this.deps.log?.(`[voice-feedback] switch failed: ${String(err)}`));
  }

  private async runTick(s: Session, words: string, endMs: number): Promise<void> {
    const startMs = s.cursorMs;
    s.cursorMs = endMs;
    const input: TidyInput = {
      targets: s.targets,
      open: s.open
        ? {
            text: s.open.text,
            raw: s.open.raw,
            target: s.open.target,
            fixed: s.open.fixed,
            ...(s.open.chosen ? { chosen: true } : {}),
          }
        : null,
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
    if (s.open) s.open.chosen = false;
    // No model, or no answer: the words still land, as said, where the person
    // last pointed — losing them is the one outcome this must not have.
    const grows = s.open !== null && s.pinned === undefined;
    comments ??= [
      {
        continues: grows,
        text: grows && s.open ? `${s.open.text} ${words}` : words,
        target: s.open?.target ?? null,
      },
    ];
    // Each comment gets its own stretch of the tick, so no two share a clip or
    // words, and no sentence of the next topic's rides on the one before it.
    const apportioned = apportionTick(input, comments, startMs, endMs);
    const parts = apportioned.parts;
    apportioned.comments.forEach((c, k) => {
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
    const where = describeTarget(s.targets, c.target);
    const thread = c.threadId ? ` (thread ${c.threadId})` : '';
    s.log.comment(
      c.endMs,
      `- ${stamp(c.startMs)}–${stamp(c.endMs)} Comment ${c.key}${thread} on ${where}: ${c.text}\n`,
    );
  }

  private emit(s: Session, c: LiveComment): void {
    const frame: VoiceCommentFrame = {
      type: 'comment',
      key: c.key,
      text: c.text,
      target: c.target,
      raw: c.raw,
      clip: clipPath(s.ws.data, s.segment, c.startMs, c.endMs),
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
        this.switchTo(s, () => {
          if (s.open) this.settle(s, s.open);
          s.pinned = msg.target;
        });
        return;
      case 'reopen':
        this.switchTo(s, () => this.reopen(s, msg.key));
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
        // Its thread rides on the line logged when it settles; only a comment
        // that settled before the post came back gets a line of its own.
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

  /** An earlier note of this recording opens again, for the next words. */
  private reopen(s: Session, key: string): void {
    const c = s.comments.get(key);
    if (!c || c === s.open) return;
    if (s.open) this.settle(s, s.open);
    s.pinned = undefined;
    // The person chose it by tapping it, so it stays on its element.
    Object.assign(c, { final: false, fixed: true, chosen: true });
    s.open = c;
    this.emit(s, c);
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
    // A tap made before the end still lands where it was meant.
    await s.switching;
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
