/**
 * The thread the doc on screen has open, for a reader outside the doc's own
 * mount: the lead chat, mounted once per page, names it in the link a message
 * carries (`lead-chat/lead-chat-link.ts`).
 *
 * Holds no thread state of its own. The doc's chrome registers a reader of its
 * thread panel's selection, the one authority for which thread is open, and
 * drops it when the doc unmounts.
 */
let reader: (() => string | null) | null = null;
const changes = new Set<() => void>();

/** Register the open doc's reader. Answers the function that drops it. */
export function setOpenThreadReader(read: () => string | null): () => void {
  reader = read;
  return () => {
    if (reader === read) reader = null;
  };
}

/** The open thread's id, or null when no doc is mounted or none is open. */
export function openThreadId(): string | null {
  return reader?.() ?? null;
}

/** The thread panel's selection moved. */
export function openThreadChanged(): void {
  for (const told of changes) told();
}

/** Tell `told` when another thread opens or the open one closes, which moves
 *  nothing on screen for a thread with no line. Answers the function that
 *  stops it. */
export function onOpenThreadChange(told: () => void): () => void {
  changes.add(told);
  return () => {
    changes.delete(told);
  };
}
