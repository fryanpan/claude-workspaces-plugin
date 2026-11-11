/**
 * The lead chat voice's public shape: its state, its options and the lines it
 * says. The behaviour is `lead-chat-voice.ts`.
 */
import type { SpokenSetup } from '@claude-workspaces/core/spoken-reply';
import type {
  PlaybackContext,
  SpokenCaptureOpts,
  SpokenCaptureStart,
} from '../board/spoken-reply-audio.ts';
import type { SpokenSocket } from '../board/spoken-reply-client.ts';
import type { ListeningTab, ListeningTabOpts } from './listening-tab.ts';
import type { PageSpeechWatch } from './page-speech.ts';

export type LeadVoicePhase = 'off' | 'listening' | 'working' | 'speaking';

export interface LeadVoiceState {
  phase: LeadVoicePhase;
  /** What the listener has heard of the question so far. */
  heard: string;
  /** Why voice is not running, when it stopped by itself. */
  notice: string;
  /** Voice is on, and another of the reader's tabs hears them
   *  (`listening-tab.ts`): this one sends nothing. */
  paused: boolean;
}

export interface LeadVoiceOpts {
  workspaceId: string;
  author: { id: string; name: string; kind?: string };
  getContext(): unknown;
  /** The lead's agent id, read at each question. */
  agent(): string | undefined;
  onChange(s: LeadVoiceState): void;
  /** `GET …/voice/timings`'s setups; injected by tests. */
  fetchSetups?: () => Promise<SpokenSetup[]>;
  openSocket?: (url: string) => SpokenSocket;
  startCapture?: (opts: SpokenCaptureOpts) => Promise<SpokenCaptureStart>;
  playbackContext?: () => PlaybackContext | null;
  /** The page's origin facts; a test passes a secure one. */
  blocked?: () => string | null;
  /** Where the board mic keeps its chosen setup; omitted, this page's own. */
  storage?: Pick<Storage, 'getItem'> | null;
  /** Where a failure is reported; omitted, the page's error reporter
   *  (Sentry, where the shell loads it). */
  report?: (err: Error) => void;
  /** Which of the reader's tabs hears them; injected by tests. */
  listeningTab?: (o: ListeningTabOpts) => ListeningTab;
  /** Whether the page or a frame on it speaks, so the mic sends silence
   *  meanwhile (`page-speech.ts`); injected by tests. */
  pageSpeech?: PageSpeechWatch;
}

export interface LeadVoice {
  /** Voice on. `gesture: false` is a page carrying voice on from the page
   *  before, outside any tap; omitted, this is the reader's tap. */
  start(how?: { gesture: boolean }): void;
  /** A tap anywhere on the page: starts a context that waits for one, and
   *  says whether there was one. */
  wake(): boolean;
  stop(): void;
  state(): LeadVoiceState;
  destroy(): void;
}

export const NO_VOICE = 'Voice is not set up on this server. Type to your lead instead.';
export const NO_SOUND = 'The microphone is sending no sound. Tap the agent button to try again.';
/** How long after a dropped socket a page owed an answer opens another, and
 *  how many times. A phone waking from sleep takes a few seconds to reconnect. */
export const OWED_RETRY_MS = 2_000;
export const OWED_RETRIES = 5;
/** Said while a carried-on voice waits for the tap its context needs. */
export const TAP_TO_LISTEN = 'Tap anywhere to keep listening.';
