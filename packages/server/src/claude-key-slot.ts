/**
 * WHICH SLOT PAID, named so a run can say it out loud.
 *
 * `claude-key-source.ts` decides which Keychain items this process may read.
 * That is configuration, and reading it back proves nothing about what a
 * RUNNING process picked up: the environment a launchd job inherits is not
 * the environment a shell shows, so "the guard is in the code" and "the guard
 * held on this run" are different claims. This module is the second one — the
 * vocabulary a call path uses to record the slot it actually consulted, and
 * the process-wide ledger those records land in.
 *
 * A SLOT IS A NAME, NEVER A VALUE. The Keychain service, or the environment
 * variable, plus the role that slot has — prod or eval. Both halves are
 * configuration that already appears in this repo in plain text. A key, a
 * prefix of one, or a hash of one is none of those things and must never be
 * derived here or anywhere downstream: a hash enables re-look-up, which is
 * the whole reason the rule is "name the slot" rather than "identify the key".
 *
 * NOTHING IN HERE READS A VALUE TO DECIDE. The role comes from which name was
 * consulted, so the decision is made before any secret exists in the process.
 */
import type { EnvLike } from '@claude-workspaces/core/env-names';
import {
  ACCESS_TOKEN_ENV,
  EVAL_KEYCHAIN_SERVICE,
  KEYCHAIN_SERVICE,
  KEYCHAIN_SERVICE_LEGACY,
  claudeKeyServices,
} from './claude-key-source.ts';

/**
 * What a slot is allowed to pay for.
 *
 * `prod` is the meeting bill; `eval` is development, CI and every harness.
 * `ci-token` is the short-lived exchanged token a CI job mints from its own
 * OIDC identity, which bills whatever that identity bills and is therefore
 * its own role rather than a flavour of either key. `explicit` is a value a
 * person typed into the command that is running — the one case where the
 * process cannot name a configured slot, and says so instead of guessing.
 */
export type ClaudeKeyRole = 'prod' | 'eval' | 'ci-token' | 'explicit';

/** One configured place a Claude credential may come from. Names only. */
export interface ClaudeKeySlot {
  /** The Keychain service, or the environment variable's name. */
  readonly name: string;
  /** What that slot is allowed to pay for. */
  readonly role: ClaudeKeyRole;
}

/** The role each configured service name has. The only mapping there is. */
const ROLE_BY_SERVICE: Readonly<Record<string, ClaudeKeyRole>> = {
  [KEYCHAIN_SERVICE]: 'prod',
  [KEYCHAIN_SERVICE_LEGACY]: 'prod',
  [EVAL_KEYCHAIN_SERVICE]: 'eval',
};

/**
 * The slot a Keychain service name IS.
 *
 * An unrecognised name is refused rather than defaulted. A default would make
 * a service nobody mapped read as the safe role, which is exactly how a new
 * item would come to spend prod's money while the record said "eval".
 */
export function slotForService(service: string): ClaudeKeySlot {
  const role = ROLE_BY_SERVICE[service];
  if (role === undefined) throw new Error(`No Claude key role is configured for "${service}"`);
  return { name: service, role };
}

/** The exchanged access token's slot. The variable's name, never its value. */
export const ACCESS_TOKEN_SLOT: ClaudeKeySlot = { name: ACCESS_TOKEN_ENV, role: 'ci-token' };

/**
 * A credential handed in on the command line or by a caller.
 *
 * There is no configured slot to name, so the record says that in as many
 * words. It is not "unknown": the process knows exactly where it came from,
 * and that place is not configuration.
 */
export const EXPLICIT_SLOT: ClaudeKeySlot = { name: 'explicit-argument', role: 'explicit' };

/** The slots this process may read a key from, in the order it tries them. */
export function claudeKeySlots(env: EnvLike): readonly ClaudeKeySlot[] {
  return claudeKeyServices(env).map(slotForService);
}

/**
 * EVERY CODE PATH IN THIS REPO THAT REACHES api.anthropic.com.
 *
 * A closed union, so a path that resolves a credential has to name itself
 * here before it compiles, and the trace below can be read as a list of
 * paths rather than as whatever strings happened to be passed.
 */
export type ClaudeCallPath =
  | 'thread-summary'
  | 'meeting-notes-compose'
  | 'meeting-notes-ledger'
  | 'meeting-task-capture'
  | 'meeting-namer'
  | 'voice-complete'
  | 'voice-feedback-tidy'
  | 'effort-estimate'
  | 'review-gate'
  | 'answer-coverage'
  | 'notes-eval'
  | 'cost-script';

/** One path's answer: the slot it resolved, or null for "it found none". */
export interface ClaudeSlotUse {
  readonly path: ClaudeCallPath;
  readonly slot: ClaudeKeySlot | null;
}

/**
 * The latest resolution each path made in THIS process.
 *
 * Latest rather than every one, because each adapter resolves once at
 * construction and then holds what it found; a list with one line per call
 * would say the same thing thousands of times over a meeting.
 */
const trace = new Map<ClaudeCallPath, ClaudeKeySlot | null>();

/** Record what a path resolved. Called at the resolution, not at the call. */
export function noteClaudeSlot(path: ClaudeCallPath, slot: ClaudeKeySlot | null): void {
  trace.set(path, slot);
}

/** What every path has resolved so far, in a stable order. */
export function claudeSlotTrace(): readonly ClaudeSlotUse[] {
  return [...trace.entries()]
    .map(([path, slot]) => ({ path, slot }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Empty the ledger. For a test that drives several environments in a row. */
export function resetClaudeSlotTrace(): void {
  trace.clear();
}

/** One line a person can read: the path, the slot's name, and its role. */
export function describeSlotUse(use: ClaudeSlotUse): string {
  return use.slot === null
    ? `${use.path}: no credential`
    : `${use.path}: ${use.slot.name} (${use.slot.role})`;
}
