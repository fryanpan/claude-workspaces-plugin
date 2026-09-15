/**
 * The one command line a secret is stored with, and whether a value fits it.
 *
 * Its own module rather than a part of `secret-name.ts`, which the MCP
 * server imports for the read-back command: a bundler keeps a computed
 * constant in every bundle that imports its module, so the budget there
 * would ship in the plugin's bundle, which never measures a line.
 *
 * Here because two packages measure the same line: the server's writer runs
 * it, and the board refuses a value that will not fit before anything is
 * sent. Nothing here reads, writes or keeps a value.
 */
import { SECRET_ACCOUNT, SECRET_VALUE_MAX_CHARS, storedSecretService } from './secret-name.ts';

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
 * The longest command line the writer will send: three quarters of the
 * measured cap, so a later `security` with a slightly smaller buffer still
 * refuses here rather than cutting there.
 */
export const SECRET_COMMAND_LINE_BUDGET = Math.floor((SECURITY_INTERACTIVE_LINE_MAX * 3) / 4);

/**
 * The one line `security -i` is handed to store a value. Here, beside the
 * budget, so the card and the writer measure the same line: the writer runs
 * it, and the card only needs its length. `encoded` is the base64 of the
 * value and nothing else; the server checks that before it runs anything.
 */
export function secretAddCommandLine(service: string, encoded: string): string {
  return `add-generic-password -U -a ${SECRET_ACCOUNT} -s ${storedSecretService(service)} -w "${encoded}"`;
}

/**
 * How many characters of base64 a value becomes, without encoding it.
 *
 * Measured in UTF-8 bytes, which is what the writer encodes: a character
 * outside ASCII takes two to four of them, so a value well inside
 * `SECRET_VALUE_MAX_CHARS` can still be too long for the line. A lone
 * surrogate counts as the three bytes of U+FFFD, which is what both
 * `TextEncoder` and the server's `Buffer` write for one.
 */
export function encodedSecretLength(value: string): number {
  return 4 * Math.ceil(new TextEncoder().encode(value).length / 3);
}

/**
 * Will this value go to the store whole? The card's copy of the question.
 *
 * The server's `secretValueFits` (`packages/server/src/secret-store.ts`)
 * builds the real line from the real encoding and stays the authority; this
 * answers from the encoded length alone, so the board can refuse a value
 * before anything is sent. `secret-store.test.ts` holds the two to the same
 * answer on each side of the boundary.
 */
export function secretValueFitsStore(service: string, value: string): boolean {
  if (value.length > SECRET_VALUE_MAX_CHARS) return false;
  const lineLength = secretAddCommandLine(service, '').length + encodedSecretLength(value);
  return lineLength <= SECRET_COMMAND_LINE_BUDGET;
}
