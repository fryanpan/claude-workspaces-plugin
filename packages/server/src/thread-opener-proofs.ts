/**
 * Which threads were opened by a request carrying a board agent token
 * (`at2`), and for which agent and board.
 *
 * A thread's author is a field in the doc, and the doc can be written two
 * ways that never present a token: a loopback caller is trusted-local, so
 * the body's author stands; and any writable editing socket can put a
 * thread into the doc's map directly. So "the opener's author id is the
 * lead's" says only that somebody wrote that id. The org relay needs the
 * stronger fact, that the lead's own token opened the thread, and this
 * record is where the server keeps it: outside the doc, written only by the
 * thread-create routes, and only when the author came from the token.
 *
 * The record also holds a hash of the opening comment's words. A socket
 * that can write the doc can rewrite those words after the lead posted
 * them, so the proof is shown only while the opener still reads as it did
 * when the token posted it.
 *
 * The thread list carries each record back as `openerProof`. Nothing else
 * reads it, and no attribution changes because of it.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface OpenerProof {
  kind: 'board-token';
  agentId: string;
  boardId: string;
}

interface ProofRow {
  docId: string;
  threadId: string;
  agentId: string;
  boardId: string;
  /** sha256 of the opening comment's text, hex. */
  textHash: string;
  ts: number;
}

/** The most rows kept. The oldest go first; a relay reads a thread within
 *  seconds of its creation, so this is far past any it still needs. */
export const MAX_OPENER_PROOFS = 20_000;

export function threadOpenerProofsPath(dataDir: string): string {
  return join(dataDir, 'thread-opener-proofs.json');
}

const keyOf = (docId: string, threadId: string) => `${docId}\u0000${threadId}`;
const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');

function isRow(r: unknown): r is ProofRow {
  if (!r || typeof r !== 'object') return false;
  const x = r as Partial<ProofRow>;
  return (
    typeof x.docId === 'string' &&
    typeof x.threadId === 'string' &&
    typeof x.agentId === 'string' &&
    typeof x.boardId === 'string' &&
    typeof x.textHash === 'string' &&
    typeof x.ts === 'number'
  );
}

export class ThreadOpenerProofs {
  private rows: Map<string, ProofRow> | null = null;

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
    private readonly max: number = MAX_OPENER_PROOFS,
  ) {}

  private load(): Map<string, ProofRow> {
    if (this.rows) return this.rows;
    this.rows = new Map();
    try {
      const raw = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : null;
      const list: unknown[] = Array.isArray(raw?.proofs) ? raw.proofs : [];
      for (const r of list) if (isRow(r)) this.rows.set(keyOf(r.docId, r.threadId), r);
    } catch {
      // An unreadable file proves nothing, which is the safe reading.
    }
    return this.rows;
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ proofs: [...this.load().values()] }), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  /** Record that `grant`'s token opened this thread with `text`. */
  record(
    docId: string,
    threadId: string,
    grant: { agentId: string; boardId: string },
    text: string,
  ): void {
    const rows = this.load();
    const key = keyOf(docId, threadId);
    if (rows.has(key)) return;
    rows.set(key, {
      docId,
      threadId,
      agentId: grant.agentId,
      boardId: grant.boardId,
      textHash: hashOf(text),
      ts: this.now(),
    });
    // A Map iterates in insertion order, so the first keys are the oldest.
    for (const k of rows.keys()) {
      if (rows.size <= this.max) break;
      rows.delete(k);
    }
    this.save();
  }

  /** The proof for a thread whose opener now reads `openerText`, or null. */
  get(docId: string, threadId: string, openerText: string | undefined): OpenerProof | null {
    const r = this.load().get(keyOf(docId, threadId));
    if (!r || openerText === undefined || hashOf(openerText) !== r.textHash) return null;
    return { kind: 'board-token', agentId: r.agentId, boardId: r.boardId };
  }

  /** A thread payload with its proof, when it has one that still holds. */
  decorate<T extends { id: string; comments: ReadonlyArray<{ text: string }> }>(
    docId: string,
    t: T,
  ): T & { openerProof?: OpenerProof } {
    const proof = this.get(docId, t.id, t.comments[0]?.text);
    return proof ? { ...t, openerProof: proof } : t;
  }
}
