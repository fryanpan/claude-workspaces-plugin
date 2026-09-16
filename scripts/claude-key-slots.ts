#!/usr/bin/env bun
/**
 * WHICH SLOT EACH CLAUDE CALL PATH ACTUALLY READS — traced from a run.
 *
 * `bun run keys:trace`
 *
 * Reading `claude-key-source.ts` says which Keychain item a process is
 * SUPPOSED to consult. It cannot say which one a running process consulted,
 * because the environment a launchd job inherits is not the environment a
 * shell shows, and that gap is the whole reason eval spend can land on the
 * prod bill without anybody noticing. So this builds every adapter in the
 * server that reaches api.anthropic.com, exactly as the server builds it, and
 * then reads back the ledger each of them wrote at its own resolution
 * (`claude-key-slot.ts`).
 *
 * IT SPENDS NOTHING AND READS NO KEY. Every adapter is constructed and none
 * is called, so no request leaves the machine. The Keychain is never touched
 * either: both slots are given a placeholder through the env override
 * `readKeychainPassword` already honours, so the lookup resolves without a
 * real value existing anywhere in this process. The run still proves the
 * thing worth proving — WHICH NAME each path asked for — because the slot is
 * decided by which name is consulted and never by what came back.
 *
 * Two passes, because there are two answers: with the launchd prod marker
 * absent (a terminal, staging, CI, a builder's dev server) and with it
 * present (the prod service). The second pass is what the guard from PR 912
 * claims, and until this ran nobody had watched it hold.
 */
import { haikuAnswerCoverage } from '../packages/server/src/answer-coverage.ts';
import {
  CLAUDE_CALL_PATHS,
  type ClaudeCallPath,
  type ClaudeKeyRole,
  type ClaudeSlotUse,
  claudeSlotTrace,
  describeSlotUse,
  resetClaudeSlotTrace,
} from '../packages/server/src/claude-key-slot.ts';
import {
  ACCESS_TOKEN_ENV,
  EVAL_KEYCHAIN_SERVICE,
  KEYCHAIN_SERVICE,
  LAUNCHD_JOB_ENV,
  PROD_SERVICE_LABEL,
} from '../packages/server/src/claude-key-source.ts';
import { haikuEffortEstimator } from '../packages/server/src/effort-estimator.ts';
import { haikuMeetingNamer } from '../packages/server/src/meeting-namer.ts';
import { createHaikuNotesComposer } from '../packages/server/src/meeting-notes-composer.ts';
import { createHaikuTaskCaptureExtractor } from '../packages/server/src/meeting-task-capture.ts';
import { createNotesMethodComposer } from '../packages/server/src/notes-method-composer.ts';
import { haikuReviewJudge } from '../packages/server/src/review-judge.ts';
import { ThreadSummarizer, resolveKeySlotFrom } from '../packages/server/src/summarize.ts';
import { createHaikuTidy } from '../packages/server/src/voice-feedback-tidy.ts';
import { haikuVoiceComplete } from '../packages/server/src/voice.ts';
import { resolveEvalCredentialFrom } from './eval-credential.ts';

/**
 * A stand-in for a key, so the lookup can resolve with nothing real in
 * reach. It is not a credential and no request is made with it: every
 * adapter below is constructed and none is invoked.
 */
const PLACEHOLDER = 'placeholder-no-request-is-made-with-this';

/** The env override `readKeychainPassword` honours for a Keychain service. */
function overrideVarFor(service: string): string {
  return service.toUpperCase().replace(/-/g, '_');
}

/** Build every adapter, in the environment this process is standing in. */
function driveEveryPath(): void {
  new ThreadSummarizer({});
  createHaikuNotesComposer({});
  createNotesMethodComposer({ methodFor: () => 'original' });
  createHaikuTaskCaptureExtractor({});
  haikuMeetingNamer({});
  haikuVoiceComplete({});
  createHaikuTidy({});
  haikuEffortEstimator({});
  haikuReviewJudge({});
  haikuAnswerCoverage({});
  // The two harness entry points. `resolveEvalCredentialFrom` IS what
  // `scripts/notes-eval.ts` calls, and the cost scripts resolve through the
  // same function this one names.
  resolveEvalCredentialFrom(undefined, readThroughOverrideOnly, process.env);
  costScriptResolution();
}

/**
 * A Keychain reader that consults ONLY the env override, never `security`.
 * The cost scripts and the eval take a reader as a parameter; the adapters
 * do not, and for those the override inside `readKeychainPassword` does the
 * same job.
 */
function readThroughOverrideOnly(service: string): string | null {
  return process.env[overrideVarFor(service)] ?? null;
}

/** What `scripts/notes-prompt-cost.ts` and its two siblings resolve, with no
 *  `--api-key` flag given. */
function costScriptResolution(): void {
  resolveKeySlotFrom('cost-script', undefined, readThroughOverrideOnly, process.env);
}

/**
 * Every feature switch that decides whether an adapter is BUILT AT ALL.
 *
 * A path whose feature is off resolves nothing and drops out of the trace, so
 * a run under `CW_REVIEW_GATE=0` would otherwise report eleven happy paths
 * and never say which one it stopped looking at. The trace turns each of them
 * on for its own process only.
 */
const FEATURE_SWITCHES = [
  'CW_SUMMARIES',
  'CW_MEETING_NOTES',
  'CW_MEETING_TASKS',
  'CW_MEETING_TITLES',
  'CW_REVIEW_GATE',
  'CW_EFFORT_ESTIMATE',
  'CW_ANSWER_COVERAGE',
] as const;

/**
 * What each path MUST resolve to, per pass. Anything else — a `ci-token` from
 * an access token in the environment, an `explicit` argument, a path that
 * resolved nothing, or a path missing from the trace altogether — is a
 * failure, because the claim being checked is "this exact slot paid", not
 * "at least it was not the other one".
 *
 * `notes-eval` is the one deliberate exception: it strips the prod marker on
 * purpose, so the eval harness bills the eval key wherever it runs.
 */
function expectedRole(path: ClaudeCallPath, prodMarker: boolean): ClaudeKeyRole {
  if (path === 'notes-eval') return 'eval';
  return prodMarker ? 'prod' : 'eval';
}

function pass(label: string, prodMarker: boolean): readonly string[] {
  resetClaudeSlotTrace();
  if (prodMarker) process.env[LAUNCHD_JOB_ENV] = PROD_SERVICE_LABEL;
  else Reflect.deleteProperty(process.env, LAUNCHD_JOB_ENV);
  driveEveryPath();
  const trace = claudeSlotTrace();
  console.log(`\n== ${label} ==`);
  for (const use of trace) console.log(`  ${describeSlotUse(use)}`);

  const seen = new Map<string, ClaudeSlotUse>(trace.map((u) => [u.path, u]));
  const problems: string[] = [];
  for (const path of CLAUDE_CALL_PATHS) {
    const use = seen.get(path);
    if (use === undefined) {
      problems.push(`${path}: never resolved — the path did not run in this pass`);
      continue;
    }
    const want = expectedRole(path, prodMarker);
    if (use.slot === null) problems.push(`${path}: no credential, expected the ${want} slot`);
    else if (use.slot.role !== want) {
      problems.push(`${path}: read ${use.slot.name} (${use.slot.role}), expected ${want}`);
    }
  }
  return problems;
}

// Both slots resolve through the override, so `security` is never spawned and
// no real key exists in this process at any point.
process.env[overrideVarFor(EVAL_KEYCHAIN_SERVICE)] = PLACEHOLDER;
process.env[overrideVarFor(KEYCHAIN_SERVICE)] = PLACEHOLDER;
// Every adapter has to be BUILT for its resolution to be traceable, and an
// access token in the environment would shadow both Keychain slots — which is
// a real answer for a CI job and the wrong question for this trace.
for (const flag of FEATURE_SWITCHES) process.env[flag] = '1';
Reflect.deleteProperty(process.env, ACCESS_TOKEN_ENV);

const problems = [
  ...pass('no launchd prod marker — terminal, staging, CI, dev server', false),
  ...pass('launchd prod marker present — the prod service', true),
];
if (problems.length === 0) {
  console.log(`\nOK: all ${CLAUDE_CALL_PATHS.length} paths read the expected slot in both passes.`);
  process.exit(0);
}
console.log(`\nFAIL: ${problems.length} path(s) did not read the slot they must:`);
for (const p of problems) console.log(`  ${p}`);
process.exit(1);
