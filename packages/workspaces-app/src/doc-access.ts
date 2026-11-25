/**
 * What this reader may do to an open doc, as the doc's own socket says, and
 * the edits the server refused because of it.
 *
 * The server tells every doc socket its person's access level at connect
 * (`MSG_ACCESS`, `server/src/yjs-protocol.ts`): `owner`, `edit`, `comment` or
 * `view`, and whether the board enforces it. A `comment` or `view` socket's
 * edit is dropped by the server (`socket-write-gate.ts`), so an editor that
 * keeps taking typing shows words that reached nobody. The surfaces read
 * `typingAllowed` from here and lock themselves.
 *
 * The frame is read off the socket with a listener of its own, not inside
 * core's `ws-client.ts`: the widget bundles that file and sits within bytes of
 * its size budget, and nothing in the widget needs the role.
 *
 * A role changes by the server hanging the socket up (`workspace-members.ts`),
 * so a reconnect brings the new level in a new frame, and the surfaces follow
 * it without a reload.
 *
 * REFUSED EDITS. Local edits the server dropped stay in this page's Y.Doc,
 * and a Y.Doc cannot forget a struct. The next socket's sync step 2 would
 * carry them up again, and once the role is raised they would land: words the
 * reader typed while they could not edit, published later without asking. So
 * when a frame shows the page holds edits the server did not take, the tracker
 * calls `onRefused`, and the caller throws the doc away and mounts a fresh one
 * from the server (`doc-cache-boot.ts`).
 */
import type { FeedbackClient } from '@claude-workspaces/core';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';

/** Server → client: this socket's access level. Contract with the server's
 *  `yjs-protocol.ts`. */
export const MSG_ACCESS = 4;
const MSG_SYNC = 0;
const SYNC_STEP_1 = 0;

export type DocRole = 'owner' | 'edit' | 'comment' | 'view';

export interface DocAccess {
  role: DocRole;
  /** `report-only` boards apply a narrow role's edits and only log them. */
  mode: 'enforce' | 'report-only';
}

/** The access frame's body, or null for any other frame. */
export function accessOfFrame(frame: Uint8Array): DocAccess | null {
  try {
    const dec = decoding.createDecoder(frame);
    if (decoding.readVarUint(dec) !== MSG_ACCESS) return null;
    const body = JSON.parse(decoding.readVarString(dec)) as Partial<DocAccess>;
    const role = body.role;
    if (role !== 'owner' && role !== 'edit' && role !== 'comment' && role !== 'view') return null;
    return { role, mode: body.mode === 'report-only' ? 'report-only' : 'enforce' };
  } catch {
    return null;
  }
}

/** Whether the server keeps this reader's typing. Unknown reads as yes: the
 *  page booted before any socket answered, and `canWrite` already said. */
export function typingAllowed(access: DocAccess | null): boolean {
  if (!access || access.mode === 'report-only') return true;
  return access.role === 'owner' || access.role === 'edit';
}

/** The label a locked surface shows where the save state would be. */
export function roleLabel(access: DocAccess | null): string | null {
  if (typingAllowed(access)) return null;
  return access?.role === 'comment' ? 'Comment only' : 'View only';
}

export interface DocAccessTracker {
  /** The level the latest socket was told, or null before any. */
  current(): DocAccess | null;
  /** Called on every frame from now on. Returns the unsubscribe. */
  onChange(cb: (access: DocAccess) => void): () => void;
}

const trackers = new WeakMap<Y.Doc, DocAccessTracker>();

/** The tracker for a doc's live client, when its socket has one. */
export function docAccessOf(ydoc: Y.Doc): DocAccessTracker | undefined {
  return trackers.get(ydoc);
}

/** True when `local` holds a struct `serverVector` does not cover. */
function aheadOf(local: Y.Doc, serverVector: Uint8Array): boolean {
  const server = Y.decodeStateVector(serverVector);
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(local))) {
    if ((server.get(client) ?? 0) < clock) return true;
  }
  return false;
}

/**
 * Follow `client`'s access frames for as long as it lives. `onRefused` is
 * called at most once, when a frame shows this page holds edits the server
 * did not take; it must throw the doc away.
 */
export function trackDocAccess(client: FeedbackClient, onRefused: () => void): DocAccessTracker {
  const { ydoc } = client;
  const listeners = new Set<(access: DocAccess) => void>();
  let current: DocAccess | null = null;
  /** Whether the socket now open has been told its level. */
  let told = false;
  let open = false;
  /** A local edit made while nothing said the server would keep it. */
  let unconfirmed = false;
  let serverVector: Uint8Array | null = null;
  let refused = false;

  ydoc.on('update', (_u: Uint8Array, _o: unknown, _d: Y.Doc, tr: Y.Transaction) => {
    if (tr.local && !(open && told && typingAllowed(current))) unconfirmed = true;
  });

  const onFrame = (frame: Uint8Array): void => {
    const sv = stepOneVector(frame);
    if (sv) {
      serverVector = sv;
      return;
    }
    const access = accessOfFrame(frame);
    if (!access) return;
    const wasLocked = current !== null && !typingAllowed(current);
    const locked = !typingAllowed(access);
    const held = unconfirmed || (serverVector !== null && locked && aheadOf(ydoc, serverVector));
    current = access;
    told = true;
    unconfirmed = false;
    if (held && (locked || wasLocked) && !refused) {
      refused = true;
      onRefused();
    }
    // Told even after `onRefused`: a caller that declined to remount still
    // has a surface that must lock, and a disposed one ignores this.
    for (const cb of [...listeners]) cb(access);
  };

  client.onStatus((s) => {
    open = s === 'open';
    if (!open) {
      told = false;
      serverVector = null;
      return;
    }
    client.ws.addEventListener('message', (ev) => {
      if (ev.data instanceof ArrayBuffer) onFrame(new Uint8Array(ev.data));
    });
  });

  const tracker: DocAccessTracker = {
    current: () => current,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  trackers.set(ydoc, tracker);
  return tracker;
}

/** The server's state vector when `frame` opens a sync, else null. */
function stepOneVector(frame: Uint8Array): Uint8Array | null {
  try {
    const dec = decoding.createDecoder(frame);
    if (decoding.readVarUint(dec) !== MSG_SYNC) return null;
    if (decoding.readVarUint(dec) !== SYNC_STEP_1) return null;
    return decoding.readVarUint8Array(dec);
  } catch {
    return null;
  }
}
