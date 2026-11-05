/**
 * A doc bound under a walled lead's root serves and stores its images
 * through `tree-fs.ts` (`routes/doc-assets.ts`):
 *
 * - 1: an image that is a link, even to a file inside the root, is not
 *   served; a plain one is (the control);
 * - 2: a hard link to an outside file is not served;
 * - 3: the doc's folder swapped for a link to an outside folder while the
 *   upload makes `images/` creates nothing outside;
 * - 4: `images` planted as a link to a folder inside the root stores
 *   nothing there.
 *
 * macOS only, as the contained calls are. Temp dirs, port 0, synthetic.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { setTreeSeamForTest, treeFsMode } from '../src/tree-fs.ts';
import { tinyPng } from './tiny-png.ts';

const CONTAINED = treeFsMode() === 'contained';
const json = { 'content-type': 'application/json' };

let h: ServerHandle;
let dataDir: string;
let workDir: string;
let base: string;
let ws: string;
let root: string;
let outside: string;

const tcp = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { ...json, ...(init.headers ?? {}) } });

let n = 0;
/** A doc bound to `<root>/<folder>/doc.md`, and its id. */
async function docIn(folder: string): Promise<string> {
  n += 1;
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'doc.md'), '# Harborlight\n');
  const res = await tcp(`/workspaces/${ws}/docs`, {
    method: 'POST',
    body: JSON.stringify({ docId: `harbor-${n}`, sourceUrl: join(dir, 'doc.md') }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { docId: string }).docId;
}

const asset = (docId: string, rel: string) =>
  tcp(`/workspaces/${ws}/docs/${encodeURIComponent(docId)}/assets/${rel}`);
const upload = (docId: string) =>
  fetch(`${base}/workspaces/${ws}/docs/${encodeURIComponent(docId)}/assets?name=chart.png`, {
    method: 'POST',
    body: tinyPng(30),
  });

describe.skipIf(!CONTAINED)('images beside a doc under a lead’s root', () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'lead-assets-'));
    workDir = realpathSync(mkdtempSync(join(tmpdir(), 'lead-assets-work-')));
    h = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${h.port}`;
    const made = await tcp('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'Harborlight' }),
    });
    ws = ((await made.json()) as { workspace: { id: string } }).workspace.id;
    root = join(workDir, 'harbor-project');
    outside = join(workDir, 'riverbend-keys');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.png'), tinyPng(77));
    const res = await tcp(`/api/board-sockets/${ws}/roots`, {
      method: 'PUT',
      body: JSON.stringify({ roots: [root] }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
  });
  afterEach(() => setTreeSeamForTest(null));
  afterAll(async () => {
    await h.stop();
    for (const d of [dataDir, workDir]) rmSync(d, { recursive: true, force: true });
  });

  it('1: serves a plain image, and not one that is a link inside the root', async () => {
    const docId = await docIn('one');
    mkdirSync(join(root, 'one', 'img'));
    mkdirSync(join(root, 'other'));
    writeFileSync(join(root, 'one', 'img', 'plain.png'), tinyPng(40));
    writeFileSync(join(root, 'other', 'a.png'), tinyPng(50));
    symlinkSync(join(root, 'other', 'a.png'), join(root, 'one', 'img', 'a.png'));
    const ok = await asset(docId, 'img/plain.png');
    expect(ok.status).toBe(200);
    expect((await ok.arrayBuffer()).byteLength).toBe(tinyPng(40).byteLength);
    const linked = await asset(docId, 'img/a.png');
    expect(linked.status).toBe(404);
    expect(await linked.text()).not.toContain('PNG');
  });

  it('2: does not serve a hard link to an outside file', async () => {
    const docId = await docIn('two');
    linkSync(join(outside, 'secret.png'), join(root, 'two', 'hard.png'));
    expect((await asset(docId, 'hard.png')).status).toBe(404);
  });

  it('3: creates nothing outside when the doc’s folder becomes a link mid-upload', async () => {
    const docId = await docIn('three');
    const target = join(outside, 'swap-target');
    mkdirSync(target);
    let swapped = false;
    setTreeSeamForTest(() => {
      if (swapped) return;
      swapped = true;
      renameSync(join(root, 'three'), join(root, 'three-moved'));
      symlinkSync(target, join(root, 'three'));
    });
    const res = await upload(docId);
    expect(swapped).toBe(true);
    expect(res.status).toBe(409);
    expect(readdirSync(target)).toEqual([]);
  });

  it('4: stores nothing through an images link inside the root, and stores a plain upload', async () => {
    const control = await docIn('four-plain');
    const stored = await upload(control);
    expect(stored.status, await stored.clone().text()).toBe(201);
    const { src } = (await stored.json()) as { src: string };
    expect(existsSync(join(root, 'four-plain', src))).toBe(true);

    const docId = await docIn('four');
    mkdirSync(join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), join(root, 'four', 'images'));
    const res = await upload(docId);
    expect(res.status).toBe(409);
    expect(readdirSync(join(root, 'elsewhere'))).toEqual([]);
  });
});
