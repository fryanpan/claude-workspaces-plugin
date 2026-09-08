import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every capture a mockup has ever had, kept instead of overwritten.
 *
 * `mockup-capture.ts` keeps ONE copy — the last thing anyone was shown — so a
 * link outlives the scratch directory its source sat in. That copy answers a
 * different question from this file's. It is the fallback; these are the
 * rounds.
 *
 * A mockup iterates: an agent edits the file, the reviewer's page updates
 * under him, and the version he was looking at when he left a comment is gone
 * a minute later. His thread survives (it lives in the `.ydoc`), but the page
 * it points at does not, so "what did this look like when I said that" had no
 * answer at all. Keeping each distinct capture makes it a lookup rather than a
 * rebuild.
 *
 * Shape on disk, beside the `.ydoc` and the capture:
 *
 *   <docId>.mock.html            the current capture (mockup-capture.ts)
 *   <docId>.mock.v3.html         round 3
 *   <docId>.mock.versions.json   the index: which rounds exist, and when
 *
 * The newest round duplicates the capture's bytes. That is deliberate: the
 * capture is read on the serve path by code that predates this file and must
 * keep working when the index is missing, corrupt, or from a build that never
 * wrote one. A few kilobytes of HTML is a cheap price for the two mechanisms
 * being independent.
 *
 * Identical content is NOT a new round. An agent that rewrites a file with the
 * same bytes, or a serve that re-captures an unchanged source, would otherwise
 * fill the history with rounds nobody made.
 */

/** How many rounds are kept before the oldest is dropped. */
export const MAX_MOCKUP_VERSIONS = 20;

export interface MockupVersion {
  /** 1-based, monotonically increasing for the life of the doc. Never reused,
   *  so a link to `?v=3` cannot come back as somebody else's round 3 after a
   *  prune. */
  v: number;
  /** ms epoch the round was recorded. */
  at: number;
  /** Byte length of the captured HTML — enough for a reader to tell two
   *  rounds apart without opening both. */
  bytes: number;
}

interface VersionIndex {
  /** Highest version ever minted, including pruned ones. */
  next: number;
  versions: MockupVersion[];
}

const EMPTY: VersionIndex = { next: 1, versions: [] };

function indexPath(dir: string, docId: string): string {
  return join(dir, `${docId}.mock.versions.json`);
}

/** Where one round's HTML lives. */
export function mockupVersionPath(dir: string, docId: string, v: number): string {
  return join(dir, `${docId}.mock.v${v}.html`);
}

function readIndex(dir: string, docId: string): VersionIndex {
  const path = indexPath(dir, docId);
  if (!existsSync(path)) return { ...EMPTY, versions: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<VersionIndex>;
    const versions = Array.isArray(parsed.versions)
      ? parsed.versions.filter(
          (r): r is MockupVersion =>
            !!r &&
            typeof r.v === 'number' &&
            typeof r.at === 'number' &&
            typeof r.bytes === 'number',
        )
      : [];
    const highest = versions.reduce((max, r) => Math.max(max, r.v), 0);
    // A `next` behind the rounds on disk would mint a number that is already
    // taken — the one way this index can hand out a colliding id. Trust the
    // rounds over the counter.
    const next = typeof parsed.next === 'number' ? Math.max(parsed.next, highest + 1) : highest + 1;
    return { next, versions };
  } catch (err) {
    // A corrupt index must not take the rounds with it: the HTML files are
    // still there and still readable by number. Starting the counter above
    // anything on disk is what keeps a rebuilt index from colliding.
    console.error(`[mockup-versions] unreadable index for ${docId}:`, err);
    return { next: highestOnDisk(dir, docId) + 1, versions: [] };
  }
}

/** The largest round number with a file on disk — the recovery path's floor. */
function highestOnDisk(dir: string, docId: string): number {
  const prefix = `${docId}.mock.v`;
  let max = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.html')) continue;
      const n = Number(name.slice(prefix.length, -'.html'.length));
      if (Number.isInteger(n) && n > max) max = n;
    }
  } catch {
    /* best effort — a missing data dir has no rounds either way */
  }
  return max;
}

function writeIndex(dir: string, docId: string, index: VersionIndex): void {
  // Same rename-over-a-sibling discipline as the capture: a truncated index is
  // a mockup whose history has silently gone, and the rounds it names are
  // still on disk.
  const path = indexPath(dir, docId);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(index));
  renameSync(tmp, path);
}

/** The rounds this mockup has, oldest first. Empty when it has none. */
export function listMockupVersions(dir: string, docId: string): MockupVersion[] {
  return readIndex(dir, docId).versions;
}

/** One round's HTML, or null when that round was never written or was pruned. */
export function readMockupVersion(dir: string, docId: string, v: number): string | null {
  if (!Number.isInteger(v) || v < 1) return null;
  const path = mockupVersionPath(dir, docId, v);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`[mockup-versions] unreadable round ${v} for ${docId}:`, err);
    return null;
  }
}

export type RecordOutcome =
  /** A new round was written; `version` names it. */
  | { recorded: true; version: number; versions: MockupVersion[] }
  /** These exact bytes are already the newest round. */
  | { recorded: false; version: number; versions: MockupVersion[] }
  /** The write failed; nothing changed. */
  | { recorded: false; version: null; versions: MockupVersion[] };

/**
 * Record `html` as this mockup's newest round, unless it already is one.
 *
 * Comparison is against the NEWEST round only, not every round. Rounds are a
 * history, and a mock that reverts to the shape it had two rounds ago has
 * genuinely made a third change — collapsing it onto the old round would make
 * the timeline lie about when the reviewer saw what.
 */
export function recordMockupVersion(dir: string, docId: string, html: string): RecordOutcome {
  const index = readIndex(dir, docId);
  const latest = index.versions[index.versions.length - 1];
  if (latest) {
    const current = readMockupVersion(dir, docId, latest.v);
    if (current === html) return { recorded: false, version: latest.v, versions: index.versions };
  }
  const v = index.next;
  const path = mockupVersionPath(dir, docId, v);
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, html);
    renameSync(tmp, path);
  } catch (err) {
    console.error(`[mockup-versions] failed to record round ${v} for ${docId}:`, err);
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort — a stray .tmp is inert */
    }
    return { recorded: false, version: null, versions: index.versions };
  }
  const versions = [...index.versions, { v, at: Date.now(), bytes: Buffer.byteLength(html) }];
  // Prune from the OLD end, and only after the new round is durable: a prune
  // that ran first would, on a failed write, leave the history one shorter for
  // nothing.
  while (versions.length > MAX_MOCKUP_VERSIONS) {
    const dropped = versions.shift();
    if (!dropped) break;
    try {
      rmSync(mockupVersionPath(dir, docId, dropped.v), { force: true });
    } catch {
      /* best effort — an orphan round file is inert and unreferenced */
    }
  }
  try {
    writeIndex(dir, docId, { next: v + 1, versions });
  } catch (err) {
    // The round itself landed. An index that could not be written means the
    // NEXT record re-derives the counter from disk, so nothing collides — the
    // cost is that this round is not listed until then.
    console.error(`[mockup-versions] failed to write the index for ${docId}:`, err);
  }
  return { recorded: true, version: v, versions };
}

/**
 * Drop every round and the index. Called from the purge path only, beside
 * `deleteMockupCapture` and for the same reason: archiving addresses a doc by
 * id in the data dir, so an unarchived mockup finds its history where it left
 * it, and a purge is the one call asking for the bytes to be gone.
 */
export function deleteMockupVersions(dir: string, docId: string): void {
  for (const r of listMockupVersions(dir, docId)) {
    try {
      rmSync(mockupVersionPath(dir, docId, r.v), { force: true });
    } catch {
      /* best effort */
    }
  }
  // Rounds whose index entry was lost still hold bytes. Sweep by name too.
  const prefix = `${docId}.mock.v`;
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(prefix)) rmSync(join(dir, name), { force: true });
    }
  } catch {
    /* best effort */
  }
  try {
    rmSync(indexPath(dir, docId), { force: true });
    rmSync(`${indexPath(dir, docId)}.tmp`, { force: true });
  } catch {
    /* best effort */
  }
}
