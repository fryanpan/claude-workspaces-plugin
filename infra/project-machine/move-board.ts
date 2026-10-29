#!/usr/bin/env bun
/**
 * Moves one board from the Mac's server onto a project machine, with the
 * same ids, so `/workspaces/<id>/…` links keep working behind the router.
 *
 *   bun run machine:move-board --board <id> --project <name> [--dry-run]
 *       [--source-data-dir <dir>] [--source-url http://127.0.0.1:8787]
 *       [--sync-config <path>] [--target-url https://<project>-workspaces.<zone>]
 *
 * In order: fingerprint the board on the source, refuse if the target holds
 * it, export it (`board-bundle.ts`), fingerprint the source again and refuse
 * if anything changed while it was read, import it on the target with the
 * target's server stopped, fingerprint the target, and only when every part
 * matches archive the source board (`PUT /workspaces/<id>/retired`, a soft
 * delete). Nothing on the source is ever removed. `--dry-run` stops after
 * the export and says what would move.
 *
 * The Mac paths its docs were bound to come back as `bindings`; with
 * `--sync-config` they are written into a config for `board-sync.ts`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOARD_ID, type BoardManifest, MoveRefused, exportBoard } from './board-bundle.ts';
import {
  type BoardLimits,
  type BoardPrint,
  boardLimits,
  boardPrint,
  judgeMove,
  loopbackGet,
} from './board-print.ts';

/** The server a board moves onto. Two of these: a project machine, and a test's loopback server. */
export interface MoveTarget {
  describe: string;
  holds(boardId: string): Promise<boolean>;
  /** Stops the target's server, imports the bundle, starts it again. */
  importBundle(bundleDir: string, boardId: string): Promise<void>;
  print(boardId: string, limits: BoardLimits): Promise<BoardPrint>;
}

export interface MoveSource {
  dataDir: string;
  /** The source server, on loopback. */
  base: string;
}

export interface MoveResult {
  ok: boolean;
  archived: boolean;
  manifest: BoardManifest;
  lines: string[];
}

const summary = (p: BoardPrint): string =>
  `docs ${p.docs.count}, threads ${p.threads.count}, tasks ${p.tasks.count}, events ${p.events.lines} line(s), notes ${p.notes.lines} line(s)`;

/** Asks the source server, on loopback, to archive the board. Reversible. */
async function archiveSource(source: MoveSource, boardId: string, to: string): Promise<void> {
  const host = `localhost:${new URL(source.base).port || '80'}`;
  const res = await fetch(`${source.base}/workspaces/${encodeURIComponent(boardId)}/retired`, {
    method: 'PUT',
    headers: { host, 'content-type': 'application/json' },
    body: JSON.stringify({ retired: true, reason: `moved to ${to}`, author: 'move-board' }),
  });
  if (!res.ok)
    throw new Error(`archiving the source board answered ${res.status}: ${await res.text()}`);
}

export async function moveBoard(opts: {
  boardId: string;
  source: MoveSource;
  target: MoveTarget;
  dryRun?: boolean;
  log?: (line: string) => void;
}): Promise<MoveResult> {
  const { boardId, source, target } = opts;
  const log = opts.log ?? ((l: string) => console.log(`[move-board] ${l}`));
  // Checked before any use: the id reaches a shell on the machine.
  if (!BOARD_ID.test(boardId)) throw new MoveRefused(`not a board id: ${boardId}`);
  const get = loopbackGet(source.base);
  const before = await boardPrint(get, source.dataDir, boardId);
  log(`source: ${summary(before)}`);
  if (await target.holds(boardId)) {
    throw new MoveRefused(`${target.describe} already holds board ${boardId}; nothing was changed`);
  }
  const work = mkdtempSync(join(tmpdir(), `cw-move-${boardId}-`));
  try {
    const bundleDir = join(work, 'bundle');
    const manifest = exportBoard(source.dataDir, boardId, bundleDir);
    const bytes = manifest.files.reduce((n, f) => n + f.bytes, 0);
    log(
      `export: ${manifest.files.length} file(s), ${bytes} bytes, ${manifest.docIds.length} doc id(s), shared entries in ${Object.keys(manifest.merges).join(', ') || 'none'}, ${manifest.bindings.length} bound file(s)`,
    );
    const again = await boardPrint(get, source.dataDir, boardId);
    const still = judgeMove(before, again);
    if (!still.ok) {
      for (const l of still.lines) log(`source changed during export: ${l}`);
      throw new MoveRefused(
        'the board changed while it was exported; quiet its agents and run again',
      );
    }
    if (opts.dryRun) {
      log('dry run: nothing imported, nothing archived');
      return { ok: true, archived: false, manifest, lines: [] };
    }
    await target.importBundle(bundleDir, boardId);
    const after = await target.print(boardId, boardLimits(before));
    log(`target: ${summary(after)}`);
    const { ok, lines } = judgeMove(before, after);
    for (const l of lines) log(l);
    if (!ok) {
      log('FAIL: the source board is left as it was, not archived');
      return { ok, archived: false, manifest, lines };
    }
    await archiveSource(source, boardId, target.describe);
    log(`PASS: ${boardId} is on ${target.describe}; the source board is archived`);
    return { ok, archived: true, manifest, lines };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** What `board-sync.ts` reads: the board, where it now lives, and each bound file. */
export function syncConfig(manifest: BoardManifest, baseUrl: string, project: string) {
  return {
    baseUrl,
    workspaceId: manifest.boardId,
    // Off until a person turns it on, per board.
    enabled: false,
    auth: {
      boardTokenService: `cw-${project}-board-sync-token`,
      accessClientId: '<client id>.access',
      accessSecretService: `cw-${project}-access-secret`,
    },
    docs: manifest.bindings,
  };
}

/** The project machine, over `fly ssh`. */
async function flyTarget(project: string): Promise<MoveTarget> {
  const { projectConfig } = await import('./deploy-plan.ts');
  const { machines } = await import('./deploy.ts');
  const { flyOk, keeperStage, onMachine } = await import('./mac-ops.ts');
  const cfg = projectConfig({ project, imageLabel: '0'.repeat(40) });
  const PROBE = 'bun /app/infra/project-machine/board-probe.ts';
  const lastJson = <T>(out: string): T => {
    const line = out
      .trim()
      .split('\n')
      .reverse()
      .find((l) => l.trim().startsWith('{'));
    if (!line) throw new Error(`no JSON in: ${out.slice(-300)}`);
    return JSON.parse(line) as T;
  };
  const machine = () => {
    const m = machines(cfg.app).find((x) => x.state !== 'destroyed');
    if (!m) throw new Error(`${cfg.app} has no machine; run machine:deploy first`);
    return m;
  };
  const started = async (id: string) => {
    for (let i = 0; i < 60; i++) {
      if (machines(cfg.app).find((x) => x.id === id)?.state === 'started') return;
      await Bun.sleep(2000);
    }
    throw new Error(`machine ${id} did not start`);
  };
  const serving = async () => {
    for (let i = 0; i < 60; i++) {
      const code = onMachine(
        cfg.app,
        "curl -s -o /dev/null -w '%{http_code}' -H 'host: localhost:8787' http://127.0.0.1:8787/api/deploy || true",
      ).trim();
      if (/\d{3}$/.test(code) && !code.endsWith('000')) return;
      await Bun.sleep(2000);
    }
    throw new Error('the board server never answered on loopback');
  };
  return {
    describe: cfg.app,
    async holds(boardId) {
      return lastJson<{ holds: boolean }>(onMachine(cfg.app, `${PROBE} holds ${boardId}`)).holds;
    },
    async importBundle(bundleDir, boardId) {
      const m = machine();
      const stage = keeperStage(`${cfg.app}-move-`);
      try {
        const tgz = join(stage.dir, 'bundle.tgz');
        const tar = spawnSync(
          'tar',
          ['--no-mac-metadata', '--no-xattrs', '-czf', tgz, '-C', bundleDir, '.'],
          { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } },
        );
        if (tar.status !== 0) throw new Error('tar failed');
        stage.share(tgz);
        const up = `/data/board-import-${boardId}`;
        flyOk(['ssh', 'sftp', 'put', tgz, `${up}.tgz`, '--app', cfg.app]);
        console.log(`[move-board] ${cfg.app}: holding services off`);
        onMachine(cfg.app, 'touch /data/maintenance');
        flyOk(['machine', 'restart', m.id, '--app', cfg.app]);
        await started(m.id);
        console.log(
          onMachine(
            cfg.app,
            `mkdir ${up} && tar -xzf ${up}.tgz -C ${up} && ${PROBE} import ${up} && chown -R cw:cw /data/cw && rm -r ${up} ${up}.tgz`,
          )
            .trim()
            .split('\n')
            .at(-1),
        );
        onMachine(cfg.app, 'rm /data/maintenance');
        flyOk(['machine', 'restart', m.id, '--app', cfg.app]);
        await started(m.id);
        await serving();
      } finally {
        stage.done();
      }
    },
    async print(boardId, limits) {
      const l = Buffer.from(JSON.stringify(limits)).toString('base64');
      return lastJson<BoardPrint>(onMachine(cfg.app, `${PROBE} fingerprint ${boardId} ${l}`));
    },
  };
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
    console.error('[move-board] --board <id> --project <name> are required');
    process.exit(2);
  }
  const source: MoveSource = {
    dataDir:
      at('source-data-dir') ??
      join(homedir(), 'Library', 'Application Support', 'claude-workspaces', 'data'),
    base: at('source-url') ?? 'http://127.0.0.1:8787',
  };
  const target = await flyTarget(project);
  const r = await moveBoard({ boardId, source, target, dryRun: args.includes('--dry-run') });
  const out = at('sync-config');
  if (out) {
    const cfg = syncConfig(
      r.manifest,
      at('target-url') ?? `https://${project}-workspaces.<zone>`,
      project,
    );
    writeFileSync(out, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    console.log(`[move-board] sync config for ${r.manifest.bindings.length} bound file(s): ${out}`);
  }
  if (!r.ok) process.exit(1);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`[move-board] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
