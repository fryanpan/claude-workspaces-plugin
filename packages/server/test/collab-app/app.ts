/**
 * A test app on the collab core, with no Workspaces imports: it takes only
 * `@claude-workspaces/core/collab`, so it proves the core runs for an app
 * that is not Workspaces.
 *
 * Its sign-in check is a header naming the person, which a real app would
 * replace with its own; its role function gives Alice edit and Bob view in
 * every room, and nobody else anything. A room is the `:id` in
 * `/rooms/:id/ws` (the socket) or `/rooms/:id/actions/:name` (a POST).
 */
import {
  type CollabConnection,
  type CollabStorage,
  type RoleFn,
  createRoomHost,
} from '@claude-workspaces/core/collab';

export const APP_ROLES: RoleFn = (p) =>
  p.id === 'alice' ? 'edit' : p.id === 'bob' ? 'view' : null;

interface SocketData {
  roomId: string;
  personId: string;
  conn?: CollabConnection;
}

export function startCollabApp(storage: CollabStorage) {
  const host = createRoomHost({
    storage,
    role: APP_ROLES,
    saveDelayMs: 20,
    actions: {
      append: (ctx, body) => {
        ctx.doc.getText('t').insert(ctx.doc.getText('t').length, String(body.text ?? ''));
        return ctx.doc.getText('t').toString();
      },
    },
  });
  const server = Bun.serve<SocketData>({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req, srv) {
      const url = new URL(req.url);
      const personId = req.headers.get('x-person') ?? '';
      const ws = /^\/rooms\/([^/]+)\/ws$/.exec(url.pathname);
      if (ws?.[1]) {
        const roomId = decodeURIComponent(ws[1]);
        if (APP_ROLES({ id: personId }, roomId) === null)
          return new Response('no role', { status: 403 });
        return srv.upgrade(req, { data: { roomId, personId } })
          ? undefined
          : new Response('upgrade failed', { status: 400 });
      }
      const act = /^\/rooms\/([^/]+)\/actions\/([\w-]+)$/.exec(url.pathname);
      if (act?.[1] && act[2] && req.method === 'POST') {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: 'bad-body' }, { status: 400 });
        }
        const res = host.action(decodeURIComponent(act[1]), { id: personId }, act[2], body);
        if (res.ok) return Response.json({ value: res.value });
        const status = res.error === 'no-role' ? 403 : res.error === 'unknown-action' ? 404 : 400;
        return Response.json({ error: res.error, message: res.message }, { status });
      }
      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        const res = host.connect({
          roomId: ws.data.roomId,
          principal: { id: ws.data.personId },
          send: (bytes) => ws.sendBinary(bytes),
        });
        if (!res.ok) {
          ws.close(1008, res.error);
          return;
        }
        ws.data.conn = res.connection;
      },
      message(ws, msg) {
        if (typeof msg === 'string') return;
        ws.data.conn?.receive(new Uint8Array(msg));
      },
      close(ws) {
        ws.data.conn?.close();
      },
    },
  });
  return {
    host,
    base: `http://127.0.0.1:${server.port}`,
    ws: (roomId: string) => `ws://127.0.0.1:${server.port}/rooms/${roomId}/ws`,
    stop: () => server.stop(true),
  };
}
