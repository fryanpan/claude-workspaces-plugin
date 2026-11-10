#!/usr/bin/env bun
/**
 * `bun run scripts/lead-hold-replay.ts` — how often the lead's meeting line
 * starts before the speaker finished a thought, for each way of holding it
 * (`packages/server/src/lead-chat/lead-line-hold.ts`), on invented talk.
 *
 *   --set dev|heldout      which fixture (default heldout)
 *   --judge cache|live     `cache` (default) answers from the recorded
 *                          verdicts and fails on a miss; `live` asks Haiku on
 *                          the EVAL credential (never prod's) and records
 *   --budget <usd>         stop before a live call would pass this (default 1)
 *   --json <path>          write the scores as JSON too
 *
 * The fixtures are `scripts/fixtures/lead-hold/`: `dev.json` was written by
 * the builder and used to shape the judge's question; `heldout.json` was
 * written separately, from the class table alone, before the question was
 * frozen. Report the held-out numbers.
 *
 * Nothing here is a real meeting: no audio, no transcript, no notes.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readKeychainPassword } from '../packages/server/src/share/keychain.ts';
import { unfinishedAsk } from '../packages/server/src/spoken-reply/pause-gate.ts';
import {
  THOUGHT_SYSTEM,
  readThought,
  thoughtPrompt,
} from '../packages/server/src/spoken-reply/thought-finished.ts';
import { HAIKU_NO_THINKING, authHeader } from '../packages/server/src/summarize.ts';
import { EVAL_CREDENTIAL_HELP, resolveEvalCredentialFrom } from './eval-credential.ts';
import {
  type ArmOpts,
  type ArmScore,
  type FixtureSet,
  type ReplayJudge,
  checkFixture,
  failsBar,
  replayPoint,
  score,
} from './lead-hold-replay-lib.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(HERE, 'fixtures', 'lead-hold');
export const ANSWERS_PATH = join(FIXTURE_DIR, 'judge-answers.json');

/** Haiku 5.5, per million tokens. */
const PRICE_IN = 0.1;
const PRICE_OUT = 0.5;
const MODEL = 'claude-haiku-5-5';

/** The arms, as the survey names them. */
export const ARMS: Record<string, ArmOpts> = {
  B: { arm: 'at-once' },
  F: { arm: 'gate' },
  F2: { arm: 'gate', unfinished: unfinishedAsk, timing: { finishedMs: 2000 } },
  C: { arm: 'gate', finalOpens: false, timing: { finishedMs: 3000, unfinishedMs: 3000 } },
  G0: { arm: 'judge' },
  G: { arm: 'judge', judged: true },
};

export interface Answer {
  finished: boolean;
  latencyMs: number;
}

/** Which question the recorded verdicts answer: a change to the prompt
 *  makes every one of them stale. */
export const PROMPT_ID = createHash('sha256').update(THOUGHT_SYSTEM).digest('hex').slice(0, 12);

interface AnswersFile {
  prompt: string;
  model: string;
  answers: Record<string, Answer>;
}

export function loadAnswers(): Record<string, Answer> {
  if (!existsSync(ANSWERS_PATH)) return {};
  const f = JSON.parse(readFileSync(ANSWERS_PATH, 'utf8')) as Partial<AnswersFile>;
  return f.prompt === PROMPT_ID && f.answers ? f.answers : {};
}

function saveAnswers(answers: Record<string, Answer>): void {
  const f: AnswersFile = { prompt: PROMPT_ID, model: MODEL, answers };
  writeFileSync(ANSWERS_PATH, `${JSON.stringify(f, null, 2)}\n`);
}

export function cachedJudge(answers: Record<string, Answer>): ReplayJudge {
  return async (recent) => {
    const a = answers[recent];
    if (!a) throw new Error(`no recorded verdict for:\n${recent}\nrun with --judge live`);
    return a;
  };
}

export function loadSet(name: string): FixtureSet {
  const f = JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8')) as FixtureSet;
  checkFixture(f);
  return f;
}

export async function runArm(f: FixtureSet, arm: ArmOpts, judge: ReplayJudge | null) {
  const results = [];
  for (const [i, p] of f.points.entries()) results.push(await replayPoint(p, i, arm, judge));
  return results;
}

function liveJudge(answers: Record<string, Answer>, budgetUsd: number) {
  const cred = resolveEvalCredentialFrom(undefined, readKeychainPassword, process.env);
  if (!cred) {
    console.error(EVAL_CREDENTIAL_HELP);
    process.exit(2);
  }
  const spend = { usd: 0, calls: 0 };
  const judge: ReplayJudge = async (recent) => {
    const hit = answers[recent];
    if (hit) return hit;
    // A call costs well under a tenth of a cent; stop before the cap, not after.
    if (spend.usd + 0.001 > budgetUsd) throw new Error(`budget $${budgetUsd} reached`);
    const t0 = performance.now();
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...authHeader(cred),
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        thinking: HAIKU_NO_THINKING,
        system: THOUGHT_SYSTEM,
        messages: [{ role: 'user', content: thoughtPrompt(recent) }],
      }),
    });
    const latencyMs = Math.round(performance.now() - t0);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    spend.calls += 1;
    spend.usd +=
      ((body.usage?.input_tokens ?? 0) * PRICE_IN + (body.usage?.output_tokens ?? 0) * PRICE_OUT) /
      1e6;
    const text = body.content?.map((b) => b.text ?? '').join('') ?? '';
    const a = { finished: readThought(text) === true, latencyMs };
    answers[recent] = a;
    return a;
  };
  return { judge, spend };
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');

export function table(scores: Record<string, ArmScore>): string {
  const rows = [
    '| Arm | Cut-ins | Released | Rate | Unsaid | Median wait | p90 wait | Judge calls |',
  ];
  rows.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const [name, s] of Object.entries(scores)) {
    rows.push(
      `| ${name} | ${s.cuts} | ${s.released} | ${pct(s.cuts, s.released)} | ${s.unsaid}/${s.requests} | ${s.medianWaitMs ?? '-'}ms | ${s.p90WaitMs ?? '-'}ms | ${s.judgeCalls} |`,
    );
  }
  return rows.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k: string, d: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? (args[i + 1] ?? d) : d;
  };
  const set = loadSet(opt('--set', 'heldout'));
  const answers = loadAnswers();
  const live = opt('--judge', 'cache') === 'live';
  const lj = live ? liveJudge(answers, Number(opt('--budget', '1'))) : null;
  const judge = lj?.judge ?? cachedJudge(answers);
  const scores: Record<string, ArmScore> = {};
  try {
    for (const [name, arm] of Object.entries(ARMS)) {
      scores[name] = score(await runArm(set, arm, judge));
    }
  } finally {
    if (live) saveAnswers(answers);
  }
  console.log(`set ${set.set}: ${set.points.length} requests, one per point\n`);
  console.log(table(scores));
  console.log('\nPer class (cut-ins / released):');
  for (const [name, s] of Object.entries(scores)) {
    const parts = Object.entries(s.byClass).map(([c, v]) => `${c}:${v.cuts}/${v.released}`);
    console.log(`  ${name.padEnd(3)} ${parts.join('  ')}`);
  }
  const gate = scores.F ?? null;
  console.log('\nBar (survey section 3):');
  for (const [name, s] of Object.entries(scores)) {
    const f = failsBar(s, name === 'F' ? null : gate);
    console.log(`  ${name.padEnd(3)} ${f.length ? `fails: ${f.join('; ')}` : 'meets'}`);
  }
  if (lj) console.log(`\nHaiku: ${lj.spend.calls} new calls, $${lj.spend.usd.toFixed(4)}`);
  const out = opt('--json', '');
  if (out) writeFileSync(out, JSON.stringify(scores, null, 1));
}

if (import.meta.main) await main();
