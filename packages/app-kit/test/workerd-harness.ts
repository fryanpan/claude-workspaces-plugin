/**
 * Runs a fixture Worker in a local workerd through Miniflare: bundled with
 * esbuild, Durable Objects on SQLite, kept in memory, listening on a free
 * loopback port. Nothing calls Cloudflare.
 */
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

export interface LocalWorker {
  /** `http://127.0.0.1:<port>` */
  http: string;
  /** `ws://127.0.0.1:<port>` */
  ws: string;
  mf: Miniflare;
  dispose: () => Promise<void>;
}

const FIXTURES = join(import.meta.dirname, 'fixtures');

/** Bundle `fixtures/<entry>` and run it. `classes` maps each binding to the
 *  Durable Object class the fixture exports. */
export async function startWorker(
  entry: string,
  classes: Record<string, string>,
): Promise<LocalWorker> {
  const out = await build({
    entryPoints: [join(FIXTURES, entry)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    write: false,
    mainFields: ['module', 'main'],
    conditions: ['workerd', 'worker', 'import'],
    logLevel: 'silent',
  });
  const script = out.outputFiles[0]?.text;
  if (!script) throw new Error(`esbuild wrote nothing for ${entry}`);
  const durableObjects: Record<string, { className: string; useSQLite: true }> = {};
  for (const [binding, className] of Object.entries(classes)) {
    durableObjects[binding] = { className, useSQLite: true };
  }
  // The v4 option shape, which this Miniflare still takes through its own
  // converter: one Worker, its script given inline.
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: 'collab-fixture',
      modules: true,
      script,
      compatibilityDate: '2026-11-01',
      durableObjects,
      // Never the default 8787: that is the board's own port on this machine.
      host: '127.0.0.1',
      port: 0,
    }),
  );
  const url = await mf.ready;
  const http = url.origin;
  return {
    http,
    ws: http.replace(/^http/, 'ws'),
    mf,
    dispose: () => mf.dispose(),
  };
}

/** Evict a Durable Object the way the runtime hibernates it: its sockets
 *  stay open, its instance and memory go. */
export function hibernate(worker: LocalWorker, className: string, name: string): Promise<void> {
  return worker.mf.unsafeEvictDurableObject('collab-fixture', className, {
    name,
    webSockets: 'hibernate',
  });
}
