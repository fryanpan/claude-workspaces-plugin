/**
 * A live dashboard, the way a Worker app builds one on the kit: one
 * `DashboardRoom` Durable Object per room, whose doc holds a root map of
 * tiles. Pages join with the `view` role and only read; the server writes.
 *
 * `POST /rooms/<room>/readings` stands in for the app's database write. It
 * records the row and moves the object's alarm out by `PUSH_DEBOUNCE_MS`,
 * so a burst of writes becomes one push. `alarm()` stands in for the app's
 * analysis module: it recomputes from every row and writes the result as
 * one tile through `setTile`, as the server. The alarm wakes an evicted
 * object, so a push is not lost to hibernation.
 *
 * `POST /rooms/<room>/agent?session=<id>` stands in for an agent tool that
 * writes a tile of its own. `user` and `role` query parameters stand in for
 * the app's sign-in and room-access check.
 */
import type { DurableObjectNamespace, DurableObjectState } from '@cloudflare/workers-types';
import { agentPrincipal, setTileAction } from '../../src/agent/index.ts';
import type { CollabRole } from '../../src/collab/index.ts';
import {
  type DurableRoom,
  SERVER_PRINCIPAL,
  alarmSchedule,
  createDurableRoom,
  sqlCollabStorage,
} from '../../src/do/index.ts';

interface Env {
  DASH: DurableObjectNamespace;
}

declare const WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket } };

type HibernatingWebSocket = WebSocket & {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
};

interface DashState {
  id: { name?: string };
  acceptWebSocket(ws: HibernatingWebSocket): void;
  getWebSockets(): HibernatingWebSocket[];
  storage: {
    sql: Parameters<typeof sqlCollabStorage>[0];
    setAlarm(time: number): Promise<void>;
  };
}

const PATH = /^\/rooms\/([A-Za-z0-9_-]+)\/(ws|readings|agent|instance)$/;
const ROLES = new Set(['owner', 'edit', 'comment', 'view']);
/** An app uses about 2s; shorter here so the suite does not wait on it. */
const PUSH_DEBOUNCE_MS = 300;

export class DashboardRoom {
  private readonly state: DashState;
  private readonly room: DurableRoom<HibernatingWebSocket>;
  private readonly roomId: string;
  private readonly schedule: (ms: number) => void;
  private readonly instance = crypto.randomUUID();

  constructor(ctx: DurableObjectState) {
    this.state = ctx as unknown as DashState;
    this.roomId = this.state.id.name ?? '';
    const sql = this.state.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS readings (value REAL NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS pushes (n INTEGER NOT NULL)');
    this.room = createDurableRoom({
      ctx: this.state,
      storage: sqlCollabStorage(sql),
      actions: { setTile: setTileAction() },
    });
    this.schedule = alarmSchedule(this.state.storage);
  }

  /** The analysis: every row, recomputed, written as one tile. */
  async alarm(): Promise<void> {
    const sql = this.state.storage.sql;
    const rows = sql.exec('SELECT value FROM readings').toArray();
    const values = rows.map((r) => Number(r.value));
    sql.exec('INSERT INTO pushes (n) VALUES (1)');
    const pushes = Number(sql.exec('SELECT COUNT(*) AS n FROM pushes').toArray()[0]?.n);
    const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    this.room.action(this.roomId, SERVER_PRINCIPAL, 'setTile', {
      tile: 'readings',
      // `by` names the instance that pushed, so a test can tell a push from
      // a woken instance apart from one an evicted instance's timer made.
      value: { count: values.length, mean, pushes, by: this.instance },
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const match = PATH.exec(url.pathname);
    if (!match?.[1]) return new Response('not found', { status: 404 });
    const [, roomId, verb] = match;
    if (verb === 'instance') return new Response(this.instance);
    if (verb === 'readings') {
      const { value } = (await req.json()) as { value: number };
      this.state.storage.sql.exec('INSERT INTO readings (value) VALUES (?)', value);
      this.schedule(PUSH_DEBOUNCE_MS);
      return new Response('ok');
    }
    if (verb === 'agent') {
      const agent = agentPrincipal(url.searchParams.get('session') ?? '');
      this.room.grant(agent, 'edit');
      const res = this.room.action(roomId, agent, 'setTile', await req.json());
      return Response.json(res.ok ? res.value : res);
    }
    const user = url.searchParams.get('user') ?? '';
    const role = url.searchParams.get('role') ?? '';
    if (!user || !ROLES.has(role)) return new Response('sign in first', { status: 401 });
    const pair = new WebSocketPair();
    const accepted = this.room.accept(pair[1] as HibernatingWebSocket, {
      roomId,
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
    const room = PATH.exec(new URL(req.url).pathname)?.[1];
    if (!room) return new Response('not found', { status: 404 });
    return env.DASH.get(env.DASH.idFromName(room)).fetch(req as never) as never;
  },
};
