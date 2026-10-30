/**
 * The bound-file sync for one board: a `doc-mirror.ts` per bound file, the
 * board token that admits them, and what they need to remember across a
 * restart.
 *
 * State lives in `<stateDir>/<workspaceId>.json` (mode 600, folder 700): each
 * doc's `MirrorMark`, and the board token as last renewed. A token expires 7
 * days after it was minted or renewed (`auth/board-agent-token.ts`), so the
 * sync renews it through `POST /api/board-tokens/refresh` at start and every
 * 12 hours, and keeps the new value here: the Keychain value it started from
 * is what a person put there, and the sync never writes the Keychain. A
 * saved value is used only while the Keychain still holds the value it was
 * renewed from (a SHA-256 of it is saved beside it), so a person who puts a
 * new token in the Keychain gets that one.
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readSmallFile, replaceFile } from '@claude-workspaces/core/safe-file';
import { configuredHostFetch } from '../outbound-fetch.ts';
import { type MirrorMark, type MirrorSocket, createDocMirror } from './doc-mirror.ts';
import type { SyncConfig } from './sync-config.ts';

interface State {
  token?: { value: string; from: string };
  marks: Record<string, MirrorMark>;
}

/** The most of a state file read back: marks for a board's docs. */
const STATE_MAX = 4 * 1024 * 1024;

const RENEW_EVERY_MS = 12 * 60 * 60 * 1000;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

function readState(path: string): State {
  try {
    const s = JSON.parse(readSmallFile(path, STATE_MAX) ?? '') as State;
    return { marks: s.marks ?? {}, ...(s.token ? { token: s.token } : {}) };
  } catch {
    return { marks: {} };
  }
}

export interface BoardSyncOptions {
  config: SyncConfig;
  stateDir: string;
  log: (line: string) => void;
  /** Opens a socket with these headers; Bun's WebSocket by default. */
  socket?: (url: string, headers: Record<string, string>) => MirrorSocket;
  writeDelayMs?: number;
  pollMs?: number;
}

function bunSocket(url: string, headers: Record<string, string>): MirrorSocket {
  // Bun's client takes headers; the DOM typing for WebSocket does not know that.
  return new WebSocket(url, { headers } as unknown as string[]) as unknown as MirrorSocket;
}

export function startBoardSync(opts: BoardSyncOptions) {
  const { config } = opts;
  mkdirSync(opts.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(opts.stateDir, 0o700);
  const statePath = join(opts.stateDir, `${config.workspaceId}.json`);
  const state = readState(statePath);
  const from = sha(config.boardToken);
  let token =
    state.token && state.token.from === from && state.token.value
      ? state.token.value
      : config.boardToken;
  // Through a random temp name, never through a link: the state folder
  // has lived where a walled lead can write (`safe-file.ts`).
  const save = () => replaceFile(statePath, JSON.stringify(state), 0o600);
  const headers = (): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    ...(config.access
      ? {
          'cf-access-client-id': config.access.clientId,
          'cf-access-client-secret': config.access.clientSecret,
        }
      : {}),
  });

  // The board's origin is the operator's own config, so it is the one host allowed.
  const toBoard = configuredHostFetch([config.baseUrl]);

  async function renew(): Promise<void> {
    try {
      const res = await toBoard(`${config.baseUrl}/api/board-tokens/refresh`, {
        method: 'POST',
        headers: headers(),
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
      const body = res.ok ? ((await res.json()) as { token?: unknown }) : {};
      if (typeof body.token !== 'string' || !body.token.startsWith('at2.')) {
        opts.log(`could not renew the board token (${res.status})`);
        return;
      }
      token = body.token;
      state.token = { value: token, from };
      save();
    } catch (err) {
      opts.log(`could not renew the board token: ${(err as Error).message}`);
    }
  }

  const wsBase = config.baseUrl.replace(/^http/, 'ws');
  const open = opts.socket ?? bunSocket;
  const mirrors = config.docs.map((d) =>
    createDocMirror({
      docId: d.docId,
      path: d.path,
      connect: () =>
        open(
          `${wsBase}/workspaces/${encodeURIComponent(config.workspaceId)}/docs/${encodeURIComponent(d.docId)}/y`,
          headers(),
        ),
      ...(state.marks[d.docId] ? { mark: state.marks[d.docId] } : {}),
      onMark: (m) => {
        state.marks[d.docId] = m;
        save();
      },
      backupDir: join(opts.stateDir, 'replaced'),
      log: opts.log,
      ...(opts.writeDelayMs !== undefined ? { writeDelayMs: opts.writeDelayMs } : {}),
      ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
    }),
  );
  const renewal = setInterval(() => void renew(), RENEW_EVERY_MS);
  const ready = renew().then(() => {
    for (const m of mirrors) m.start();
  });
  return {
    ready,
    synced: () => mirrors.every((m) => m.synced()),
    stop(): void {
      clearInterval(renewal);
      for (const m of mirrors) m.stop();
    },
  };
}
