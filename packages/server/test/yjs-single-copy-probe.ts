/**
 * Run by `yjs-single-copy.test.ts` in a fresh `bun` process, so the module
 * registry it reports holds the server's graph and nothing a neighbouring test
 * file loaded. It loads what `bin.ts` loads, boots a server, drives a doc
 * through the routes that touch Yjs, and prints one line:
 *
 *   YJS_PROBE {"modules":[...],"warnings":N,"binImports":N}
 *
 * `modules` is every Yjs build in the registry. Bun lists ESM and CommonJS
 * modules alike in `require.cache`, so an ESM import and a `require('yjs')`
 * show up as two entries — the second way a single installed copy becomes two
 * loaded ones. `warnings` counts Yjs's own "already imported" message.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src');

// Installed before anything imports Yjs: it speaks while its module evaluates.
let warnings = 0;
const consoleError = console.error;
console.error = (...args: unknown[]) => {
  if (args.some((a) => String(a).includes('Yjs was already imported'))) warnings++;
  consoleError(...args);
};

// Everything `bin.ts` imports, found rather than listed so a new import there
// is covered here. `bin.ts` itself runs the process on import, so not it. Plus
// the one dynamic import in the graph (`sentry.ts` loads the SDK on demand).
const binImports = new Bun.Transpiler({ loader: 'ts' })
  .scanImports(readFileSync(join(src, 'bin.ts'), 'utf8').replace(/^#!.*\n/, ''))
  .map((i) => i.path)
  .filter((p) => p.startsWith('./'));
for (const p of binImports) await import(join(src, p));
await import('@sentry/bun');

const { createServer } = await import(join(src, 'server.ts'));
const dataDir = mkdtempSync(join(tmpdir(), 'yjs-single-copy-'));
const handle = createServer({ port: 0, dataDir });
const base = `http://127.0.0.1:${handle.port}`;
const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as Record<string, unknown>;
};

try {
  const author = { id: 'agent:yjs-probe', name: 'Yjs Probe', kind: 'agent' };
  const board = (await post('/workspaces', { name: 'Riverbend', author })) as {
    workspace: { id: string };
  };
  const ws = board.workspace.id;
  const file = join(dataDir, 'riverbend.md');
  writeFileSync(file, '# Riverbend\n\nThe ferry schedule moves to the spring timetable.\n');
  const doc = (await post(`/workspaces/${ws}/docs`, {
    docId: 'riverbend',
    type: 'markdown',
    sourceUrl: file,
  })) as { docId: string };
  await post(`/workspaces/${ws}/docs/${doc.docId}/threads/by_find`, {
    author,
    text: 'Which week does it start?',
    find: 'spring timetable',
  });
  const modules = Object.keys(require.cache).filter((k) => /\/yjs\/dist\/yjs\.[cm]?js$/.test(k));
  console.log(`YJS_PROBE ${JSON.stringify({ modules, warnings, binImports: binImports.length })}`);
} finally {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
}
