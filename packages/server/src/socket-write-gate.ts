/**
 * Which writes a doc or board socket may make, judged per frame (D1 step 8).
 *
 * Two refusals, both read off the update the frame carries before Yjs
 * applies it:
 *
 * - `role`: the socket's person holds `comment` or `view` on the board
 *   (`share/board-access.ts`), and the frame changes the doc.
 * - `threads`: the frame writes the `threads` map, on ANY socket. Comments
 *   are written by the thread routes, which stamp the author from the
 *   server's identity; no page writes that map over its socket (the board,
 *   the doc page and the widget only read it). Before this, any writable
 *   socket could plant a comment under any author name.
 *
 * And a third, `unresolved`: an update whose items this doc cannot place
 * under a root. A client only ever learns items from this server, so a
 * legitimate update always resolves; one that does not is refused rather
 * than guessed at.
 *
 * The board's roles mode decides what a refusal does. `enforce` drops the
 * frame. `report-only` — every board's default — applies it and logs the
 * refusal it would have made, once per socket per reason.
 */
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { type SocketAccess, mayEditDocs } from './share/board-access.ts';

export type WriteRefusal = 'role' | 'threads' | 'unresolved';

/** Root types only the server writes. */
const SERVER_WRITTEN_ROOTS: ReadonlySet<string> = new Set(['threads']);

/** The update a sync step 2 or update frame carries; null for step 1 and
 *  for a frame this cannot read (Yjs then refuses it on its own). */
export function updateOfSyncFrame(frame: Uint8Array): Uint8Array | null {
  try {
    const dec = decoding.createDecoder(frame);
    decoding.readVarUint(dec); // the MSG_SYNC kind
    const step = decoding.readVarUint(dec);
    if (step !== syncProtocol.messageYjsSyncStep2 && step !== syncProtocol.messageYjsUpdate) {
      return null;
    }
    return decoding.readVarUint8Array(dec);
  } catch {
    return null;
  }
}

type AnyType = Y.AbstractType<unknown>;

/** The root key a live type sits under, or null when it is not in this doc. */
function rootOfType(type: AnyType): string | null {
  let at = type;
  while (at._item !== null) {
    const parent = at._item.parent;
    if (!(parent instanceof Y.AbstractType)) return null;
    at = parent as AnyType;
  }
  try {
    return Y.findRootTypeKey(at);
  } catch {
    return null;
  }
}

/**
 * Every root an update writes or deletes under. `null` in the set means an
 * item could not be placed.
 */
export function rootsTouched(ydoc: Y.Doc, update: Uint8Array): Set<string | null> {
  const { structs, ds } = Y.decodeUpdate(update);
  const roots = new Set<string | null>();
  const byClient = new Map<number, Y.Item[]>();
  for (const s of structs) {
    if (!(s instanceof Y.Item)) continue;
    const list = byClient.get(s.id.client) ?? [];
    list.push(s);
    byClient.set(s.id.client, list);
  }
  const inUpdate = (client: number, clock: number): Y.Item | undefined =>
    byClient.get(client)?.find((i) => i.id.clock <= clock && clock < i.id.clock + i.length);
  const memo = new Map<Y.Item, string | null>();

  // The root of whatever item an id names: an item in this update, or one
  // already in the doc. A sibling (origin) and a nested type's holder (a
  // parent id) both sit under the same root as the item that names them.
  const rootOfId = (id: Y.ID, depth: number): string | null | 'gc' => {
    const local = inUpdate(id.client, id.clock);
    if (local) return rootOfDecoded(local, depth + 1);
    if (Y.getState(ydoc.store, id.client) <= id.clock) return null;
    const struct = Y.getItem(ydoc.store, id);
    if (!(struct instanceof Y.Item)) return 'gc';
    return struct.parent instanceof Y.AbstractType ? rootOfType(struct.parent as AnyType) : null;
  };
  const rootOfDecoded = (item: Y.Item, depth: number): string | null => {
    if (memo.has(item)) return memo.get(item) ?? null;
    if (depth > 5_000) return null;
    let root: string | null = null;
    const parent = item.parent as unknown;
    if (typeof parent === 'string') {
      root = parent;
    } else {
      const ref = (parent as Y.ID | null) ?? item.origin ?? item.rightOrigin;
      const found = ref ? rootOfId(ref, depth) : null;
      // An item next to collected garbage is collected too when Yjs applies
      // it, so it writes nothing.
      root = found === 'gc' ? '' : found;
    }
    memo.set(item, root);
    return root;
  };

  for (const list of byClient.values()) {
    for (const item of list) roots.add(rootOfDecoded(item, 0));
  }
  for (const [client, ranges] of ds.clients) {
    for (const { clock, len } of ranges) {
      const end = clock + len;
      for (const item of byClient.get(client) ?? []) {
        if (item.id.clock < end && clock < item.id.clock + item.length) {
          roots.add(rootOfDecoded(item, 0));
        }
      }
      if (Y.getState(ydoc.store, client) <= clock) {
        if (!inUpdate(client, clock)) roots.add(null);
        continue;
      }
      const held = ydoc.store.clients.get(client) ?? [];
      for (let i = Y.findIndexSS(held, clock); i < held.length; i++) {
        const struct = held[i];
        if (!struct || struct.id.clock >= end) break;
        if (struct instanceof Y.Item && struct.parent instanceof Y.AbstractType) {
          roots.add(rootOfType(struct.parent as AnyType));
        }
      }
    }
  }
  roots.delete('');
  return roots;
}

/** Whether an update changes anything at all. An empty step 2 is what every
 *  client sends when it has nothing new, and it is never a refusal. */
function writesNothing(update: Uint8Array): boolean {
  const { structs, ds } = Y.decodeUpdate(update);
  return structs.length === 0 && ds.clients.size === 0;
}

/** The refusal this frame earns, or null when it may be applied. */
export function judgeSocketWrite(
  ydoc: Y.Doc,
  access: SocketAccess | undefined,
  frame: Uint8Array,
): WriteRefusal | null {
  const update = updateOfSyncFrame(frame);
  if (update === null) return null;
  try {
    if (writesNothing(update)) return null;
    if (access && !mayEditDocs(access.role)) return 'role';
    const roots = rootsTouched(ydoc, update);
    if (roots.has(null)) return 'unresolved';
    for (const root of roots) if (root !== null && SERVER_WRITTEN_ROOTS.has(root)) return 'threads';
    return null;
  } catch {
    return 'unresolved';
  }
}

/** Sockets already logged for a reason, so a typing reader logs once. */
const logged = new WeakMap<object, Set<WriteRefusal>>();

/**
 * Judge a frame and act on the board's mode. True when the frame must be
 * dropped; false when it is applied (allowed, or refused in report-only).
 */
export function refuseSocketWrite(
  socket: object,
  docId: string,
  ydoc: Y.Doc,
  access: SocketAccess | undefined,
  frame: Uint8Array,
): boolean {
  const refusal = judgeSocketWrite(ydoc, access, frame);
  if (refusal === null) return false;
  const enforce = access?.mode() === 'enforce';
  const seen = logged.get(socket) ?? new Set<WriteRefusal>();
  if (!seen.has(refusal)) {
    seen.add(refusal);
    logged.set(socket, seen);
    console.warn(
      `[roles] ${enforce ? 'refused' : 'report-only, would refuse'} a ${refusal} write on ${docId}` +
        ` (board ${access?.workspaceId ?? 'unknown'}, role ${access?.role ?? 'unknown'})`,
    );
  }
  return enforce;
}
