/**
 * A view member cannot write a doc's threads through REST; a comment member
 * and an editor can.
 *
 * The socket gate (`socket-write-gate.ts`) already drops a view socket's
 * thread writes. The thread routes were the other door: a view member's
 * `POST /threads` answered 200 and filed a comment. This drives the real
 * route table behind an Access-fronted share hostname, as
 * `board-access-roles.test.ts` does. Every name here is invented.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { accessHarness } from './access-share.ts';

const SHARE_AUD = 'aud-thread-write-access';
const SHARE_HOST = 'share.example.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };

const VIEWER = 'alice@harborlight.example';
const COMMENTER = 'bob@harborlight.example';
const EDITOR = 'riverbend@harborlight.example';

const ANCHOR = {
  kind: 'element',
  fingerprint: {
    tag: 'P',
    stableAttrs: {},
    classes: [],
    text: 'Body.',
    path: 'P[0] > BODY[0]',
    dataAttrs: {},
  },
  snippet: { text: 'Body.' },
};

describe('thread writes follow the member’s access level', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let board: string;
  let docId: string;
  let signJwt: (aud: string, email?: string) => Promise<string>;

  const req = (path: string, host: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { host, ...((init.headers as Record<string, string>) ?? {}) },
    });
  const postLocal = (path: string, body: unknown) =>
    req(path, `localhost:${handle.port}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const postAsMember = async (email: string, path: string, body: unknown) =>
    req(path, SHARE_HOST, {
      method: 'POST',
      headers: {
        ...CF_RAY,
        'cf-access-jwt-assertion': await signJwt(SHARE_AUD, email),
        'content-type': 'application/json',
        origin: `http://${SHARE_HOST}`,
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify(body),
    });

  /** Sign `email` in through a fresh link, then give them `access`. */
  const join_ = async (email: string, access: 'view' | 'comment' | undefined) => {
    const r = await postLocal('/api/share/workspace', { workspaceId: board });
    expect(r.status, await r.clone().text()).toBe(200);
    const { link } = (await r.json()) as { link: { linkId: string } };
    const redeemed = await req(`/s/${link.linkId}`, SHARE_HOST, {
      headers: { ...CF_RAY, 'cf-access-jwt-assertion': await signJwt(SHARE_AUD, email) },
    });
    expect(redeemed.status).toBe(302);
    expect(handle.shareLinks.setMemberRole(board, email, 'member', access)).toBe(true);
  };

  const newThread = (email: string, text: string) =>
    postAsMember(email, `/workspaces/${board}/docs/${docId}/threads`, {
      author: { id: 'ignored', name: 'Ignored', kind: 'person' },
      text,
      anchor: ANCHOR,
    });

  const threadTexts = (): string[] =>
    handle.docStore
      .listThreads(docId)
      .map((t) => t.comments[0]?.text ?? '')
      .sort();

  beforeAll(async () => {
    const access = await accessHarness(VIEWER);
    signJwt = access.signJwt;
    dataDir = mkdtempSync(join(tmpdir(), 'thread-write-access-'));
    handle = createServer({
      port: 0,
      dataDir,
      ...access.serverOptions,
      shareLinkHosts: [SHARE_HOST],
      shareLinkAudience: SHARE_AUD,
    });
    base = `http://127.0.0.1:${handle.port}`;
    const created = await postLocal('/workspaces', { name: 'Harborlight' });
    board = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    const path = join(dataDir, 'riverbend-notes.md');
    writeFileSync(path, '# Riverbend notes\n\nBody.\n');
    const doc = await postLocal(`/workspaces/${board}/docs`, {
      docId: 'riverbend-notes',
      type: 'markdown',
      sourceUrl: path,
    });
    expect(doc.status).toBe(200);
    docId = ((await doc.json()) as { docId: string }).docId;
    expect((await postLocal(`/workspaces/${board}/docs:attach`, { docId })).status).toBe(200);
    handle.shareLinks.addToAudience(board, ['@harborlight.example'], 'Saltmarsh');
    await join_(VIEWER, 'view');
    await join_(COMMENTER, 'comment');
    await join_(EDITOR, undefined);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses a view member’s new thread, and files a comment member’s and an editor’s', async () => {
    const viewed = await newThread(VIEWER, 'from the viewer');
    expect(viewed.status).toBe(403);
    expect(((await viewed.json()) as { error: string }).error).toBe('view_only');

    const commented = await newThread(COMMENTER, 'from the commenter');
    expect(commented.status, await commented.clone().text()).toBe(200);
    const edited = await newThread(EDITOR, 'from the editor');
    expect(edited.status, await edited.clone().text()).toBe(200);

    expect(threadTexts()).toEqual(['from the commenter', 'from the editor']);
  });

  it('refuses a view member’s reply and resolve on a thread a commenter opened', async () => {
    const opened = await newThread(COMMENTER, 'a thread to answer');
    expect(opened.status).toBe(200);
    const threadId = ((await opened.json()) as { thread: { id: string } }).thread.id;
    const path = `/workspaces/${board}/docs/${docId}/threads/${threadId}`;

    const reply = await postAsMember(VIEWER, `${path}/comments`, {
      author: { id: 'ignored', name: 'Ignored', kind: 'person' },
      text: 'a viewer’s reply',
    });
    expect(reply.status).toBe(403);
    expect((await postAsMember(VIEWER, `${path}/resolve`, {})).status).toBe(403);

    // Control: the commenter's reply on the same thread lands.
    const control = await postAsMember(COMMENTER, `${path}/comments`, {
      author: { id: 'ignored', name: 'Ignored', kind: 'person' },
      text: 'a commenter’s reply',
    });
    expect(control.status, await control.clone().text()).toBe(200);
    const texts = handle.docStore.getThread(docId, threadId)?.comments.map((c) => c.text);
    expect(texts).toEqual(['a thread to answer', 'a commenter’s reply']);
  });

  it('refuses a comment member’s rewrite of a thread’s region, which changes the text', async () => {
    const opened = await newThread(COMMENTER, 'a thread on the body');
    expect(opened.status).toBe(200);
    const threadId = ((await opened.json()) as { thread: { id: string } }).thread.id;
    const path = `/workspaces/${board}/docs/${docId}/threads/${threadId}/rewrite_region`;
    const rewrite = { replacement: 'Rewritten by Bob.' };
    const refused = await postAsMember(COMMENTER, path, rewrite);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe('comment_only');
    // Control: the editor's same request is not refused by the level.
    expect((await postAsMember(EDITOR, path, rewrite)).status).not.toBe(403);
  });

  it('refuses a view or comment member’s answer to a suggestion', async () => {
    const path = `/workspaces/${board}/docs/${docId}/suggestions/resolve_all`;
    for (const who of [VIEWER, COMMENTER]) {
      expect((await postAsMember(who, path, { action: 'reject' })).status, who).toBe(403);
    }
    expect((await postAsMember(EDITOR, path, { action: 'reject' })).status).toBe(200);
  });

  it('report-only: the owner’s opt-out lets a view member’s thread through', async () => {
    handle.shareLinks.setRolesMode(board, 'report-only');
    try {
      const res = await newThread(VIEWER, 'viewer under report-only');
      expect(res.status, await res.clone().text()).toBe(200);
    } finally {
      handle.shareLinks.setRolesMode(board, 'enforce');
    }
  });
});
