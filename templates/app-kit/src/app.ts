/**
 * The app: Hono routes for its pages and assets, and a socket per open doc
 * that the collab core syncs. `server.ts` runs it; tests call `createApp`
 * with their own storage and sign-in.
 *
 * Who may do what to which doc is the role table (`doc-roles.ts`): the first
 * person to open a doc owns it, the owner gives others a role at
 * `POST /docs/<id>/roles`, and everybody else gets the table's default
 * (`edit`). The core asks the table on every connect, action and presence
 * update, and again after every role change, so a `view` socket's edits are
 * dropped by the server however the page behaves.
 *
 * Beside the doc socket, `/docs/<id>/presence` carries who else has the doc
 * open (`presence.ts`), scoped by the same table.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CollabConnection,
  type CollabStorage,
  type Principal,
  ROOM_ID,
  type RoomHost,
  createRoomHost,
} from '@claude-workspaces/app-kit/collab';
import type { ServerWebSocket } from 'bun';
import { Hono } from 'hono';
import { type DocRoles, isRole } from './doc-roles.ts';
import { docPage, homePage } from './page.ts';
import { type DocPresence, type PresenceSocket, createDocPresence } from './presence.ts';
import { type SignIn, sameOrigin } from './sign-in.ts';

export interface AppOptions {
  appName: string;
  signIn: SignIn;
  storage: CollabStorage;
  /** Who may do what to each doc (`openDocRoles`). */
  roles: DocRoles;
  /** The built client: `main.js`, `app.css`, `theme.css`. */
  distDir: string;
  /** How long after the last edit a doc is saved. */
  saveDelayMs?: number;
}

type SocketData =
  | { kind: 'doc'; docId: string; who: Principal; conn?: CollabConnection }
  | { kind: 'presence'; docId: string; who: Principal; presence?: PresenceSocket };

/** The one thing the app asks of Bun's server: to take a socket over.
 *  Written out rather than imported, because `Server`'s type parameters
 *  differ between @types/bun releases. */
interface Upgrader {
  upgrade(req: Request, opts: { data: SocketData }): boolean;
}

const DOC_SOCKET = /^\/docs\/([^/]+)\/(ws|presence)$/;

const ASSET_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
};

/** What the roles route reaches beyond the options: the live rooms, so a
 *  role change reaches every open socket of the doc. */
interface Live {
  host: RoomHost;
  presence: DocPresence;
}

function routes(opts: AppOptions, live: Live) {
  const { appName, signIn, distDir, roles } = opts;
  // Only files the build wrote are served, read once at start: an asset path
  // is looked up in this map, never joined onto the folder.
  const assets = new Map<string, string>();
  for (const name of readdirSync(distDir)) {
    const ext = name.slice(name.lastIndexOf('.'));
    if (ASSET_TYPES[ext]) assets.set(name, join(distDir, name));
  }

  return (
    new Hono()
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
        const role = roles.claim(id, who);
        if (role === null) return c.text('You have no access to this doc.', 403);
        return c.html(docPage(appName, who, id, role));
      })
      // The owner gives a person a role on the doc, by their account's email.
      .post('/docs/:id/roles', async (c) => {
        if (!sameOrigin(c.req.raw)) return c.text('cross-site form', 403);
        const who = await signIn.principal(c.req.raw);
        if (!who) return c.text('sign in first', 401);
        const id = c.req.param('id');
        if (!ROOM_ID.test(id)) return c.text('A doc name is letters, digits, _ and -.', 400);
        if (roles.role(who, id) !== 'owner') return c.text('Only the doc’s owner sets roles.', 403);
        const form = await c.req.raw.formData().catch(() => null);
        const email = form?.get('email');
        const role = form?.get('role');
        if (
          typeof email !== 'string' ||
          email.length === 0 ||
          email.length > 320 ||
          !isRole(role)
        ) {
          return c.text('Give an email and a role: owner, edit, comment or view.', 400);
        }
        const person = await signIn.personByEmail(email);
        if (!person) return c.text('No account has that email.', 404);
        if (person.id === who.id) return c.text('You cannot change your own role.', 400);
        roles.set(id, person.id, role);
        live.host.recheckRoles(id);
        live.presence.recheck(id);
        return c.redirect(`/docs/${id}`, 303);
      })
  );
}

/** The Hono app's type, for a typed client (`hc<AppRoutes>`). */
export type AppRoutes = ReturnType<typeof routes>;

export function createApp(opts: AppOptions) {
  const { role } = opts.roles;
  const host: RoomHost = createRoomHost({
    storage: opts.storage,
    role,
    saveDelayMs: opts.saveDelayMs ?? 500,
    onSaveError: (docId, err) => console.error(`saving ${docId} failed:`, err),
  });
  const presence = createDocPresence(role);
  const app = routes(opts, { host, presence });

  async function fetch(req: Request, server: Upgrader): Promise<Response | undefined> {
    const match = DOC_SOCKET.exec(new URL(req.url).pathname);
    if (!match?.[1]) return app.fetch(req);
    const docId = match[1];
    if (!ROOM_ID.test(docId)) return new Response('bad doc', { status: 400 });
    if (!sameOrigin(req)) return new Response('cross-site socket', { status: 403 });
    const who = await opts.signIn.principal(req);
    if (!who) return new Response('sign in first', { status: 401 });
    if (opts.roles.claim(docId, who) === null) return new Response('no access', { status: 403 });
    const data: SocketData =
      match[2] === 'presence' ? { kind: 'presence', docId, who } : { kind: 'doc', docId, who };
    return server.upgrade(req, { data })
      ? undefined
      : new Response('upgrade failed', { status: 400 });
  }

  const websocket = {
    open(ws: ServerWebSocket<SocketData>) {
      if (ws.data.kind === 'presence') {
        const p: PresenceSocket = {
          docId: ws.data.docId,
          who: ws.data.who,
          send: (text) => ws.sendText(text),
          close: (code, reason) => ws.close(code, reason),
        };
        ws.data.presence = p;
        presence.open(p);
        return;
      }
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
      if (ws.data.kind === 'presence') {
        if (typeof msg === 'string' && ws.data.presence) presence.message(ws.data.presence, msg);
        return;
      }
      if (typeof msg === 'string') return;
      ws.data.conn?.receive(new Uint8Array(msg));
    },
    close(ws: ServerWebSocket<SocketData>) {
      if (ws.data.kind === 'presence') {
        if (ws.data.presence) presence.close(ws.data.presence);
        return;
      }
      ws.data.conn?.close();
    },
  };

  return { app, host, fetch, websocket };
}
