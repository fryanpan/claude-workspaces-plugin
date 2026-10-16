/**
 * The server's record of which threads a board agent token opened. The org
 * relay trusts a sender only through it, so what it must never do is hand
 * back a proof for a thread whose opener changed, or one it was never told.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadOpenerProofs, threadOpenerProofsPath } from '../src/thread-opener-proofs.ts';

const GRANT = { agentId: 'agent-harborlight-lead', boardId: 'w-harbor' };
const thread = (id: string, text: string) => ({ id, comments: [{ text }] });

describe('ThreadOpenerProofs', () => {
  const dirs: string[] = [];
  const path = () => {
    const dir = mkdtempSync(join(tmpdir(), 'opener-proofs-'));
    dirs.push(dir);
    return threadOpenerProofsPath(dir);
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('proves a recorded thread while its opener reads as it was posted', () => {
    const proofs = new ThreadOpenerProofs(path());
    proofs.record('task:t-out', 'th-1', GRANT, 'to: riverbend-lead\nhello');
    expect(proofs.decorate('task:t-out', thread('th-1', 'to: riverbend-lead\nhello'))).toEqual({
      ...thread('th-1', 'to: riverbend-lead\nhello'),
      openerProof: { kind: 'board-token', ...GRANT },
    });
    // Unrecorded thread, another doc, rewritten words: no proof at all.
    expect(proofs.decorate('task:t-out', thread('th-2', 'x'))).not.toHaveProperty('openerProof');
    expect(proofs.get('task:t-other', 'th-1', 'to: riverbend-lead\nhello')).toBeNull();
    expect(proofs.get('task:t-out', 'th-1', 'to: saltmarsh-lead\nhello')).toBeNull();
    expect(proofs.get('task:t-out', 'th-1', undefined)).toBeNull();
  });

  it('keeps the first record for a thread', () => {
    const proofs = new ThreadOpenerProofs(path());
    proofs.record('d', 'th-1', GRANT, 'first');
    proofs.record('d', 'th-1', { agentId: 'agent-other', boardId: 'w-other' }, 'second');
    expect(proofs.get('d', 'th-1', 'first')?.agentId).toBe(GRANT.agentId);
    expect(proofs.get('d', 'th-1', 'second')).toBeNull();
  });

  it('survives a restart in a file only its owner can read', () => {
    const p = path();
    new ThreadOpenerProofs(p).record('d', 'th-1', GRANT, 'words');
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(new ThreadOpenerProofs(p).get('d', 'th-1', 'words')?.boardId).toBe(GRANT.boardId);
  });

  it('drops the oldest past its cap', () => {
    const proofs = new ThreadOpenerProofs(path(), Date.now, 2);
    for (const id of ['a', 'b', 'c']) proofs.record('d', id, GRANT, id);
    expect(proofs.get('d', 'a', 'a')).toBeNull();
    expect(proofs.get('d', 'b', 'b')).not.toBeNull();
    expect(proofs.get('d', 'c', 'c')).not.toBeNull();
  });

  it('proves nothing from an unreadable or malformed file', () => {
    const p = path();
    writeFileSync(p, '{not json');
    expect(new ThreadOpenerProofs(p).get('d', 'th-1', 'words')).toBeNull();
    writeFileSync(p, JSON.stringify({ proofs: [{ docId: 'd', threadId: 'th-1', agentId: 1 }] }));
    expect(new ThreadOpenerProofs(p).get('d', 'th-1', 'words')).toBeNull();
  });
});
