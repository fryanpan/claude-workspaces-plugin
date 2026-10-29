#!/usr/bin/env bun
/**
 * `bun run notes:replay <meeting folder> --out <dir> --spend-usd <max>`
 *
 * Replay a recorded meeting's settled turns through the CURRENT note-taker,
 * offline, and write what came out — the notes, the per-tick timing the
 * pipeline records, the at-stop quality reading — to `<out>/<docId>/`.
 * `notes-replay-score.ts` reads that directory and scores it.
 *
 * THE FOLDER is a copy of one doc's meeting directory: `meetings.jsonl`, each
 * meeting's `<meetingId>.jsonl` transcript, and optionally `meeting.json`
 * (the title) and `<meetingId>-notes-doc.json` (the names its first leg
 * started knowing). The audio is never read.
 *
 * PRIVATE BY CONSTRUCTION. A recorded meeting is somebody's words, so the
 * output goes only where `--out` points and this refuses an `--out` inside
 * the repository. Nothing from the meeting is printed: the console carries
 * counts, durations and dollars.
 *
 * THE KEY IS THE EVAL KEY (`scripts/eval-credential.ts`), never prod's, and
 * `--spend-usd` is required: every compose is a model call.
 *
 *   --one-leg          run every meeting as one session (the control for
 *                      what reconnects cost the notes)
 *   --endpoint-lag N   ms between a speaker stopping and the turn settling
 *   --stub             the deterministic stub composer; free, for plumbing
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNotesMethod } from '../packages/core/src/notes-method.ts';
import {
  type NotesComposer,
  createStubNotesComposer,
} from '../packages/server/src/meeting-notes.ts';
import {
  type NotesCoverageJudge,
  createCoverageJudge,
} from '../packages/server/src/notes-coverage-judge.ts';
import { createNotesMethodComposer } from '../packages/server/src/notes-method-composer.ts';
import { readNotesMethod, writeNotesMethod } from '../packages/server/src/notes-method-store.ts';
import { createPromptStore } from '../packages/server/src/prompt-store.ts';
import { readKeychainPassword } from '../packages/server/src/share/keychain.ts';
import { runReplay } from '../packages/server/test/notes-replay-run.ts';
import { EVAL_CREDENTIAL_HELP, resolveEvalCredentialFrom } from './eval-credential.ts';
import {
  type ReplayMeeting,
  SpendMeter,
  type TranscriptRow,
  parseJsonLines,
  parseTranscript,
  planMeetings,
} from './notes-replay-lib.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface MeetingFolder {
  docId: string;
  title?: string;
  meetings: ReplayMeeting[];
  seedNames: Record<string, Record<string, string>>;
}

/** Read a copied meeting directory into a replay plan. */
export function readMeetingFolder(dir: string, opts: { oneLeg?: boolean } = {}): MeetingFolder {
  const files = readdirSync(dir);
  const meta = existsSync(join(dir, 'meeting.json'))
    ? (JSON.parse(readFileSync(join(dir, 'meeting.json'), 'utf8')) as Record<string, unknown>)
    : {};
  const index = parseJsonLines(readFileSync(join(dir, 'meetings.jsonl'), 'utf8'));
  const docId =
    typeof meta.docId === 'string'
      ? meta.docId
      : ((index.find((l) => typeof l.docId === 'string')?.docId as string | undefined) ??
        basename(dir));
  const transcripts = new Map<string, TranscriptRow[]>();
  const seedNames: Record<string, Record<string, string>> = {};
  for (const line of index) {
    const id = line.meetingId;
    if (typeof id !== 'string' || transcripts.has(id)) continue;
    const path = join(dir, `${id}.jsonl`);
    transcripts.set(id, existsSync(path) ? parseTranscript(readFileSync(path, 'utf8')) : []);
    const seed = join(dir, `${id}-notes-doc.json`);
    if (files.includes(basename(seed))) {
      const names = (JSON.parse(readFileSync(seed, 'utf8')) as { speakerNames?: unknown })
        .speakerNames;
      if (names && typeof names === 'object') {
        seedNames[id] = Object.fromEntries(
          Object.entries(names as Record<string, unknown>).filter(
            (e): e is [string, string] => typeof e[1] === 'string',
          ),
        );
      }
    }
  }
  return {
    docId,
    ...(typeof meta.title === 'string' ? { title: meta.title } : {}),
    meetings: planMeetings(index, transcripts, opts),
    seedNames,
  };
}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

function shippedComposer(meter: SpendMeter, outDir: string, dataDir: string): NotesComposer {
  const credential = resolveEvalCredentialFrom(undefined, readKeychainPassword, process.env);
  if (!credential || credential.kind !== 'key') {
    console.error(EVAL_CREDENTIAL_HELP);
    process.exit(2);
  }
  const key = credential.value;
  const prompts = createPromptStore({ dataDir: join(outDir, 'prompts') });
  const composer = createNotesMethodComposer({
    methodFor: (docId) => readNotesMethod(dataDir, docId),
    apiKey: key,
    // Every slot the composer resolves gets the eval key and nothing else,
    // so no half of it can fall through to prod's Keychain item.
    readKey: () => key,
    composerOpts: {
      apiKey: key,
      fetchImpl: meter.fetch(),
      instructions: () => prompts.read('meeting-notes'),
    },
    ledgerFetch: meter.fetch(),
    onError: (m) => console.error(`[replay] ${m}`),
  });
  if (!composer) throw new Error('no note-taker could be built with the eval key');
  return composer;
}

/** The at-stop coverage judge the server wires, on the eval key. */
function evalCoverageJudge(meter: SpendMeter): NotesCoverageJudge {
  const credential = resolveEvalCredentialFrom(undefined, readKeychainPassword, process.env);
  if (!credential || credential.kind !== 'key') {
    console.error(EVAL_CREDENTIAL_HELP);
    process.exit(2);
  }
  return createCoverageJudge({
    apiKey: credential.value,
    fetchImpl: meter.fetch(),
    onError: (m) => console.error(`[replay] ${m}`),
  });
}

async function main(argv: string[]): Promise<number> {
  const folder = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
  const out = flag(argv, '--out');
  const stub = argv.includes('--stub');
  const cap = Number(flag(argv, '--spend-usd'));
  if (!folder || !out || (!stub && !(cap > 0))) {
    console.error(
      'usage: notes-replay.ts <meeting folder> --out <dir> --spend-usd <max> [--one-leg]',
    );
    return 2;
  }
  if (!relative(REPO_ROOT, resolve(out)).startsWith('..')) {
    console.error('refusing --out inside the repository: a recorded meeting never enters it');
    return 2;
  }
  const plan = readMeetingFolder(folder, { oneLeg: argv.includes('--one-leg') });
  const runDir = join(out, plan.docId);
  const dataDir = join(runDir, 'data');
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  // A note-taker other than the doc's default, as a person would pick it.
  const methodArg = flag(argv, '--method');
  if (methodArg !== undefined) {
    const method = parseNotesMethod(methodArg);
    if (!method) {
      console.error(`unknown --method ${methodArg}`);
      return 2;
    }
    writeNotesMethod(dataDir, plan.docId, { method, at: Date.now() });
  }
  const meter = new SpendMeter(stub ? Number.POSITIVE_INFINITY : cap);
  const built = stub ? createStubNotesComposer() : shippedComposer(meter, runDir, dataDir);
  // Every edit the model answered, before the guards: what a note that never
  // reached the doc said is otherwise not recorded anywhere.
  const editLog = join(runDir, 'edits.jsonl');
  const composer: NotesComposer = argv.includes('--log-edits')
    ? {
        name: built.name,
        async compose(input) {
          const edits = await built.compose(input);
          appendFileSync(editLog, `${JSON.stringify({ meetingId: input.meetingId, edits })}\n`);
          return edits;
        },
      }
    : built;
  const coverageJudge = stub ? undefined : evalCoverageJudge(meter);
  const lag = flag(argv, '--endpoint-lag');
  const legs = plan.meetings.reduce((n, m) => n + m.legs.length, 0);
  const turns = plan.meetings.reduce(
    (n, m) => n + m.legs.reduce((k, l) => k + l.turns.length, 0),
    0,
  );
  console.error(`replay: ${plan.meetings.length} meeting(s), ${legs} leg(s), ${turns} turns`);
  const t0 = performance.now();
  const result = await runReplay({
    docId: plan.docId,
    ...(plan.title ? { docTitle: plan.title } : {}),
    meetings: plan.meetings,
    seedNames: plan.seedNames,
    dataDir,
    composer,
    ...(coverageJudge ? { coverageJudge } : {}),
    ...(lag !== undefined ? { endpointLagMs: Number(lag) } : {}),
  });
  const wallMs = Math.round(performance.now() - t0);
  const pipelineUsd = result.summaries.reduce((n, s) => n + (s.spend?.totalUsd ?? 0), 0);
  writeFileSync(join(runDir, 'notes.md'), result.markdown);
  writeFileSync(
    join(runDir, 'turn-waits.jsonl'),
    result.turnWaits.map((w) => JSON.stringify(w)).join('\n') +
      (result.turnWaits.length ? '\n' : ''),
  );
  const run = {
    docId: plan.docId,
    folder: resolve(folder),
    composer: composer.name,
    oneLeg: argv.includes('--one-leg'),
    meetings: plan.meetings.map((m) => ({ meetingId: m.meetingId, legs: m.legs.length })),
    turns,
    ticks: result.ticks,
    errors: result.errors.length,
    filings: result.filings,
    wallMs,
    spend: { meteredUsd: meter.spentUsd, calls: meter.calls, pipelineUsd, capHit: meter.over },
    summaries: result.summaries.map((s) => ({
      meetingId: s.meetingId,
      ticks: s.ticks,
      turnsSettled: s.turnsSettled,
      turnsLost: s.turnsLost,
      composeFailures: s.composeFailures,
      refusedTooLong: s.refusedTooLong,
      phantomTags: s.phantomTags,
      latencyMedianMs: s.latencyMedianMs,
      latencyWorstMs: s.latencyWorstMs,
      spendUsd: s.spend?.totalUsd,
    })),
  };
  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  console.error(
    `replay: ${result.ticks.written} written / ${result.ticks.empty} empty / ` +
      `${result.ticks.failed} failed ticks, ${result.errors.length} errors, ` +
      `$${meter.spentUsd.toFixed(3)} metered, ${(wallMs / 1000).toFixed(0)}s wall -> ${runDir}`,
  );
  return meter.over ? 1 : 0;
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
