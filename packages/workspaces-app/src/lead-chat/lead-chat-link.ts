/**
 * The link a message to the lead carries: the page's own address, cut to the
 * most specific thing open on it. Every page already writes that into its
 * URL — the board's `syncBoardUrl` keeps `?item=` (the review item Home's
 * walkthrough is on), `?task=` and `?thread=` current, and a doc, mock or app
 * door is its own path — so the link is the address with every other param
 * dropped. A doc page passes the thread its panel has open, which its URL
 * does not follow.
 *
 * The server keeps a link only when it is a path on the same board with no
 * param but these four (`messageLink` in `packages/server/src/voice.ts`).
 */
import type { VoiceContext } from '../voice-capture.ts';

const KEPT = ['task', 'goal', 'thread', 'item'] as const;

/**
 * The page's link, or undefined off a board's pages. `openThread`: a string
 * names the open thread, null says none is open, undefined leaves the URL's
 * own `?thread=` as it is.
 */
export function messageLinkOf(
  pathname: string,
  search: string,
  openThread?: string | null,
): string | undefined {
  if (!pathname.startsWith('/workspaces/')) return undefined;
  const from = new URLSearchParams(search);
  const params = new URLSearchParams();
  for (const name of KEPT) {
    const v = from.get(name);
    if (v) params.set(name, v);
  }
  if (openThread === null) params.delete('thread');
  else if (openThread) params.set('thread', openThread);
  const q = params.toString();
  return `${pathname}${q ? `?${q}` : ''}`;
}

/** The page's context with its link added; the board surface when the page
 *  gave none. Undefined only off a board's pages with no context either. */
export function withMessageLink(
  context: VoiceContext | undefined,
  link: string | undefined,
): VoiceContext | undefined {
  if (!link) return context;
  return { ...(context ?? { surface: 'board' }), link };
}
