/**
 * Block identity: the id that lets an agent name a block it read, and the
 * authorship attribute that records which agent wrote it.
 *
 * Everything else in the prose family addresses the doc by TEXT — a find
 * string, a relative position, a heading's spelling. That is the right
 * address for an agent editing prose it just read in one shot. It is the
 * wrong one for an agent that reads the doc every few seconds and writes a
 * line at a time into it while a person types in the same paragraph: the
 * text it matched moves, the heading it keyed on gets renamed, and a
 * re-created element loses whatever the agent believed about it.
 *
 * So a block carries two attributes of its own:
 *
 * - `cwId` — a short opaque id. It is the address the outline hands out and
 *   the address an edit comes back with, so a rename of the heading above the
 *   block changes nothing about where the edit lands. A block that has none
 *   yet is addressed by `derivedBlockId`, and the first edit that writes the
 *   doc stores that value: an outline read writes nothing, like every GET.
 * - `cwAuthor` — the agent that WROTE this block. Set when an agent inserts
 *   it; cleared by `clearAuthorshipOnPersonEdit` the moment a person-origin
 *   transaction touches the block. So "still marked mine" and "still
 *   untouched by a person" are one question with one answer, and an agent
 *   may only replace, move or delete a block that answers it yes.
 *
 * Both live in the Yjs element, so they travel in the `.ydoc` snapshot and
 * survive a restart with no side file. They do NOT survive a round trip
 * through markdown — the `.md` on disk has nowhere to put them — which is
 * why a reparse-from-disk gives new ids and drops authorship. That is the
 * correct answer rather than a gap: a doc that came back off disk is one
 * nobody can prove the agent wrote.
 *
 * **The browser has to know these attributes exist.** y-prosemirror's
 * `updateYFragment` removes every Yjs attribute the ProseMirror node does
 * not carry, and `equalAttrs` counts keys on both sides — so an attribute
 * the editor's schema has never heard of is both stripped on the next local
 * edit and treated as a difference that forces the block to be rewritten.
 * `packages/workspaces-app/src/block-identity.ts` declares them as global
 * attributes for exactly that reason; deleting it silently un-does this
 * file.
 */
import * as Y from 'yjs';
import { blockAddresses, isAddressable, isListEl } from './prose-address.ts';
import { getProseFragment, headingLevelOf, walkProse } from './prose-fragment.ts';
import {
  BLOCK_AUTHOR_ATTR,
  readBlockAuthor,
  readBlockId,
  setBlockAuthor,
} from './prose-identity.ts';
import { textContent } from './prose-markdown.ts';

export {
  addressableBlocks,
  blockAddresses,
  duplicateIdBlocks,
  ensureBlockIds,
  findBlockById,
  remintDuplicateIds,
  storeBlockAddresses,
} from './prose-address.ts';
export {
  BLOCK_ID_ATTR,
  BLOCK_AUTHOR_ATTR,
  BLOCK_IDENTITY_ATTRS,
  blockAddressOf,
  derivedBlockId,
  readBlockId,
  readBlockAuthor,
  setBlockAuthor,
} from './prose-identity.ts';

/** Longest preview text an outline entry carries per block. */
const OUTLINE_TEXT_MAX = 240;

export type OutlineKind = 'heading' | 'listItem' | 'block';

/** One addressable block, as an agent sees it. */
export interface OutlineEntry {
  /** The address to send an edit back with. */
  id: string;
  kind: OutlineKind;
  /** Element tag, for a caller that wants to know a paragraph from a table. */
  nodeName: string;
  /** Heading level, for `kind: 'heading'` only. */
  level?: number;
  /** The block's text, truncated. */
  text: string;
  /** The agent that wrote it, when it is still marked and untouched. */
  author?: string;
  /** Id of the nearest heading above it, when there is one. */
  underHeadingId?: string;
  /**
   * How deeply a `listItem` is nested: `0` for a top-level bullet, `1` for a
   * sub-bullet under one, and so on. Absent for anything that is not a list
   * item.
   *
   * WITHOUT THIS AN OUTLINE CANNOT TELL A GROUPED TOPIC FROM A FLAT ONE. Every
   * bullet printed the same, so a note-taker asked to regroup a topic past
   * the flat-run bar had no way to see whether it had already done so — and
   * no way to count the run it was being asked about. It read six lines under
   * a heading whether they were a wall or three tidy groups.
   */
  depth?: number;
  /** A `listItem` of a numbered list. A dictated order is structure the
   *  speaker gave, and a check that read it as a flat wall would undo it. */
  ordered?: true;
}

/** The Yjs parent of a node, as an untyped walk. Yjs's own `parent` is typed
 *  per concrete type, so a loop that climbs from a `Y.XmlText` to an
 *  ancestor `Y.XmlElement` has no single type to name. */
export function parentOf(node: unknown): unknown {
  if (node == null || typeof node !== 'object') return null;
  return (node as { parent?: unknown }).parent ?? null;
}

let idSeq = 0;

/** A short id, unique within a process and unlikely to collide across them.
 *  Ids are opaque: nothing parses one, and nothing may depend on its shape. */
export function newBlockId(): string {
  idSeq = (idSeq + 1) % 0xffff;
  return `b${Date.now().toString(36)}${idSeq.toString(36)}${Math.floor(Math.random() * 0xffff).toString(36)}`;
}

/** How many lists a list item sits inside, less the one that holds it: `0`
 *  for a top-level bullet. Climbed rather than tracked through the walk,
 *  because `addressableBlocks` hands back a flat array and the nesting is
 *  the one thing that array has thrown away. */
function listDepthOf(el: Y.XmlElement): number {
  let depth = -1;
  let node: unknown = el;
  while (node != null) {
    if (node instanceof Y.XmlElement && isListEl(node)) depth++;
    node = parentOf(node);
  }
  return depth < 0 ? 0 : depth;
}

/** Mark `el` and every addressable block inside it as `author`'s. A parsed
 *  list arrives as ONE element, and it is the ITEMS an agent later edits. */
export function claimSubtree(el: Y.XmlElement, author: string): void {
  setBlockAuthor(el, author);
  if (el.nodeName === 'table') return;
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlElement && isAddressable(child)) claimSubtree(child, author);
    else if (child instanceof Y.XmlElement) {
      for (const grand of child.toArray()) {
        if (grand instanceof Y.XmlElement && isAddressable(grand)) claimSubtree(grand, author);
      }
    }
  }
}

/** The text an outline shows for a block: its own words, not its children's
 *  whole subtree. A list item reads as its first paragraph, so a group's lead
 *  bullet is not printed with every point nested under it. A block quote reads
 *  as its own PARAGRAPHS, separated: it is one entry now, so every paragraph
 *  in it has to appear here, and `textContent` alone joins children with
 *  nothing, which ran the last word of one paragraph into the first of the
 *  next. A list or code block inside a quote is left out for the reason the
 *  walk leaves a list container's words out — those blocks carry entries of
 *  their own, and printing them here is the doubling this whole file exists
 *  to avoid. */
export function outlineTextOf(el: Y.XmlElement): string {
  let text: string;
  if (el.nodeName === 'listItem') {
    const first = el.toArray()[0];
    text = first instanceof Y.XmlElement ? textContent(first) : '';
  } else if (el.nodeName === 'bulletList' || el.nodeName === 'orderedList') {
    text = '';
  } else if (el.nodeName === 'blockquote') {
    text = el
      .toArray()
      .filter(
        (child): child is Y.XmlElement =>
          child instanceof Y.XmlElement && child.nodeName === 'paragraph',
      )
      .map((child) => textContent(child))
      .join('\n');
  } else {
    text = textContent(el);
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > OUTLINE_TEXT_MAX ? `${flat.slice(0, OUTLINE_TEXT_MAX - 1)}…` : flat;
}

export interface OutlineOptions {
  /** Return only headings. The cheap read, for "where could this go?". */
  headingsOnly?: boolean;
  /** Cap on non-heading entries, counted from the END of the doc. Headings
   *  are never dropped. This is what keeps a tick's prompt the size of the
   *  conversation rather than the size of the meeting. */
  recentBlocks?: number;
  /**
   * How many body entries the window drops at a time, once `recentBlocks`
   * bites.
   *
   * WHY A WINDOW WOULD RATHER JUMP THAN SLIDE. A caller that reads this
   * outline into a model prompt every few seconds is paying for a prefix
   * match: the same leading text two reads running is billed at a tenth, and
   * one changed byte at the front costs the whole prompt. A window that keeps
   * "the last 80" drops its oldest line every time a new one is written, so
   * the front changes on every read and nothing ever matches. Dropping in
   * whole steps instead means the front is IDENTICAL for a step's worth of
   * reads and moves once — and what it holds only ever grows in between,
   * which is the shape a cache is cheap on.
   *
   * The cost is that the window is `recentBlocks` to `recentBlocks + step - 1`
   * entries rather than exactly `recentBlocks`: it never shows fewer than the
   * cap, only up to a step more. Absent, or not a positive number, the window
   * slides one at a time exactly as it always did.
   */
  recentBlocksStep?: number;
}

/**
 * The doc as an agent addresses it: every heading with its id, and the
 * blocks under them. Writes nothing: a block with no stored id is reported
 * under the address `blockAddresses` derives for it.
 */
export function readOutline(doc: Y.Doc, opts: OutlineOptions = {}): OutlineEntry[] {
  const fragment = getProseFragment(doc);
  const entries: OutlineEntry[] = [];
  let underHeadingId: string | undefined;
  for (const { el, id } of blockAddresses(fragment)) {
    const isHeading = el.nodeName === 'heading';
    if (isHeading) underHeadingId = id;
    if (opts.headingsOnly === true && !isHeading) continue;
    // A list container carries no words of its own; its items are the
    // entries. Printing it would spend a line saying "a list follows".
    if (el.nodeName === 'bulletList' || el.nodeName === 'orderedList') continue;
    // A copy's author is one it copied, and nothing proves the agent wrote it.
    const stored = readBlockId(el);
    const author = stored === undefined || stored === id ? readBlockAuthor(el) : undefined;
    entries.push({
      id,
      kind: isHeading ? 'heading' : el.nodeName === 'listItem' ? 'listItem' : 'block',
      nodeName: el.nodeName,
      ...(isHeading ? { level: headingLevelOf(el) } : {}),
      text: outlineTextOf(el),
      ...(author !== undefined ? { author } : {}),
      ...(!isHeading && underHeadingId !== undefined ? { underHeadingId } : {}),
      ...(el.nodeName === 'listItem' ? { depth: listDepthOf(el) } : {}),
      ...(el.nodeName === 'listItem' &&
      (parentOf(el) as Y.XmlElement | null)?.nodeName === 'orderedList'
        ? { ordered: true as const }
        : {}),
    });
  }
  const cap = opts.recentBlocks;
  if (cap === undefined || cap < 0) return entries;
  const bodyCount = entries.filter((e) => e.kind !== 'heading').length;
  if (bodyCount <= cap) return entries;
  const step = opts.recentBlocksStep;
  if (step !== undefined && Number.isFinite(step) && step > 0) {
    // Drop from the FRONT, in whole steps. Counting the drop rather than the
    // keep is what makes the retained front stand still: `dropped` is
    // unchanged for a step's worth of new entries, so every read in between
    // begins with the same words.
    const dropped = Math.floor((bodyCount - cap) / step) * step;
    if (dropped <= 0) return entries;
    let skip = dropped;
    const kept: OutlineEntry[] = [];
    for (const entry of entries) {
      if (entry.kind !== 'heading' && skip > 0) {
        skip--;
        continue;
      }
      kept.push(entry);
    }
    return kept;
  }
  let allowed = cap;
  const keep: OutlineEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as OutlineEntry;
    if (entry.kind === 'heading') {
      keep.push(entry);
      continue;
    }
    if (allowed <= 0) continue;
    allowed--;
    keep.push(entry);
  }
  return keep.reverse();
}

/**
 * Did this transaction come from a person?
 *
 * Every server-side write names its origin with a STRING — `'agent'`,
 * `'file-watch'`, `'block-ids'`. The collaboration socket does not: it hands
 * `readSyncMessage` the connection object itself, so an update that a
 * browser produced arrives with a non-string origin. Hydration applies its
 * update with no origin at all, which is neither.
 *
 * The test is therefore "a non-null origin that is not a string", and it is
 * written this way round on purpose: a new server-side writer that forgets
 * to name itself gets a loud misclassification rather than a silent pass.
 *
 * THE SERVER ASKS THE SAME QUESTION A DIFFERENT WAY. `isAuthoringOrigin` in
 * `packages/server/src/live-doc-fanout.ts` decides whether an update should
 * bump the doc's revision, and it names the two positive cases (an origin
 * string starting `agent`, or a connection this doc actually holds) instead
 * of naming the negative one. Both are right today; they answer differently
 * for an origin neither has met, so a change to either belongs in both.
 */
export function isPersonOrigin(origin: unknown): boolean {
  return origin != null && typeof origin !== 'string';
}

/** Origin used for the clearing write itself, so it is never mistaken for
 *  a person's edit on the way back round. */
export const AUTHOR_CLEAR_ORIGIN = 'author-clear';

/**
 * Watch a doc and drop the authorship attribute off any block a person
 * edits. Returns a disposer.
 *
 * The unit is the block the change happened INSIDE, walked up from the
 * event target, so typing one character in an agent's bullet hands that
 * bullet back and leaves its neighbours alone. Deleting a block needs no
 * handling: the attribute goes with it.
 *
 * THE CLEAR IS ITS OWN TRANSACTION, and it lands a beat after the edit.
 * Observers run once the transaction that triggered them has been cleaned
 * up, so this handler is outside the person's transaction by the time it
 * runs and its `doc.transact` opens a second one, under
 * `AUTHOR_CLEAR_ORIGIN`. A reader watching the doc can therefore see the
 * person's character with the agent's claim still on the block. That is
 * safe because nothing decides anything in the gap: the only reader of the
 * attribute is `applyBlockEdits`, which runs on a tick of its own and sees
 * the cleared state, and the second observer pass this write triggers is
 * not a person's origin, so it finds nothing to clear and stops.
 */
export function clearAuthorshipOnPersonEdit(doc: Y.Doc): () => void {
  const fragment = getProseFragment(doc);
  const onChange = (events: Y.YEvent<Y.AbstractType<unknown>>[], txn: Y.Transaction): void => {
    if (!isPersonOrigin(txn.origin)) return;
    const claimed = new Set<Y.XmlElement>();
    for (const event of events) {
      let node: unknown = event.target;
      while (node != null) {
        if (node instanceof Y.XmlElement && readBlockAuthor(node) !== undefined) {
          claimed.add(node);
        }
        node = parentOf(node);
      }
    }
    if (claimed.size === 0) return;
    doc.transact(() => {
      for (const el of claimed) el.removeAttribute(BLOCK_AUTHOR_ATTR);
    }, AUTHOR_CLEAR_ORIGIN);
  };
  fragment.observeDeep(onChange);
  return () => fragment.unobserveDeep(onChange);
}

/** Plain text of a doc's blocks, for a caller that wants the words without
 *  the walk. Thin wrapper over `walkProse`, exported so the notes reader
 *  does not have to reach into `prose-fragment.ts` itself. */
export function plainTextOf(doc: Y.Doc): string {
  return walkProse(getProseFragment(doc)).plainText;
}
