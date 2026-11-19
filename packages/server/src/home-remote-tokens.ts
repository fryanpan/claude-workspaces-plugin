/**
 * The board tokens Home on the Mac pulls each remote feed with, kept alive.
 *
 * Once a project server runs `CW_SIGNIN=better-auth`, no Access application
 * fronts it and a service token proves nothing there. The Mac then pulls each
 * remote board's feed with that board's own agent token (`at2`,
 * `auth/board-agent-token.ts`), named in the home-remotes config's
 * `boardTokens`. `routes/home-feed.ts` admits one for its own board only.
 *
 * Each token expires in seven days. Before a read, a token with less than
 * half its life left is renewed by presenting it to
 * `POST /api/board-tokens/refresh` on the server that holds the board. A
 * revoked token renews nothing, so revocation still ends it.
 *
 * Renewed values go to a state file in the data directory (mode 600),
 * because the config file is what a person edits and the server never
 * writes it. The rule is the org relay's (`org-relay/relay-bearers.ts`):
 * each saved value records a hash of the config value it was renewed from,
 * and wins at start only while the config still holds that same value.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { BOARD_AGENT_TOKEN_TTL_MS } from './auth/board-agent-token.ts';
import { refreshDue } from './org-relay/relay-bearers.ts';

export const HOME_REMOTE_TOKENS_FILE = 'home-remote-tokens.json';

/** A board token's shape; the server decides whether it stands. */
export const BOARD_TOKEN = /^at2\.[A-Za-z0-9._-]{1,512}$/;

/** Ask the board's server for a fresh value; null when it refuses. */
export type RenewToken = (boardId: string, token: string) => Promise<string | null>;

export interface HomeRemoteTokens {
  /** The board's current token, or undefined when it has none. */
  get(boardId: string): string | undefined;
  /** Renew the board's token first when it is due. Never throws. */
  fresh(boardId: string, renew: RenewToken): Promise<string | undefined>;
}

interface Saved {
  value: string;
  from: string;
}

const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');

function readSaved(path: string | undefined): Record<string, Saved> {
  if (!path) return {};
  try {
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, Saved>)
      : {};
  } catch {
    return {};
  }
}

export function createHomeRemoteTokens(opts: {
  /** Board id → the token the config names. */
  tokens: Map<string, string>;
  /** Where renewed values are kept; none means they live in memory only. */
  stateFile?: string;
  now?: () => number;
}): HomeRemoteTokens {
  const now = opts.now ?? Date.now;
  const current = new Map(opts.tokens);
  const saved = readSaved(opts.stateFile);
  for (const [boardId, configured] of opts.tokens) {
    const entry = saved[boardId];
    if (
      entry &&
      typeof entry.value === 'string' &&
      BOARD_TOKEN.test(entry.value) &&
      entry.from === hashOf(configured)
    ) {
      current.set(boardId, entry.value);
    }
  }
  const renewing = new Map<string, Promise<void>>();

  const save = (): void => {
    const path = opts.stateFile;
    if (!path) return;
    const out: Record<string, Saved> = {};
    for (const [boardId, value] of current) {
      out[boardId] = { value, from: hashOf(opts.tokens.get(boardId) ?? value) };
    }
    try {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    } catch {
      console.error('[home-remotes] could not save a renewed board token.');
    }
  };

  const renewOne = async (boardId: string, token: string, renew: RenewToken): Promise<void> => {
    let next: string | null = null;
    try {
      next = await renew(boardId, token);
    } catch {
      next = null;
    }
    if (next === null || !BOARD_TOKEN.test(next) || current.get(boardId) !== token) return;
    current.set(boardId, next);
    save();
  };

  return {
    get: (boardId) => current.get(boardId),
    async fresh(boardId, renew) {
      const token = current.get(boardId);
      if (token === undefined || !refreshDue(token, BOARD_AGENT_TOKEN_TTL_MS, now())) return token;
      // One renewal at a time per board: the stream and a read may both ask.
      let inflight = renewing.get(boardId);
      if (!inflight) {
        inflight = renewOne(boardId, token, renew).finally(() => renewing.delete(boardId));
        renewing.set(boardId, inflight);
      }
      await inflight;
      return current.get(boardId);
    },
  };
}
