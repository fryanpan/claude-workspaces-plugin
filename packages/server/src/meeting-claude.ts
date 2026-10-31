/**
 * "Claude, …" said in a bot meeting: a one-line spoken answer into the call,
 * and a minute in the meeting's notes only when the answer is worth keeping
 * (`minuteFor`).
 *
 * Two rules decide whether anything happens, and both fail closed:
 *
 *  - THE WAKE PHRASE opens the utterance: "Claude," or "Hey Claude," with a
 *    pause mark after it, then the request. The transcriber writes the pause
 *    as a comma, so "Claude's notes say…", "Claudia, …" and "Cloud, …" are
 *    not addressed to anyone, and neither is "Claude" said mid-sentence.
 *  - THE OWNER ASKS. A speaker is the owner only when Recall's participant
 *    email matches the server's owner email (`CW_OWNER_EMAIL`). A display
 *    name never counts: anyone in a call can rename themselves, and two
 *    people can share a name. No email on the participant, or no owner email
 *    configured, is silence.
 *
 * Claude never speaks unprompted, so a final turn that fails either rule
 * returns before anything is read, and nothing here runs on a timer.
 *
 * The answer comes from the board's own answerer (`spoken-reply/answer.ts`),
 * the one setups 1 to 4 use, so a meeting hears what the board mic would
 * say. Only its first sentence is said, in at most `MEETING_SPOKEN_MAX_WORDS`
 * words. A minute is written before the voice is tried, so a voice that
 * fails still leaves it.
 *
 * Asked as a page's microphone meeting asks (`spoken-reply/meeting-ask.ts`):
 * with the meeting doc's notes and what the call said in the two minutes
 * before the request (`voice-meeting-context.ts`), fenced as untrusted. What
 * the router hands to the lead is acknowledged ("On it.") and the lead's
 * answer is said into the call when it arrives, once the bot is not already
 * speaking, with its minute written by the same `minuteFor` rule
 * (`spoken-reply/meeting-errands.ts`). In a planning meeting either minute
 * goes under the plan section the request names (`spoken-reply/plan-minutes.ts`).
 */
import type { RecallClient } from './recall.ts';
import { type SpokenAnswer, SpokenAnswerer, type SpokenBoard } from './spoken-reply/answer.ts';
import { INTERVIEW_ROUTE } from './spoken-reply/interview.ts';
import { LEAD_MINUTE_MAX, type LeadAnswers } from './spoken-reply/lead-answer.ts';
import { MeetingErrands } from './spoken-reply/meeting-errands.ts';
import { sentences } from './spoken-reply/reply-shape.ts';
import type { SpokenVoice } from './spoken-reply/tts.ts';
import type { VoiceActor } from './voice-action.ts';
import { MEETING_HEARD_MS, meetingContext } from './voice-meeting-context.ts';
import { AGENT_ACK } from './voice-quick.ts';

/** A meeting participant, as far as this decision needs one. */
export interface MeetingSpeaker {
  name: string | null;
  email: string | null;
}

/** One settled utterance, and where an answer to it would go. */
export interface MeetingUtterance {
  docId: string;
  botId: string;
  speaker: MeetingSpeaker;
  text: string;
  /** Writes lines into this meeting's own notes section. */
  note(markdown: string): void;
}

export type MeetingClaudeVerdict =
  | 'not-addressed'
  | 'not-owner'
  /** An answer to this bot is still being said; this request is dropped. */
  | 'busy'
  | 'answered';

export interface MeetingClaudeDeps {
  /** The owner's email. Empty or null means nobody may ask. */
  ownerEmail: string | null;
  /** The answerer for the board holding this doc; null when none does. */
  answererFor(docId: string): SpokenAnswerer | null;
  /** Who the owner is to the board, for anything the answer changes. */
  actor(speaker: MeetingSpeaker): VoiceActor;
  /** Says text as MP3, which is the one format Recall plays. Null: notes only. */
  voice: SpokenVoice | null;
  /** Plays MP3 into the call (`RecallClient.outputAudio`). */
  play(botId: string, mp3: Uint8Array): Promise<void>;
  /** Writes a minute into a planning meeting's plan, under the section
   *  `about` names; false, or absent, and it goes to the notes. */
  planMinute?(docId: string, markdown: string, about: string): boolean;
  /** The meeting doc's text as it stands, which a request is asked with. */
  notesOf?(docId: string): string | null;
  /** Where the lead's answers to requests it took are waited for; absent,
   *  only the ack is said. */
  lead?: { answers: LeadAnswers; boardOf(docId: string): string | undefined };
  now?: () => number;
  log?: (line: string) => void;
}

/** One bot's call, as far as answering in it goes. */
interface BotCall {
  /** Made on the first request, so "which goal?" is answered in the same call. */
  answerer?: SpokenAnswerer | null;
  /** Final turns, oldest first, kept for `MEETING_HEARD_MS`. */
  said: Array<{ at: number; line: string }>;
  /** Requests out with the lead, and their answers waiting to be said. */
  errands: MeetingErrands;
  /** The latest utterance's way into the notes, for a lead's minute. */
  note(markdown: string): void;
}

/** The pause mark the transcriber writes after a name being called. */
const WAKE = /^(?:(?:hey|hi|ok|okay|so)[\s,]+)?claude\s*[,.!?:;–—-]+\s*(\S[\s\S]*)$/i;

/** The request after the wake phrase, or null when nobody called Claude. */
export function wakeRequest(text: string): string | null {
  const m = text.trim().match(WAKE);
  const ask = m?.[1]?.trim();
  return ask ? ask : null;
}

/** Whether this speaker is the owner. Fails closed: no email is no. */
export function isOwner(speaker: MeetingSpeaker, ownerEmail: string | null): boolean {
  const want = ownerEmail?.trim().toLowerCase();
  const have = speaker.email?.trim().toLowerCase();
  return Boolean(want) && want === have;
}

/** At most this many words are said aloud. Voice is slower than reading, so a
 *  meeting hears the shortest answer that works (Bryan, 3 Oct: "saying a full
 *  sentence when you could just say 'no' is a waste of my time"). */
export const MEETING_SPOKEN_MAX_WORDS = 20;

/** A step label a question is read after ("Next: …"), not worth saying. */
const LABEL = /^(?:first|next|then)\s*:\s*/i;

/** The one line said into the meeting: its first sentence, cut at the word
 *  cap. The planning voice's reply is the exception: "Written under Work.
 *  Next: who signs off?" is said as its question, which is the part that
 *  needs an answer. */
export function spokenLine(a: SpokenAnswer): string {
  const all = sentences(a.points.map((p) => p.say).join(' ') || a.spoken);
  const asked = a.route === INTERVIEW_ROUTE ? all.find((s) => s.endsWith('?')) : undefined;
  const line = (asked ?? all[0] ?? '').replace(LABEL, '');
  const words = line.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= MEETING_SPOKEN_MAX_WORDS) return words.join(' ');
  return `${words.slice(0, MEETING_SPOKEN_MAX_WORDS).join(' ')}…`;
}

/** `a` as a meeting says it: one line, one point. */
export function meetingLine<T extends SpokenAnswer>(a: T): T {
  if (!a.spoken) return a;
  const line = spokenLine(a);
  return { ...a, spoken: line, points: [{ say: line }] };
}

/**
 * The line a "Claude, …" leaves in the meeting's notes, or null for none —
 * which is the default (Bryan, 3 Oct: a request and Claude's reply do not
 * belong in the notes). An answer is minuted only when it holds something to
 * keep for future reference: a decision, a fact found or tasks created, named
 * by the lead in its answer (`answer_voice`'s `minute`), or a change the board
 * made itself (`notes.ts`). The line is the minute alone, never the exchange,
 * on one line so it is one block of its own.
 */
export function minuteFor(a: SpokenAnswer): string | null {
  const minute =
    a.minute ??
    (a.route === 'fast-path-action'
      ? a.points.flatMap((p) => (p.note ? [p.note] : [])).join('; ')
      : '');
  const line = minute.replace(/\s+/g, ' ').trim().slice(0, LEAD_MINUTE_MAX);
  return line ? `- Claude: ${line}` : null;
}

export class MeetingClaude {
  /** Bots saying an answer now. A second request waits for none. */
  private readonly speaking = new Set<string>();
  private readonly calls = new Map<string, BotCall>();

  constructor(private readonly deps: MeetingClaudeDeps) {}

  /** Whether a bot should be created able to play audio. */
  get speaks(): boolean {
    return this.deps.voice !== null;
  }

  /** A settled utterance. Resolves once the answer is noted and said. */
  async heard(u: MeetingUtterance): Promise<MeetingClaudeVerdict> {
    const call = this.call(u);
    const before = this.recent(call);
    this.remember(call, u);
    const request = wakeRequest(u.text);
    if (request === null) return 'not-addressed';
    if (!isOwner(u.speaker, this.deps.ownerEmail)) return 'not-owner';
    if (this.speaking.has(u.botId)) return 'busy';
    this.speaking.add(u.botId);
    call.note = u.note;
    try {
      await this.answer(u, call, request, before);
    } catch (err) {
      this.fail(u.docId, err);
    } finally {
      this.speaking.delete(u.botId);
    }
    await this.sayHeld(u.botId, call, u.docId);
    return 'answered';
  }

  /** The bot left: its pending question and its waits for the lead go with it. */
  forget(botId: string): void {
    const call = this.calls.get(botId);
    if (call) this.deps.lead?.answers.drop(call);
    this.calls.delete(botId);
    this.speaking.delete(botId);
  }

  private call(u: MeetingUtterance): BotCall {
    let call = this.calls.get(u.botId);
    if (!call) {
      call = { said: [], errands: new MeetingErrands(), note: u.note };
      this.calls.set(u.botId, call);
    }
    return call;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private remember(call: BotCall, u: MeetingUtterance): void {
    const text = u.text.trim();
    const at = this.now();
    call.said = call.said.filter((s) => at - s.at <= MEETING_HEARD_MS);
    if (text) call.said.push({ at, line: u.speaker.name ? `${u.speaker.name}: ${text}` : text });
  }

  /** What the call said in the `MEETING_HEARD_MS` before now. */
  private recent(call: BotCall): string {
    const at = this.now();
    return call.said
      .filter((s) => at - s.at <= MEETING_HEARD_MS)
      .map((s) => s.line)
      .join('\n');
  }

  private async answer(
    u: MeetingUtterance,
    call: BotCall,
    request: string,
    before: string,
  ): Promise<void> {
    if (call.answerer === undefined) call.answerer = this.deps.answererFor(u.docId);
    const answerer = call.answerer;
    const context = meetingContext(this.deps.notesOf?.(u.docId), before);
    const a: SpokenAnswer = answerer
      ? await answerer.ask(request, this.deps.actor(u.speaker), undefined, context)
      : {
          spoken: 'This meeting is not on a board, so I have nothing to look up.',
          points: [{ say: 'This meeting is not on a board, so I have nothing to look up.' }],
          detail: [],
          asking: false,
          route: 'none',
        };
    if (a.awaiting) {
      // The lead took it. A call has no page to show it working, so the bot
      // says the ack; the lead's minute, if it gives one, is written when
      // its answer comes.
      this.awaitLead(u, call, a.awaiting, request);
      await this.say(u.botId, a.spoken ? spokenLine(a) : AGENT_ACK);
      return;
    }
    if (!a.spoken) return;
    const minute = minuteFor(a);
    if (minute) this.minute(u.docId, call, minute, request);
    await this.say(u.botId, spokenLine(a));
  }

  private awaitLead(u: MeetingUtterance, call: BotCall, queueId: string, request: string): void {
    const lead = this.deps.lead;
    const workspaceId = lead?.boardOf(u.docId);
    if (!lead || !workspaceId) return;
    call.errands.started(queueId, request);
    lead.answers.wait(workspaceId, queueId, call, (a) => {
      const done = this.calls.get(u.botId) === call ? call.errands.answered(queueId, a) : null;
      if (!done) return;
      if (done.note) this.minute(u.docId, call, done.note, done.about);
      void this.sayHeld(u.botId, call, u.docId);
    });
  }

  private minute(docId: string, call: BotCall, markdown: string, about: string): void {
    if (!this.deps.planMinute?.(docId, markdown, about)) call.note(markdown);
  }

  /** The lead's answers that came in, said while nothing else is. */
  private async sayHeld(botId: string, call: BotCall, docId: string): Promise<void> {
    while (call.errands.waiting && !this.speaking.has(botId) && this.calls.get(botId) === call) {
      this.speaking.add(botId);
      try {
        for (const h of call.errands.take()) await this.say(botId, h.spoken);
      } catch (err) {
        this.fail(docId, err);
      } finally {
        this.speaking.delete(botId);
      }
    }
  }

  private async say(botId: string, line: string): Promise<void> {
    const voice = this.deps.voice;
    if (!voice || !line) return;
    const chunks: Uint8Array[] = [];
    await voice.speak(line, (b) => chunks.push(b), new AbortController().signal);
    const mp3 = Buffer.concat(chunks);
    if (mp3.length === 0) return;
    await this.deps.play(botId, new Uint8Array(mp3));
  }

  private fail(docId: string, err: unknown): void {
    this.deps.log?.(
      `[meeting-claude] ${docId}: ${err instanceof Error ? err.message : 'answer failed'}`,
    );
  }
}

/**
 * The server's one meeting Claude, or null when it is off: switched off
 * (`CW_MEETING_CLAUDE=0`), no owner email to recognise the owner by, or no
 * Recall client to play through. Says which in one line, so a silent
 * meeting can be told from a disabled one in the log.
 */
export function createMeetingClaude(o: {
  enabled: boolean;
  ownerEmail: string | undefined;
  client: RecallClient | null;
  voice: SpokenVoice | null;
  /** Read at answer time: the board router is built after the relay. */
  board: () => SpokenBoard;
  boardOf: (docId: string) => string | undefined;
  ownerId: () => string;
  /** The meeting doc's text, asked with each request. */
  notesOf?: (docId: string) => string | null;
  /** The waits the spoken-reply sockets share, so a lead answers one route. */
  leads?: LeadAnswers;
  /** A planning meeting's minutes, placed in the plan (`PlanMinutes.place`). */
  planMinute?: (docId: string, markdown: string, about: string) => boolean;
  log?: (line: string) => void;
}): MeetingClaude | null {
  const ownerEmail = o.ownerEmail?.trim() ?? '';
  const client = o.client;
  const log = o.log ?? ((line: string) => console.warn(line));
  const off = !o.enabled
    ? 'switched off'
    : !ownerEmail
      ? 'no owner email'
      : !client
        ? 'no Recall client'
        : null;
  log(`[meeting-claude] ${off === null ? 'on' : `off: ${off}`}`);
  if (off !== null || !client) return null;
  return new MeetingClaude({
    ownerEmail,
    answererFor: (docId) => {
      const workspaceId = o.boardOf(docId);
      return workspaceId ? new SpokenAnswerer(o.board(), workspaceId) : null;
    },
    actor: (speaker) => ({ id: o.ownerId(), name: speaker.name ?? 'Owner', kind: 'known' }),
    voice: o.voice,
    play: (botId, mp3) => client.outputAudio(botId, mp3),
    ...(o.notesOf ? { notesOf: o.notesOf } : {}),
    ...(o.leads ? { lead: { answers: o.leads, boardOf: o.boardOf } } : {}),
    ...(o.planMinute ? { planMinute: o.planMinute } : {}),
    log: (line) => console.error(line),
  });
}
