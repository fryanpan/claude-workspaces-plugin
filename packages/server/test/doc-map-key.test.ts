/**
 * The Google Maps key reaches a doc page only through
 * `GET …/docs/<id>/map-key/google`, and only for a doc whose live content
 * draws a `<StreetMap basemap="google">`: not for a doc whose maps use
 * another basemap, not for a doc with no map, not once the tag stops naming
 * Google, and not from a server that holds no key. The key is a fake one, and
 * no request leaves the machine. Each refusal sits beside a served control.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const FAKE_KEY = 'fake-maps-key-harborlight-0000';

const GOOGLE_DOC = `# Harborlight reports

<StreetMap title="Halls" basemap="google" markers={[{ lat: 37.77, lng: -122.42, label: "Harborlight" }]} />
`;
const OSM_DOC = `# Riverbend reports

<StreetMap basemap="osm" markers={[{ lat: 37.78, lng: -122.41, label: "Riverbend" }]} />

<StreetMap title="basemap=google" markers={[{ lat: 37.78, lng: -122.41 }]} />
`;
const PLAIN_DOC = '# Saltmarsh\n\nNo map here, though the word basemap="google" is.\n';

interface Board {
  handle: ServerHandle;
  base: string;
  ws: string;
}

/** Console output captured while the suite runs, to prove the key is never
 *  written to it. */
const printed: string[] = [];
const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
const originals = methods.map((m) => console[m]);

describe('GET …/docs/<id>/map-key/<basemap>', () => {
  let root: string;
  let repo: string;
  let keyed: Board;
  let keyless: Board;

  const open = async (googleMapsKey: string | undefined, dir: string): Promise<Board> => {
    const handle = createServer({
      port: 0,
      dataDir: join(root, dir),
      ...(googleMapsKey ? { googleMapsKey } : {}),
    });
    const base = `http://127.0.0.1:${handle.port}`;
    const ws = await seedBoard(base, { name: 'Harborlight' });
    for (const docId of ['gmap', 'osm', 'plain']) {
      const r = await fetch(`${base}/workspaces/${ws}/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          docId,
          type: 'markdown',
          sourceUrl: join(repo, dir, `${docId}.${docId === 'plain' ? 'md' : 'mdx'}`),
        }),
      });
      expect(r.ok, await r.text()).toBe(true);
    }
    return { handle, base, ws };
  };
  const key = (b: Board, doc: string, basemap = 'google', init?: RequestInit) =>
    fetch(`${b.base}/workspaces/${b.ws}/docs/${doc}/map-key/${basemap}`, init);

  beforeAll(async () => {
    methods.forEach((m) => {
      console[m] = (...args: unknown[]) => {
        printed.push(args.map(String).join(' '));
      };
    });
    root = mkdtempSync(join(tmpdir(), 'doc-map-key-'));
    repo = join(root, 'repo');
    mkdirSync(repo);
    spawnSync('git', ['init', '-q'], { cwd: repo });
    // One folder of docs per server, so neither server's write-back touches
    // the other's files.
    for (const dir of ['keyed', 'keyless']) {
      mkdirSync(join(repo, dir));
      writeFileSync(join(repo, dir, 'gmap.mdx'), GOOGLE_DOC);
      writeFileSync(join(repo, dir, 'osm.mdx'), OSM_DOC);
      writeFileSync(join(repo, dir, 'plain.md'), PLAIN_DOC);
    }
    keyed = await open(FAKE_KEY, 'keyed');
    keyless = await open(undefined, 'keyless');
  });

  afterAll(async () => {
    await keyed?.handle.stop();
    await keyless?.handle.stop();
    methods.forEach((m, i) => {
      console[m] = originals[i] as (typeof console)[typeof m];
    });
    rmSync(root, { recursive: true, force: true });
  });

  it('hands the key to a doc that draws a Google map, uncached and same-origin only', async () => {
    const r = await key(keyed, 'gmap');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ key: FAKE_KEY });
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  });

  it('refuses a doc whose maps use another basemap, or that has no map', async () => {
    for (const doc of ['osm', 'plain']) {
      const r = await key(keyed, doc);
      expect(r.status).toBe(404);
      const text = await r.text();
      expect(text).not.toContain(FAKE_KEY);
      expect(JSON.parse(text).reason).toBe('not-named');
    }
  });

  it('refuses a basemap that needs no key, an unknown one, and a write', async () => {
    for (const basemap of ['osm', 'bing', '']) {
      const r = await key(keyed, 'gmap', basemap);
      expect(r.status).toBe(404);
      expect(await r.text()).not.toContain(FAKE_KEY);
    }
    const post = await key(keyed, 'gmap', 'google', { method: 'POST' });
    expect(post.status).toBe(405);
    expect(await post.text()).not.toContain(FAKE_KEY);
  });

  it('stops handing the key out once the doc stops naming Google', async () => {
    expect((await key(keyed, 'gmap')).status).toBe(200);
    const edit = await fetch(`${keyed.base}/workspaces/${keyed.ws}/docs/gmap/content`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: OSM_DOC }),
    });
    expect(edit.ok, await edit.text()).toBe(true);
    await waitFor(async () => (await key(keyed, 'gmap')).status === 404, {
      describe: 'the key to be refused',
    });
    const after = await key(keyed, 'gmap');
    expect((await after.json()).reason).toBe('not-named');
  });

  it('answers no-key from a server that holds none, so the page can fall back', async () => {
    const r = await key(keyless, 'gmap');
    expect(r.status).toBe(404);
    expect((await r.json()).reason).toBe('no-key');
  });

  it('never puts the key in the doc page itself or in the server’s output', async () => {
    const page = await fetch(`${keyed.base}/workspaces/${keyed.ws}/docs/gmap`);
    expect(await page.text()).not.toContain(FAKE_KEY);
    // Positive control: the capture is live.
    console.warn('capture check');
    expect(printed).toContain('capture check');
    expect(printed.join('\n')).not.toContain(FAKE_KEY);
  });
});
