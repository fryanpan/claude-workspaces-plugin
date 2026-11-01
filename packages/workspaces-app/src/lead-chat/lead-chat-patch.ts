/**
 * Redraw the chat's list without replacing a row that did not change.
 *
 * The chat redraws often: on every word the listener hears while voice is
 * on, and on every frame about a message. Rebuilding the list each time
 * replaced every link in it, so a press that spanned a redraw lost its tap —
 * Chromium sends the click to what the press and the release share (the
 * list), and iOS Safari drops it (Bryan, 1 Nov: "Your links don't work in
 * chat in board"). So each row is drawn fresh, compared by its markup with
 * what that row drew last time, and the node already on screen stays when
 * the two match. A row whose node stays is never removed or moved.
 */

/** What one row drew last time: its fresh markup, and the node on screen. */
export interface DrawnRow {
  html: string;
  node: Element;
}

/**
 * Make `list` hold `fresh`, in order. A row whose key drew the same markup
 * last time keeps the node in `kept`, so whatever was done to it since — a
 * link title filled in, a press in progress — survives. `kept` is rewritten
 * to describe this draw.
 */
export function patchRows(
  list: Element,
  fresh: ReadonlyArray<readonly [key: string, node: Element]>,
  kept: Map<string, DrawnRow>,
): void {
  const next = new Map<string, DrawnRow>();
  const nodes: Element[] = [];
  for (const [key, node] of fresh) {
    const html = node.outerHTML;
    const prev = next.has(key) ? undefined : kept.get(key);
    const row = prev && prev.html === html && prev.node.parentNode === list ? prev : { html, node };
    if (!next.has(key)) next.set(key, row);
    nodes.push(row.node);
  }
  // Drop the rows that went first, so the ones that stay need no move.
  const want = new Set<Node>(nodes);
  for (const child of [...list.childNodes]) if (!want.has(child)) child.remove();
  let at: Node | null = list.firstChild;
  for (const node of nodes) {
    if (at === node) {
      at = at.nextSibling;
      continue;
    }
    list.insertBefore(node, at);
  }
  kept.clear();
  for (const [key, row] of next) kept.set(key, row);
}
