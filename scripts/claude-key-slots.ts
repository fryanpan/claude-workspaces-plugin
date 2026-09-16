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
  type ClaudeSlotUse,
  claudeSlotTrace,
  describeSlotUse,
  resetClaudeSlotTrace,
} from '../packages/server/src/claude-key-slot.ts';
import {
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

function pass(label: string, prodMarker: boolean): readonly ClaudeSlotUse[] {
  resetClaudeSlotTrace();
  if (prodMarker) process.env[LAUNCHD_JOB_ENV] = PROD_SERVICE_LABEL;
  else Reflect.deleteProperty(process.env, LAUNCHD_JOB_ENV);
  driveEveryPath();
  const trace = claudeSlotTrace();
  console.log(`\n== ${label} ==`);
  for (const use of trace) console.log(`  ${describeSlotUse(use)}`);
  return trace;
}

// Both slots resolve through the override, so `security` is never spawned and
// no real key exists in this process at any point.
process.env[overrideVarFor(EVAL_KEYCHAIN_SERVICE)] = PLACEHOLDER;
process.env[overrideVarFor(KEYCHAIN_SERVICE)] = PLACEHOLDER;

const off = pass('no launchd prod marker — terminal, staging, CI, dev server', false);
const on = pass('launchd prod marker present — the prod service', true);

const leaked = off.filter((u) => u.slot?.role === 'prod');
console.log(
  leaked.length === 0
    ? `\nOK: all ${off.length} paths read the eval slot outside the prod service.`
    : `\nFAIL: ${leaked.map((u) => u.path).join(', ')} read a prod slot outside prod.`,
);
const strays = on.filter((u) => u.slot?.role === 'eval' && u.path !== 'notes-eval');
console.log(
  strays.length === 0
    ? `OK: all ${on.length} paths read the prod slot inside the prod service (the eval harness excepted, by design).`
    : `FAIL: ${strays.map((u) => u.path).join(', ')} read the eval slot inside prod.`,
);
process.exit(leaked.length === 0 && strays.length === 0 ? 0 : 1);
