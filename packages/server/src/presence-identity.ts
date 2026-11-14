/**
 * Who a presence socket is, decided by the server, and the rewrite that puts
 * that name on everything the socket announces.
 *
 * A page announces `user` in its awareness state. That field used to reach
 * every other page and agent exactly as the page wrote it, so any page could
 * appear as anyone. Now the upgrade works out who opened the socket
 * (`presenceUserFor`) and `yjs-protocol.ts` runs every awareness frame the
 * socket sends through `stampAwarenessUpdate`, which replaces `user` with that
 * name. The page's own copy still says what the page set; every other reader
 * hears the server's.
 *
 * The same rewrite drops any entry for a client id the socket does not own:
 * one another socket introduced, or the server's own slot. The server's slot
 * carries `agentSpots` and `personDirective`, so a page that wrote it could
 * move where agents are drawn pointing and which tab an agent's `show` moves.
 */
import type { User } from '@claude-workspaces/core';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { sanitizeVisitorAuthor } from './share/visitor-identity.ts';

/** The name the server puts on a socket's presence. */
export interface PresenceUser {
  id: string;
  name: string;
  color: string;
  /** `agent` when the proven id is a roster agent (a board-token socket). */
  kind: 'person' | 'agent' | 'guest';
  /** True when a proof named this identity. False for a guest, and for the
   *  owner name given to an unproven socket on a single-person deployment. */
  verified: boolean;
}

/** What an upgrade knows about the socket it is opening. */
export interface PresenceProof {
  /** The identity the request proved, or null. Never a body's claim. */
  proven: User | null;
  /** Whether a proven id is an agent's roster row. */
  isAgent: (id: string) => boolean;
  /** The share or membership key of a share visitor, or null. */
  shareKey: string | null;
  /** The socket may read and may not write: the sign-in gate refused it. */
  readOnly: boolean;
  /** The deployment owner, for a writable socket that proved nobody. */
  owner: () => { id: string; name: string };
  /** A per-socket id the server holds (`newSocketSeed`); seeds a guest. */
  socketSeed: string;
}

/** A fresh per-socket seed. Server-held: no page chooses it. */
export function newSocketSeed(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * A guest's presence. A share visitor's id is seeded by the share, the same
 * namespace `sanitizeVisitorAuthor` gives their comments; any other guest is
 * `Guest` and four characters of the seed.
 */
export function guestPresenceUser(seed: string, shareKey: string | null): PresenceUser {
  if (shareKey !== null) {
    const guest = sanitizeVisitorAuthor({ id: seed }, { shareKey });
    return { id: guest.id, name: guest.name, color: guest.color, kind: 'guest', verified: false };
  }
  const short = seed.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'anon';
  const id = `guest-${short}`;
  return {
    id,
    name: `Guest ${short.slice(0, 4)}`,
    color: colorFor(id),
    kind: 'guest',
    verified: false,
  };
}

/**
 * The name a socket shows, in this order:
 *  1. the identity the request proved (an agent token, Access, a session or
 *     a widget token, as `provenAuthor` ranks them);
 *  2. a share visitor with no proof: a `guest-` id seeded by the share;
 *  3. a read-only socket that proved nobody: `Guest` and four characters;
 *  4. a writable socket that proved nobody: the owner, unverified. Such a
 *     socket exists only where writes need no sign-in, which is a
 *     single-person deployment.
 */
export function presenceUserFor(p: PresenceProof): PresenceUser {
  if (p.proven) {
    return {
      id: p.proven.id,
      name: p.proven.name,
      color: validColor(p.proven.color) ?? colorFor(p.proven.id),
      kind: p.isAgent(p.proven.id) ? 'agent' : 'person',
      verified: true,
    };
  }
  if (p.shareKey !== null || p.readOnly) return guestPresenceUser(p.socketSeed, p.shareKey);
  const owner = p.owner();
  return {
    id: owner.id,
    name: owner.name,
    color: colorFor(owner.id),
    kind: 'person',
    verified: false,
  };
}

/** The `user` field the server writes into a stamped state. */
export function stampedUserField(stamp: PresenceUser): Record<string, unknown> {
  return {
    id: stamp.id,
    name: stamp.name,
    color: stamp.color,
    kind: stamp.kind,
    verified: stamp.verified,
  };
}

export interface StampOptions {
  /** The name written over `user` in every non-null state. */
  stamp: PresenceUser;
  /** Whether a client id belongs to another socket or to the server. */
  isForeign: (clientId: number) => boolean;
}

/**
 * Rewrite one y-protocols awareness update: drop every entry the socket may
 * not carry, and replace `user` in each remaining non-null state with the
 * stamp. Returns null when no entry is left, or when the update is malformed.
 *
 * Wire format (`y-protocols/awareness` `encodeAwarenessUpdate`): a count,
 * then for each entry its client id, its clock and its state as JSON.
 */
export function stampAwarenessUpdate(update: Uint8Array, opts: StampOptions): Uint8Array | null {
  const kept: Array<{ clientId: number; clock: number; json: string }> = [];
  try {
    const dec = decoding.createDecoder(update);
    const count = decoding.readVarUint(dec);
    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(dec);
      const clock = decoding.readVarUint(dec);
      const raw = decoding.readVarString(dec);
      if (opts.isForeign(clientId)) continue;
      const state: unknown = JSON.parse(raw);
      if (state === null) {
        kept.push({ clientId, clock, json: raw });
        continue;
      }
      if (typeof state !== 'object' || Array.isArray(state)) continue;
      const user = (state as { user?: { color?: unknown } }).user;
      const stamp = {
        ...opts.stamp,
        // A page keeps the colour it picked: it names nobody.
        color: validColor(user?.color) ?? opts.stamp.color,
      };
      kept.push({
        clientId,
        clock,
        json: JSON.stringify({ ...(state as object), user: stampedUserField(stamp) }),
      });
    }
  } catch {
    return null;
  }
  if (kept.length === 0) return null;
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, kept.length);
  for (const e of kept) {
    encoding.writeVarUint(enc, e.clientId);
    encoding.writeVarUint(enc, e.clock);
    encoding.writeVarString(enc, e.json);
  }
  return encoding.toUint8Array(enc);
}

function validColor(c: unknown): string | null {
  return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : null;
}

function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `#${(0x404040 + (h % 0x7f7f7f)).toString(16).padStart(6, '0')}`;
}
