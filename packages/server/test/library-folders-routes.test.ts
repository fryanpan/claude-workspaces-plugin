/**
 * The Library's folder verbs over real HTTP: a person or an agent makes a
 * folder and files a doc in it, the open Library hears it, a meeting lands in
 * Meetings without being filed, and `list_docs` names the folder. Filing
 * never touches the doc's file.
 *
 * All fixtures synthetic. Port 0, temp data dirs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LibraryPayload } from '../src/library.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

/** Every event name read off an open stream, until stopped. */
function framesOf(res: Response): { names: () => string[]; stop: () => void } {
  const names: string[] = [];
  let buf = '';
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const name = /^event: (.+)$/m.exec(buf.slice(0, sep))?.[1];
          if (name) names.push(name);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
        }
      }
    } catch {
      // Cancelled with a read in flight.
    }
  })();
  return { names: () => names, stop: () => void reader.cancel() };
}

interface FolderAnswer {
  ok?: boolean;
  error?: string;
  message?: string;
  folder?: { id: string; name: string };
  folders?: Array<{ id: string; name: string; path: string; parentId: string | null }>;
}

describe('library folder routes', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let WS = '';
  const host = { host: 'localhost' };
  const send = async (path: string, method: string, body?: unknown) => {
    const res = await fetch(`${base}/workspaces/${WS}${path}`, {
      method,
      headers: { ...host, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as FolderAnswer };
  };
  const items = async (): Promise<LibraryPayload> =>
    (await (
      await fetch(`${base}/workspaces/${WS}/library/items`, { headers: host })
    ).json()) as LibraryPayload;
  /** A markdown doc on the board, made under an alias; answers the id the
   *  server minted, which is the one the Library rows carry. */
  const makeDoc = async (alias: string, text: string): Promise<{ id: string; path: string }> => {
    const path = join(dataDir, `${alias}.md`);
    writeFileSync(path, text);
    const res = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { ...host, 'content-type': 'application/json' },
      body: JSON.stringify({ docId: alias, type: 'markdown', sourceUrl: path }),
    });
    expect(res.status).toBe(200);
    return { id: ((await res.json()) as { docId: string }).docId, path };
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'library-folders-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base, { name: 'Harborlight' });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('an open Library hears a folder made and a doc filed in it, and the file is untouched', async () => {
    const { id: plan, path } = await makeDoc('plan', '# Riverbend plan\n');
    const res = await fetch(`${base}/workspaces/${WS}/events:stream`, { headers: host });
    const page = framesOf(res);
    try {
      const made = await send('/library/folders', 'POST', { name: 'Plans' });
      expect(made.status).toBe(200);
      const id = made.body.folder?.id ?? '';
      expect(made.body.folders?.map((f) => f.name)).toEqual(['Meetings', 'Plans']);
      await waitFor(() => page.names().includes('library.changed'));

      const before = page.names().filter((n) => n === 'library.changed').length;
      const filed = await send('/library/docs/plan/folder', 'PUT', { folderId: id });
      expect(filed.status).toBe(200);
      await waitFor(() => page.names().filter((n) => n === 'library.changed').length > before);

      const lib = await items();
      expect(lib.folders?.map((f) => f.name)).toEqual(['Meetings', 'Plans']);
      expect(lib.files.find((r) => r.docId === plan)?.folderId).toBe(id);
      // Board data only: the doc keeps its file, its bytes and its id.
      expect(readFileSync(path, 'utf8')).toBe('# Riverbend plan\n');
    } finally {
      page.stop();
    }
  });

  it('puts a meeting in Meetings without anybody filing it', async () => {
    const huddle = await fetch(`${base}/workspaces/${WS}/huddles`, {
      method: 'POST',
      headers: { ...host, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'discussion' }),
    });
    expect(huddle.status).toBe(200);
    const lib = await items();
    expect(lib.meetings).toHaveLength(1);
    expect(lib.meetings[0]?.folderId).toBe('meetings');
  });

  it('refuses a duplicate name in the same place, and Meetings refuses archive and move', async () => {
    expect((await send('/library/folders', 'POST', { name: 'Plans' })).status).toBe(200);
    const dup = await send('/library/folders', 'POST', { name: 'plans' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('duplicate-name');
    expect((await send('/library/folders/meetings/archive', 'POST')).status).toBe(409);
    expect((await send('/library/folders/meetings/move', 'POST', { parentId: null })).status).toBe(
      409,
    );
    // CONTROL: Meetings can be renamed.
    expect((await send('/library/folders/meetings/rename', 'POST', { name: 'Calls' })).status).toBe(
      200,
    );
  });

  it('archives reversibly: the doc reads as in no folder, then is back', async () => {
    const { id: notes } = await makeDoc('notes', '# Saltmarsh notes\n');
    const id = (await send('/library/folders', 'POST', { name: 'Research' })).body.folder?.id ?? '';
    await send('/library/docs/notes/folder', 'PUT', { folderId: id });

    expect((await send(`/library/folders/${id}/archive`, 'POST')).status).toBe(200);
    let lib = await items();
    expect(lib.folders?.some((f) => f.id === id)).toBe(false);
    expect(lib.files.find((r) => r.docId === notes)?.folderId).toBeUndefined();

    expect((await send(`/library/folders/${id}/unarchive`, 'POST')).status).toBe(200);
    lib = await items();
    expect(lib.files.find((r) => r.docId === notes)?.folderId).toBe(id);
  });

  it('refuses to file a doc that is not on this board, and a folder that is not', async () => {
    await makeDoc('notes', '# Saltmarsh notes\n');
    expect((await send('/library/docs/elsewhere/folder', 'PUT', { folderId: null })).status).toBe(
      404,
    );
    expect((await send('/library/docs/notes/folder', 'PUT', { folderId: 'f-nope' })).status).toBe(
      404,
    );
    expect((await send('/library/docs/notes/folder', 'PUT', {})).status).toBe(400);
    // CONTROL: no folder is a real answer.
    expect((await send('/library/docs/notes/folder', 'PUT', { folderId: null })).status).toBe(200);
  });

  it('names the folder on list_docs rows', async () => {
    const { id: plan } = await makeDoc('plan', '# Riverbend plan\n');
    const design = (await send('/library/folders', 'POST', { name: 'Design' })).body.folder?.id;
    const mocks = await send('/library/folders', 'POST', { name: 'Mocks', parentId: design });
    await send('/library/docs/plan/folder', 'PUT', { folderId: mocks.body.folder?.id });
    const res = await fetch(`${base}/workspaces/${WS}/docs?limit=50`, { headers: host });
    const page = (await res.json()) as {
      docs: Array<{ docId: string; folder?: { id: string; path: string } }>;
    };
    expect(page.docs.find((d) => d.docId === plan)?.folder).toEqual({
      id: mocks.body.folder?.id ?? '',
      path: 'Design/Mocks',
    });
  });

  it('keeps the folders across a restart', async () => {
    await send('/library/folders', 'POST', { name: 'Plans' });
    await handle.stop();
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    await waitFor(async () => {
      const got = await send('/library/folders', 'GET');
      return got.body.folders?.some((f) => f.name === 'Plans') === true;
    });
  });
});
