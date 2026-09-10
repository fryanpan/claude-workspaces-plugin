/**
 * The one-off repair for documents already carrying a note-list gap.
 *
 * The defect is in `insertBlocksMerging` (`packages/core/src/prose-batch.ts`)
 * and is fixed there: a browser holding a doc open keeps an empty paragraph
 * at its end (Tiptap's `TrailingNode`), a meeting's notes heading is the last
 * heading, so every note landed after that paragraph, the merge test saw the
 * paragraph rather than the list, and each note opened a list of its own with
 * what reads as two blank lines in front of it.
 *
 * The fix stops new notes doing that. It does nothing for the documents that
 * already read that way, which is what this module is: for each empty
 * unclaimed paragraph flanked by two lists of the same type, the later list's
 * items move into the earlier one and the paragraph stays where it lands.
 *
 * ## What survives the move, and what does not
 *
 * Yjs cannot reparent an integrated type, so the items are `clone()`d into
 * the host list and the emptied wrapper is deleted. A clone carries every
 * attribute, so **`cwId` and `cwAuthor` ride along on each item** — the notes
 * stay the agent's own, still addressable by the ids the note-taker knows.
 *
 * A clone does NOT carry Yjs item identity, so **every `Y.RelativePosition`
 * into the moved text stops resolving** — measured, not assumed. Comment
 * anchors are exactly such positions, so the move alone would orphan every
 * thread anchored to a moved bullet. This module therefore rebuilds them:
 *
 * - Before the move it records each anchor as a pair of DOC OFFSETS into
 *   `prose.walkProse(...).plainText`, plus the text they span.
 * - The move leaves those offsets unchanged. An empty paragraph contributes
 *   no characters and exactly one `\n\n` separator wherever it sits, so
 *   relocating it from between the two lists to after them shifts nothing:
 *   the separator the paragraph used to supply in front of the stranded
 *   items is the one they now get from the item above. Asserted by
 *   `note-list-gap-repair.test.ts` rather than trusted.
 * - After the move it mints fresh relative positions at the same offsets and
 *   checks the span still reads the same words. An anchor whose span changed,
 *   or which did not resolve to begin with, is left exactly as it was and
 *   counted — this module never orphans a thread and never guesses.
 *
 * ## What the shape does NOT prove
 *
 * An empty paragraph a person typed into and then cleared is byte-identical
 * to the browser's: person edits strip authorship
 * (`clearAuthorshipOnPersonEdit`) and a person's own block never carried it.
 * So a gap site is a strong signal, not a proof, and this repair RESTRUCTURES
 * a document rather than merely reading it. Measured on the corpus this was
 * written for: three of nine sites carried no authorship anywhere, because a
 * document parsed from a `.md` file has none — so an authorship filter would
 * have skipped a meeting that plainly needed repairing, which is why
 * `GapSite.authored` is reported as evidence for a person to read rather than
 * used as a gate. The gate is `scripts/repair-note-list-gaps.ts` refusing to
 * `--apply` across a whole directory: somebody reads the dry run and names
 * the documents.
 *
 * The one identity that is genuinely retired is the emptied list WRAPPER's
 * own `cwId`. Nothing addresses a list wrapper by id: `readOutline` emits
 * headings, list ITEMS and non-list blocks, so no id a caller has ever been
 * shown points at a wrapper.
 *
 * This module only ever touches a `Y.Doc` it was handed.
 * `note-list-gap-corpus.ts` is the half that reads and writes files, and
 * `scripts/repair-note-list-gaps.ts` the only caller that names a real data
 * directory.
 */
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';

/** The transaction origin every write here carries, so a live server's own
 *  observers can tell a repair from a person and from an agent. */
export const REPAIR_ORIGIN = 'note-list-gap-repair';

/** One place a stranded list sits behind blank paragraphs it should not. */
export interface GapSite {
  /** Top-level index of the list the items belong in. */
  hostIndex: number;
  /** Top-level index of the list whose items are stranded. */
  strandedIndex: number;
  /** `bulletList` or `orderedList` — both lists are this. */
  nodeName: string;
  /** How many items the move would carry. */
  items: number;
  /** How many blank paragraphs sit between the two. */
  paragraphs: number;
  /** Every item of the stranded list carries a `cwAuthor` — evidence that an
   *  agent wrote them and no person has touched them since
   *  (`clearAuthorshipOnPersonEdit` strips authorship when one does). False
   *  is not evidence of the opposite: a document parsed from a `.md` file
   *  carries no authorship anywhere. */
  authored: boolean;
}

export interface RepairReport {
  /** Gap sites merged. A chain of three lists is two sites. */
  sites: number;
  itemsMoved: number;
  /** Text-range thread anchors that resolved before the repair. */
  anchorsChecked: number;
  /** Of those, the ones re-minted at the same offsets and verified. */
  anchorsRebuilt: number;
  /** Of those, the ones left untouched because the rebuild did not verify. */
  anchorsUnverified: number;
}

function isList(el: unknown): el is Y.XmlElement {
  return (
    el instanceof Y.XmlElement && (el.nodeName === 'bulletList' || el.nodeName === 'orderedList')
  );
}

/**
 * Every gap site currently in `doc`, left to right.
 *
 * A site is a list, one or more empty unclaimed paragraphs, and a second list
 * of the SAME type. The blank-paragraph test is the one the fix uses —
 * imported rather than restated, so the repair can never disagree with the
 * code that stops the damage recurring.
 *
 * Sites are reported non-overlapping: after one is found the scan resumes at
 * the stranded list, which is the host of the next site in a chain. Merging
 * changes indices, so a caller applying them re-reads rather than batching.
 */
export function findGapSites(doc: Y.Doc): GapSite[] {
  const fragment = doc.getXmlFragment('prose');
  const tops = fragment.toArray() as (Y.XmlElement | Y.XmlText)[];
  const sites: GapSite[] = [];
  let i = 0;
  while (i < tops.length) {
    if (!isList(tops[i])) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < tops.length && prose.isUnclaimedBlankParagraph(tops[j])) j++;
    const stranded = tops[j];
    if (j > i + 1 && isList(stranded) && stranded.nodeName === (tops[i] as Y.XmlElement).nodeName) {
      const items = stranded.toArray() as Y.XmlElement[];
      sites.push({
        hostIndex: i,
        strandedIndex: j,
        nodeName: stranded.nodeName,
        items: items.length,
        paragraphs: j - i - 1,
        authored: items.length > 0 && items.every((it) => prose.readBlockAuthor(it) !== undefined),
      });
      i = j;
      continue;
    }
    i++;
  }
  return sites;
}

interface AnchorSnapshot {
  set: Y.Map<Y.Map<unknown>>;
  key: string;
  start: number;
  end: number;
  text: string;
  /** The stored anchor as it was. A rebuild writes this back with only
   *  `startRel` and `endRel` replaced: a text-range anchor may also carry
   *  `context` (which view the thread belongs to) and `deletedSnippet` (what
   *  a redline comment was actually about), and rebuilding the object from
   *  its positions alone would drop both. */
  original: unknown;
}

/** Doc offset of a resolved relative position, or null when it is outside the
 *  prose fragment (a code doc's flat text, say). */
function offsetOf(
  doc: Y.Doc,
  encoded: unknown,
  segments: ReturnType<typeof prose.walkProse>['segments'],
) {
  if (!(encoded instanceof Uint8Array) && !Array.isArray(encoded)) return null;
  const bytes = encoded instanceof Uint8Array ? encoded : new Uint8Array(encoded as number[]);
  let rel: Y.RelativePosition;
  try {
    rel = Y.decodeRelativePosition(bytes);
  } catch {
    return null;
  }
  const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc);
  if (!abs || !(abs.type instanceof Y.XmlText)) return null;
  const seg = segments.find((s) => s.node === abs.type);
  if (!seg) return null;
  return seg.docOffset + abs.index;
}

/** Read every text-range anchor in `map` as a pair of doc offsets. */
function snapshotAnchors(
  doc: Y.Doc,
  map: Y.Map<Y.Map<unknown>>,
  read: (entry: Y.Map<unknown>) => { startRel: unknown; endRel: unknown; original: unknown } | null,
): AnchorSnapshot[] {
  const { plainText, segments } = prose.walkProse(doc.getXmlFragment('prose'));
  const out: AnchorSnapshot[] = [];
  map.forEach((entry, key) => {
    const raw = read(entry);
    if (!raw) return;
    const start = offsetOf(doc, raw.startRel, segments);
    const end = offsetOf(doc, raw.endRel, segments);
    if (start === null || end === null) return;
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    out.push({
      set: map,
      key,
      start: lo,
      end: hi,
      text: plainText.slice(lo, hi),
      original: raw.original,
    });
  });
  return out;
}

/** Mint a relative position at `offset`, or nothing if no segment covers it. */
function relAt(
  offset: number,
  segments: ReturnType<typeof prose.walkProse>['segments'],
): Uint8Array | null {
  const seg =
    segments.find((s) => offset >= s.docOffset && offset < s.docOffset + s.length) ??
    segments.find((s) => offset === s.docOffset + s.length);
  if (!seg) return null;
  return Y.encodeRelativePosition(
    Y.createRelativePositionFromTypeIndex(seg.node, offset - seg.docOffset),
  );
}

/**
 * Put each snapshot back at the offset it held, and say how many verified.
 *
 * A rebuild only lands when the new positions span exactly the words the old
 * ones did. Anything else leaves the stored anchor alone: a broken anchor the
 * editor will orphan on its own is a smaller loss than one this script
 * silently moved to different words.
 */
function restoreAnchors(
  doc: Y.Doc,
  snapshots: AnchorSnapshot[],
  write: (
    entry: Y.Map<unknown>,
    startRel: Uint8Array,
    endRel: Uint8Array,
    snippet: unknown,
  ) => void,
): { rebuilt: number; unverified: number } {
  const { plainText, segments } = prose.walkProse(doc.getXmlFragment('prose'));
  let rebuilt = 0;
  let unverified = 0;
  for (const snap of snapshots) {
    const entry = snap.set.get(snap.key);
    const startRel = relAt(snap.start, segments);
    const endRel = relAt(snap.end, segments);
    if (!entry || !startRel || !endRel || plainText.slice(snap.start, snap.end) !== snap.text) {
      unverified++;
      continue;
    }
    doc.transact(() => write(entry, startRel, endRel, snap.original), REPAIR_ORIGIN);
    rebuilt++;
  }
  return { rebuilt, unverified };
}

/** Move one site's stranded items into its host list. */
function mergeSite(fragment: Y.XmlFragment, site: GapSite): number {
  const host = fragment.get(site.hostIndex) as Y.XmlElement;
  const stranded = fragment.get(site.strandedIndex) as Y.XmlElement;
  const clones = (stranded.toArray() as Y.XmlElement[]).map((item) => item.clone());
  host.insert(host.length, clones);
  fragment.delete(site.strandedIndex, 1);
  return clones.length;
}

/**
 * Repair every gap site in `doc`, rebuilding comment anchors around the move.
 *
 * Idempotent: a second run finds no sites and writes nothing. Returns what it
 * did, which is what the CLI prints in dry-run mode and what the caller
 * checks afterwards.
 */
export function repairNoteListGaps(doc: Y.Doc): RepairReport {
  const fragment = doc.getXmlFragment('prose');
  if (findGapSites(doc).length === 0) {
    return { sites: 0, itemsMoved: 0, anchorsChecked: 0, anchorsRebuilt: 0, anchorsUnverified: 0 };
  }

  const threads = snapshotAnchors(doc, doc.getMap('threads') as Y.Map<Y.Map<unknown>>, (entry) => {
    const anchor = entry.get('anchor') as
      | { kind?: string; startRel?: unknown; endRel?: unknown }
      | undefined;
    if (!anchor || anchor.kind !== 'text-range') return null;
    return { startRel: anchor.startRel, endRel: anchor.endRel, original: anchor };
  });
  const agentAnchors = snapshotAnchors(
    doc,
    doc.getMap('agent_anchors') as Y.Map<Y.Map<unknown>>,
    (entry) => {
      const startRel = entry.get('startRel');
      const endRel = entry.get('endRel');
      if (!startRel || !endRel) return null;
      return { startRel, endRel, original: undefined };
    },
  );

  let sites = 0;
  let itemsMoved = 0;
  doc.transact(() => {
    // Re-read after every merge: a merge shifts every index after it, and a
    // chain of lists collapses one site at a time into the same host.
    for (;;) {
      const next = findGapSites(doc)[0];
      if (!next) break;
      itemsMoved += mergeSite(fragment, next);
      sites++;
      // A site can only ever remove a top-level node, so the loop is bounded
      // by the fragment's length; this is the belt to that brace.
      if (sites > fragment.length + 1) break;
    }
  }, REPAIR_ORIGIN);

  const threadResult = restoreAnchors(doc, threads, (entry, startRel, endRel, original) => {
    // Spread, never rebuild: `context` and `deletedSnippet` are optional
    // fields of a text-range anchor that only the thread that wrote them can
    // supply, and composing a fresh object from the positions drops them.
    entry.set('anchor', { ...(original as object), startRel, endRel });
  });
  const agentResult = restoreAnchors(doc, agentAnchors, (entry, startRel, endRel) => {
    entry.set('startRel', startRel);
    entry.set('endRel', endRel);
  });

  return {
    sites,
    itemsMoved,
    anchorsChecked: threads.length + agentAnchors.length,
    anchorsRebuilt: threadResult.rebuilt + agentResult.rebuilt,
    anchorsUnverified: threadResult.unverified + agentResult.unverified,
  };
}
