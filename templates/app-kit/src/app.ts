/**
 * The app: Hono routes for its pages and assets, and a socket per open doc
 * that the collab core syncs. `server.ts` runs it; tests call `createApp`
 * with their own storage and sign-in.
 *
 * Who may open which doc is `role` below. The kit's answer is "anyone signed
 * in may edit any doc"; an app with owners or sharing changes that function
 * and nothing else, because the core asks it on every connect and action.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CollabConnection,
  type CollabStorage,
  type Principal,
  ROOM_ID,
  type RoleFn,
  type RoomHost,
  createRoomHost,
} from '@claude-workspaces/app-kit/collab';
import type { ServerWebSocket } from 'bun';
import { Hono } from 'hono';
import { docPage, homePage } from './page.ts';
import type { SignIn } from './sign-in.ts';

export interface AppOptions {
  appName: string;
  signIn: SignIn;
  storage: CollabStorage;
  /** The built client: `main.js`, `app.css`, `theme.css`. */
  distDir: string;
  /** How long after the last edit a doc is saved. */
  saveDelayMs?: number;
}

interface SocketData {
  docId: string;
  who: Principal;
  conn?: CollabConnection;
}

export const role: RoleFn = () => 'edit';

/** The one thing the app asks of Bun's server: to take a socket over.
 *  Written out rather than imported, because `Server`'s type parameters
 *  differ between @types/bun releases. */
interface Upgrader {
  upgrade(req: Request, opts: { data: SocketData }): boolean;
}

const DOC_SOCKET = /^\/docs\/([^/]+)\/ws$/;

const ASSET_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
};

function routes(opts: AppOptions) {
  const { appName, signIn, distDir } = opts;
  // Only files the build wrote are served, read once at start: an asset path
  // is looked up in this map, never joined onto the folder.
  const assets = new Map<string, string>();
  for (const name of readdirSync(distDir)) {
    const ext = name.slice(name.lastIndexOf('.'));
    if (ASSET_TYPES[ext]) assets.set(name, join(distDir, name));
  }

  return new Hono()
    .route('/auth', signIn.routes)
    .get('/assets/:name', (c) => {
      const name = c.req.param('name');
      const path = assets.get(name);
      if (!path) return c.notFound();
      const ext = name.slice(name.lastIndexOf('.'));
      return new Response(Bun.file(path), {
        headers: { 'content-type': ASSET_TYPES[ext] ?? 'application/octet-stream' },
      });
    })
    .get('/health', (c) => c.json({ ok: true }))
    .get('/', async (c) => {
      const who = await signIn.principal(c.req.raw);
      if (!who) return c.redirect(signIn.signInPath, 303);
      return c.html(homePage(appName, who));
    })
    .get('/docs/:id', async (c) => {
      const who = await signIn.principal(c.req.raw);
      if (!who) return c.redirect(signIn.signInPath, 303);
      const id = c.req.param('id');
      if (!ROOM_ID.test(id)) return c.text('A doc name is letters, digits, _ and -.', 400);
      return c.html(docPage(appName, who, id));
    });
}

/** The Hono app's type, for a typed client (`hc<AppRoutes>`). */
export type AppRoutes = ReturnType<typeof routes>;

/** A socket from another site would carry the person's cookie; refuse it. */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

export function createApp(opts: AppOptions) {
  const host: RoomHost = createRoomHost({
    storage: opts.storage,
    role,
    saveDelayMs: opts.saveDelayMs ?? 500,
    onSaveError: (docId, err) => console.error(`saving ${docId} failed:`, err),
  });
  const app = routes(opts);

  async function fetch(req: Request, server: Upgrader): Promise<Response | undefined> {
    const match = DOC_SOCKET.exec(new URL(req.url).pathname);
    if (!match?.[1]) return app.fetch(req);
    const docId = match[1];
    if (!ROOM_ID.test(docId)) return new Response('bad doc', { status: 400 });
    if (!sameOrigin(req)) return new Response('cross-site socket', { status: 403 });
    const who = await opts.signIn.principal(req);
    if (!who) return new Response('sign in first', { status: 401 });
    if (role(who, docId) === null) return new Response('no access', { status: 403 });
    const data: SocketData = { docId, who };
    return server.upgrade(req, { data })
      ? undefined
      : new Response('upgrade failed', { status: 400 });
  }

  const websocket = {
    open(ws: ServerWebSocket<SocketData>) {
      const res = host.connect({
        roomId: ws.data.docId,
        principal: ws.data.who,
        send: (bytes) => ws.sendBinary(bytes),
        onRevoked: () => ws.close(1008, 'revoked'),
      });
      if (!res.ok) {
        ws.close(1008, res.error);
        return;
      }
      ws.data.conn = res.connection;
    },
    message(ws: ServerWebSocket<SocketData>, msg: string | Buffer) {
      if (typeof msg === 'string') return;
      ws.data.conn?.receive(new Uint8Array(msg));
    },
    close(ws: ServerWebSocket<SocketData>) {
      ws.data.conn?.close();
    },
  };

  return { app, host, fetch, websocket };
}
