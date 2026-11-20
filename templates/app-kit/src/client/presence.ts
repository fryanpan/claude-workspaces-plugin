/**
 * A page's half of the presence socket (`src/presence.ts` is the server's):
 * says "I am on this doc" when it opens, and keeps the list of everyone else
 * on it, as the server last sent it. Reconnects when the socket drops. No
 * DOM: the tests run it in Bun.
 */

export interface PresencePerson {
  id: string;
  name: string;
}

export interface PresenceHandle {
  /** Everyone else on this doc, by name. */
  here(): PresencePerson[];
  onChange(fn: (here: PresencePerson[]) => void): void;
  close(): void;
}

export interface PresenceOptions {
  /** Extra handshake headers. Bun honours them; a browser sends its cookies. */
  headers?: Record<string, string>;
  retryMs?: number;
  maxRetryMs?: number;
}

const isPerson = (v: unknown): v is PresencePerson =>
  typeof (v as PresencePerson | null)?.id === 'string' &&
  typeof (v as PresencePerson | null)?.name === 'string';

export function connectPresence(url: string, opts: PresenceOptions = {}): PresenceHandle {
  let here: PresencePerson[] = [];
  const listeners: Array<(here: PresencePerson[]) => void> = [];
  let ws: WebSocket | null = null;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retry = opts.retryMs ?? 500;

  const set = (next: PresencePerson[]): void => {
    here = next;
    for (const fn of listeners) fn(here);
  };

  const open = (): void => {
    timer = null;
    if (closed) return;
    const socket = opts.headers
      ? new WebSocket(url, { headers: opts.headers } as unknown as string[])
      : new WebSocket(url);
    ws = socket;
    socket.addEventListener('open', () => {
      retry = opts.retryMs ?? 500;
      socket.send(JSON.stringify({ spot: {} }));
    });
    socket.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      try {
        const msg = JSON.parse(ev.data) as { here?: unknown };
        if (Array.isArray(msg.here)) set(msg.here.filter(isPerson));
      } catch {
        // Not ours: ignore it.
      }
    });
    socket.addEventListener('close', () => {
      if (ws === socket) ws = null;
      if (closed) return;
      set([]);
      timer = setTimeout(open, retry);
      retry = Math.min(retry * 2, opts.maxRetryMs ?? 10_000);
    });
  };
  open();

  return {
    here: () => here,
    onChange: (fn) => {
      listeners.push(fn);
    },
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      ws?.close();
    },
  };
}
