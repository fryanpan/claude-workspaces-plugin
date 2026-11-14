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
 * The same rewrite drops any entry for a client id the socket may not carry
 * (the server's own slot, or one another socket holds), and strips the
 * fields only the server writes (`agentSpots`, `personDirective`, the
 * whiteboard's agent pointers, a doc's agent focus) from every state it
 * keeps: a page that wrote them could move where agents are drawn pointing
 * and which tab an agent's `show` moves.
 */
import { type User, guestNameFor } from '@claude-workspaces/core';
import { AGENT_FOCUS_FIELD } from '@claude-workspaces/core/spoken-reply';
import { AGENT_POINTERS_FIELD } from '@claude-workspaces/core/whiteboard-scene';
import { AGENT_SPOTS_FIELD, DIRECTIVE_FIELD } from '@claude-workspaces/core/workspace-presence';
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
   *  owner name given to an unproven loopback socket. */
  verified: boolean;
}

/**
 * The rule for a guest: a socket that proved nobody and is not the owner.
 * The id comes from the page's own stable browser id hashed with `scope`, the
 * namespace `sanitizeVisitorAuthor` gives a share visitor's comments. So a
 * guest keeps one id across tabs and reloads, the id matches the one their
 * comments carry, it never names a member, and the raw browser id is never
 * broadcast. The guest keeps the display name they typed unless it is
 * reserved or a roster member's.
 */
export interface GuestStamp {
  kind: 'guest';
  verified: false;
  /** The share the visitor came through, or `local` for any other guest. */
  scope: string;
  /** True for a display name a guest may not show: a roster member's. */
  reservedName?: (name: string) => boolean;
}

/** What an upgrade stamps on a socket: a fixed name, or the guest rule. */
export type PresenceStamp = PresenceUser | GuestStamp;

/** The scope of a guest who did not come through a share. */
export const LOCAL_GUEST_SCOPE = 'local';

/** Fields only the server's own awareness slot carries. Every page state is
 *  stripped of them, so no page can move where agents are drawn pointing or
 *  focused, or which tab an agent's `show` moves. */
const SERVER_ONLY_FIELDS = [
  AGENT_SPOTS_FIELD,
  DIRECTIVE_FIELD,
  AGENT_POINTERS_FIELD,
  AGENT_FOCUS_FIELD,
] as const;

/** What an upgrade knows about the socket it is opening. */
export interface PresenceProof {
  /** The identity the request proved, or null. Never a body's claim. */
  proven: User | null;
  /** Whether a proven id is an agent's roster row. */
  isAgent: (id: string) => boolean;
  /** The share key of a share visitor (as its comments use it), or null. */
  shareKey: string | null;
  /** The socket may read and may not write: the sign-in gate refused it. */
  readOnly: boolean;
  /** The socket came through the tunnel or from a peer that is not loopback. */
  offBox: boolean;
  /** The deployment owner, for a writable loopback socket that proved nobody. */
  owner: () => { id: string; name: string };
  /** A display name a guest may not show (a roster member's). */
  reservedName?: (name: string) => boolean;
}

/** The roster reads `presenceUserFor` needs, as the server wires them. */
export interface PresenceRoster {
  owner: () => { id: string; name: string };
  isAgent: (id: string) => boolean;
  /** A display name a guest may not show: a roster member's. */
  reservedName?: (name: string) => boolean;
}

/**
 * The stamp for a socket, in this order:
 *  1. the identity the request proved (an agent token, Access, a session or
 *     a widget token, as `provenAuthor` ranks them);
 *  2. a share visitor with no proof: a guest scoped by the share;
 *  3. a read-only socket, or one from off this machine (tunnel, tailnet,
 *     LAN), that proved nobody: a guest scoped `local`;
 *  4. a writable loopback socket that proved nobody: the owner, unverified.
 *     That is the single-person local setup, where agent follow must keep
 *     working without a sign-in.
 */
export function presenceUserFor(p: PresenceProof): PresenceStamp {
  if (p.proven) {
    return {
      id: p.proven.id,
      name: p.proven.name,
      color: validColor(p.proven.color) ?? colorFor(p.proven.id),
      kind: p.isAgent(p.proven.id) ? 'agent' : 'person',
      verified: true,
    };
  }
  const guest = (scope: string): GuestStamp => ({
    kind: 'guest',
    verified: false,
    scope,
    ...(p.reservedName ? { reservedName: p.reservedName } : {}),
  });
  if (p.shareKey !== null) return guest(p.shareKey);
  if (p.readOnly || p.offBox) return guest(LOCAL_GUEST_SCOPE);
  const owner = p.owner();
  return {
    id: owner.id,
    name: owner.name,
    color: colorFor(owner.id),
    kind: 'person',
    verified: false,
  };
}

/** A stamp that is the guest rule rather than a fixed name. */
export function isGuestStamp(stamp: PresenceStamp): stamp is GuestStamp {
  return 'scope' in stamp;
}

/** The name a stamp puts on one state, given the `user` the page announced. */
export function resolveStamp(stamp: PresenceStamp, claimed: unknown): PresenceUser {
  const claimedColor = validColor((claimed as { color?: unknown } | null)?.color);
  if (!isGuestStamp(stamp)) {
    // A page keeps the colour it picked: it names nobody.
    return { ...stamp, color: claimedColor ?? stamp.color };
  }
  const guest = sanitizeVisitorAuthor(claimed, { shareKey: stamp.scope });
  const name = stamp.reservedName?.(guest.name) ? guestNameFor(guest.id) : guest.name;
  return { id: guest.id, name, color: guest.color, kind: 'guest', verified: false };
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
  /** The rule written over `user` in every non-null state. */
  stamp: PresenceStamp;
  /**
   * Whether the socket may carry this client id, given the name its entry
   * would be stamped with (null for a removal). False for the server's own
   * slot and for a client id another socket holds (`yjs-protocol.ts`).
   */
  mayCarry: (clientId: number, user: PresenceUser | null) => boolean;
  /** The clock a kept entry is applied at. The server may have bumped a
   *  socket's state itself (a rename), so a page's next clock can be one it
   *  has already passed. Absent: the page's own clock. */
  clockFor?: (clientId: number, clock: number) => number;
}

/**
 * Rewrite one y-protocols awareness update: drop every entry the socket may
 * not carry, strip the server-only fields from each remaining state, and
 * replace `user` with the stamp. Returns null when no entry is left, or when
 * the update is malformed.
 *
 * Wire format (`y-protocols/awareness` `encodeAwarenessUpdate`): a count,
 * then for each entry its client id, its clock and its state as JSON.
 */
export function stampAwarenessUpdate(update: Uint8Array, opts: StampOptions): Uint8Array | null {
  const kept: AwarenessEntry[] = [];
  try {
    const dec = decoding.createDecoder(update);
    const count = decoding.readVarUint(dec);
    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(dec);
      const clock = decoding.readVarUint(dec);
      const raw = decoding.readVarString(dec);
      const state: unknown = JSON.parse(raw);
      if (state === null) {
        if (opts.mayCarry(clientId, null)) {
          kept.push({ clientId, clock: opts.clockFor?.(clientId, clock) ?? clock, json: raw });
        }
        continue;
      }
      if (typeof state !== 'object' || Array.isArray(state)) continue;
      const own = { ...(state as Record<string, unknown>) };
      for (const field of SERVER_ONLY_FIELDS) delete own[field];
      const user = resolveStamp(opts.stamp, own.user);
      if (!opts.mayCarry(clientId, user)) continue;
      kept.push({
        clientId,
        clock: opts.clockFor?.(clientId, clock) ?? clock,
        json: JSON.stringify({ ...own, user: stampedUserField(user) }),
      });
    }
  } catch {
    return null;
  }
  if (kept.length === 0) return null;
  return encodeAwarenessEntries(kept);
}

/** One entry of a y-protocols awareness update. */
export interface AwarenessEntry {
  clientId: number;
  clock: number;
  json: string;
}

/** Encode entries in the y-protocols awareness wire format. */
export function encodeAwarenessEntries(entries: AwarenessEntry[]): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, entries.length);
  for (const e of entries) {
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
