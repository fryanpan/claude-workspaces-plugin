/**
 * Say a reply point by point, and send each point's note just before its
 * first audio — so the written record never trails the voice.
 *
 * Each point is one call to the voice, made in turn. A point's audio is
 * forwarded the moment it arrives, so it reaches the page well ahead of
 * playback (synthesis runs faster than speech); the next point's call is
 * made while the page is still playing this one, and its connection set-up
 * is hidden behind that. The page queues the audio in order and shows each
 * note as its point starts to play.
 *
 * Wire order, per reply: `note`(0)? `audio-start` pcm… `note`(1)? pcm… `audio-end`.
 * A point whose voice sends nothing gets its note anyway, before the next
 * point, so a silent point is never a lost note.
 */
import {
  SPOKEN_OUTPUT_RATE,
  type SpokenPoint,
  type SpokenServerMessage,
} from '@claude-workspaces/core/spoken-reply';
import type { SpokenVoice } from './tts.ts';

export interface SpeakPointsDeps {
  voice: SpokenVoice;
  points: readonly SpokenPoint[];
  signal: AbortSignal;
  /** False once the turn this reply belongs to is over. */
  live(): boolean;
  sendJson(msg: SpokenServerMessage): void;
  sendAudio(pcm: Uint8Array): void;
  /** A cue already opened the audio stream (`filler-cue.ts`): continue it. */
  opened?: boolean;
}

export async function speakPoints(d: SpeakPointsDeps): Promise<void> {
  let started = d.opened === true;
  const on = (): boolean => !d.signal.aborted && d.live();
  try {
    for (let i = 0; i < d.points.length; i++) {
      if (!on()) return;
      const point = d.points[i];
      if (!point?.say) continue;
      let noted = point.note === undefined;
      const sendNote = (): void => {
        if (noted || !point.note) return;
        noted = true;
        d.sendJson({ type: 'note', point: i, text: point.note });
      };
      await d.voice.speak(
        point.say,
        (pcm) => {
          if (!on()) return;
          sendNote();
          if (!started) {
            started = true;
            d.sendJson({ type: 'audio-start', sampleRate: SPOKEN_OUTPUT_RATE });
          }
          d.sendAudio(pcm);
        },
        d.signal,
      );
      if (on()) sendNote();
    }
  } finally {
    if (started) d.sendJson({ type: 'audio-end' });
  }
}
