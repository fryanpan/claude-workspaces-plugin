import { createAnchor } from '@claude-workspaces/core/anchor/element';
import { type PageEdit, readPageEdits } from '@claude-workspaces/core/page-edits';

/**
 * Edit mode's rules that need no screen: which element a tap edits, the
 * short path the agent is handed, what an unsent draft remembers, and which
 * mark a sent edit wears.
 *
 * Nothing here writes the page's source. A draft changes the words on the
 * reader's screen and remembers what they were; a send posts the difference
 * on the page's thread (`edit-mode.ts`), and the agent applies it to whatever
 * generated the page.
 */

/** Our own nodes carry this, as every widget node does (`widget-picker.ts`). */
const OURS = '[data-feedback-widget],claude-feedback-widget';

/** Phrasing elements a text element may hold and still be edited as text.
 *  Anything else inside it — a list, a paragraph, an image — makes it a
 *  layout, which v1 does not edit. */
const INLINE = new Set([
  'A',
  'ABBR',
  'B',
  'BDI',
  'BDO',
  'BR',
  'CITE',
  'CODE',
  'DATA',
  'DFN',
  'EM',
  'I',
  'KBD',
  'MARK',
  'Q',
  'S',
  'SAMP',
  'SMALL',
  'SPAN',
  'STRONG',
  'SUB',
  'SUP',
  'TIME',
  'U',
  'VAR',
  'WBR',
]);

/** Elements whose words are not text on the page. */
const NOT_TEXT = new Set([
  'INPUT',
  'TEXTAREA',
  'SELECT',
  'OPTION',
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'SVG',
  'CANVAS',
  'IFRAME',
  'VIDEO',
  'AUDIO',
  'IMG',
  'HTML',
  'BODY',
]);

/** Wrappers a readable path leaves out: they rarely name anything. */
const WRAPPERS = new Set(['DIV', 'TBODY', 'THEAD', 'TFOOT', 'SECTION', 'FIGURE', 'MAIN']);

/** Words as a reader sees them: runs of whitespace are one space. */
export function normText(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

function onlyInline(el: Element): boolean {
  for (const c of el.children) {
    if (!INLINE.has(c.tagName) || !onlyInline(c)) return false;
  }
  return true;
}

/**
 * The element a tap on `start` edits: the nearest one up the tree that holds
 * words and nothing but words, or null. An inline element inside a paragraph
 * edits the paragraph, so a bold word is changed in its sentence.
 */
export function editableTarget(start: Element | null): HTMLElement | null {
  if (!start || start.closest(OURS)) return null;
  let el: Element | null = start;
  while (el && INLINE.has(el.tagName) && el.parentElement && onlyInline(el.parentElement)) {
    el = el.parentElement;
  }
  if (!(el instanceof HTMLElement) || NOT_TEXT.has(el.tagName)) return null;
  if (el.closest('svg,[contenteditable="false"]')) return null;
  if (!onlyInline(el) || normText(el.textContent) === '') return null;
  return el;
}

function step(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const cls = [...el.classList].find((c) => !c.startsWith('cw-') && !c.startsWith('cfw-'));
  const parent = el.parentElement;
  const sameTag = parent ? [...parent.children].filter((c) => c.tagName === el.tagName) : [];
  const nth = sameTag.length > 1 ? `:nth-of-type(${sameTag.indexOf(el) + 1})` : '';
  return `${tag}${cls ? `.${cls}` : ''}${nth}`;
}

/**
 * A short CSS path for the agent to find the node by in its own template:
 * the last three steps, without the wrappers that name nothing. Readable
 * before it is unique; the anchor beside it is what the page resolves by.
 */
export function cssPath(el: Element): string {
  const steps: string[] = [];
  let at: Element | null = el;
  while (at && steps.length < 3 && at.tagName !== 'BODY' && at.tagName !== 'HTML') {
    if (at === el || !WRAPPERS.has(at.tagName)) steps.unshift(step(at));
    at = at.parentElement;
  }
  return steps.join(' > ');
}

interface Draft {
  edit: Omit<PageEdit, 'after'>;
  /** The element's children as they were, so undo gives its markup back. */
  nodes: Node[];
}

/**
 * The edits typed and not yet sent. Held against the elements they change;
 * `edit-mode.ts` writes them out as they change, so a reload puts them back
 * (`draft-store.ts`).
 */
export class EditDrafts {
  private drafts = new Map<HTMLElement, Draft>();

  /** Remember `el` as it is now, before the first keystroke changes it. */
  begin(el: HTMLElement): void {
    if (this.drafts.has(el)) return;
    this.drafts.set(el, {
      edit: { anchor: createAnchor(el), selector: cssPath(el), before: normText(el.textContent) },
      nodes: [...el.childNodes].map((n) => n.cloneNode(true)),
    });
  }

  has(el: HTMLElement): boolean {
    return this.drafts.has(el);
  }

  /** The elements whose words now differ from what they were. */
  elements(): HTMLElement[] {
    return [...this.drafts.keys()].filter(
      (el) => normText(el.textContent) !== this.drafts.get(el)?.edit.before,
    );
  }

  /** Every draft that changes something, as the edit the agent will get. */
  changed(): PageEdit[] {
    return this.elements().map((el) => ({
      ...(this.drafts.get(el) as Draft).edit,
      after: normText(el.textContent),
    }));
  }

  /** Put the element's words back as they were, and forget the draft. */
  undo(el: HTMLElement): void {
    const d = this.drafts.get(el);
    if (!d) return;
    el.replaceChildren(...d.nodes.map((n) => n.cloneNode(true)));
    this.drafts.delete(el);
  }

  /** Forget one draft, leaving its element as it is: it has left the page. */
  forget(el: HTMLElement): void {
    this.drafts.delete(el);
  }

  /** Forget every draft, leaving the words as typed: they have been sent. */
  clear(): void {
    this.drafts.clear();
  }
}

/** One send on the page's threads. */
export interface SentEdits {
  threadId: string;
  /** Open: the agent has not resolved it. */
  open: boolean;
  edits: PageEdit[];
}

/** The sends among a doc's threads, read from the threads map's JSON. */
export function sentEdits(threads: Record<string, unknown>): SentEdits[] {
  const out: SentEdits[] = [];
  for (const [threadId, raw] of Object.entries(threads)) {
    const t = raw as { status?: unknown; comments?: Array<{ pageEdits?: unknown }> } | null;
    const edits = readPageEdits(t?.comments?.[0]?.pageEdits);
    if (edits) out.push({ threadId, open: t?.status === 'open', edits });
  }
  return out;
}

/**
 * Which mark a sent edit wears: `pending` until the agent has applied it,
 * `applied` after. Applied is the thread resolved, or the page showing the
 * new words when the reader did not type them in this visit — which is the
 * agent's change arriving through a reload.
 */
export function markFor(
  open: boolean,
  edit: PageEdit,
  shown: string,
  typedHere: boolean,
): 'pending' | 'applied' {
  if (!open) return 'applied';
  return !typedHere && normText(shown) === normText(edit.after) ? 'applied' : 'pending';
}
