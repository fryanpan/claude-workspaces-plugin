/**
 * Five different WAYS of note-taking, so `bun run notes:eval` can measure them
 * against one corpus and one judge.
 *
 * WHY A SWITCH AND NOT FIVE BRANCHES. The number this exploration exists for —
 * the share of voiced ideas the notes did not keep — is only comparable when
 * the corpus, the ground truth and the judge are the same. Five branches means
 * five runs of five slightly different evals, and the differences between them
 * would be read as differences between the methods. So the methods are values
 * here, and `--variant <name>` picks one.
 *
 * NOTHING HERE SHIPS. The winner gets a proper build row; this file is the
 * measurement, and the seams it uses in the server (`extraPrompt`, the
 * composer's `model`) are inert unless a variant sets them.
 *
 * WHAT EACH ONE IS
 * - `baseline`   the shipped prompt on Haiku, unchanged. The control.
 * - `nested`     two layers: a glanceable lead bullet per point, every
 *                proposition folded under it as a sub-bullet.
 * - `ledger`     two passes: a cheap pass enumerates the ideas in the tick,
 *                the compose is handed that list as a checklist, and whatever
 *                the notes still do not carry rides the next tick.
 * - `selfcheck`  the lost-idea check runs live, per tick, as a MODEL call over
 *                this tick's sentences, and its misses are fed back as the
 *                composer's `missed` on the following tick.
 * - `anchored`   every note ends with the moment it came from, "(#7)", so the
 *                detail behind it is a click away rather than a token in the
 *                note. Judged twice: on the notes as written, and on the notes
 *                with each cited moment's speech appended.
 * - `sonnet` / `opus`  the shipped prompt, composed by a bigger model.
 */

import type { NotesComposeInput, NotesTurn } from '../packages/server/src/meeting-notes.ts';
import {
  contentWords,
  ideaCarried,
  sentencesOf,
} from '../packages/server/src/notes-idea-coverage.ts';
import { DEFAULT_NOTES_INSTRUCTIONS } from '../packages/server/src/notes-prompt-store.ts';

const API_URL = 'https://api.anthropic.com/v1/messages';
/** The cheap model the extra passes run on. A variant that pays Sonnet for its
 *  own bookkeeping is not a variant of the note-taker, it is a bigger bill. */
export const HELPER_MODEL = 'claude-haiku-4-5-20251001';

/* ===== The instruction variants ===== */

/**
 * Replace one block of the shipped instructions, loudly.
 *
 * A silent `.replace()` that matched nothing would run the variant as the
 * baseline and report it as a different method — the failure mode that makes
 * a whole table meaningless. So the anchor is asserted.
 */
function swap(source: string, anchor: string, replacement: string): string {
  if (!source.includes(anchor)) {
    throw new Error(`variant instructions: the anchor is no longer in the prompt:\n${anchor}`);
  }
  return source.replace(anchor, replacement);
}

const FLAT_RUN_ANCHOR = [
  '- ONE POINT PER BULLET, AT MOST 20 WORDS — count them. A longer thought',
  '  is two bullets, and a bullet that needs a dash, a semicolon or the word',
  '  "and" to hold two ideas is already those two bullets. The speaker tag',
  '  does not count towards the twenty.',
].join('\n');

const NESTED_RULE = [
  '- TWO LAYERS, ALWAYS. The top layer is what a person reads at a glance:',
  '  short LEAD bullets, at most 12 words each, one per point the room',
  '  worked on. Under each lead bullet sit its SUB-BULLETS, indented two',
  '  spaces, one per proposition the speech carried about that point — an',
  '  option, a number, an objection, a reason, a decision, who said it.',
  '  Like this:',
  '      - Remote has to survive the couch',
  '        - B: people lose it between the cushions weekly',
  '        - Option: a locator beep triggered by a whistle',
  '        - Cost of the beeper is not known yet (unconfirmed)',
  '- SO NOTHING IS EVER DROPPED FOR LENGTH. The glance layer stays short',
  '  because the detail is one layer DOWN, not because it was cut. If a',
  '  proposition does not fit in the lead bullet, it becomes a sub-bullet;',
  '  it never becomes nothing.',
  '- ONE POINT PER BULLET, AT MOST 20 WORDS — count them, lead bullets and',
  '  sub-bullets alike. A longer thought is two bullets. The speaker tag',
  '  does not count towards the twenty.',
].join('\n');

const ANCHOR_RULE = [
  '- ANCHOR EVERY NOTE TO THE MOMENT IT CAME FROM. End each bullet you',
  '  write with the moment marker given to you for this speech — "(#7)" —',
  '  after the words and after any "(unconfirmed)". A reader who wants the',
  '  detail behind a note opens that moment of the transcript, so the note',
  '  itself carries only the point.',
  '- BECAUSE THE DETAIL IS ONE CLICK AWAY, the note can be short. It can',
  '  NOT be absent: an anchor with no note beside it points at nothing, and',
  '  every idea still gets its own bullet.',
  '- ONE POINT PER BULLET, AT MOST 20 WORDS — count them. A longer thought',
  '  is two bullets. Neither the speaker tag nor the moment marker counts',
  '  towards the twenty.',
].join('\n');

/* ===== The helper calls ===== */

interface ToolSpec {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

/** How a variant reaches the API and gets its spend counted. */
export interface VariantContext {
  key: string;
  /** The eval's counting fetch for a model, so helper spend lands in the
   *  report rather than off the books. */
  fetchFor: (model: string) => typeof fetch;
}

async function callTool(
  ctx: VariantContext,
  system: string,
  user: string,
  tool: ToolSpec,
  maxTokens: number,
): Promise<Record<string, unknown> | null> {
  const res = await ctx.fetchFor(HELPER_MODEL)(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ctx.key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: HELPER_MODEL,
      max_tokens: maxTokens,
      system,
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: user }],
    }),
  });
  // The status only. A body can echo the prompt, and the prompt is speech.
  if (!res.ok) {
    console.error(`  variant helper call returned HTTP ${res.status}`);
    return null;
  }
  const body = (await res.json()) as {
    content?: Array<{ type?: string; name?: string; input?: unknown }>;
  };
  const call = body.content?.find((b) => b.type === 'tool_use' && b.name === tool.name);
  if (!call?.input || typeof call.input !== 'object') return null;
  return call.input as Record<string, unknown>;
}

/**
 * The extract pass, worded DELIBERATELY UNLIKE the ground truth's own listing
 * prompt.
 *
 * The ground truth in `<meeting>.ideas.json` was enumerated by Sonnet under a
 * prompt of its own. A variant that enumerates with the same words is not
 * measuring a two-pass note-taker, it is measuring how well one prompt
 * reproduces another — and it would score well for a reason that does not
 * survive contact with a real meeting. So this asks for the same KIND of thing
 * in different terms, and the confound is named in the results rather than
 * hidden.
 */
const EXTRACT_SYSTEM = [
  'You are the first of two passes over a live meeting. Your only job is to',
  'catch everything, so the second pass — which writes the notes — cannot',
  'quietly lose any of it.',
  '',
  'Read the speech and write down each separate thing it put on the table:',
  'a point somebody argued, a proposal, a worry, a constraint, a figure, a',
  'choice made, a job somebody took on, something left unanswered.',
  '',
  'Rules: one thing per line, in plain words, twelve words or fewer. Say who',
  'when it matters. Skip pure social noise and abandoned half-sentences. If',
  'the speech genuinely put nothing on the table, write nothing at all — a',
  'padded list is worse than a short one.',
  '',
  'Answer with the record_points tool.',
].join('\n');

const EXTRACT_TOOL: ToolSpec = {
  name: 'record_points',
  description: 'Record each separate thing this speech put on the table.',
  input_schema: {
    type: 'object',
    properties: { points: { type: 'array', items: { type: 'string' } } },
    required: ['points'],
  },
};

async function extractPoints(ctx: VariantContext, transcript: string): Promise<string[]> {
  const out = await callTool(ctx, EXTRACT_SYSTEM, `The speech:\n${transcript}`, EXTRACT_TOOL, 700);
  const points = out?.points;
  if (!Array.isArray(points)) return [];
  return points.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
}

const CARRY_SYSTEM = [
  'You are checking a set of live meeting notes against sentences that were',
  'spoken, one at a time.',
  '',
  'For each numbered sentence, answer whether the notes ALREADY CARRY what it',
  'said — in any words, anywhere, however compressed. A five-word note that',
  'says the same thing carries it. A note about the same topic that does not',
  'say this particular thing does not. A sentence that said nothing worth a',
  'note — a greeting, a false start, agreement with no content — counts as',
  'carried, because the notes owe it nothing.',
  '',
  'Answer with the record_carried tool: one entry per sentence, in order.',
].join('\n');

const CARRY_TOOL: ToolSpec = {
  name: 'record_carried',
  description: 'Say, per sentence, whether the notes already carry it.',
  input_schema: {
    type: 'object',
    properties: {
      carried: {
        type: 'array',
        items: {
          type: 'object',
          properties: { n: { type: 'number' }, carried: { type: 'boolean' } },
          required: ['n', 'carried'],
        },
      },
    },
    required: ['carried'],
  },
};

/** Which of these lines the notes already carry. An unreadable answer is
 *  "carried" for every line: a live check that cannot be read must not put the
 *  whole tick back into the next prompt. */
async function judgeCarriedLive(
  ctx: VariantContext,
  lines: readonly string[],
  notes: string,
): Promise<boolean[]> {
  if (lines.length === 0) return [];
  const out = await callTool(
    ctx,
    CARRY_SYSTEM,
    [
      `The notes:\n${notes || '(the notes are empty)'}`,
      `The sentences:\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}`,
    ].join('\n\n'),
    CARRY_TOOL,
    200 + lines.length * 40,
  );
  const rows = out?.carried;
  if (!Array.isArray(rows)) return lines.map(() => true);
  const verdicts = new Array<boolean>(lines.length).fill(true);
  let answered = 0;
  for (const row of rows as Array<{ n?: unknown; carried?: unknown }>) {
    const n = typeof row?.n === 'number' ? row.n - 1 : -1;
    if (n < 0 || n >= lines.length) continue;
    verdicts[n] = row.carried === true;
    answered++;
  }
  return answered === lines.length ? verdicts : lines.map(() => true);
}

/* ===== The variant shape ===== */

/** One meeting's worth of variant state. */
export interface MeetingHooks {
  /** Extra input fields for this tick's compose, merged over the harness's. */
  before(
    input: NotesComposeInput,
    tick: number,
    transcript: string,
  ): Promise<Partial<NotesComposeInput>>;
  /** Called after the tick's write with the notes as they now stand. */
  after(notes: string, tick: number, transcript: string): Promise<void>;
  /** The final notes as the idea judge should read them. Undefined means "as
   *  written" — only `anchored` supplies one. */
  expand?(notes: string): string;
}

export interface Variant {
  name: string;
  /** What composes. Absent means the eval's own default (Haiku). */
  model?: string;
  maxTokens?: number;
  effort?: string;
  /** The system prompt. Absent means the shipped default. */
  instructions?: string;
  /** Whether the notes are judged a second time with the anchors expanded. */
  judgeExpanded?: boolean;
  begin(ctx: VariantContext): MeetingHooks;
}

const NO_HOOKS: MeetingHooks = {
  async before() {
    return {};
  },
  async after() {
    /* nothing to do */
  },
};

const passthrough = (): MeetingHooks => NO_HOOKS;

/** The most a variant may put in front of one compose. An unbounded carry is
 *  how a meeting's prompt once grew without limit. */
const MAX_CARRIED = 12;

/**
 * `ledger`: enumerate, then compose against the enumeration.
 *
 * The unplaced entries carry forward, and they are dropped after three ticks
 * rather than forever — a point the note-taker has declined three times with
 * the notes in front of it is a point it is declining on purpose.
 */
function ledgerHooks(ctx: VariantContext): MeetingHooks {
  let carried: Array<{ text: string; age: number }> = [];
  let thisTick: string[] = [];
  return {
    async before(_input, _tick, transcript) {
      thisTick = await extractPoints(ctx, transcript);
      const items = [...carried.map((c) => c.text), ...thisTick];
      if (items.length === 0) return {};
      return {
        extraPrompt: [
          'A FIRST PASS ALREADY READ THIS SPEECH AND LISTED WHAT IT PUT ON THE',
          'TABLE. The notes must end up carrying every line below, in your own',
          'compressed words, under the heading it belongs to. Work down the',
          'list: a line with no note is a dropped idea, and dropping one is the',
          'single thing this note-taker is not allowed to do. Skip a line only',
          'when the notes above already say it.',
          ...items.map((p) => `- ${p}`),
        ].join('\n'),
      };
    },
    async after(notes) {
      // Lexical, not a model call: this decides only what to OFFER again, and
      // an offer costs a few tokens while a second judge per tick costs a
      // second bill. The real verdict is the eval's.
      const next: Array<{ text: string; age: number }> = [];
      for (const entry of [...carried, ...thisTick.map((text) => ({ text, age: 0 }))]) {
        const keywords = contentWords(entry.text);
        const done = ideaCarried({ turn: 0, text: entry.text, keywords }, notes);
        if (done || entry.age >= 2) continue;
        next.push({ text: entry.text, age: entry.age + 1 });
      }
      carried = next.slice(-MAX_CARRIED);
      thisTick = [];
    },
  };
}

/**
 * Variant D: the same ledger, off the critical path.
 *
 * `ledgerHooks` awaits the extract before the compose starts, so every tick
 * pays a Haiku round trip before the note-taker begins writing. This one
 * starts the extract for THIS tick's speech and does not wait: the compose
 * runs on the points extracted from the PREVIOUS tick, which finished while
 * the room was still talking.
 *
 * WHAT IT TRADES. A tick's own points reach the notes one tick late, so a
 * point raised and never mentioned again is written on the following update
 * rather than this one. In exchange the extract costs no latency at all. The
 * eval prints compose-to-written median beside the lost-idea rate, which is
 * where the two halves of that trade show up.
 *
 * THE LAST TICK'S EXTRACT IS NEVER READ, because there is no tick after it to
 * read it. Its points are the ones the meeting's final update would have
 * carried; whether that matters is what the rate says.
 */
function pipelinedLedgerHooks(ctx: VariantContext): MeetingHooks {
  let carried: Array<{ text: string; age: number }> = [];
  let inFlight: Promise<string[]> | null = null;
  let offered: string[] = [];
  return {
    async before(_input, _tick, transcript) {
      // Resolved long ago in the ordinary case: it was started one tick back
      // and the compose in between took seconds. Awaiting it is how a slow
      // extract still cannot be skipped, only overtaken.
      const ready = inFlight ? await inFlight : [];
      inFlight = extractPoints(ctx, transcript);
      offered = ready;
      const items = [...carried.map((c) => c.text), ...ready];
      if (items.length === 0) return {};
      return {
        extraPrompt: [
          'A FIRST PASS ALREADY READ THE SPEECH JUST BEFORE THIS ONE AND LISTED',
          'WHAT IT PUT ON THE TABLE. The notes must end up carrying every line',
          'below, in your own compressed words, under the heading it belongs',
          'to. Work down the list: a line with no note is a dropped idea, and',
          'dropping one is the single thing this note-taker is not allowed to',
          'do. Skip a line only when the notes above already say it.',
          ...items.map((p) => `- ${p}`),
        ].join('\n'),
      };
    },
    async after(notes) {
      const next: Array<{ text: string; age: number }> = [];
      for (const entry of [...carried, ...offered.map((text) => ({ text, age: 0 }))]) {
        const keywords = contentWords(entry.text);
        const done = ideaCarried({ turn: 0, text: entry.text, keywords }, notes);
        if (done || entry.age >= 2) continue;
        next.push({ text: entry.text, age: entry.age + 1 });
      }
      carried = next.slice(-MAX_CARRIED);
      offered = [];
    },
  };
}

/**
 * `selfcheck`: the lost-idea question, asked live, every tick.
 *
 * The sentences this tick actually contained are checked against the notes by
 * a model, and the ones it says are missing become the NEXT tick's `missed` —
 * the field the pipeline already has for "said earlier and still in no note",
 * whose current filler is a keyword-overlap proxy.
 */
function selfcheckHooks(ctx: VariantContext): MeetingHooks {
  let pending: NotesTurn[] = [];
  let lastTurns: readonly NotesTurn[] = [];
  return {
    async before(input) {
      lastTurns = input.tick.turns;
      if (pending.length === 0) return {};
      const missed = [...(input.missed ?? []), ...pending];
      pending = [];
      return { missed };
    },
    async after(notes) {
      const lines: Array<{ text: string; turn: NotesTurn }> = [];
      for (const turn of lastTurns) {
        for (const sentence of sentencesOf(turn.text)) {
          if (contentWords(sentence).length < 2) continue;
          lines.push({ text: sentence, turn });
        }
      }
      if (lines.length === 0) return;
      const verdicts = await judgeCarriedLive(
        ctx,
        lines.map((l) => l.text),
        notes,
      );
      pending = lines
        .filter((_, i) => verdicts[i] === false)
        .slice(0, MAX_CARRIED)
        .map(({ text, turn }) => ({
          ...turn,
          text,
        }));
    },
  };
}

/**
 * `anchored`: every bullet ends with the moment it came from.
 *
 * The tick ordinal is the anchor, because it is the one label both the note
 * and the transcript already share. `expand` is what makes the claim
 * measurable: it hands the judge the notes with each cited moment's speech
 * appended, which is what a reader who clicks an anchor sees.
 */
function anchoredHooks(): MeetingHooks {
  const spoken = new Map<number, string>();
  return {
    async before(_input, tick, transcript) {
      spoken.set(tick, transcript);
      return {
        extraPrompt: `This speech is moment #${tick}. Every note you write from it ends with "(#${tick})".`,
      };
    },
    async after() {
      /* nothing to settle */
    },
    expand(notes) {
      const cited = new Set<number>();
      for (const m of notes.matchAll(/\(#(\d+)\)/g)) cited.add(Number(m[1]));
      if (cited.size === 0) return notes;
      const spans = [...cited]
        .sort((a, b) => a - b)
        .filter((n) => spoken.has(n))
        .map((n) => `Moment #${n}, as spoken:\n${spoken.get(n)}`);
      return `${notes}\n\n--- the moments these notes point at ---\n\n${spans.join('\n\n')}`;
    },
  };
}

const COMPRESS_ANCHOR = [
  '- COMPRESS, NEVER DROP. What goes is the packaging: greetings, thinking',
  '  aloud, false starts, a point already in the notes, the same point said',
  '  again in other words. What STAYS is every idea. If the speech raised a',
  '  subject the notes do not yet carry, it gets a note — even a small one,',
  '  even a single sentence that mattered for a moment. Length is what you',
  '  cut; ideas are not. When you must choose, write the idea in five words',
  '  rather than leaving it out.',
].join('\n');

/**
 * Variant E: stop asking for compression at all.
 *
 * The shipped rule asks for two things at once — keep every idea, and cut the
 * length — and every variant that lost ideas wrote FEWER bullets than
 * baseline, never more. This drops the second half and says the quiet part:
 * one note per idea, and the page is as long as the meeting was.
 *
 * It is the variant that tells the owner what a 5% lost-idea rate COSTS in
 * page length, which is why the run reports bullets written and page length
 * beside the rate rather than the rate alone.
 */
const ONE_NOTE_PER_IDEA = [
  '- ONE NOTE PER IDEA, AND NO IDEA WITHOUT A NOTE. Every distinct thing this',
  '  speech said gets its own bullet: an option, a number, an objection, a',
  '  reason, a decision, a question, an aside that mattered for a moment.',
  '  Count the ideas in the speech and write that many bullets.',
  '- DO NOT COMPRESS. Length is not a cost here and there is no ceiling on',
  '  how long the notes may get. The only things you leave out are greetings,',
  '  filler, a false start the speaker corrected, and a point already written',
  '  in the notes in the same words. Everything else is an idea and gets its',
  '  bullet, even a small one.',
  '- WHEN YOU ARE UNSURE WHETHER SOMETHING IS AN IDEA, WRITE IT. A note the',
  '  room skims past costs a line. An idea left out is gone.',
].join('\n');

export const VARIANTS: Record<string, Variant> = {
  baseline: { name: 'baseline', begin: passthrough },
  nested: {
    name: 'nested',
    instructions: swap(DEFAULT_NOTES_INSTRUCTIONS, FLAT_RUN_ANCHOR, NESTED_RULE),
    begin: passthrough,
  },
  ledger: { name: 'ledger', begin: ledgerHooks },
  selfcheck: { name: 'selfcheck', begin: selfcheckHooks },
  anchored: {
    name: 'anchored',
    instructions: swap(DEFAULT_NOTES_INSTRUCTIONS, FLAT_RUN_ANCHOR, ANCHOR_RULE),
    judgeExpanded: true,
    begin: anchoredHooks,
  },
  // The combination the first sweep pointed at: the shape that never collapsed
  // (nested) carrying the enumeration that produced the lowest floor (ledger).
  'nested-ledger': {
    name: 'nested-ledger',
    instructions: swap(DEFAULT_NOTES_INSTRUCTIONS, FLAT_RUN_ANCHOR, NESTED_RULE),
    begin: ledgerHooks,
  },
  sonnet: {
    name: 'sonnet',
    model: 'claude-sonnet-5',
    maxTokens: 4_000,
    effort: 'low',
    begin: passthrough,
  },
  opus: {
    name: 'opus',
    model: 'claude-opus-5',
    maxTokens: 4_000,
    effort: 'low',
    begin: passthrough,
  },
  // Round 2. The compress instruction removed, on the finding that every
  // variant which lost ideas wrote fewer bullets than baseline rather than
  // more — so the instruction to cut length may be the thing being obeyed.
  everything: {
    name: 'everything',
    instructions: swap(DEFAULT_NOTES_INSTRUCTIONS, COMPRESS_ANCHOR, ONE_NOTE_PER_IDEA),
    begin: passthrough,
  },
  // Round 2. The ledger with its extract taken off the critical path.
  'ledger-pipelined': { name: 'ledger-pipelined', begin: pipelinedLedgerHooks },
  // Round 2. The best method on the best model, to price the ceiling.
  'opus-nested-ledger': {
    name: 'opus-nested-ledger',
    model: 'claude-opus-5',
    maxTokens: 4_000,
    effort: 'low',
    instructions: swap(DEFAULT_NOTES_INSTRUCTIONS, FLAT_RUN_ANCHOR, NESTED_RULE),
    begin: ledgerHooks,
  },
};

export function resolveVariant(name: string): Variant {
  const v = VARIANTS[name];
  if (!v) throw new Error(`unknown --variant ${name}. One of: ${Object.keys(VARIANTS).join(', ')}`);
  return v;
}
