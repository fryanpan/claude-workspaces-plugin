/**
 * Editing the words in a doc: whole-doc rewrites, find-and-replace, the
 * anchored edits a comment thread drives, and block insert and delete. The
 * suggestion verbs are in `doc-suggest-ops.ts`, resolving docs through `live`.
 *
 * Split out of `doc-store.ts`, which keeps the doc lifecycle these operate on.
 * Almost every verb here is a thin, deliberate wrapper: resolve the doc,
 * hand the `Y.Doc` to `prose`, return what it says. The
 * value of gathering them is that the wrapping is the SAME each time —
 * a missing doc is one answer, not eleven — and that is easier to hold
 * true in one file than scattered through six thousand lines of lifecycle.
 *
 * What it needs from the store is four things, named in `DocEditPersistence`
 * rather than reached for through a `this` that also owns eviction, file
 * watchers and the websocket fan-out.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Thread, contentKind, prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import {
  type BlockEditsAuthor,
  type BlockEditsResult,
  type DocOutline,
  applyDocBlockEdits,
  readDocOutline,
} from './doc-outline-ops.ts';
import type { LiveDoc } from './doc-store.ts';
import {
  STALE_WRITE_WINDOW_MS,
  type ScopedEditGuard,
  type ScopedEditRefusal,
  scopedEditRefusal,
  touchedByDryRun,
  unseenHumanEdit,
} from './scoped-edit-guard.ts';

/** Backups kept per doc by `backupReplacedContent` before rotation. */
const REPLACE_BACKUP_CAP = 20;

/** What a doc-edit verb may reach in the store, and nothing else. */
export interface DocEditPersistence {
  /** Where backups are written. Read at call time: the store builds this
   *  seam in a field initialiser, before its own config is assigned. */
  dataDir(): string;
  /** The hydrated doc behind a docId or alias, or nothing. */
  doc(docId: string): LiveDoc | undefined;
  thread(docId: string, threadId: string): Thread | null;
  /** `DocStore.staleWriteCheck`: has a person edited since this reader read? */
  staleWrite(docId: string, reader?: string): { humanEditedAt: number; lastReadAt?: number } | null;
}

/** The editing verbs. One per `DocStore`; its only state is the backup counter,
 *  which nothing outside a backup has ever read. */
export class DocEditOps {
  private backupSeq = 0;
  /** While `guardScopedEdit` dry-runs an edit, the copy the verbs resolve to. */
  private dryRun: { real: LiveDoc; copy: LiveDoc } | null = null;

  constructor(private readonly p: DocEditPersistence) {}

  /** The doc a verb edits: the live one, or its copy during a dry run.
   *  Public so `DocSuggestOps` resolves through the same dry-run swap. */
  live(docId: string): LiveDoc | undefined {
    const doc = this.p.doc(docId);
    return doc && this.dryRun?.real === doc ? this.dryRun.copy : doc;
  }

  /**
   * Run one scoped edit under the stale-write rule (`scoped-edit-guard.ts`).
   * When a person has edited since the caller's last read, the edit is first
   * tried on a copy, and refused if a block it changes is one they changed.
   * Before an edit lands on a doc a person edited inside the window, the doc
   * as it stands is backed up — once per person's edit, not once per agent
   * edit, so an agent working through a doc does not rotate the person's
   * version out of the backups. No `guard` is a server-side writer acting for
   * a person, which runs unchecked as it always did.
   */
  guardScopedEdit<R extends { ok: boolean }>(
    docId: string,
    guard: ScopedEditGuard | undefined,
    run: () => R,
  ): R | (R & { backup: string }) | ScopedEditRefusal {
    const doc = this.p.doc(docId);
    if (!doc || !guard) return run();
    const now = Date.now();
    if (guard.confirm !== true) {
      const stale = this.p.staleWrite(docId, guard.reader);
      if (stale) {
        const { touched } = touchedByDryRun(doc.ydoc, prose.getProseFragment, (copy) => {
          // A view over the live doc with only `ydoc` swapped, never a spread:
          // spreading reads every getter, and `awareness` constructs a
          // presence object with a timer that never stops.
          const view = Object.create(doc, { ydoc: { value: copy } }) as LiveDoc;
          this.dryRun = { real: doc, copy: view };
          try {
            return run();
          } finally {
            this.dryRun = null;
          }
        });
        const at = unseenHumanEdit(touched, doc.humanBlockEditAt, {
          lastReadAt: stale.lastReadAt,
          now,
        });
        if (at !== undefined) return scopedEditRefusal(at, stale.lastReadAt);
      }
    }
    let backup: string | null = null;
    if (
      doc.lastHumanEditAt !== undefined &&
      now - doc.lastHumanEditAt < STALE_WRITE_WINDOW_MS &&
      doc.humanEditSeq !== doc.backedUpHumanEditSeq
    ) {
      backup = this.backupReplacedContent(
        docId,
        prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc)),
      );
      if (backup) doc.backedUpHumanEditSeq = doc.humanEditSeq;
    }
    const res = run();
    return backup && res.ok ? { ...res, backup } : res;
  }

  /**
   * Snapshot the markdown a whole-doc rewrite is about to replace into
   * `<dataDir>/backups/<docId>/<ts>-<seq>.md`, rotating to a cap. Runs on
   * EVERY accepted set_doc_content — including a confirmed overwrite — so
   * "the guard was bypassed" is never the same event as "the words are
   * gone", and before a scoped edit on a doc a person just edited
   * (`guardScopedEdit`). Backups are transient files: rotation hard-deletes
   * the oldest.
   * Never throws; the rewrite proceeds either way.
   */
  private backupReplacedContent(docId: string, content: string): string | null {
    try {
      const safeId = docId.replace(/[^A-Za-z0-9._-]/g, '_');
      const dir = join(this.p.dataDir(), 'backups', safeId);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const seq = String(this.backupSeq++).padStart(6, '0');
      const file = join(dir, `${Date.now()}-${seq}.md`);
      writeFileSync(file, content);
      const entries = readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .sort();
      for (const stale of entries.slice(0, Math.max(0, entries.length - REPLACE_BACKUP_CAP))) {
        rmSync(join(dir, stale), { force: true });
      }
      return file;
    } catch (err) {
      console.error(`[doc-store] pre-edit backup failed for ${docId}:`, err);
      return null;
    }
  }

  setDocContent(
    docId: string,
    markdown: string,
  ): { ok: true } | { ok: false; error: 'not-found' | 'unsupported' | 'empty' | 'parse-failed' } {
    const doc = this.live(docId);
    if (!doc) return { ok: false, error: 'not-found' };
    // Flat docs (code / diff) are read-only review surfaces; their content
    // comes from disk or a pinned commit, never from an agent payload.
    if (contentKind(doc.meta.type) !== 'prose') return { ok: false, error: 'unsupported' };
    if (!markdown.trim()) return { ok: false, error: 'empty' };
    // An `.mdx` doc reads its components as blocks, as its bound file does.
    const opts = { mdx: prose.isMdxPath(doc.meta.sourceUrl) };
    let blocks: Y.XmlElement[];
    try {
      blocks = prose.parseMarkdownBlocks(markdown, opts);
    } catch {
      return { ok: false, error: 'parse-failed' };
    }
    if (blocks.length === 0) return { ok: false, error: 'empty' };
    const fragment = prose.getProseFragment(doc.ydoc);
    // Backup-on-replace: whatever the doc holds right now survives this
    // rewrite on disk, whoever wrote it and whatever the caller believed.
    this.backupReplacedContent(docId, prose.serializeFragmentToMarkdown(fragment));
    // A doc-side edit origin (NOT 'file-watch'): the write-back observer must
    // see this and flush it to disk like any other agent edit.
    doc.ydoc.transact(() => {
      prose.applyMarkdownToFragment(fragment, markdown, opts);
    }, 'agent-set-content');
    prose.normalizeHeadingLevels(doc.ydoc);
    return { ok: true };
  }

  /**
   * Replace `find` with `replace` inside the doc. Optional context
   * string around the match disambiguates repeated phrases; pass
   * `occurrence` to pick by index when you know the match count.
   */
  findAndReplace(
    docId: string,
    opts: {
      find: string;
      replace: string;
      contextBefore?: string;
      contextAfter?: string;
      occurrence?: number;
      /** Replace EVERY occurrence in one transaction. See prose.findAndReplace. */
      replaceAll?: boolean;
      parseInlineMarks?: boolean;
    },
  ): prose.ReplaceResult {
    const doc = this.live(docId);
    if (!doc) return { ok: false, error: 'no-match' };
    return prose.findAndReplace(doc.ydoc, opts);
  }

  /**
   * Rewrite the range a text-range thread is anchored to. The thread
   * anchor is authoritative — we never recompute offsets on the
   * client. When the anchor is orphaned (user deleted the text) the
   * caller gets `anchor-orphaned` back and should either re-anchor or
   * fall back to `findAndReplace`.
   */
  rewriteThreadRegion(
    docId: string,
    threadId: string,
    replacement: string,
    opts?: { parseInlineMarks?: boolean },
  ): prose.AnchoredEditResult {
    const doc = this.live(docId);
    if (!doc) return { ok: false, error: 'anchor-not-found' };
    const thread = this.p.thread(docId, threadId);
    if (!thread) return { ok: false, error: 'anchor-not-found' };
    if (thread.anchor.kind !== 'text-range') return { ok: false, error: 'anchor-orphaned' };
    return prose.rewriteRange(doc.ydoc, {
      startRel: thread.anchor.startRel,
      endRel: thread.anchor.endRel,
      replacement,
      parseInlineMarks: opts?.parseInlineMarks === true,
    });
  }

  /**
   * Agent anchors — the agent can mint its own named pointers into the
   * doc for batch edits. Stored separately from comment threads.
   */
  createAgentAnchor(
    docId: string,
    opts: {
      find: string;
      contextBefore?: string;
      contextAfter?: string;
      occurrence?: number;
      label?: string;
    },
  ): prose.CreateAnchorResult {
    const doc = this.live(docId);
    if (!doc) return { ok: false, error: 'no-match' };
    return prose.createAgentAnchor(doc.ydoc, opts);
  }

  editAtAgentAnchor(
    docId: string,
    anchorId: string,
    op: { kind: 'replace'; text: string } | { kind: 'insert_after'; text: string },
  ): prose.AnchoredEditResult {
    const doc = this.live(docId);
    if (!doc) return { ok: false, error: 'anchor-not-found' };
    const anchor = prose.readAgentAnchor(doc.ydoc, anchorId);
    if (!anchor) return { ok: false, error: 'anchor-not-found' };
    if (op.kind === 'replace') {
      return prose.rewriteRange(doc.ydoc, {
        startRel: anchor.startRel,
        endRel: anchor.endRel,
        replacement: op.text,
      });
    }
    return prose.insertAfterRange(doc.ydoc, { endRel: anchor.endRel, text: op.text });
  }

  deleteAgentAnchor(docId: string, anchorId: string): boolean {
    const doc = this.live(docId);
    if (!doc) return false;
    return prose.deleteAgentAnchor(doc.ydoc, anchorId);
  }

  /**
   * Parse markdown into block elements and insert them as siblings
   * immediately after the block that contains the agent anchor.
   * Use this for adding new headings / paragraphs / lists / tables —
   * `edit_at_anchor` with `insert_after` does a character-stream
   * insert which keeps the new text inside the anchor's block,
   * producing literal `## Heading` text instead of a heading element.
   */
  insertBlocksAtAnchor(
    docId: string,
    anchorId: string,
    markdown: string,
    opts?: { placement?: prose.BlockPlacement },
  ): prose.AnchoredEditResult {
    const doc = this.live(docId);
    if (!doc) return { ok: false, error: 'anchor-not-found' };
    const anchor = prose.readAgentAnchor(doc.ydoc, anchorId);
    if (!anchor) return { ok: false, error: 'anchor-not-found' };
    return prose.insertBlocksAfterAnchor(doc.ydoc, {
      anchorRel: anchor.endRel,
      markdown,
      placement: opts?.placement,
      parse: { mdx: prose.isMdxPath(doc.meta.sourceUrl) },
    });
  }

  /** Append text at the END position of a thread's anchored range. */
  insertAfterThread(docId: string, threadId: string, text: string): prose.AnchoredEditResult {
    const doc = this.live(docId);
    if (!doc) return { ok: false, error: 'anchor-not-found' };
    const thread = this.p.thread(docId, threadId);
    if (!thread) return { ok: false, error: 'anchor-not-found' };
    if (thread.anchor.kind !== 'text-range') return { ok: false, error: 'anchor-orphaned' };
    return prose.insertAfterRange(doc.ydoc, { endRel: thread.anchor.endRel, text });
  }

  /**
   * Parse markdown into block elements and insert them immediately
   * after the block that contains the thread's anchor. Use this for
   * "add a section below this comment" — the anchor picks the
   * location, the markdown describes the new blocks.
   */
  insertBlocksAfterThread(
    docId: string,
    threadId: string,
    markdown: string,
    opts?: { placement?: prose.BlockPlacement },
  ): prose.AnchoredEditResult {
    const doc = this.live(docId);
    if (!doc) return { ok: false, error: 'anchor-not-found' };
    const thread = this.p.thread(docId, threadId);
    if (!thread) return { ok: false, error: 'anchor-not-found' };
    if (thread.anchor.kind !== 'text-range') return { ok: false, error: 'anchor-orphaned' };
    return prose.insertBlocksAfterAnchor(doc.ydoc, {
      anchorRel: thread.anchor.endRel,
      markdown,
      placement: opts?.placement,
      parse: { mdx: prose.isMdxPath(doc.meta.sourceUrl) },
    });
  }

  /**
   * Delete the single block containing a thread's anchored range. Use
   * for "remove the paragraph this comment points at." Empty-string
   * find_and_replace cannot do this — it removes text but leaves the
   * empty block element behind.
   */
  deleteBlockAtThread(docId: string, threadId: string): prose.DeleteBlockResult {
    const doc = this.live(docId);
    if (!doc) return { ok: false, error: 'anchor-orphaned' };
    const thread = this.p.thread(docId, threadId);
    if (!thread) return { ok: false, error: 'anchor-orphaned' };
    if (thread.anchor.kind !== 'text-range') return { ok: false, error: 'anchor-orphaned' };
    return prose.deleteBlockAtAnchor(doc.ydoc, { anchorRel: thread.anchor.startRel });
  }

  /** Same, keyed on an agent anchor. */
  deleteBlockAtAgentAnchor(docId: string, anchorId: string): prose.DeleteBlockResult {
    const doc = this.live(docId);
    if (!doc) return { ok: false, error: 'anchor-orphaned' };
    const anchor = prose.readAgentAnchor(doc.ydoc, anchorId);
    if (!anchor) return { ok: false, error: 'anchor-orphaned' };
    return prose.deleteBlockAtAnchor(doc.ydoc, { anchorRel: anchor.startRel });
  }

  /** Delete every top-level block from start match through end match.
   *  Block-inclusive — partial match still deletes the whole block. */
  deleteBlocksInRange(
    docId: string,
    opts: {
      startFind: string;
      endFind: string;
      contextBefore?: string;
      contextAfter?: string;
      startOccurrence?: number;
      endOccurrence?: number;
    },
  ): prose.DeleteBlocksInRangeResult {
    const doc = this.live(docId);
    if (!doc) return { ok: false, error: 'no-match' };
    return prose.deleteBlocksInRange(doc.ydoc, opts);
  }

  /** Delete a heading block + everything until the next heading at ≤ level. */
  deleteSection(
    docId: string,
    opts: { heading: string; level?: number; occurrence?: number },
  ): prose.DeleteSectionResult {
    const doc = this.live(docId);
    if (!doc) return { ok: false, error: 'no-match' };
    return prose.deleteSection(doc.ydoc, opts);
  }

  /**
   * The doc's addressable blocks, each with the id an edit comes back with.
   * `null` for a doc that does not exist; an empty outline for one that has
   * no prose. Lives in `doc-outline-ops.ts` — see that file's header.
   */
  readOutline(docId: string, opts: prose.OutlineOptions = {}): DocOutline | null {
    const doc = this.live(docId);
    if (!doc) return null;
    return readDocOutline(doc, opts);
  }

  /** Apply a batch of block-addressed edits in one transaction. */
  applyBlockEdits(
    docId: string,
    edits: prose.BlockEdit[],
    who: BlockEditsAuthor,
  ): BlockEditsResult {
    const doc = this.live(docId);
    if (!doc) return { ok: false, error: 'not-found' };
    return applyDocBlockEdits(doc, edits, who);
  }

  /**
   * Sweep every text-range thread in a doc and best-effort re-anchor
   * the ones whose Y.RelativePosition no longer resolves. Idempotent —
   * safe to call on every significant doc change.
   */
  autoReanchor(docId: string): { checked: number; reanchored: number; stillOrphan: number } | null {
    const doc = this.live(docId);
    if (!doc) return null;
    return prose.autoReanchorDoc(doc.ydoc);
  }
}
