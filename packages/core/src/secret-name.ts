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
  return `security find-generic-password -a ${SECRET_ACCOUNT} -s ${storedSecretService(service)} -w`;
}
