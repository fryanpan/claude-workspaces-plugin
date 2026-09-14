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
 * value on stdin, the one command line `security -i` reads it from, the
 * read-back that turns exit 0 into evidence. Its runner takes stdin, which `KeychainRunner`
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
import {
  SECRET_ACCOUNT,
  SECRET_VALUE_MAX_CHARS,
  storedSecretService,
} from '@claude-workspaces/core/secret-name';

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
  SECRET_VALUE_MAX_CHARS,
  secretReadCommand,
  storedSecretService,
} from '@claude-workspaces/core/secret-name';

/** How long either command gets before it is killed. The write is local and
 *  returns in milliseconds; a wait past this is a locked keychain or a
 *  consent dialog, and a request must not hang on one. */
const SECRET_COMMAND_TIMEOUT_MS = 10_000;

/**
 * The longest line `security -i` reads as one command, measured.
 *
 * Interactive mode reads its commands from stdin a line at a time, and cuts a
 * line at this many characters: measured on macOS 26.2 by storing values of
 * one repeated letter under a throwaway name, a command line of 4,095
 * characters stored whole, and every longer one stored exactly the part that
 * fit — then ran the remainder as a command of its own ("unknown command").
 * A cut line does not fail; it stores a shorter value.
 */
const SECURITY_INTERACTIVE_LINE_MAX = 4095;

/**
 * The longest command line this module will send: three quarters of the
 * measured cap, so a later `security` with a slightly smaller buffer still
 * refuses here rather than cutting there.
 */
export const SECRET_COMMAND_LINE_BUDGET = Math.floor((SECURITY_INTERACTIVE_LINE_MAX * 3) / 4);

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
 * NEWLINES ARE FINE, AND THAT IS THE POINT. A browser `input` strips the
 * breaks from a pasted SSH key or service-account file, and `security` cannot
 * take a raw multi-line value on any path — measured on macOS 26.2, where a
 * three-line value through the old prompt printed "passwords don't match"
 * three times and stored nothing. `encodeSecretValue` is the fix: every value
 * goes to the store base64, so every value is one line and the newlines
 * survive. What this function still refuses is a NUL and an empty string — a
 * NUL survives the encoding, but it cannot survive the shell pipeline an agent
 * reads the value back through, so storing one would be storing something
 * nobody can use.
 */
export function isStorableSecretValue(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !value.includes('\u0000');
}

/**
 * The value as it goes to the store, and comes back from it.
 *
 * One format for every value — see `SECRET_STORED_ENCODING` in core for why
 * it is not conditional on the value having a newline in it, and for what is
 * and is not being claimed by encoding.
 */
export function encodeSecretValue(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/** Only the base64 alphabet may sit between the quotes of the command line:
 *  no quote, no backslash, no space, no newline. `encodeSecretValue` never
 *  produces anything else; this is what holds that true if it ever did. */
const BASE64_ONLY = /^[A-Za-z0-9+/]+={0,2}$/;

/** The one line `security -i` is handed. The value is the only thing in it
 *  that came from a reader, and it arrives here already encoded. */
function addCommandLine(storedService: string, encoded: string): string {
  return `add-generic-password -U -a ${SECRET_ACCOUNT} -s ${storedService} -w "${encoded}"`;
}

/**
 * Will this value go to the store whole?
 *
 * The door and the writer both ask, so a value the door accepts is never one
 * the writer then refuses mid-loop. Two limits and both are real: the
 * character count is the one a person is told, and the command line is the
 * one `security` cuts — a value within the first can still break the second
 * if its characters are wide, and it is refused rather than stored short.
 */
export function secretValueFits(service: string, value: string): boolean {
  if (value.length > SECRET_VALUE_MAX_CHARS) return false;
  const line = addCommandLine(storedSecretService(service), encodeSecretValue(value));
  return line.length <= SECRET_COMMAND_LINE_BUDGET;
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
 * THROUGH `security -i`, NOT THE PROMPT. `add-generic-password … -w` with no
 * argument prompts for the value, and that prompt reads at most 128
 * characters and exits 0 with the rest cut off — measured with 129, 144 and
 * 200-character inputs, all stored as 128. Base64 makes any value over 96
 * characters longer than that, so a real API key was stored truncated and
 * reported as a failed save (2026-09-14). Interactive mode takes the whole
 * command on stdin instead: `security`'s argument list is just `-i`, and the
 * value is on one line of its standard input, which no other process on the
 * machine can list. Its own cap is `SECURITY_INTERACTIVE_LINE_MAX`, and
 * `secretValueFits` keeps every line well inside it.
 *
 * THE READ-BACK IS NOT BELT AND BRACES. The prompt path exited 0 having
 * stored a cut value; a cut line in interactive mode stores a cut value too.
 * The exit code alone is not evidence that the value is in the store, so the
 * entry is read back and compared, and "saved" is a fact rather than a hope.
 * The value read back is compared and dropped; it reaches no caller, no
 * message and no log.
 *
 * A FAILED CHECK REMOVES THE ENTRY. `-U` has already replaced whatever was
 * there, so what the store holds after a mismatch is not the reader's value
 * under the reader's name — a cut key that an agent would read back and use.
 * It is deleted, by name and with no value in the arguments, so the name holds
 * nothing rather than something wrong.
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
  if (!isStorableSecretValue(value)) return { ok: false, error: 'bad-value' };
  if (!secretValueFits(service, value)) return { ok: false, error: 'value-too-long' };

  const stored = storedSecretService(service);
  const encoded = encodeSecretValue(value);
  if (!BASE64_ONLY.test(encoded)) return { ok: false, error: 'bad-value' };
  const wrote = await run('security', ['-i'], `${addCommandLine(stored, encoded)}\n`);
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
    await run('security', ['delete-generic-password', '-a', SECRET_ACCOUNT, '-s', stored], '');
    return { ok: false, error: 'verify-failed' };
  }
  return { ok: true };
}
