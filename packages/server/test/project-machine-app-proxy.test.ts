/**
 * A project's dev server, on the project machine, opened by a collaborator
 * through the board's own sign-in.
 *
 * The machine is simulated in one process, configured as `machine:deploy`
 * configures a Fly machine: the server on loopback with whole-server Access
 * (`CF_ACCESS_AUD`), the project's hostname as its proxied host with the
 * owner's address as the only operator, loopback callers skipping Access
 * (`CW_LOOPBACK_SKIPS_ACCESS`), and a frame hostname (`CW_FRAME_ORIGIN`).
 * Requests from the edge carry `cf-ray`, and an Access assertion where
 * Cloudflare would have added one. Cloudflare adds it from its own cookie,
 * which is SameSite=Lax and so is not sent with an opaque frame's
 * subresources; a request without it here is that request.
 *
 * The dev server is Harborlight's admin dashboard: a Vite-shaped fixture
 * started under the board's prefix (`vite-base-fixture.ts`), bound to
 * loopback, attached with `servesPrefix`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frameCookieName } from '../src/frame-ticket.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type AccessHarness, accessHarness } from './access-share.ts';
import { type ViteFixture, startViteFixture } from './vite-base-fixture.ts';

const AUD = 'aud-board-harborlight';
const BOARD_HOST = 'harborlight.boards.example';
const FRAME_HOST = 'harborlight.frames.example';
const OWNER = 'owner@harborlight.example';
const MEMBER = 'reviewer@partner.example';
const OUTSIDER = 'someone@elsewhere.example';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };

describe('a dev server on a project machine, opened through the board', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let access: AccessHarness;
  let vite: ViteFixture;
  let ws: string;
  let prefix: string;

  /** On the project's hostname, through the edge; `email` signs it in. */
  const onBoard = async (
    email: string | null,
    path: string,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      headers: {
        host: BOARD_HOST,
        ...CF_RAY,
        ...(email ? { 'cf-access-jwt-assertion': await access.signJwt(AUD, email) } : {}),
        ...headers,
      },
    });
  /** On the frame hostname, through the edge, with no Access assertion. */
  const onFrames = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      headers: { host: FRAME_HOST, ...CF_RAY, ...headers },
    });
  /** As the machine itself: loopback, no edge. */
  const local = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: `localhost:${handle.port}` },
      body: JSON.stringify(body),
    });

  /** The member's browser: open the app, take the frame, trade its ticket. */
  const memberFrame = async (email = MEMBER) => {
    const host = await onBoard(email, prefix, { 'sec-fetch-dest': 'document' });
    expect(host.status).toBe(200);
    const html = await host.text();
    const raw = /data-src="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&') ?? '';
    const src = new URL(raw);
    const redeemed = await onFrames(`${src.pathname}${src.search}`, { 'sec-fetch-dest': 'iframe' });
    const cookie = (redeemed.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    return { src, redeemed, cookie };
  };
  const script = (path: string, cookie: string) =>
    onFrames(path, { 'sec-fetch-dest': 'script', 'sec-fetch-site': 'same-origin', cookie });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'project-machine-app-'));
    access = await accessHarness(MEMBER);
    vite = startViteFixture();
    handle = createServer({
      port: 0,
      dataDir,
      cfAccess: { ...access.serverOptions.cfAccess, audience: AUD },
      proxiedTrustedHosts: [BOARD_HOST],
      proxiedTrustedEmails: [OWNER],
      loopbackSkipsAccess: true,
      frameOrigin: `https://${FRAME_HOST}`,
    });
    base = `http://127.0.0.1:${handle.port}`;
    const made = await local('/workspaces', { name: 'Harborlight' });
    ws = ((await made.json()) as { workspace: { id: string } }).workspace.id;
    // The lead's order: attach the port, learn the prefix, start Vite under it.
    const attached = await local(`/workspaces/${ws}/apps`, {
      docId: 'harborlight-admin',
      origin: vite.origin,
      servesPrefix: true,
    });
    expect(attached.status, await attached.clone().text()).toBe(200);
    const body = (await attached.json()) as { prefix: string; servesPrefix: boolean };
    expect(body.servesPrefix).toBe(true);
    prefix = body.prefix;
    vite.setBase(prefix);
    // A member, as a redeemed share link records one.
    handle.shareLinks.addToAudience(ws, [MEMBER], 'Bryan');
    const link = handle.shareLinks.create({ workspaceId: ws, createdBy: 'Bryan' });
    expect(handle.shareLinks.redeem(link.linkId, MEMBER).ok).toBe(true);
  });
  afterAll(async () => {
    await handle.stop();
    await vite.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('a signed-in collaborator', () => {
    it('gets a host page that frames the app on the frame hostname, with a ticket', async () => {
      const { src, redeemed, cookie } = await memberFrame();
      expect(src.origin).toBe(`https://${FRAME_HOST}`);
      expect(src.pathname).toBe(prefix);
      expect(src.searchParams.get('cw-ft')).not.toBeNull();
      expect(redeemed.status).toBe(303);
      expect(cookie.startsWith(`${frameCookieName(ws)}=`)).toBe(true);
    });

    it('loads the frame with the widget and the dev server’s module scripts', async () => {
      const { cookie } = await memberFrame();
      const frame = await onFrames(`${prefix}?cw-frame=1`, { 'sec-fetch-dest': 'iframe', cookie });
      expect(frame.status).toBe(200);
      const html = await frame.text();
      expect(html).toContain('claude-feedback-widget');
      expect(html).toContain(`<script type="module" src="${prefix}src/main.ts">`);
      // Each module the page names, then the one the entry imports, with
      // only the frame's cookie: no Access assertion rides on them.
      for (const [path, says] of [
        [`${prefix}@vite/client`, 'harborlight'],
        [`${prefix}src/main.ts`, "from './router.ts'"],
        [`${prefix}src/router.ts`, JSON.stringify(prefix)],
      ] as const) {
        const r = await script(path, cookie);
        expect(r.status, path).toBe(200);
        expect(r.headers.get('content-type')).toBe('text/javascript');
        expect(await r.text()).toContain(says);
      }
      // The dev server was asked at the board's own paths, prefix kept.
      expect(vite.asked).toContain(`${prefix}src/router.ts`);
    });

    it("reaches the router's own pages under the prefix", async () => {
      const { cookie } = await memberFrame();
      const r = await onFrames(`${prefix}berths?cw-frame=1`, {
        'sec-fetch-dest': 'iframe',
        cookie,
      });
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('Harborlight admin');
    });

    it('CONTROL: the same script asked on the board hostname without sign-in is refused', async () => {
      // What the member's opaque frame would have sent before this change.
      const r = await onBoard(null, `${prefix}src/main.ts`, { 'sec-fetch-dest': 'script' });
      expect(r.status).toBe(401);
    });

    it('loses the frame the moment the membership ends', async () => {
      const removed = 'keeper@partner.example';
      handle.shareLinks.addToAudience(ws, [removed], 'Bryan');
      const link = handle.shareLinks.create({ workspaceId: ws, createdBy: 'Bryan' });
      expect(handle.shareLinks.redeem(link.linkId, removed).ok).toBe(true);
      const { cookie } = await memberFrame(removed);
      expect((await script(`${prefix}src/main.ts`, cookie)).status).toBe(200);
      expect(handle.shareLinks.removeMember(ws, removed)).toBe(true);
      const after = await script(`${prefix}src/main.ts`, cookie);
      expect(after.status).toBe(403);
      expect(await after.text()).not.toContain('router');
    });
  });

  describe('the same URL with no sign-in', () => {
    it('is refused on the board hostname: the page, the frame and a script', async () => {
      for (const [path, dest] of [
        [prefix, 'document'],
        [`${prefix}?cw-frame=1`, 'iframe'],
        [`${prefix}src/main.ts`, 'script'],
      ] as const) {
        const r = await onBoard(null, path, { 'sec-fetch-dest': dest });
        expect(r.status, path).toBe(401);
        expect(await r.text()).not.toContain('Harborlight admin');
      }
    });

    it('is refused on the frame hostname without a ticket or cookie', async () => {
      const frame = await onFrames(`${prefix}?cw-frame=1`, { 'sec-fetch-dest': 'iframe' });
      expect(frame.status).toBe(401);
      const js = await script(`${prefix}src/main.ts`, '');
      expect(js.status).toBe(401);
      expect(await js.text()).not.toContain('router');
    });

    it("is refused to a signed-in address the board never gave, and to a member's bare token", async () => {
      const outsider = await onBoard(OUTSIDER, prefix, { 'sec-fetch-dest': 'document' });
      expect(outsider.status).toBe(403);
      // A member's Access token on the frame hostname, with no ticket.
      const bare = await onFrames(`${prefix}src/main.ts`, {
        'sec-fetch-dest': 'script',
        'sec-fetch-site': 'same-origin',
        'cf-access-jwt-assertion': await access.signJwt(AUD, MEMBER),
      });
      expect(bare.status).toBe(403);
    });
  });

  it('serves the owner as before: an operator ticket, the app scripts with its cookie', async () => {
    const { src, cookie } = await memberFrame(OWNER);
    expect(src.origin).toBe(`https://${FRAME_HOST}`);
    expect((await script(`${prefix}src/main.ts`, cookie)).status).toBe(200);
  });
});
