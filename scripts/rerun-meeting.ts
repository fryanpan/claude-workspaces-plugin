#!/usr/bin/env bun
/**
 * `bun run meeting:rerun <meeting folder | audio file> --spend-usd <max>`
 *
 * Replay a retained meeting's audio through the REAL note-taker and report
 * what the notes came out like. The mechanics are `rerun-meeting-run.ts`,
 * which is tested with a stub composer and costs nothing; this file is the
 * argv and the three things that bill — the engine, the note-taker and the
 * capture pass — so that every one of them is constructed in exactly one
 * place and a test never reaches any of them.
 *
 * WHY IT IS NOT IN `verify`. It calls a model on every tick of a real
 * recording, and the whole reason `check:meeting-smoke` uses a stub composer
 * is that a gate which costs money per run is a gate somebody takes out of
 * the set. `--spend-usd` is required, the estimate is refused against it
 * before the socket opens, and nothing in `bun run verify --list` names this.
 */

import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { haikuMeetingNamer } from '../packages/server/src/meeting-namer.ts';
import type { NotesComposer } from '../packages/server/src/meeting-notes.ts';
import { createHaikuTaskCaptureExtractor } from '../packages/server/src/meeting-task-capture.ts';
import { createNotesMethodComposer } from '../packages/server/src/notes-method-composer.ts';
import { createPromptStore } from '../packages/server/src/prompt-store.ts';
import {
  createAssemblyAiEngine,
  createAssemblyAiProEngine,
} from '../packages/server/src/transcribe-assemblyai.ts';
import { createSonioxEngine } from '../packages/server/src/transcribe-soniox.ts';
import {
  type MockScriptTurn,
  type TranscriptionEngine,
  createMockTranscriptionEngine,
} from '../packages/server/src/transcribe.ts';
import { resolveReplayTarget } from './replay-meeting-lib.ts';
import { USAGE, UsageError, loadDocSpec, parseRerunArgs } from './rerun-meeting-args.ts';
import type { RerunArgs } from './rerun-meeting-args.ts';
import { methodReader, runRerun } from './rerun-meeting-run.ts';

/**
 * The engine the server opens.
 *
 * `mock` is the free one and the reason `--mock-script` exists: it reveals
 * one scripted word per audio chunk, so a synthetic meeting's known content
 * can ride real PCM without a vendor hearing anything. At the default 20ms
 * chunk that is fifty words a second — set `--chunk-ms 400` for something
 * near conversational speed.
 */
function engineFor(args: RerunArgs): TranscriptionEngine {
  let engine: TranscriptionEngine | null;
  switch (args.engine) {
    case 'mock': {
      const script = args.mockScript
        ? (JSON.parse(readFileSync(args.mockScript, 'utf8')) as MockScriptTurn[])
        : undefined;
      if (script && (!Array.isArray(script) || script.length === 0)) {
        throw new UsageError(`--mock-script ${args.mockScript} must be a non-empty JSON array`);
      }
      engine = script ? createMockTranscriptionEngine(script) : createMockTranscriptionEngine();
      break;
    }
    case 'soniox':
      engine = createSonioxEngine();
      break;
    case 'assemblyai':
      engine = createAssemblyAiEngine();
      break;
    case 'assemblyai-pro':
      engine = createAssemblyAiProEngine();
      break;
  }
  if (!engine) throw new UsageError(`the ${args.engine} engine has no key on this machine`);
  return engine;
}

/**
 * The shipped note-taker, built the way `server-deps.ts` builds it.
 *
 * `createNotesMethodComposer` is the one that is three: it reads the doc's
 * method at the top of every compose, THROUGH `methodFor`. So `methodFor` is
 * wired to `readNotesMethod` over the run's own data dir, exactly as
 * `server-deps.ts` wires it — the run writes the preference file and the
 * composer reads it, which is what makes `--method` pick the note-taker
 * through the product's own seam. A `methodFor` that answered a constant
 * would run the original composer for all three methods, and a comparison
 * between them would be a comparison of nothing.
 *
 * THE INSTRUCTIONS ARE THE SHIPPED DEFAULTS. The prompt store is opened over
 * a throwaway directory, so a rerun measures the prompt in this checkout
 * rather than whatever a machine happens to have tuned — which is what makes
 * two runs on two branches comparable.
 */
function composerFor(log: (line: string) => void): (dataDir: string) => NotesComposer {
  const promptStore = createPromptStore({
    dataDir: mkdtempSync(join(tmpdir(), 'cw-rerun-prompts-')),
  });
  // SAID ONCE, IN THE RUN LOG. `--method` only reaches the note-taker through
  // this read, and when it did not the report still said "ledger-opus" at the
  // top while the original composer wrote every bullet. Logging the answer the
  // composer actually got is what makes that visible in the artefact rather
  // than only in the code.
  const build = (dataDir: string): NotesComposer | null =>
    createNotesMethodComposer({
      methodFor: methodReader(dataDir, log),
      composerOpts: { instructions: () => promptStore.read('meeting-notes') },
      onError: (m) => console.error(`[rerun] ${m}`),
    });
  // Asked once here, BEFORE the server exists, so a machine with no key is
  // told so instead of holding a whole meeting that writes nothing.
  if (!build(mkdtempSync(join(tmpdir(), 'cw-rerun-probe-')))) {
    throw new UsageError(
      'no note-taker could be built: this machine has no key for it. A rerun without a real ' +
        'composer would be `check:meeting-smoke` with extra steps.',
    );
  }
  return (dataDir: string): NotesComposer => {
    const composer = build(dataDir);
    if (!composer) throw new UsageError('the note-taker could not be built');
    return composer;
  };
}

async function main(argv: string[]): Promise<number> {
  const args = parseRerunArgs(argv);
  const target = resolveReplayTarget(args.target, args.segment);
  const doc = loadDocSpec(args.doc);
  const transcription = engineFor(args);
  const promptStore = createPromptStore({
    dataDir: mkdtempSync(join(tmpdir(), 'cw-rerun-capture-prompts-')),
  });

  const lines: string[] = [];
  const log = (line: string): void => {
    lines.push(line);
    console.error(`rerun: ${line}`);
  };

  const outcome = await runRerun(args, target, doc, {
    composer: composerFor(log),
    transcription,
    taskExtractor: createHaikuTaskCaptureExtractor({
      instructions: () => promptStore.read('meeting-capture'),
    }),
    titleNamer: haikuMeetingNamer(),
    log,
  });
  await Bun.write(join(outcome.runDir, 'run.log'), `${lines.join('\n')}\n`);
  console.log(outcome.reportPath);
  console.error(`\n${'-'.repeat(60)}`);
  console.error(readFileSync(outcome.reportPath, 'utf8'));
  // A capped run answers 1: its notes are real as far as they go, and a
  // report of a meeting that stopped early must not read as a finished one.
  return outcome.cappedUsd === undefined ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      if (err instanceof UsageError) {
        console.error(err.message === USAGE ? USAGE : `${err.message}\n\n${USAGE}`);
        process.exit(2);
      }
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exit(1);
    },
  );
}
