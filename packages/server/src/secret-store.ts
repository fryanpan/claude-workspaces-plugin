/**
 * Writing a secret the reader handed over, and nothing else.
 *
 * THE ONE RULE THIS MODULE EXISTS FOR: the value goes to the store on
 * **stdin**, never in an argument. `ps` on this machine lists every running
 * process's whole argument list to every user, so a value passed as
 * `-w <value>` is readable by anything running here for as long as the
 * command lives — and `security`'s own usage line says so ("Use of the -p or
 * -w options is insecure"). Passing the value on stdin is the documented
 * alternative, and it is the only way this module will write one.
 *
 * The store is the macOS Keychain. That is the repo's security posture for a
 * high-stakes credential (`.claude/rules/security-posture.md`, rule 7:
 * "prefer the OS keystore over disk"), and it is also the reason nothing in
 * here writes a file: there is no on-disk copy of a value to leak, quarantine
 * or forget to delete. The Keychain is named HERE and in the tool description
 * that tells an agent how to read a value back, and nowhere a person reads —
 * on every surface the reader sees, the word is "secret".
 *
 * NOT `share/keychain.ts`, and the split is deliberate. That module READS the
 * operator's own configuration out of the Keychain — a Cloudflare token, the
 * Google OAuth pair — synchronously, addressed by service, with an env
 * override so a test can supply one. This one WRITES a value a reader just
 * handed over, and every property that matters here is about the write: the
 * value on stdin, the double line the prompt needs, the read-back that turns
 * exit 0 into evidence. Its runner takes stdin, which `KeychainRunner`
 * cannot express, so there is no interface to share — only the binary.
 *
 * THE VALUE NEVER ENTERS A MESSAGE. Not an error, not a log line, not a
 * thrown `Error`. Every failure this module reports is a bare tag naming
 * which step failed; the caller turns it into a sentence that also holds no
 * value. That is a rule about this file rather than a property of it, so
 * `secret-store.test.ts` asserts it against a runner that records what it was
 * given.
 */
import { isSecretServiceName } from '@claude-workspaces/core';
import { SECRET_ACCOUNT, storedSecretService } from '@claude-workspaces/core/secret-name';

/**
 * Where a stored secret lands, and the line an agent reads it back with.
 *
 * Re-exported rather than declared here: the MCP tool descriptions are built
 * from the same names, and neither package can import the other, so they live
 * in `core`. This module is the only thing in the server that turns one of
 * them into a command argument. Read `core/secret-name.ts` for why the
 * namespace exists — it is the reason a review item cannot name, and
 * overwrite, an entry this server reads its own configuration from.
 */
export {
  SECRET_ACCOUNT,
  SECRET_SERVICE_PREFIX,
  secretReadCommand,
  storedSecretService,
} from '@claude-workspaces/core/secret-name';

/** How long either command gets before it is killed. The write is local and
 *  returns in milliseconds; a wait past this is a locked keychain or a
 *  consent dialog, and a request must not hang on one. */
const SECRET_COMMAND_TIMEOUT_MS = 10_000;

/**
 * The longest value this will store.
 *
 * Generous for a key or a token and far under anything that would be a
 * pasted file. It bounds what one request can push through a spawned
 * process's stdin, which is the reason it is here rather than at the door.
 */
export const SECRET_VALUE_MAX_CHARS = 4096;

export interface SecretRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command with `stdin` on its standard input and hand back what it
 * said. INJECTED, so the unit test never touches the real Keychain — and so
 * that what the test asserts is the thing this module actually does with a
 * value rather than a re-description of it.
 */
export type SecretRunner = (
  file: string,
  args: string[],
  stdin: string,
) => Promise<SecretRunResult>;

/** Why a write did not happen. Tags, never sentences, and never a value — see
 *  the head of this file. */
export type SecretWriteFailure =
  | 'bad-service'
  | 'bad-value'
  | 'value-too-long'
  | 'write-failed'
  | 'verify-failed';

export type SecretWriteResult = { ok: true } | { ok: false; error: SecretWriteFailure };

/**
 * The seam the server is wired with: name a service, hand over a value, learn
 * only whether it landed. Nothing in the result can carry the value back, and
 * the shape is named here rather than in the route's context module so the
 * writer and every holder of it move together.
 */
export type SecretWriter = (service: string, value: string) => Promise<SecretWriteResult>;

/**
 * Is this something the line-based store can hold?
 *
 * `security` reads the value from a PROMPT, which is line-based: it takes one
 * line, then asks for it again to confirm. So a value carrying a newline
 * cannot go down this path — the second line would be read as the
 * confirmation, the two would differ, and (this is the part worth knowing)
 * the command RETRIES and then exits 0 having stored an empty password.
 * Measured, not assumed. Refusing here is how that is never reachable; the
 * read-back below is what catches it if it ever is.
 *
 * The practical consequence is a limit worth stating: a multi-line secret (a
 * PEM block) cannot be handed over this way today.
 */
export function isStorableSecretValue(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !/[\r\n\0]/.test(value);
}

/** The default runner: spawn the binary, write stdin, read both pipes, and
 *  kill it rather than wait forever. */
async function spawnCommand(file: string, args: string[], stdin: string): Promise<SecretRunResult> {
  const proc = Bun.spawn([file, ...args], {
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const killer = setTimeout(() => proc.kill(), SECRET_COMMAND_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(killer);
  }
}

/**
 * Store one value under one name, and prove it landed.
 *
 * THE READ-BACK IS NOT BELT AND BRACES. `security add-generic-password` exits
 * 0 after storing an EMPTY password when its two prompted reads disagree —
 * measured on this machine — so the exit code alone is not evidence that the
 * value is in the store. Writing the value twice is what makes the reads
 * agree; reading it back and comparing is what makes "saved" a fact rather
 * than a hope. The value read back is compared and dropped; it reaches no
 * caller, no message and no log.
 *
 * `-U` so a second hand-over replaces the first rather than failing on an
 * item that already exists: re-answering an ask is a thing people do, and a
 * rotated key is the commonest reason to.
 */
export async function storeSecret(
  service: string,
  value: string,
  run: SecretRunner = spawnCommand,
): Promise<SecretWriteResult> {
  if (!isSecretServiceName(service)) return { ok: false, error: 'bad-service' };
  if (typeof value === 'string' && value.length > SECRET_VALUE_MAX_CHARS) {
    return { ok: false, error: 'value-too-long' };
  }
  if (!isStorableSecretValue(value)) return { ok: false, error: 'bad-value' };

  // `-w` LAST, with nothing after it: that is what makes `security` prompt,
  // and prompting is what makes it read from stdin. Given an argument it
  // would take the value on argv, which is the one thing this module exists
  // to prevent — and a trailing keychain path would be eaten by the flag.
  const stored = storedSecretService(service);
  const wrote = await run(
    'security',
    ['add-generic-password', '-U', '-a', SECRET_ACCOUNT, '-s', stored, '-w'],
    // Twice: the prompt asks, then asks again to confirm. See the note above
    // for what a single line does.
    `${value}\n${value}\n`,
  );
  if (wrote.code !== 0) return { ok: false, error: 'write-failed' };

  const readBack = await run(
    'security',
    ['find-generic-password', '-a', SECRET_ACCOUNT, '-s', stored, '-w'],
    '',
  );
  // `-w` prints the value and a newline, and nothing else.
  if (readBack.code !== 0 || readBack.stdout.replace(/\n$/, '') !== value) {
    return { ok: false, error: 'verify-failed' };
  }
  return { ok: true };
}
