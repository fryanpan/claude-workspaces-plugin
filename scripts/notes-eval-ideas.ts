#!/usr/bin/env bun
/**
 * The lost-idea rate: how much of what was said the notes did not keep.
 *
 *   bun run scripts/notes-eval-ideas.ts --build            # list ground truth
 *   bun run scripts/notes-eval-ideas.ts --build --meeting ES2002a
 *   bun run scripts/notes-eval-ideas.ts --build --corpus <dir>
 *
 * WHY A SEPARATE GROUND TRUTH. Every other check in `notes-eval.ts` reads the
 * notes and asks whether they are well formed. None of them can ask the
 * question a person actually asks — "I said that, where is it?" — because
 * answering it needs a list of what was said that is independent of what was
 * written. So the ideas in each tick are enumerated ONCE, by a model, into a
 * file beside the fixture, and every run afterwards measures against that
 * list rather than against a fresh reading. A metric whose denominator is
 * re-derived each run cannot move.
 *
 * IT IS MEANT TO BE CORRECTED BY HAND. The file is plain JSON, one array of
 * sentences per tick, and a wrong entry is fixed by editing it. That is the
 * point of writing it down: a model's first listing is a draft, and a
 * corrected draft is worth more than a fresh draft every run. `listedBy` and
 * `listedAt` say where a list came from so a hand-corrected one is not
 * silently rebuilt over.
 *
 * THE JUDGE IS PER IDEA, and it reads the notes as they stood at the END of
 * the meeting. That is what a person opens afterwards. An idea the notes do
 * not carry is LOST, whatever the pipeline's own retry counter said: the
 * runtime check in `notes-idea-coverage.ts` is a lexical proxy and this is
 * the measurement it is a proxy for.
 *
 * THE CORPUS IS TWO HALVES, and one of them is not in this repo. The AMI
 * excerpts are committed; real meetings are private, so they live wherever
 * `--corpus` points and nothing here writes them anywhere near the working
 * tree. Only counts and rates come back.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readKeychainPassword } from '../packages/server/src/share/keychain.ts';
import { resolveKeyFrom } from '../packages/server/src/summarize.ts';
import { FIXTURE_DIR, type NotesEvalFixture } from './notes-eval-fixtures.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TRUTH_MODEL = 'claude-sonnet-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

/** One tick's distinct ideas, as listed once and corrected by hand after. */
export interface TickIdeas {
  /** 1-based, matching the fixture's tick order. */
  tick: number;
  ideas: string[];
}

export interface IdeaTruth {
  meeting: string;
  listedBy: string;
  listedAt: string;
  ticks: TickIdeas[];
}

/** Where a meeting's ground truth sits: beside its fixture, always. */
export function truthPath(dir: string, meeting: string): string {
  return join(dir, `${meeting}.ideas.json`);
}

export function readTruth(dir: string, meeting: string): IdeaTruth | null {
  const path = truthPath(dir, meeting);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as IdeaTruth;
}

/* ===== Listing the ideas ===== */

const LIST_SYSTEM = [
  'You are enumerating what a moment of a meeting CONTAINED, so a note-taker',
  'can be measured against it. You are not writing notes.',
  '',
  'List the distinct IDEAS in the speech: a claim, a problem, an option, a',
  'decision, an action, a question, a constraint, a number that mattered.',
  'One idea per entry, in your own short words, under fifteen words each.',
  '',
  'Do NOT list: greetings, acknowledgements, thinking aloud that reaches',
  'nothing, a false start, or an idea already listed for this moment. If the',
  'speech genuinely contained nothing, return an empty list — an empty moment',
  'is a real answer and inventing one idea for it corrupts every rate built',
  'on this file.',
  '',
  'Answer with the record_ideas tool and nothing else.',
].join('\n');

const LIST_TOOL: ToolSpec = {
  name: 'record_ideas',
  description: 'Record the distinct ideas this moment of the meeting contained.',
  input_schema: {
    type: 'object' as const,
    properties: {
      ideas: { type: 'array', items: { type: 'string' } },
    },
    required: ['ideas'],
  },
};

/** A forced tool call, the shape both questions here take. */
interface ToolSpec {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

async function callTool(
  key: string,
  system: string,
  user: string,
  tool: ToolSpec,
  maxTokens: number,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: TRUTH_MODEL,
      max_tokens: maxTokens,
      system,
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: user }],
    }),
  });
  // The STATUS only, never the body: a body can echo the prompt, and the
  // prompt is meeting speech.
  if (!res.ok) {
    console.error(`  idea call returned HTTP ${res.status}`);
    return null;
  }
  const body = (await res.json()) as {
    content?: Array<{ type?: string; name?: string; input?: unknown }>;
  };
  const call = body.content?.find((b) => b.type === 'tool_use' && b.name === tool.name);
  if (!call?.input || typeof call.input !== 'object') return null;
  return call.input as Record<string, unknown>;
}

/** List one tick's ideas. Null when the model could not be read. */
export async function listIdeas(key: string, transcript: string): Promise<string[] | null> {
  const out = await callTool(
    key,
    LIST_SYSTEM,
    `Speech in this moment:\n${transcript}`,
    LIST_TOOL,
    700,
  );
  if (!out) return null;
  const ideas = out.ideas;
  if (!Array.isArray(ideas)) return null;
  return ideas.filter((i): i is string => typeof i === 'string' && i.trim().length > 0);
}

/* ===== Judging what survived ===== */

const CARRY_SYSTEM = [
  'You are checking a set of meeting notes against a list of things the',
  'meeting contained, one at a time.',
  '',
  'For each numbered idea, answer whether the NOTES CARRY IT — in any words,',
  'anywhere in the notes, however compressed. A note that says the same thing',
  'in five words carries it. A note about the same TOPIC that does not say',
  'this particular thing does not.',
  '',
  'Answer with the record_carried tool: one entry per idea, in the same',
  'order, each with the idea number and true or false.',
].join('\n');

const CARRY_TOOL: ToolSpec = {
  name: 'record_carried',
  description: 'Say, per idea, whether the notes carry it.',
  input_schema: {
    type: 'object' as const,
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

/**
 * Which of these ideas the notes carry. `null` when the judge could not be
 * read — the ideas are then dropped from the sample rather than counted lost,
 * because a judge that would not answer is not evidence about the notes.
 */
export async function judgeCarried(
  key: string,
  ideas: readonly string[],
  notes: string,
): Promise<boolean[] | null> {
  if (ideas.length === 0) return [];
  const user = [
    `The notes:\n${notes || '(the notes are empty)'}`,
    `The ideas:\n${ideas.map((idea, i) => `${i + 1}. ${idea}`).join('\n')}`,
  ].join('\n\n');
  const out = await callTool(key, CARRY_SYSTEM, user, CARRY_TOOL, 200 + ideas.length * 40);
  if (!out || !Array.isArray(out.carried)) return null;
  const verdicts = new Array<boolean>(ideas.length).fill(false);
  let answered = 0;
  for (const row of out.carried as Array<{ n?: unknown; carried?: unknown }>) {
    const n = typeof row?.n === 'number' ? row.n - 1 : -1;
    if (n < 0 || n >= ideas.length) continue;
    verdicts[n] = row.carried === true;
    answered++;
  }
  // A partial answer is not a verdict on the ones it skipped, and scoring
  // those as lost would grade the judge's arithmetic.
  return answered === ideas.length ? verdicts : null;
}

/* ===== The rate ===== */

/** The gate, from the row that asked for this: under five per cent. */
export const MAX_LOST_IDEA_RATE = 0.05;

/**
 * The fewest ideas a run may gate on.
 *
 * A five per cent bar cannot be held by a sample of eight: one miss is twelve
 * per cent, and the CI smoke slice — three ticks of one meeting — would go red
 * on a single judgement call about a single bullet. That is not the gate
 * failing, it is arithmetic, and a gate that cries wolf is turned off.
 *
 * So a thin sample REPORTS and does not gate, and says out loud that it did
 * not — which is a different thing from the zero case below, where nothing was
 * measured at all and the run fails. The full corpus is 847 committed ideas
 * plus whatever `--corpus` adds, so the bar binds on every run that is meant
 * to hold it.
 */
export const MIN_GATED_IDEAS = 100;

export interface MeetingIdeaRate {
  meeting: string;
  ideas: number;
  lost: number;
  /** Ideas whose judge could not be read. Reported, never counted. */
  unjudged: number;
  /** The first few lost ideas, so a failing run says WHAT went missing. */
  examples: string[];
}

export function rateOf(row: { ideas: number; lost: number }): number {
  return row.ideas === 0 ? 0 : row.lost / row.ideas;
}

/**
 * Print the per-meeting and overall rates, and say whether the gate holds.
 * Returns the exit code the caller should use — 0 unless `gate` and the
 * overall rate is above the bar.
 */
export function reportIdeaRates(
  rows: readonly MeetingIdeaRate[],
  gate: boolean,
  quote = true,
): number {
  if (rows.length === 0) {
    console.log('\nNo idea ground truth for this corpus — the lost-idea rate was not measured.');
    console.log('Build it with: bun run scripts/notes-eval-ideas.ts --build');
    // A gate with no examples is not a pass. Saying so out loud is the whole
    // lesson of the CI job this sits beside, which read green while skipping.
    return gate ? 1 : 0;
  }
  console.log('\nLost ideas                                    ideas       lost');
  console.log('-'.repeat(66));
  let ideas = 0;
  let lost = 0;
  let unjudged = 0;
  for (const row of rows) {
    ideas += row.ideas;
    lost += row.lost;
    unjudged += row.unjudged;
    console.log(
      `${row.meeting.padEnd(42)} ${String(row.ideas).padStart(7)}   ${`${row.lost} (${(rateOf(row) * 100).toFixed(1)}%)`.padStart(
        8,
      )}`,
    );
  }
  console.log('-'.repeat(66));
  const overall = rateOf({ ideas, lost });
  console.log(
    `${'overall'.padEnd(42)} ${String(ideas).padStart(7)}   ${`${lost} (${(overall * 100).toFixed(1)}%)`.padStart(
      8,
    )}`,
  );
  if (unjudged > 0) console.log(`${unjudged} idea(s) had no readable verdict and are not counted.`);
  // An example IS a line of the meeting, restated. On a corpus that is not in
  // this repo that meeting is somebody's private one, and the brief for the
  // private half is counts, rates and ids only — so the examples are withheld
  // rather than trusted to a log file, a CI transcript or a scrollback.
  for (const row of rows) {
    if (row.examples.length === 0) continue;
    if (!quote) {
      console.log(
        `\n${row.meeting} — ${row.examples.length} idea(s) reached no note. ` +
          'Text withheld: this corpus is private.',
      );
      continue;
    }
    console.log(`\n${row.meeting} — ideas the notes did not carry, first five:`);
    for (const e of row.examples.slice(0, 5)) console.log(`  ${e}`);
  }
  if (!gate) return 0;
  if (ideas < MIN_GATED_IDEAS) {
    console.log(
      `\n${ideas} idea(s) is too thin a sample to hold a ` +
        `${(MAX_LOST_IDEA_RATE * 100).toFixed(0)}% bar (${MIN_GATED_IDEAS} needed). ` +
        'Reported, not gated.',
    );
    return 0;
  }
  if (overall > MAX_LOST_IDEA_RATE) {
    console.log(
      `\nFAILED: ${(overall * 100).toFixed(1)}% of ideas reached no note, over the ` +
        `${(MAX_LOST_IDEA_RATE * 100).toFixed(0)}% bar. The note-taker is dropping things it ` +
        'was told to compress. Read the examples above before changing the bar.',
    );
    return 1;
  }
  return 0;
}

/* ===== Building the ground truth ===== */

async function build(dir: string, only: readonly string[], key: string): Promise<number> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.ideas.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as NotesEvalFixture)
    .filter((f) => only.length === 0 || only.includes(f.meeting))
    .sort((a, b) => a.meeting.localeCompare(b.meeting));
  if (files.length === 0) throw new Error(`No fixtures in ${dir}`);

  for (const fixture of files) {
    const path = truthPath(dir, fixture.meeting);
    if (existsSync(path) && only.length === 0) {
      // Never rebuild over a list somebody may have corrected. Naming one
      // meeting is the way to ask for a rebuild, which makes overwriting an
      // explicit act.
      console.log(`${fixture.meeting}: ground truth already exists, left alone`);
      continue;
    }
    const ticks: TickIdeas[] = [];
    for (let i = 0; i < fixture.ticks.length; i++) {
      const transcript = fixture.ticks[i]!.turns.map((t) => `${t.speaker}: ${t.text}`).join('\n');
      const ideas = await listIdeas(key, transcript);
      if (ideas === null) {
        console.error(`  ${fixture.meeting} tick ${i + 1}: unreadable, listed as no ideas`);
        continue;
      }
      if (ideas.length > 0) ticks.push({ tick: i + 1, ideas });
    }
    const truth: IdeaTruth = {
      meeting: fixture.meeting,
      listedBy: TRUTH_MODEL,
      listedAt: new Date().toISOString(),
      ticks,
    };
    writeFileSync(path, `${JSON.stringify(truth, null, 2)}\n`);
    const total = ticks.reduce((n, t) => n + t.ideas.length, 0);
    console.log(`${fixture.meeting}: ${total} ideas over ${ticks.length} ticks -> ${path}`);
  }
  // A file written INTO the repo has to satisfy the repo's formatter, or the
  // next `bun run verify` fails on a generated artifact and the person who
  // ran the build has to guess why. Biome collapses a short array that
  // `JSON.stringify(_, 2)` spreads over lines, which is a difference no
  // amount of care in the writer avoids — so the formatter is asked rather
  // than imitated. Outside the repo there is nothing to satisfy.
  if (!relative(REPO_ROOT, dir).startsWith('..')) {
    Bun.spawnSync(['bunx', 'biome', 'check', '--write', dir], { cwd: REPO_ROOT });
  }
  return 0;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--meeting');
  const corpusAt = argv.indexOf('--corpus');
  const dir = corpusAt >= 0 && argv[corpusAt + 1] ? argv[corpusAt + 1]! : FIXTURE_DIR;
  const key = resolveKeyFrom(undefined, readKeychainPassword);
  if (!key) {
    console.error('No dedicated key. Set CW_SUMMARY_API_KEY or use the Keychain entry.');
    process.exit(2);
  }
  if (!argv.includes('--build')) {
    console.error('Nothing to do. Pass --build to list ground truth.');
    process.exit(2);
  }
  build(dir, at >= 0 && argv[at + 1] ? [argv[at + 1]!] : [], key).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
