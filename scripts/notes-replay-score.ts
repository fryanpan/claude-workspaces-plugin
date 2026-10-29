#!/usr/bin/env bun
/**
 * `bun run notes:replay:score <run dir>... --truth <dir> --spend-usd <max>`
 *
 * Score what `notes-replay.ts` wrote against the five goal metrics of a good
 * meeting, and write `score.json` beside it:
 *
 *   1. repeats    — no repeated bullet, no topic headed twice
 *                   (`repeatedBullets`, `duplicateTopics`: the product's own)
 *   2. lostIdeas  — under 5% of the ideas said reach no note (over 10% is a
 *                   defect). Ideas are listed ONCE per doc from the transcript
 *                   into `--truth`, and judged per run against the final
 *                   notes (`notes-eval-ideas.ts`), so every run shares one
 *                   denominator.
 *   3. latency    — settled-to-written per written tick, from the timing
 *                   file the pipeline wrote on the replay clock: median at
 *                   most 10s AND under 10% of notes over 10s
 *   4. speakers   — no tag naming a voice the meeting never had
 *                   (`unknownVoices`)
 *   5. reported   — every goal of 1-4 the meeting missed is named by the
 *                   quality item the at-stop pass filed
 *   6. paraphrases — no note restates an earlier note under its heading
 *                   (`notes-repeat-judge.ts`)
 *
 * LOST IS READ TWICE. Each idea the first judge calls lost is shown to a
 * second call that must copy the line carrying it (`notes-lost-confirm.ts`);
 * `lostShare` is after that pass and `rawLostShare` before it.
 * `--reuse-raw` takes the first reading from an earlier score.json of the
 * same notes instead of paying for it again.
 *
 * The truth dir and the run dirs hold meeting words, so both must be outside
 * the repository. The console prints numbers only.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notesQualityFiledPath } from '../packages/server/src/notes-quality-filed-store.ts';
import { voicesOf } from '../packages/server/src/notes-quality-pass.ts';
import {
  type MeetingVoices,
  duplicateBulletLines,
  repeatedBullets,
  unknownVoices,
} from '../packages/server/src/notes-quality-report.ts';
import { duplicateTopics } from '../packages/server/src/notes-quality.ts';
import { readTickWaits } from '../packages/server/src/notes-tick-timing.ts';
import { readKeychainPassword } from '../packages/server/src/share/keychain.ts';
import type { SummaryCredential } from '../packages/server/src/summarize.ts';
import { EVAL_CREDENTIAL_HELP, resolveEvalCredentialFrom } from './eval-credential.ts';
import { judgeCarried, listIdeas, setIdeaUsageSink } from './notes-eval-ideas.ts';
import { confirmLost } from './notes-lost-confirm.ts';
import {
  CHECK_MODEL,
  CHECK_SYSTEM,
  CHECK_TOOL,
  PROPOSE_MODEL,
  PROPOSE_SYSTEM,
  PROPOSE_TOOL,
  type RepeatCall,
  judgeRepeats,
  modelCall,
} from './notes-repeat-judge.ts';
import { ideaWindows, scoreGoals } from './notes-replay-goals.ts';
import { SpendMeter, type TranscriptRow } from './notes-replay-lib.ts';
import { readMeetingFolder } from './notes-replay.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JUDGE_BATCH = 40;
const CONFIRM_BATCH = 20;

interface Truth {
  docId: string;
  listedAt: string;
  windows: Array<{ firstTurn: number; ideas: string[] }>;
}

/**
 * Voices across every recording of a doc, for a notes section they share. A
 * label two recordings named differently is a different person each time, so
 * its pairing is dropped and either name is accepted on it.
 */
export function mergeVoices(all: readonly MeetingVoices[]): MeetingVoices {
  const labels = new Set<string>();
  const names = new Set<string>();
  const assigned: Record<string, string> = {};
  const conflicted = new Set<string>();
  for (const v of all) {
    for (const l of v.labels) labels.add(l);
    for (const n of v.names) names.add(n);
    for (const [label, name] of Object.entries(v.assigned ?? {})) {
      if (assigned[label] !== undefined && assigned[label] !== name) conflicted.add(label);
      assigned[label] = name;
    }
  }
  for (const l of conflicted) delete assigned[l];
  return { labels: [...labels], names: [...names], assigned };
}

function speech(rows: readonly TranscriptRow[]): string {
  return rows.map((t) => `${t.speaker ?? 'Speaker'}: ${t.text}`).join('\n');
}

async function buildTruth(
  key: SummaryCredential,
  docId: string,
  turns: readonly TranscriptRow[],
  meter: SpendMeter,
): Promise<Truth> {
  const windows: Truth['windows'] = [];
  for (const w of ideaWindows(turns)) {
    if (meter.over) throw new Error(`spend cap $${meter.capUsd} reached while listing ideas`);
    let ideas = await listIdeas(key, speech(w));
    if (ideas === null) ideas = await listIdeas(key, speech(w));
    if (ideas === null) throw new Error('the idea lister did not answer twice; truth not written');
    windows.push({ firstTurn: w[0]?.turn ?? 0, ideas });
  }
  return { docId, listedAt: new Date().toISOString(), windows };
}

async function judgeAll(
  key: SummaryCredential,
  ideas: readonly string[],
  notes: string,
  meter: SpendMeter,
): Promise<{ judged: number; lost: number; unjudged: number; lostIdeas: string[] }> {
  let judged = 0;
  let lost = 0;
  let unjudged = 0;
  const lostIdeas: string[] = [];
  for (let i = 0; i < ideas.length; i += JUDGE_BATCH) {
    const batch = ideas.slice(i, i + JUDGE_BATCH);
    if (meter.over) throw new Error(`spend cap $${meter.capUsd} reached while judging`);
    let verdicts = await judgeCarried(key, batch, notes);
    if (verdicts === null) verdicts = await judgeCarried(key, batch, notes);
    if (verdicts === null) {
      unjudged += batch.length;
      continue;
    }
    judged += verdicts.length;
    verdicts.forEach((carried, j) => {
      if (carried) return;
      lost++;
      lostIdeas.push(batch[j] as string);
    });
  }
  return { judged, lost, unjudged, lostIdeas };
}

/** The lost ideas a quoted line shows carried after all are taken out. A
 *  batch the second call could not answer keeps its first verdict. */
async function confirmAll(
  key: SummaryCredential,
  lostIdeas: readonly string[],
  notes: string,
  meter: SpendMeter,
): Promise<{ stillLost: string[]; foundCarried: string[] }> {
  const stillLost: string[] = [];
  const foundCarried: string[] = [];
  for (let i = 0; i < lostIdeas.length; i += CONFIRM_BATCH) {
    const batch = lostIdeas.slice(i, i + CONFIRM_BATCH);
    if (meter.over) throw new Error(`spend cap $${meter.capUsd} reached while confirming`);
    const carried = await confirmLost(key, batch, notes);
    batch.forEach((idea, j) => (carried?.[j] ? foundCarried : stillLost).push(idea));
  }
  return { stillLost, foundCarried };
}

function outside(path: string): boolean {
  return relative(REPO_ROOT, resolve(path)).startsWith('..');
}

async function scoreRun(
  runDir: string,
  truthDir: string,
  key: SummaryCredential | null,
  meter: SpendMeter,
  reuseRaw = false,
): Promise<Record<string, unknown>> {
  const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as {
    docId: string;
    folder: string;
    meetings: Array<{ meetingId: string }>;
    spend: { meteredUsd: number };
  };
  const dataDir = join(runDir, 'data');
  const notes = readFileSync(join(runDir, 'notes.md'), 'utf8');
  const folder = readMeetingFolder(run.folder);
  const turns = folder.meetings.flatMap((m) => m.legs.flatMap((l) => l.turns));
  const voices = mergeVoices(
    run.meetings.map((m) =>
      voicesOf(
        dataDir,
        run.docId,
        m.meetingId,
        turns.map((t) => ({
          turn: t.turn,
          text: t.text,
          ...(t.speaker ? { speaker: t.speaker } : {}),
        })),
      ),
    ),
  );
  const waits = run.meetings.flatMap(
    (m) => readTickWaits(dataDir, run.docId, m.meetingId)?.map((w) => w.waitMs) ?? [],
  );
  const reportedKinds = new Set<string>();
  for (const m of run.meetings) {
    const path = notesQualityFiledPath(dataDir, run.docId, m.meetingId);
    if (!existsSync(path)) continue;
    const kinds = (JSON.parse(readFileSync(path, 'utf8')) as { verdict?: { kinds?: unknown } })
      .verdict?.kinds;
    if (Array.isArray(kinds))
      for (const k of kinds) if (typeof k === 'string') reportedKinds.add(k);
  }

  let ideas: Awaited<ReturnType<typeof judgeAll>> | null = null;
  let confirmed: Awaited<ReturnType<typeof confirmAll>> | null = null;
  let paraphrases: Awaited<ReturnType<typeof judgeRepeats>> | null = null;
  const truthPath = join(truthDir, `${run.docId}.ideas.json`);
  if (key) {
    const before = meter.spentUsd;
    const earlier = reuseRaw ? previousRaw(runDir) : null;
    if (earlier) {
      ideas = earlier;
    } else {
      if (!existsSync(truthPath)) {
        const truth = await buildTruth(key, run.docId, turns, meter);
        writeFileSync(truthPath, `${JSON.stringify(truth, null, 2)}\n`);
      }
      const truth = JSON.parse(readFileSync(truthPath, 'utf8')) as Truth;
      ideas = await judgeAll(
        key,
        truth.windows.flatMap((w) => w.ideas),
        notes,
        meter,
      );
    }
    confirmed = await confirmAll(key, ideas.lostIdeas, notes, meter);
    const book = meter.book.bind(meter);
    const guarded =
      (call: RepeatCall): RepeatCall =>
      (user) => {
        if (meter.over) throw new Error(`spend cap $${meter.capUsd} reached while judging repeats`);
        return call(user);
      };
    paraphrases = await judgeRepeats(
      notes,
      guarded(
        modelCall({
          key,
          model: PROPOSE_MODEL,
          system: PROPOSE_SYSTEM,
          tool: PROPOSE_TOOL,
          maxTokens: 8_000,
          book,
        }),
      ),
      guarded(
        modelCall({
          key,
          model: CHECK_MODEL,
          system: CHECK_SYSTEM,
          tool: CHECK_TOOL,
          maxTokens: 3_000,
          book,
        }),
      ),
    );
    console.error(`score: ${run.docId} judged for $${(meter.spentUsd - before).toFixed(3)}`);
  }
  const goals = scoreGoals({
    duplicateBulletLines: duplicateBulletLines(repeatedBullets(notes)),
    duplicateHeadings: duplicateTopics(notes).length,
    ideas: ideas && confirmed ? { judged: ideas.judged, lost: confirmed.stillLost.length } : ideas,
    waitsMs: waits,
    unknownSpeakers: unknownVoices(notes, voices).length,
    reportedKinds: [...reportedKinds],
    ...(key
      ? {
          paraphrasedRepeats:
            paraphrases && paraphrases.judgedNotes === paraphrases.notes
              ? paraphrases.repeats
              : null,
        }
      : {}),
  });
  if (goals.lostIdeas && ideas) {
    goals.lostIdeas.rawLost = ideas.lost;
    goals.lostIdeas.rawLostShare = ideas.judged > 0 ? ideas.lost / ideas.judged : null;
  }
  const score = {
    docId: run.docId,
    goals,
    allPass: Object.values(goals).every((g) => g.pass),
    unjudgedIdeas: ideas?.unjudged ?? null,
    // Meeting words, kept so a fix can be aimed; score.json never leaves
    // the run dir.
    lostIdeas: confirmed?.stillLost ?? ideas?.lostIdeas ?? null,
    rawLostIdeas: ideas?.lostIdeas ?? null,
    foundCarried: confirmed?.foundCarried ?? null,
    paraphrasePairs: paraphrases?.pairs ?? null,
    paraphraseNotes: paraphrases
      ? { notes: paraphrases.notes, judged: paraphrases.judgedNotes }
      : null,
    reportedKinds: [...reportedKinds],
    replayUsd: run.spend.meteredUsd,
    scoredAt: new Date().toISOString(),
  };
  writeFileSync(join(runDir, 'score.json'), `${JSON.stringify(score, null, 2)}\n`);
  return score;
}

/** The first judge's reading from an earlier score.json of these notes. */
function previousRaw(runDir: string): Awaited<ReturnType<typeof judgeAll>> | null {
  const path = join(runDir, 'score.json');
  if (!existsSync(path)) return null;
  const prev = JSON.parse(readFileSync(path, 'utf8')) as {
    goals?: { lostIdeas?: { judged?: number } };
    unjudgedIdeas?: number | null;
    lostIdeas?: string[] | null;
    rawLostIdeas?: string[] | null;
  };
  const lostIdeas = prev.rawLostIdeas ?? prev.lostIdeas;
  const judged = prev.goals?.lostIdeas?.judged;
  if (!Array.isArray(lostIdeas) || typeof judged !== 'number') return null;
  return { judged, lost: lostIdeas.length, unjudged: prev.unjudgedIdeas ?? 0, lostIdeas };
}

function pct(x: unknown): string {
  return typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '-';
}

async function main(argv: string[]): Promise<number> {
  const at = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const truthDir = at('--truth');
  const cap = Number(at('--spend-usd'));
  const noJudge = argv.includes('--no-judge');
  const reuseRaw = argv.includes('--reuse-raw');
  const runs = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
  if (runs.length === 0 || !truthDir || (!noJudge && !(cap > 0))) {
    console.error(
      'usage: notes-replay-score.ts <run dir>... --truth <dir> --spend-usd <max> [--no-judge]',
    );
    return 2;
  }
  if (!outside(truthDir) || runs.some((r) => !outside(r))) {
    console.error('refusing a truth or run dir inside the repository');
    return 2;
  }
  let key: SummaryCredential | null = null;
  if (!noJudge) {
    key = resolveEvalCredentialFrom(undefined, readKeychainPassword, process.env);
    if (!key) {
      console.error(EVAL_CREDENTIAL_HELP);
      return 2;
    }
  }
  const meter = new SpendMeter(noJudge ? Number.POSITIVE_INFINITY : cap);
  setIdeaUsageSink((model, input, output, cacheRead, cacheWrite) =>
    meter.book(model, {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cacheRead ?? 0,
      cache_creation_input_tokens: cacheWrite ?? 0,
    }),
  );
  console.log(
    'doc              repeats  lost(judged)     raw     median  >10s    speakers  reported  para     all',
  );
  let allPass = true;
  for (const run of runs) {
    const s = (await scoreRun(run, truthDir, key, meter, reuseRaw)) as {
      docId: string;
      allPass: boolean;
      goals: Record<string, Record<string, unknown>>;
    };
    allPass &&= s.allPass;
    const g = s.goals;
    const yes = (k: string): string => (g[k]?.pass ? 'pass' : 'FAIL');
    console.log(
      [
        s.docId.padEnd(16),
        `${yes('repeats')} ${g.repeats?.duplicateBulletLines}/${g.repeats?.duplicateHeadings}`.padEnd(
          8,
        ),
        `${yes('lostIdeas')} ${pct(g.lostIdeas?.lostShare)} (${g.lostIdeas?.judged})`.padEnd(16),
        pct(g.lostIdeas?.rawLostShare).padStart(6),
        `${typeof g.latency?.medianMs === 'number' ? (g.latency.medianMs / 1000).toFixed(1) : '-'}s`.padStart(
          6,
        ),
        pct(g.latency?.lateShare).padStart(6),
        `${yes('latency')}`,
        `${yes('speakers')} ${g.speakers?.unknownSpeakers}`.padEnd(9),
        yes('reported').padEnd(9),
        `${g.paraphrases ? yes('paraphrases') : '-'} ${g.paraphrases?.paraphrasedRepeats ?? '-'}`.padEnd(
          8,
        ),
        s.allPass ? 'pass' : 'FAIL',
      ].join('  '),
    );
  }
  console.error(`score: $${meter.spentUsd.toFixed(3)} spent on judging over ${meter.calls} calls`);
  return allPass ? 0 : 1;
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
