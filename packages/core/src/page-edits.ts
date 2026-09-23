import type { ElementAnchor } from './types.ts';

/**
 * A change a person made to the words on a page, sent to the agent that
 * builds the page rather than written into it.
 *
 * The widget's edit mode lets a reviewer retype text on a mock or on a dev
 * server in place. It never writes the page's source: the page may be a
 * generator's output, or a dev server this server cannot read at all. What it
 * records is the element, the words it showed and the words the reviewer
 * wants, and it posts them on the page's thread as the first comment's
 * `pageEdits`. The agent applies each one to its own source and resolves the
 * thread; an open thread is an edit still waiting, a resolved one an edit
 * applied.
 *
 * Text only. An edit carries no markup, no style and no image.
 */
export interface PageEdit {
  /** The element, fingerprinted the way a comment pin is, so the page can
   *  find it again after a reload and mark it. */
  anchor: ElementAnchor;
  /** A short CSS path, readable by the agent looking for the node in its own
   *  template: the last few steps, without structural wrappers. */
  selector: string;
  /** The element's words as the page showed them. */
  before: string;
  /** The words the reviewer typed. Empty means the words were deleted. */
  after: string;
}

/** The most edits one send may carry. */
export const MAX_PAGE_EDITS = 50;
/** The most characters `before` or `after` may hold. Longer is refused, not
 *  cut: half an edit applied is a wrong edit. */
export const MAX_PAGE_EDIT_TEXT = 4000;
/** The longest `selector`. */
export const MAX_PAGE_EDIT_SELECTOR = 300;
/** Characters of each side quoted in the comment's words. The whole text is
 *  on the edit itself. */
const QUOTED = 120;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Every field the page's resolver reads to find the element again. A
 *  fingerprint missing one would reach `resolve` on the reviewer's page. */
function isElementAnchor(v: unknown): v is ElementAnchor {
  if (!isRecord(v) || v.kind !== 'element') return false;
  const fp = v.fingerprint;
  return (
    isRecord(fp) &&
    typeof fp.tag === 'string' &&
    typeof fp.text === 'string' &&
    typeof fp.path === 'string' &&
    Array.isArray(fp.classes) &&
    isRecord(fp.stableAttrs) &&
    isRecord(fp.dataAttrs) &&
    isRecord(v.snippet) &&
    typeof v.snippet.text === 'string'
  );
}

const okText = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_PAGE_EDIT_TEXT;

/**
 * The edits on a stored or posted comment, or nothing.
 *
 * Read as defensively as the other notes a comment carries: this value is
 * written by whatever peer posted it, so a malformed entry is dropped rather
 * than reaching a renderer or an agent, and an empty list reads as absent so
 * an ordinary comment keeps exactly the shape it always had. The server
 * additionally validates each anchor before it stores one.
 */
export function readPageEdits(raw: unknown): PageEdit[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PageEdit[] = [];
  for (const e of raw) {
    if (out.length === MAX_PAGE_EDITS) break;
    if (!e || typeof e !== 'object') continue;
    const { anchor, selector, before, after } = e as Record<string, unknown>;
    if (!isElementAnchor(anchor)) continue;
    if (typeof selector !== 'string' || selector === '') continue;
    if (selector.length > MAX_PAGE_EDIT_SELECTOR) continue;
    if (!okText(before) || !okText(after) || before === after) continue;
    out.push({ anchor, selector, before, after });
  }
  return out.length > 0 ? out : undefined;
}

function quote(s: string): string {
  return `"${s.length > QUOTED ? `${s.slice(0, QUOTED - 1)}…` : s}"`;
}

/**
 * The comment's words for a send: what changed where, one line an edit.
 *
 * Written by the server from the edits themselves, so every surface that
 * shows a thread — the board, the doc page, the Home queue, an agent's
 * channel line — says the same thing the structure does.
 */
export function pageEditsText(edits: readonly PageEdit[]): string {
  const head = `${edits.length} text edit${edits.length === 1 ? '' : 's'} on this page:`;
  const lines = edits.map(
    (e) => `- ${e.selector}: ${quote(e.before)} → ${e.after === '' ? 'deleted' : quote(e.after)}`,
  );
  return [head, ...lines].join('\n');
}
