/**
 * What the board's lead says into a meeting, played aloud on the page that
 * holds the microphone.
 *
 * The lead speaks with one call (`say_in_meeting`); the server puts the line
 * in the meeting, where every page shows it, and voices it on request
 * (`voice` on `POST …/lead-chat/meeting`, PCM16 mono). Only the recorder
 * plays it, because that page is in the room: a second device playing the
 * same line would talk over the first. A bot meeting has no room here, so it
 * plays nothing.
 *
 * Lines play one after another in the order said, through the board mic's
 * player (`board/spoken-reply-audio.ts`). The microphone keeps recording
 * while one plays; its echo cancellation is what keeps the lead's voice out
 * of the transcript.
 */
import { SPOKEN_OUTPUT_RATE } from '@claude-workspaces/core/spoken-reply';
import {
  type PlaybackContext,
  type SpokenPlayer,
  createSpokenPlayer,
} from '../board/spoken-reply-audio.ts';

export interface LeadLineVoiceOpts {
  workspaceId: string;
  author: { id: string; name: string; kind?: string };
  fetch?: typeof fetch;
  playbackContext?: () => PlaybackContext | null;
  /** Line `turn` started playing. */
  onPlaying(turn: number): void;
  /** Line `turn` is over: played to its end (`said`), or not played. */
  onDone(turn: number, said: boolean): void;
}

export interface LeadLineVoice {
  /** Play line `turn` of meeting `meetingId` after any line still playing. */
  play(meetingId: string, turn: number): void;
  /** Resume the player inside a tap (Safari plays only from one). */
  wake(): void;
  stop(): void;
}

function audioContext(): PlaybackContext | null {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  try {
    return Ctor ? (new Ctor() as unknown as PlaybackContext) : null;
  } catch {
    return null;
  }
}

export function createLeadLineVoice(opts: LeadLineVoiceOpts): LeadLineVoice {
  const doFetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const url = `/workspaces/${encodeURIComponent(opts.workspaceId)}/lead-chat/meeting`;
  const player: SpokenPlayer = createSpokenPlayer({
    context: opts.playbackContext ?? audioContext,
    onFirstWord: () => {},
  });
  const queue: Array<{ meetingId: string; turn: number }> = [];
  const seen = new Set<string>();
  let busy = false;
  let stopped = false;

  async function sayOne(meetingId: string, turn: number): Promise<boolean> {
    const res = await doFetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'voice', id: meetingId, turn, author: opts.author }),
    });
    if (!res.ok || !res.body) return false;
    const rate = Number(res.headers.get('x-sample-rate')) || SPOKEN_OUTPUT_RATE;
    player.wake();
    player.begin(rate);
    opts.onPlaying(turn);
    const reader = res.body.getReader();
    // PCM16 samples are two bytes; a chunk may split one, so carry the odd byte.
    let carry: Uint8Array | null = null;
    while (!stopped) {
      const { done, value } = await reader.read();
      if (done) break;
      let bytes: Uint8Array = value;
      if (carry) {
        const joined = new Uint8Array(carry.length + bytes.length);
        joined.set(carry);
        joined.set(bytes, carry.length);
        bytes = joined;
        carry = null;
      }
      if (bytes.length % 2 === 1) {
        carry = bytes.slice(-1);
        bytes = bytes.slice(0, -1);
      }
      if (bytes.length > 0) player.push(bytes);
    }
    await new Promise<void>((resolve) => player.finish(resolve));
    return !stopped;
  }

  async function drain(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      for (let next = queue.shift(); next && !stopped; next = queue.shift()) {
        let said = false;
        try {
          said = await sayOne(next.meetingId, next.turn);
        } catch {
          // Offline, or the page went: the line still shows.
        }
        opts.onDone(next.turn, said);
      }
    } finally {
      busy = false;
    }
  }

  return {
    play(meetingId, turn) {
      const key = `${meetingId}\0${turn}`;
      if (stopped || seen.has(key)) return;
      seen.add(key);
      queue.push({ meetingId, turn });
      void drain();
    },
    wake: () => player.wake(),
    stop() {
      stopped = true;
      queue.length = 0;
      player.stop();
    },
  };
}
