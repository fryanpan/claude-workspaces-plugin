/**
 * Which blocks of a doc a person changed, and whether an agent's scoped edit
 * lands on one of them from a copy older than the change.
 *
 * `set_doc_content` has refused a stale whole-doc rewrite since 2026-08-26.
 * The scoped verbs — find_and_replace, rewrite_thread_region, the anchor and
 * block edits — skipped that check, and on 2026-10-14 an agent's scoped edit
 * flattened a table a person had just formatted, with no backup to restore
 * from. Refusing every scoped edit while a person is typing would end the
 * concurrent editing the product is built on, so the rule here is narrower:
 * an edit is refused only when a block it changes was changed by a person
 * after the agent's last read. Edits elsewhere in the doc land as before.
 *
 * Blocks are the prose fragment's top-level children, named by their Yjs item
 * id. That id is the same in every copy of the doc, which is what lets
 * `touchedByDryRun` run an edit on a copy and compare its answer against
 * stamps taken on the live doc.
 */
import * as Y from 'yjs';

/** How long after a human's live edit an UNTRACKED caller's write is judged
 *  stale (callers with a tracked read are judged by order, not the clock).
 *  See `DocStore.staleWriteCheck`. */
export const STALE_WRITE_WINDOW_MS = 10 * 60_000;

/** What a caller of a scoped edit tells the guard about itself. */
export interface ScopedEditGuard {
  /** The author id the caller's get_doc reads were recorded under. */
  reader?: string;
  /** The caller has re-read and means to write over the person's change. */
  confirm?: boolean;
}

/** The answer when the guard refuses. Shaped like set_doc_content's 409. */
export interface ScopedEditRefusal {
  ok: false;
  error: 'stale-write';
  humanEditedAt: number;
  lastReadAt?: number;
  message: string;
}

function itemKey(id: Y.ID): string {
  return `${id.client}:${id.clock}`;
}

/** The top-level blocks a set of fragment events touched, added and deleted
 *  ones included. */
export function touchedBlockKeys(
  fragment: Y.XmlFragment,
  events: ReadonlyArray<Y.YEvent<Y.AbstractType<unknown>>>,
): Set<string> {
  const keys = new Set<string>();
  for (const ev of events) {
    if (ev.target === fragment) {
      for (const item of ev.changes.added) keys.add(itemKey(item.id));
      for (const item of ev.changes.deleted) keys.add(itemKey(item.id));
      continue;
    }
    let t: Y.AbstractType<unknown> | null = ev.target;
    while (t && t.parent !== fragment) t = t.parent;
    if (t?._item) keys.add(itemKey(t._item.id));
  }
  return keys;
}

/**
 * Run `run` against a copy of `ydoc` and report the blocks it changed. The
 * live doc is never touched: the copy is built from its full state, so every
 * relative position and agent anchor resolves there as it would here.
 */
export function touchedByDryRun<R>(
  ydoc: Y.Doc,
  fragmentOf: (doc: Y.Doc) => Y.XmlFragment,
  run: (copy: Y.Doc) => R,
): { result: R; touched: Set<string> } {
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(ydoc));
    const fragment = fragmentOf(copy);
    const touched = new Set<string>();
    const observe = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>) => {
      for (const k of touchedBlockKeys(fragment, events)) touched.add(k);
    };
    fragment.observeDeep(observe);
    const result = run(copy);
    fragment.unobserveDeep(observe);
    return { result, touched };
  } finally {
    copy.destroy();
  }
}

/**
 * The newest person's edit among `touched` that the caller has not seen: newer
 * than its last read, or — with no read on record — inside the window.
 * `undefined` when the edit is safe.
 */
export function unseenHumanEdit(
  touched: ReadonlySet<string>,
  stamps: ReadonlyMap<string, number> | undefined,
  opts: { lastReadAt?: number; now: number },
): number | undefined {
  if (!stamps) return undefined;
  let newest: number | undefined;
  for (const key of touched) {
    const at = stamps.get(key);
    if (at === undefined) continue;
    const unseen =
      opts.lastReadAt !== undefined ? at >= opts.lastReadAt : opts.now - at < STALE_WRITE_WINDOW_MS;
    if (unseen && (newest === undefined || at > newest)) newest = at;
  }
  return newest;
}

export function scopedEditRefusal(humanEditedAt: number, lastReadAt?: number): ScopedEditRefusal {
  return {
    ok: false,
    error: 'stale-write',
    humanEditedAt,
    ...(lastReadAt !== undefined ? { lastReadAt } : {}),
    message:
      `REFUSED: a human edited the block this change touches at ${new Date(humanEditedAt).toISOString()}` +
      (lastReadAt !== undefined
        ? `, AFTER your last read at ${new Date(lastReadAt).toISOString()}`
        : ', within the last 10 minutes') +
      ' — your copy of it is older than theirs. Re-read the doc with get_doc, re-apply' +
      ' your change onto the CURRENT content, and only if you mean to replace what they' +
      ' wrote retry with confirmOverwriteHumanEdits: true.',
  };
}
