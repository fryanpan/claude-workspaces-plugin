/**
 * Which Claude key this process may spend: prod's, or the eval key.
 *
 * Bryan, 2026-09-11: local development and CI use the eval key only, and
 * prod's key is spent only by real meetings in a workspace. Until then every
 * server on this Mac read the same Keychain item — prod under launchd,
 * `bun run staging`, a builder's dev server, the one `check:client-boot`
 * spawns — so any of them could spend prod's key, and the 2026-09-09 outage
 * showed what exhausting that key costs a meeting.
 *
 * HOW PROD IS RECOGNISED. launchd puts `XPC_SERVICE_NAME=<job label>` in the
 * environment of every job it starts, and `scripts/serve.ts` hands its
 * environment on to the server it spawns. So prod carries the marker with no
 * configuration of its own: it comes from the plist's `Label`, which every
 * install writes. Nothing else holds that value by accident. A terminal, a
 * Claude Code session, staging, a test runner and a CI job each see their own
 * app's value, `0`, or nothing at all. Only a DESCENDANT of the prod job
 * inherits the label, and prod spawns git, `bun install`, `security` and the
 * plugin updater, none of which starts a server.
 *
 * `CW_DATA_DIR`, the other candidate, is refused for two reasons. Scripts and
 * tests set it on purpose, to point a run at a corpus (prod's included), so it
 * can be true by accident. And it sits in a plist key added by hand that the
 * install template does not write, so a reinstall would quietly take prod off
 * Claude.
 *
 * Pure: the environment and the Keychain reader are parameters, so the choice
 * is tested without touching a real Keychain.
 */
import type { EnvLike } from '@claude-workspaces/core/env-names';

/** The launchd job that IS prod. `deploy.ts` restarts it by this name. */
export const PROD_SERVICE_LABEL = 'com.fryanpan.claude-workspaces';

/** The variable launchd sets to the label of the job it started. */
export const LAUNCHD_JOB_ENV = 'XPC_SERVICE_NAME';

/** Prod's Keychain item — read by the prod service and nothing else. */
export const KEYCHAIN_SERVICE = 'claude-workspaces-summary-api-key';

/**
 * Prod's pre-rename item, still read if the current one holds nothing.
 *
 * Deliberately NOT migrated by `scripts/migrate-rename.ts`. Copying a
 * keychain item means reading the secret out and writing it back, which puts
 * the key in a process's memory and its argv for the benefit of saving one
 * manual command — and the operator re-keying by hand is both cheap and the
 * act of consent this feature is gated on. Reading the old name costs one
 * failed lookup at construction and keeps summaries alive across the flag day
 * with nobody touching the keychain at all.
 */
export const KEYCHAIN_SERVICE_LEGACY = 'live-feedback-summary-api-key';

/** The eval key's item. Every Claude call made outside prod bills this one. */
export const EVAL_KEYCHAIN_SERVICE = 'claude-workspaces-eval-api-key';

/** The env override `readKeychainPassword` honours for that item — its
 *  service name uppercased, dashes to underscores. */
export const EVAL_KEY_ENV = 'CLAUDE_WORKSPACES_EVAL_API_KEY';

/** Env var holding an already-exchanged access token — CI mints one from its
 *  own OIDC identity. Only the meeting-notes adapters accept one; the rest
 *  send a key or nothing. */
export const ACCESS_TOKEN_ENV = 'CW_SUMMARY_ACCESS_TOKEN';

/** Is this process the prod launchd service? */
export function isProdService(env: EnvLike): boolean {
  return env[LAUNCHD_JOB_ENV] === PROD_SERVICE_LABEL;
}

/**
 * `env` with the prod marker removed, for a caller that must never count as
 * prod wherever it runs — the note-taking eval.
 */
export function withoutProdMarker(env: EnvLike): EnvLike {
  const copy = { ...env };
  Reflect.deleteProperty(copy, LAUNCHD_JOB_ENV);
  return copy;
}

/**
 * The Keychain items this process may read a Claude key from, in order.
 *
 * Outside prod the answer is the eval item and nothing else: not prod's item,
 * not its legacy name, and so not their env overrides either, because
 * `readKeychainPassword` only consults the override of an item it was asked
 * for.
 */
export function claudeKeyServices(env: EnvLike): readonly string[] {
  return isProdService(env) ? [KEYCHAIN_SERVICE, KEYCHAIN_SERVICE_LEGACY] : [EVAL_KEYCHAIN_SERVICE];
}

/** The command that adds the key THIS process reads — the eval item, outside prod. */
export function claudeKeyAddHint(env: EnvLike): string {
  return `security add-generic-password -a "$USER" -s ${claudeKeyServices(env)[0]} -w`;
}

/** What goes off-machine only with a key, named once so every boot line agrees. */
const KEY_ONLY_FEATURES =
  'thread summaries, task capture, the review gate, effort estimates and the voice fast path';

/**
 * The boot's single line on which credential this server spends, or that it
 * spends none. It names Keychain items and variables, never a value: `read`'s
 * answer and the token are only tested for presence.
 *
 * A token counts as well as a key, because the meeting-notes adapters take one
 * (`resolveCredentialFrom`) and prefer it — a line saying "no Claude" while
 * notes were leaving the machine on a token would be the silent case this
 * line exists to end.
 */
export function describeClaudeKey(env: EnvLike, read: (service: string) => string | null): string {
  const prod = isProdService(env);
  const found = claudeKeyServices(env).some((service) => {
    try {
      return Boolean(read(service));
    } catch {
      // A missing item throws; that is the "no key" answer.
      return false;
    }
  });
  const token = Boolean(env[ACCESS_TOKEN_ENV]?.trim());
  const who = prod ? 'prod service' : 'not the prod service';
  const tokenNote = token
    ? ` Meeting notes spend the access token in ${ACCESS_TOKEN_ENV} instead.`
    : '';
  if (found) {
    const key = prod
      ? `prod's key (${KEYCHAIN_SERVICE})`
      : `the eval key (${EVAL_KEYCHAIN_SERVICE}), never prod's`;
    return `[claude] ${who}: Claude calls spend ${key}.${tokenNote}`;
  }
  const missing = prod ? 'no key' : 'no eval key';
  const neverProd = prod ? '' : " Prod's key is never read outside the launchd service.";
  const off = token
    ? `meeting notes spend the access token in ${ACCESS_TOKEN_ENV}; ${KEY_ONLY_FEATURES} are off.`
    : `running without Claude — meeting notes, ${KEY_ONLY_FEATURES} are off.`;
  return `[claude] ${who} with ${missing}: ${off}${neverProd} Add the key with: ${claudeKeyAddHint(env)}`;
}
