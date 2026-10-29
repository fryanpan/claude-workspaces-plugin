/**
 * One board out of one server's data dir, and into another's, with the same
 * ids. `move-board.ts` drives it; this file only reads and writes data dirs.
 *
 * What a board owns, read off the stores (the list the PR and
 * docs/process/project-machine.md "Moving a board" carry):
 *
 * - `workspaces/<board>.*`: the board record, its tasks, goal rows and review
 *   items (`.tasks.json`), its event log, agent-note log, comment and voice
 *   queues, home brief and load reports. Not `.attachments.json`: that is
 *   which agent sessions are attached right now, and they attach again on the
 *   new server.
 * - The docs: `ws:<board>`, `task:<id>` for every task and goal row (their
 *   threads), and every doc in the board's `docIds`. Each doc's `.ydoc`, its
 *   voice-feedback log and recordings, its meetings folder and huddle notes.
 * - Entries keyed by the board in seven shared files (`MERGES`): share links,
 *   members and audience; Access shares; the sharing close and lock flags;
 *   lead ranks; the board summary; dispatch reports; the review-answer log.
 *
 * What stays behind, and why: each doc's `.private.json` and the board's
 * `notesHome` are paths on the Mac (host facts, which never leave it; the
 * paths come back as `bindings` for `board-sync.ts`); `.index.json` is a cache
 * the server rebuilds at boot; board agent tokens, GitHub push keys and
 * thread-opener proofs are signed or minted by the source server and mean
 * nothing to another; stall, nudge and escalation stamps are rebuilt from the
 * board; `activity.jsonl`, `chat-audit.jsonl` and `page-loads.jsonl` are the
 * owner's own analytics of the Mac; archived docs in `_archive/` stay
 * archived where they are.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { withoutPrivateMeta } from '../../packages/server/src/private-meta.ts';

export const BUNDLE_FORMAT = 'cw-board-bundle-1';

/** A board id as the server mints and checks them. */
export const BOARD_ID = /^w-[A-Za-z0-9_-]{6,64}$/;
/** A doc id that is safe as one file name: no slash, no `..`. */
const DOC_ID = /^(?!\.)[A-Za-z0-9:._-]{1,200}$/;

export interface BundleFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface Binding {
  docId: string;
  /** The `.md` on the Mac the doc was bound to. */
  path: string;
}

export interface BoardManifest {
  format: typeof BUNDLE_FORMAT;
  boardId: string;
  boardName: string;
  exportedAt: number;
  docIds: string[];
  files: BundleFile[];
  /** Per shared file, the entries that belong to this board. */
  merges: Record<string, unknown>;
  bindings: Binding[];
}

export class MoveRefused extends Error {}

type Json = Record<string, unknown>;

/**
 * How each shared file holds a board's entries. `arrays`: top-level arrays of
 * records with a `workspaceId`. `rootArray`: the file is such an array.
 * `idLists`: arrays of board ids. `prefixedKeys`: maps whose keys start
 * `<board>:`. `keyed`: a map keyed by board id. `jsonl`: one record a line.
 */
type MergeRule =
  | { file: string; kind: 'arrays'; fields: string[] }
  | { file: string; kind: 'rootArray' }
  | { file: string; kind: 'idLists'; fields: string[] }
  | { file: string; kind: 'prefixedKeys'; fields: string[] }
  | { file: string; kind: 'keyed' }
  | { file: string; kind: 'jsonl' };

export const MERGES: readonly MergeRule[] = [
  { file: 'share-links.json', kind: 'arrays', fields: ['links', 'members', 'audiences'] },
  { file: 'shares.json', kind: 'rootArray' },
  { file: 'sharing.json', kind: 'idLists', fields: ['closedBoards', 'lockedBoards'] },
  { file: 'review-ranks.json', kind: 'prefixedKeys', fields: ['ranks', 'tags', 'personMoves'] },
  { file: 'board-summaries.json', kind: 'keyed' },
  { file: 'dispatch-reports.json', kind: 'arrays', fields: ['reports'] },
  { file: 'review-answers.jsonl', kind: 'jsonl' },
];

/** What a fresh target file starts as when it does not exist yet. */
const EMPTY: Record<string, () => unknown> = {
  'share-links.json': () => ({ links: [], members: [], audiences: [] }),
  'shares.json': () => [],
  // An absent sharing.json reads as sharing on; a written one must say so.
  'sharing.json': () => ({ enabled: true }),
  'review-ranks.json': () => ({ ranks: {}, tags: {}, personMoves: {} }),
  'board-summaries.json': () => ({}),
  'dispatch-reports.json': () => ({ version: 1, reports: [] }),
  'review-answers.jsonl': () => '',
};

/** Files a board's sidecars may carry, by suffix after `<board>.`. */
const BOARD_SKIP = new Set(['attachments.json']);

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const isRec = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const ofBoard = (boardId: string) => (r: unknown) => isRec(r) && r.workspaceId === boardId;

/** This board's entries in one shared file, or undefined when it has none. */
function pick(rule: MergeRule, text: string, boardId: string): unknown {
  if (rule.kind === 'jsonl') {
    const lines = text.split('\n').filter((l) => {
      if (!l.trim()) return false;
      try {
        return ofBoard(boardId)(JSON.parse(l));
      } catch {
        return false;
      }
    });
    return lines.length ? lines : undefined;
  }
  const parsed = JSON.parse(text) as unknown;
  const out: Json = {};
  let any = false;
  if (rule.kind === 'rootArray') {
    const rows = Array.isArray(parsed) ? parsed.filter(ofBoard(boardId)) : [];
    return rows.length ? rows : undefined;
  }
  if (!isRec(parsed)) return undefined;
  if (rule.kind === 'keyed') return parsed[boardId] === undefined ? undefined : parsed[boardId];
  for (const f of rule.fields) {
    const v = parsed[f];
    if (rule.kind === 'arrays' && Array.isArray(v)) out[f] = v.filter(ofBoard(boardId));
    if (rule.kind === 'idLists' && Array.isArray(v)) out[f] = v.filter((x) => x === boardId);
    if (rule.kind === 'prefixedKeys' && isRec(v)) {
      out[f] = Object.fromEntries(Object.entries(v).filter(([k]) => k.startsWith(`${boardId}:`)));
    }
    const got = out[f];
    if (Array.isArray(got) ? got.length > 0 : isRec(got) && Object.keys(got).length > 0) any = true;
  }
  return any ? out : undefined;
}

function safeSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Every file under `dir`, as paths relative to `root`. */
function walk(root: string, dir: string): string[] {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return [dir];
  return readdirSync(abs)
    .sort()
    .flatMap((name) => walk(root, join(dir, name)));
}

/** The data-dir paths this board owns, given its doc ids. */
function ownedPaths(dataDir: string, boardId: string, docIds: readonly string[]): string[] {
  const own = readdirSync(join(dataDir, 'workspaces'))
    .filter((n) => n.startsWith(`${boardId}.`) && !n.endsWith('.tmp'))
    .filter((n) => !BOARD_SKIP.has(n.slice(boardId.length + 1)))
    .map((n) => join('workspaces', n));
  const docs = docIds.flatMap((id) => [
    `${id}.ydoc`,
    `${id}.voice-feedback.md`,
    ...walk(dataDir, `${id}.voice-feedback`),
    ...walk(dataDir, join('meetings', safeSegment(id))),
    join('meetings', `${id}.md`),
    join('huddles', `${id}.md`),
  ]);
  return [...own, ...docs].filter((p) => existsSync(join(dataDir, p)));
}

/** Every doc id the board owns or links. */
function boardDocIds(record: Json, boardId: string): string[] {
  const ws = isRec(record.workspace) ? record.workspace : {};
  const linked = Array.isArray(ws.docIds) ? ws.docIds.filter((d) => typeof d === 'string') : [];
  const rows = [
    ...(Array.isArray(record.tasks) ? record.tasks : []),
    ...(Array.isArray(record.goalRows) ? record.goalRows : []),
  ];
  const rowDocs = rows.flatMap((r) =>
    isRec(r) && typeof r.id === 'string' ? [`task:${r.id}`] : [],
  );
  const ids = [...new Set([`ws:${boardId}`, ...rowDocs, ...(linked as string[])])];
  const bad = ids.find((d) => !DOC_ID.test(d));
  if (bad !== undefined) throw new MoveRefused(`doc id is not safe as a file name: ${bad}`);
  return ids;
}

/**
 * Writes `boardId`'s record from `dataDir` into `outDir` (which must not
 * exist): `manifest.json` and `files/<path>`. Reads only; the source is
 * never changed.
 */
export function exportBoard(dataDir: string, boardId: string, outDir: string): BoardManifest {
  if (!BOARD_ID.test(boardId)) throw new MoveRefused(`not a board id: ${boardId}`);
  const recordPath = join(dataDir, 'workspaces', `${boardId}.tasks.json`);
  if (!existsSync(recordPath)) throw new MoveRefused(`${dataDir} holds no board ${boardId}`);
  if (existsSync(outDir)) throw new MoveRefused(`${outDir} already exists`);
  const raw = readJson(recordPath);
  if (!isRec(raw) || !isRec(raw.workspace)) throw new MoveRefused('board record is malformed');
  // `notesHome` is a path on the Mac; the server on the target has no use for it.
  const workspace = Object.fromEntries(
    Object.entries(raw.workspace).filter(([k]) => k !== 'notesHome'),
  );
  const record: Json = { ...structuredClone(raw), workspace };
  const docIds = boardDocIds(record, boardId);

  const files: BundleFile[] = [];
  const put = (path: string, bytes: Uint8Array) => {
    const to = join(outDir, 'files', path);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, bytes, { mode: 0o600 });
    files.push({ path, sha256: sha(bytes), bytes: bytes.length });
  };
  for (const path of ownedPaths(dataDir, boardId, docIds)) {
    const bytes = new Uint8Array(readFileSync(join(dataDir, path)));
    if (path === join('workspaces', `${boardId}.tasks.json`)) {
      put(path, Buffer.from(`${JSON.stringify(record)}\n`));
    } else if (path.endsWith('.ydoc')) {
      put(path, withoutPrivateMeta(bytes));
    } else {
      put(path, bytes);
    }
  }

  const merges: Json = {};
  for (const rule of MERGES) {
    const p = join(dataDir, rule.file);
    if (!existsSync(p)) continue;
    const got = pick(rule, readFileSync(p, 'utf8'), boardId);
    if (got !== undefined) merges[rule.file] = got;
  }

  const bindings: Binding[] = [];
  for (const docId of docIds) {
    const p = join(dataDir, `${docId}.private.json`);
    if (!existsSync(p)) continue;
    const meta = readJson(p);
    if (isRec(meta) && typeof meta.sourceUrl === 'string' && meta.sourceUrl.endsWith('.md')) {
      bindings.push({ docId, path: meta.sourceUrl });
    }
  }

  const manifest: BoardManifest = {
    format: BUNDLE_FORMAT,
    boardId,
    boardName: String(workspace.name ?? ''),
    exportedAt: Date.now(),
    docIds,
    files,
    merges,
    bindings,
  };
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return manifest;
}

/** Whether `dataDir` already holds any part of the board. */
export function holdsBoard(dataDir: string, boardId: string): boolean {
  return (
    existsSync(join(dataDir, 'workspaces', `${boardId}.tasks.json`)) ||
    existsSync(join(dataDir, `ws:${boardId}.ydoc`))
  );
}

/** A manifest path must be one of the shapes `exportBoard` writes. */
function checkPath(m: BoardManifest, path: string): void {
  const parts = path.split('/');
  if (path.startsWith('/') || parts.includes('..') || parts.includes('.') || path.includes('\\')) {
    throw new MoveRefused(`bundle path escapes the data dir: ${path}`);
  }
  if (parts[0] === 'workspaces' && parts.length === 2) {
    const name = parts[1] ?? '';
    if (name.startsWith(`${m.boardId}.`) && !BOARD_SKIP.has(name.slice(m.boardId.length + 1)))
      return;
  }
  const docOk = m.docIds.some(
    (id) =>
      path === `${id}.ydoc` ||
      path === `${id}.voice-feedback.md` ||
      path.startsWith(`${id}.voice-feedback/`) ||
      path.startsWith(`meetings/${safeSegment(id)}/`) ||
      path === `meetings/${id}.md` ||
      path === `huddles/${id}.md`,
  );
  if (!docOk) throw new MoveRefused(`bundle path is not one a board owns: ${path}`);
}

/** Reads and checks a bundle: format, ids, every path's shape and hash. */
export function readBundle(bundleDir: string): BoardManifest {
  const m = readJson(join(bundleDir, 'manifest.json')) as BoardManifest;
  if (m.format !== BUNDLE_FORMAT) throw new MoveRefused('not a board bundle');
  if (!BOARD_ID.test(m.boardId)) throw new MoveRefused(`not a board id: ${m.boardId}`);
  if (!Array.isArray(m.docIds) || m.docIds.some((d) => typeof d !== 'string' || !DOC_ID.test(d)))
    throw new MoveRefused('bundle doc ids are malformed');
  for (const f of m.files) {
    checkPath(m, f.path);
    const bytes = readFileSync(join(bundleDir, 'files', f.path));
    if (sha(bytes) !== f.sha256) throw new MoveRefused(`bundle file altered: ${f.path}`);
  }
  for (const k of Object.keys(m.merges ?? {})) {
    if (!MERGES.some((r) => r.file === k))
      throw new MoveRefused(`bundle merges an unknown file: ${k}`);
  }
  return m;
}

/** `target` with the board's entries from `add` merged in; refuses an entry already there. */
function merged(rule: MergeRule, target: unknown, add: unknown, boardId: string): unknown {
  const clash = () => new MoveRefused(`${rule.file} on the target already holds ${boardId}`);
  if (rule.kind === 'jsonl') {
    const text = typeof target === 'string' ? target : '';
    if (pick(rule, text, boardId) !== undefined) throw clash();
    const lines = (add as string[]).join('\n');
    return `${text}${text && !text.endsWith('\n') ? '\n' : ''}${lines}\n`;
  }
  if (rule.kind === 'rootArray') {
    const rows = Array.isArray(target) ? target : [];
    if (rows.some(ofBoard(boardId))) throw clash();
    return [...rows, ...(add as unknown[])];
  }
  const t = isRec(target) ? { ...target } : {};
  if (rule.kind === 'keyed') {
    if (t[boardId] !== undefined) throw clash();
    t[boardId] = add;
    return t;
  }
  const a = add as Json;
  for (const f of rule.fields) {
    const extra = a[f];
    if (extra === undefined) continue;
    if (rule.kind === 'prefixedKeys') {
      const cur = isRec(t[f]) ? (t[f] as Json) : {};
      if (Object.keys(cur).some((k) => k.startsWith(`${boardId}:`))) throw clash();
      t[f] = { ...cur, ...(extra as Json) };
    } else {
      const cur = Array.isArray(t[f]) ? (t[f] as unknown[]) : [];
      const has = rule.kind === 'idLists' ? cur.includes(boardId) : cur.some(ofBoard(boardId));
      if (has) throw clash();
      const more = (extra as unknown[]).length;
      if (more > 0) t[f] = [...cur, ...(extra as unknown[])];
    }
  }
  return t;
}

function writeAtomic(path: string, body: string | Uint8Array, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.move-tmp`;
  writeFileSync(tmp, body, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/**
 * Puts a bundle's board into `dataDir`. The server on `dataDir` must be
 * stopped, since it holds the shared files in memory and would write over
 * the merge. Refuses, having written nothing, when the target already holds
 * the board, any of its files, or an entry for it in a shared file.
 */
export function importBoard(bundleDir: string, dataDir: string): BoardManifest {
  const m = readBundle(bundleDir);
  mkdirSync(join(dataDir, 'workspaces'), { recursive: true });
  if (holdsBoard(dataDir, m.boardId)) {
    throw new MoveRefused(`the target already holds board ${m.boardId}`);
  }
  const taken = m.files.filter((f) => existsSync(join(dataDir, f.path))).map((f) => f.path);
  if (taken.length) throw new MoveRefused(`the target already has ${taken.join(', ')}`);
  // Every merge is computed before anything is written, so a clash refuses cleanly.
  const writes: { path: string; body: string; mode: number }[] = [];
  for (const rule of MERGES) {
    const add = m.merges[rule.file];
    if (add === undefined) continue;
    const path = join(dataDir, rule.file);
    const exists = existsSync(path);
    const text = exists ? readFileSync(path, 'utf8') : '';
    const cur = rule.kind === 'jsonl' ? text : exists ? JSON.parse(text) : EMPTY[rule.file]?.();
    const next = merged(rule, cur, add, m.boardId);
    const mode = exists ? statSync(path).mode & 0o777 : 0o600;
    const body = typeof next === 'string' ? next : `${JSON.stringify(next, null, 2)}\n`;
    writes.push({ path, body, mode });
  }
  // The board record goes last, so a server booted on a part-written import
  // does not see the board until every doc it names is in place.
  const record = join('workspaces', `${m.boardId}.tasks.json`);
  const ordered = [
    ...m.files.filter((f) => f.path !== record),
    ...m.files.filter((f) => f.path === record),
  ];
  for (const w of writes) writeAtomic(w.path, w.body, w.mode);
  for (const f of ordered) {
    writeAtomic(join(dataDir, f.path), readFileSync(join(bundleDir, 'files', f.path)), 0o600);
  }
  return m;
}
