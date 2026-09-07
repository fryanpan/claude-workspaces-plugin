/**
 * Do this review item's links go anywhere?
 *
 * A card is written to be answered from the card alone, so a link on it is
 * load-bearing: the reader taps it, gets a 404 or a board they do not
 * recognise, and the item is unanswerable. Measured on the live board, 3 of
 * 46 distinct relative links in filed items resolved to nothing — two used
 * the `/mockup/<id>` route that the addressability cutover retired, one named
 * a document that had gone — and 9 more were bare URLs, several carrying a
 * trailing comma or backtick that an autolinker swallows into the address.
 *
 * This check is deterministic and runs BEFORE the judge, for the reason the
 * word ceiling does not: whether a link resolves is a fact, not a judgement,
 * and a fact is cheaper and more reliable to establish here than to describe
 * to a model. The judge's criteria already ask for links "inline on the words
 * they explain, never bare URLs" — this is what makes that clause enforceable
 * rather than aspirational.
 *
 * It says nothing about EXTERNAL links. A GitHub pull request or a vendor's
 * console is not this server's to resolve, and pretending to check one would
 * be a check that passes on everything.
 */

/** Whether the ids a relative link names actually exist. */
export interface LinkTargets {
  boardExists: (workspaceId: string) => boolean;
  taskExists: (taskId: string) => boolean;
  docExists: (docId: string) => boolean;
}

/**
 * Route prefixes that no longer serve anything, with what replaced them.
 *
 * Both were the way to address a doc before the cutover moved every resource
 * under `/workspaces/<id>/`. A link written to either returns a bare 404 —
 * they are named here rather than left to `docExists` because the id in them
 * is usually still perfectly good, so the target check would pass and the
 * link would still be dead.
 */
const RETIRED: ReadonlyArray<{ prefix: string; instead: string }> = [
  { prefix: '/mockup/', instead: '/workspaces/<board>/mockups/<id>' },
  { prefix: '/review/', instead: '/workspaces/<board>/docs/<id>' },
];

/** One fault found in an item's links. `link` is quoted back verbatim. */
export interface LinkFault {
  link: string;
  why: string;
}

/** Markdown inline links: `[text](target)`. Reference links are not used in
 *  review items and are deliberately not matched. */
const MD_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;

/**
 * A bare URL — one not already inside a markdown link's parentheses.
 *
 * The lookbehind is the whole trick: `](` is what precedes an address that
 * IS inline, so requiring the character before `http` not to be `(` finds the
 * ones that are not. Trailing punctuation is captured on purpose, because a
 * trailing comma or backtick is exactly the fault being reported.
 */
const BARE_URL = /(?<!\()https?:\/\/\S+/g;

function faultInRelative(target: string, ids: LinkTargets): string | undefined {
  for (const { prefix, instead } of RETIRED) {
    if (target.startsWith(prefix)) return `that route was retired — use ${instead}`;
  }
  const ws = /^\/workspaces\/([^/?#]+)/.exec(target);
  if (!ws) return undefined;
  const board = ws[1] ?? '';
  if (!ids.boardExists(board)) return 'no board has that id';
  const task = /[?&]task=([^&#]+)/.exec(target);
  if (task && !ids.taskExists(task[1] ?? '')) return 'no task on that board has that id';
  const doc = /^\/workspaces\/[^/]+\/(?:docs|mockups)\/([^/?#]+)/.exec(target);
  if (doc && !ids.docExists(doc[1] ?? '')) return 'no document has that id';
  return undefined;
}

/**
 * Every fault in one item's links, in the order they appear.
 *
 * Empty for an item whose links all resolve — and for one with no links at
 * all, which is not a fault: most items need none.
 */
export function linkFaults(detail: string | undefined, ids: LinkTargets): LinkFault[] {
  const text = detail ?? '';
  const faults: LinkFault[] = [];
  for (const m of text.matchAll(MD_LINK)) {
    const target = m[1] ?? '';
    if (!target.startsWith('/')) continue;
    const why = faultInRelative(target, ids);
    if (why !== undefined) faults.push({ link: target, why });
  }
  for (const m of text.matchAll(BARE_URL)) {
    faults.push({
      link: m[0],
      why: 'a bare URL — put the link on the words it explains, or a trailing character lands inside the address',
    });
  }
  return faults;
}

/**
 * The hold reason for an item whose links do not resolve, or undefined when
 * they all do.
 *
 * ONE fault is named, not the list. The gate holds an item at most twice, and
 * every other hold this system issues names the single biggest gap so the fix
 * is one edit; a bulleted list of link faults would be the only place it
 * behaved differently.
 */
export function linkHoldReason(detail: string | undefined, ids: LinkTargets): string | undefined {
  const first = linkFaults(detail, ids)[0];
  if (!first) return undefined;
  return `The link ${first.link} goes nowhere: ${first.why}`;
}
