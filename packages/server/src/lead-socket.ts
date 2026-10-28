/**
 * The lead socket: a unix socket a sandboxed lead reaches its board through.
 *
 * The lead's Seatbelt profile denies every board-server TCP port
 * (`scripts/lead-sandbox-wall.ts`), so this socket is its only way in, and it
 * admits nothing but a board agent token (`at2`). The listener marks each
 * request it accepts; `request-admission.ts` asks that mark, never the Host
 * header, and judges a marked request by the board agent door alone
 * (`middleware/board-agent-door.ts`). There is no fallback to trusted-local.
 *
 * A request here has no peer address (Bun's `requestIP` answers null for a
 * unix socket), so every loopback-only check further down the chain refuses
 * it as well.
 *
 * Websocket upgrades are refused: the upgrade routes call the TCP server's
 * `upgrade`, which cannot take a connection this listener accepted.
 */
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';

export interface LeadSocket {
  /** Whether this request arrived on the lead socket. */
  isLeadSocketRequest: (req: Request) => boolean;
  /** Close the listener and every connection on it. */
  stop: () => void;
}

export interface LeadSocketOptions {
  /** Where to listen. A unix socket path is limited to 104 bytes on macOS. */
  path: string;
  /** The server's front door, the same one the TCP listener calls. */
  handle: (req: Request) => Promise<Response | undefined>;
  j: (status: number, body: unknown) => Response;
}

export function openLeadSocket(opts: LeadSocketOptions): LeadSocket {
  const { path, handle, j } = opts;
  removeStaleSocket(path);
  const marked = new WeakSet<Request>();
  const server = Bun.serve({
    unix: path,
    async fetch(req) {
      if (req.headers.get('upgrade')) return j(403, { error: 'lead_socket_no_upgrade' });
      marked.add(req);
      return (await handle(req)) ?? j(500, { error: 'lead_socket_no_response' });
    },
  });
  // Only this user may connect. A sandboxed lead runs as the same user; the
  // token, not the file mode, is what tells one lead from another.
  chmodSync(path, 0o600);
  return {
    isLeadSocketRequest: (req) => marked.has(req),
    stop: () => {
      server.stop(true);
      removeStaleSocket(path);
    },
  };
}

/**
 * A socket file left by a process that died is removed, so the bind does not
 * fail. Anything else at the path is left alone and the bind fails on it.
 */
function removeStaleSocket(path: string): void {
  try {
    if (lstatSync(path).isSocket()) unlinkSync(path);
  } catch {
    // Nothing there.
  }
}
