/**
 * The one splice that turns one text into another. Shared by the page's
 * `<textarea>` binding and the server's file merge and agent edits, so it
 * imports nothing: a Worker that uses `./markdown-file` or `./agent` pulls
 * in no DOM code through it.
 */

/** The one splice that turns `from` into `to`: the common prefix and
 *  suffix stay, the middle is replaced. */
export function splice(
  from: string,
  to: string,
): { index: number; remove: number; insert: string } {
  let start = 0;
  const max = Math.min(from.length, to.length);
  while (start < max && from[start] === to[start]) start++;
  let end = 0;
  while (end < max - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end++;
  return {
    index: start,
    remove: from.length - start - end,
    insert: to.slice(start, to.length - end),
  };
}
