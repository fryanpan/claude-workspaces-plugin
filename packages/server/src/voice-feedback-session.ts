/**
 * The state of one voice feedback session, as the relay
 * (`voice-feedback-relay.ts`) keeps it: the socket, the recording, the words
 * heard (`voice-feedback-turns.ts`) and the notes made from them. Types only;
 * the relay's tests drive every field.
 */
import type { VoiceTarget } from '@claude-workspaces/core';
import type { TranscriptionSession } from './transcribe.ts';
import type { VoiceLog, WavWriter } from './voice-feedback-store.ts';
import type { VoiceTurns } from './voice-feedback-turns.ts';

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

export interface LiveComment {
  key: string;
  text: string;
  target: number | null;
  raw: string;
  startMs: number;
  endMs: number;
  fixed: boolean;
  final: boolean;
  /** Tapped to add to, and no tick has grown it since. */
  chosen?: boolean;
  /** The thread the page posted it as, once the page says. */
  threadId?: string;
}

export interface Session {
  ws: VoiceWs;
  engine: TranscriptionSession | null;
  wav: WavWriter;
  log: VoiceLog;
  segment: number;
  targets: VoiceTarget[];
  turns: VoiceTurns;
  comments: Map<string, LiveComment>;
  open: LiveComment | null;
  pinned: number | null | undefined;
  seq: number;
  /** Audio position (ms) where the words not yet ticked begin. */
  cursorMs: number;
  timer: unknown;
  /** When the oldest word no tick has taken was heard; null when none waits. */
  since: number | null;
  /** The tick in flight, if any — one at a time. */
  inflight: Promise<void> | null;
  /** Taps waiting on the words before them to be folded, in order. */
  switching: Promise<void>;
  /** The one ending: a Stop and a close that race share it. */
  ending: Promise<void> | null;
  closed: boolean;
  usd: number;
  ticks: number;
}
