/**
 * THE LEDGER: enumerate what a tick's speech put on the table, then compose
 * against that enumeration.
 *
 * The shipped one-pass note-taker reads the speech and writes the notes in
 * one call, and the eval says it leaves about a third of the voiced ideas
 * unwritten. This runs a cheap pass first — one Haiku call that lists the
 * separate things the speech raised — and hands the writer that list as a
 * checklist. Whatever the notes still do not carry rides forward to the next
 * tick, so an idea the writer skipped once gets offered again.
 *
 * PORTED FROM `scripts/notes-eval-variants.ts`, which measured it as
 * `nested-ledger` before any of it shipped. Two things changed on the way in,
 * both because the exploration measured them going wrong:
 *
 * 1. THE EXTRACT KEEPS THE SPEAKER. The exploration's extract said "say who
 *    when it matters", so most lines came back as bare propositions, and a
 *    writer working down a list of unattributed lines wrote unattributed
 *    notes: the ledger variants held the "decisions and questions keep a
 *    speaker" bar at 22–42% where the original holds it at 100%. The label
 *    now rides every line, and the checklist says in as many words that the
 *    speaker rule still governs. See `LEDGER_PREAMBLE`.
 * 2. THE EXTRACT IS ON THE CRITICAL PATH. `pipelinedLedgerHooks` composed
 *    against the PREVIOUS tick's points to save the round trip; it is not
 *    what shipped, because a point raised once and never repeated then lands
 *    a tick late or, on the last tick, not at all.
 *
 * 3. THE EXTRACT CARRIES THE STRENGTH BAR TOO. It is the pass that decides
 *    what a point IS, and the writer can only write what it hands over. On
 *    AMI ES2002b tick 14 — the room untangling cables — it returned
 *    "D: Committed to current approach" out of D saying "I'm all in [a
 *    knot]", and "B: Suggested wireless setup would be nice" out of a joke
 *    about the room's own wiring. Both reached the notes as claims about the
 *    product. `EXTRACT_SYSTEM` now says an aside is not a proposal and an
 *    unfinished fragment is not a commitment, in the same words the writer's
 *    accuracy block uses, so the bar is one bar on both passes.
 *
 * IT IS ONE HAIKU CALL PER TICK whichever method is running: `ledger-opus`
 * changes what COMPOSES, not what enumerates. A ledger that paid the big
 * model for its own bookkeeping would be a bigger bill rather than a better
 * note-taker.
 */

import type { NotesTurn } from './meeting-notes.ts';
import { contentWords, ideaCarried } from './notes-idea-coverage.ts';
import { NOTES_SPEAKERS_HEADING } from './notes-prompt-store.ts';
import { MAX_BULLET_WORDS } from './notes-quality.ts';
import { appendToSection, replaceSection } from './prompt-sections.ts';
import { type SummaryCredential, authHeader } from './summarize.ts';

/** The cheap model the extract runs on, whatever composes the notes. */
export const LEDGER_EXTRACT_MODEL = 'claude-haiku-4-5-20251001';

const API_URL = 'https://api.anthropic.com/v1/messages';

/**
 * The most points that may ride in front of one compose.
 *
 * A carry with no ceiling is how a meeting's prompt grows without limit: a
 * long meeting whose writer keeps declining the same points would put every
 * one of them in front of every later tick.
 */
export const MAX_CARRIED = 12;

/**
 * How many ticks an unplaced point keeps being offered.
 *
 * Two, not forever. A point the writer has had in front of it three times
 * with the notes beside it is a point it is declining on purpose, and the
 * eval counts it lost either way — offering it a fourth time spends prompt
 * on a decision already made.
 */
export const MAX_CARRY_AGE = 2;

const EXTRACT_SYSTEM = [
  'You are the first of two passes over a live meeting. Your only job is to',
  'catch everything, so the second pass — which writes the notes — cannot',
  'quietly lose any of it.',
  '',
  'Read the speech and write down each separate thing it put on the table:',
  'a point somebody argued, a proposal, a worry, a constraint, a figure, a',
  'choice made, a job somebody took on, something left unanswered.',
  '',
  'ALWAYS BEGIN A LINE WITH WHO SAID IT, exactly as the transcript spells',
  'them: "Name (LABEL): the point". The second pass has to attribute what it',
  'writes, and it can only attribute what you hand it — a line with no',
  'speaker becomes a note with no speaker. Where a point genuinely belongs to',
  'the room rather than to a person, begin it with "Room:".',
  '',
  'Rules: one thing per line, in plain words, twelve words or fewer after the',
  'speaker. Skip pure social noise and abandoned half-sentences. If the',
  'speech genuinely put nothing on the table, write nothing at all — a padded',
  'list is worse than a short one.',
  '',
  'WRITE EACH POINT AT THE STRENGTH IT WAS SAID, never one step up. An aside',
  'is not a proposal, an unfinished fragment is not a commitment, and a',
  'remark about the room — the cables, the seats, the projector — is not a',
  'point about the thing being designed. Where two speakers talk over each',
  'other, do not assemble their fragments into an intention neither of them',
  'finished. The second pass can only write what you hand it, so a line you',
  'strengthen here becomes a note nobody said. Leave it out rather than',
  'finish it for them.',
  '',
  'Answer with the record_points tool.',
].join('\n');

/**
 * The checklist the compose is handed, above the points themselves.
 *
 * THE SPEAKER SENTENCES ARE LOAD-BEARING, and they are the reason this is a
 * named constant rather than an inline array. Every line below arrives
 * attributed, and a writer told only "carry every line" treats the list as
 * the thing to satisfy and the standing instructions as background — which
 * is exactly how the exploration's ledger variants dropped attribution they
 * would otherwise have kept. The checklist restates the rule it is competing
 * with.
 */
const LEDGER_PREAMBLE = [
  'A FIRST PASS ALREADY READ THIS SPEECH AND LISTED WHAT IT PUT ON THE',
  'TABLE. The notes must end up carrying every line below, in your own',
  'compressed words, under the heading it belongs to. Work down the list: a',
  'line with no note is a dropped idea, and dropping one is the single thing',
  'this note-taker is not allowed to do. Skip a line only when the notes',
  'above already say it.',
  '',
  'EACH LINE BEGINS WITH WHO SAID IT, and that is not decoration: the note',
  'you write from it carries the same speaker tag you would have written had',
  'you read the speech yourself. THE ATTRIBUTION RULES ABOVE STILL GOVERN —',
  'a decision and an open question always keep their speaker tag, and this',
  'list never excuses one. A line beginning "Room:" is the only one that',
  'takes no tag.',
].join('\n');

/** One carried point and how many ticks it has been offered. */
interface CarriedPoint {
  text: string;
  age: number;
}

/** How the ledger reaches the model. Injected so a test drives it with no key
 *  and no network, and so the eval can count its spend. */
export interface NotesLedgerDeps {
  /**
   * How the extract authenticates — the SAME shape the compose half uses, and
   * for the same reason it is a shape rather than a string: an access token
   * and an API key go in different headers, and a ledger that could only send
   * one of them would go quiet on exactly the runs that hold a token.
   */
  credential: SummaryCredential;
  fetchImpl?: typeof fetch;
  /** Where an unreadable extract is reported. Never throws out of the ledger:
   *  a failed enumeration must degrade to the original note-taker, not fail
   *  the tick. */
  onError?: (message: string) => void;
}

/** One meeting's ledger. Stateful — the carry is the state — so a session
 *  holds one of these for its lifetime. */
export interface NotesLedger {
  /**
   * The extract for this tick's speech, as the `extraPrompt` the compose
   * should carry. Empty string when the speech put nothing on the table and
   * nothing is carried, which is the tick that should compose exactly as the
   * original would.
   */
  before(turns: readonly NotesTurn[]): Promise<string>;
  /**
   * Told the notes as they now stand, so the points those notes carry stop
   * being offered.
   *
   * LEXICAL, NOT A MODEL CALL. This decides only what to OFFER again, and an
   * offer costs a few tokens where a second judge per tick costs a second
   * bill. The real verdict on whether an idea survived is the eval's.
   */
  after(notes: string): void;
}

/**
 * The speech of one tick as the extract reads it: one line per turn, named
 * the way the compose prompt names them, so a label in the extract's output
 * is a label the writer can tag with.
 */
export function ledgerTranscript(turns: readonly NotesTurn[]): string {
  return turns
    .map((t) => {
      const who = t.speaker ?? 'Speaker 1';
      const label = t.speakerLabel === undefined ? '' : ` (${t.speakerLabel})`;
      const partial = t.partial === true ? ' [still being spoken]' : '';
      return `${who}${label}${partial}: ${t.text}`;
    })
    .join('\n');
}

/** The checklist block for a set of points, or '' for no points at all. */
export function ledgerPrompt(points: readonly string[]): string {
  if (points.length === 0) return '';
  return [LEDGER_PREAMBLE, '', ...points.map((p) => `- ${p}`)].join('\n');
}

async function extractPoints(deps: NotesLedgerDeps, transcript: string): Promise<string[]> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchImpl(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeader(deps.credential),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: LEDGER_EXTRACT_MODEL,
        max_tokens: 700,
        system: EXTRACT_SYSTEM,
        tools: [
          {
            name: 'record_points',
            description: 'Record each separate thing this speech put on the table.',
            input_schema: {
              type: 'object',
              properties: { points: { type: 'array', items: { type: 'string' } } },
              required: ['points'],
            },
          },
        ],
        tool_choice: { type: 'tool', name: 'record_points' },
        messages: [{ role: 'user', content: `The speech:\n${transcript}` }],
      }),
    });
  } catch (err) {
    // A NETWORK FAILURE IS AN EMPTY LEDGER, never a thrown tick. The compose
    // that follows is the original note-taker, which is a worse note-taker
    // and not a broken one.
    deps.onError?.(`notes ledger extract failed: ${err instanceof Error ? err.message : 'error'}`);
    return [];
  }
  // The status only. A body can echo the prompt, and the prompt is speech.
  if (!res.ok) {
    deps.onError?.(`notes ledger extract returned HTTP ${res.status}`);
    return [];
  }
  let body: { content?: Array<{ type?: string; name?: string; input?: unknown }> };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    deps.onError?.('notes ledger extract returned an unreadable body');
    return [];
  }
  const call = body.content?.find((b) => b.type === 'tool_use' && b.name === 'record_points');
  const points = (call?.input as { points?: unknown } | undefined)?.points;
  if (!Array.isArray(points)) return [];
  return points.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
}

export function createNotesLedger(deps: NotesLedgerDeps): NotesLedger {
  let carried: CarriedPoint[] = [];
  let thisTick: string[] = [];
  return {
    async before(turns) {
      const transcript = ledgerTranscript(turns);
      // No speech is no extract: a tick that fired on the cadence with
      // nothing settled must not pay a round trip to be told so. Carried
      // points still ride, which is the whole point of carrying them.
      thisTick = transcript.trim().length === 0 ? [] : await extractPoints(deps, transcript);
      return ledgerPrompt([...carried.map((c) => c.text), ...thisTick]);
    },
    after(notes) {
      const next: CarriedPoint[] = [];
      for (const entry of [...carried, ...thisTick.map((text) => ({ text, age: 0 }))]) {
        const done = ideaCarried(
          { turn: 0, text: entry.text, keywords: contentWords(entry.text) },
          notes,
        );
        if (done || entry.age >= MAX_CARRY_AGE) continue;
        next.push({ text: entry.text, age: entry.age + 1 });
      }
      // The NEWEST survivors, not the oldest: when more points are unplaced
      // than may ride, the ones just raised are the ones still live in the
      // room.
      carried = next.slice(-MAX_CARRIED);
      thisTick = [];
    },
  };
}

/**
 * The section of the notes instructions the two-layer rule replaces, by its
 * heading. Only the heading is matched, so a person may reword the section on
 * the settings page and a ledger method still writes in two layers.
 */
export const LEDGER_REPLACES_HEADING = 'Grouping';

/**
 * WHY A LEDGER METHOD WRITES IN TWO LAYERS.
 *
 * The checklist is only worth its call if the writer has somewhere to put
 * every point on it. Under a flat rule the writer drops what will not fit and
 * the enumeration buys nothing; under this one the glance layer stays short
 * because the detail is one layer DOWN, and the exploration measured that
 * pairing (`nested-ledger`) as the lowest lost-idea rate of the sweep. The
 * twenty-word cap is unchanged and still counted per bullet.
 *
 * THE LEAD NOTES CARRY NO WORD CEILING OF THEIR OWN, and that is a measured
 * decision rather than a looser rule. With one, the writer met it by cutting
 * the speaker tag off the front of a lead bullet, and a single untagged
 * bullet survives every later tick — so one dropped tag cost the whole
 * "decisions and questions keep a speaker" column, which the original holds
 * at 100%.
 *
 * Its example carries no speaker tag, on purpose: the rules about tags are
 * `LEDGER_SPEAKER_RULES`, which ride in the speakers section so a solo
 * meeting drops them with the rest of it.
 */
export const LEDGER_TWO_LAYERS_SECTION = [
  '### Two layers',
  '',
  '- Always write in two layers.',
  '- The top layer is for a quick read. Write short LEAD notes, one for each point that the people discussed. Make each lead note as short as the point allows.',
  '- Under each lead note, put its SUB-NOTES, indented two spaces. Write one sub-note for each fact that the speech gave about the point: an option, a number, an objection, a reason, a decision.',
  '',
  '```',
  '- Remote has to survive the couch',
  '  - People lose it between the cushions each week',
  '  - Option: a locator beep that a whistle starts',
  '  - Cost of the beeper is not known yet (unconfirmed)',
  '```',
  '',
  '- Do not drop a point for length. The top layer stays short because the detail is one layer down. If a fact does not fit in the lead note, make it a sub-note.',
  `- Write one point in each note, lead notes and sub-notes alike. Use a maximum of ${MAX_BULLET_WORDS} words.`,
  '- Group with `nest_blocks`. Do not group with `replace_block` and `delete_block`.',
].join('\n');

/**
 * What the two-layer rule asks about WHO SAID IT, added at the end of the
 * speakers section — so a solo meeting, which is not sent that section, is
 * not sent these either.
 *
 * Each line is a measured regression: nested notes scored 73% on "decisions
 * and questions keep a speaker" against the original's 100%, because the
 * rule's worked example wrote a bare "B:" and a writer fused two people's
 * points into one bullet that belonged to nobody.
 */
export const LEDGER_SPEAKER_RULES = [
  '- Tag the voice on the layer where the point is, lead note or sub-note. Decisions, open questions, doubts and claims always keep their tag. Only a note about the group has no tag.',
  '- Do not join the points of two people in one note. Write two notes, each with its own tag: "[@Speaker B](speaker:B) says people will buy it" and "[@Speaker C](speaker:C) doubts it is practical".',
  '- Before you write a note with no tag, find the voice that said it. If you can name one, add the tag.',
  '- Do not remove a tag to make a lead note shorter. The tag is not packaging. It shows who said the point.',
].join('\n');

/**
 * The instructions with the two-layer rule in place of `### Grouping` — what
 * a LEDGER method composes against — and its speaker rules at the end of the
 * speakers section, or in a section of their own when the instructions have
 * none (a solo meeting drops that one too: `withoutSpeakerAttribution`
 * removes every section under the heading).
 *
 * Returns the source unchanged, and says so once, when there is no
 * `### Grouping` section: a person editing the prompt on the settings page
 * must not be able to turn a ledger method into a failed tick. The
 * note-taker then writes flat, which is the original's behaviour and never
 * nothing.
 */
export function nestedNotesInstructions(
  source: string,
  onError?: (message: string) => void,
): string {
  const layered = replaceSection(source, LEDGER_REPLACES_HEADING, LEDGER_TWO_LAYERS_SECTION);
  if (layered === null) {
    onError?.(
      `notes ledger: the instructions have no "### ${LEDGER_REPLACES_HEADING}" section, ` +
        'so the nested writing rule was not applied',
    );
    return source;
  }
  return (
    appendToSection(layered, NOTES_SPEAKERS_HEADING, LEDGER_SPEAKER_RULES) ??
    `${layered}\n\n### ${NOTES_SPEAKERS_HEADING}\n\n${LEDGER_SPEAKER_RULES}`
  );
}
