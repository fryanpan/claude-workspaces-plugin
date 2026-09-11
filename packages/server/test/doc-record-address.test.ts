/**
 * The doc surface's two floats read the doc's RECORD, and this is the test
 * that the address they read it at answers one.
 *
 * `/workspaces/<ws>/docs/<id>` serves two things: the editor's HTML shell to a
 * person who typed it, and the doc's JSON record to a caller that asks with
 * `?format=json`. Before the address cutover those were two paths —
 * `/review/<id>` and `/api/docs/<id>` — and could not be confused. After it,
 * a reader that forgets the query gets HTML under a 200, `res.json()` throws,
 * and a float whose catch means "leave it as it was" renders nothing and says
 * nothing. That is exactly what happened to the planning and review flows.
 *
 * So the test drives the CLIENT's own URL builder against a real server rather
 * than a path spelled out here: a builder that stops asking for JSON, or a
 * server that stops answering it, fails this. The bare address is asserted
 * beside it as the control — it must NOT be the record, because a page is
 * what a person typing that address is owed.
 *
 * All fixtures synthetic; no port is bound (port: 0). The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docJsonUrl } from '../../workspaces-app/src/doc-path.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type AccessHarness, accessHarness } from './access-share.ts';

interface DocRecord {
  meta?: { huddle?: boolean; huddleKind?: string; title?: string };
}

describe('the address the doc floats read a record at', () => {
  let handle: ServerHandle;
  let access: AccessHarness;
  let dataDir: string;
  let base: string;
  let workspaceId: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const post = (path: string, body: unknown) =>
    local(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'doc-record-address-'));
    access = await accessHarness();
    handle = createServer({ port: 0, dataDir, ...access.serverOptions });
    base = `http://127.0.0.1:${handle.port}`;
    workspaceId = (
      await jj<{ workspace: { id: string } }>(await post('/workspaces', { name: 'flows-board' }))
    ).workspace.id;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /**
   * Both kinds, because both floats gate on what this read returns: Make Plan
   * on `huddleKind`, Review on `huddle`. A plan huddle whose record does not
   * arrive is a doc with no planning flow in it, which is the bug.
   */
  for (const kind of ['plan', 'discussion'] as const) {
    it(`answers a ${kind} huddle's record at the URL the client builds`, async () => {
      const started = await jj<{ docId: string }>(
        await post(`/workspaces/${workspaceId}/huddles`, { kind }),
      );
      const res = await local(docJsonUrl(started.docId, workspaceId));
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = (await res.json()) as DocRecord;
      expect(body.meta?.huddle).toBe(true);
      expect(body.meta?.huddleKind).toBe(kind);
    });
  }

  /**
   * The control, and it is the reason the query has to stay. Without it a
   * builder that dropped `format=json` could be "fixed" by making the bare
   * path answer data, which would hand a browser a body it cannot render on
   * every doc link the product prints.
   *
   * Asserted as "not the record" rather than "the editor page": this suite
   * boots with no built client bundle, so the page half has nothing to serve
   * and answers 404 where prod answers HTML. What must hold in both is that
   * the bare address is not the JSON twin.
   */
  it('does not answer the record at the same address without the query', async () => {
    const started = await jj<{ docId: string }>(
      await post(`/workspaces/${workspaceId}/huddles`, { kind: 'plan' }),
    );
    const bare = await local(`/workspaces/${workspaceId}/docs/${started.docId}`);
    expect(bare.headers.get('content-type')).not.toContain('application/json');
    expect(await bare.text()).not.toContain('huddleKind');
  });
});
