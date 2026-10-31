/**
 * The files beside a bound doc, served for a `::html{src="…"}` frame: the
 * page and its siblings come from the doc's own folder, and nothing outside
 * that folder, no dotfile, no unlisted type and no doc without a file is
 * reachable through it. Every refusal sits beside a served control from the
 * same folder, so a refusal is the rule and not a broken fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRef } from '../src/doc-file-frame.ts';
import { MOCK_FRAME_CSP } from '../src/mockup-frame.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { tinyPng } from './tiny-png.ts';
import { seedBoard } from './workspace-seed.ts';

const PAGE = [
  '<!doctype html><html><head>',
  '<link rel="stylesheet" href="style.css">',
  '<script src="app.js" defer></script>',
  '<script src="../outside.js"></script>',
  '</head><body><h1>Harborlight</h1></body></html>',
].join('\n');
const APP_JS = 'window.harborlight = "loaded";';
const STYLE = 'h1 { color: rgb(1, 2, 3); }';
const DATA = '{"ferry":"Riverbend"}';

describe('GET …/docs/<id>/files/<path>', () => {
  let handle: ServerHandle;
  let root: string;
  let docDir: string;
  let base: string;
  let ws: string;
  let otherWs: string;

  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(r.ok, await r.clone().text()).toBe(true);
    return r;
  };
  const get = (path: string, init: RequestInit = {}, doc = 'harborlight', board = ws) =>
    fetch(`${base}/workspaces/${board}/docs/${doc}/files/${path}`, init);

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'doc-files-'));
    docDir = join(root, 'harborlight');
    mkdirSync(join(docDir, 'data'), { recursive: true });
    mkdirSync(join(docDir, '.git'), { recursive: true });
    writeFileSync(join(docDir, 'doc.md'), '# Harborlight\n\n::html{src="map.html"}\n');
    writeFileSync(join(docDir, 'map.html'), PAGE);
    writeFileSync(join(docDir, 'app.js'), APP_JS);
    writeFileSync(join(docDir, 'style.css'), STYLE);
    writeFileSync(join(docDir, 'data', 'ferry.json'), DATA);
    writeFileSync(join(docDir, 'pin.png'), tinyPng(30));
    writeFileSync(join(docDir, 'notes.txt'), 'not served');
    writeFileSync(join(docDir, '.env'), 'SECRET=1');
    writeFileSync(join(docDir, '.git', 'config'), '[core]');
    writeFileSync(join(root, 'outside.js'), 'window.leaked = true;');
    writeFileSync(join(root, 'secret.json'), '{"secret":true}');
    symlinkSync(join(root, 'secret.json'), join(docDir, 'leak.json'));
    symlinkSync(join(docDir, '.env'), join(docDir, 'env.json'));
    symlinkSync(join(docDir, 'notes.txt'), join(docDir, 'renamed.json'));
    handle = createServer({ port: 0, dataDir: join(root, 'data') });
    base = `http://127.0.0.1:${handle.port}`;
    ws = await seedBoard(base, { name: 'Harborlight' });
    otherWs = await seedBoard(base, { name: 'Riverbend' });
    await post(`/workspaces/${ws}/docs`, {
      docId: 'harborlight',
      type: 'markdown',
      sourceUrl: join(docDir, 'doc.md'),
    });
    await post(`/workspaces/${ws}/docs`, { docId: 'saltmarsh', type: 'dev' });
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('serves the page sandboxed, with its relative script and stylesheet written in', async () => {
    const res = await get('map.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(MOCK_FRAME_CSP);
    expect(MOCK_FRAME_CSP).not.toContain('allow-same-origin');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const page = await res.text();
    const b64 = Buffer.from(APP_JS).toString('base64');
    expect(page).toContain(`<script src="data:text/javascript;base64,${b64}" defer></script>`);
    expect(page).toContain(`<style>${STYLE}</style>`);
    // A reference that climbs out of the folder is left as written.
    expect(page).toContain('<script src="../outside.js"></script>');
    expect(page).not.toContain(Buffer.from('window.leaked = true;').toString('base64'));
    // The relay is the first script in the head, after the doctype.
    expect(page.startsWith('<!doctype html><html><head><script>(function(){var B=')).toBe(true);
    expect(page).toContain(`var B="/workspaces/${ws}/docs/harborlight/files/"`);
  });

  it('serves each sibling with its own type, nosniff and the bare sandbox', async () => {
    for (const [path, type] of [
      ['app.js', 'text/javascript; charset=utf-8'],
      ['style.css', 'text/css; charset=utf-8'],
      ['data/ferry.json', 'application/json; charset=utf-8'],
      ['pin.png', 'image/png'],
    ] as const) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toBe(type);
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(res.headers.get('content-security-policy'), path).toBe('sandbox');
    }
    expect(await (await get('data/ferry.json')).text()).toBe(DATA);
  });

  it('refuses every spelling of a climb out of the folder, and a NUL', async () => {
    for (const p of [
      '..%2Fsecret.json',
      '%2E%2E%2Fsecret.json',
      '%2e%2e/secret.json',
      'data%2F..%2F..%2Fsecret.json',
      'map.html%00.json',
      `${encodeURIComponent(join(root, 'secret.json'))}`,
    ]) {
      const res = await get(p);
      expect([400, 404], p).toContain(res.status);
      expect(await res.text(), p).not.toContain('"secret":true');
    }
  });

  it('refuses a symlink whose real path leaves the folder', async () => {
    expect((await get('data/ferry.json')).status).toBe(200);
    const res = await get('leak.json');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('"secret":true');
  });

  it('refuses a dotfile, a dot folder, and a link that lands on a dotfile', async () => {
    for (const p of ['.env', '.git/config', 'env.json']) {
      const res = await get(p);
      expect([404, 415], p).toContain(res.status);
      expect(await res.text(), p).not.toContain('SECRET=1');
    }
  });

  it('refuses a type not on the list, by name or by where its link lands', async () => {
    expect((await get('notes.txt')).status).toBe(415);
    expect((await get('renamed.json')).status).toBe(415);
  });

  it('refuses a doc with no bound file, and a doc on another board', async () => {
    const unbound = await get('map.html', {}, 'saltmarsh');
    expect(unbound.status).toBe(404);
    expect(await unbound.text()).toContain('not bound to a file');
    const elsewhere = await get('map.html', {}, 'harborlight', otherWs);
    expect(elsewhere.status).toBe(404);
    expect(await elsewhere.text()).not.toContain('Harborlight</h1>');
  });

  it('answers reads only', async () => {
    expect((await get('map.html', { method: 'POST' })).status).toBe(405);
    expect((await get('map.html', { method: 'HEAD' })).status).toBe(200);
  });

  it('gives a new page validator when a sibling changes, so a reload shows the edit', async () => {
    const first = await get('map.html');
    const etag = first.headers.get('etag') ?? '';
    expect(etag).not.toBe('');
    expect((await get('map.html', { headers: { 'if-none-match': etag } })).status).toBe(304);
    writeFileSync(join(docDir, 'app.js'), 'window.harborlight = "edited";');
    const second = await get('map.html', { headers: { 'if-none-match': etag } });
    expect(second.status).toBe(200);
    expect(await second.text()).toContain(
      Buffer.from('window.harborlight = "edited";').toString('base64'),
    );
  });
});

describe('resolveRef', () => {
  it('resolves against the page folder and refuses a climb, a scheme or an absolute path', () => {
    expect(resolveRef(['map'], 'app.js')).toEqual(['map', 'app.js']);
    expect(resolveRef(['map'], '../data/a.json?v=1')).toEqual(['data', 'a.json']);
    expect(resolveRef(['map'], './a%20b.css')).toEqual(['map', 'a b.css']);
    for (const ref of ['../../x.js', '/x.js', '//cdn.example/x.js', 'https://x/y.js', 'a\\b.js']) {
      expect(resolveRef(['map'], ref), ref).toBeNull();
    }
  });
});
