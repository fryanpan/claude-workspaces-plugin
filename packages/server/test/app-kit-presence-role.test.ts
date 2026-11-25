/**
 * The app kit's presence client (`templates/app-kit/src/client/presence.ts`)
 * reports the reader's role as the server says it, and reports it gone when
 * the server closes the socket with 1008, as the kit's presence does for a
 * reader whose role was removed. The page's half of following a role is
 * driven in a browser in `scripts/app-kit-role-browser.test.ts`.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { connectPresence } from '../../../templates/app-kit/src/client/presence.ts';
import { waitFor } from './wait-for.ts';

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  server?.stop(true);
  server = null;
});

describe('the app kit presence client', () => {
  it('reports the role it is sent, then null once the server refuses the socket', async () => {
    let opened = 0;
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        open(ws) {
          opened++;
          if (opened === 1) {
            ws.send(JSON.stringify({ here: [], role: 'edit' }));
            setTimeout(() => ws.close(1008, 'revoked'), 20);
          } else ws.close(1008, 'revoked');
        },
        message() {},
      },
    });
    const seen: Array<string | null> = [];
    const presence = connectPresence(`ws://127.0.0.1:${server.port}/presence`, { retryMs: 10 });
    presence.onRole((r) => seen.push(r));
    try {
      await waitFor(() => seen.includes(null), { what: 'the role to be reported gone' });
      expect(seen).toEqual(['edit', null]);
      expect(presence.role()).toBeNull();
      // A refused reconnect does not report it again.
      await waitFor(() => opened >= 2, { what: 'a reconnect' });
      expect(seen).toEqual(['edit', null]);
    } finally {
      presence.close();
    }
  });
});
