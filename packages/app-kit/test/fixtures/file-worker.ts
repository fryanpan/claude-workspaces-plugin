/**
 * A Worker whose docs are markdown files kept somewhere else, the way a
 * Worker app mounts `markdownFileRoom` on the kit's `./do` adapter. The
 * "somewhere else" is `FileStore`, a second Durable Object reached over
 * fetch, standing in for the app's file service: every load and save is a
 * real async round trip out of the doc's object.
 *
 * `user` and `role` query parameters stand in for the Worker's own sign-in
 * and room-access check. `POST /docs/<doc>/agent?session=<id>` stands in
 * for the app's tool dispatch running an `edit_document` call.
 */
import type { DurableObjectNamespace, DurableObjectState } from '@cloudflare/workers-types';
import { agentPrincipal, editDocAction } from '../../src/agent/index.ts';
import type { CollabRole } from '../../src/collab/index.ts';
import {
  type DurableRoom,
  alarmSchedule,
  createDurableRoom,
  sqlKeyValue,
} from '../../src/do/index.ts';
import { type MarkdownFileRoom, markdownFileRoom } from '../../src/markdown-file/index.ts';

interface Env {
  DOC: DurableObjectNamespace;
  FILES: DurableObjectNamespace;
}

declare const WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket } };

type HibernatingWebSocket = WebSocket & {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
};

interface DocState {
  id: { name?: string };
  acceptWebSocket(ws: HibernatingWebSocket): void;
  getWebSockets(): HibernatingWebSocket[];
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  storage: {
    sql: Parameters<typeof sqlKeyValue>[0];
    setAlarm(time: number): Promise<void>;
  };
}

const DOC_PATH = /^\/docs\/([A-Za-z0-9_-]+)\/(ws|refresh|text|instance|agent)$/;
const FILE_PATH = /^\/files\/([A-Za-z0-9_-]+)$/;
const ROLES = new Set(['owner', 'edit', 'comment', 'view']);
/** Long enough that a test can evict the object inside it; an app uses
 *  about 2s. */
const DEBOUNCE_MS = 1000;

/** The stand-in file service: one text per name. */
export class FileStore {
  private readonly sql: DocState['storage']['sql'];

  constructor(ctx: DurableObjectState) {
    this.sql = (ctx as unknown as DocState).storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS files (name TEXT PRIMARY KEY, text TEXT NOT NULL)');
  }

  async fetch(req: Request): Promise<Response> {
    const name = FILE_PATH.exec(new URL(req.url).pathname)?.[1];
    if (!name) return new Response('not found', { status: 404 });
    if (req.method === 'PUT') {
      this.sql.exec(
        'INSERT INTO files (name, text) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET text = excluded.text',
        name,
        await req.text(),
      );
      return new Response('ok');
    }
    const row = this.sql.exec('SELECT text FROM files WHERE name = ?', name).toArray()[0];
    return new Response(typeof row?.text === 'string' ? row.text : '');
  }
}

export class DocFile {
  private file!: MarkdownFileRoom;
  private room!: DurableRoom<HibernatingWebSocket>;
  private readonly instance = crypto.randomUUID();

  constructor(ctx: DurableObjectState, env: Env) {
    const state = ctx as unknown as DocState;
    const name = state.id.name ?? '';
    const files = env.FILES.get(env.FILES.idFromName('files'));
    const url = `https://files.invalid/files/${name}`;
    void state.blockConcurrencyWhile(async () => {
      this.file = await markdownFileRoom({
        load: async () => (await files.fetch(url)).text(),
        save: async (text) => {
          const res = await files.fetch(url, { method: 'PUT', body: text });
          if (!res.ok) throw new Error(`file store answered ${res.status}`);
        },
        state: sqlKeyValue(state.storage.sql, 'file'),
        schedule: alarmSchedule(state.storage),
        debounceMs: DEBOUNCE_MS,
      });
      this.room = createDurableRoom({
        ctx: state,
        docs: this.file.docs,
        actions: { editDoc: editDocAction() },
      });
    });
  }

  async alarm(): Promise<void> {
    await this.file.flush();
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const match = DOC_PATH.exec(url.pathname);
    if (!match?.[1]) return new Response('not found', { status: 404 });
    const [, docId, verb] = match;
    if (verb === 'instance') return new Response(this.instance);
    if (verb === 'text') return new Response(this.file.text());
    if (verb === 'refresh') {
      await this.file.refresh();
      return new Response(this.file.text());
    }
    if (verb === 'agent') {
      const agent = agentPrincipal(url.searchParams.get('session') ?? '');
      this.room.grant(agent, 'edit');
      const res = this.room.action(docId, agent, 'editDoc', await req.json());
      return Response.json(res.ok ? res.value : res);
    }
    const user = url.searchParams.get('user') ?? '';
    const role = url.searchParams.get('role') ?? '';
    if (!user || !ROLES.has(role)) return new Response('sign in first', { status: 401 });
    const pair = new WebSocketPair();
    const accepted = this.room.accept(pair[1] as HibernatingWebSocket, {
      roomId: docId,
      principal: { id: user, name: user },
      role: role as CollabRole,
    });
    if (!accepted.ok) return new Response(accepted.error, { status: 403 });
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
    const path = new URL(req.url).pathname;
    if (FILE_PATH.test(path)) {
      return env.FILES.get(env.FILES.idFromName('files')).fetch(req as never) as never;
    }
    const doc = DOC_PATH.exec(path)?.[1];
    if (!doc) return new Response('not found', { status: 404 });
    return env.DOC.get(env.DOC.idFromName(doc)).fetch(req as never) as never;
  },
};
