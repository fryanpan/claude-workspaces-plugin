/**
 * "Add to Home Screen" from a shared board installs THAT board
 * (`routes/workspace-manifest.ts`, the install assets on the share
 * allowlist, and which manifest each board shell links).
 *
 * Two layers. The pure guard is driven directly, because it is the thing
 * that refused the install: a member's browser asked for the icons and the
 * manifest and got nothing, so the Home Screen got a bookmark. Then a real
 * server with a mocked Access edge, so what is asserted is what a phone
 * would fetch — the shell a share visitor is served, the manifest it links,
 * and that a foreign board's manifest is still refused on the share host.
 * Fixtures are invented; the repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ShareTarget, shareScopeAllows } from '../src/middleware/host-guard.ts';
import { buildBoardManifest } from '../src/routes/workspace-manifest.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import {
  type AccessHarness,
  type MintedShare,
  accessHarness,
  mintAccessShare,
} from './access-share.ts';
import { seedBoard } from './workspace-seed.ts';

const INSTALL_ASSETS = [
  '/manifest.webmanifest',
  '/apple-touch-icon.png',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
];

describe('the share allowlist and a Home Screen install', () => {
  const WS: ShareTarget = { workspaceId: 'ws-1' };
  const NO_WS: ShareTarget = {};
  const workspacesOf = () => ['ws-1'];

  it('serves the install assets to a board share, and to nothing narrower', () => {
    for (const p of INSTALL_ASSETS) {
      expect(shareScopeAllows(p, 'GET', WS, workspacesOf), p).toBe(true);
      expect(shareScopeAllows(p, 'GET', NO_WS, workspacesOf), `${p} (no workspace)`).toBe(false);
    }
    // The control: the service worker is not an install asset and stays
    // closed — push is not a member route, so a worker would have no job.
    expect(shareScopeAllows('/sw.js', 'GET', WS, workspacesOf)).toBe(false);
  });

  it("serves the shared board's own manifest and refuses another board's", () => {
    expect(shareScopeAllows('/workspaces/ws-1/manifest.webmanifest', 'GET', WS, workspacesOf)).toBe(
      true,
    );
    expect(shareScopeAllows('/workspaces/ws-2/manifest.webmanifest', 'GET', WS, workspacesOf)).toBe(
      false,
    );
    expect(
      shareScopeAllows('/workspaces/ws-1/manifest.webmanifest', 'POST', WS, workspacesOf),
    ).toBe(false);
  });
});

describe('what one board’s manifest says', () => {
  it('starts on the board, is scoped to it, and is named after it', () => {
    const m = buildBoardManifest('w-1', 'Harbour plan');
    // The spec's own test for a usable manifest: the start URL sits inside
    // the scope. The first cut had `/workspaces/w-1/` as the scope, which
    // excludes the start URL by one character.
    expect((m.start_url as string).startsWith(m.scope as string)).toBe(true);
    expect(m).toMatchObject({
      id: '/workspaces/w-1',
      name: 'Harbour plan',
      short_name: 'Harbour plan',
      start_url: '/workspaces/w-1',
      scope: '/workspaces/w-1',
      display: 'standalone',
    });
  });

  it('shortens a long title for the space under the icon, and escapes the id', () => {
    const m = buildBoardManifest('w/odd id', 'Quarterly planning for the harbour');
    expect(m.short_name).toBe('Quarterly p…');
    expect(m.start_url).toBe('/workspaces/w%2Fodd%20id');
  });
});

describe('over HTTP, on the share hostname', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let access: AccessHarness;
  let share: MintedShare;
  let boardId: string;
  let otherBoardId: string;

  const local = (path: string) =>
    fetch(`${base}${path}`, { headers: { host: `localhost:${handle.port}` } });
  const pub = (path: string) =>
    fetch(`${base}${path}`, { redirect: 'manual', headers: share.headers });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'board-manifest-'));
    access = await accessHarness();
    handle = createServer({ port: 0, dataDir, ...access.serverOptions });
    base = `http://127.0.0.1:${handle.port}`;
    boardId = await seedBoard(base, { name: 'Harbour plan' });
    otherBoardId = await seedBoard(base, { name: 'Other board' });
    share = await mintAccessShare(base, access, boardId);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('answers two boards with two manifests', async () => {
    const a = await local(`/workspaces/${boardId}/manifest.webmanifest`);
    const b = await local(`/workspaces/${otherBoardId}/manifest.webmanifest`);
    expect(a.status).toBe(200);
    expect(a.headers.get('content-type')).toBe('application/manifest+json');
    const ma = (await a.json()) as { name: string; start_url: string };
    const mb = (await b.json()) as { name: string; start_url: string };
    expect(ma.name).toBe('Harbour plan');
    expect(ma.start_url).toBe(`/workspaces/${boardId}`);
    expect(mb.name).toBe('Other board');
    expect(mb.start_url).toBe(`/workspaces/${otherBoardId}`);
  });

  it("links the board's own manifest from a visitor's shell, and the root one from the owner's", async () => {
    const visitor = await (await pub(`/workspaces/${boardId}`)).text();
    expect(visitor).toContain(`href="/workspaces/${boardId}/manifest.webmanifest"`);
    expect(visitor).not.toContain('href="/manifest.webmanifest"');
    const owner = await (await local(`/workspaces/${boardId}`)).text();
    expect(owner).toContain('href="/manifest.webmanifest"');
  });

  it('serves a visitor their manifest and icons, and refuses the other board’s', async () => {
    const mine = await pub(`/workspaces/${boardId}/manifest.webmanifest`);
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as { name: string }).name).toBe('Harbour plan');
    for (const p of INSTALL_ASSETS) {
      // 200 with the built asset, or 404 on a dist that was never built —
      // either way not the guard's refusal.
      const r = await pub(p);
      expect([200, 404], p).toContain(r.status);
      expect(r.status, p).not.toBe(403);
    }
    const theirs = await pub(`/workspaces/${otherBoardId}/manifest.webmanifest`);
    expect(theirs.status).toBe(403);
    // Positive control for the refusal path: the same address is fine locally.
    expect((await local(`/workspaces/${otherBoardId}/manifest.webmanifest`)).status).toBe(200);
  });
});
