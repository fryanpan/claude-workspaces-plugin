#!/usr/bin/env bun
/**
 * Moves one board from the Mac's server onto its project machine over
 * HTTPS, with no keeper and no `fly ssh`:
 *
 *   bun run machine:push-board --board <id> --project <name> [--dry-run]
 *       [--target-url https://<project host>] [--source-data-dir <dir>]
 *       [--source-url http://127.0.0.1:8787] [--token "agent <project>"]
 *
 * It is `machine:move-board`'s sequence (`moveBoard`): fingerprint the board
 * on the Mac, refuse if the machine holds it, export it, fingerprint again,
 * import, fingerprint the machine, and only when everything matches archive
 * the Mac's board (`PUT /workspaces/<id>/retired`, reversible). Only the
 * transport differs. The bundle goes to the machine's
 * `PUT /api/board-import/<id>` (`routes/board-import.ts`), the machine stages
 * it and restarts, its boot imports it before the server serves
 * (`board-import-cli.ts`), and this polls the same route until the import
 * is recorded.
 *
 * It sends the project's existing Access service token, read from the
 * Keychain under the services `cf:sync-config` stored it in
 * (`infra/cloudflare/service-tokens.ts`, `tokenServices`). It mints nothing.
 * The target is the project's own hostname, which the board router sends to
 * the project's machine whatever the board table says.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRouterConfig } from '../board-router-worker/router-config.ts';
import { projectHost } from '../board-router-worker/worker.js';
import { tokenServices } from '../cloudflare/service-tokens.ts';
import { type BoardManifest, MoveRefused } from './board-bundle.ts';
import { type ImportStatus, writePushBody } from './board-import-store.ts';
import type { BoardPrint } from './board-print.ts';
import { type MoveTarget, moveBoard } from './move-board.ts';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface PushTargetOptions {
  /** The project machine's origin, `https://<project host>`. */
  base: string;
  /** The Access service token pair, as headers. */
  headers: Record<string, string>;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the machine to restart and import. */
  importTimeoutMs?: number;
  pollMs?: number;
}

/** The project machine, over its own hostname. */
export function pushTarget(opts: PushTargetOptions): MoveTarget {
  const call = opts.fetch ?? ((url, init) => fetch(url, init));
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const url = (board: string, tail = '') =>
    `${opts.base.replace(/\/+$/, '')}/api/board-import/${encodeURIComponent(board)}${tail}`;
  const answer = async <T>(res: Response, what: string): Promise<T> => {
    const text = await res.text();
    if (!res.ok) throw new Error(`${what} answered ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  };
  const status = async (board: string) =>
    answer<ImportStatus>(await call(url(board), { headers: opts.headers }), 'the import status');
  return {
    describe: new URL(opts.base).host,
    async holds(board) {
      return (await status(board)).holds;
    },
    async importBundle(bundleDir, board) {
      const manifest = JSON.parse(
        readFileSync(join(bundleDir, 'manifest.json'), 'utf8'),
      ) as BoardManifest;
      const work = mkdtempSync(join(tmpdir(), 'cw-push-'));
      try {
        const body = join(work, 'push.bin');
        writePushBody(bundleDir, manifest, body);
        const res = await call(url(board), {
          method: 'PUT',
          headers: { ...opts.headers, 'content-type': 'application/octet-stream' },
          body: Bun.file(body),
        });
        const staged = await answer<ImportStatus>(res, 'the push');
        console.log(
          `[push-board] staged (${staged.files ?? 0} file(s)); the machine restarts to import`,
        );
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
      const pollMs = opts.pollMs ?? 5000;
      const polls = Math.ceil((opts.importTimeoutMs ?? 15 * 60_000) / pollMs);
      for (let i = 0; i < polls; i++) {
        await sleep(pollMs);
        let s: ImportStatus;
        try {
          s = await status(board);
        } catch {
          continue; // The machine is restarting.
        }
        if (s.state === 'imported' && s.holds) return;
        if (s.state === 'refused')
          throw new MoveRefused(`the machine refused the import: ${s.reason}`);
      }
      throw new Error('the machine did not record the import in time; it may still be restarting');
    },
    async print(board, limits) {
      const res = await call(url(board, '/print'), {
        method: 'POST',
        headers: { ...opts.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ limits }),
      });
      return answer<BoardPrint>(res, "the machine's fingerprint");
    },
  };
}

/** The project's own hostname, from the router's config. */
export function projectOrigin(routerConfigText: string, project: string): string {
  const router = parseRouterConfig(routerConfigText);
  if (!router.projects[project]) throw new Error(`router.local.json has no project ${project}`);
  return `https://${projectHost(project, router.oneAddress)}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = (n: string) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const boardId = at('board');
  const project = at('project');
  if (!boardId || !project || !/^[a-z][a-z0-9-]{1,30}$/.test(project)) {
    console.error('[push-board] --board <id> --project <name> are required');
    process.exit(2);
  }
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const base =
    at('target-url') ??
    projectOrigin(
      readFileSync(join(repo, 'infra', 'board-router-worker', 'router.local.json'), 'utf8'),
      project,
    );
  const { readKeychainPassword } = await import('../../packages/server/src/share/keychain.ts');
  const services = tokenServices(at('token') ?? `agent ${project}`);
  const target = pushTarget({
    base,
    headers: {
      'cf-access-client-id': readKeychainPassword(services.clientId),
      'cf-access-client-secret': readKeychainPassword(services.secret),
    },
  });
  const r = await moveBoard({
    boardId,
    source: {
      dataDir:
        at('source-data-dir') ??
        join(homedir(), 'Library', 'Application Support', 'claude-workspaces', 'data'),
      base: at('source-url') ?? 'http://127.0.0.1:8787',
    },
    target,
    dryRun: args.includes('--dry-run'),
    log: (l) => console.log(`[push-board] ${l}`),
  });
  if (!r.ok) process.exit(1);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`[push-board] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
