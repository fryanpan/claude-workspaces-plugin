/**
 * Where a secret a review item asked for is stored, and the one line an agent
 * runs to read it back.
 *
 * It lives in `core` because two packages have to agree about it and neither
 * can import the other: the server's writer spells the stored name when it
 * runs `security`, and the MCP tool descriptions tell an agent the name to
 * read. Those were two hand-written copies of the same prefix, in prose, with
 * nothing that went red when one of them moved. Now the prose is built from
 * this, so there is one spelling and a rename cannot leave an agent reading
 * an entry that does not exist.
 *
 * Nothing here reads or writes a value. This module is names and one command
 * string; the value never passes through this package at all.
 */

/**
 * The Keychain account every stored secret sits under.
 *
 * One constant, not per board and not per person. The Keychain addresses an
 * item by (account, service), the `service` is already the name the item's
 * author chose and the reader saw, and an account derived from a person would
 * put an identity into a store key for no lookup's benefit. It is also what
 * makes the read-back command a single fixed line an agent can be told.
 */
export const SECRET_ACCOUNT = 'claude-workspaces';

/**
 * The namespace every name a review item asks for is stored under.
 *
 * WITHOUT THIS, TWO DIFFERENT THINGS SHARE ONE FLAT KEYSPACE. The Keychain
 * has no folders: the server reads its OWN configuration out of it by service
 * name — the tunnel token, the transcription keys — and that lookup falls
 * back to "any account" when the operator's own entry is absent. A review item
 * naming one of those would therefore write an entry the server later reads as
 * its own configuration, and the write is an update-in-place, so nothing would
 * refuse it. The prefix is what makes that unreachable: a name asked for
 * through an item can only ever land under this namespace, and nothing in this
 * repo reads its own configuration from under it.
 *
 * The card, the answer line and the activity feed all keep showing the name
 * the item asked for. The prefix is between the writer and the store, and
 * `secretReadCommand` is what tells an agent the full name.
 */
export const SECRET_SERVICE_PREFIX = 'claude-workspaces-secret.';

/** The name an asked-for secret is actually stored under. One function, so
 *  the write, the read-back check and the command an agent is handed cannot
 *  spell it three ways. */
export function storedSecretService(service: string): string {
  return `${SECRET_SERVICE_PREFIX}${service}`;
}

/**
 * The longest value a secret field takes, in characters.
 *
 * Here rather than beside the writer because the card has to say it BEFORE a
 * request is sent, and the board cannot import the server. The number itself
 * is chosen from the store: `security -i` cuts a command line at 4,095
 * characters and stores the part that fit, and `SECRET_COMMAND_LINE_BUDGET`
 * below holds every line to three quarters of that. A value this long, of
 * ASCII text, under the
 * longest name an item may declare, stays inside it — `secret-store.test.ts`
 * builds that line and checks. A real API key is around a hundred.
 */
export const SECRET_VALUE_MAX_CHARS = 2000;

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

/**
 * The one line an agent runs to read a value back, once the answer says it
 * was saved.
 *
 * A formatter rather than a reader, on purpose: this product never reads a
 * stored value back to an agent, and a verb that did would be a door with the
 * secret on the wrong side of it. The agent runs this itself, in its own
 * session, against its own Keychain access.
 *
 * It is called in two places that must not drift: the MCP tool descriptions,
 * which are where an agent actually reads it, and the server's own
 * documentation of the door. Pass the bare name the item asked for — the
 * prefix is added here.
 */
export function secretReadCommand(service: string): string {
  return `security find-generic-password -a ${SECRET_ACCOUNT} -s ${storedSecretService(service)} -w | base64 --decode`;
}

/**
 * Why the command ends in a decode.
 *
 * `security` takes its input a line at a time — first from a prompt, now as
 * one command line of `security -i`. A value carrying a newline cannot go down
 * either path whole: measured on macOS 26.2, the three-line attempt through
 * the prompt printed "passwords don't match" three times and exited 1 with
 * nothing stored. So a reader pasting an SSH key or a service-account file had
 * a value the store could not take.
 *
 * Encoding is what makes it one line. Every value is base64 on the way in,
 * whether or not it has a newline in it — one format, so no reader has to
 * know which kind of value they pasted and no agent has to guess which of two
 * commands to run. `base64 --decode` is spelled the same on macOS and on GNU
 * coreutils, both verified here.
 *
 * The consequence worth stating: what sits in the Keychain is the ENCODING,
 * not the value. Encoding is not protection and is not claimed as any — the
 * protection is the Keychain — but anything reading the entry without the
 * decode gets base64 rather than the secret.
 */
export const SECRET_STORED_ENCODING = 'base64' as const;
