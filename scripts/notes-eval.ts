#!/usr/bin/env bun
/**
 * Does the note-taker actually behave? Run it over real meetings and check.
 *
 *   bun run notes:eval                 # every fixture, every judge
 *   bun run notes:eval --smoke         # the CI slice, a few cents
 *   bun run notes:eval --meeting ES2002a
 *   bun run notes:eval --judge off     # programmatic checks only, no Sonnet
 *   bun run notes:eval --no-ideas      # skip the lost-idea rate and its gate
 *   bun run notes:eval --corpus <dir>  # a corpus that is NOT in this repo
 *   bun run notes:eval --max-usd 0.25  # stop once the run has spent that much
 *   bun run notes:eval --ratchet       # lower the lost-idea bar to this run's rate
 *
 * THE NUMBER THIS RUN EXISTS FOR IS THE LOST-IDEA RATE. Everything else here
 * asks whether the notes are well FORMED; that one asks whether they are
 * COMPLETE, which is the question a person asks when they say "I said that,
 * where is it". It is measured against a list of the ideas in each tick,
 * written down once beside the fixture and corrected by hand afterwards
 * (`notes-eval-ideas.ts`), and it FAILS the run above the ratcheted bar in
 * `notes-eval.baseline.json` (`--ratchet` lowers it to a better run; the target
 * is five per cent) — unlike every other rate here, because its denominator is fixed rather than
 * re-derived, so it means the same thing on two different days.
 *
 * REAL MEETINGS ARE NOT IN THIS REPO. `--corpus <dir>` reads fixtures and
 * their ground truth from anywhere, which is how the rate is measured over
 * private meetings without a line of them being committed, quoted or printed.
 * Only counts and rates come out.
 *
 * WHY THIS EXISTS. Everything the note-taking behaviour asks for — paraphrase,
 * short bullets, one heading per topic, a marked guess, a link on a row that
 * was named — is a property of what a MODEL wrote, and a unit test can only
 * prove that the instruction was sent. So the instructions are checked the
 * way a person would check them: run a real meeting through the real pipeline
 * and read the notes. This does the reading, on 273 ticks instead of three.
 *
 * A RATE HERE IS OVER TICKS, NOT OVER MODEL REPLIES. The decidable checks ask
 * what the NOTES say at each tick, so one over-long bullet that nobody
 * rewrites fails every tick it survives — twenty-eight failures in a run can
 * be four bullets. That is the honest reading of "are the notes good right
 * now", which is the question a reader of a live doc actually asks, but it is
 * not "how often did the model err". Read the failure lines, which name the
 * bullet, before concluding anything about frequency.
 *
 * WHAT CAN TURN A RUN RED is the lost-idea rate and nothing else about the
 * notes' shape. A rate over a model's output is a reading, not a verdict, so
 * every behaviour reports and exits 0. The flat wall of bullets — a topic
 * left running past four with no sub-bullets and no subheading under it — is
 * decidable and cheap to see, and it prints a WARNING, because the fix for it
 * is open note-taker work: a daily job red every morning for a reason nobody
 * is going to act on today hides the day something else breaks.
 *
 * ON DEMAND ONLY. It spends money and it talks to the network, so nothing
 * runs it on a push except the `--smoke` slice, which is sized to cost cents.
 * It is not a test and it does not live in the suites: a check whose verdict
 * depends on a model's mood must never be able to turn somebody else's CI red.
 *
 * TWO KINDS OF JUDGE, and the split is deliberate. Anything decidable is
 * decided in code (`notes-quality.ts`, unit-tested) — bullet length, a topic
 * opened twice, a topic left running as a flat wall of bullets, a decision
 * with no voice on it, a named row left unlinked, a bullet copied verbatim
 * out of the transcript. Only the questions that need
 * reading comprehension go to a model: was this paraphrase faithful, does the
 * note say what was decided and by whom, was that new heading a new topic.
 * A model judging what a regex can settle is money spent on a worse answer.
 *
 * THE CORPUS is AMI (CC BY 4.0), excerpted into committed fixtures by
 * `notes-eval-fixtures.ts`. Speakers are letters; no fixture names a person.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { prose } from '../packages/core/src/index.ts';
import { createHaikuNotesComposer } from '../packages/server/src/meeting-notes-composer.ts';
import type { NoteReference, NotesComposeInput } from '../packages/server/src/meeting-notes.ts';
import {
  findInventedLinks,
  notesLinkSources,
} from '../packages/server/src/notes-invented-links.ts';
import {
  MAX_FLAT_RUN_BULLETS,
  allBullets,
  decisionsWithoutSpeaker,
  duplicateTopics,
  longFlatRuns,
  overlongBullets,
  parseNotesTopics,
  unconfirmedBullets,
  unlinkedReferences,
  verbatimBullets,
} from '../packages/server/src/notes-quality.ts';
import { median } from '../packages/server/src/notes-timing.ts';
import { readKeychainPassword } from '../packages/server/src/share/keychain.ts';
import { type SummaryCredential, authHeader } from '../packages/server/src/summarize.ts';
import { createNotesTickHarness } from '../packages/server/test/notes-tick-harness.ts';
import { EVAL_CREDENTIAL_HELP, resolveEvalCredentialFrom } from './eval-credential.ts';
import { FIXTURE_DIR, type NotesEvalFixture, staleClockWarning } from './notes-eval-fixtures.ts';
import {
  MIN_GATED_IDEAS,
  type MeetingIdeaRate,
  judgeCarried,
  ratchetLostIdeaBar,
  readTruth,
  reportIdeaRates,
  setIdeaUsageSink,
} from './notes-eval-ideas.ts';
import { type Variant, resolveVariant } from './notes-eval-variants.ts';

const JUDGE_MODEL = 'claude-sonnet-5';
/** How the judge's spend is booked, so it never merges with a variant that
 *  happens to compose on the judge's model. */
const JUDGE_LABEL = 'claude-sonnet-5 (judge)';
const NOTES_MODEL = 'claude-haiku-4-5-20251001';

/**
 * What a thousand tokens costs, per model, in dollars — input then output.
 * Used only to print what the run spent; a figure that drifts makes the
 * report wrong in a way nobody notices, so it is stated here rather than
 * buried in a multiplication.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  [NOTES_MODEL]: { input: 1 / 1_000_000, output: 5 / 1_000_000 },
  // Sonnet 5 and Opus 5 are here because `--variant sonnet|opus` composes on
  // them. A model priced at zero would report a variant as free, which is the
  // one wrong number this table must never print.
  'claude-sonnet-5': { input: 2 / 1_000_000, output: 10 / 1_000_000 },
  'claude-opus-5': { input: 5 / 1_000_000, output: 25 / 1_000_000 },
  // The judge, booked under a name of its own at Sonnet's price. `--variant
  // sonnet` composes on the same model, and one row for both would report the
  // cost of MEASURING that variant as part of what it costs to run — the one
  // confusion this whole table exists to prevent.
  [JUDGE_LABEL]: { input: 2 / 1_000_000, output: 10 / 1_000_000 },
};

/**
 * What one run may spend before it stops, in dollars.
 *
 * Bryan's number: the CI runs must not cost more than a dollar a day. A cap
 * is the only form of that promise a machine can keep — a measured estimate
 * says what yesterday cost, and the run that matters is the one where a
 * fixture grew, a retry loop misbehaved, or somebody pointed `--corpus` at
 * three hundred meetings. So the run aborts rather than reporting an overrun
 * afterwards.
 */
export const DEFAULT_MAX_USD = 1;

/** Thrown when the cap is reached, so one `catch` in main ends the run. */
export class SpendCapReached extends Error {
  constructor(
    readonly spent: number,
    readonly cap: number,
  ) {
    super(`spend cap reached: $${spent.toFixed(4)} of $${cap.toFixed(2)}`);
    this.name = 'SpendCapReached';
  }
}

let maxUsd = DEFAULT_MAX_USD;

/**
 * Has this run spent past its cap?
 *
 * A cap of zero means UNCAPPED, not "spend nothing" — `--max-usd 0` is how a
 * person says "I know what I am doing, run the whole corpus". A run that
 * spent nothing at all is never over, whatever the cap.
 */
export function overBudget(spent: number, cap: number): boolean {
  return cap > 0 && spent > cap;
}

/**
 * What a set of token counts cost, at the prices this file knows.
 *
 * CACHED TOKENS ARE PRICED SEPARATELY, and leaving them out was not a rounding
 * error. The API reports `input_tokens` as the uncached remainder only: a
 * prompt served almost entirely from cache reports a tiny `input` and carries
 * the rest in `cache_read_input_tokens`. Summing input and output alone
 * therefore priced a cached run at a fraction of its bill — and `--max-usd`,
 * which is meant to stop a runaway, read the same fraction. Cache reads bill
 * at a tenth of input and a five-minute cache write at 1.25x, so both are
 * expressed as multipliers of the model's own input price rather than as new
 * per-model numbers to keep in step.
 */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * The read-to-write ratio a cache has to beat before it is worth having.
 *
 * A token read from cache bills at 0.1x input and a token written into a
 * five-minute entry at 1.25x, against 1x for sending it plain. So caching R
 * tokens and writing W of them is cheaper than sending R + W only while
 * 0.1R + 1.25W < R + W — that is, while R/W > 0.25/0.9.
 */
export const CACHE_BREAK_EVEN_RATIO: number =
  (CACHE_WRITE_MULTIPLIER - 1) / (1 - CACHE_READ_MULTIPLIER);

/**
 * What the read and write counts SAY, in the one sentence a reader needs.
 *
 * The share served from cache is not the verdict and has hidden a losing
 * cache before: a run can serve half its prompt from cache and still cost
 * more than one that cached nothing, because every one of those reads was
 * paid for by a write at 1.25x. The ratio is the verdict, and it has a fixed
 * number to beat.
 *
 * A run that wrote nothing is not a run that paid nothing. Its reads still
 * bill at 0.1x — it is only that this run bought none of the entries it read
 * from, because they were written before the window it measured. Saying
 * "free" there would understate the bill of exactly the run whose cache is
 * working best.
 */
export function cacheVerdict(cacheRead: number, cacheWrite: number): string {
  if (cacheWrite === 0)
    return `nothing written this run — its ${cacheRead} read token(s) still bill at ${CACHE_READ_MULTIPLIER}x`;
  const ratio = cacheRead / cacheWrite;
  const verdict = ratio > CACHE_BREAK_EVEN_RATIO ? 'paying' : 'LOSING MONEY';
  return `read/write ${ratio.toFixed(2)} against ${CACHE_BREAK_EVEN_RATIO.toFixed(2)} break-even — ${verdict}`;
}

export function costOf(
  counts: Readonly<
    Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>
  >,
  prices: Readonly<Record<string, { input: number; output: number }>> = PRICES,
): number {
  let sum = 0;
  for (const [model, u] of Object.entries(counts)) {
    const price = prices[model];
    // A model with no price contributes nothing rather than throwing. A new
    // judge model must not be able to abort a run by being unpriced — but it
    // is then invisible to the cap, which is why adding one means adding its
    // price in the same commit.
    if (!price) continue;
    sum += u.input * price.input + u.output * price.output;
    sum += (u.cacheRead ?? 0) * price.input * CACHE_READ_MULTIPLIER;
    sum += (u.cacheWrite ?? 0) * price.input * CACHE_WRITE_MULTIPLIER;
  }
  return sum;
}

/**
 * A line typed by a person, seeded into every fixture's doc before the
 * meeting starts.
 *
 * Criterion 1.2 — never edit a bullet a human edited — has no examples
 * without one: a meeting where nobody types is a meeting where the rule
 * cannot be broken, and a pass rate over it would be 100% and meaningless.
 * So every tick of every fixture is an example, and the check is exact: after
 * the tick, is this line still in the accepted notes, character for
 * character.
 */
const HUMAN_LINE = 'my own note: check this against the brief before we commit';

/* ===== The behaviours, and what counts as an example of each ===== */

export interface Verdict {
  /** Did this tick satisfy the behaviour? */
  ok: boolean;
  /** Why not — printed for the failures, never for the passes. */
  detail?: string;
}

/**
 * Did this tick cite anything it was not given?
 *
 * COUNTED ON WHAT THE MODEL WROTE, not on what the doc ended up with. The
 * applier strips an invented link before it lands
 * (`notes-invented-links.ts`), so reading the notes afterwards would report a
 * flawless run no matter how often the composer invented an address — the
 * repair would hide the fault it exists to answer. This asks the composed
 * edits, with the same rule the applier uses and the same sources it is
 * given, plus the notes as they stood: a bullet regrouped from an earlier
 * tick carries that tick's citation, and it was legitimate then.
 *
 * A tick that composed no link at all is not an example of anything.
 */
export function inventedLinkVerdict(
  shot: { input?: NotesComposeInput; composed: readonly prose.BlockEdit[] },
  notesBefore: string,
): Verdict | null {
  const input = shot.input;
  if (!input) return null;
  if (!shot.composed.some((e) => 'markdown' in e && e.markdown.includes(']('))) return null;
  const given = notesLinkSources({ ...input, ...input.tick });
  const invented = findInventedLinks(shot.composed, {
    urls: given.urls,
    text: [...given.text, notesBefore],
  });
  return { ok: invented.length === 0, detail: invented.join(', ') };
}

/** One behaviour's tally across the run. */
export class Behaviour {
  examples = 0;
  passes = 0;
  readonly failures: string[] = [];
  constructor(
    readonly id: string,
    readonly what: string,
  ) {}
  see(verdict: Verdict | null, where: string): void {
    // Null means "this tick is not an example" — a tick that named no board
    // row says nothing about linking, and counting it as a pass would inflate
    // every rate with ticks that could not have failed.
    if (!verdict) return;
    this.examples++;
    if (verdict.ok) this.passes++;
    else this.failures.push(`${where}: ${verdict.detail ?? 'failed'}`);
  }
  get rate(): number {
    return this.examples === 0 ? 0 : this.passes / this.examples;
  }
  /**
   * How many DIFFERENT things failed, as against how many ticks a failure was
   * visible on.
   *
   * The decidable checks read the NOTES at each tick, so one bad bullet
   * written on tick one fails every tick it survives — forty failures can be
   * one line. The rate is still the honest answer to "are the notes good
   * right now", but it is a terrible answer to "how often did the writer
   * err", and a table comparing two methods on the rate alone reads a single
   * unlucky bullet as a systematic gap. So both numbers print.
   */
  get distinctFailures(): number {
    // The meeting and the text, without the tick: the same bullet failing on
    // twelve ticks of one meeting is one thing, and the same wording in two
    // different meetings is two.
    return new Set(this.failures.map((f) => f.replace(/ tick \d+:/, ':'))).size;
  }
}

/* ===== Usage accounting ===== */

interface Usage {
  input: number;
  output: number;
  /** Served from an existing cache entry, billed at a tenth of input. */
  cacheRead: number;
  /** Written into a new cache entry, billed at 1.25x input (5-minute TTL). */
  cacheWrite: number;
  calls: number;
}

const usage: Record<string, Usage> = {};

function recordUsage(
  model: string,
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
): void {
  const u = (usage[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 });
  u.input += input;
  u.output += output;
  u.cacheRead += cacheRead;
  u.cacheWrite += cacheWrite;
  u.calls++;
  // Checked AFTER the call is counted, not before: the cap is on what this
  // run has actually spent, and a check beforehand would have to guess the
  // size of a reply nobody has seen yet. So the overshoot is bounded by one
  // call rather than by a guess.
  if (overBudget(totalCost(), maxUsd)) throw new SpendCapReached(totalCost(), maxUsd);
}

function totalCost(): number {
  return costOf(usage);
}

/**
 * The composer's own fetch, wrapped so the run can price itself.
 *
 * Reading `usage` off the response rather than counting tokens separately:
 * the billed number is the one in the reply, and a second count_tokens call
 * would be both an estimate and an expense.
 */
function countingFetch(model: string): typeof fetch {
  const wrapped = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const res = await globalThis.fetch(input as string, init);
    const body = await res
      .clone()
      .json()
      .catch(() => null);
    const u = (
      body as {
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      } | null
    )?.usage;
    if (u) {
      recordUsage(
        model,
        u.input_tokens ?? 0,
        u.output_tokens ?? 0,
        u.cache_read_input_tokens ?? 0,
        u.cache_creation_input_tokens ?? 0,
      );
    }
    return res;
  };
  // Bun's `fetch` type carries a `preconnect`; nothing here calls it, and the
  // composer only ever invokes the function itself.
  return Object.assign(wrapped, { preconnect: globalThis.fetch.preconnect }) as typeof fetch;
}

/* ===== The model judge ===== */

const JUDGE_SYSTEM = [
  'You are grading a live meeting note-taker, strictly and briefly.',
  '',
  'You get the speech from one moment of a meeting, the notes as they stood',
  'before it, and the notes after. Judge ONLY what the new writing does.',
  '',
  'Record every verdict with the record_verdict tool. Each behaviour carries',
  'its own verdict AND its own reason — a reason that explains a different',
  'behaviour is worse than none, because it is read as evidence about the one',
  'it is filed under. Each reason is AT MOST TWELVE WORDS naming what failed,',
  'or empty when the verdict holds.',
  '',
  "- paraphrased: the new notes say what the speech MEANT in the writer's own",
  '  short sentences. False if a note reads as a transcript line, quotes',
  "  filler, or keeps the speaker's syntax.",
  '- covers: what the speech actually settled is in the notes — the point',
  '  discussed, and where the speech had them, why it matters, what was',
  '  decided and by whom, what happens next. False if a decision or an owner',
  '  was said and is missing. True when the speech settled nothing and the',
  '  notes correctly say little.',
  '- topics: headings match the discussion. False if a new heading was opened',
  '  for a topic already present, or if the speech clearly changed subject and',
  '  everything was still filed under the old heading.',
  '- guesses: anything uncertain is marked "(unconfirmed)" rather than',
  '  asserted. False if the notes state as fact something the speech left',
  '  ambiguous or garbled. True if there was nothing uncertain.',
  '- together: related points sit together rather than being repeated or',
  '  scattered. False if the same point now appears twice in different places.',
].join('\n');

/**
 * The judge's answer as a TOOL rather than as prose to be parsed.
 *
 * Two runs were lost to the judge writing its way past a token budget and
 * truncating the JSON mid-object. The obvious fix — prefill the opening
 * brace — this model refuses outright ("does not support assistant message
 * prefill"). A forced tool call is the shape the API itself enforces, so
 * there is no reply to parse and no way to half-answer.
 */
const VERDICT_TOOL = {
  name: 'record_verdict',
  description: 'Record one verdict, with its reason, for each behaviour graded.',
  input_schema: {
    type: 'object' as const,
    properties: Object.fromEntries(
      ['paraphrased', 'covers', 'topics', 'guesses', 'together'].map((field) => [
        field,
        {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            why: { type: 'string', description: 'At most twelve words, or empty when ok.' },
          },
          required: ['ok', 'why'],
        },
      ]),
    ),
    required: ['paraphrased', 'covers', 'topics', 'guesses', 'together'],
  },
};

/**
 * Why judge replies could not be read, this run.
 *
 * A judge that answers unusably is not evidence about the note-taker, so its
 * tick is dropped — and a drop that says nothing is how five behaviours
 * quietly fell to twelve examples each. Collected here and printed with the
 * report, so a sample that shrank says why.
 */
const judgeUnread = new Set<string>();

/** One judged behaviour: did it hold, and why not. */
interface JudgedField {
  ok: boolean;
  why: string;
}

async function judge(
  key: SummaryCredential,
  before: string,
  after: string,
  transcript: string,
): Promise<Record<string, JudgedField> | null> {
  const user = [
    `Speech in this moment:\n${transcript}`,
    `Notes before:\n${before || '(none yet)'}`,
    `Notes after:\n${after}`,
    // Without this the judge marks the note-taker down for the seeded human
    // line — it reads as an off-topic bullet, which is exactly what it is,
    // and the note-taker is forbidden from touching it. Grading it would
    // score the fixture rather than the behaviour.
    `One bullet was typed by a person and the note-taker may not change it. It is not its work and is not to be graded:\n- ${HUMAN_LINE}`,
  ].join('\n\n');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeader(key),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      // Five verdicts each carrying their own sentence. 300 was the budget
      // for ONE reason and it silently truncated the JSON of the five-reason
      // reply, which failed to parse, which returned null, which dropped the
      // tick — taking the judged behaviours from 32 examples to 12 with
      // nothing in the output saying so. Sized for the reply that is now
      // asked for, and a truncation is reported rather than dropped.
      max_tokens: 900,
      system: JUDGE_SYSTEM,
      tools: [VERDICT_TOOL],
      tool_choice: { type: 'tool', name: VERDICT_TOOL.name },
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    // The status only. A body can echo the prompt, and the prompt carries
    // meeting speech. This line used to be a bare `return null`, which is how
    // a run once reported no judged examples and no reason for it.
    judgeUnread.add(`the judge call returned HTTP ${res.status}`);
    return null;
  }
  const body = (await res.json()) as {
    content?: Array<{ type?: string; name?: string; input?: unknown }>;
    stop_reason?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  recordUsage(JUDGE_LABEL, body.usage?.input_tokens ?? 0, body.usage?.output_tokens ?? 0);
  const call = body.content?.find((b) => b.type === 'tool_use' && b.name === VERDICT_TOOL.name);
  if (!call?.input || typeof call.input !== 'object') {
    judgeUnread.add(
      body.stop_reason === 'max_tokens'
        ? 'the judge ran out of output tokens before recording a verdict'
        : 'the judge answered without calling record_verdict',
    );
    return null;
  }
  const out: Record<string, JudgedField> = {};
  for (const [field, value] of Object.entries(call.input as Record<string, unknown>)) {
    // The schema requires the object form, but a schema is a request and this
    // reads whatever actually arrived: a bare boolean is still an answer, and
    // dropping the tick over the wrapper would shrink the sample silently.
    if (typeof value === 'boolean') out[field] = { ok: value, why: '' };
    else if (value && typeof value === 'object') {
      const o = value as { ok?: unknown; why?: unknown };
      out[field] = { ok: o.ok === true, why: typeof o.why === 'string' ? o.why : '' };
    }
  }
  return out;
}

/* ===== The run ===== */

interface Options {
  smoke: boolean;
  meetings: string[];
  judgePerMeeting: number;
  key: SummaryCredential;
  /** Where the fixtures live. `--corpus <dir>` points it at a corpus that is
   *  NOT in this repo — real meetings are private and never committed. */
  corpusDir: string;
  /** Measure the lost-idea rate against the ground truth beside each fixture,
   *  and let it fail the run. */
  ideas: boolean;
  /** Which way of note-taking this run is measuring. */
  variant: Variant;
  /** Where each meeting's final notes are written, so a person can read what
   *  the rate is a rate OVER. Absent, nothing is written. */
  dumpDir?: string;
}

function loadFixtures(only: readonly string[], dir: string): NotesEvalFixture[] {
  const fixtures = readdirSync(dir)
    // `.ideas.json` files are the ground truth beside a fixture, not fixtures.
    .filter((f) => f.endsWith('.json') && !f.endsWith('.ideas.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as NotesEvalFixture)
    .filter((f) => only.length === 0 || only.includes(f.meeting))
    .sort((a, b) => a.meeting.localeCompare(b.meeting));
  // A FIXTURE OUTLIVES THE CLOCKS IT WAS CUT WITH, and a rate read off the
  // wrong tick rate is wrong without looking wrong. Said before the run rather
  // than in the report, so nobody spends an hour of model calls on it first.
  for (const fixture of fixtures) {
    const stale = staleClockWarning(fixture);
    if (stale) console.log(`WARNING: ${stale}`);
  }
  return fixtures;
}

/** `/workspaces/w-eval?task=t-3` → `t-3`, so the harness rebuilds the row's
 *  URL exactly as the fixture's board states it. */
function taskIdOf(url: string): string {
  return new URL(url, 'http://x').searchParams.get('task') ?? url;
}

async function runMeeting(
  fixture: NotesEvalFixture,
  opts: Options,
  behaviours: Record<string, Behaviour>,
  ticksWanted: number,
): Promise<{ rate: MeetingIdeaRate | null; expanded: MeetingIdeaRate | null }> {
  const composeModel = opts.variant.model ?? NOTES_MODEL;
  // The raw key, for the two callers that still want one: the composer and
  // the variants' own helper calls. An access-token run leaves them without
  // one — which is what `createHaikuNotesComposer` already reads as "no
  // dedicated key", and it says so rather than sending an empty header.
  const rawKey = opts.key.kind === 'key' ? opts.key.value : undefined;
  const composer = createHaikuNotesComposer({
    apiKey: rawKey,
    fetchImpl: countingFetch(composeModel),
    ...(opts.variant.model ? { model: opts.variant.model } : {}),
    ...(opts.variant.maxTokens ? { maxTokens: opts.variant.maxTokens } : {}),
    ...(opts.variant.effort ? { effort: opts.variant.effort } : {}),
    ...(opts.variant.instructions
      ? { instructions: (): string => opts.variant.instructions as string }
      : {}),
  });
  if (!composer) throw new Error('no composer: the dedicated key did not resolve');
  const hooks = opts.variant.begin({ credential: opts.key, fetchFor: countingFetch });
  // The transcript of the tick a compose is running for. The hooks are handed
  // it rather than re-deriving it, because `input.tick.turns` on a retry tick
  // is not the same list the harness spoke.
  let tickTranscript = '';
  let tickNumber = 0;

  const ticks = fixture.ticks.slice(0, ticksWanted);
  // Which ticks the model judge reads. Spread across the meeting rather than
  // taken from the front: the first ticks of a meeting are its easiest, and a
  // judge that only ever saw them would report on a meeting that had not
  // started.
  const step = Math.max(1, Math.floor(ticks.length / Math.max(1, opts.judgePerMeeting)));
  const judged = new Set(
    Array.from({ length: opts.judgePerMeeting }, (_, i) => i * step).filter(
      (i) => i < ticks.length,
    ),
  );

  const harness = createNotesTickHarness({
    // A doc and a meeting id OF THIS MEETING'S OWN. The harness defaults both
    // ('d-meeting', 'm1'), which was harmless while meetings ran one at a
    // time and is not once `--jobs` runs four at once: four sessions sharing
    // one doc id share every log line and every piece of state keyed on it.
    // CW_NOTES_EVAL_SHARED_IDS=1 restores the collision deliberately. It is
    // the positive control for the finding: without it, "the collapse stopped
    // happening" is a claim about a run that also changed nothing else.
    ...(process.env.CW_NOTES_EVAL_SHARED_IDS === '1'
      ? {}
      : { docId: `d-${fixture.meeting}`, meetingId: `m-${fixture.meeting}` }),
    doc: `## Meeting notes\n\n- ${HUMAN_LINE}\n`,
    docTitle: `${fixture.meeting} (AMI)`,
    workspaceId: 'w-eval',
    tasks: fixture.board.map((b) => ({ id: taskIdOf(b.url), title: b.title, status: 'todo' })),
    // A real compose, and its reply grows with the notes: by the twentieth
    // tick of a meeting the model is rewriting two pages. The composer's own
    // timeout is 30s and this has to sit above it, or a tick that WOULD have
    // landed is recorded as a failure and every tick behind it fails too —
    // the composes are serialized on one chain.
    tickTimeoutMs: 60_000,
    compose: async (input: NotesComposeInput) => {
      const extra = await hooks.before(input, tickNumber, tickTranscript);
      const edits = await composer.compose({ ...input, ...extra });
      // CW_NOTES_EVAL_OPS=1 prints the op mix per tick. A meeting whose notes
      // end EMPTY after fifty ticks is not a note-taker that wrote nothing —
      // it is one that wrote and then deleted, and the two look identical in
      // every other number this run prints.
      if (process.env.CW_NOTES_EVAL_OPS === '1') {
        // The ids an edit names, and — for a delete — the words it is about to
        // remove. A tick that took the notes from forty bullets to none is
        // only legible if the log says WHAT it deleted, not just that it
        // deleted something.
        const byId = new Map(input.outline.map((e) => [e.id, e]));
        const mix = edits
          .map((e) => {
            const id = 'blockId' in e ? e.blockId : 'headingId' in e ? e.headingId : undefined;
            if (e.op !== 'delete_block') return `${e.op}(${id ?? '-'})`;
            const gone = byId.get(id as string);
            return `delete_block(${id}: ${gone?.kind ?? '?'} "${(gone?.text ?? '?').slice(0, 40)}")`;
          })
          .join(' ');
        console.log(
          `  [ops] ${fixture.meeting} tick ${tickNumber}: outline=${input.outline.length} ` +
            `heading=${input.notesHeadingId ?? 'none'} :: ${mix || '(none)'}`,
        );
      }
      return edits;
    },
  });

  let before = '';
  // Ticks whose compose never ran. Counted and reported rather than assumed
  // away: a run that quietly measured 250 of 273 ticks would still print a
  // pass rate, and the rate would be over a sample nobody could see.
  //
  // These are composes that FAILED — a timeout, or the API refusing. The
  // words are not lost: a failed compose carries its turns into the next
  // tick, which is what the live pipeline does too. What is lost is the tick
  // as an EXAMPLE, which is why the count is printed next to the totals and
  // the reasons are printed under them.
  let uncomposed = 0;
  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i]!;
    const transcript = tick.turns.map((t) => `${t.speaker}: ${t.text}`).join('\n');
    tickTranscript = transcript;
    tickNumber = i + 1;
    let shot: Awaited<ReturnType<typeof harness.tick>>;
    try {
      shot = await harness.speak(...tick.turns.map((t) => ({ speaker: t.speaker, text: t.text })));
    } catch (err) {
      // A refused or timed-out compose is a fact about the run, not about the
      // behaviour: it is reported and the tick is not counted as an example.
      console.error(`  ${fixture.meeting} tick ${i + 1}: compose failed — ${String(err)}`);
      continue;
    }
    const notes = shot.notes;
    if (process.env.CW_NOTES_EVAL_OPS === '1') {
      console.log(
        `  [doc] ${fixture.meeting} tick ${i + 1}: ${allBullets(notes).length} bullets in the ` +
          `notes section, ${allBullets(shot.markdown).length} in the whole doc`,
      );
    }
    await hooks.after(notes, i + 1, transcript);
    const where = `${fixture.meeting} tick ${i + 1}`;
    if (!shot.input) uncomposed++;
    const references = (shot.input?.references ?? []) as readonly NoteReference[];

    /* --- 1.1 readability, the decidable half --- */
    const over = overlongBullets(notes);
    behaviours.length!.see(
      {
        ok: over.length === 0,
        detail: over.map((o) => `${o.words}w: ${o.bullet.slice(0, 60)}`).join(' | '),
      },
      where,
    );
    const copied = verbatimBullets(notes, transcript);
    behaviours.verbatim!.see({ ok: copied.length === 0, detail: copied[0]?.slice(0, 80) }, where);

    /* --- 1.2 a person's bullet is untouched --- */
    behaviours.human!.see(
      {
        ok: notes.includes(HUMAN_LINE),
        detail: 'the seeded human bullet is no longer in the accepted notes',
      },
      where,
    );

    /* --- 1.3 one heading per topic --- */
    const dupes = duplicateTopics(notes);
    behaviours.oneHeading!.see({ ok: dupes.length === 0, detail: dupes.join(', ') }, where);
    // A tick with enough notes to organise but no heading at all is a flat
    // list, which is the shape this behaviour replaced. Fewer than four
    // bullets is not yet a document with topics in it.
    const bullets = allBullets(notes).length;
    behaviours.organised!.see(
      bullets < 4
        ? null
        : {
            ok: parseNotesTopics(notes).some((t) => t.heading.length > 0),
            detail: `${bullets} bullets and no topic heading`,
          },
      where,
    );
    // A topic that has grown past the bar and never been regrouped. Every
    // tick it survives is a failure, the same way an over-long bullet is:
    // the question is what the notes look like NOW, not how often the model
    // erred. The detail names the heading so a reader can go and look at it.
    const walls = longFlatRuns(notes);
    behaviours.flatRuns!.see(
      {
        ok: walls.length === 0,
        detail: walls
          .map((r) => `${r.bullets.length} flat bullets under "${r.heading || '(no heading)'}"`)
          .join(' | '),
      },
      where,
    );

    /* --- 1.4 reference hygiene --- */
    behaviours.links!.see(
      references.length === 0
        ? null
        : (() => {
            const missed = unlinkedReferences(notes, references);
            return { ok: missed.length === 0, detail: `not linked: ${missed.join(', ')}` };
          })(),
      where,
    );
    behaviours.inventedLinks!.see(inventedLinkVerdict(shot, before), where);
    const unattributed = decisionsWithoutSpeaker(notes);
    behaviours.speakers!.see(
      { ok: unattributed.length === 0, detail: unattributed[0]?.slice(0, 80) },
      where,
    );

    /* --- the model's half --- */
    if (judged.has(i) && opts.judgePerMeeting > 0) {
      const verdict = await judge(opts.key, before, notes, transcript);
      if (verdict) {
        for (const [key, id] of [
          ['paraphrased', 'paraphrase'],
          ['covers', 'covers'],
          ['topics', 'topicChange'],
          ['guesses', 'unconfirmed'],
          ['together', 'together'],
        ] as const) {
          // A field the judge did not answer is not an example of anything.
          // Scoring it as a failure would grade the judge's JSON, not the
          // note-taker.
          const field = verdict[key];
          if (!field) continue;
          behaviours[id]!.see({ ok: field.ok, detail: field.why }, where);
        }
      }
    }
    before = notes;
  }
  await harness.end();

  // THE LOST-IDEA RATE, judged against the notes the meeting was LEFT with.
  // That is what a person opens afterwards, and it is the only reading under
  // which a retry that landed two ticks later counts as coverage rather than
  // as a miss.
  let rate: MeetingIdeaRate | null = null;
  let expanded: MeetingIdeaRate | null = null;
  const finalNotes = harness.notes();
  if (opts.dumpDir) {
    writeFileSync(
      join(opts.dumpDir, `${fixture.meeting}.${opts.variant.name}.md`),
      `${harness.notes()}\n`,
    );
  }
  if (opts.ideas) {
    const truth = readTruth(opts.corpusDir, fixture.meeting);
    if (!truth) {
      console.log(`  ${fixture.meeting}: no idea ground truth beside the fixture`);
    } else {
      // The notes as WRITTEN, and — for a variant whose whole claim is that
      // the detail sits behind a link — the notes as a reader following those
      // links would see them. Both, because either alone is a different
      // question, and reporting only the second would credit an anchor for
      // words the note itself never carried.
      const readings: Array<{ notes: string; row: MeetingIdeaRate }> = [
        {
          notes: finalNotes,
          row: { meeting: fixture.meeting, ideas: 0, lost: 0, unjudged: 0, examples: [] },
        },
      ];
      if (opts.variant.judgeExpanded && hooks.expand) {
        readings.push({
          notes: hooks.expand(finalNotes),
          row: { meeting: fixture.meeting, ideas: 0, lost: 0, unjudged: 0, examples: [] },
        });
      }
      for (const entry of truth.ticks) {
        // Only the ticks this run actually played. A slice measured against
        // the whole meeting's ground truth would report every idea after the
        // slice as lost.
        if (entry.tick > ticks.length) continue;
        for (const reading of readings) {
          const verdicts = await judgeCarried(opts.key, entry.ideas, reading.notes);
          if (!verdicts) {
            reading.row.unjudged += entry.ideas.length;
            continue;
          }
          entry.ideas.forEach((idea, i) => {
            reading.row.ideas++;
            if (verdicts[i]) return;
            reading.row.lost++;
            if (reading.row.examples.length < 5)
              reading.row.examples.push(`tick ${entry.tick}: ${idea}`);
          });
        }
      }
      rate = readings[0]!.row;
      expanded = readings[1]?.row ?? null;
    }
  }

  const marked = unconfirmedBullets(harness.notes()).length;
  // THE TWO NUMBERS THE LATENCY TICKET IS ABOUT, printed beside the coverage
  // number they trade against: a note-taker can always be faster by writing
  // less. `turnsLost` is the lost-idea rate — settled turns no successful
  // compose ever carried — and the latencies are compose-and-write only,
  // because this harness fires its own ticks (see `NotesTickHarness.timing`).
  const latencies = harness
    .timing()
    .rows()
    .map((r) => r.settledToWrittenMs)
    .filter((v): v is number => v !== null);
  const lost = harness.summary()?.turnsLost ?? 0;
  if (latencies.length > 0) {
    console.log(
      `  ${fixture.meeting}: ${lost} turn(s) in no note, compose→written median ` +
        `${Math.round(median(latencies) ?? 0)}ms, worst ${Math.round(Math.max(...latencies))}ms`,
    );
  }
  console.log(
    `  ${fixture.meeting}: ${ticks.length} ticks, ${allBullets(harness.notes()).length} bullets, ` +
      `${parseNotesTopics(harness.notes()).filter((t) => t.heading).length} topics, ` +
      `${marked} marked unconfirmed, ` +
      // The count over the FINAL notes, which is what the room was left
      // reading. The behaviour table counts the ticks a wall survived; this
      // counts the walls still standing when the meeting ended, and a zero
      // is worth printing because it is the number that should be there.
      `${longFlatRuns(harness.notes()).length} topics over ${MAX_FLAT_RUN_BULLETS} flat bullets` +
      (uncomposed > 0 ? `, ${uncomposed} never composed` : ''),
  );
  // Distinct reasons, not one line per failure: twenty timeouts are one fact
  // about the run, and printing them twenty times buries the meeting totals.
  for (const reason of new Set(harness.errors)) {
    console.log(`    ${fixture.meeting}: ${reason}`);
  }
  return { rate, expanded };
}

function report(
  behaviours: Record<string, Behaviour>,
  ideaRows: readonly MeetingIdeaRate[],
  gateIdeas: boolean,
  quote: boolean,
  ratchet = false,
): number {
  console.log(
    '\nBehaviour                                  examples   pass rate   distinct misses',
  );
  console.log('-'.repeat(83));
  let thin = 0;
  for (const b of Object.values(behaviours)) {
    const rate = b.examples === 0 ? '     —' : `${(b.rate * 100).toFixed(0).padStart(5)}%`;
    const distinct = b.failures.length === 0 ? '' : `${b.distinctFailures} of ${b.failures.length}`;
    console.log(
      `${b.what.padEnd(42)} ${String(b.examples).padStart(8)}   ${rate}   ${distinct.padStart(15)}`,
    );
    if (b.examples < 25) thin++;
  }
  console.log('-'.repeat(83));
  // A failure line quotes the bullet that failed, and a bullet is the meeting
  // restated. Off-repo corpora are private meetings, so they get the count
  // and nothing else.
  for (const b of Object.values(behaviours)) {
    if (b.failures.length === 0) continue;
    if (!quote) {
      console.log(`\n${b.what} — ${b.failures.length} failures. Text withheld: private corpus.`);
      continue;
    }
    console.log(`\n${b.what} — ${b.failures.length} failures, first five:`);
    for (const f of b.failures.slice(0, 5)) console.log(`  ${f}`);
  }
  if (judgeUnread.size > 0) {
    console.log('\nJudge replies that could not be read (their ticks are not examples):');
    for (const reason of judgeUnread) console.log(`  ${reason}`);
  }
  console.log('\nSpend:');
  for (const [model, u] of Object.entries(usage)) {
    // Through `costOf` rather than a second copy of the formula here. The
    // inline copy is what printed a cached run at a fraction of its bill
    // after the totals had already learned better.
    const cost = costOf({ [model]: u });
    console.log(
      `  ${model}: ${u.calls} calls, ${u.input} in / ${u.output} out` +
        // Printed only when the prompt was cacheable at all, so a run against
        // an uncached path reads exactly as it always did. `cache read` is
        // also the only honest answer to "is the cache working": a
        // `cache_control` marker on a prompt below the model's minimum
        // cacheable size is ignored silently, and a zero here is what says so.
        (u.cacheRead + u.cacheWrite > 0
          ? `, ${u.cacheRead} cache read / ${u.cacheWrite} cache write` +
            ` (${((100 * u.cacheRead) / Math.max(1, u.input + u.cacheRead + u.cacheWrite)).toFixed(0)}% of prompt served from cache,` +
            ` ${cacheVerdict(u.cacheRead, u.cacheWrite)})`
          : '') +
        `, $${cost.toFixed(4)}`,
    );
  }
  console.log(`  total: $${totalCost().toFixed(4)}`);
  if (thin > 0) console.log(`\n${thin} behaviour(s) saw fewer than 25 examples.`);
  // Both verdicts are computed, and both are printed, before either exits.
  // A run that stopped at the first failure would hide the number the row is
  // about behind a formatting one.
  const ideaCode = reportIdeaRates(ideaRows, gateIdeas, quote);
  if (ratchet && gateIdeas && ideaCode === 0 && ideaRows.length > 0) {
    const ideas = ideaRows.reduce((n, r) => n + r.ideas, 0);
    const lost = ideaRows.reduce((n, r) => n + r.lost, 0);
    if (ideas >= MIN_GATED_IDEAS) {
      const bar = ratchetLostIdeaBar(
        lost / ideas,
        `${new Date().toISOString().slice(0, 10)}: ${ideaRows.length} meeting(s), ${ideas} ideas, ${((lost / ideas) * 100).toFixed(1)}% lost`,
      );
      console.log(`Bar now ${(bar * 100).toFixed(1)}%.`);
    }
  }
  const walls = behaviours.flatRuns!;
  if (walls.failures.length > 0) {
    console.log(
      `\nWARNING: ${walls.failures.length} tick(s) left a topic running past ` +
        `${MAX_FLAT_RUN_BULLETS} flat bullets. The instructions ask for the topic's points ` +
        'to be gathered into groups once it passes the bar; raise the structure, not the bar. ' +
        'Not failing the run: this is open note-taker work, and a daily job that is red for a ' +
        'known reason hides the day something else breaks.',
    );
  }
  return ideaCode;
}

async function main(argv: string[]): Promise<number> {
  const smoke = argv.includes('--smoke');
  const at = argv.indexOf('--meeting');
  const meetings = at >= 0 && argv[at + 1] ? [argv[at + 1]!] : [];
  const keyAt = argv.indexOf('--api-key');
  const judgeAt = argv.indexOf('--judge');
  const judgeOff = judgeAt >= 0 && argv[judgeAt + 1] === 'off';
  // `--judge ideas` keeps the number the run exists for and drops the
  // behaviour half of the model judge. A variant sweep reads the lost-idea
  // rate over and over and the behaviour verdicts once; paying Sonnet for six
  // reading-comprehension calls a meeting on every variant is money spent on
  // a column nobody is comparing.
  const judgeIdeasOnly = judgeAt >= 0 && argv[judgeAt + 1] === 'ideas';
  const variantAt = argv.indexOf('--variant');
  const variant = resolveVariant(variantAt >= 0 ? (argv[variantAt + 1] ?? '') : 'baseline');
  const jobsAt = argv.indexOf('--jobs');
  // Meetings are independent — separate harnesses, separate docs, separate
  // ledgers — so they run side by side. Serially a full run is the sum of
  // eight meetings' worth of serialized composes, which is most of an hour
  // per variant and the reason a sweep would not fit in a day.
  const jobs = Math.max(1, jobsAt >= 0 ? Number(argv[jobsAt + 1]) || 1 : 1);
  const dumpAt = argv.indexOf('--dump-notes');
  const dumpDir = dumpAt >= 0 ? argv[dumpAt + 1] : undefined;
  if (dumpDir) mkdirSync(dumpDir, { recursive: true });
  const capAt = argv.indexOf('--max-usd');
  if (capAt >= 0) {
    const asked = Number(argv[capAt + 1]);
    if (!Number.isFinite(asked) || asked < 0) {
      console.error(`--max-usd wants a number of dollars, not "${argv[capAt + 1]}".`);
      return 2;
    }
    maxUsd = asked;
  }
  // Every model call this run makes is priced against one budget, this file's
  // and the idea judge's alike. The sink is cleared in the `finally` below so
  // a second run in the same process cannot inherit it.
  setIdeaUsageSink(recordUsage);
  // THE EVAL'S OWN CREDENTIAL, never the live meeting's — see
  // `eval-credential.ts`. A sweep that could exhaust prod's key is a
  // measurement job with the power to stop a meeting taking notes.
  const key = resolveEvalCredentialFrom(
    keyAt >= 0 ? argv[keyAt + 1] : undefined,
    readKeychainPassword,
    process.env,
  );
  if (!key) {
    console.error(EVAL_CREDENTIAL_HELP);
    return 2;
  }

  // Every model call this run makes is priced against one budget — the
  // note-taker's, the variant's helpers', and both judges'. The idea judge
  // runs on the behaviour judge's model, so its spend is relabelled on the way
  // in: one row for MEASURING, separate from a `--variant sonnet` that
  // composes on the same model. The sink is cleared in the `finally` below so
  // a second run in the same process cannot inherit it.
  setIdeaUsageSink((model, input, output) =>
    recordUsage(model === JUDGE_MODEL ? JUDGE_LABEL : model, input, output),
  );

  const behaviours: Record<string, Behaviour> = {
    length: new Behaviour('1.1', 'Bullets: 20 words or fewer'),
    verbatim: new Behaviour('1.1', 'Bullets: not copied from the transcript'),
    paraphrase: new Behaviour('1.1', 'Paraphrased into written sentences'),
    covers: new Behaviour('1.1', 'Covers discussed / decided / next'),
    together: new Behaviour('1.1', 'Related points kept together'),
    human: new Behaviour('1.2', "A person's bullet is never edited"),
    oneHeading: new Behaviour('1.3', 'One heading per topic'),
    organised: new Behaviour('1.3', 'Notes are organised under topics'),
    flatRuns: new Behaviour('1.3', `No topic runs past ${MAX_FLAT_RUN_BULLETS} flat bullets`),
    topicChange: new Behaviour('1.3', 'A new heading means a new topic'),
    links: new Behaviour('1.4', 'A named board row is linked'),
    inventedLinks: new Behaviour('1.4', 'No link the tick was not given'),
    speakers: new Behaviour('1.4', 'Decisions and questions keep a speaker'),
    unconfirmed: new Behaviour('1.4', 'Uncertain points marked unconfirmed'),
  };

  const corpusAt = argv.indexOf('--corpus');
  const corpusDir = corpusAt >= 0 && argv[corpusAt + 1] ? argv[corpusAt + 1]! : FIXTURE_DIR;
  // On by default for a full run, because the rate is the point of the corpus;
  // `--no-ideas` is for a formatting-only pass that must not spend a judge, and
  // `--judge off` means NO model judge at all — the idea judge included.
  const ideas = !judgeOff && !argv.includes('--no-ideas');
  const fixtures = loadFixtures(
    smoke && corpusDir === FIXTURE_DIR ? ['ES2002a'] : meetings,
    corpusDir,
  );
  if (fixtures.length === 0) throw new Error('No fixtures matched. Run notes-eval-fixtures.ts?');
  const opts: Options = {
    smoke,
    meetings,
    // The smoke slice judges ONE tick: the CI job is there to prove the
    // harness still runs end to end, not to measure anything.
    judgePerMeeting: judgeOff || judgeIdeasOnly ? 0 : smoke ? 1 : 6,
    key,
    corpusDir,
    ideas,
    variant,
    ...(dumpDir ? { dumpDir } : {}),
  };
  const ticksWanted = smoke ? 3 : Number.POSITIVE_INFINITY;

  console.log(
    `${smoke ? 'Smoke slice' : 'Full run'}: variant ${variant.name}, ${fixtures.length} meeting(s), ` +
      `notes on ${variant.model ?? NOTES_MODEL}, behaviour judge ` +
      `${opts.judgePerMeeting > 0 ? JUDGE_MODEL : 'off'}, idea judge ${ideas ? JUDGE_MODEL : 'off'}` +
      `, ${jobs} meeting(s) at a time`,
  );
  const started = Date.now();
  const ideaRows: MeetingIdeaRate[] = [];
  const expandedRows: MeetingIdeaRate[] = [];
  const queue = [...fixtures];
  try {
    const workers = Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      for (;;) {
        const fixture = queue.shift();
        if (!fixture) return;
        const out = await runMeeting(fixture, opts, behaviours, ticksWanted);
        if (out.rate) ideaRows.push(out.rate);
        if (out.expanded) expandedRows.push(out.expanded);
      }
    });
    // SETTLED, not `Promise.all`. The cap is thrown from inside one worker,
    // and the others are still in flight: `all` would reject while they kept
    // running, which turns their own throws into unhandled rejections and
    // leaves the spend still climbing after the message said it stopped.
    // So every worker is awaited, and then the first failure is re-thrown.
    // The overshoot is the calls already in flight, not another meeting.
    const settled = await Promise.allSettled(workers);
    const failed = settled.find((r) => r.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  } catch (err) {
    if (!(err instanceof SpendCapReached)) throw err;
    // Print what was spent before saying anything else: the number is the
    // reason the run stopped, and a reader who sees only "aborted" goes
    // looking for a bug.
    console.log(`\nSpend before the cap stopped it: $${totalCost().toFixed(4)}`);
    for (const [model, u] of Object.entries(usage)) {
      console.log(`  ${model}: ${u.calls} calls, ${u.input} in / ${u.output} out`);
    }
    console.error(
      `\nSTOPPED: this run reached its $${err.cap.toFixed(2)} cap and did not finish. ` +
        'Nothing here is a verdict — the meetings it did not reach were not measured. ' +
        'Raise it with --max-usd if the corpus genuinely grew; otherwise find what ' +
        'started calling more than it used to.',
    );
    return 1;
  } finally {
    setIdeaUsageSink(null);
  }
  // Rows come back in whatever order the meetings finished. A table that
  // reorders itself between runs cannot be diffed against another variant's.
  ideaRows.sort((a, b) => a.meeting.localeCompare(b.meeting));
  expandedRows.sort((a, b) => a.meeting.localeCompare(b.meeting));
  console.log(`\nRan in ${Math.round((Date.now() - started) / 1000)}s.`);
  // One thing turns a verdict red: the lost-idea rate. It is measured against
  // a fixed ground truth, so it means the same thing every run, and it gates
  // on every run that measured it. The flat-wall check is a SHAPE the notes
  // may not have, and it warns rather than fails until the note-taker fix
  // lands, so a daily run is red only when the harness itself breaks.
  // A corpus outside this repo is a private meeting corpus by construction —
  // that is the only reason `--corpus` exists. Its examples never print.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const quote = !relative(repoRoot, resolve(corpusDir)).startsWith('..');
  const code = report(behaviours, ideaRows, ideas, quote, argv.includes('--ratchet'));
  if (expandedRows.length > 0) {
    console.log(
      '\nThe same notes, read with every anchor followed — what a person who ' +
        'clicks through sees, not what the page says:',
    );
    reportIdeaRates(expandedRows, false, quote);
  }
  return code;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
