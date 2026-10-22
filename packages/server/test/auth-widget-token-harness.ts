/**
 * Shared set-up for the widget board token (`wt2`) route suites: a real
 * server with emailed-code sign-in, a sign-in, a mint through the popup's
 * route, and a comment posted the way the widget posts it.
 */
import { afterEach, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementAnchor, User } from '@claude-workspaces/core';
import { activityLogPath } from '../src/activity.ts';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import { SESSION_COOKIE } from '../src/auth/session.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

// The log sender masks the code unless this is set — see
// `auth/code-sender.ts`. This suite drives a real sign-in, so it needs the
// code the way a developer does, and it says so rather than depending on a
// default. Set before any server boots: the flag is read per send.
process.env.CW_LOG_LOGIN_CODES = '1';

export const bryan: User = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };

export const fakeAnchor: ElementAnchor = {
  kind: 'element',
  fingerprint: {
    tag: 'BUTTON',
    stableAttrs: {},
    classes: [],
    text: 'Go',
    path: 'BUTTON[0] > BODY[0]',
    dataAttrs: {},
  },
  snippet: { text: 'Go' },
};

/** An origin the policy treats as a dev server on this machine. */
export const DEV_ORIGIN = 'http://127.0.0.1:5173';

export const cleanups: Array<() => void | Promise<void>> = [];
export const codes: string[] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => {
  const m = args
    .map(String)
    .join(' ')
    .match(/login code for \S+: (\d{6})/);
  if (m?.[1]) codes.push(m[1]);
  originalLog(...(args as []));
};

/** Stop every server a case booted, and forget the owners it named. Call
 *  once at the top of each suite that boots through this module. */
export function stopServersAfterEach(): void {
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
    resetOwnerIdentities();
  });
}

export function boot(options: { requireEmailAuth?: boolean; dataDir?: string } = {}): {
  base: string;
  dataDir: string;
  handle: ServerHandle;
  /** This server's board — every doc it holds is addressed under it, and
   *  each `boot()` is a server of its own. */
  ws: string;
} {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'widget-token-routes-'));
  // emailCodeSignIn: the server's own emailed-code sign-in is off by default now
  // that every browser-facing hostname sits behind Cloudflare Access. These tests
  // are about that flow, so they ask for it explicitly.
  const handle = createServer({
    port: 0,
    dataDir,
    emailCodeSignIn: true,
    requireEmailAuth: options.requireEmailAuth,
  });
  cleanups.push(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  // Minted through the store: this helper is synchronous, and half these
  // servers are booted with the write gate on, where an HTTP seed is a 401.
  const ws = handle.tasks.createWorkspace('Test board').id;
  return { base: `http://127.0.0.1:${handle.port}`, dataDir, handle, ws };
}

export async function signIn(base: string, email: string): Promise<string> {
  const before = codes.length;
  const started = await fetch(`${base}/api/auth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(started.status).toBe(200);
  expect(codes.length).toBe(before + 1);
  const res = await fetch(`${base}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, code: codes[codes.length - 1] }),
  });
  expect(res.status).toBe(200);
  const pair = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  expect(pair.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  return pair;
}

export async function mintToken(
  base: string,
  cookie: string | null,
  workspaceId: string,
  origin: string = DEV_ORIGIN,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await fetch(`${base}/api/auth/widget-token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: JSON.stringify({ origin, workspaceId }),
  });
}

/** Sign in and exchange the session for a widget board token. */
export async function signInAndMint(
  base: string,
  email: string,
  workspaceId: string,
): Promise<{ cookie: string; token: string }> {
  const cookie = await signIn(base, email);
  const res = await mintToken(base, cookie, workspaceId);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string };
  expect(typeof body.token).toBe('string');
  return { cookie, token: body.token };
}

/** A token-carrying request as the widget sends it: a cross-origin fetch
 *  from the dev server, so the browser stamps Origin on it. */
export function bearer(token: string, origin: string | null = DEV_ORIGIN): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...(origin === null ? {} : { origin }) };
}

export async function postComment(
  base: string,
  dataDir: string,
  ws: string,
  docId: string,
  token?: string,
  origin: string | null = DEV_ORIGIN,
): Promise<Response> {
  const file = join(dataDir, `${docId}.md`);
  writeFileSync(file, '# Heading\n\nSome prose to comment on.\n');
  const created = await fetch(`${base}/workspaces/${ws}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId, type: 'markdown', sourceUrl: file }),
  });
  expect(created.status).toBe(200);
  return await fetch(`${base}/workspaces/${ws}/docs/${docId}/threads`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? bearer(token, origin) : {}),
    },
    body: JSON.stringify({ author: bryan, text: 'this needs more detail', anchor: fakeAnchor }),
  });
}

export interface ActivityRow {
  type: string;
  actorId: string;
  actorName: string;
}

export function commentRows(dataDir: string): ActivityRow[] {
  // A log that was never written is the "no comment landed" we assert on.
  if (!existsSync(activityLogPath(dataDir))) return [];
  return readFileSync(activityLogPath(dataDir), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as ActivityRow)
    .filter((r) => r.type === 'comment');
}
