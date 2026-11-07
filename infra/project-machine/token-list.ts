/**
 * The central list of long-lived Claude tokens, on the Mac.
 *
 * The list holds only accounts Bryan owns (his decision, 2026-11-07), never
 * another person's: Anthropic's terms bar routing work through another
 * person's account. What is left open by the published text is in
 * `docs/process/project-machine.md`.
 *
 * Each token is one Keychain entry, `claude-token-list-<n>`, holding
 * `{ label, token, added }` as JSON. The Keychain cannot list its entries by
 * prefix, so the list is the slots 1 to `TOKEN_LIST_SLOTS`, read in order. An
 * entry is made once and never rewritten, which keeps `keychainCreate`'s
 * refusal to replace; an emptied slot is skipped. The first listed token is
 * the one a deploy takes when it is not told a label.
 *
 * A value goes to a child's stdin and nowhere else (`mac-ops.ts`). Every error
 * here names the entry or the label, never any part of a value.
 */
import { createHash } from 'node:crypto';
import { TOKEN_LABEL } from './lead-usage.ts';
import { keychainCreate, keychainHas, keychainRead } from './mac-ops.ts';
import { isSetupToken } from './org-signin.ts';

export const TOKEN_LIST_SLOTS = 32;
export const tokenSlot = (n: number): string => `claude-token-list-${n}`;
/** The Mac's walled lead's sign-in, which no org's lead may hold (review H2). */
const WALLED_LEAD_ENTRY = 'claude-lead-oauth-token';

export interface ListedToken {
  label: string;
  token: string;
  /** The day it joined the list, YYYY-MM-DD. A setup token lasts a year. */
  added: string;
}

function parseEntry(entry: string, raw: string): ListedToken {
  const bad = new Error(`the Keychain entry ${entry} does not hold a label and a token`);
  let v: Partial<ListedToken>;
  try {
    v = JSON.parse(raw) as Partial<ListedToken>;
  } catch {
    throw bad;
  }
  const { label, token, added } = v;
  if (typeof label !== 'string' || !TOKEN_LABEL.test(label)) throw bad;
  if (typeof token !== 'string' || !isSetupToken(token)) throw bad;
  return { label, token, added: typeof added === 'string' ? added : '' };
}

/** The listed tokens, in slot order. */
export function readTokenList(): ListedToken[] {
  const list: ListedToken[] = [];
  for (let n = 1; n <= TOKEN_LIST_SLOTS; n++) {
    const entry = tokenSlot(n);
    if (keychainHas(entry)) list.push(parseEntry(entry, keychainRead(entry)));
  }
  return list;
}

/** The token `label` names, or the first listed; undefined only for an empty list and no label. */
export function chooseToken(list: readonly ListedToken[], label?: string): ListedToken | undefined {
  if (label === undefined) return list[0];
  const found = list.find((t) => t.label === label);
  if (!found) throw new Error(`no token labelled ${label} is on the list; nothing was changed`);
  return found;
}

/**
 * The value of `CW_LEAD_TOKEN_ORG` for a listed token. Listed tokens are
 * shared between orgs, so a marker naming the org cannot say a token was
 * meant for it. This one binds the org, the label and the token, and
 * `entrypoint.sh` computes the same digest, so a machine starts its lead only
 * on the exact token a deploy or a move set for that org. A stale token set
 * over it, or the marker copied to another org, starts no lead.
 */
export function tokenMarker(project: string, label: string, token: string): string {
  const digest = createHash('sha256').update(`listed:${project}:${label}:${token}`).digest('hex');
  return `listed:${label}:${digest}`;
}

/** Store a new token in the first free slot. Returns the entry's name. */
export function addToken(label: string, token: string, added: string): string {
  if (!TOKEN_LABEL.test(label)) {
    throw new Error(
      'a label is 1-32 characters of a-z, 0-9 and -, starting with a letter or digit',
    );
  }
  if (!isSetupToken(token)) throw new Error('that is not a token claude setup-token prints');
  const list = readTokenList();
  if (list.some((t) => t.label === label)) throw new Error(`${label} is already on the list`);
  if (list.some((t) => t.token === token)) throw new Error('that token is already on the list');
  if (keychainHas(WALLED_LEAD_ENTRY) && keychainRead(WALLED_LEAD_ENTRY).trim() === token) {
    throw new Error(`that token is ${WALLED_LEAD_ENTRY}, which no org's lead may hold`);
  }
  for (let n = 1; n <= TOKEN_LIST_SLOTS; n++) {
    const entry = tokenSlot(n);
    if (keychainHas(entry)) continue;
    keychainCreate(entry, JSON.stringify({ label, token, added }));
    return entry;
  }
  throw new Error(`the list is full at ${TOKEN_LIST_SLOTS} tokens`);
}
