/**
 * The credential the note-taking EVAL spends, which is deliberately not the
 * one live meetings spend.
 *
 * On 2026-09-09 an eval sweep and a live meeting were drawing on the same
 * key. The key hit its monthly limit; the meeting stopped taking notes. A
 * measurement job must not be able to take the product down, so the eval
 * reads a Keychain item of its own and nothing else.
 *
 * WHAT IS ACCEPTED, IN ORDER:
 *
 *  1. `--api-key <value>` — somebody named a credential in the same command.
 *     Explicit consent, and it wins over anything ambient.
 *  2. `CW_SUMMARY_ACCESS_TOKEN` — the short-lived token CI mints from its own
 *     OIDC identity for one run. It is not prod's key: nothing durable exists
 *     to exhaust, and the service account behind it is CI's.
 *  3. The Keychain item `claude-workspaces-eval-api-key`.
 *
 * WHAT IS REFUSED: prod's Keychain item, its legacy name, and the
 * `CW_SUMMARY_API_KEY` env override. Those are the live meeting's credential.
 * Absent an eval credential the run FAILS naming the item to add — it does
 * not quietly borrow prod's, which is the whole bug.
 *
 * Nothing here logs, returns or formats a credential VALUE. It answers a
 * `SummaryCredential`, whose value reaches exactly one header.
 */
import type { SummaryCredential } from '../packages/server/src/summarize.ts';

/** The Keychain item the eval reads. Prod's is a different name on purpose. */
export const EVAL_KEYCHAIN_SERVICE = 'claude-workspaces-eval-api-key';

/** Env var holding an already-exchanged access token — how CI runs. */
export const EVAL_ACCESS_TOKEN_ENV = 'CW_SUMMARY_ACCESS_TOKEN';

/**
 * What to tell somebody who has no eval credential. It names the item and
 * the command that adds it, and says in as many words that prod's key is not
 * a fallback — otherwise the obvious next move is to point the eval back at
 * the key this whole change exists to protect.
 */
export const EVAL_CREDENTIAL_HELP: string =
  'No eval credential. The note-taking eval spends its OWN key, never the one\n' +
  'live meetings use. Add it once with:\n' +
  `  security add-generic-password -a "$USER" -s "${EVAL_KEYCHAIN_SERVICE}" -w\n` +
  `or set ${EVAL_ACCESS_TOKEN_ENV} to an already-exchanged access token (how CI\n` +
  'runs), or pass --api-key. Nothing was run.';

/**
 * Resolve the eval's credential, or null when there is none.
 *
 * `read` is a parameter so a test can drive the ORDER — and prove which
 * service names are asked for — without touching a real Keychain. It may
 * throw for a missing item, exactly as `readKeychainPassword` does.
 */
export function resolveEvalCredentialFrom(
  explicit: string | null | undefined,
  read: (service: string) => string | null,
  env: Record<string, string | undefined>,
): SummaryCredential | null {
  if (explicit !== undefined) return explicit ? { kind: 'key', value: explicit } : null;
  const token = env[EVAL_ACCESS_TOKEN_ENV]?.trim();
  if (token) return { kind: 'token', value: token };
  try {
    const key = read(EVAL_KEYCHAIN_SERVICE);
    if (key) return { kind: 'key', value: key };
  } catch {
    // A missing item throws. That is the "not configured" answer, and the
    // caller prints `EVAL_CREDENTIAL_HELP` for it — there is nowhere else to
    // look, by design.
  }
  return null;
}
