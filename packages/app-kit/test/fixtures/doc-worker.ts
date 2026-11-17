/**
 * A Worker with one Durable Object per doc, written the way a Worker app
 * mounts the kit's `./do` adapter. The tests bundle it and run it in workerd
 * through Miniflare.
 *
 * The Worker's own sign-in check is stood in for by two query parameters,
 * `user` and `role`: an app reads its session token here instead, and checks
 * the person's access to the room, before it forwards the upgrade.
 */
import type { DurableObjectNamespace, DurableObjectState } from '@cloudflare/workers-types';
import type { CollabRole } from '../../src/collab/index.ts';
import { type DurableRoom, createDurableRoom, sqlCollabStorage } from '../../src/do/index.ts';

interface Env {
  DOC: DurableObjectNamespace;
}

declare const WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket } };

type HibernatingWebSocket = WebSocket & {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
};

const ROLES = new Set(['owner', 'edit', 'comment', 'view']);
const DOC_PATH = /^\/docs\/([A-Za-z0-9_-]+)\/(ws|revoke|close|accepts|instance|text)$/;

export class DocRoom {
  private readonly room: DurableRoom<HibernatingWebSocket>;
  /** New on every construction, so a test can tell a woken object from a
   *  kept one. */
  private readonly instance = crypto.randomUUID();
  /** Sockets accepted per user by this instance, so a test can tell
   *  whether a page reconnected. */
  private readonly accepts = new Map<string, number>();

  constructor(ctx: DurableObjectState, _env: Env) {
    const state = ctx as unknown as {
      acceptWebSocket(ws: HibernatingWebSocket): void;
      getWebSockets(): HibernatingWebSocket[];
      storage: { sql: Parameters<typeof sqlCollabStorage>[0] };
    };
    this.room = createDurableRoom({
      ctx: state,
      storage: sqlCollabStorage(state.storage.sql),
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const match = DOC_PATH.exec(url.pathname);
    if (!match?.[1]) return new Response('not found', { status: 404 });
    const [, docId, verb] = match;
    if (verb === 'instance') return new Response(this.instance);
    if (verb === 'text') {
      const res = this.room.read(docId, (doc) => doc.getText('body').toString());
      return res.ok ? new Response(String(res.value)) : new Response(res.error, { status: 404 });
    }
    const user = url.searchParams.get('user') ?? '';
    if (verb === 'accepts') return new Response(String(this.accepts.get(user) ?? 0));
    if (verb === 'revoke') return new Response(String(this.room.revoke(user)));
    if (verb === 'close') {
      const code = Number(url.searchParams.get('code'));
      const reason = url.searchParams.get('reason') ?? '';
      return new Response(String(this.room.closeRoom(docId, code, reason)));
    }
    const role = url.searchParams.get('role') ?? '';
    if (!user || !ROLES.has(role)) return new Response('sign in first', { status: 401 });
    const pair = new WebSocketPair();
    const accepted = this.room.accept(pair[1] as HibernatingWebSocket, {
      roomId: docId,
      principal: { id: user, name: user },
      role: role as CollabRole,
    });
    if (!accepted.ok) return new Response(accepted.error, { status: 403 });
    this.accepts.set(user, (this.accepts.get(user) ?? 0) + 1);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  webSocketMessage(ws: HibernatingWebSocket, message: ArrayBuffer | string): void {
    this.room.message(ws, message);
  }

  webSocketClose(ws: HibernatingWebSocket): void {
    this.room.close(ws);
  }
}

export default {
  fetch(req: Request, env: Env): Promise<Response> | Response {
    const match = DOC_PATH.exec(new URL(req.url).pathname);
    if (!match?.[1]) return new Response('not found', { status: 404 });
    const stub = env.DOC.get(env.DOC.idFromName(match[1]));
    return stub.fetch(req as never) as unknown as Promise<Response>;
  },
};
