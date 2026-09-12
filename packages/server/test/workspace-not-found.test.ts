/**
 * A wrong link under a board reads as a wrong link, not as a dead server.
 *
 * THE FAILURE THIS PINS. `/workspaces/<ws>/review/<id>` — the pre-cutover
 * spelling of a doc's page, still pasted into chats — fell to the router's
 * tail and answered nine bytes of `not found` with no content type, which Bun
 * labels `application/octet-stream`. Chrome refuses to render that and paints
 * ERR_INVALID_RESPONSE, the same thing it paints for an unreachable server.
 * So the reader waits for a deploy instead of reporting the link.
 *
 * WHAT EACH TEST IS FOR. The four shapes a wrong link actually takes each
 * answer 404 with an HTML page that links back somewhere a reader can use;
 * the JSON surface is unchanged, because answering a tool with a page helps
 * nobody. Behaviour throughout: the server is driven over HTTP and the
 * response is read, never the source of the renderer.
 *
 * Fixtures are synthetic — invented board names. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { renderBoardMemberNotFound } from '../src/shells.ts';

describe('a wrong address under a board answers a readable page', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let ws: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  /** Status, content type and body for one address — the three things a
   *  browser decides what to paint from. */
  const probe = async (path: string) => {
    const r = await local(path);
    return {
      status: r.status,
      type: r.headers.get('content-type') ?? '',
      body: await r.text(),
    };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'not-found-page-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const created = await local('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'harborlight-review', goal: 'Ship it.' }),
    });
    ws = ((await created.json()) as { workspace: { id: string } }).workspace.id;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** The board's own address, which is the way out every page under a live
   *  board has to offer. */
  const boardHref = () => `/workspaces/${encodeURIComponent(ws)}`;

  it('answers the dead /review/<id> address with a page, not a bodyless 404', async () => {
    const got = await probe(`${boardHref()}/review/d-nope`);
    expect(got.status).toBe(404);
    expect(got.type).toBe('text/html; charset=utf-8');
    // The three things the page has to do: be a document a browser paints,
    // say the fault is the link, and hand the reader the board back.
    expect(got.body.startsWith('<!doctype html>')).toBe(true);
    expect(got.body).toContain('The server is running');
    expect(got.body).toContain(`href="${boardHref()}"`);
  });

  it('answers any other unknown remainder under the board the same way', async () => {
    for (const path of [`${boardHref()}/whatever`, `${boardHref()}/some/deep/guess`]) {
      const got = await probe(path);
      expect(got.status).toBe(404);
      expect(got.type).toBe('text/html; charset=utf-8');
      expect(got.body).toContain(`href="${boardHref()}"`);
    }
  });

  it('answers an unknown doc under the board with the same page', async () => {
    const got = await probe(`${boardHref()}/docs/d-nope`);
    expect(got.status).toBe(404);
    expect(got.type).toBe('text/html; charset=utf-8');
    expect(got.body).toContain(`href="${boardHref()}"`);
  });

  it('sends a browser to the workspace list when the board itself is gone', async () => {
    // The deep link is the shape a pasted URL actually has, and it used to
    // answer a tab with a JSON body. Offering to open a board that does not
    // exist would be a second dead end, so the way out is the list.
    for (const path of ['/workspaces/w-nope/review/d-nope', '/workspaces/w-nope/whatever']) {
      const r = await local(path, { headers: { accept: 'text/html,application/xhtml+xml' } });
      expect(r.status).toBe(404);
      expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
      const body = await r.text();
      expect(body).toContain('The server is running');
      expect(body).toContain('href="/"');
      expect(body).not.toContain('href="/workspaces/w-nope"');
    }
  });

  it('lets ?format=json win over a browser Accept header', async () => {
    // An explicit ask for data beats the header every time. An iframe or a
    // pasted debug URL carries a browser's Accept alongside it, and turning
    // that into a page would answer a caller something it cannot parse.
    for (const path of [
      '/workspaces/w-nope/review/d-nope?format=json',
      `${boardHref()}/docs/d-nope?format=json`,
    ]) {
      const r = await local(path, { headers: { accept: 'text/html,application/xhtml+xml' } });
      expect(r.status).toBe(404);
      expect(r.headers.get('content-type') ?? '').not.toContain('text/html');
      expect(JSON.parse(await r.text())).toHaveProperty('error');
    }
  });

  it('still answers a tool with JSON on the same gone-board addresses', async () => {
    // Only the Accept header decides the shape. A tool sends the wildcard
    // type, and what it parses is unchanged.
    const got = await probe('/workspaces/w-nope/review/d-nope');
    expect(got.status).toBe(404);
    expect(got.type).not.toContain('text/html');
    expect(JSON.parse(got.body)).toHaveProperty('error');
  });

  it('sends an unknown board to the workspace list, not to a board that is not there', async () => {
    const got = await probe('/workspaces/w-nope');
    expect(got.status).toBe(404);
    expect(got.type).toBe('text/html; charset=utf-8');
    expect(got.body).toContain('The server is running');
    // Offering to open a board that does not exist would be a second dead
    // end, so this page's way out is the list.
    expect(got.body).toContain('href="/"');
    expect(got.body).not.toContain('href="/workspaces/w-nope"');
  });

  it('echoes the wrong address without decoding it', async () => {
    // The remainder is printed as it arrived. A percent-escaped `<` stays
    // percent-escaped, so the page cannot be made to paint markup the link
    // carried.
    const got = await probe(`${boardHref()}/%3Cimg%20src=x%20onerror=alert(1)%3E`);
    expect(got.status).toBe(404);
    expect(got.body).not.toContain('<img src=x');
    expect(got.body).toContain('%3Cimg%20src=x');
  });

  it('escapes a raw angle bracket in the address it echoes', () => {
    // Driven directly because a `fetch` percent-encodes the character before
    // it leaves; a hand-rolled client does not have to. Both halves of the
    // page take untrusted text — the remainder and the board id.
    const page = renderBoardMemberNotFound('w-<b>1', '<img src=x onerror=alert(1)>');
    expect(page).not.toContain('<img src=x');
    expect(page).not.toContain('<b>1');
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('bounds how much of a very long address it prints', () => {
    // The link back is the point of the page, and an address pasted from a
    // generated URL can be long enough to push it off a phone screen.
    const page = renderBoardMemberNotFound('w-1', `docs/${'d'.repeat(400)}`);
    expect(page).toContain('…');
    expect(page).not.toContain('d'.repeat(200));
  });

  it('leaves the JSON surface alone', async () => {
    // An API path is not a browser navigating, and neither is a board path
    // that asked for data. Both keep the answer their callers parse.
    const api = await probe('/api/nope');
    expect(api.status).toBe(404);
    expect(api.type).not.toContain('text/html');

    const json = await probe(`${boardHref()}/review/d-nope?format=json`);
    expect(json.status).toBe(404);
    expect(json.type).not.toContain('text/html');

    // A write is a tool's, whatever the path looks like.
    const posted = await local(`${boardHref()}/review/d-nope`, {
      method: 'POST',
      body: '{}',
    });
    expect(posted.status).toBe(404);
    expect(posted.headers.get('content-type') ?? '').not.toContain('text/html');
  });
});
