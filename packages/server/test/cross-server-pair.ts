/**
 * Two real board servers for the cross-server wall tests, Harborlight and
 * Riverbend: each on a fresh data dir, so each makes its own signing key on
 * first start, each with its own board, a mock on it, and a signed-in
 * session for the same person.
 *
 * Both servers serve a frame hostname (`frames.localhost`), so the frame
 * ticket and frame cookie have a route to be presented on. The frame origin
 * names the port, so each server is made once to learn a free port and then
 * again on it. Nothing here reads a real key or reaches the network.
 */
import { expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_COOKIE } from '../src/auth/session.ts';
import type { ServerOptions } from '../src/server-options.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { loadCookieKey } from '../src/share/link-session.ts';

export const EMAIL = 'alice@example.com';
export const AGENT = 'agent-saltmarsh';

export interface Server {
  name: string;
  handle: ServerHandle;
  dataDir: string;
  base: string;
  board: string;
  /** A mockup doc on `board`. */
  mock: string;
  /** `cw_session=<value>` for EMAIL, from this server's own sign-in. */
  cookie: string;
  /** This server's key file, as `loadCookieKey` reads it. */
  key: string;
  /** The Host a request names to reach this server's frame hostname. */
  frameHost: string;
}

const codes: string[] = [];
const originalLog = console.log;

/** The log sender prints each code; collect them. Call once per file. */
export function captureLoginCodes(): () => void {
  process.env.CW_LOG_LOGIN_CODES = '1';
  console.log = (...args: unknown[]) => {
    const m = args
      .map(String)
      .join(' ')
      .match(/login code for \S+: (\d{6})/);
    if (m?.[1]) codes.push(m[1]);
    originalLog(...(args as []));
  };
  return () => {
    console.log = originalLog;
  };
}

export async function post(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** Ask `base` for a login code for EMAIL, and return the one it sent. */
export async function startCode(base: string): Promise<string> {
  const before = codes.length;
  expect((await post(base, '/api/auth/start', { email: EMAIL })).status).toBe(200);
  expect(codes.length).toBe(before + 1);
  return codes.at(-1) ?? '';
}

export async function bootServer(
  name: string,
  opts: {
    beforeStart?: (dataDir: string) => void;
    extra?: Partial<ServerOptions>;
  } = {},
): Promise<Server> {
  const dataDir = mkdtempSync(join(tmpdir(), `walls-${name.toLowerCase()}-`));
  opts.beforeStart?.(dataDir);
  const probe = createServer({ port: 0, dataDir });
  const port = probe.port;
  await probe.stop();
  const handle = createServer({
    port,
    dataDir,
    emailCodeSignIn: true,
    // So an Access-minted widget token passes its board-membership half on
    // either server for the same person.
    proxiedTrustedEmails: [EMAIL],
    frameOrigin: `http://frames.localhost:${port}`,
    frameBoardHosts: ['127.0.0.1'],
    ...opts.extra,
  });
  const base = `http://127.0.0.1:${handle.port}`;
  const made = await post(base, '/workspaces', { name: `${name} board` });
  expect(made.status).toBe(200);
  const board = ((await made.json()) as { workspace: { id: string } }).workspace.id;
  const file = join(dataDir, 'tides.html');
  writeFileSync(file, `<!doctype html><title>${name} tides</title><h1>${name} tides</h1>`);
  const doc = await post(base, `/workspaces/${board}/docs`, {
    docId: 'tides',
    type: 'mockup',
    sourceUrl: file,
  });
  expect(doc.status, await doc.clone().text()).toBe(200);
  const mock = ((await doc.json()) as { docId: string }).docId;
  expect((await post(base, `/workspaces/${board}/docs:attach`, { docId: mock })).status).toBe(200);
  const code = await startCode(base);
  const verified = await post(base, '/api/auth/verify', { email: EMAIL, code });
  expect(verified.status).toBe(200);
  const cookie = (verified.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  return {
    name,
    handle,
    dataDir,
    base,
    board,
    mock,
    cookie,
    key: loadCookieKey(dataDir),
    frameHost: `frames.localhost:${port}`,
  };
}

export async function stopServer(s: Server | undefined): Promise<void> {
  if (!s) return;
  await s.handle.stop();
  rmSync(s.dataDir, { recursive: true, force: true });
}
