/**
 * A page's half of the presence socket (`src/presence.ts` is the server's):
 * says "I am on this doc" when it opens, and keeps the list of everyone else
 * on it and the reader's own role, as the server last sent them. Reconnects
 * when the socket drops. No DOM: the tests run it in Bun.
 */

export interface PresencePerson {
  id: string;
  name: string;
}

export interface PresenceHandle {
  /** Everyone else on this doc, by name. */
  here(): PresencePerson[];
  onChange(fn: (here: PresencePerson[]) => void): void;
  /** The reader's role on this doc, as the server last said, or null. */
  role(): string | null;
  /** Called each time the server says the role, changed or not. Null when
   *  the server refused the socket (1008): the reader has no role left. */
  onRole(fn: (role: string | null) => void): void;
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
  const roleListeners: Array<(role: string | null) => void> = [];
  let role: string | null = null;
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
        const msg = JSON.parse(ev.data) as { here?: unknown; role?: unknown };
        if (Array.isArray(msg.here)) set(msg.here.filter(isPerson));
        if (typeof msg.role === 'string') {
          role = msg.role;
          for (const fn of roleListeners) fn(msg.role);
        }
      } catch {
        // Not ours: ignore it.
      }
    });
    socket.addEventListener('close', (ev) => {
      if (ws === socket) ws = null;
      if (closed) return;
      // The server closes a reader whose role is gone with 1008, and refuses
      // their reconnect the same way.
      if (ev.code === 1008 && role !== null) {
        role = null;
        for (const fn of roleListeners) fn(null);
      }
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
    role: () => role,
    onRole: (fn) => {
      roleListeners.push(fn);
    },
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      ws?.close();
    },
  };
}
