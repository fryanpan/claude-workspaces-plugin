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
 * The one identity that is genuinely retired is the emptied list WRAPPER's
 * own `cwId`. Nothing addresses a list wrapper by id: `readOutline` emits
 * headings, list ITEMS and non-list blocks, so no id a caller has ever been
 * shown points at a wrapper.
 *
 * ## Read this before running it against live data
 *
 * The server is the only writer of a `.ydoc`, and it writes a full snapshot
 * of whatever it holds in memory. Repairing a file a server has open is
 * therefore undone by that server's next flush — silently, with no error
 * anywhere. `scripts/repair-note-list-gaps.ts` is the only caller that names
 * a real data directory — the rule the doc-identity migration set, and the
 * reason a test run and a stray import cannot rewrite a corpus — and it is
 * where that check lives, because the discovery slot is a fact about this
 * machine rather than about a corpus.
 */
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
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
      sites.push({
        hostIndex: i,
        strandedIndex: j,
        nodeName: stranded.nodeName,
        items: stranded.length,
        paragraphs: j - i - 1,
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
  snippet: unknown;
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
  read: (entry: Y.Map<unknown>) => { startRel: unknown; endRel: unknown; snippet: unknown } | null,
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
      snippet: raw.snippet,
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
    doc.transact(() => write(entry, startRel, endRel, snap.snippet), REPAIR_ORIGIN);
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
      | { kind?: string; startRel?: unknown; endRel?: unknown; snippet?: unknown }
      | undefined;
    if (!anchor || anchor.kind !== 'text-range') return null;
    return { startRel: anchor.startRel, endRel: anchor.endRel, snippet: anchor.snippet };
  });
  const agentAnchors = snapshotAnchors(
    doc,
    doc.getMap('agent_anchors') as Y.Map<Y.Map<unknown>>,
    (entry) => {
      const startRel = entry.get('startRel');
      const endRel = entry.get('endRel');
      if (!startRel || !endRel) return null;
      return { startRel, endRel, snippet: undefined };
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

  const threadResult = restoreAnchors(doc, threads, (entry, startRel, endRel, snippet) => {
    entry.set('anchor', { kind: 'text-range', startRel, endRel, snippet });
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

/** Suffix of the copy taken before a document is rewritten. */
export const BACKUP_SUFFIX = '.pre-list-repair';

export interface DataDirOptions {
  /** Write the repairs. Without it nothing is opened for writing at all. */
  apply?: boolean;
  /** Only these doc ids, rather than every `.ydoc` in the directory. */
  docIds?: readonly string[];
  /** Where a line of the report goes. */
  log?: (line: string) => void;
}

export interface DataDirResult {
  /** Documents carrying at least one site, whether or not they were written. */
  docsWithSites: number;
  sitesFound: number;
  docsRepaired: number;
  sitesRepaired: number;
  itemsMoved: number;
  anchorsRebuilt: number;
  anchorsUnverified: number;
}

function loadYdoc(path: string): Y.Doc | null {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, new Uint8Array(readFileSync(path)));
  } catch {
    return null;
  }
  return doc;
}

/**
 * Write temp-then-rename.
 *
 * The write-over-the-original version of this in the doc-identity migration
 * had a window where a failure left a TRUNCATED `.ydoc` — the durable record
 * of somebody's document, the one thing here that nothing rebuilds. A rename
 * is atomic: the file is either the document as it was or the repaired one.
 */
function saveYdoc(path: string, doc: Y.Doc): void {
  const tmp = `${path}.repairing`;
  writeFileSync(tmp, Y.encodeStateAsUpdate(doc));
  renameSync(tmp, path);
}

/**
 * Report — and with `apply`, repair — every gap site in a data directory.
 *
 * Nothing is destroyed: a document about to be rewritten is copied to
 * `<id>.ydoc.pre-list-repair` first, and an EXISTING copy is never
 * overwritten, so a second run cannot turn the backup into a copy of the
 * repaired file. Reverting one document is a `mv` of that copy back.
 */
export function repairDataDir(dataDir: string, opts: DataDirOptions = {}): DataDirResult {
  const log = opts.log ?? ((line: string) => console.log(line));
  const result: DataDirResult = {
    docsWithSites: 0,
    sitesFound: 0,
    docsRepaired: 0,
    sitesRepaired: 0,
    itemsMoved: 0,
    anchorsRebuilt: 0,
    anchorsUnverified: 0,
  };

  const ids =
    opts.docIds && opts.docIds.length > 0
      ? [...opts.docIds]
      : readdirSync(dataDir)
          .filter((name) => name.endsWith('.ydoc'))
          .map((name) => name.slice(0, -'.ydoc'.length))
          .sort();

  for (const id of ids) {
    const path = join(dataDir, `${id}.ydoc`);
    if (!existsSync(path)) {
      log(`${id}: no .ydoc — skipped`);
      continue;
    }
    const doc = loadYdoc(path);
    if (!doc) {
      log(`${id}: unreadable — skipped`);
      continue;
    }
    const sites = findGapSites(doc);
    if (sites.length === 0) continue;
    result.docsWithSites++;
    result.sitesFound += sites.length;
    log(
      `${id}: ${sites.length} site(s) — ` +
        sites.map((s) => `${s.items} item(s) behind ${s.paragraphs} blank`).join('; '),
    );
    if (!opts.apply) continue;

    const backup = `${path}${BACKUP_SUFFIX}`;
    if (!existsSync(backup)) copyFileSync(path, backup);
    const report = repairNoteListGaps(doc);
    saveYdoc(path, doc);
    result.docsRepaired++;
    result.sitesRepaired += report.sites;
    result.itemsMoved += report.itemsMoved;
    result.anchorsRebuilt += report.anchorsRebuilt;
    result.anchorsUnverified += report.anchorsUnverified;
    log(
      `  repaired: ${report.sites} site(s), ${report.itemsMoved} item(s) moved, ` +
        `anchors ${report.anchorsRebuilt}/${report.anchorsChecked} rebuilt` +
        (report.anchorsUnverified > 0 ? `, ${report.anchorsUnverified} left alone` : ''),
    );
  }
  return result;
}
