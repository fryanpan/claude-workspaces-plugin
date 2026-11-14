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
 * item or a deleted range could not be placed.
 *
 * Linear in the update's size: each client's items are sorted once and found
 * by binary search, and roots are resolved without recursion, so neither a
 * long chain of unmerged items nor a crafted frame can make the walk give up
 * on a real edit or hold the event loop.
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
  for (const list of byClient.values()) list.sort((a, b) => a.id.clock - b.id.clock);
  /** Index of the first item of `client` that ends after `clock`. */
  const firstEndingAfter = (list: Y.Item[], clock: number): number => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const it = list[mid] as Y.Item;
      if (it.id.clock + it.length <= clock) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const inUpdate = (client: number, clock: number): Y.Item | undefined => {
    const list = byClient.get(client);
    if (!list) return undefined;
    const it = list[firstEndingAfter(list, clock)];
    return it && it.id.clock <= clock ? it : undefined;
  };

  // `''` marks an item that Yjs collects on apply (it sits next to garbage),
  // so it writes nothing; it is removed from the answer at the end.
  const memo = new Map<Y.Item, string | null>();
  /** The id an item is placed by: its parent's holder, else a neighbour. */
  const refOf = (item: Y.Item): Y.ID | null => {
    const parent = item.parent as unknown;
    if (typeof parent === 'string') return null;
    return (parent as Y.ID | null) ?? item.origin ?? item.rightOrigin;
  };
  /** The root of an item already in the doc, or of garbage (`''`). */
  const rootOfStored = (id: Y.ID): string | null => {
    if (Y.getState(ydoc.store, id.client) <= id.clock) return null;
    const struct = Y.getItem(ydoc.store, id);
    if (!(struct instanceof Y.Item)) return '';
    return struct.parent instanceof Y.AbstractType ? rootOfType(struct.parent as AnyType) : null;
  };
  // Iterative: follow refs through this update's items until one is placed
  // (a string parent, a stored item, or a memoized item), then write that
  // root back along the chain. A ref back into the chain is a cycle: null.
  const rootOfDecoded = (first: Y.Item): string | null => {
    const chain: Y.Item[] = [];
    const onChain = new Set<Y.Item>();
    let at: Y.Item | undefined = first;
    let root: string | null = null;
    while (at) {
      const known = memo.get(at);
      if (known !== undefined || memo.has(at)) {
        root = known ?? null;
        break;
      }
      if (onChain.has(at)) {
        root = null;
        break;
      }
      chain.push(at);
      onChain.add(at);
      const parent = at.parent as unknown;
      if (typeof parent === 'string') {
        root = parent;
        break;
      }
      const ref = refOf(at);
      if (!ref) {
        root = null;
        break;
      }
      const local = inUpdate(ref.client, ref.clock);
      if (!local) {
        root = rootOfStored(ref);
        break;
      }
      at = local;
    }
    for (const item of chain) memo.set(item, root);
    return root;
  };

  for (const list of byClient.values()) {
    for (const item of list) roots.add(rootOfDecoded(item));
  }
  for (const [client, ranges] of ds.clients) {
    const list = byClient.get(client) ?? [];
    const state = Y.getState(ydoc.store, client);
    for (const { clock, len } of ranges) {
      const end = clock + len;
      // This update's own items in the range.
      for (let i = firstEndingAfter(list, clock); i < list.length; i++) {
        const item = list[i] as Y.Item;
        if (item.id.clock >= end) break;
        roots.add(rootOfDecoded(item));
      }
      // Past what the doc holds, every clock must be an item this update
      // carries. Yjs keeps an uncovered remainder pending and applies it to
      // whatever arrives at those clocks later — a comment the server writes
      // included — so an uncovered range is never judged by its known part.
      let covered = Math.max(clock, state);
      for (let i = firstEndingAfter(list, covered); i < list.length && covered < end; i++) {
        const item = list[i] as Y.Item;
        if (item.id.clock > covered) break;
        covered = item.id.clock + item.length;
      }
      if (covered < end) roots.add(null);
      if (clock >= state) continue;
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
