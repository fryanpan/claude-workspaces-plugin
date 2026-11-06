/**
 * Telling the board server that a keeper request waits for Bryan's passkey,
 * so the request shows on his Home instead of only in the caller's terminal.
 *
 * On 4 Nov a check waited 13 minutes on two held requests whose approval
 * links had gone only to a script's stderr. A keeper client now hands each
 * held answer to an announcer as well as to `onHeld`. The announcer posts the
 * request's id and poll token to `POST /api/keeper/holds` on the board
 * server on this machine. The server does not believe the post: it asks the
 * keeper itself whether that request is waiting before it files a card
 * (`keeper-home-card.ts`).
 *
 * The board server is found the way the MCP client finds it:
 * `CW_BOARD_URL`, else the discovery file's port on loopback. Only a
 * loopback address is accepted, because the post carries the poll token,
 * which can withdraw the request. `CW_BOARD_URL=off` turns it off; the test
 * preload sets that, so no test can reach a real server.
 */
import { homedir } from 'node:os';
import { readDiscovery } from '@claude-workspaces/core/discovery-file';
import { configuredHostFetch } from '../outbound-fetch.ts';
import type { HeldAnswer } from './keeper-client.ts';

export const BOARD_URL_ENV = 'CW_BOARD_URL';
export const HOLDS_PATH = '/api/keeper/holds';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The board server to tell, or null when there is none to tell. */
export function boardUrlFromEnv(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string | null {
  const set = env[BOARD_URL_ENV]?.trim();
  if (set === 'off') return null;
  if (set) {
    try {
      const url = new URL(set);
      return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) ? url.origin : null;
    } catch {
      return null;
    }
  }
  const found = readDiscovery(home);
  return found ? `http://127.0.0.1:${found.port}` : null;
}

/**
 * An announcer for `KeeperClientOptions.announce`. It never throws and never
 * delays the wait: a board server that is down costs a log line, and the
 * caller still prints the link.
 */
export function announceToBoard(
  boardUrl: string | null,
  requester: string,
  opts: { fetchImpl?: typeof fetch; say?: (line: string) => void } = {},
): (held: HeldAnswer) => void {
  const say = opts.say ?? ((line: string) => console.error(line));
  if (!boardUrl) return () => {};
  const doFetch = opts.fetchImpl ?? configuredHostFetch([boardUrl]);
  return (held) => {
    void doFetch(`${boardUrl}${HOLDS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: held.id, pollToken: held.pollToken, requester }),
    })
      .then(async (res) => {
        if (res.ok) return;
        const why = await res.text().catch(() => '');
        say(`[keeper] Home was not told of request ${held.id}: ${res.status} ${why.slice(0, 200)}`);
      })
      .catch((err: unknown) => {
        say(`[keeper] Home was not told of request ${held.id}: ${String(err)}`);
      });
  };
}
