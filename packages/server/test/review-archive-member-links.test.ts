/**
 * Archiving a review takes the rows that point INTO it, not just the row for
 * the set.
 *
 * A review is filed onto a board as one row — the set id — and archiving
 * unlinks that row, because a row pointing at a doc that no longer loads is a
 * dead end. But a member file can be filed onto a board on its own
 * (`attach_doc` with the member's docId), which is exactly what somebody does
 * when one changed file matters to a second board. Those rows were left
 * behind: the set went to `_archive`, the member's `.ydoc` went with it, and
 * the second board kept a row addressing a doc the server would not serve.
 *
 * The round trip has to be symmetric or the fix trades one broken state for
 * another, so the manifest remembers which boards linked which member and
 * unarchive puts each one back.
 *
 * All fixtures synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

describe('archiving a review unlinks the rows that point into it', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let base: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  /** The docIds a board currently holds rows for. */
  const docIdsOn = (workspaceId: string): string[] =>
    handle.tasks.getWorkspace(workspaceId)?.docIds ?? [];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ar-links-data-'));
    folder = mkdtempSync(join(tmpdir(), 'ar-links-src-'));
    mkdirSync(join(folder, 'src'));
    writeFileSync(join(folder, 'README.md'), '# Project\n\nthe unique md line\n');
    writeFileSync(join(folder, 'src', 'index.ts'), 'export const answer = 42;\n');
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  /**
   * A folder review filed on board A, with ONE of its members also filed on
   * board B — the shape the bug is about.
   *
   * Members bind lazily, so the file is opened first: an unopened member is
   * not in `docStore.list()` and could not have been attached anywhere, which
   * would make every assertion below pass vacuously.
   */
  async function reviewOnTwoBoards(): Promise<{
    setId: string;
    memberId: string;
    boardA: string;
    boardB: string;
  }> {
    const a = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name: 'board-a' }),
    );
    const b = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name: 'board-b' }),
    );
    const boardA = a.workspace.id;
    const boardB = b.workspace.id;
    // A folder bind is `POST /workspaces` with a folderPath — the same
    // collection a board create uses, told apart by the body.
    const bound = await jj<{ workspaceId?: string; setId?: string }>(
      await post('/workspaces', { folderPath: folder }),
    );
    const setId = (bound.setId ?? bound.workspaceId) as string;
    // The bind files the set under the default holding board, so board A
    // gets its row the way a person would give it one.
    await jj(await post(`/workspaces/${boardA}/docs:attach`, { docId: setId }));
    const opened = await handle.docStore.openContextFile(setId, 'README.md');
    expect(opened.ok, 'the member file has to open before it can be filed anywhere').toBe(true);
    const memberId = (opened as { docId: string }).docId;

    await jj(await post(`/workspaces/${boardB}/docs:attach`, { docId: memberId }));
    // The control for everything below: both rows exist before the archive,
    // so "the row is gone" is about the archive and not about a fixture that
    // never had one.
    expect(docIdsOn(boardA)).toContain(setId);
    expect(docIdsOn(boardB)).toContain(memberId);
    return { setId, memberId, boardA, boardB };
  }

  it('takes the member row off the other board, not just the set row off this one', async () => {
    const { setId, memberId, boardA, boardB } = await reviewOnTwoBoards();

    await jj(
      await post(`/workspaces/${boardA}/attachments/${setId}/archive`, { reason: 'shipped' }),
    );

    expect(docIdsOn(boardA)).not.toContain(setId);
    expect(docIdsOn(boardB)).not.toContain(memberId);
  });

  it('puts every member row back where it was on unarchive', async () => {
    // Without this the fix above would be a one-way door: archiving would
    // clean up rows that unarchiving could never restore, which is a worse
    // failure than the one it replaces.
    const { setId, memberId, boardA, boardB } = await reviewOnTwoBoards();
    await jj(
      await post(`/workspaces/${boardA}/attachments/${setId}/archive`, { reason: 'shipped' }),
    );
    // Stated, so this test cannot pass by the row having never left. Without
    // it the whole assertion below is satisfied by the bug itself.
    expect(docIdsOn(boardB)).not.toContain(memberId);

    await jj(await post(`/workspaces/${boardA}/attachments/${setId}/unarchive`, {}));

    expect(docIdsOn(boardA)).toContain(setId);
    expect(docIdsOn(boardB)).toContain(memberId);
  });
});
