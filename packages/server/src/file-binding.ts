/**
 * The file bindings: everything that keeps a live doc and a file on disk
 * saying the same thing. `attachFile` and its flat-text twins, the shared
 * mtime poll, the debounced write-back and the conflict reconcile that
 * arbitrates when both sides moved — plus the doc-origin-repo pin, which is only
 * ever a rule about which file a binding may write.
 *
 * It reaches the doc lifecycle through `FileBindingHost` rather than
 * holding a `DocStore`. The seam is that shape because the bindings touch a
 * doc on every path — its ydoc, its persist debounce, its event fan-out —
 * so a line-range extraction would have had to copy those, and a copy of a
 * persist timer is a second timer. Every entry below is a THUNK onto the
 * live thing: `doc` is the doc map, `schedulePersist` is the 200ms
 * `.ydoc` debounce, `noteTouched` writes the one residency clock the
 * eviction policy also reads. Nothing here owns state the lifecycle owns,
 * and nothing there owns the bindings' own timers.
 *
 * Timings, ordering and log lines are unchanged from when this lived in
 * `doc-store.ts`: the write-back debounce, the read settle, the reconcile's
 * decision order and its backup-before-reassert rule are the contract the
 * bound-doc sync behaviour rests on, and this file moved them without
 * touching them.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type DocMeta,
  type DocOriginRepo,
  type WebhookPayload,
  contentKind,
  prose,
  suggestOps,
} from '@claude-workspaces/core';
import * as Y from 'yjs';
import { isBoardOwnedDoc } from './doc-ids.ts';
import {
  canonicalRepoRoot,
  normalizeDocOriginRepo,
  resolveOriginRepoCheckout,
  verifyPathInOriginRepo,
} from './doc-origin-repo.ts';
import { DOC_STORE_TIMINGS } from './doc-store-timings.ts';
import type { LiveDoc } from './doc-store.ts';
import { statStampSync } from './file-stamp.ts';
import { showFile } from './git-diff.ts';
import { gitConflictHint } from './git-provenance.ts';
import { isWithinRoot } from './safe-path.ts';
import { boundFiles, isDataless, redactBoundPath } from './slow-fs.ts';

/**
 * Per-doc binding to a markdown file on disk. Maintained by
 * `attachFile` — every prose change debounces a write of the
 * serialized fragment back to the file. First attach seeds from disk
 * if the fragment is empty.
 */
/**
 * What a caller can tell an attach that the files cannot.
 *
 * `liveWins`: the live doc holds content the file does not — an un-flushed
 * write-back the index row recorded at shutdown, or the very edit that
 * triggered this attach — so the at-rest arbitration reasserts the doc
 * (disk version backed up) instead of asking the clock. Without it a fresh
 * attach with no bookkeeping compares the file's mtime against the persisted
 * `.ydoc`'s, and EQUAL goes to disk. The two are routinely written inside one
 * file-timestamp tick (~4ms on a stock Linux kernel): an evict-flush right after
 * the bind, a `git worktree add` a few ms before the rebind's persist. Both
 * reverted a live edit with the file's stale copy — the doc-origin-repo-binding and
 * doc-eviction reds of 2026-08-31/09-01 — and read as a bare timeout.
 */
/**
 * A bound file's bytes, already read by somebody else.
 *
 * Hydration reads the file through `boundFiles` (off the main thread, under a
 * deadline) and hands the result down, so the attach itself performs no
 * blocking syscall on the path. `exists: false` covers both "not there" and
 * "would not answer" — the attach treats them the same way it has always
 * treated a missing file, which is why there is no third state here.
 */
export interface PrereadFile {
  exists: boolean;
  text?: string;
  mtimeMs?: number;
  size?: number;
}

export interface AttachOpts {
  liveWins?: boolean;
  /** Bytes read ahead of the attach; see `PrereadFile`. */
  preread?: PrereadFile;
}

interface FileBinding {
  path: string;
  writeTimer?: ReturnType<typeof setTimeout> | null;
  readTimer?: ReturnType<typeof setTimeout> | null;
  /**
   * Whether this binding takes part in the shared mtime sweep (see
   * `armFileWatcher`). There is no per-binding interval any more: 4,228 of
   * them were the 2026-08-29 timer storm. The sweep stats every ARMED
   * binding whose doc is active, plus a rotating slice of the idle ones.
   */
  pollArmed?: boolean;
  /** A poll stat is on the thread pool right now — see `pollBinding`. */
  statInFlight?: boolean;
  /** A write-back is on the thread pool right now — see `writeBoundFileNow`. */
  writeInFlight?: boolean;
  /**
   * Which write is the current one. Bumped by every write that starts; a
   * pool write compares it on landing and records nothing if it lost — see
   * `writeBoundFileNow`.
   */
  writeSeq?: number;
  /**
   * Last file mtime (ms) we have actually READ, so the poll reacts only to
   * changes. Advanced when the reconcile's read lands, never when the stat
   * that spotted the change lands — see `applyPolledMtime`.
   */
  lastMtimeMs?: number;
  /**
   * The size that came back with `lastMtimeMs`, and the second half of the
   * poll's change test.
   *
   * mtime ALONE is not enough. A write that lands inside the granule of the
   * stamp we recorded leaves the mtime it found, so `mtimeMs ===
   * lastMtimeMs` and the poll concludes nothing happened — permanently,
   * because that mtime never moves again. The edit is invisible to every
   * reader of the doc and nothing is logged.
   *
   * Two things make that granule small. Size is one: almost every real edit
   * changes the byte count. The mtime's own precision is the other, and it is
   * read in NANOSECONDS (`file-stamp.ts`) rather than whole milliseconds,
   * which is what shrank the window from a millisecond to the filesystem's
   * own resolution. What is left uncovered is a same-length write that the
   * filesystem could not separate either — a volume with a coarse timestamp,
   * or a write that restores the previous mtime deliberately. Content-hashing
   * every tick would close that and is exactly the per-tick read the mtime
   * poll exists to avoid.
   */
  lastSize?: number;
  /**
   * Set when the attach could not read its file because the file is not on
   * disk — a cloud-sync file left online-only, which `open` refuses with
   * EDEADLK (`isDataless`). The doc came up on its `.ydoc` content without the
   * attach-time reconcile, so two things hold until a read lands:
   *
   *   - The poll retries the read on EVERY visit, not only on a stat change.
   *     Downloading a file moves neither its mtime nor its size, so a poll
   *     that waited for one would never read it, and whatever it holds — an
   *     edit made on another machine, or the write the server owed it — would
   *     never meet the doc.
   *   - The write-back holds. Writing now would put the `.ydoc` over bytes
   *     nobody has read, which is the one outcome the hydrate guard parks docs
   *     to avoid. The held write is marked failed, so a restart still owes it.
   *
   * The first read that lands re-runs the attach with those bytes
   * (`retryUnreadAttach`). `liveWins` is the verdict the attach reached
   * without them — the caller's claim, else the mtime comparison, which a
   * `stat` can still make on a file that will not open. It is decided THEN
   * because it cannot be decided later: any `.ydoc` save in between (a comment
   * is enough) moves the doc's stamp past the file's, and the edit that was
   * newer at boot would lose to a doc that never saw it.
   */
  unreadAtAttach?: { liveWins: boolean };
  /** An mtime spotted by the stat whose reconcile read has not landed yet. */
  pendingMtimeMs?: number;
  /** The size spotted alongside `pendingMtimeMs`. */
  pendingSize?: number;
  /** The serialized markdown we last wrote or last read from disk.
   *  Both directions guard against this to break echo loops. */
  lastWritten?: string;
  /** The file's own bytes as we last read or wrote them — not serializer
   *  space. The write-back reuses them for every block an edit did not touch
   *  (`prose.serializeKeepingSourceLayout`), so a one-paragraph edit rewrites
   *  one paragraph. A read stores the text; a write stores the layout of what
   *  it wrote, so the next flush does not parse the file again. Only ever a
   *  formatting hint: a stale value costs fidelity, never content. */
  diskSource?: string | prose.SourceLayout;
  /** Set when the most recent disk→doc reconcile failed (parse threw or
   *  produced zero blocks) or hit a conflict. Cleared on the next successful
   *  reconcile. Surfaced via getDoc AND on edit-tool responses so a wedged
   *  doc reports WHY it's stale instead of silently serving pre-edit
   *  content. */
  lastSyncError?: { message: string; at: number };
  /** The observeDeep callback wired by attachFile. Kept so a re-attach can
   *  unobserve it — without this, every re-attach (hydrate, re-run
   *  attach_markdown) stacked another write-back scheduler holding stale
   *  binding state. */
  observer?: Parameters<Y.XmlFragment['observeDeep']>[0];
  /** True when this flat binding writes doc edits back to the file (the
   *  editable File view). Absent/false = classic read-only code binding. */
  writeBack?: boolean;
  /**
   * Doc→disk is OFF for this binding, and the sentence saying why.
   *
   * One writer per path. Two doc-sets can end up bound to the same file — a
   * refreshed diff review over a repo another, older review still covers —
   * and the older one keeps a live binding long after its set stops
   * answering the API. Waking it (a threads read is enough) then flushed a
   * weeks-old `.ydoc` over the file the newer set is showing, which is the
   * 2026-09-16 incident. The NEWER doc keeps the write-back; the older one
   * is suspended here: its content still serves from the `.ydoc`, it still
   * reads disk→doc, and it writes nothing.
   */
  writeBackSuspended?: string;
  /**
   * True when this binding watches a MOCKUP's source HTML.
   *
   * A mockup's doc holds no content surface (`contentKind` is `none`) — its
   * surface is the host page — so this binding never touches the ydoc's text
   * and never writes back. It exists for the disk→doc direction only: the
   * shared mtime sweep spots the edit, the reconcile hands the bytes to
   * `onMockupChanged`, and the page a reviewer already has open becomes the
   * new round. Nothing else about the sweep changes, which is the point —
   * a second watcher for mockups would be a second timer, a second set of
   * inode-replacement bugs, and a second thing to get the quarantine wrong.
   */
  mockup?: boolean;
  /** The content-Y.Text observer wired by attachFlatFile({writeBack:true}).
   *  Kept so a re-attach can unobserve it (same stacking hazard as
   *  `observer` above). */
  contentObserver?: (event: Y.YTextEvent, tr: Y.Transaction) => void;
}

/**
 * Does this binding ever write doc→disk?
 *
 * Only a writer can hold a path against another writer. A read-only code
 * member (`attachFlatFile` without `writeBack`) and a mockup's source watcher
 * are disk→doc only, so counting them as owners would suspend the one
 * binding that actually edits the file, chosen by nothing more than which
 * hydrated first.
 */
interface PathClaim {
  /** Set when a NEWER binding already owns the path: this doc must not write. */
  refusal?: string;
  /** Set when a loser we just suspended had a write already at the pool. */
  contested?: boolean;
}

function bindingWrites(binding: FileBinding): boolean {
  if (binding.mockup === true) return false;
  return binding.observer !== undefined || binding.writeBack === true;
}

/**
 * Decide what a disk→doc reconcile should do, given the file's current
 * content (`disk`), the markdown we last wrote/read (`lastWritten`), and the
 * live doc's current serialization (`currentSerialized`).
 *
 *   - `in-sync`   disk is byte-identical to our last write → nothing to do.
 *   - `catch-up`  disk differs from lastWritten but already equals the live
 *                 doc → just advance bookkeeping, don't touch the fragment.
 *   - `apply`     disk changed externally and the live doc is clean (still
 *                 equals lastWritten) → safe to pull disk into the doc.
 *   - `conflict`  disk changed externally AND the live doc has its own
 *                 un-flushed edits (diverged from lastWritten) → a blind
 *                 replace would clobber the human's in-progress work. The
 *                 caller keeps the live edits (the editor is the runtime
 *                 source of truth) and reasserts them to disk.
 *
 * Pure + exported so the policy is unit-tested without timing races.
 */
export function decideReconcile(args: {
  disk: string;
  lastWritten: string | undefined;
  currentSerialized: string;
}): 'in-sync' | 'catch-up' | 'apply' | 'conflict' {
  const { disk, lastWritten, currentSerialized } = args;
  if (disk === lastWritten) return 'in-sync';
  if (disk === currentSerialized) return 'catch-up';
  // disk diverges from BOTH our last write and the live doc.
  if (currentSerialized !== lastWritten) return 'conflict';
  return 'apply';
}

/**
 * What an incoming copy of the file does to the doc's blocks: how many it
 * takes away, how many it brings, and the NET loss.
 *
 * Three numbers, because two different decisions ride on this and they do not
 * share a trigger. Measured over a seven-block doc with three headings:
 *
 * | the file came back with…      | removed | added | net | headings gone |
 * | ----------------------------- | ------- | ----- | --- | ------------- |
 * | one paragraph reworded        |       1 |     1 |   0 |             0 |
 * | three paragraphs reworded     |       3 |     3 |   0 |             0 |
 * | the notes section DELETED     |       3 |     0 |   3 |             1 |
 * | the notes section SWAPPED     |       3 |     3 |   0 |             1 |
 * | every block reworded          |       7 |     7 |   0 |             3 |
 *
 * `net` is the honest signal for "the file got shorter", and it is zero for an
 * ordinary reword — which is why it and not `removed` decides whether to raise
 * a `syncError`, a thing a person is asked to act on and which would be a
 * regression in noise if it fired on every external save.
 *
 * `removed` alone cannot decide the other question. Read down that column and
 * the shapes cross: an ordinary three-paragraph reword removes as many blocks
 * as a whole section being swapped out, so no threshold on it separates the
 * loss this module exists to catch from a person editing prose.
 *
 * `removedHeadings` does separate them, which is why it is here. A section
 * leaving takes its heading with it whether or not anything arrives in its
 * place, and rewording paragraphs under a heading does not touch the heading.
 * It is the SWAPPED row — same size in, same size out, `net` zero, the loudest
 * possible loss — that a net-only rule would have missed entirely.
 *
 * The last row is a false positive and is meant to be: a revision that renamed
 * every heading rewrote the whole document, and that is exactly when keeping
 * the doc's own copy is worth one small file. What escapes both triggers is a
 * same-size paragraph swapped under an untouched heading — which is bytes for
 * bytes what an ordinary reword is, so nothing on the file could tell them
 * apart.
 *
 * The comparison is deliberately blind to WHO shortened the file. A person
 * deleting a section in their editor and a cloud-sync provider handing back
 * the revision it held before the meeting produce the same bytes, and the
 * server cannot tell them apart — nothing on the file says which. So this
 * does not decide a winner (disk still wins at rest, as the sync contract
 * says); it decides whether the doc's own copy is worth keeping before it
 * goes.
 *
 * Multiset, not set: a doc holding the same bullet twice that comes back
 * holding it once has lost one, and a `Set` would say it lost nothing.
 *
 * Pure + exported so the rule is unit-tested without a filesystem, the same
 * way `decideReconcile` is.
 */
export interface BlockDelta {
  /** Live blocks whose markdown the incoming copy does not hold. */
  removed: number;
  /** Incoming blocks the live doc did not hold. */
  added: number;
  /** `removed - added`, floored at zero: the file is this many blocks shorter
   *  in content it and the doc do not share. */
  net: number;
  /** How many of the removed blocks were HEADINGS — a section that left. */
  removedHeadings: number;
}

/**
 * A serialized block that is a heading.
 *
 * Reading the markdown rather than the node because `blockDelta` is pure over
 * strings, and the serializer makes this unambiguous: a heading is the only
 * block it ever emits starting `#`. A fenced block is wrapped in backticks
 * before its first line is reached, a list in `-` or a number, a blockquote in
 * `>`, and a paragraph whose text began `# ` would have parsed as a heading.
 */
const HEADING_MD = /^#{1,6}\s/;

/**
 * Whether the doc's own copy is worth keeping before an incoming file wins.
 *
 * A section left (its heading went with it), or the file simply came back
 * shorter. Both triggers, one predicate, so the force-pull path and the poll
 * path cannot drift apart on what counts as worth keeping.
 */
function worthKeeping(delta: BlockDelta): boolean {
  return delta.removedHeadings > 0 || delta.net > 0;
}

export function blockDelta(live: readonly string[], incoming: readonly string[]): BlockDelta {
  const spare = new Map<string, number>();
  for (const block of incoming) spare.set(block, (spare.get(block) ?? 0) + 1);
  let removed = 0;
  let removedHeadings = 0;
  for (const block of live) {
    const left = spare.get(block) ?? 0;
    if (left === 0) {
      removed++;
      if (HEADING_MD.test(block)) removedHeadings++;
    } else spare.set(block, left - 1);
  }
  let added = 0;
  for (const left of spare.values()) added += left;
  return { removed, added, net: Math.max(0, removed - added), removedHeadings };
}

/**
 * One block's markdown each, for the comparison above.
 *
 * A block that will not serialize gets a value nothing else can equal, so it
 * counts as removed rather than as matched — this decides whether to keep a
 * BACKUP, and an unreadable block is exactly the one worth erring towards
 * keeping.
 */
function blockTexts(blocks: readonly Y.XmlElement[]): string[] {
  return blocks.map((block, i) => {
    try {
      return prose.serializeBlockToMarkdown(block);
    } catch {
      // Unique per block and unreachable by any serializer, so an
      // unreadable block matches nothing — not even another one.
      return `\u0000unreadable-${i}`;
    }
  });
}

/**
 * The same, for blocks straight out of `parseMarkdownBlocks`.
 *
 * They belong to no document yet, and reading a Yjs type before it is in one
 * is an error — every block would have come back "unreadable" and the count
 * would have been the doc's own block count, which is right only by accident.
 * A scratch `Y.Doc` is the cheapest place to put them; the caller has already
 * paid for the parse and uses these blocks for nothing else.
 */
function incomingBlockTexts(blocks: Y.XmlElement[]): string[] {
  const scratch = new Y.Doc();
  const fragment = prose.getProseFragment(scratch);
  fragment.push(blocks);
  return blockTexts(fragment.toArray() as Y.XmlElement[]);
}

/**
 * The one log line for an attach whose file is not on disk (`isDataless`):
 * the doc, the errno and what happens next. No stack, because nothing here is
 * a fault to debug, and no path, because a path under a cloud-sync folder can
 * name a private project.
 */
function notDownloadedLine(docId: string, err: unknown, outcome: string): string {
  const code = (err as NodeJS.ErrnoException).code ?? 'EDEADLK';
  return `[doc-store] ${docId}: bound file is not downloaded (${code}); ${outcome}`;
}

/** How a bound file parses: an `.mdx` path holds its components as blocks. */
function parseOptsFor(path: string): prose.MarkdownParseOptions {
  return { mdx: prose.isMdxPath(path) };
}

/** Yjs origin for the private-meta guard's own deletes, so it never

/**
 * How long a `liveWins` write-back claim stays believable (24h).
 *
 * See `fileOutlivedClaim`. A write owed at shutdown is carried out by the
 * next boot; a claim still outstanding a day after the file moved on belongs
 * to a doc-set nobody runs any more, and carrying it out is the 2026-09-16
 * clobber. Generous on purpose — a weekend of downtime is not staleness, and
 * the cost of believing a claim one hour too long is nil while the cost of
 * refusing a real one is a lost edit.
 */
const STALE_CLAIM_AFTER_MS = 24 * 60 * 60 * 1000;

/** How often the shared mtime sweep runs — the cadence the old per-binding
 *  interval ran at, kept so external-edit latency is unchanged for a doc
 *  anyone is actually looking at. */
const FILE_POLL_MS = DOC_STORE_TIMINGS.filePollMs;

/** Settle time before a changed file is read, so no half-written save is parsed. */
const READ_DEBOUNCE_MS = DOC_STORE_TIMINGS.readDebounceMs;

/** Doc → disk: how long a prose change waits before the serialize+write. */
const WRITE_BACK_MS = DOC_STORE_TIMINGS.writeBackMs;

/** How long after an access a bound doc counts as ACTIVE — stat'd on every
 *  tick. Long enough that a person reading, thinking and typing never falls
 *  out of it; short enough that a doc touched once by a bulk operation goes
 *  quiet again. */
const FILE_POLL_ACTIVE_MS = 60_000;

/**
 * How many IDLE bindings the sweep may stat per tick.
 *
 * This is the cap that turns an unbounded per-doc cost into a constant one.
 * Idle bindings are visited round-robin, so the syscall rate is
 * `IDLE_SWEEP_BUDGET / FILE_POLL_MS` (256/s) no matter how many bound docs
 * exist — what grows with the corpus is how long an UNWATCHED external edit
 * waits to be noticed, not how hard the server works. Below the budget
 * (every dev machine, every test) each idle binding is still visited on every
 * tick, so the old 500ms guarantee is unchanged there.
 */
const IDLE_SWEEP_BUDGET = 128;

/**
 * How many copies of ONE doc's own content to keep in `clobber-backups/`.
 *
 * Generous on purpose: the file this exists to preserve is the one a person
 * comes looking for days later, and rotating it out to save a few kilobytes
 * would be the loss this whole change is about. It is a ceiling against a
 * pathological binding, not a tidy-up — an ordinary doc never reaches it,
 * because the same content is never kept twice in a row.
 */
const LIVE_BACKUP_CAP = 20;

/**
 * How many distinct activation tags to keep. Everything past the cap folds
 * into `other`, so a pathological caller cannot grow this map without bound.
 */
const ACTIVATION_TAG_CAP = 32;
/** How many to report. The question is "who is doing this", not a census. */
const ACTIVATION_TAGS_REPORTED = 8;

/**
 * Where the current `touchDoc` came from, as `packages/<path>:<line>`.
 *
 * Only ever called when a binding goes idle -> active, which in a healthy
 * server is rare and in the case this exists to catch is exactly the thing
 * worth paying for. Frames inside `doc-store.ts` AND this file are skipped —
 * every touch passes through `get` / `getOrCreate` and then through
 * `FileBindings.touchDoc`, so the useful frame is the first one outside both.
 * Missing the second name would have made every activation read as
 * `file-binding.ts`, which names the mechanism instead of the caller.
 *
 * Deliberately relative to `packages/`: the absolute path is a host-machine
 * fact and this string is served by `GET /api/metrics`.
 */
function activationTag(): string {
  const stack = new Error().stack;
  if (!stack) return 'unknown';
  for (const line of stack.split('\n').slice(1)) {
    const m = line.match(/[/\\]packages[/\\]([^\s)]+?):(\d+):\d+/);
    if (!m) continue;
    const where = m[1].replace(/\\/g, '/');
    if (where.endsWith('/doc-store.ts') || where.endsWith('/file-binding.ts')) continue;
    return `packages/${where}:${m[2]}`;
  }
  return 'external';
}

/**
 * What the bindings need from the doc lifecycle, and nothing more.
 *
 * Every member is a function onto the live thing rather than a copy of it:
 * the doc map, the `.ydoc` persist debounce, the residency clock, the
 * doc's event fan-out. That is the whole reason this interface exists —
 * the bindings mutate a doc's ydoc and re-arm its persist timer on almost
 * every path, so handing them a snapshot of a doc would give two owners to
 * one timer.
 */
export interface FileBindingHost {
  /** Where the corpus lives: `.ydoc` files, index rows, clobber backups. */
  dataDir(): string;
  /** Resolve an id (which may be an alias) to its doc, hydrating if needed. */
  doc(docId: string): LiveDoc | undefined;
  /** Only what is already in memory — no hydrate, no access stamp. */
  residentDoc(docId: string): LiveDoc | undefined;
  /** The doc's persisted `.ydoc` path, whose mtime the at-rest arbitration reads. */
  ydocPath(docId: string): string;
  /** Arm the debounced `.ydoc` persist (and the sidecar and index row with it). */
  schedulePersist(doc: LiveDoc): void;
  /** Persist the `.ydoc` now, synchronously. */
  persistNow(doc: LiveDoc): void;
  /** Drop `pendingFileWrite` from the doc's index row — the row belongs to
   *  the lifecycle, the flag's meaning belongs here. */
  clearPendingFileWrite(docId: string): void;
  /** The residency clock. One clock for the whole policy, so "recently
   *  touched" cannot mean two things a few lines apart. */
  now(): number;
  /** Read and write the access stamp the poll's fast lane and the eviction
   *  window share. */
  lastTouchedAt(docId: string): number | undefined;
  noteTouched(docId: string, at: number): void;
  /** Fan an event out to the doc's sockets, SSE and webhooks. */
  broadcast(doc: LiveDoc, payload: WebhookPayload): void;
  /**
   * A watched mockup's source file changed; `html` is what it now holds.
   *
   * The bindings do not know what a capture or a round is — that is the doc
   * store's business, next to the data dir it owns — so the reconcile stops
   * at "these are the new bytes" and this thunk decides what to keep and who
   * to tell.
   */
  onMockupChanged(doc: LiveDoc, html: string): void;
  /** Fill in `reviewUrl` and friends; the URL machinery stays in the server layer. */
  decorate(meta: DocMeta): DocMeta;
}

/**
 * One server's file bindings. Constructed by `DocStore`, which keeps the
 * lifecycle and the websocket fan-out and calls in here for everything that
 * touches a file.
 */
export class FileBindings {
  private bindings = new Map<string, FileBinding>();
  /**
   * Rate-limits the re-place probe for a home-pinned doc that has NO binding
   * (`maybeRebindHome`) — the probe is cheap, but not per-keystroke.
   */
  private homeRebindAttemptAt = new Map<string, number>();
  private pollTicker: ReturnType<typeof setInterval> | null = null;
  /** Where the idle rotation of the shared sweep left off. */
  private idleCursor = 0;
  /** Idle → active transitions since boot, by the caller that caused them. */
  private activations = new Map<string, number>();
  /**
   * Docs whose last write-back THREW. `writeBoundFileNow` swallows its own
   * errors, so nothing downstream could otherwise tell a failed write from a
   * finished one — and the doc index row is what tells the next boot to come
   * back for it.
   */
  private failedWrites = new Set<string>();

  /** When we last wrote each doc's bound file ourselves, in epoch ms. Read
   *  by the live-copy rule; see the write-back that sets it. */
  private readonly writeBackAt = new Map<string, number>();

  /** The doc content most recently snapshotted into `clobber-backups/` for
   *  each doc, so a reconcile that removes the same block twice keeps one
   *  file rather than two. See `keepLiveCopy`.
   *
   *  A whole serialized doc per entry, so `discard` drops it with the
   *  binding — otherwise a long-running server holds a copy of every doc it
   *  ever backed up, and a doc rebound under the same id would have its first
   *  real backup suppressed by a match against content nothing keeps. */
  private readonly lastLiveBackup = new Map<string, string>();

  /** When we last wrote this doc's file ourselves, if we ever have. */
  lastWriteBackAt(docId: string): number | undefined {
    return this.writeBackAt.get(docId);
  }

  constructor(private readonly p: FileBindingHost) {}

  /**
   * Bind a doc to a file path on disk. After attach:
   *   - if the doc's prose fragment is empty AND the file exists with
   *     content, the file is parsed and seeded into the fragment
   *   - every subsequent prose change debounces a write of the
   *     serialized markdown back to the file (default 800ms)
   *
   * File path is resolved relative to the server's process cwd if
   * relative. An absolute path is strongly recommended.
   *
   * Bidirectional sync:
   *   doc → disk — every prose change debounces an 800ms serialize+write
   *   disk → doc — fs.watch fires on external edits, debounced 300ms,
   *     reads the file, diffs against current serialized output, and if
   *     different applies the new markdown in one 'file-watch' transact.
   *   Echo loop is broken by `binding.lastWritten` on both sides — a
   *   write we initiated won't be re-applied, and a read that matches
   *   our cached content is silently ignored.
   */
  /**
   * Bind a file, reading it on the thread pool first.
   *
   * This is the door every REQUEST and TIMER path uses. `attachFile` itself
   * stays synchronous because hydration needs it to be, and its no-preread
   * fallback still opens the file on the main thread — safe only where
   * nothing is waiting, which after this is boot and nothing else. Anything
   * with a caller on the other end comes through here instead, so the one
   * blocking syscall is already done and handed over as a preread.
   *
   * A file that cannot be read is not an error here: the attach is refused,
   * the doc keeps its `.ydoc` content, and the caller sees `read-failed`.
   *
   * `attachFlatFileAsync` and `attachReadonlyFileAsync` sit beside it now.
   * They deliberately did not, for as long as every flat (code / diff-member)
   * attach was reached from a synchronous caller: an async door with no
   * caller is worse than none, because it reads like coverage the flat path
   * does not have. The two callers that made the flat path blocking — the
   * bind loop in `bind-diff` and the member opens in `doc-store-workspaces` —
   * are async now and come through these, so the doors have callers and the
   * flat path has the guarantee the prose one already had.
   */
  async attachFileAsync(
    docId: string,
    filePath: string,
    opts: AttachOpts = {},
  ): Promise<ReturnType<FileBindings['attachFile']>> {
    const ready = await this.withPreread(filePath, opts);
    if (ready === 'unreadable') return { ok: false, error: 'read-failed' };
    return this.attachFile(docId, filePath, ready);
  }

  /**
   * `attachFlatFile` with the file read on the thread pool first.
   *
   * The flat twin of `attachFileAsync`, and it exists for the same reason:
   * the callers on the other side of it are a bind loop over every changed
   * file in a repository and a click in the all-files sidebar. Both hand it
   * whatever path the caller's tree holds, which is exactly the path a
   * cloud-sync provider can refuse to answer for.
   */
  async attachFlatFileAsync(
    docId: string,
    filePath: string,
    opts: AttachOpts & { writeBack?: boolean } = {},
  ): Promise<ReturnType<FileBindings['attachFlatFile']>> {
    const ready = await this.withPreread(filePath, opts);
    if (ready === 'unreadable') return { ok: false, error: 'read-failed' };
    return this.attachFlatFile(docId, filePath, ready);
  }

  /** `attachReadonlyFile` with the file read on the thread pool first. */
  async attachReadonlyFileAsync(
    docId: string,
    filePath: string,
    opts: AttachOpts = {},
  ): Promise<ReturnType<FileBindings['attachReadonlyFile']>> {
    const ready = await this.withPreread(filePath, opts);
    if (ready === 'unreadable') return { ok: false, error: 'read-failed' };
    return this.attachReadonlyFile(docId, filePath, ready);
  }

  /**
   * Fill in `opts.preread` from a pool read, unless the caller brought one.
   *
   * A read that fails or never answers returns `'unreadable'`, and the async
   * doors above refuse the attach on it. Falling through to the synchronous
   * read instead — which is what this did first — reopens the hazard the
   * whole change exists to close, and reopens it in its worst form: a file
   * that is present but unreadable (an un-materialized cloud file failing
   * with EDEADLK) is not quarantined, so the fallback read runs, and on the
   * prose path a throw inside the attach-time reconcile is logged and
   * swallowed. The doc binds with `.ydoc` content it never checked against
   * disk, and the next write-back overwrites the file. Refusing to bind is
   * what keeps the bytes on disk safe: the doc still comes back, from its
   * `.ydoc`, with writes parked.
   */
  private async withPreread<T extends AttachOpts>(
    filePath: string,
    opts: T,
  ): Promise<T | 'unreadable'> {
    if (opts.preread) return opts;
    if (!filePath || filePath.trim() === '') return opts;
    const abs = filePath.startsWith('/') ? filePath : join(process.cwd(), filePath);
    const res = await boundFiles.read(abs, { keep: false });
    if (res.status !== 'ok') return 'unreadable';
    return {
      ...opts,
      preread: res.exists
        ? { exists: true, text: res.text, mtimeMs: res.mtimeMs, size: res.size }
        : { exists: false },
    };
  }

  attachFile(
    docId: string,
    filePath: string,
    opts: AttachOpts = {},
  ): {
    ok: boolean;
    error?: 'not-found' | 'path-empty' | 'read-failed';
    seeded?: boolean;
    resolvedPath?: string;
  } {
    if (!filePath || filePath.trim() === '') return { ok: false, error: 'path-empty' };
    const doc = this.p.doc(docId);
    if (!doc) return { ok: false, error: 'not-found' };
    const abs = filePath.startsWith('/') ? filePath : join(process.cwd(), filePath);
    const fragment = prose.getProseFragment(doc.ydoc);
    // Either the caller already read the file for us (hydration does, off the
    // main thread) or we read it here. Both branches go through these two so
    // no path below can reach the filesystem behind the preread's back.
    const pre = opts.preread;
    // No preread means the sync fallback below, and that is only safe on a
    // path that has not already proved hostile. A quarantined one is refused
    // outright rather than opened: `attachFileAsync` is the door every
    // request and timer path comes through, and it always brings a preread.
    //
    // `busy` is the same refusal one level up. It means some bound path is
    // holding pool threads and has not been identified yet, so THIS path is
    // not known-good either — and a `busy` verdict leaves no quarantine mark
    // behind, which is how a hostile file used to reach the blocking read
    // below anyway. Refusing costs a parked doc; not refusing costs the
    // process.
    //
    // What still reaches the blocking read below, now that the bind flows and
    // the workspace member opens come through the async doors, is an
    // in-process caller holding a path it supplied itself and needing the
    // binding in the same turn. In production that is BOOT and nothing else:
    // hydration passes a preread on every other path (`DocStore.prereadFor`),
    // and no request handler reaches these two without one. The rest of the
    // callers are the tests.
    if (!pre && (boundFiles.quarantined(abs) || boundFiles.busy())) {
      return { ok: false, error: 'read-failed' };
    }
    const fileExists = () => (pre ? pre.exists : existsSync(abs));
    const readFile = () => (pre ? (pre.text ?? '') : readFileSync(abs, 'utf8'));
    let seeded = false;
    let seedText: string | undefined;
    if (fragment.length === 0 && fileExists()) {
      try {
        const md = readFile();
        seedText = md;
        const blocks = prose.parseMarkdownBlocks(md, parseOptsFor(abs));
        if (blocks.length > 0) {
          doc.ydoc.transact(() => fragment.push(blocks), 'file-seed');
          seeded = true;
        }
      } catch (err) {
        if (isDataless(err))
          console.warn(notDownloadedLine(docId, err, 'nothing to seed from, left unbound'));
        else console.error(`[doc-store] read failed for ${abs}:`, err);
        return { ok: false, error: 'read-failed' };
      }
    }
    const existing = this.bindings.get(docId);
    if (existing?.writeTimer) clearTimeout(existing.writeTimer);
    if (existing?.readTimer) clearTimeout(existing.readTimer);
    if (existing) existing.pollArmed = false;
    // A re-attach must replace the write-back observer, not stack another —
    // each leaked observer is a duplicate scheduler holding a stale binding.
    if (existing?.observer) fragment.unobserveDeep(existing.observer);
    const binding: FileBinding = {
      path: abs,
      lastMtimeMs: existing?.lastMtimeMs,
      lastSize: existing?.lastSize,
      diskSource: seedText,
    };
    this.bindings.set(docId, binding);
    // Before anything below can arm a flush: one writer per path.
    const claim = this.claimPathOwnership(docId, abs);
    if (claim.refusal) this.suspendWriteBack(docId, binding, claim.refusal);
    else if (claim.contested) this.reassertAfterContest(docId, binding);
    // A re-attach that MOVES this doc leaves its old path behind; whoever it
    // was suspending there is now free to write again.
    if (existing && existing.path !== abs) this.rearbitratePath(existing.path);
    // sourceUrl records the bound path. It stays OUT of the CRDT (an absolute
    // host path is exactly what a share visitor must not sync) — the sidecar
    // is its home, and saveToDisk is what persists it.
    if (!doc.meta.sourceUrl) {
      doc.meta.sourceUrl = abs;
      this.p.schedulePersist(doc);
    }

    // Attaching a NON-empty fragment (hydrate after a restart, or a re-run
    // attach_markdown): honor the sync contract's "the file is the source
    // of truth at rest". Without this, an edit made while the server was down
    // was never picked up — and the next flush overwrote it on disk.
    let unread = false;
    if (!seeded && fileExists()) {
      try {
        const md = readFile();
        binding.diskSource = md;
        // An `.mdx` doc read as paragraphs before its components were blocks.
        // Once a flush had joined a component onto one line on disk, doc and
        // file serialized alike and every branch below read them as in sync,
        // so re-type in the doc first. Same bytes, so no branch is changed.
        if (prose.isMdxPath(abs)) {
          doc.ydoc.transact(() => prose.retypeMdxParagraphs(fragment), 'file-watch');
        }
        const currentSerialized = prose.serializeFragmentToMarkdown(fragment);
        const prior = existing?.lastWritten;
        if (md !== currentSerialized) {
          // NB: this byte-equality guard rarely spares the parse below —
          // most real files differ from the serializer's normal form, so
          // hydrate pays one parse+serialize per bound doc (~1ms for a
          // typical doc). Accepted: the alternative was rewriting ~every
          // never-edited bound file on each restart.
          const diskNormalized = prose.normalizeMarkdown(md, parseOptsFor(abs));
          // Who is newer AT REST, asked once so the reassert branch and the
          // refusal below cannot reach two different answers.
          const diskNewer = this.diskNewerThanState(docId, abs, pre?.mtimeMs);
          // A `liveWins` claim that the CLOCK contradicts.
          //
          // `liveWins` means "the live doc holds content disk has never
          // held", and at boot it is read off the doc's index row — a row
          // that survives for as long as the `.ydoc` does. A doc-set that
          // went dormant mid-write keeps that claim for WEEKS, and the first
          // read that hydrates it would flush its weeks-old content over a
          // file a person has edited since (2026-09-16: three tracked files
          // in another repo rewritten from a 3-week-old doc).
          //
          // The claim cannot outrank a file that is demonstrably newer than
          // the `.ydoc` the content came from. Refuse the flush, say so on
          // the doc, drop the row's claim so the next hydrate does not
          // re-make it, and let disk win below — which snapshots the live
          // side into `clobber-backups/` first, so nothing is unrecoverable.
          if (
            prior === undefined &&
            opts.liveWins === true &&
            this.fileOutlivedClaim(docId, abs, pre?.mtimeMs)
          ) {
            const message =
              'the bound file on disk is newer than this doc’s last saved state, so the ' +
              'held write-back was refused and the file was read in instead; the version this ' +
              'doc held is in clobber-backups/';
            console.warn(`[doc-store] ${docId}: ${message} (${redactBoundPath(abs)})`);
            binding.lastSyncError = { message, at: Date.now() };
            this.p.clearPendingFileWrite(docId);
          }
          if (diskNormalized === currentSerialized) {
            // Pure normalization drift: disk parses to exactly the live
            // doc's content, the bytes just differ in formatting the
            // round-trip doesn't preserve. This is the steady state for
            // every bound-but-never-edited doc (binding stamps the .ydoc
            // after the .md, so mtime arbitration below would call the
            // live side newer and rewrite the file). Semantically equal
            // means in-sync — leave the file untouched.
            binding.lastWritten = currentSerialized;
          } else if (prose.isMdxPath(abs) && prose.normalizeMarkdown(md) === currentSerialized) {
            // An `.mdx` doc last parsed before its components were blocks:
            // disk and doc agree under the old grammar. Re-read the doc
            // under the new one and write nothing — the file is already
            // right, and a write at boot would be a rewrite nobody asked for.
            doc.ydoc.transact(() => {
              prose.applyMarkdownToFragment(fragment, md, parseOptsFor(abs));
            }, 'file-watch');
            binding.lastWritten = prose.serializeFragmentToMarkdown(fragment);
          } else if (prior !== undefined && currentSerialized !== prior) {
            // The live doc has un-flushed edits relative to our last write —
            // we are NOT at rest, so don't pick a winner here. Keep the old
            // bookkeeping; if disk also moved, the poll's reconcile will
            // treat it as a conflict (backup + reassert). If disk did not
            // move, re-arm the flush this re-attach just cancelled. (The
            // conflict case reconciles NOW — armFileWatcher re-baselines the
            // mtime below, so the poll would never see the change.)
            binding.lastWritten = prior;
            // A disk that IS (or normalizes to) our last write hasn't
            // really changed — re-arm the flush this re-attach cancelled.
            // Without the normalized check, a doc whose drift was
            // suppressed at hydrate hit reconcile here and reported a
            // false conflict (backup + syncError) though disk never moved.
            if (md === prior || diskNormalized === prior) this.scheduleFileWrite(doc, binding);
            else this.reconcileFromDisk(doc, binding);
          } else if (
            prior === undefined &&
            ((opts.liveWins && !this.fileOutlivedClaim(docId, abs, pre?.mtimeMs)) || !diskNewer)
          ) {
            // Fresh attach with NO bookkeeping (post-restart hydrate) and the
            // .md is OLDER than the persisted .ydoc: the crash happened inside
            // the 800ms write-back window, so the hydrated doc is the newer
            // side. Applying disk here would revert the just-made edit on
            // startup (codex P1). Reassert the live doc to disk instead —
            // snapshotting the disk version first, symmetric with the apply
            // branch below (this is the one writer that replaces content the
            // server never wrote). `liveWins` used to reach this branch on
            // the caller's knowledge INSTEAD of the clock; it no longer
            // overrides a file the clock says is newer — see the refusal
            // above and `AttachOpts`.
            this.backupExternalVersion(docId, md);
            binding.lastWritten = md;
            this.scheduleFileWrite(doc, binding);
          } else if (prose.parseMarkdownBlocks(md, parseOptsFor(abs)).length > 0) {
            // At rest: pull disk in as a block diff so anchors on untouched
            // blocks keep resolving. On the no-bookkeeping path we can't
            // PROVE the fragment's extra state was ever flushed, so snapshot
            // it first — restarts are rare enough that a stray backup beats
            // an unrecoverable revert.
            if (prior === undefined) {
              this.backupExternalVersion(docId, currentSerialized, 'live');
            }
            doc.ydoc.transact(() => {
              prose.applyMarkdownToFragment(fragment, md, parseOptsFor(abs));
            }, 'file-watch');
            prose.normalizeHeadingLevels(doc.ydoc);
          }
        }
      } catch (err) {
        // Not on disk, which is not a fault in anything this server did: one
        // line, and the poll takes it from here (see `unreadAtAttach`). It
        // used to be a stack trace per doc per boot, naming the path.
        unread = isDataless(err);
        if (unread)
          console.warn(
            notDownloadedLine(docId, err, 'serving the .ydoc until the poll can read it'),
          );
        else console.error(`[doc-store] attach-time reconcile failed for ${abs}:`, err);
      }
    }

    // doc → disk: every change schedules a debounced write.
    const observer: Parameters<Y.XmlFragment['observeDeep']>[0] = (_events, tr) => {
      // Don't echo our own seed-from-disk or file-watch apply back to disk.
      if (tr.origin === 'file-seed' || tr.origin === 'file-watch') return;
      this.scheduleFileWrite(doc, binding);
    };
    binding.observer = observer;
    fragment.observeDeep(observer);
    // Bookkeeping lives in serializer-space: comparing raw disk bytes against
    // normalized serializer output made every applied external edit look like
    // permanent divergence, so the NEXT external edit was misjudged a
    // conflict and clobbered (2026-08-03 incident, RC1).
    if (binding.lastWritten === undefined) {
      binding.lastWritten = prose.serializeFragmentToMarkdown(fragment);
    }

    // disk → doc: poll for external edits (see armFileWatcher).
    this.armFileWatcher(doc, binding, pre);
    if (unread) {
      const liveWins = opts.liveWins === true || !this.diskNewerThanState(docId, abs, pre?.mtimeMs);
      binding.unreadAtAttach = { liveWins };
      // A caller that said a write is owed (the index row, at boot) is still
      // owed one, so the row keeps saying so. The stamp's verdict alone is
      // not: it calls every never-edited doc the newer side.
      if (opts.liveWins === true) this.failedWrites.add(docId);
      // Said to the owner on `get_doc` as well, because a held write-back is
      // otherwise indistinguishable from one that landed.
      binding.lastSyncError = {
        message:
          'the bound file is not downloaded (EDEADLK); content is served from the .ydoc and ' +
          'writes to the file are held until it can be read',
        at: Date.now(),
      };
    }

    return { ok: true, seeded, resolvedPath: abs };
  }

  /**
   * Bind a READ-ONLY source file (type='code') for review. The file's raw
   * text is seeded into the flat `content` Y.Text (no markdown parse), the
   * mtime poll is armed for disk→doc refresh, and — crucially — there is NO
   * doc→disk write-back: the browser never edits a code file (it only
   * comments), so the file is never rewritten by claude-workspaces. The agent
   * edits the source via its normal tools; the poll re-renders the view.
   */
  attachReadonlyFile(
    docId: string,
    filePath: string,
    opts: AttachOpts = {},
  ): { ok: boolean; error?: 'not-found' | 'path-empty' | 'read-failed'; resolvedPath?: string } {
    return this.attachFlatFile(docId, filePath, opts);
  }

  /**
   * Bind a flat (code / working-tree diff) doc to a file. Disk→doc always
   * flows via the mtime poll; pass `writeBack: true` to also flow doc→disk
   * through the same debounced atomic writer prose docs use — that is what
   * makes the File view a live editor. Pinned diff docs must never pass
   * writeBack (their content is a commit, not a file).
   */
  attachFlatFile(
    docId: string,
    filePath: string,
    opts: AttachOpts & { writeBack?: boolean } = {},
  ): { ok: boolean; error?: 'not-found' | 'path-empty' | 'read-failed'; resolvedPath?: string } {
    if (!filePath || filePath.trim() === '') return { ok: false, error: 'path-empty' };
    const doc = this.p.doc(docId);
    if (!doc) return { ok: false, error: 'not-found' };
    const abs = filePath.startsWith('/') ? filePath : join(process.cwd(), filePath);
    const content = doc.ydoc.getText('content');
    // See `attachFile`: hydration reads off the main thread and hands the
    // bytes down, so nothing below opens the bound path itself.
    const pre = opts.preread;
    // And the same refusal, for the same reason. This door is the one a
    // folder bind walks — `bind-diff` attaches every member of a repo in one
    // synchronous loop — so a single hostile file in a bound tree is exactly
    // the shape that parked the event loop. Read the note in `attachFile`.
    if (!pre && (boundFiles.quarantined(abs) || boundFiles.busy())) {
      return { ok: false, error: 'read-failed' };
    }
    const fileExists = () => (pre ? pre.exists : existsSync(abs));
    let text = '';
    if (fileExists()) {
      try {
        text = pre ? (pre.text ?? '') : readFileSync(abs, 'utf8');
      } catch (err) {
        console.error(`[doc-store] read failed for ${abs}:`, err);
        return { ok: false, error: 'read-failed' };
      }
    }
    // Sync content to the file's CURRENT bytes when disk is the newer side.
    // For read-only docs disk is always authoritative (the live doc never
    // holds browser edits). For write-back docs the two can genuinely
    // diverge across a restart, in BOTH directions: a File-view edit whose
    // ~800ms flush the crash beat (doc newer — blindly seeding here silently
    // destroyed it), or an agent editing the working tree while the server
    // was down (disk newer — "doc always wins" would reassert pre-deploy
    // bytes over their work). Arbitrate by mtime via diskNewerThanState;
    // when the doc wins, back up the losing disk version and reassert below.
    // The 'file-watch' origin routes a disk apply through the same reanchor
    // sweep as a live edit.
    //
    // One writer per path first, for the same reason as in `attachFile`: a
    // superseded diff set binds the same working-tree files a newer one
    // does, and the reassert below is a write.
    const claim = opts.writeBack ? this.claimPathOwnership(docId, abs) : {};
    const pathRefusal = claim.refusal;
    let reassertDoc = false;
    if (fileExists() && text !== content.toString()) {
      const diskNewer = this.diskNewerThanState(docId, abs, pre?.mtimeMs);
      // The same refusal `attachFile` makes, on the same evidence: a
      // `liveWins` claim read off an index row cannot outrank a file that is
      // newer than the `.ydoc` the claim describes. See the long note there.
      const claimOutlived = this.fileOutlivedClaim(docId, abs, pre?.mtimeMs);
      if (opts.writeBack && content.length > 0 && opts.liveWins === true && claimOutlived) {
        console.warn(
          `[doc-store] ${docId}: the bound file is newer than this doc’s last saved state; ` +
            `the held write-back was refused and the file read in (${redactBoundPath(abs)})`,
        );
        this.p.clearPendingFileWrite(docId);
      }
      if (
        opts.writeBack &&
        content.length > 0 &&
        ((opts.liveWins && !claimOutlived) || !diskNewer) &&
        pathRefusal === undefined
      ) {
        this.backupExternalVersion(docId, text);
        reassertDoc = true;
      } else {
        const origin = content.length === 0 ? 'file-seed' : 'file-watch';
        doc.ydoc.transact(() => {
          if (content.length > 0) content.delete(0, content.length);
          if (text.length > 0) content.insert(0, text);
        }, origin);
      }
    }
    const existing = this.bindings.get(docId);
    if (existing?.writeTimer) clearTimeout(existing.writeTimer);
    if (existing?.readTimer) clearTimeout(existing.readTimer);
    if (existing) existing.pollArmed = false;
    if (existing?.contentObserver) content.unobserve(existing.contentObserver);
    // lastWritten is "what the FILE holds" — when the doc won the arbitration
    // the file still holds the stale disk text, and recording the doc text
    // instead would make the writer's no-op check skip the reassert.
    const binding: FileBinding = {
      path: abs,
      lastWritten: reassertDoc ? text : content.toString(),
    };
    this.bindings.set(docId, binding);
    if (pathRefusal) this.suspendWriteBack(docId, binding, pathRefusal);
    else if (claim.contested) this.reassertAfterContest(docId, binding);
    // A re-attach that MOVES this doc leaves its old path behind; whoever it
    // was suspending there is now free to write again.
    if (existing && existing.path !== abs) this.rearbitratePath(existing.path);
    if (!doc.meta.sourceUrl) {
      // Sidecar, not CRDT — see attachFile above.
      doc.meta.sourceUrl = abs;
      this.p.schedulePersist(doc);
    }
    if (opts.writeBack) {
      // doc → disk: same origin-guarded debounced writer as prose docs —
      // our own seed/poll applies must not echo back out to the file.
      binding.writeBack = true;
      const observer = (_event: Y.YTextEvent, tr: Y.Transaction) => {
        if (tr.origin === 'file-seed' || tr.origin === 'file-watch') return;
        this.scheduleFileWrite(doc, binding);
      };
      binding.contentObserver = observer;
      content.observe(observer);
    }
    this.armFileWatcher(doc, binding, pre);
    // Doc won the attach-time arbitration above: push its state back out
    // through the normal debounced writer (which also stamps the poll
    // baseline so the reassert isn't misread as an external edit).
    if (reassertDoc) this.scheduleFileWrite(doc, binding);
    return { ok: true, resolvedPath: abs };
  }

  /**
   * Watch a MOCKUP's source HTML for edits.
   *
   * Same shared sweep as every other binding — arming enrols it in
   * `sweepFilePolls`, so a mockup nobody is looking at is visited on the idle
   * rotation and one somebody has open is visited every tick. What differs is
   * only what happens when the file moves: there is no fragment to seed, no
   * write-back to schedule and no conflict to arbitrate, because the browser
   * never edits a mockup's HTML. It comments on it. So the reconcile's whole
   * job is to hand the new bytes to `onMockupChanged`.
   *
   * Idempotent on the same path: re-serving a mockup calls this on every
   * request, and re-binding a doc to a NEW path replaces the binding the way
   * every other attach does.
   */
  attachMockupFile(
    docId: string,
    filePath: string,
    opts: { preread?: PrereadFile } = {},
  ): { ok: boolean; error?: 'not-found' | 'path-empty'; resolvedPath?: string } {
    if (!filePath || filePath.trim() === '') return { ok: false, error: 'path-empty' };
    const doc = this.p.doc(docId);
    if (!doc) return { ok: false, error: 'not-found' };
    const abs = filePath.startsWith('/') ? filePath : join(process.cwd(), filePath);
    const existing = this.bindings.get(docId);
    // Already watching this exact file: leave the poll bookkeeping alone.
    // Re-arming would re-baseline `lastMtimeMs` from a fresh stat, and an
    // edit that landed between the last sweep and this call would be
    // baselined away — read as "nothing happened" for good. The serve path
    // calls this on every request, so that would be most of them.
    if (existing?.mockup && existing.path === abs) return { ok: true, resolvedPath: abs };
    if (existing?.writeTimer) clearTimeout(existing.writeTimer);
    if (existing?.readTimer) clearTimeout(existing.readTimer);
    if (existing) existing.pollArmed = false;
    const binding: FileBinding = { path: abs, mockup: true };
    this.bindings.set(docId, binding);
    // A serve and a bind reach this door with no preread, having just read
    // the file successfully, so the one stat that arming costs is on a path
    // already proved to answer. A HYDRATE has proved nothing on this thread:
    // it brings the pool's stat, and arming must not take a second one here.
    this.armFileWatcher(doc, binding, opts.preread);
    return { ok: true, resolvedPath: abs };
  }

  /**
   * Pin a doc to its origin repo: repo + branch + relPath (see `DocOriginRepo` in
   * core). From here on, the file the doc syncs with is "the declared
   * relPath in whichever worktree has the declared branch checked out" —
   * resolved at pin, at hydrate, and re-verified by `originRepoGuard` before every
   * flush and every disk→doc apply. A checkout that switches branches under
   * the binding is never written again; the binding follows the branch or
   * parks.
   *
   * Prose docs only: a home is for durable planning/discussion notes. Diff,
   * code and mockup docs follow their surface (the diff's repo, the running
   * server) and pinning them would fight those flows.
   */
  setDocOriginRepo(
    docId: string,
    input: unknown,
  ):
    | {
        ok: true;
        home: DocOriginRepo;
        placement: { placed: true; path: string } | { placed: false; reason: string };
      }
    | { ok: false; error: 'not-found' | 'invalid-home' | 'not-markdown'; detail?: string } {
    const doc = this.p.doc(docId);
    if (!doc) return { ok: false, error: 'not-found' };
    if (isBoardOwnedDoc(doc.docId) || contentKind(doc.meta.type) !== 'prose') {
      return {
        ok: false,
        error: 'not-markdown',
        detail: 'an origin repo is for markdown docs; code/diff/mockup docs follow their surface',
      };
    }
    const norm = normalizeDocOriginRepo(input);
    if (!norm.ok) return { ok: false, error: 'invalid-home', detail: norm.error };
    // The repo must at least exist as a repo — a typo'd repoRoot pinned
    // as-is would park the doc forever with a message blaming the branch.
    // Store the MAIN checkout's root, not the caller's spelling: a home
    // declared from a linked worktree must survive that worktree's removal.
    const canonRoot = canonicalRepoRoot(norm.home.repoRoot);
    if (canonRoot === null) {
      return {
        ok: false,
        error: 'invalid-home',
        detail: `${norm.home.repoRoot} is not a git checkout`,
      };
    }
    const home: DocOriginRepo = { ...norm.home, repoRoot: canonRoot };
    doc.meta.docHome = home;
    const placement = resolveOriginRepoCheckout(home);
    if (placement.placed) {
      const binding = this.bindings.get(doc.docId);
      // Already bound to an EXISTING copy of the home: nothing to move. A
      // missing file still retargets — the retarget is what exports it.
      if (binding?.path === placement.absPath && existsSync(placement.absPath)) {
        this.p.schedulePersist(doc);
      } else {
        this.retargetHomeBinding(doc, placement.absPath);
      }
      return { ok: true, home, placement: { placed: true, path: placement.absPath } };
    }
    // Unplaced is a legal pin: the doc stays durable in the .ydoc and the
    // guard parks every write until a checkout on the branch appears. An
    // existing binding to some other path is deliberately left in the map —
    // originRepoGuard is what stops it writing, and keeping it is what lets the
    // next flush attempt re-resolve and recover.
    this.p.schedulePersist(doc);
    return { ok: true, home, placement: { placed: false, reason: placement.reason } };
  }

  /** Unpin: the doc keeps whatever binding it has and goes back to being an
   *  ordinary explicit-path doc. */
  clearDocOriginRepo(docId: string): { ok: boolean } {
    const doc = this.p.doc(docId);
    if (!doc || !doc.meta.docHome) return { ok: false };
    doc.meta.docHome = undefined;
    this.p.schedulePersist(doc);
    return { ok: true };
  }

  /** The pin plus where it resolves RIGHT NOW — for doc status surfaces. */
  docOriginRepoStatus(docId: string):
    | {
        home: DocOriginRepo;
        placement: { placed: true; path: string } | { placed: false; reason: string };
        boundPath?: string;
      }
    | undefined {
    const doc = this.p.doc(docId);
    const home = doc?.meta.docHome;
    if (!doc || !home) return undefined;
    const placement = resolveOriginRepoCheckout(home);
    const boundPath = this.bindings.get(doc.docId)?.path;
    return {
      home,
      placement: placement.placed
        ? { placed: true, path: placement.absPath }
        : { placed: false, reason: placement.reason },
      ...(boundPath ? { boundPath } : {}),
    };
  }

  /**
   * Write a prose doc's current markdown to a NEW file and bind the doc there.
   *
   * The move verb's half that touches disk. The file is created exclusively
   * (`wx`), so a file that appeared since the caller checked is refused rather
   * than overwritten, and nothing about the doc changes until that write has
   * landed — a failed write leaves the doc bound exactly where it was. The
   * rebind is `retargetHomeBinding` with the live doc winning, because the
   * file it finds is the one this call just wrote from that doc. The old file,
   * when there was one, is left on disk untouched.
   */
  exportAndRebind(
    doc: LiveDoc,
    absPath: string,
  ): { ok: true; previous?: string } | { ok: false; error: 'target-exists' | 'write-failed' } {
    const md = prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc));
    try {
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, md, { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return { ok: false, error: 'target-exists' };
      }
      console.error(`[doc-store] ${doc.docId}: could not write ${absPath}:`, err);
      return { ok: false, error: 'write-failed' };
    }
    const previous = this.bindings.get(doc.docId)?.path ?? doc.meta.sourceUrl;
    this.retargetHomeBinding(doc, absPath, { liveWins: true });
    return { ok: true, ...(previous !== undefined ? { previous } : {}) };
  }

  /**
   * Point a home-pinned doc's binding at `absPath` (the freshly-resolved
   * home) with a CLEAN attach. The old binding's bookkeeping is about the
   * old file — letting `attachFile` read its `lastWritten` as `prior` would
   * arbitrate the new checkout's file against another file's history — so it
   * is dropped whole and the attach runs the same mtime arbitration a
   * restart does (losing side backed up, never silently discarded).
   */
  retargetHomeBinding(doc: LiveDoc, absPath: string, opts: AttachOpts = {}): void {
    const docId = doc.docId;
    const old = this.bindings.get(docId);
    // The path this doc is leaving may still hold a binding this doc's
    // presence had suspended. Settled below, once the new attach is done.
    const vacated = old && old.path !== absPath ? old.path : undefined;
    if (old) {
      if (old.writeTimer) clearTimeout(old.writeTimer);
      if (old.readTimer) clearTimeout(old.readTimer);
      old.pollArmed = false;
      if (old.observer) prose.getProseFragment(doc.ydoc).unobserveDeep(old.observer);
      this.bindings.delete(docId);
    }
    // A branch whose checkout holds no copy yet: the pin (or retarget) IS
    // the export. Write the doc's content first, atomically, so the attach
    // below finds an in-sync file instead of never creating one (attachFile
    // arms nothing for a missing path). A copy the checkout DOES hold is
    // arbitrated by the attach — by the caller's knowledge when it has any
    // (`opts.liveWins`), by mtime otherwise.
    // A preread already answered "is it there" off the main thread; asking
    // the filesystem again here would put the blocking call straight back.
    const absent = opts.preread ? !opts.preread.exists : !existsSync(absPath);
    let attachOpts = opts;
    if (absent) {
      const md = prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc));
      try {
        mkdirSync(dirname(absPath), { recursive: true });
        const tmp = `${absPath}.cw-export~`;
        writeFileSync(tmp, md);
        renameSync(tmp, absPath);
        // The export just changed the answer the preread carried, and a
        // preread saying "not there" would leave the attach unbound and the
        // poll unarmed. Drop it: the path has answered a write, so the
        // attach's own read is not the syscall this guard exists for.
        attachOpts = { ...opts, preread: undefined };
      } catch (err) {
        console.error(`[doc-store] ${docId}: could not export doc to its home ${absPath}:`, err);
      }
    }
    // attachFile only records sourceUrl when absent; a retarget must repoint.
    doc.meta.sourceUrl = absPath;
    this.attachFile(docId, absPath, attachOpts);
    if (vacated) this.rearbitratePath(vacated);
    this.p.schedulePersist(doc);
    console.log(`[doc-store] ${docId}: home binding now at ${absPath}`);
  }

  /**
   * A home-pinned doc with NO binding tries to re-place its home. The state
   * exists when hydration found no checkout on the home branch: parking
   * there leaves nothing in `fileBindings`, and every recovery path below
   * this one — originRepoGuard, the poll sweep — hangs off a binding. Without this
   * hook the park message's promise ("check the branch out and the next
   * edit or reparse resumes syncing") held only for docs parked while LIVE;
   * a doc parked at hydrate stayed parked until a re-pin or restart. Called
   * from the doc's update hook (throttled) and from reparseFromDisk
   * (forced). Bound docs return immediately — originRepoGuard owns them.
   */
  maybeRebindHome(doc: LiveDoc, opts?: { force?: boolean }): void {
    const home = doc.meta.docHome;
    if (!home || this.bindings.has(doc.docId)) return;
    if (isBoardOwnedDoc(doc.docId) || contentKind(doc.meta.type) !== 'prose') return;
    const now = Date.now();
    if (!opts?.force && now - (this.homeRebindAttemptAt.get(doc.docId) ?? 0) < 1000) return;
    this.homeRebindAttemptAt.set(doc.docId, now);
    const placement = resolveOriginRepoCheckout(home);
    if (!placement.placed) return;
    // Persist BEFORE attaching so the .ydoc the attach's at-rest arbitration
    // reads (diskNewerThanState) holds the current state, not the pre-edit
    // one. When the trigger is the edit itself that arbitration is not
    // trusted at all: the live doc is the newer side by construction, and
    // `liveWins` says so instead of letting a clock tie decide (see
    // `AttachOpts`). A forced rebind (reparse) is the caller declaring disk
    // the winner, and the reparse that follows reads disk in regardless.
    this.p.persistNow(doc);
    this.retargetHomeBinding(doc, placement.absPath, { liveWins: !opts?.force });
  }

  /**
   * The per-sync-direction gate for home-pinned docs, run before a flush
   * writes AND before a disk change is applied. Cheap (a handful of stat +
   * plumbing-file reads, no subprocess), because it has to run every time:
   * verifying only occasionally is how a triage doc once landed on another
   * session's feature branch — the checkout under the path had switched and
   * both directions kept treating its file as the doc's.
   *
   * 'ok'         the bound path is still the home; proceed.
   * 'retargeted' the home resolves elsewhere now; the binding was moved
   *              there (exporting the file if the new checkout has none)
   *              and a flush was re-armed. The caller must NOT touch the
   *              old binding it was handed.
   * 'parked'     the home resolves nowhere; nothing was read or written,
   *              and a syncError names why and how to resume.
   */
  private originRepoGuard(doc: LiveDoc, binding: FileBinding): 'ok' | 'retargeted' | 'parked' {
    const home = doc.meta.docHome;
    if (!home) return 'ok';
    if (verifyPathInOriginRepo(binding.path, home) === 'ok') return 'ok';
    const placement = resolveOriginRepoCheckout(home);
    if (placement.placed) {
      // Resolution landing on the very path the verify refused (a nested
      // repo under relPath can split the two): writing there is what the
      // home declares, so treat it as placed rather than retarget-looping.
      if (placement.absPath === binding.path) return 'ok';
      this.retargetHomeBinding(doc, placement.absPath);
      const next = this.bindings.get(doc.docId);
      // Re-arm a flush on the NEW binding: its no-op pass is what clears the
      // pending-write bookkeeping the flush this guard interrupted was
      // carrying.
      if (next) this.scheduleFileWrite(doc, next);
      return 'retargeted';
    }
    const message =
      placement.reason === 'repo-missing'
        ? `doc origin repo is unreachable: ${home.repoRoot} is not (or no longer) a git checkout. ` +
          'Writes are parked; the live doc stays the source of truth and its content is durable ' +
          'in the workspace. Re-pin the home at a valid checkout to resume.'
        : placement.reason === 'path-escapes-checkout'
          ? `doc origin repo is unsafe: ${home.relPath} passes through a symlink that leaves the ` +
            'checkout, so writing it would land outside the repo. Writes are parked; the live ' +
            'doc stays the source of truth. Re-pin the home at a path contained in the checkout.'
          : `doc origin repo is unplaced: no checkout of the repo has branch "${home.branch}" checked out. ` +
            'Writes are parked; the live doc stays the source of truth and its content is durable ' +
            'in the workspace. Check the branch out in some worktree (git worktree add <path> ' +
            `"${home.branch}") and the next edit or reparse resumes syncing there.`;
    if (binding.lastSyncError?.message !== message) {
      this.recordSyncError(doc, binding, message);
    }
    return 'parked';
  }

  /**
   * Watch the bound file for external edits via an mtime poll.
   *
   * We deliberately do NOT use fs.watch. A file-level fs.watch is bound to
   * the inode present at watch-creation time (kqueue on macOS, inotify on
   * Linux). Editors — and Claude Code's own Edit tool — save via
   * write-temp-then-rename, which atomically replaces the file's inode, so
   * the watch goes stale and only the FIRST external edit ever reaches the
   * live doc (deterministic repro on Bun + Node). Watching the parent
   * directory dodges the inode problem on macOS but proved unreliable under
   * Bun-on-Linux. A stat-mtime poll is immune to all of it — inode
   * replacement, platform, and runtime — and ~1s latency matches the doc's
   * existing sync contract.
   *
   * What changed on 2026-08-29: the poll is no longer an interval PER
   * binding. Arming enrols the binding in one shared sweep (`sweepFilePolls`)
   * which visits active docs every tick and idle docs on a budget. Same
   * mechanism, same immunity, a constant number of timers.
   */
  private armFileWatcher(_doc: LiveDoc, binding: FileBinding, preread?: PrereadFile): void {
    binding.pollArmed = false;
    // A preread already paid for the stat on the thread pool. Re-stat'ing
    // here would put the blocking syscall back on the main thread and undo
    // the whole point of hydrating off it.
    if (preread) {
      if (!preread.exists) return;
      binding.lastMtimeMs = preread.mtimeMs;
      binding.lastSize = preread.size;
      binding.pollArmed = true;
      this.ensureFilePollTicker();
      return;
    }
    // No preread means a startup attach: every request and timer path comes
    // through `attachFileAsync`, which always brings one. Nothing is waiting
    // on the server at boot, so this stat may block — and it must stay
    // synchronous, because arming is part of what `attachFile` PROMISES its
    // caller. Making it async moved `pollArmed` a tick later and broke every
    // test that counts armed bindings straight after an attach.
    if (boundFiles.quarantined(binding.path)) return;
    if (!existsSync(binding.path)) return;
    try {
      const st = statStampSync(binding.path);
      binding.lastMtimeMs = st.mtimeMs;
      binding.lastSize = st.size;
    } catch {}
    // Armed, but deliberately not marked as ACCESSED. Hydration re-binds
    // every bound doc at boot; if arming warmed them, the first minute of
    // every restart would put the whole corpus in the fast lane — the storm
    // this change exists to remove. It joins the idle rotation instead, and
    // the first real `get` / `getOrCreate` promotes it.
    binding.pollArmed = true;
    this.ensureFilePollTicker();
  }

  /**
   * Is somebody looking at this doc — i.e. does it belong in the fast lane,
   * stat'd on every 500ms tick rather than on the idle rotation?
   *
   * "Looking at" is one of three things, all of them pushed to us rather
   * than polled for:
   *   - a live websocket on the doc (someone has the editor open),
   *   - a write-back or reconcile still inside its debounce window, or
   *   - an access within the last `FILE_POLL_ACTIVE_MS` — any `get` /
   *     `getOrCreate`, which is every REST read, every MCP edit tool, and the
   *     websocket upgrade itself.
   *
   * An IDLE binding is not unwatched — it is watched more slowly, on the
   * round-robin budget (see `IDLE_SWEEP_BUDGET`), and re-stat'd immediately
   * by `touchDoc` the moment anyone reaches for the doc. That matters
   * because a git checkout / stash / pull against a bound file nobody has
   * open must still reach the live doc: it is the documented behaviour and
   * `git-ops-vs-bound.test.ts` pins it. `reparseFromDisk` remains the
   * explicit force-pull.
   */
  private bindingIsActive(docId: string, binding: FileBinding, now: number): boolean {
    if (!binding.pollArmed) return false;
    if (binding.writeTimer || binding.readTimer) return true;
    const doc = this.p.residentDoc(docId);
    if (doc && doc.conns.size > 0) return true;
    const touched = this.p.lastTouchedAt(docId);
    return touched !== undefined && now - touched < FILE_POLL_ACTIVE_MS;
  }

  /**
   * One stat of one bound file, and the reconcile it may schedule. Extracted
   * from the old per-binding interval body so the shared sweep and the
   * on-access edge check run byte-identical logic.
   */
  private pollBinding(docId: string, binding: FileBinding): void {
    if (!this.p.residentDoc(docId)) return;
    // One stat, and it runs on the thread pool. The sweep visits every bound
    // file, so a single path whose provider has stopped answering used to be
    // enough to park the event loop for the whole server — see slow-fs. A
    // stat still in flight is not re-issued: a stalled one never returns, and
    // re-issuing it every tick is how the overdue bound would be exhausted.
    if (binding.statInFlight) return;
    binding.statInFlight = true;
    void boundFiles
      .statMtime(binding.path)
      .then((res) => {
        if (res.status !== 'ok') return; // quarantined, busy, or never answered
        if (!res.exists) return; // the ordinary case: a deleted worktree
        this.applyPolledStat(docId, binding, res.mtimeMs, res.size);
      })
      .finally(() => {
        binding.statInFlight = false;
      });
  }

  /**
   * The rest of `pollBinding`, once the stat has come back. Split out only so
   * the stat can be awaited; the decisions below are unchanged.
   */
  private applyPolledStat(
    docId: string,
    binding: FileBinding,
    mtimeMs: number,
    size: number,
  ): void {
    const doc = this.p.residentDoc(docId);
    if (!doc) return;
    // Our own write-back is on the pool. Its rename has possibly landed and
    // its `lastMtimeMs` certainly has not — that is recorded in the callback
    // — so the mtime in hand can be OUR bytes reading as an external edit,
    // and the conflict arm would back up the user's own document as if a
    // stranger had written it. The write's callback records the mtime it
    // ended up with, and the next sweep then sees no change at all.
    if (binding.writeInFlight) return;
    if (this.bindings.get(docId) !== binding) return;
    // BOTH halves, and the mtime at nanosecond precision, or an edit that
    // lands in the same granule as the stamp we recorded is invisible for
    // good — see `lastSize`.
    const changed = mtimeMs !== binding.lastMtimeMs || size !== binding.lastSize;
    // A file the attach could not read is read again whatever the stat says:
    // downloading it changes neither half (see `unreadAtAttach`).
    if (!changed && !binding.unreadAtAttach) return;
    // A reconcile for this exact stamp is already on the debounce; re-arming
    // it on every tick would push the read further away the longer the file
    // sits changed.
    if (mtimeMs === binding.pendingMtimeMs && size === binding.pendingSize && binding.readTimer)
      return;
    binding.pendingMtimeMs = mtimeMs;
    binding.pendingSize = size;
    // An external write IS somebody reaching for the doc — the editor or the
    // git operation that made it is usually about to make another. Promote
    // the binding to the fast lane so the next few writes are seen in one
    // tick rather than one rotation, and let it decay like any other access.
    // `this.p.now()`, not `Date.now()`: residency runs on ONE clock, or an
    // externally edited doc ages against an epoch the policy never sees.
    //
    // A retry of an unread file is NOT an access — nobody wrote anything —
    // and counting it as one would hold that doc resident for as long as its
    // file stays in the cloud.
    if (changed) this.p.noteTouched(docId, this.p.now());
    // Debounce so we don't read a half-written file mid-save.
    if (binding.readTimer) clearTimeout(binding.readTimer);
    binding.readTimer = setTimeout(() => {
      // Null it FIRST. `bindingIsActive` reads `readTimer` as "a reconcile is
      // still pending"; a handle left behind after the callback fired made
      // that permanently true, so one external edit pinned the binding in the
      // fast lane for the life of the process. `writeTimer` has always nulled
      // itself here for the same reason.
      binding.readTimer = null;
      // The read the reconcile needs also goes through the pool. This is the
      // syscall the outage actually wedged on (`openat`, not `stat`), so a
      // guarded stat above with a blocking read here would guard nothing.
      // Quiet while retrying an unread file: the attach logged it once, and a
      // line per visit is the noise this binding state exists to replace.
      const quiet = binding.unreadAtAttach !== undefined;
      void boundFiles.read(binding.path, { quiet }).then((res) => {
        if (this.bindings.get(docId) !== binding) return;
        if (res.status !== 'ok') {
          // The read was refused or never answered. Forget that we spotted
          // this mtime so the next sweep tries again: committing it here
          // would make the change look already-handled and lose the external
          // edit for as long as nobody touched the file a second time.
          binding.pendingMtimeMs = undefined;
          binding.pendingSize = undefined;
          return;
        }
        if (binding.unreadAtAttach && res.exists) {
          binding.pendingMtimeMs = undefined;
          binding.pendingSize = undefined;
          this.retryUnreadAttach(doc, binding, res);
          return;
        }
        // Commit the stamp of the bytes we actually got, not the one the stat
        // reported — the file may have been written again in between, and
        // that write must still look like a change worth reading.
        binding.lastMtimeMs = res.exists ? res.mtimeMs : undefined;
        binding.lastSize = res.exists ? res.size : undefined;
        binding.pendingMtimeMs = undefined;
        binding.pendingSize = undefined;
        this.reconcileFromDisk(doc, binding, res);
      });
    }, READ_DEBOUNCE_MS);
  }

  /**
   * The read an attach could not make, landing at last: run the attach again
   * with those bytes in hand, so the doc and the file are arbitrated as they
   * would have been had the file been on disk at boot.
   *
   * Re-running `attachFile` rather than reconciling here, for the reason
   * `DocStore.bindAfterRead` re-runs its hydrate: the attach is where that
   * decision lives. The poll's reconcile would get it wrong — it calls a clean
   * live doc the older side, so a write the server owed the file would be
   * reverted by the stale copy it was meant to replace.
   *
   * The verdict is the one the attach reached (see `unreadAtAttach`), plus
   * one claim of our own: an edit made while the file was unreadable is what
   * `bindAfterRead` calls an edit in its gap — the live doc holds content
   * disk has never held — so it wins too. Whichever side wins, the loser is
   * backed up first, as the attach's own two branches do.
   */
  private retryUnreadAttach(doc: LiveDoc, binding: FileBinding, pre: PrereadFile): void {
    const live = prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc));
    const liveWins = binding.unreadAtAttach?.liveWins === true || live !== binding.lastWritten;
    const disk = pre.text ?? '';
    if (liveWins) {
      // No bookkeeping: the re-run takes the fresh-attach branch, backs the
      // file up and reasserts the doc.
      binding.lastWritten = undefined;
    } else if (
      disk !== live &&
      prose.normalizeMarkdown(disk, parseOptsFor(binding.path)) !== live
    ) {
      // Bookkeeping kept, and equal to the doc, so the re-run APPLIES the file
      // whatever the two stamps say now. That branch backs nothing up when
      // bookkeeping exists, so the doc's copy is kept here instead.
      this.backupExternalVersion(doc.docId, live, 'live');
    }
    const res = this.attachFile(doc.docId, binding.path, {
      preread: pre,
      ...(liveWins ? { liveWins } : {}),
    });
    if (!res.ok) return;
    // The held write is the attach's now: it armed one if the file needs it,
    // and a file that already matches the doc owes nothing.
    this.failedWrites.delete(doc.docId);
    if (!this.hasPendingWrite(doc.docId)) this.p.clearPendingFileWrite(doc.docId);
    console.log(`[doc-store] ${doc.docId}: bound file is readable again; reconciled`);
  }

  /**
   * ONE interval for every bound file on the server, instead of one per
   * binding. The measured corpus had 4,228 bound docs; at 500ms each that was
   * thousands of stat syscalls a second, almost all of them for docs nobody
   * had open, plus 4,228 entries on the timer heap that never came off.
   */
  private ensureFilePollTicker(): void {
    if (this.pollTicker) return;
    const timer = setInterval(() => this.sweepFilePolls(), FILE_POLL_MS);
    // Don't let the poll keep the process (or a test runner) alive.
    timer.unref?.();
    this.pollTicker = timer;
  }

  /**
   * One pass over the bound files: every ACTIVE binding, plus a slice of the
   * idle ones.
   *
   * The two halves answer different questions. An active binding belongs to a
   * doc somebody is in, so it keeps the original 500ms latency. An idle one
   * belongs to a doc that is nonetheless allowed to change under us — a git
   * checkout, a branch switch, an editor save — so it must still be visited,
   * just not all of them every half-second. `idleCursor` walks the binding
   * map so each idle doc comes round in turn.
   */
  private sweepFilePolls(): void {
    const now = this.p.now();
    const idle: string[] = [];
    let armed = 0;
    for (const [docId, binding] of this.bindings) {
      if (!binding.pollArmed) continue;
      armed++;
      if (this.bindingIsActive(docId, binding, now)) this.pollBinding(docId, binding);
      else idle.push(docId);
    }
    if (armed === 0) {
      if (this.pollTicker) clearInterval(this.pollTicker);
      this.pollTicker = null;
      this.idleCursor = 0;
      return;
    }
    const take = Math.min(IDLE_SWEEP_BUDGET, idle.length);
    for (let i = 0; i < take; i++) {
      const docId = idle[(this.idleCursor + i) % idle.length];
      const binding = this.bindings.get(docId);
      if (binding) this.pollBinding(docId, binding);
    }
    this.idleCursor = idle.length === 0 ? 0 : (this.idleCursor + take) % idle.length;
  }

  /**
   * Record that somebody just reached for this doc, and — on the idle→active
   * edge — pull any external edit in before they read it.
   *
   * Called from `get` / `getOrCreate`, which every route, MCP tool and
   * websocket upgrade funnels through. The edge check is rate-limited to one
   * stat per `FILE_POLL_MS` per doc, so a burst of requests against one doc
   * costs no more syscalls than the old always-on poll did.
   */
  touchDoc(docId: string): void {
    const binding = this.bindings.get(docId);
    if (!binding?.pollArmed) {
      // Nothing to poll — but still remember the access, so a doc that is
      // bound later starts out warm rather than cold.
      this.p.noteTouched(docId, this.p.now());
      return;
    }
    const now = this.p.now();
    // Asked BEFORE the stamp moves: afterwards every touch looks active.
    const wasActive = this.bindingIsActive(docId, binding, now);
    const prev = this.p.lastTouchedAt(docId);
    this.p.noteTouched(docId, now);
    this.ensureFilePollTicker();
    if (!wasActive) this.noteActivation();
    if (prev === undefined || now - prev >= FILE_POLL_MS) this.pollBinding(docId, binding);
  }

  /** One idle -> active transition, filed under where it came from. */
  private noteActivation(): void {
    const tag = activationTag();
    const seen = this.activations.get(tag);
    if (seen !== undefined) {
      this.activations.set(tag, seen + 1);
      return;
    }
    if (this.activations.size >= ACTIVATION_TAG_CAP) {
      this.activations.set('other', (this.activations.get('other') ?? 0) + 1);
      return;
    }
    this.activations.set(tag, 1);
  }

  /**
   * Force a re-parse of the bound file into the live doc, ignoring
   * the currentSerialized match and lastWritten guards. Useful when
   * the parser itself changed (e.g. after a fix) and the on-disk
   * content would parse differently now even though its bytes are
   * unchanged.
   */
  reparseFromDisk(docId: string): { ok: boolean; error?: 'not-found' | 'no-binding' | 'missing' } {
    const doc = this.p.doc(docId);
    if (!doc) return { ok: false, error: 'not-found' };
    this.touchDoc(doc.docId);
    // PINNED diff docs have no file binding — their content is pinned to a
    // commit. Recover by re-reading the file at the target hash from the
    // repo. (Working-tree diff docs have a live binding and fall through to
    // the normal flat-text path below.)
    if (doc.meta.type === 'diff' && doc.meta.diffTarget) {
      const { workspaceRoot, diffTarget, relPath, diffStatus } = doc.meta;
      if (!workspaceRoot || !diffTarget || !relPath) return { ok: false, error: 'no-binding' };
      if (diffStatus === 'deleted') return { ok: true };
      const text = showFile(workspaceRoot, diffTarget, relPath);
      if (text === null) return { ok: false, error: 'missing' };
      const content = doc.ydoc.getText('content');
      doc.ydoc.transact(() => {
        content.delete(0, content.length);
        content.insert(0, text);
      }, 'file-watch');
      return { ok: true };
    }
    // A pinned doc re-resolves its home before the reparse reads anything.
    // The old path's checkout may have switched branches since the binding
    // was made — an unguarded read here would pull that branch's copy
    // straight into the live doc, the exact incident originRepoGuard closes on
    // the poll path — and a doc parked at hydrate has no binding at all,
    // with reparse documented as one of its two recovery verbs.
    if (doc.meta.docHome && !isBoardOwnedDoc(doc.docId) && contentKind(doc.meta.type) === 'prose') {
      const bound = this.bindings.get(docId);
      if (!bound) this.maybeRebindHome(doc, { force: true });
      else if (this.originRepoGuard(doc, bound) === 'parked')
        return { ok: false, error: 'missing' };
    }
    const binding = this.bindings.get(docId);
    if (!binding) return { ok: false, error: 'no-binding' };
    // A path that has already refused to answer is not force-readable either
    // — this read is synchronous and would park the whole server (slow-fs).
    if (boundFiles.quarantined(binding.path)) return { ok: false, error: 'missing' };
    if (!existsSync(binding.path)) return { ok: false, error: 'missing' };
    // The caller is declaring disk the winner. A pending write-back holds a
    // PRE-reparse serialization — letting it fire would rewrite the file the
    // caller just forced ("its stale in-memory copy flushed to disk and the
    // reparse pulled that back", 2026-08-03 incident).
    if (binding.writeTimer) {
      clearTimeout(binding.writeTimer);
      binding.writeTimer = null;
    }
    let md: string;
    try {
      md = readFileSync(binding.path, 'utf8');
    } catch {
      return { ok: false, error: 'missing' };
    }
    if (contentKind(doc.meta.type) === 'flat') {
      const content = doc.ydoc.getText('content');
      doc.ydoc.transact(() => {
        content.delete(0, content.length);
        content.insert(0, md);
      }, 'file-watch');
      binding.lastWritten = md;
      binding.lastSyncError = undefined;
      return { ok: true };
    }
    const opts = parseOptsFor(binding.path);
    const diskBlocks = prose.parseMarkdownBlocks(md, opts);
    if (diskBlocks.length === 0) return { ok: false, error: 'missing' };
    binding.diskSource = md;
    const fragment = prose.getProseFragment(doc.ydoc);
    // A force-pull is the bluntest disk-wins path there is: it cleared the
    // pending write-back above, so anything the doc holds that the file has
    // never seen is about to exist nowhere. The caller asked for disk and
    // still gets it — but not silently, and not without a copy. See
    // `recordBlocksDropped`.
    const liveBefore = prose.serializeFragmentToMarkdown(fragment);
    const delta = blockDelta(
      blockTexts(fragment.toArray() as Y.XmlElement[]),
      incomingBlockTexts(diskBlocks),
    );
    doc.ydoc.transact(() => {
      // Block-level diff, not delete-all + push: blocks the rewrite didn't
      // touch keep their Y.XmlText identity, so their thread anchors keep
      // resolving instead of every thread in the doc orphaning.
      prose.applyMarkdownToFragment(fragment, md, opts);
    }, 'file-watch');
    // The diff above keys blocks by their serialized markdown, so a block
    // whose only defect is an ATTRIBUTE (a legacy string heading level, which
    // serializes to the same `## …`) is correctly seen as unchanged and kept.
    // reparse is the documented recovery tool, so repair those here — without
    // it, force-pulling a legacy doc still left its headings rendering as h1.
    prose.normalizeHeadingLevels(doc.ydoc);
    // Serializer-space, not raw disk bytes — see attachFile (RC1).
    binding.lastWritten = prose.serializeFragmentToMarkdown(fragment);
    // Cleared FIRST, not in an `else`: a reparse that swapped one section for
    // another of the same size keeps a copy (a heading left) and raises
    // nothing (the file is no shorter), and an earlier error left standing
    // through that would outlive what it described.
    if (delta.net === 0) binding.lastSyncError = undefined;
    if (worthKeeping(delta)) this.recordBlocksDropped(doc, binding, liveBefore, delta);
    return { ok: true };
  }

  /**
   * External file changed — read it, compare to what we think is
   * canonical, and apply the delta to the live doc if different.
   * Applies in one transact origin='file-watch' so the doc→disk
   * observer knows not to re-flush (which would bounce back here).
   */
  private reconcileFromDisk(
    doc: LiveDoc,
    binding: FileBinding,
    preread?: PrereadFile,
  ): 'in-sync' | 'catch-up' | 'apply' | 'conflict' | 'missing' {
    // The disk→doc side of the home gate. Without it, `git checkout` under a
    // pinned doc's old path rewrites the file, the poll sees an mtime change,
    // and the OTHER branch's copy gets applied into the live doc — the read
    // half of the same incident the write half guards against.
    if (this.originRepoGuard(doc, binding) !== 'ok') return 'missing';
    let md: string;
    if (preread) {
      if (!preread.exists) return 'missing';
      md = preread.text ?? '';
    } else {
      // No preread means a SYNCHRONOUS caller — a flush guard, an explicit
      // "sync now". Those still block, so they must not touch a path that has
      // already proved it will not answer (see slow-fs). Reporting 'missing'
      // is the same answer they get for a file that has gone, and the poll
      // retries once the backoff lapses.
      if (boundFiles.quarantined(binding.path)) return 'missing';
      if (!existsSync(binding.path)) return 'missing';
      try {
        md = readFileSync(binding.path, 'utf8');
      } catch (err) {
        console.error(`[doc-store] read failed for ${binding.path}:`, err);
        return 'missing';
      }
    }
    // A mockup has no content surface in the doc at all — see
    // `attachMockupFile`. The bytes go to the doc store, which captures the
    // round and tells the open viewers; nothing here touches the ydoc.
    if (binding.mockup) {
      if (md === binding.lastWritten) return 'in-sync';
      binding.lastWritten = md;
      this.p.onMockupChanged(doc, md);
      return 'apply';
    }
    // Code and working-tree diff docs are flat text — replace the whole
    // `content` Y.Text on change. Read-only bindings can't hold live edits,
    // so 'conflict' is impossible for them; editable (writeBack) bindings
    // get the same keep-live/backup/reassert arm the prose path has — a
    // blind replace here would eat the reviewer's in-flight keystrokes.
    if (contentKind(doc.meta.type) === 'flat') {
      const content = doc.ydoc.getText('content');
      const current = content.toString();
      const decision = decideReconcile({
        disk: md,
        lastWritten: binding.lastWritten,
        currentSerialized: current,
      });
      if (decision === 'in-sync') return decision;
      if (decision === 'catch-up') {
        binding.lastWritten = md;
        return decision;
      }
      if (decision === 'conflict' && binding.writeBack) {
        this.recordConflictReassert(doc, binding, md);
        return decision;
      }
      doc.ydoc.transact(() => {
        content.delete(0, content.length);
        content.insert(0, md);
      }, 'file-watch');
      binding.lastWritten = md;
      binding.lastSyncError = undefined;
      return decision;
    }
    binding.diskSource = md;
    const fragment = prose.getProseFragment(doc.ydoc);
    const currentSerialized = prose.serializeFragmentToMarkdown(fragment);
    const decision = decideReconcile({
      disk: md,
      lastWritten: binding.lastWritten,
      currentSerialized,
    });
    // Same content as last round-trip → nothing to do.
    if (decision === 'in-sync') return decision;
    // The live doc already serializes to disk (up to serializer whitespace) —
    // just catch up bookkeeping, don't touch the fragment.
    if (decision === 'catch-up') {
      binding.lastWritten = md;
      return decision;
    }
    // decideReconcile compares BYTES. A formatting-only external save
    // (format-on-save, trailing-newline fixers) changes bytes but not
    // content — without these checks it classified as 'apply' (block
    // rewrite, broken anchors) or, with un-flushed live edits, 'conflict'
    // (backup + syncError + reassert over the human's formatting). Parse
    // cost is fine here: we only get this far on a detected mtime change.
    const opts = parseOptsFor(binding.path);
    const diskNormalized = prose.normalizeMarkdown(md, opts);
    if (diskNormalized === currentSerialized) {
      // Formatting-variant of the live content — semantically in-sync.
      // Leave the file as the external tool wrote it.
      binding.lastWritten = currentSerialized;
      return 'in-sync';
    }
    if (decision === 'conflict') {
      if (diskNormalized === binding.lastWritten) {
        // Disk holds a formatting-variant of our LAST write — no semantic
        // external change, so the un-flushed live edits are not in
        // conflict. Re-arm the flush; the pending write carries them out.
        this.scheduleFileWrite(doc, binding);
        return 'catch-up';
      }
      // An external write collided with un-flushed live edits. A blind
      // delete+push here would clobber the human's in-progress work (the bug
      // a peer reported). The editor is the runtime source of truth, so keep
      // the live edits and reassert them to disk via the debounced writer.
      // BUT the reassert overwrites the external version on disk — so back it
      // up first, or "recoverable with reparse_from_disk" is a lie (disk
      // would already hold our reassert by the time anyone reparses).
      this.recordConflictReassert(doc, binding, md);
      return decision;
    }
    // decision === 'apply' — disk changed externally and the live doc is clean.
    let blocks: Y.XmlElement[];
    try {
      blocks = prose.parseMarkdownBlocks(md, opts);
    } catch (err) {
      // A parse throw used to vanish into the setTimeout callback, leaving
      // the doc silently serving pre-edit content. Record + log instead so
      // getDoc can report WHY it's stale. The fragment is left untouched
      // (we never started the transact), so the next edit retries cleanly.
      const message = err instanceof Error ? err.message : String(err);
      this.recordSyncError(doc, binding, `parse failed: ${message}`);
      console.error(`[doc-store] ${doc.docId}: disk→doc parse failed for ${binding.path}:`, err);
      return decision;
    }
    if (blocks.length === 0) {
      // Don't wipe to empty on a parse that produced nothing — but DON'T
      // do it silently either (the old behavior). Surface it.
      this.recordSyncError(
        doc,
        binding,
        'disk content parsed to zero blocks; live doc left unchanged',
      );
      console.warn(
        `[doc-store] ${doc.docId}: disk→doc reconcile yielded 0 blocks from ${binding.path}; keeping prior state`,
      );
      return decision;
    }
    // Apply as a block-level diff: only blocks whose markdown actually
    // changed are replaced, so anchors on untouched blocks keep resolving.
    // Anchors inside a rewritten block still break — auto-reanchor's
    // snippet-match sweep catches that case on the next tick.
    //
    // Suggestions ride the same block-granularity rule: marks in untouched
    // blocks survive (identity preserved), but an external rewrite of a
    // block CARRYING suggestions replaces the block and its proposals are
    // dropped — accepted-and-surfaced, not silently swallowed. Snapshot the
    // pending sids so the drop can be recorded below (syncError pattern; a
    // snippet-match re-anchor sweep for suggestions is out of scope for v1).
    const sidsBefore = new Set(suggestOps.scanSuggestions(fragment).keys());
    // Whatever this apply is about to take OUT of the doc, before it is gone.
    // `apply` means the live doc equals our last write, which is why it is
    // safe to let disk win — but it says nothing about the file having moved
    // FORWARD. A shortened copy is applied by the same arm as an edited one,
    // and the words it drops were only ever in the `.ydoc`.
    const delta = blockDelta(
      blockTexts(fragment.toArray() as Y.XmlElement[]),
      incomingBlockTexts(blocks),
    );
    doc.ydoc.transact(() => {
      prose.applyMarkdownToFragment(fragment, md, opts);
    }, 'file-watch');
    const sidsAfter = new Set(suggestOps.scanSuggestions(fragment).keys());
    const droppedSids = [...sidsBefore].filter((sid) => !sidsAfter.has(sid));
    // Same as reparseFromDisk: a block whose only defect is a legacy string
    // heading level serializes identically, so the diff keeps it and the
    // attribute has to be repaired separately. Idempotent and cheap.
    prose.normalizeHeadingLevels(doc.ydoc);
    // Serializer-space, NOT the raw disk bytes (RC1): parse→serialize is not
    // byte-identity, so storing `md` here left `currentSerialized ≠
    // lastWritten` forever after — and the NEXT external edit was misjudged
    // a conflict and clobbered by the reassert.
    binding.lastWritten = prose.serializeFragmentToMarkdown(fragment);
    if (droppedSids.length > 0) {
      // Same recoverability philosophy as the conflict backups: the reconcile
      // SUCCEEDED, but pending proposals living in a rewritten block were
      // dropped — record which, so agents/UI can report the loss instead of
      // the suggestions just vanishing. Cleared by the next clean reconcile.
      this.recordSyncError(
        doc,
        binding,
        `external edit dropped pending suggestion(s): ${droppedSids.join(', ')}`,
      );
      console.warn(
        `[doc-store] ${doc.docId}: external edit to ${binding.path} dropped suggestion(s) ${droppedSids.join(', ')}`,
      );
    } else if (delta.net === 0) {
      binding.lastSyncError = undefined;
    }
    // Recorded LAST, so it is the message a reader gets when an apply both
    // shortened the doc and disturbed a suggestion: losing whole blocks is
    // the worse of the two, and `lastSyncError` holds one message. The apply
    // itself STANDS — disk is the source of truth at rest and this does not
    // relitigate that. What changes is that the words it removed are still
    // somewhere, and somebody is told.
    if (worthKeeping(delta)) this.recordBlocksDropped(doc, binding, currentSerialized, delta);
    console.log(
      `[doc-store] ${doc.docId}: applied external edit from ${binding.path} (${blocks.length} blocks)`,
    );
    return decision;
  }

  private scheduleFileWrite(doc: LiveDoc, binding: FileBinding): void {
    // One writer per path (see `writeBackSuspended`). Checked here rather
    // than at each caller so every doc→disk route — the observer, the
    // attach-time reassert, a retarget — is covered by one line.
    if (binding.writeBackSuspended) return;
    // A pending flush makes the binding active (see `bindingIsActive`), so the
    // sweep must be running to see it — it may have stopped itself while the
    // doc was idle.
    if (binding.pollArmed) this.ensureFilePollTicker();
    if (binding.writeTimer) clearTimeout(binding.writeTimer);
    binding.writeTimer = setTimeout(() => {
      binding.writeTimer = null;
      this.writeBoundFileNow(doc, binding);
    }, WRITE_BACK_MS);
  }

  /** The write-back body: what the ~800ms debounce runs when it fires, and
   *  what `flush()` runs synchronously on graceful shutdown. */
  /**
   * Serialize the doc and put it on disk.
   *
   * `how` decides which thread does the writing, and the two callers want
   * opposite things. The 800ms write-back timer fires on a LIVE server
   * against every bound doc, so its write goes on the pool: `writeFileSync`
   * to a provider that has stopped answering parks the event loop exactly the
   * way the hydrate read used to. Shutdown and eviction pass `'sync'`,
   * because `flush()` is the SIGTERM durability contract — it must have the
   * bytes on disk before the process exits, and it has no way to await. On
   * the way down a blocked write delays an exit; on a live server it would
   * stop the whole thing answering.
   */
  private writeBoundFileNow(
    doc: LiveDoc,
    binding: FileBinding,
    how: 'pool' | 'sync' = 'pool',
  ): void {
    try {
      // Home-pinned docs re-verify the destination before every write —
      // "persistence never writes to whatever checkout happens to be
      // current". A retarget already carried this flush's content out (the
      // export) or re-armed one on the new binding; parked means the bytes
      // stay in the live doc.
      if (this.originRepoGuard(doc, binding) !== 'ok') return;
      // And the suspension again, because `flush()` calls this directly: a
      // shutdown must not carry out the write the scheduler refused.
      if (binding.writeBackSuspended) return;
      // Held while the file has not been read since the attach — see
      // `unreadAtAttach`. Marked failed rather than dropped: the `.ydoc` keeps
      // the edit, the index row says a write is owed, and the re-attach that
      // finally reads the file carries it out.
      if (binding.unreadAtAttach) {
        this.failedWrites.add(doc.docId);
        return;
      }
      // Guard (RC2a): the poll has already SEEN an external change and is
      // holding it behind the read debounce. It advanced `lastMtimeMs` the
      // instant it saw the change, so the mtime guard below now compares disk
      // against disk, reports "unchanged", and we write over bytes NOBODY HAS
      // READ — no backup, no syncError, which is the one outcome the conflict
      // arm exists to prevent. Reproduced under CPU load: a `git pull` landing
      // inside the read debounce was overwritten in complete silence.
      //
      // `readTimer` is exactly "a reconcile is pending" (`bindingIsActive`
      // reads it that way), so run that reconcile now rather than racing it.
      // Its conflict arm backs the external version up and re-arms this
      // flush; `flush()` sweeps until quiescent, so a shutdown still carries
      // the live edits out.
      if (binding.readTimer) {
        clearTimeout(binding.readTimer);
        binding.readTimer = null;
        // 'in-sync' means the bytes never actually changed — an mtime touch,
        // or a formatting-variant of our own last write. This flush's content
        // still has to reach disk, so fall through instead of dropping it.
        if (this.reconcileFromDisk(doc, binding) !== 'in-sync') return;
      }
      // Guard (RC2b): if disk moved since we last read or wrote it, we'd be
      // overwriting bytes we have never seen — the poll just hasn't caught
      // up yet. Reconcile first; apply/conflict decides, and the conflict
      // path both backs up the external version and re-schedules our flush.
      if (
        binding.lastMtimeMs !== undefined &&
        !boundFiles.quarantined(binding.path) &&
        existsSync(binding.path)
      ) {
        try {
          const st = statStampSync(binding.path);
          if (st.mtimeMs !== binding.lastMtimeMs || st.size !== binding.lastSize) {
            binding.lastMtimeMs = st.mtimeMs;
            binding.lastSize = st.size;
            this.reconcileFromDisk(doc, binding);
            return;
          }
        } catch {}
      }
      const md =
        contentKind(doc.meta.type) === 'flat'
          ? doc.ydoc.getText('content').toString()
          : prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc));
      if (md === binding.lastWritten) {
        // Nothing to write means nothing to reassert after a restart either.
        this.failedWrites.delete(doc.docId);
        this.p.clearPendingFileWrite(doc.docId);
        return;
      }
      // What lands on disk: `md` itself for flat text, and for prose `md`
      // with the file's own bytes kept for every block the edit did not
      // touch. `lastWritten` stays `md` — the bookkeeping is serializer space.
      const written =
        contentKind(doc.meta.type) === 'flat'
          ? undefined
          : prose.serializeKeepingSourceLayout(
              prose.getProseFragment(doc.ydoc),
              binding.diskSource,
              parseOptsFor(binding.path),
            );
      const bytes = written?.text ?? md;
      // Atomic: write-temp-then-rename, so a crash mid-write can't leave
      // the user's file truncated and a concurrent reader never sees half
      // a document. (Same save pattern editors use.) Rename onto the
      // REALPATH — renaming onto a symlink would replace the link with a
      // regular file instead of writing through it (codex P2).
      if (how === 'pool') {
        // One write at a time per binding. Two pool writes racing to the same
        // path would land in whichever order the pool chose, and the loser
        // would be the newer content. Re-arm instead: the debounce that
        // brought us here will bring us back with whatever the doc says then.
        if (binding.writeInFlight) {
          this.scheduleFileWrite(doc, binding);
          return;
        }
        binding.writeInFlight = true;
        const seq = (binding.writeSeq = (binding.writeSeq ?? 0) + 1);
        // `lastWritten` and the pending flag are set when the bytes LAND, not
        // here: until then the doc genuinely is unsaved, and a restart in
        // between must still reassert it.
        void boundFiles
          .write(binding.path, bytes)
          .then((res) => {
            if (this.bindings.get(doc.docId) !== binding) return;
            // A synchronous flush ran while this write was still on the pool.
            // Both renames target the same file and the order is the pool's
            // to choose, so disk may hold either version and we cannot say
            // which. Claiming `lastWritten` here would assert bytes we did
            // not verify, and clearing the pending flag would tell the next
            // boot there is nothing to reassert. Keep the doc marked instead:
            // the `.ydoc` holds the newer content either way, and a restart
            // puts it back on disk.
            if (binding.writeSeq !== seq) {
              this.failedWrites.add(doc.docId);
              return;
            }
            if (res.status !== 'ok') {
              this.failedWrites.add(doc.docId);
              return;
            }
            binding.lastWritten = md;
            binding.diskSource = written;
            // Record our own write's mtime so the poll doesn't treat the
            // write-back as an external edit and schedule a redundant reconcile.
            if (res.exists) {
              binding.lastMtimeMs = res.mtimeMs;
              // Our own write, as opposed to the mtimes we merely READ. The
              // live-copy rule needs the difference: a `git checkout` in
              // another worktree bumps an mtime with nobody having edited
              // anything, and the copy we ourselves last wrote should not
              // lose to it.
              this.writeBackAt.set(doc.docId, res.mtimeMs);
              binding.lastSize = res.size;
            }
            this.failedWrites.delete(doc.docId);
            this.p.clearPendingFileWrite(doc.docId);
          })
          .finally(() => {
            // Always reached, and the flag's correctness depends on it: a
            // binding stuck `writeInFlight` would never write again and would
            // hold the poll down with it. `boundFiles.write` awaits `race`,
            // which resolves on a `Promise.race` against a deadline timer, so
            // it settles within `boundReadDeadlineMs` even when the syscall
            // underneath never returns.
            binding.writeInFlight = false;
          });
        return;
      }
      // The sync path is shutdown and eviction, and it is unbounded by
      // nature — `writeFileSync` to a provider that has stopped answering
      // never returns, which would hang the very shutdown that exists to save
      // the edit. A path already known hostile is skipped instead: the flush
      // saves nothing there either way, and the `.ydoc` is the durable record
      // the doc comes back from. It stays a failed write, so a restart
      // reasserts it once the file answers again.
      //
      // `busy` is skipped for the same reason and matters more here than at
      // shutdown, because EVICTION runs this on a live server: a doc leaving
      // memory while the pool holds unreturned threads would put a blocking
      // write on the main thread of a process that is still serving. `busy`
      // is also the state that leaves no mark on the path, so the quarantine
      // check alone cannot see it — a merely slow file reaches the sync
      // write with nothing to stop it.
      if (boundFiles.quarantined(binding.path) || boundFiles.busy()) {
        this.failedWrites.add(doc.docId);
        return;
      }
      // Take the generation before writing: a pool write already on the
      // thread must not report its own bytes as the file's content once this
      // one has landed on top of them.
      binding.writeSeq = (binding.writeSeq ?? 0) + 1;
      let target = binding.path;
      try {
        target = realpathSync(binding.path);
      } catch {}
      // A LANE of its own, never the pool writer's temp path. Both can be
      // live at the same moment — SIGTERM arriving while a write-back sits on
      // the thread pool is precisely the case this branch exists for — and
      // two writers filling one temp file interleave their bytes into it,
      // which the rename then publishes as the user's document.
      const tmp = `${target}.cw-flush~`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, target);
      binding.lastWritten = md;
      binding.diskSource = written;
      // Record our own write's mtime so the poll doesn't treat the
      // write-back as an external edit and schedule a redundant reconcile.
      try {
        const st = statStampSync(binding.path);
        binding.lastMtimeMs = st.mtimeMs;
        binding.lastSize = st.size;
      } catch {}
      // The edit is on disk now, so a restart has nothing to repair. Note
      // this is NOT in a `finally`: a write that THREW must keep the flag,
      // because that is exactly the doc a restart still has to reassert.
      this.failedWrites.delete(doc.docId);
      this.p.clearPendingFileWrite(doc.docId);
    } catch (err) {
      // Sticky, because the caller cannot see this: the throw is swallowed
      // here and the write timer is already cleared, so nothing downstream
      // can tell a failed write from a finished one.
      this.failedWrites.add(doc.docId);
      console.error(`[doc-store] file write failed for ${binding.path}:`, err);
    }
  }

  /**
   * The conflict arm of `reconcileFromDisk`, shared by the prose and flat
   * write-back bindings so the two cannot drift apart: back the external
   * version up, record a `syncError` explaining what happened and where the
   * overwritten bytes went, log it, and re-arm the flush that reasserts the
   * live doc onto disk.
   *
   * The message names GIT when the bytes we are about to overwrite are a blob
   * this repository already holds. The mtime poll cannot distinguish
   * `git checkout` / `git stash` / `git pull` from a person saving in an
   * editor — nothing on the file says which it was — so before this, a git
   * operation against a doc with un-flushed live edits was undone a second
   * later with the operator seeing only a clean `git` exit and, if they
   * happened to look, an unexplained dirty working tree. The provenance check
   * is advisory only: it never changes which side wins.
   */
  private recordConflictReassert(doc: LiveDoc, binding: FileBinding, external: string): void {
    const backupPath = this.backupExternalVersion(doc.docId, external);
    const gitHint = gitConflictHint(binding.path, external);
    this.recordSyncError(
      doc,
      binding,
      'external file change collided with un-flushed live edits; kept live edits and reasserted them to disk. ' +
        (backupPath
          ? `The external version was saved to ${backupPath} — restore it and reparse_from_disk to make it win.`
          : 'Backup of the external version FAILED — it survives only in your editor/git history.') +
        gitHint,
      backupPath,
    );
    console.warn(
      `[doc-store] ${doc.docId}: disk↔doc conflict for ${binding.path}; kept live edits, reasserting to disk` +
        (backupPath ? ` (external version backed up to ${backupPath})` : '') +
        (gitHint ? ' — the overwritten bytes came from git, not an editor save' : ''),
    );
    this.scheduleFileWrite(doc, binding);
  }

  /**
   * A disk-wins replacement REMOVED blocks from the doc: keep the doc's own
   * copy, say where it went, and announce it.
   *
   * The counterpart of `recordConflictReassert`, for the arm that reaches the
   * opposite verdict. When the live doc wins, the external version is backed
   * up so the loser is recoverable; when DISK wins, nothing was — the doc's
   * copy went straight into the transact and the only trace of the words was
   * the `.ydoc` that had just been overwritten. That is how a meeting's notes
   * can leave the doc and the file together with nothing kept anywhere: the
   * file goes backwards (a cloud-sync provider handing back the revision it
   * held, a materialization that answers short, an editor saving a stale
   * buffer), the arbitration correctly reads a clean doc and an externally
   * changed file, and the section is gone.
   *
   * This does not change who wins — see `blockDelta` for why the
   * server cannot tell a regression from a person's deletion. It makes the
   * loss recoverable and visible, which is what "the file is the source of
   * truth at rest" owes the side that loses.
   *
   * Never throws: the backup is best-effort and the reconcile has already
   * happened by the time this runs.
   */
  private recordBlocksDropped(
    doc: LiveDoc,
    binding: FileBinding,
    liveBefore: string,
    delta: BlockDelta,
  ): void {
    // The COPY is taken when a SECTION left or the file came back shorter
    // (`worthKeeping`). An ordinary reword moves neither, so editing prose in
    // another editor still leaves nothing behind — which is what the existing
    // clean-apply control asserts.
    const backupPath = this.keepLiveCopy(doc.docId, liveBefore);
    // The ALARM is raised only when the file actually came back shorter. It
    // reaches `get_doc`, every edit-tool response and every watching session,
    // so a section SWAP keeps the copy and stays quiet: nothing is missing
    // from the file for a person to go and restore.
    if (delta.net === 0) {
      console.warn(
        `[doc-store] ${doc.docId}: external change to ${binding.path} replaced ` +
          `${delta.removed} block(s) the doc held` +
          (backupPath ? `; the doc's copy was kept at ${backupPath}` : ''),
      );
      return;
    }
    const blocks = `${delta.net} block${delta.net === 1 ? '' : 's'}`;
    this.recordSyncError(
      doc,
      binding,
      `the bound file no longer holds ${blocks} the doc did; disk won and those blocks are gone from the doc. ` +
        (backupPath
          ? `The doc's copy was saved to ${backupPath} — restore it over the file and reparse_from_disk to bring the blocks back.`
          : "Backup of the doc's copy FAILED — those blocks survive only in an earlier .ydoc snapshot."),
      backupPath,
    );
    console.warn(
      `[doc-store] ${doc.docId}: ${binding.path} came back short; ${blocks} dropped from the doc` +
        (backupPath ? ` (the doc's copy was backed up to ${backupPath})` : ''),
    );
  }

  /**
   * Snapshot the doc's own content before a disk-wins replacement, bounded.
   *
   * Two bounds, because this fires on a section leaving as well as on a
   * shortened file:
   *
   *   - **Nothing is reached on a quiet poll.** A reconcile runs only on a
   *     stat that actually changed, so the ceiling is "one small file per
   *     external save that took a section or shortened the file", not per
   *     tick. The write path is
   *     untaxed either way — this is on the READ side.
   *   - **The same content is never kept twice in a row**, and a doc keeps at
   *     most {@link LIVE_BACKUP_CAP} of them; past that the oldest goes. That
   *     is the rotation `backupReplacedContent` already runs for
   *     `set_doc_content`, and these are transient recovery copies of content
   *     the `.ydoc` history also holds — the one class CLAUDE.md names as
   *     correctly hard-deleted.
   *
   * De-duplication is off the binding rather than the directory, so the
   * common case costs no syscall at all. A restart forgets it, which costs
   * one extra file.
   */
  private keepLiveCopy(docId: string, content: string): string | null {
    if (this.lastLiveBackup.get(docId) === content) return null;
    const path = this.backupExternalVersion(docId, content, 'live');
    if (path === null) return null;
    this.lastLiveBackup.set(docId, content);
    this.rotateLiveCopies(docId);
    return path;
  }

  /** Drop the oldest live copies of one doc past the cap. Best-effort: a
   *  directory that will not list is a rotation skipped, never a throw into
   *  a reconcile that has already happened. */
  private rotateLiveCopies(docId: string): void {
    try {
      const dir = join(this.p.dataDir(), 'clobber-backups');
      const prefix = `${docId.replace(/[^A-Za-z0-9._-]/g, '_')}-live-`;
      // The names carry a millisecond stamp, so lexical order IS age order.
      const mine = readdirSync(dir)
        .filter((name) => name.startsWith(prefix) && name.endsWith('.md'))
        .sort();
      for (const stale of mine.slice(0, Math.max(0, mine.length - LIVE_BACKUP_CAP))) {
        rmSync(join(dir, stale), { force: true });
      }
    } catch (err) {
      console.error(`[doc-store] live-copy rotation failed for ${docId}:`, err);
    }
  }

  /**
   * Record a sync failure on a binding AND announce it on the doc's event
   * channels as a `doc.sync_error` broadcast.
   *
   * Every `lastSyncError` write funnels through here for the same reason
   * thread changes funnel through `fireEvent`: a fifth failure mode added
   * later gets the broadcast for free rather than silently going without.
   * Before this, the error was only readable via get_doc or a later edit
   * response — surfaces the party who just LOST content (whoever ran the
   * `git stash` whose bytes now exist only in clobber-backups/, or saved in
   * an editor) never touches. Watching sessions do, so the loss is announced
   * where the watchers already are (proposed on a board ticket, 2026-08).
   */
  private recordSyncError(
    doc: LiveDoc,
    binding: FileBinding,
    message: string,
    backupPath?: string | null,
  ): void {
    const at = Date.now();
    binding.lastSyncError = { message, at };
    doc.seq++;
    const decorate = (m: DocMeta) => this.p.decorate(m);
    this.p.broadcast(doc, {
      event: 'doc.sync_error',
      docId: doc.docId,
      doc: decorate(doc.meta),
      path: doc.meta.relPath ?? binding.path,
      ...(backupPath ? { backupPath } : {}),
      message,
      at,
      seq: doc.seq,
    });
  }

  /**
   * Snapshot an external file version we are about to overwrite into
   * `<dataDir>/clobber-backups/`, so a conflict reassert is recoverable
   * instead of destructive. Returns the backup path, or null on failure —
   * never throws (the reconcile must proceed either way).
   */
  private backupExternalVersion(docId: string, content: string, label = 'external'): string | null {
    try {
      const dir = join(this.p.dataDir(), 'clobber-backups');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const safeId = docId.replace(/[^A-Za-z0-9._-]/g, '_');
      const stem = join(dir, `${safeId}-${label}-${Date.now()}`);
      // `wx` rather than a plain write: the stamp is milliseconds, and two
      // drops inside one millisecond would otherwise have the second silently
      // overwrite the first — one recovery copy destroying another, which is
      // the loss this whole path exists to prevent. The suffix keeps lexical
      // order equal to age order, which the rotation below relies on.
      for (let n = 0; n < 100; n++) {
        const file = n === 0 ? `${stem}.md` : `${stem}-${String(n).padStart(2, '0')}.md`;
        try {
          writeFileSync(file, content, { flag: 'wx' });
          return file;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
      }
      throw new Error('100 backups in one millisecond');
    } catch (err) {
      console.error(`[doc-store] clobber backup failed for ${docId}:`, err);
      return null;
    }
  }

  /**
   * Is the bound .md at least as new as the persisted .ydoc? Decides who wins
   * a no-bookkeeping attach (post-restart): the .ydoc's mtime marks the live
   * doc's last change, so an older .md means the crash beat the write-back
   * debounce and disk is the STALE side. Errs toward disk (the documented
   * source of truth at rest) when either stat fails.
   */
  /**
   * Is the bound file at least as new as the persisted `.ydoc`?
   *
   * The `.ydoc` half stays a whole-millisecond `mtimeMs` while the file's is
   * read to the nanosecond, and the two are only ever compared with `>=`, so a
   * tie still goes to disk exactly as it did before the file's stamp got
   * finer. One window is not identical: a fractional-millisecond double
   * resolves ~244ns at today's epoch, so a file mtime in the top ~122ns of a
   * millisecond rounds UP to the next one while a plain `statSync().mtimeMs`
   * truncates down. Inside that window a same-millisecond file now reads as
   * newer where it used to read as older. It errs toward disk — the
   * documented source of truth at rest, and the side a tie already went to —
   * and `liveWins` is what a caller holding un-flushed content passes instead
   * of arguing about clocks.
   *
   * `knownMtimeMs` is the preread's, and passing it is what keeps this off
   * the main thread: the caller has already paid for that stat on the pool,
   * and re-taking it here used to put a blocking syscall back on the hostile
   * path even when the read had been prewarmed. The `.ydoc` is server-owned
   * local state and never on a sync folder, so its stat stays synchronous.
   */
  /**
   * Has the bound file outlived the write-back claim being made over it?
   *
   * `liveWins` says "the live doc holds content disk has never held". At
   * boot it is read off the doc's INDEX ROW, and that row lasts as long as
   * the `.ydoc`: a doc-set that went dormant mid-write still claimed a write
   * three weeks later, and the read that finally woke it flushed August's
   * content over files a person had edited since (2026-09-16).
   *
   * What separates the two is not which side is newer — a crash fixture and
   * a dormant set both leave the file later than the `.ydoc`, by
   * milliseconds in one case and by weeks in the other. It is how long the
   * claim has been outstanding. A write owed at shutdown is carried out by
   * the next boot, minutes or hours later; a file that has moved on a whole
   * day past the doc's last save belongs to a set nobody is running any
   * more. So the claim is given a lifetime instead of an unbounded one, and
   * `STALE_CLAIM_AFTER_MS` is that lifetime — the one number here that is a
   * judgement rather than a fact.
   *
   * Errs toward the CLAIM when a stat fails: with no evidence, a veto has
   * nothing to stand on.
   */
  private fileOutlivedClaim(docId: string, filePath: string, knownMtimeMs?: number): boolean {
    try {
      const ydocPath = this.p.ydocPath(docId);
      if (!existsSync(ydocPath)) return false;
      const stateMtime = statSync(ydocPath).mtimeMs;
      const fileMtime =
        knownMtimeMs ??
        (boundFiles.quarantined(filePath) ? undefined : statStampSync(filePath).mtimeMs);
      if (fileMtime === undefined) return false;
      // A claim only ever loses to a file that has actually moved past it.
      if (fileMtime <= stateMtime) return false;
      // Two ways to be too old, and BOTH are needed. The gap between the two
      // writes catches a file edited long after the doc's last save. The
      // claim's own elapsed age catches the other order — a file edited a
      // minute after the save, on a doc nobody opened again for a month —
      // where the gap stays small forever.
      return (
        fileMtime - stateMtime > STALE_CLAIM_AFTER_MS ||
        Date.now() - stateMtime > STALE_CLAIM_AFTER_MS
      );
    } catch {
      return false;
    }
  }

  private diskNewerThanState(docId: string, filePath: string, knownMtimeMs?: number): boolean {
    try {
      const ydocPath = this.p.ydocPath(docId);
      if (!existsSync(ydocPath)) return true;
      const stateMtime = statSync(ydocPath).mtimeMs;
      if (knownMtimeMs !== undefined) return knownMtimeMs >= stateMtime;
      if (boundFiles.quarantined(filePath)) return true;
      return statStampSync(filePath).mtimeMs >= stateMtime;
    } catch {
      return true;
    }
  }

  /**
   * Settle which doc may write to `abs`, now that `docId` is binding it.
   *
   * Two doc-sets over one path is not an error — a refreshed diff review
   * binds the same files the set it supersedes bound — but two WRITERS is.
   * The newer doc (by `createdAt`) keeps the write-back; every older one
   * bound to the same path is suspended, and a newcomer that is itself the
   * older side is handed back the sentence to suspend ITSELF with, so the
   * verdict does not depend on which order the two hydrated in.
   *
   * Returns the reason this attach must not write, or `undefined` when it
   * owns the path.
   */
  /**
   * The winner of a contested path writes its own content once the loser's
   * in-flight write has had its chance to land.
   *
   * Bumping the loser's sequence stops its bookkeeping but not its rename, so
   * without this the last bytes on disk can be the superseded doc's — the
   * exact failure this arbitration exists to end. Scheduling is enough: the
   * write-back debounce is longer than a pool write's turnaround, and a
   * second identical write is a no-op the reconcile treats as in-sync.
   */
  private reassertAfterContest(docId: string, binding: FileBinding): void {
    const doc = this.p.residentDoc(docId);
    if (doc) this.scheduleFileWrite(doc, binding);
  }

  private claimPathOwnership(docId: string, abs: string): PathClaim {
    const mine = this.p.residentDoc(docId)?.meta.createdAt ?? 0;
    const claim: PathClaim = {};
    for (const [otherId, other] of this.bindings) {
      if (otherId === docId || other.path !== abs) continue;
      // Only WRITERS can break the one-writer rule. A read-only code member,
      // a pinned diff and a watched mockup never write doc→disk, so counting
      // them here would silently disable the only editable binding on a path
      // depending on which hydrated first (codex P2).
      if (!bindingWrites(other)) continue;
      const theirs = this.p.residentDoc(otherId)?.meta.createdAt ?? 0;
      if (theirs > mine) {
        claim.refusal =
          `a newer doc (${otherId}) is bound to this file, so this doc no longer writes to it; ` +
          'content is served from the .ydoc';
      } else {
        // Its write may already be at the pool, past every check — the rename
        // lands whatever we do here. Tell the caller, so the winner writes
        // after it and disk ends on the winner's bytes.
        if (other.writeInFlight) claim.contested = true;
        this.suspendWriteBack(
          otherId,
          other,
          `a newer doc (${docId}) is bound to this file, so this doc no longer writes to it; ` +
            'content is served from the .ydoc',
        );
      }
    }
    return claim;
  }

  /** Turn one binding's doc→disk direction off, dropping any flush it had
   *  already armed. Idempotent: the same reason twice says nothing twice. */
  private suspendWriteBack(docId: string, binding: FileBinding, reason: string): void {
    if (binding.writeBackSuspended === reason) return;
    binding.writeBackSuspended = reason;
    if (binding.writeTimer) {
      clearTimeout(binding.writeTimer);
      binding.writeTimer = null;
    }
    // And the PERSISTED claim with it. Cancelling only the timer leaves
    // `pendingFileWrite` on the index row — the `.ydoc` save records that
    // marker at 200ms, ahead of the write-back's own debounce — and the next
    // boot's reassert opens this doc ALONE, with no newer binding resident to
    // suspend it again. The write we just refused would land then instead.
    this.failedWrites.delete(docId);
    this.p.clearPendingFileWrite(docId);
    // A write already handed to the pool cannot be recalled. Bumping the
    // sequence makes its completion take the "somebody else wrote too"
    // branch — it claims no `lastWritten` and clears no marker — and the
    // caller re-arms the WINNER so the last bytes on disk are the winner's.
    // The residual window is real and narrow: between the loser's rename and
    // the winner's, disk holds the loser's content.
    if (binding.writeInFlight) binding.writeSeq = (binding.writeSeq ?? 0) + 1;
    binding.lastSyncError = { message: reason, at: Date.now() };
    console.warn(`[doc-store] ${docId}: write-back suspended — ${reason}`);
  }

  /**
   * Run a disk→doc reconcile for a bound doc right now (instead of waiting
   * for the mtime poll) and report the decision. Used by tests to pin the
   * reconcile policy without timing races, and available to routes for an
   * explicit "sync now".
   */
  reconcileNow(
    docId: string,
  ): 'in-sync' | 'catch-up' | 'apply' | 'conflict' | 'no-binding' | 'missing' {
    const doc = this.p.doc(docId);
    // Every keyed lookup below takes the RESOLVED id: `docId` may be an
    // alias, which resolves to a doc but keys no binding and no clock.
    const binding = doc ? this.bindings.get(doc.docId) : undefined;
    if (!doc || !binding) return 'no-binding';
    this.touchDoc(doc.docId);
    if (boundFiles.quarantined(binding.path)) return 'missing';
    if (!existsSync(binding.path)) return 'missing';
    // Advance the poll baseline the same way the poll itself would, so this
    // manual reconcile doesn't get replayed on the next tick.
    try {
      const st = statStampSync(binding.path);
      binding.lastMtimeMs = st.mtimeMs;
      binding.lastSize = st.size;
    } catch {}
    if (binding.readTimer) {
      clearTimeout(binding.readTimer);
      binding.readTimer = null;
    }
    return this.reconcileFromDisk(doc, binding);
  }

  /** The doc's pending sync trouble, if any — conflicts, parse failures. */
  getSyncError(docId: string): { message: string; at: number } | undefined {
    return this.bindings.get(docId)?.lastSyncError;
  }

  /**
   * Bound documents whose write-back flush has been scheduled and has not
   * fired yet — i.e. the live doc holds edits that disk does not.
   *
   * This is the window in which an external write to the same file LOSES:
   * the poll classifies it as a conflict, the live doc wins, and the file is
   * reasserted ~800ms later. A `git pull` is such a write, so a deploy asks
   * this before it fast-forwards anything.
   *
   * `root` limits the answer to files under one directory, because the
   * question is only ever about the tree that is about to be rewritten — a
   * document bound from some other repo has no bearing on it. Containment
   * goes through `isWithinRoot`, which realpaths both sides: this machine
   * reaches the same home directory through two paths, and a lexical prefix
   * test answers no for half of them.
   *
   * One consequence of `isWithinRoot` answering closed: a binding whose file
   * has been deleted is not reported. That is the right way round — the
   * caller uses this to decide whether to refuse, and a missing file is not
   * a reason to block a deploy.
   */
  pendingFileWrites(root?: string): { docId: string; path: string }[] {
    const out: { docId: string; path: string }[] = [];
    for (const [docId, binding] of this.bindings) {
      if (!this.hasPendingWrite(docId)) continue;
      if (root !== undefined && !isWithinRoot(root, binding.path)) continue;
      out.push({ docId, path: binding.path });
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // What the doc lifecycle asks the bindings. Each of these replaces a
  // reach into the binding map from `doc-store.ts`; the map itself never leaves
  // this file.
  // ---------------------------------------------------------------------

  /**
   * Every doc bound to a file under `root`, pending write or not.
   *
   * `pendingFileWrites` answers a different question — what would be LOST if
   * this went away now — and a checkout being retired has to reach every doc
   * bound inside it, including the ones with nothing outstanding, because
   * their bindings are about to name a path that does not exist.
   */
  boundUnder(root: string): { docId: string; path: string }[] {
    const out: { docId: string; path: string }[] = [];
    for (const [docId, binding] of this.bindings) {
      if (isWithinRoot(root, binding.path)) out.push({ docId, path: binding.path });
    }
    return out;
  }

  /** Is this doc file-backed right now? */
  has(docId: string): boolean {
    return this.bindings.has(docId);
  }

  /** The file this doc is bound to, if any. */
  pathOf(docId: string): string | undefined {
    return this.bindings.get(docId)?.path;
  }

  /** The binding as a doc-status surface sees it: bound where, wedged how.
   *  A read-only view, so a status route cannot reach a live timer. */
  describe(
    docId: string,
  ): { path: string; syncError?: { message: string; at: number } } | undefined {
    const binding = this.bindings.get(docId);
    if (!binding) return undefined;
    return {
      path: binding.path,
      ...(binding.lastSyncError ? { syncError: binding.lastSyncError } : {}),
    };
  }

  /**
   * A write-back is outstanding — the live doc holds edits disk does not.
   * What `pendingFileWrite` on the index row records.
   *
   * A write on the thread pool counts. It has no timer (the timer is what
   * started it) and it has not landed, so answering "no" here is how a doc
   * mid-write became invisible to the shutdown sweep, to the deploy's
   * refusal check, and to the eviction guard, all at once.
   *
   * So does a write held for a file not yet read (`unreadAtAttach`): it has
   * neither, and it is still owed. Evicting that doc would drop the poll that
   * is waiting to carry it out.
   */
  hasPendingWrite(docId: string): boolean {
    const binding = this.bindings.get(docId);
    if (!binding) return false;
    if (binding.unreadAtAttach && this.failedWrites.has(docId)) return true;
    return binding.writeTimer != null || binding.writeInFlight === true;
  }

  /** The last write-back threw; a restart still has to reassert this doc. */
  hasFailedWrite(docId: string): boolean {
    return this.failedWrites.has(docId);
  }

  /** The marker's job is done — the index row carries it now. */
  forgetFailedWrite(docId: string): void {
    this.failedWrites.delete(docId);
  }

  /** Docs with an armed write-back, for `flush()`'s sweep-until-quiescent. */
  pendingWriteDocIds(): string[] {
    const out: string[] = [];
    for (const [docId, binding] of this.bindings) {
      if (binding.writeTimer || binding.writeInFlight) out.push(docId);
    }
    return out;
  }

  /**
   * Run one doc's armed write-back NOW instead of waiting out the debounce —
   * the shutdown path. The timer is cleared whether or not the doc is still
   * in memory: a timer left armed on an evicted doc fires into nothing.
   */
  flushWrite(docId: string, doc: LiveDoc | undefined): void {
    const binding = this.bindings.get(docId);
    // An armed timer OR a write already on the pool. The second is the one
    // that used to be skipped: `flush()` has no way to await it, so the only
    // way to keep the SIGTERM contract is to write the current content
    // synchronously here and let the generation counter sort out what the
    // pool write may claim afterwards.
    if (!binding || (!binding.writeTimer && !binding.writeInFlight)) return;
    if (binding.writeTimer) clearTimeout(binding.writeTimer);
    binding.writeTimer = null;
    if (doc) this.writeBoundFileNow(doc, binding, 'sync');
  }

  /**
   * The eviction flush: same order and same calls as `flush()`, so a doc
   * leaving memory is saved exactly the way a shutdown saves it. A throw is
   * loud and does NOT stop the eviction — the `.ydoc` is the durable record,
   * and refusing to evict here would pin a wedged doc in memory forever.
   */
  flushWriteBeforeEvict(doc: LiveDoc): void {
    const binding = this.bindings.get(doc.docId);
    if (!binding || (!binding.writeTimer && !binding.writeInFlight)) return;
    if (binding.writeTimer) clearTimeout(binding.writeTimer);
    binding.writeTimer = null;
    try {
      this.writeBoundFileNow(doc, binding, 'sync');
    } catch (err) {
      console.error(`[doc-store] evict ${doc.docId}: write-back failed:`, err);
    }
  }

  /**
   * Let go of a doc's file: cancel both debounces, take it out of the shared
   * sweep, and drop the binding. Clearing `lastMtimeMs` with it is the
   * write-loss guard — a stale `lastWritten` should not be reachable at all.
   * A no-op for a doc that was never bound.
   */
  discard(docId: string): void {
    // Dropped whether or not the doc was bound: the de-dup entry outlives the
    // binding otherwise, and it is a whole document's markdown.
    this.lastLiveBackup.delete(docId);
    const binding = this.bindings.get(docId);
    if (!binding) return;
    if (binding.writeTimer) clearTimeout(binding.writeTimer);
    binding.writeTimer = null;
    if (binding.readTimer) clearTimeout(binding.readTimer);
    binding.readTimer = null;
    binding.pollArmed = false;
    this.bindings.delete(docId);
    this.rearbitratePath(binding.path);
  }

  /**
   * A binding on `path` has gone away — settle who writes to it now.
   *
   * Without this, suspending is one-way: archive or evict the newer doc and
   * the older one keeps taking edits and silently writing none of them, even
   * though it is the only writer left. The rule is the one `claimPathOwnership`
   * applies, re-run over whoever remains, so there is one answer to "who owns
   * this path" rather than two that can disagree.
   */
  private rearbitratePath(path: string): void {
    const holders = [...this.bindings].filter(([, b]) => b.path === path && bindingWrites(b));
    if (holders.length === 0) return;
    let newestId = '';
    let newestAt = Number.NEGATIVE_INFINITY;
    for (const [id] of holders) {
      const at = this.p.residentDoc(id)?.meta.createdAt ?? 0;
      if (at > newestAt) {
        newestAt = at;
        newestId = id;
      }
    }
    for (const [id, b] of holders) {
      if (id === newestId) {
        if (b.writeBackSuspended !== undefined) {
          b.writeBackSuspended = undefined;
          console.warn(
            `[doc-store] ${id}: write-back resumed — it is the only doc bound to its file`,
          );
          // Every edit made while it was suspended returned from
          // `scheduleFileWrite` having armed nothing, so without this they
          // reach disk only if somebody edits again (codex P1). The doc is
          // the right thing to write: disk→doc never stopped, so it already
          // holds whatever the winner wrote while it was out.
          const doc = this.p.residentDoc(id);
          if (doc) this.scheduleFileWrite(doc, b);
        }
        continue;
      }
      this.suspendWriteBack(
        id,
        b,
        `a newer doc (${newestId}) is bound to this file, so this doc no longer writes to it; ` +
          'content is served from the .ydoc',
      );
    }
  }

  /** Stop the shared mtime sweep — part of `DocStore.stop()`. */
  stopPolling(): void {
    if (this.pollTicker) clearInterval(this.pollTicker);
    this.pollTicker = null;
  }

  /**
   * What `DocStore.stats()` reports about the bindings: how many exist, how many
   * the sweep would stat on this tick, how many debounce timers they hold,
   * and who has been promoting them into the fast lane.
   */
  stats(now: number): {
    count: number;
    active: number;
    timers: number;
    /** The shared mtime sweep's own interval: 1 while it is running, else 0. */
    tickers: number;
    activations: { tag: string; count: number }[];
    activationsTotal: number;
  } {
    let active = 0;
    let timers = 0;
    for (const [docId, binding] of this.bindings) {
      if (this.bindingIsActive(docId, binding, now)) active++;
      if (binding.writeTimer) timers++;
      if (binding.readTimer) timers++;
    }
    return {
      count: this.bindings.size,
      active,
      timers,
      tickers: this.pollTicker ? 1 : 0,
      activations: [...this.activations.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, ACTIVATION_TAGS_REPORTED)
        .map(([tag, count]) => ({ tag, count })),
      activationsTotal: [...this.activations.values()].reduce((a, b) => a + b, 0),
    };
  }
}
