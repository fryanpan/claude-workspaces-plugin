/**
 * Who a comment's `to` may name, resolved against the roster.
 *
 * A comment's addressees decide who is notified and who must answer, so the
 * server writes them, never the body. Each entry is an id, an email, or a
 * name, and it resolves only to somebody on the doc's board: the owner, a
 * person who is a member of a board the doc is on, or an agent attached to
 * one. The name written is the roster's. Anything else, including an archived
 * row, refuses the whole request (`bad_addressee`) rather than dropping the
 * entry, because a comment silently missing one of its addressees reads as
 * delivered to somebody who never hears it.
 */
import type { Addressee } from '@claude-workspaces/core';
import type { Identities, IdentityRecord } from './identities.ts';

/** The most addressees one comment may name. */
export const MAX_ADDRESSEES = 10;

export interface AddresseeRoster {
  identities: Pick<Identities, 'get' | 'byEmail' | 'list' | 'resolveAgentId'>;
  /** The owner's identity id and the name they go by. */
  owner: () => { id: string; name: string };
  /** Whether this person may open this board (owner role or member). */
  isMember: (boardId: string, person: IdentityRecord) => boolean;
  /** The agent ids attached to this board, as the attachments spell them. */
  attachedAgents: (boardId: string) => string[];
}

export type AddresseeResult =
  | { ok: true; addressedTo?: Addressee[] }
  | { ok: false; error: 'bad_addressee'; message: string };

const refuse = (message: string): AddresseeResult => ({
  ok: false,
  error: 'bad_addressee',
  message,
});

export function resolveAddressees(
  raw: unknown,
  boards: readonly string[],
  roster: AddresseeRoster,
): AddresseeResult {
  if (raw === undefined || raw === null) return { ok: true };
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ADDRESSEES) {
    return refuse(`to must be a list of 1-${MAX_ADDRESSEES} ids or names`);
  }
  const owner = roster.owner();
  const memberHere = (rec: IdentityRecord) => boards.some((b) => roster.isMember(b, rec));
  const attached = new Set<string>();
  for (const b of boards) {
    for (const a of roster.attachedAgents(b))
      attached.add(roster.identities.resolveAgentId(a) ?? a);
  }
  const out: Addressee[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      return refuse('each entry in to is an id, an email or a name');
    }
    const found = resolveOne(entry.trim(), owner, memberHere, attached, roster.identities);
    if (!found) return refuse(`${JSON.stringify(entry)} is nobody on this board`);
    if (seen.has(found.id)) continue;
    seen.add(found.id);
    out.push(found);
  }
  return { ok: true, addressedTo: out };
}

function resolveOne(
  entry: string,
  owner: { id: string; name: string },
  memberHere: (rec: IdentityRecord) => boolean,
  attached: ReadonlySet<string>,
  identities: AddresseeRoster['identities'],
): Addressee | null {
  const lower = entry.toLowerCase();
  if (entry === owner.id || lower === owner.name.trim().toLowerCase()) {
    return { id: owner.id, kind: 'person', name: owner.name };
  }
  const person = (rec: IdentityRecord | null): Addressee | null =>
    rec && rec.kind === 'person' && rec.status === 'active' && memberHere(rec)
      ? { id: rec.id, kind: 'person', name: rec.displayName }
      : null;
  const direct = identities.get(entry);
  if (direct?.kind === 'person') return person(direct);
  if (entry.includes('@')) return person(identities.byEmail(entry));
  const agentId = identities.resolveAgentId(entry);
  if (agentId !== null) {
    const rec = identities.get(agentId);
    return rec && rec.status === 'active' && attached.has(agentId)
      ? { id: agentId, kind: 'agent', name: rec.displayName }
      : null;
  }
  // A display name: only a person on this board, and only when exactly one
  // goes by it, so a name two members share cannot pick one of them.
  const named = identities
    .list()
    .filter((r) => r.kind === 'person' && r.displayName.trim().toLowerCase() === lower);
  const here = named.map(person).filter((a): a is Addressee => a !== null);
  return here.length === 1 ? (here[0] ?? null) : null;
}
