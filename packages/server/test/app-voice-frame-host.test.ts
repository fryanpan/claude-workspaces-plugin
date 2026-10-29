/**
 * An app's frame on the frame hostname carries an app voice token only when
 * its frame ticket says the host page was served to somebody who may hold
 * one.
 *
 * The frame's own document request carries the frame cookie, not the board's
 * session cookie, so on a server where browsers must sign in the frame proves
 * nobody. What the host page knew about its reader travels in the ticket it
 * writes into the frame's address (`frame-ticket.ts`). Driven through a real
 * server as a browser drives it: the host page, the ticket's redeem, then
 * the frame with the cookie.
 *
 * Fixtures are fictional — a harbour pilot's app.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_VOICE_SEED_ATTR } from '@claude-workspaces/core/app-voice';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import { frameKeys, mintFrameTicket } from '../src/frame-ticket.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { loadCookieKey } from '../src/share/link-session.ts';
import { signedInPerson } from './signed-in-person.ts';

const OWNER_EMAIL = 'owner@harborlight.test';

describe("an app's frame on the frame hostname", () => {
  let handle: ServerHandle;
  let page: ReturnType<typeof Bun.serve>;
  let dataDir: string;
  let base = '';
  let ws = '';
  let doc = '';
  let owner: Record<string, string> = {};
  let alice: Record<string, string> = {};
  const BOARD = () => ({ host: `127.0.0.1:${handle.port}` });
  const FRAMES = () => ({ host: `frames.localhost:${handle.port}` });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'app-voice-frame-host-'));
    page = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        new Response(
          '<!doctype html><html><head><script src="/widget/app-voice.js"></script></head>' +
            '<body><h1>Riverbend pilot</h1></body></html>',
          { headers: { 'content-type': 'text/html' } },
        ),
    });
    // Port 0 picks one, and the frame origin names the port, so the server
    // is made once to learn a free port and then again on it.
    const probe = createServer({ port: 0, dataDir });
    const port = probe.port;
    await probe.stop();
    handle = createServer({
      port,
      dataDir,
      frameOrigin: `http://frames.localhost:${port}`,
      frameBoardHosts: ['127.0.0.1'],
      requireSignInToWrite: true,
      ownerEmail: OWNER_EMAIL,
    });
    base = `http://127.0.0.1:${handle.port}`;
    const made = await fetch(`${base}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...BOARD() },
      body: JSON.stringify({ name: 'Harborlight' }),
    });
    ws = ((await made.json()) as { workspace: { id: string } }).workspace.id;
    const attached = await fetch(`${base}/workspaces/${ws}/apps`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...BOARD() },
      body: JSON.stringify({ docId: 'riverbend-pilot', origin: `http://127.0.0.1:${page.port}` }),
    });
    doc = ((await attached.json()) as { docId: string }).docId;
    owner = signedInPerson(handle, dataDir, base, { email: OWNER_EMAIL, name: 'Bryan' }).headers;
    alice = signedInPerson(handle, dataDir, base, { email: 'alice@harborlight.example' }).headers;
  });
  afterAll(async () => {
    await handle.stop();
    page.stop(true);
    resetOwnerIdentities();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** The host page, as `reader` opens it on the board, and its frame's address. */
  const frameSrc = async (reader: Record<string, string>): Promise<URL> => {
    const host = await fetch(`${base}/workspaces/${ws}/apps/${doc}/`, {
      headers: {
        ...BOARD(),
        'sec-fetch-dest': 'document',
        ...(reader.cookie ? { cookie: reader.cookie } : {}),
      },
    });
    expect(host.status).toBe(200);
    const src = /data-src="([^"]+)"/.exec(await host.text())?.[1]?.replace(/&amp;/g, '&') ?? '';
    expect(src).toContain('cw-ft=');
    return new URL(src);
  };
  /** The frame at `src`, loaded as a browser's frame loads it: the ticket
   *  traded for the cookie, then the frame itself with the cookie. */
  const frameOf = async (src: URL): Promise<{ status: number; html: string }> => {
    const iframe = { ...FRAMES(), 'sec-fetch-dest': 'iframe' };
    const traded = await fetch(`${base}${src.pathname}${src.search}`, {
      headers: iframe,
      redirect: 'manual',
    });
    if (traded.status !== 303) return { status: traded.status, html: await traded.text() };
    const cookie = (traded.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const frame = await fetch(`${base}${traded.headers.get('location')}`, {
      headers: { ...iframe, cookie },
    });
    return { status: frame.status, html: await frame.text() };
  };
  const withTicket = (ticket: string): URL => {
    const src = new URL(`http://frames.localhost:${handle.port}/workspaces/${ws}/apps/${doc}/`);
    src.searchParams.set('cw-frame', '1');
    src.searchParams.set('cw-ft', ticket);
    return src;
  };
  const keys = () => frameKeys(loadCookieKey(dataDir));

  it('carries a token when the host page was served to the owner', async () => {
    const frame = await frameOf(await frameSrc(owner));
    expect(frame.status).toBe(200);
    expect(frame.html).toContain('Riverbend pilot');
    expect(frame.html).toContain(APP_VOICE_SEED_ATTR);
  });

  it('carries none when the host page was served to another person or to nobody', async () => {
    for (const reader of [alice, {}]) {
      const frame = await frameOf(await frameSrc(reader));
      // CONTROL: the frame itself is served; only the token is withheld.
      expect(frame.status).toBe(200);
      expect(frame.html).toContain('Riverbend pilot');
      expect(frame.html).not.toContain(APP_VOICE_SEED_ATTR);
    }
  });

  it('carries none for a ticket that grants no voice, as a visitor’s would', async () => {
    // A share visitor's host page frames opaquely and mints no ticket at all
    // (`frameFor`); a ticket minted for a viewer who may not hold a token is
    // the most such a page could carry.
    const ticket = mintFrameTicket(keys().ticket, 'frames.localhost', ws);
    const frame = await frameOf(withTicket(ticket));
    expect(frame.status).toBe(200);
    expect(frame.html).not.toContain(APP_VOICE_SEED_ATTR);
  });

  it('serves nothing for no ticket, another board’s ticket or an expired one', async () => {
    const iframe = { ...FRAMES(), 'sec-fetch-dest': 'iframe' };
    const bare = await fetch(`${base}/workspaces/${ws}/apps/${doc}/?cw-frame=1`, {
      headers: iframe,
    });
    expect(bare.status).toBe(403);
    expect(await bare.text()).not.toContain(APP_VOICE_SEED_ATTR);
    const other = mintFrameTicket(
      keys().ticket,
      'frames.localhost',
      'w-riverbend',
      Date.now(),
      true,
    );
    const expired = mintFrameTicket(
      keys().ticket,
      'frames.localhost',
      ws,
      Date.now() - 10 * 60_000,
      true,
    );
    for (const ticket of [other, expired]) {
      const frame = await frameOf(withTicket(ticket));
      expect(frame.status).toBe(404);
      expect(frame.html).not.toContain(APP_VOICE_SEED_ATTR);
    }
    // CONTROL: the same mint, for this board and now, does open the frame
    // with a token, so the refusals above are the board and the clock.
    const good = mintFrameTicket(keys().ticket, 'frames.localhost', ws, Date.now(), true);
    expect((await frameOf(withTicket(good))).html).toContain(APP_VOICE_SEED_ATTR);
  });
});
