/**
 * A test app's presence, on the collab core alone (no Workspaces imports).
 *
 * Sign-in is a header naming the person. Alice has a role on both boards,
 * Bob only on Harborlight, Saltmarsh only on Riverbend. A page is a path
 * segment; `private` has no presence. The socket is
 * `/rooms/:board/presence`: a page sends `{ spot }` or `{ follow }` as JSON,
 * and is sent `{ view }` whenever what it should show may have changed.
 */
import {
  type PresenceConnection,
  type RoleFn,
  createPresenceHub,
} from '@claude-workspaces/core/collab';

export interface AppSpot {
  page: string;
  scroll: number;
}

export const PRESENCE_ROLES: RoleFn = (p, room) => {
  if (p.id === 'alice') return 'edit';
  if (p.id === 'bob') return room === 'harborlight' ? 'edit' : null;
  if (p.id === 'saltmarsh') return room === 'riverbend' ? 'view' : null;
  return null;
};

export function parseAppSpot(raw: unknown): AppSpot | null {
  const r = raw as { page?: unknown; scroll?: unknown } | null;
  if (!r || typeof r.page !== 'string' || !/^[a-z0-9-]{1,64}$/.test(r.page)) return null;
  const scroll = typeof r.scroll === 'number' && r.scroll >= 0 && r.scroll <= 1 ? r.scroll : 0;
  return { page: r.page, scroll };
}

interface Data {
  roomId: string;
  personId: string;
  conn?: PresenceConnection<AppSpot>;
}

export function startPresenceApp(opts: { appWide: boolean; burst?: number; now?: () => number }) {
  const hub = createPresenceHub<AppSpot>({
    role: PRESENCE_ROLES,
    parseSpot: (raw) => parseAppSpot((raw as { spot?: unknown } | null)?.spot),
    pageOf: (s) => s.page,
    hasPresence: (page) => page !== 'private',
    appWide: opts.appWide,
    rate: { burst: opts.burst ?? 50, perSecond: 1 },
    ...(opts.now ? { now: opts.now } : {}),
  });
  const push = (ws: { data: Data; send: (s: string) => unknown }) => {
    if (ws.data.conn) ws.send(JSON.stringify({ view: ws.data.conn.view() }));
  };
  const server = Bun.serve<Data>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      const m = /^\/rooms\/([^/]+)\/presence$/.exec(new URL(req.url).pathname);
      if (!m?.[1]) return new Response('not found', { status: 404 });
      const roomId = decodeURIComponent(m[1]);
      const personId = req.headers.get('x-person') ?? '';
      if (PRESENCE_ROLES({ id: personId }, roomId) === null) {
        return new Response('no role', { status: 403 });
      }
      return srv.upgrade(req, { data: { roomId, personId } })
        ? undefined
        : new Response('upgrade failed', { status: 400 });
    },
    websocket: {
      open(ws) {
        const res = hub.join({
          roomId: ws.data.roomId,
          principal: { id: ws.data.personId, name: ws.data.personId },
          // Called only when this socket may see the change: push to it alone.
          onChange: () => push(ws),
        });
        if (!res.ok) {
          ws.close(1008, res.error);
          return;
        }
        ws.data.conn = res.connection;
        push(ws);
      },
      message(ws, msg) {
        const conn = ws.data.conn;
        if (!conn || typeof msg !== 'string') return;
        let body: { spot?: unknown; follow?: unknown };
        try {
          body = JSON.parse(msg) as typeof body;
        } catch {
          return;
        }
        if ('follow' in body) {
          conn.follow(typeof body.follow === 'string' ? body.follow : null);
          push(ws);
        } else if (conn.update(body) === 'applied') {
          push(ws);
        }
      },
      close(ws) {
        ws.data.conn?.close();
      },
    },
  });
  return {
    hub,
    url: (room: string) => `ws://127.0.0.1:${server.port}/rooms/${room}/presence`,
    stop: () => server.stop(true),
  };
}
