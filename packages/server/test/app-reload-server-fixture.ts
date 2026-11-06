/**
 * A stand-in for a framework's dev server with a websocket reload channel,
 * for the attached-app socket tests. It keeps the rules Vite's own server
 * keeps (`vite/dist/node`, read at 8.3.6): the channel is at the app's base,
 * `vite-ping` opens and closes at once with no token, `vite-hmr` needs the
 * page's token whenever a request carries an `Origin`, and anything else
 * gets no upgrade. On connecting it says `{"type":"connected"}`, as Vite does,
 * so a proxy that loses a dev server's first frame fails here.
 *
 * It can be stopped and started on the same port, which is the restart a
 * reader's client has to survive. Fixtures are fictional.
 */
import type { Server, ServerWebSocket } from 'bun';

export const RELOAD_TOKEN = 'harborlight-token';

export interface Handshake {
  path: string;
  search: string;
  protocol: string;
  headers: Record<string, string>;
}

export interface ReloadServerFixture {
  origin: string;
  port: number;
  /** Where the channel is. The board names a prefix only once attached. */
  setBase(base: string): void;
  /** Say this to every open channel. */
  broadcast(frame: string | Uint8Array): void;
  /** Close every open channel with this code and reason. */
  closeAll(code: number, reason: string): void;
  /** Every handshake the server took, in order. */
  handshakes(): Handshake[];
  /** Every frame a reader sent it, in order. */
  received(): Array<string | number[]>;
  /** How each channel ended, in order: `<code> <reason>`. */
  closes(): string[];
  /** How many reload channels are open now. Pings do not count. */
  open(): number;
  stop(): Promise<void>;
  start(): void;
}

interface ChannelData {
  protocol: string;
}

export function startReloadServer(): ReloadServerFixture {
  let base = '/';
  const channels = new Set<ServerWebSocket<ChannelData>>();
  const handshakes: Handshake[] = [];
  const received: Array<string | number[]> = [];
  const closes: string[] = [];
  let port = 0;
  let server: Server<ChannelData> | null = null;

  const listen = (): void => {
    server = Bun.serve<ChannelData>({
      port,
      hostname: '127.0.0.1',
      fetch(req, srv) {
        const url = new URL(req.url);
        const protocol = req.headers.get('sec-websocket-protocol') ?? '';
        if (req.headers.get('upgrade') === null) return new Response('<h1>Harborlight</h1>');
        if (url.pathname !== base || !['vite-hmr', 'vite-ping'].includes(protocol)) {
          return new Response('no channel here', { status: 400 });
        }
        const proven = url.searchParams.get('token') === RELOAD_TOKEN;
        if (protocol === 'vite-hmr' && req.headers.has('origin') && !proven) {
          return new Response('bad token', { status: 400 });
        }
        handshakes.push({
          path: url.pathname,
          search: url.search,
          protocol,
          headers: Object.fromEntries(req.headers),
        });
        const upgraded = srv.upgrade(req, {
          data: { protocol },
          headers: { 'Sec-WebSocket-Protocol': protocol },
        });
        return upgraded ? undefined : new Response('upgrade failed', { status: 500 });
      },
      websocket: {
        open(ws) {
          if (ws.data.protocol === 'vite-ping') {
            ws.close(1000);
            return;
          }
          channels.add(ws);
          ws.send('{"type":"connected"}');
        },
        message(_ws, message) {
          received.push(typeof message === 'string' ? message : [...message]);
        },
        close(ws, code, reason) {
          if (!channels.delete(ws)) return;
          closes.push(`${code} ${reason}`);
        },
      },
    });
    port = server.port ?? 0;
  };
  listen();

  return {
    get origin() {
      return `http://127.0.0.1:${port}`;
    },
    get port() {
      return port;
    },
    setBase(next) {
      base = next;
    },
    broadcast(frame) {
      for (const ws of channels) ws.send(frame);
    },
    closeAll(code, reason) {
      for (const ws of channels) ws.close(code, reason);
    },
    handshakes: () => handshakes,
    received: () => received,
    closes: () => closes,
    open: () => channels.size,
    async stop() {
      // Not awaited: the listener goes now, and a restarted server's promise
      // has been seen never to settle once its sockets are gone.
      void server?.stop(true);
      server = null;
    },
    start: listen,
  };
}
