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
 * Is this something the store can hold?
 *
 * NEWLINES ARE FINE NOW, AND THAT IS THE POINT. `security` reads the value
 * from a PROMPT, which is line-based: one line, then the same line again to
 * confirm. A raw multi-line value therefore cannot go down that path at all —
 * measured on macOS 26.2, where a three-line value printed "passwords don't
 * match" three times and exited 1 with nothing stored. Which meant a reader
 * pasting an SSH key or a service-account file was refused by this function,
 * and — worse, and what the UX walk found — a browser `input` had already
 * stripped the newlines before the value ever reached here, so a three-line
 * paste arrived as one joined line, passed this check, and was stored
 * silently wrong under the name the reader thought held their key.
 *
 * `encodeSecretValue` is the fix: every value goes to the prompt base64, so
 * every value is one line and the newlines survive. What this function still
 * refuses is a NUL and an empty string — a NUL survives the encoding, but it
 * cannot survive the shell pipeline an agent reads the value back through, so
 * storing one would be storing something nobody can use.
 */
export function isStorableSecretValue(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !value.includes('\u0000');
}

/**
 * The value as it goes to the prompt, and comes back from it.
 *
 * One format for every value — see `SECRET_STORED_ENCODING` in core for why
 * it is not conditional on the value having a newline in it, and for what is
 * and is not being claimed by encoding.
 */
export function encodeSecretValue(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
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
  // ENCODED, so the prompt sees one line whatever the reader pasted. A
  // multi-line value sent raw does not half-work: it fails the confirm read
  // and stores nothing.
  const encoded = encodeSecretValue(value);
  const wrote = await run(
    'security',
    ['add-generic-password', '-U', '-a', SECRET_ACCOUNT, '-s', stored, '-w'],
    // Twice: the prompt asks, then asks again to confirm. See the note above
    // for what a single line does.
    `${encoded}\n${encoded}\n`,
  );
  if (wrote.code !== 0) return { ok: false, error: 'write-failed' };

  const readBack = await run(
    'security',
    ['find-generic-password', '-a', SECRET_ACCOUNT, '-s', stored, '-w'],
    '',
  );
  // `-w` prints what is stored and a newline, and nothing else. Compared in
  // the ENCODED form: byte-for-byte equality there is equality of the value,
  // and it keeps the decoded value from being materialised a second time.
  if (readBack.code !== 0 || readBack.stdout.replace(/\n$/, '') !== encoded) {
    return { ok: false, error: 'verify-failed' };
  }
  return { ok: true };
}
