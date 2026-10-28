import { contextMatches } from '@claude-workspaces/core/anchor/context';
import {
  WORDS_TAG,
  createAnchor,
  extractText,
  tokenOverlap,
} from '@claude-workspaces/core/anchor/element';
import type { ElementAnchor, ElementFingerprint } from '@claude-workspaces/core/types';
import type { ThreadRow } from './widget-threads.ts';
import type { FeedbackWidgetEl } from './widget.ts';

/**
 * Tell the server what a commented element says now, so a mock rewritten
 * round after round keeps its pins.
 *
 * An anchor holds the words its element had when the comment was made. An
 * agent revising a mock changes a few of them each round, and the resolver
 * finds an element only while it still says over half of what the anchor
 * holds, so after two or three rounds the thread loses its pin: on one data
 * mock, 19 of 29 open threads. Each render hands this every thread it pinned
 * (`listHook`), and for each element that now says something other than its
 * anchor does, the page sends the element's fresh description through the
 * thread's `reanchor` route with `refresh: true`. The server keeps the first
 * anchor beside it and moves only the description (`core/anchor/refresh.ts`).
 *
 * A pin is only reported where it cannot be a guess, because a wrong report
 * would move the thread for good:
 *
 * - the thread was made in exactly this state of the page, not another view
 *   of it;
 * - its element has words, and the anchor is not an agent's words anchor —
 *   a wordless element is found only by its exact path, and a words anchor
 *   has a resolver of its own;
 * - the element says over half of the anchor's words, and no other element of
 *   its tag says as many. Two elements equally close — two cells saying the
 *   same figure — is the case a report must never decide; such a thread is
 *   still pinned as before, and is just not reported.
 *
 * And not while the reader is on an earlier round of a mock
 * (`pauseAnchorRefresh`): that round's words are older than the anchor's.
 *
 * Each description is sent once per thread per page, so two pages showing
 * different rounds cannot trade reports back and forth.
 *
 * In `mic.js` and `mockup-live.js`, beside the page list that calls it, and
 * off the budgeted bundle.
 */

let paused = false;
const sent = new Set<string>();

/** Hold reports while the page shows a round older than the newest. */
export function pauseAnchorRefresh(p: boolean): void {
  paused = p;
}

/** What a report changes: the element's description without the box it drew. */
function described(fp: ElementFingerprint): string {
  return JSON.stringify([fp.id, fp.text, fp.path, fp.classes, fp.stableAttrs, fp.dataAttrs]);
}

/** Is `el` the one element of its tag that the anchor's words point to? */
function surely(fp: ElementFingerprint, el: HTMLElement): boolean {
  const own = tokenOverlap(fp.text, extractText(el));
  if (own <= 0.5) return false;
  for (const c of document.querySelectorAll<HTMLElement>(el.tagName)) {
    if (c !== el && tokenOverlap(fp.text, extractText(c)) >= own) return false;
  }
  return true;
}

export function refreshAnchors(el: FeedbackWidgetEl, rows: ThreadRow[]): void {
  if (paused || !el.opts?.serverUrl) return;
  for (const { thread: t, el: at } of rows) {
    const a = t.anchor;
    if (!at || a.kind !== 'element' || !a.fingerprint.text || a.fingerprint.tag === WORDS_TAG) {
      continue;
    }
    if (!contextMatches(a.context, el.currentContext ?? {})) continue;
    const seen: ElementAnchor = createAnchor(at);
    const now = described(seen.fingerprint);
    if (now === described(a.fingerprint)) continue;
    const key = `${t.id}\n${now}`;
    if (sent.has(key) || !surely(a.fingerprint, at)) continue;
    sent.add(key);
    // Spelled rather than taken from `widget-auth.ts`, as `mic-entry.ts`
    // spells the base: and a plain fetch, because a refused report must not
    // ask the reader to sign in for a write they never made.
    const base = el.opts.serverUrl.replace(/^ws/, 'http');
    const enc = encodeURIComponent;
    void fetch(
      `${base}/workspaces/${enc(el.opts.workspaceId)}/docs/${enc(el.opts.docId)}/threads/${enc(t.id)}/reanchor`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(el.authToken ? { authorization: `Bearer ${el.authToken}` } : {}),
        },
        body: JSON.stringify({ anchor: seen, refresh: true }),
      },
    ).catch(() => {
      /* a report that does not land leaves the anchor as it was */
    });
  }
}
