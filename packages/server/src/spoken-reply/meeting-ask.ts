/**
 * "Claude, …" said in a meeting recorded from the page's own microphone (or
 * microphone plus Mac audio): the same wake phrase and owner rule a Recall
 * bot meeting uses (`meeting-claude.ts`), answered through the page's
 * spoken-reply socket rather than into a call. Nothing is written into the
 * meeting's notes unless the answer holds a minute (`minuteFor`).
 *
 * WHO ASKED. A bot meeting knows each speaker's email; a mic meeting knows
 * only the page. So the speaker is the person signed in on the page that
 * opened the socket, and only when the socket's own person proof — the
 * Cloudflare Access email or the signed session cookie, never a display
 * name, a body's claim, a widget token or an agent token — resolves to an
 * owner id (`isOwnerActor({ id })`, the check the grant door makes). That is
 * decided once, at the upgrade (`routes/upgrade-stream.ts`), and arrives
 * here as `owner`.
 *
 * WHOSE WORDS. A Mac-audio meeting also carries everybody dialled in, on the
 * `system` stream. Those words can never form a request: `own` holds only
 * what the page's microphone heard, and the wake phrase is looked for there.
 *
 * Fails closed like the bot path: no wake phrase, or not the owner, and
 * nothing is said or written.
 *
 * IN A PLANNING MEETING, "Claude, any questions?" is the planning voice's.
 * Asking the meeting's own assistant for its questions is asking for the
 * plan's open ones, so it goes to the interview as an invitation
 * (`SpokenAnswerer.invite`), never to the board router, which answered
 * Bryan's with a board status brief. Any other "Claude, …" still goes to the
 * router, and a discussion meeting is unchanged.
 *
 * SAID SHORT. Whoever answers — the router, the lead, the planning voice —
 * the meeting hears one sentence of at most `MEETING_SPOKEN_MAX_WORDS`
 * words (`meetingLine`).
 *
 * ASKED WITH THE MEETING. The router and the lead get the meeting's notes and
 * the room's last two minutes with the request (`MeetingRoom.recent`), so
 * "do you have enough to create tasks?" is about this meeting. Anyone in the
 * room can speak, so both are fenced as untrusted content.
 *
 * ANYTHING A SESSION CAN DO. A "Claude, …" is not narrowed to lookups here:
 * the router decides, and what it hands to the lead ("On it.") is worked on
 * while the meeting goes on, its answer said at a later pause
 * (`meeting-errands.ts`).
 */
import { meetingLine, minuteFor, wakeRequest } from '../meeting-claude.ts';
import type { TranscriptionEngine } from '../transcribe.ts';
import type { VoiceActor } from '../voice-action.ts';
import type { MeetingContext } from '../voice-meeting-context.ts';
import type { VoiceContext } from '../voice-prompt.ts';
import type { SpokenAnswer, SpokenAnswerer } from './answer.ts';
import { asksForQuestions } from './interview-phrases.ts';

/** A meeting recording on a doc, as a spoken-reply socket may hear it. */
export interface MeetingRoom {
  /** The meeting's transcript, as a listener (`MeetingEars.engine`). */
  engine: TranscriptionEngine;
  /** A planning meeting: the planning voice asks at its pauses. */
  plan: boolean;
  /** Writes a minute into this meeting: its notes section, or in a plan the
   *  section `about` (what was asked) names (`plan-minutes.ts`). */
  note(markdown: string, about?: string): void;
  /** The meeting's notes and the speech before now, which a "Claude, …" is
   *  asked with (`voice-meeting-context.ts`). Untrusted. */
  recent?(): MeetingContext | undefined;
}

/** One pause's worth of a meeting, as the answer needs it. */
export interface MeetingTurn {
  room: MeetingRoom;
  /** The socket's person proof names the owner. */
  owner: boolean;
  /** What the page's own microphone heard this turn. */
  own: string;
}

/** A wake phrase opening the turn or any sentence in it. */
const SENTENCE_WAKE = /(?:^|[.!?]\s+)((?:(?:hey|hi|ok|okay|so)[\s,]+)?claude\s*[,.!?:;–—-])/gi;

/** The request after the first wake phrase that opens a sentence, or null. */
export function wakeRequestIn(text: string): string | null {
  for (const m of text.matchAll(SENTENCE_WAKE)) {
    const at = (m.index ?? 0) + m[0].length - (m[1]?.length ?? 0);
    const ask = wakeRequest(text.slice(at));
    if (ask !== null) return ask;
  }
  return null;
}

/** A meeting's answer; `request` is what was asked when the lead took it. */
export interface MeetingAnswer extends SpokenAnswer {
  request?: string;
}

export const SILENT: SpokenAnswer = {
  spoken: '',
  points: [],
  detail: [],
  asking: false,
  route: 'none',
};

/**
 * The answer to one pause of a meeting: Claude's, when the owner called it
 * on the page's microphone; else the planning voice's, in a plan; else
 * nothing.
 */
export async function meetingAnswer(
  answerer: SpokenAnswerer,
  heard: string,
  actor: VoiceActor,
  context: VoiceContext | undefined,
  turn: MeetingTurn,
): Promise<MeetingAnswer> {
  const request = turn.owner ? wakeRequestIn(turn.own) : null;
  if (request !== null && turn.room.plan && asksForQuestions(request)) {
    return meetingLine(await answerer.invite(heard, actor, context));
  }
  if (request !== null) {
    // No `navigate`: following it would take the page off the meeting it
    // is recording.
    const { navigate: _, ...a } = await answerer.ask(request, actor, context, turn.room.recent?.());
    // Handed to the lead, nothing is said until it answers: the lead's
    // minute, if it gives one, is written when it comes (`meeting-errands.ts`).
    if (a.awaiting) return { ...a, asking: false, request };
    if (!a.spoken) return SILENT;
    const minute = minuteFor(a);
    if (minute) turn.room.note(minute, request);
    return { ...meetingLine(a), asking: false };
  }
  return turn.room.plan ? meetingLine(await answerer.answer(heard, actor, context, true)) : SILENT;
}
