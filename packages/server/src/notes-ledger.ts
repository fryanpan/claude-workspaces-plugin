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
 * The paragraph of the shipped instructions the nested rule replaces.
 *
 * Asserted rather than assumed: a silent `.replace()` that matched nothing
 * would run a ledger method on the ORIGINAL prompt and report it as a
 * different note-taker, which is the failure that makes a whole comparison
 * table meaningless.
 */
export const LEDGER_FLAT_RUN_ANCHOR = [
  '- ONE POINT PER BULLET, AT MOST 20 WORDS — count them. A longer thought',
  '  is two bullets, and a bullet that needs a dash, a semicolon or the word',
  '  "and" to hold two ideas is already those two bullets. The speaker tag',
  '  does not count towards the twenty.',
].join('\n');

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
 * THE LEAD BULLETS CARRY NO WORD CEILING OF THEIR OWN, and that is a measured
 * decision rather than a looser rule. With one, the writer met it by cutting
 * the speaker tag off the front of a lead bullet, and a single untagged
 * bullet survives every later tick — so one dropped tag cost the whole
 * "decisions and questions keep a speaker" column, which the original holds
 * at 100%.
 */
export const LEDGER_NESTED_RULE = [
  '- TWO LAYERS, ALWAYS. The top layer is what a person reads at a glance:',
  '  short LEAD bullets, one per point the room worked on, each as short as',
  '  the point can be said in. Under each lead bullet sit its SUB-BULLETS, indented two',
  '  spaces, one per proposition the speech carried about that point — an',
  '  option, a number, an objection, a reason, a decision, who said it.',
  '  Like this:',
  '      - Remote has to survive the couch',
  '        - [@Dana](speaker:B) says people lose it between the cushions weekly',
  '        - [@Rowan](speaker:C) offers a locator beep triggered by a whistle',
  '        - Cost of the beeper is not known yet (unconfirmed)',
  '- THE SPEAKER TAG RIDES WHICHEVER LAYER THE POINT IS ON, in the same',
  '  `[@Name](speaker:LABEL)` form as everywhere else. A decision, an open',
  '  question, a doubt and a claim all keep their tag whether they are a lead',
  '  bullet or a sub-bullet — who decided, who is asking and who is unsure is',
  '  part of what those notes say, and being the short glance layer buys a',
  '  lead bullet no exemption from it. Only a note that is the ROOM rather',
  '  than anybody in it goes untagged, like the last line above.',
  "- A BULLET THAT FUSES TWO PEOPLE'S POINTS IS TWO BULLETS, each with its",
  '  own tag. Fusing is how a note ends up belonging to nobody: "assumption',
  '  that people will buy it, but practicality is uncertain" is one person\'s',
  "  claim and another's doubt, and written as one bullet it loses both",
  '  names. Before you write a bullet with no tag on it, name the voice it',
  '  came from; if you can name one, the tag goes on.',
  '- SO NOTHING IS EVER DROPPED FOR LENGTH. The glance layer stays short',
  '  because the detail is one layer DOWN, not because it was cut. If a',
  '  proposition does not fit in the lead bullet, it becomes a sub-bullet;',
  '  it never becomes nothing.',
  '- ONE POINT PER BULLET, AT MOST 20 WORDS — count them, lead bullets and',
  '  sub-bullets alike. A longer thought is two bullets. The speaker tag',
  '  does not count towards the twenty, and no lead bullet is ever shortened',
  '  by dropping one: the tag is not packaging, it is who said the thing.',
].join('\n');

/**
 * The shipped instructions with the nested writing rule in place of the flat
 * one — what a LEDGER method composes against.
 *
 * Returns the source unchanged, and says so once, when the anchor is no
 * longer there: a person editing the prompt on the settings page must not be
 * able to turn a ledger method into a failed tick. The note-taker then writes
 * flat, which is the original's behaviour and never nothing.
 */
export function nestedNotesInstructions(
  source: string,
  onError?: (message: string) => void,
): string {
  if (!source.includes(LEDGER_FLAT_RUN_ANCHOR)) {
    onError?.(
      'notes ledger: the one-point-per-bullet rule is no longer in the instructions, ' +
        'so the nested writing rule was not applied',
    );
    return source;
  }
  return source.replace(LEDGER_FLAT_RUN_ANCHOR, LEDGER_NESTED_RULE);
}
