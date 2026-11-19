#!/usr/bin/env bun
/**
 * The components package's map in a bound `.mdx`, on the real doc page in
 * headless Chromium against a real server and the real doc bundle. The doc's
 * repository holds the unpacked tarball, the same `lib/map.js` a static site
 * installs, in a folder declared by `component.json`; the doc's tag imports
 * it. Then a second client on the doc's socket writes the map's state, as
 * another open page or an agent would, and the open page is timed until it
 * redraws.
 *
 * No request leaves the machine: the build fetches nothing from esm.sh (the
 * package carries Leaflet), and every tile request is answered locally by
 * `components/test/map-page-harness.ts`.
 *
 * Spawned by `components-map-doc-browser.test.ts`, which reads the JSON it
 * prints.
 *
 * audit: no-text — every value returned comes from the running page.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateHook } from '@claude-workspaces/core/mdx-component-state';
import { resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
import { packComponents } from '../../components/scripts/pack.ts';
import {
  type MapPage,
  type MapReading,
  mapPage,
  until,
} from '../../components/test/map-page-harness.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import { openSocket } from './doc-socket-client.ts';

export interface ComponentsMapDocReading {
  /** The map as the tag's props draw it. */
  first: MapReading;
  /** The map after another client wrote its state, and how long that write
   *  took to reach the open page. */
  afterWrite: MapReading;
  writeToPageMs: number;
  /** Requests to an origin that is neither the server nor the tile server. */
  stray: string[];
  tileRequests: number;
}

const step = (what: string): void => {
  process.stderr.write(`[components-map-doc-driver] ${what}\n`);
};

const DOC = `# Harborlight sites

import CwMap from './components/claude-workspaces-components/lib/map.js'

<CwMap id="sites" title="Harborlight sites" rings={[150]} height={360} markers={[{ lat: 37.761, lng: -122.441, label: "Harborlight hall", category: "Library" }, { lat: 37.772, lng: -122.432, label: "Riverbend school", category: "School" }]} />

Saltmarsh notes below.
`;

const WRITTEN = {
  title: 'Harborlight sites, Saltmarsh added',
  markers: [
    { lat: 37.761, lng: -122.441, label: 'Harborlight hall', category: 'Library' },
    { lat: 37.772, lng: -122.432, label: 'Riverbend school', category: 'School' },
    { lat: 37.755, lng: -122.45, label: 'Saltmarsh pier', category: 'Library' },
  ],
};

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'components-map-doc-'));
  let handle: ServerHandle | undefined;
  let page: MapPage | undefined;
  let writer: ReturnType<typeof openSocket> | undefined;
  try {
    step('build the doc bundle and pack the components tarball');
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`doc bundle build failed:\n${built.stderr}`);
    const tarball = await packComponents(join(dir, 'packed'));

    const repo = join(dir, 'harborlight');
    const unpacked = join(repo, 'components', 'claude-workspaces-components');
    mkdirSync(unpacked, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'components', 'component.json'), '{}');
    const untar = spawnSync('tar', ['-xzf', tarball, '-C', unpacked, '--strip-components', '1']);
    if (untar.status !== 0) throw new Error(`could not unpack ${tarball}`);
    writeFileSync(join(repo, 'sites.mdx'), DOC);

    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
      componentFetch: async () => new Response('not here', { status: 404 }),
    });
    const base = `http://127.0.0.1:${handle.port}`;
    const post = async (path: string, payload: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const author = { id: 'agent-harborlight', name: 'Harborlight notes', kind: 'agent' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author })) as { workspace: { id: string } }
    ).workspace.id;
    const docId = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'sites',
          type: 'markdown',
          sourceUrl: join(repo, 'sites.mdx'),
        })
      ).docId,
    );

    page = await mapPage(resolveChromeBin(undefined), base, 'components-map-doc');
    await page.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}`,
    });
    step('open the doc');
    await page.open(`${base}/workspaces/${ws}/docs/${docId}`, 1180, 820);
    const read = async () => (await page?.read('#editor')) ?? null;
    const first = await until('the map drew from its props', read, 60_000);

    step("write the map's state from a second client and time the open page");
    writer = openSocket(`ws://127.0.0.1:${handle.port}/workspaces/${ws}/docs/${docId}/y`);
    await writer.ready;
    const hook = createStateHook(writer.ydoc, 'sites', { canWrite: true });
    const wroteAt = performance.now();
    for (const w of [hook.set('markers', WRITTEN.markers), hook.set('title', WRITTEN.title)]) {
      if (!w.ok) throw new Error(`state write refused: ${w.error}`);
    }
    const afterWrite = await until('the written state on the open page', async () => {
      const r = await read();
      return r && r.markers === WRITTEN.markers.length && r.title === WRITTEN.title ? r : null;
    });
    const writeToPageMs = Math.round(performance.now() - wroteAt);
    hook.dispose();
    const reading: ComponentsMapDocReading = {
      first,
      afterWrite,
      writeToPageMs,
      stray: page.stray,
      tileRequests: page.tileRequests(),
    };
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    writer?.close();
    await page?.close();
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 170s');
  process.exit(3);
}, 170_000).unref();
await main();
process.exit(0);
