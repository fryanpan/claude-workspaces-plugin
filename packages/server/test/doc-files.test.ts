/**
 * The files of a page a bound doc frames: served only from the folder of a
 * page a `::html{src}` line in the doc names, and nothing outside that folder,
 * no dotfile, no `node_modules`, no gitignored file, no unlisted type and no
 * doc without a file or a line is reachable through it. Every refusal sits
 * beside a served control from the same folder, so a refusal is the rule and
 * not a broken fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { DOC_PAGE_CSP, frameHtml, landsInside, resolveRef } from '../src/doc-file-frame.ts';
import { LISTING_AGES, listingScanCount } from '../src/doc-file-listing.ts';
import { PAGE_RECHECK, pageBuildCount } from '../src/doc-file-page-cache.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { tinyPng } from './tiny-png.ts';
import { waitFor } from './wait-for.ts';
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
const AS_FRAME = { headers: { 'sec-fetch-dest': 'iframe' } };

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
  const write = (rel: string, text: string | Uint8Array) => {
    const abs = join(docDir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'doc-files-'));
    docDir = join(root, 'harborlight');
    mkdirSync(docDir);
    spawnSync('git', ['init', '-q'], { cwd: docDir });
    write('doc.md', '# Harborlight\n\n::html{src="map/index.html"}\n');
    write('plain.md', '# Riverbend\n\nNo page here.\n');
    write('.gitignore', 'map/ignored.json\n');
    write('map/index.html', PAGE);
    write('map/app.js', APP_JS);
    write('map/style.css', STYLE);
    write('map/data/ferry.json', DATA);
    write('map/pin.png', tinyPng(30));
    write('map/notes.txt', 'not served');
    write('map/.env', 'SECRET=1');
    write('map/.hidden/x.json', '{"hidden":true}');
    write('map/node_modules/lib/index.js', 'window.dependency = true;');
    write('map/ignored.json', '{"ignored":true}');
    write('config.json', '{"token":"beside the doc"}');
    write('src/config.js', 'window.config = "beside the doc";');
    write('outside.js', 'window.leaked = true;');
    // A page at the doc's own level, and a line naming a page that is not there.
    write('tide.md', '# Tide\n\n::html{src="index.html"}\n');
    write('index.html', '<h1>Tide</h1>');
    write('ghost.md', '# Ghost\n\n::html{src="ghost/index.html"}\n');
    write('ghost/data.json', '{"ghost":true}');
    // A page in a subfolder whose scope narrows once the doc frames it itself.
    write('narrow.md', '# Narrow\n\n::html{src="map/index.html"}\n');
    write('map/shared.js', 'window.shared = 1;');
    write('map/inner/page.html', '<head><script src="../shared.js"></script></head>');
    write('map/gen.html', '<head><script src="gen.js"></script></head>');
    write('map/gen.js', 'window.generation = 1;');
    // A doc folder outside any git work tree.
    const loose = join(root, 'loose');
    mkdirSync(join(loose, 'map'), { recursive: true });
    writeFileSync(join(loose, 'doc.md'), '# Loose\n\n::html{src="map/index.html"}\n');
    writeFileSync(join(loose, 'map', 'index.html'), '<h1>Loose</h1>');
    writeFileSync(join(loose, 'map', 'app.js'), 'window.loose = true;');
    writeFileSync(join(root, 'secret.json'), '{"secret":true}');
    symlinkSync(join(root, 'secret.json'), join(docDir, 'map', 'leak.json'));
    symlinkSync(join(docDir, 'config.json'), join(docDir, 'map', 'up.json'));
    symlinkSync(join(docDir, 'map', '.env'), join(docDir, 'map', 'env.json'));
    symlinkSync(join(docDir, 'map', 'notes.txt'), join(docDir, 'map', 'renamed.json'));
    handle = createServer({ port: 0, dataDir: join(root, 'data') });
    base = `http://127.0.0.1:${handle.port}`;
    ws = await seedBoard(base, { name: 'Harborlight' });
    otherWs = await seedBoard(base, { name: 'Riverbend' });
    const bind = (docId: string, file: string) =>
      post(`/workspaces/${ws}/docs`, { docId, type: 'markdown', sourceUrl: join(docDir, file) });
    await bind('harborlight', 'doc.md');
    await bind('riverbend', 'plain.md');
    await bind('tide', 'tide.md');
    await bind('ghost', 'ghost.md');
    await bind('narrow', 'narrow.md');
    await post(`/workspaces/${ws}/docs`, {
      docId: 'loose',
      type: 'markdown',
      sourceUrl: join(root, 'loose', 'doc.md'),
    });
    PAGE_RECHECK.ms = 0;
    await post(`/workspaces/${ws}/docs`, { docId: 'saltmarsh', type: 'dev' });
  });

  afterAll(async () => {
    PAGE_RECHECK.ms = 1_000;
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('serves the page into a frame under its own policy, its script and stylesheet written in', async () => {
    const res = await get('map/index.html', AS_FRAME);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(DOC_PAGE_CSP);
    expect(DOC_PAGE_CSP).not.toContain('allow-same-origin');
    expect(DOC_PAGE_CSP).toContain("connect-src 'none'");
    expect(DOC_PAGE_CSP).toContain("default-src 'none'");
    const page = await res.text();
    const b64 = Buffer.from(APP_JS).toString('base64');
    expect(page).toContain(`<script src="data:text/javascript;base64,${b64}" defer></script>`);
    expect(page).toContain(`<style>${STYLE}</style>`);
    // A reference out of the page's folder is left as written.
    expect(page).toContain('<script src="../outside.js"></script>');
    expect(page).not.toContain(Buffer.from('window.leaked = true;').toString('base64'));
    // The relay is first in the head, and reaches only the page's own folder.
    expect(page.startsWith('<!doctype html><html><head><script>(function(){var B=')).toBe(true);
    expect(page).toContain(`var B="/workspaces/${ws}/docs/harborlight/files/map/"`);
  });

  it('serves a page only into a frame', async () => {
    expect((await get('map/index.html', AS_FRAME)).status).toBe(200);
    for (const dest of [undefined, 'document', 'empty', 'script']) {
      const res = await get('map/index.html', dest ? { headers: { 'sec-fetch-dest': dest } } : {});
      expect(res.status, String(dest)).toBe(403);
      expect(await res.text()).not.toContain('Harborlight</h1>');
    }
  });

  it('serves each sibling with its own type, nosniff, same-origin CORP and the bare sandbox', async () => {
    for (const [path, type] of [
      ['map/app.js', 'text/javascript; charset=utf-8'],
      ['map/style.css', 'text/css; charset=utf-8'],
      ['map/data/ferry.json', 'application/json; charset=utf-8'],
      ['map/pin.png', 'image/png'],
    ] as const) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toBe(type);
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(res.headers.get('cross-origin-resource-policy'), path).toBe('same-origin');
      expect(res.headers.get('content-security-policy'), path).toBe('sandbox');
    }
    expect(await (await get('map/data/ferry.json')).text()).toBe(DATA);
    // A refusal carries the same resource policy.
    const refused = await get('map/notes.txt');
    expect(refused.status).toBe(415);
    expect(refused.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  });

  it('serves nothing outside the folder of a page the doc frames', async () => {
    expect((await get('map/app.js')).status).toBe(200);
    for (const p of ['config.json', 'src/config.js', 'outside.js']) {
      const res = await get(p);
      expect(res.status, p).toBe(404);
      expect(await res.text(), p).not.toContain('beside the doc');
    }
  });

  it('serves nothing for a doc in the same folder whose content frames no page', async () => {
    expect((await get('map/app.js', {}, 'harborlight')).status).toBe(200);
    const res = await get('map/app.js', {}, 'riverbend');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('harborlight');
  });

  it('refuses a gitignored file and anything under node_modules', async () => {
    expect((await get('map/data/ferry.json')).status).toBe(200);
    for (const p of ['map/ignored.json', 'map/node_modules/lib/index.js']) {
      const res = await get(p);
      expect(res.status, p).toBe(404);
      const text = await res.text();
      expect(text, p).not.toContain('"ignored":true');
      expect(text, p).not.toContain('dependency');
    }
  });

  it('refuses every spelling of a climb out of the folder, and a NUL', async () => {
    for (const p of [
      'map/..%2F..%2Fsecret.json',
      'map/%2E%2E%2Fconfig.json',
      'map/%2e%2e/config.json',
      'map/data%2F..%2F..%2Fconfig.json',
      'map/app.js%00.json',
      `${encodeURIComponent(join(root, 'secret.json'))}`,
    ]) {
      const res = await get(p);
      expect([400, 404], p).toContain(res.status);
      const text = await res.text();
      expect(text, p).not.toContain('"secret":true');
      expect(text, p).not.toContain('beside the doc');
    }
  });

  it('refuses a symlink whose real path leaves the serving folder', async () => {
    expect((await get('map/data/ferry.json')).status).toBe(200);
    for (const p of ['map/leak.json', 'map/up.json']) {
      const res = await get(p);
      expect(res.status, p).toBe(404);
      const text = await res.text();
      expect(text, p).not.toContain('"secret":true');
      expect(text, p).not.toContain('beside the doc');
    }
  });

  it('refuses a dotfile, a dot folder, and a link that lands on a dotfile', async () => {
    for (const p of ['map/.env', 'map/.hidden/x.json', 'map/env.json']) {
      const res = await get(p);
      expect([404, 415], p).toContain(res.status);
      const text = await res.text();
      expect(text, p).not.toContain('SECRET=1');
      expect(text, p).not.toContain('"hidden":true');
    }
  });

  it('refuses a type not on the list, by name or by where its link lands', async () => {
    expect((await get('map/notes.txt')).status).toBe(415);
    expect((await get('map/renamed.json')).status).toBe(415);
  });

  it('refuses a doc with no bound file, and a doc on another board', async () => {
    const unbound = await get('map/index.html', AS_FRAME, 'saltmarsh');
    expect(unbound.status).toBe(404);
    expect(await unbound.text()).toContain('not bound to a file');
    const elsewhere = await get('map/index.html', AS_FRAME, 'harborlight', otherWs);
    expect(elsewhere.status).toBe(404);
    expect(await elsewhere.text()).not.toContain('Harborlight</h1>');
  });

  it('answers reads only, and builds no page for a HEAD', async () => {
    expect((await get('map/index.html', { method: 'POST' })).status).toBe(405);
    // A sibling edit leaves no current build, so a GET here would build one.
    write('map/style.css', 'h1 { color: rgb(4, 5, 6); }');
    const before = pageBuildCount();
    const head = await get('map/index.html', { method: 'HEAD', ...AS_FRAME });
    expect(head.status).toBe(200);
    expect(pageBuildCount()).toBe(before);
    expect((await get('map/index.html', AS_FRAME)).status).toBe(200);
    expect(pageBuildCount()).toBe(before + 1);
  });

  it('builds a page once while its files stay the same, and again when a sibling changes', async () => {
    const first = await get('map/index.html', AS_FRAME);
    const etag = first.headers.get('etag') ?? '';
    expect(etag).not.toBe('');
    const built = pageBuildCount();
    const again = await get('map/index.html', {
      headers: { 'sec-fetch-dest': 'iframe', 'if-none-match': etag },
    });
    expect(again.status).toBe(304);
    expect(pageBuildCount()).toBe(built);
    write('map/app.js', 'window.harborlight = "edited";');
    const second = await get('map/index.html', {
      headers: { 'sec-fetch-dest': 'iframe', 'if-none-match': etag },
    });
    expect(second.status).toBe(200);
    expect(pageBuildCount()).toBe(built + 1);
    expect(await second.text()).toContain(
      Buffer.from('window.harborlight = "edited";').toString('base64'),
    );
  });
  it('builds a page again once a script it names appears', async () => {
    write('map/late.html', '<head><script src="late.js"></script></head><body>Saltmarsh</body>');
    const first = await waitFor(
      async () => {
        const res = await get('map/late.html', AS_FRAME);
        return res.status === 200 && (await res.text());
      },
      { describe: 'the new page served' },
    );
    expect(first).toContain('<script src="late.js"></script>');
    write('map/late.js', 'window.late = true;');
    // The folder listing finds a new file on its next rescan (`fs-listing.ts`).
    const b64 = Buffer.from('window.late = true;').toString('base64');
    await waitFor(async () => (await (await get('map/late.html', AS_FRAME)).text()).includes(b64), {
      describe: 'the page written again with the script that appeared',
    });
  });

  it('serves nothing for a page at the doc level', async () => {
    expect((await get('map/app.js')).status).toBe(200);
    expect((await get('index.html', AS_FRAME, 'tide')).status).toBe(404);
    const res = await get('config.json', {}, 'tide');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('beside the doc');
  });

  it('serves nothing for a line naming a page that is not there', async () => {
    const res = await get('ghost/data.json', {}, 'ghost');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('"ghost":true');
  });

  it('serves nothing from a doc folder outside a git work tree', async () => {
    expect((await get('map/app.js')).status).toBe(200);
    expect((await get('map/index.html', AS_FRAME, 'loose')).status).toBe(404);
    const res = await get('map/app.js', {}, 'loose');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('loose');
  });

  it('starts no git run for requests naming files that do not exist', async () => {
    expect((await get('map/app.js')).status).toBe(200);
    const saved = LISTING_AGES.missRescanMs;
    LISTING_AGES.missRescanMs = 0;
    try {
      const before = listingScanCount();
      for (let n = 0; n < 20; n++) expect((await get(`map/nope-${n}.json`)).status).toBe(404);
      expect(listingScanCount()).toBe(before);
    } finally {
      LISTING_AGES.missRescanMs = saved;
    }
  });

  it('keys a page on its decoded path: another spelling is the same page and the same relay base', async () => {
    expect((await get('map/index.html', AS_FRAME)).status).toBe(200);
    const built = pageBuildCount();
    const res = await get('%6Dap/index.html', AS_FRAME);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`var B="/workspaces/${ws}/docs/harborlight/files/map/"`);
    expect(pageBuildCount()).toBe(built);
  });

  it("stops writing in a file once the page's folder narrows past it", async () => {
    const shared = Buffer.from('window.shared = 1;').toString('base64');
    const first = await get('map/inner/page.html', AS_FRAME, 'narrow');
    expect(await first.text()).toContain(shared);
    write(
      'narrow.md',
      '# Narrow\n\n::html{src="map/index.html"}\n\n::html{src="map/inner/page.html"}\n',
    );
    await waitFor(
      async () => {
        const res = await get('map/inner/page.html', AS_FRAME, 'narrow');
        return res.status === 200 && !(await res.text()).includes(shared);
      },
      { describe: 'the page served without the file above its own folder' },
    );
  });

  it('stops writing in a file once git stops listing it', async () => {
    const gen = Buffer.from('window.generation = 1;').toString('base64');
    expect(await (await get('map/gen.html', AS_FRAME)).text()).toContain(gen);
    write('.gitignore', 'map/ignored.json\nmap/gen.js\n');
    const saved = LISTING_AGES.freshMs;
    LISTING_AGES.freshMs = 0;
    try {
      await waitFor(
        async () => {
          const res = await get('map/gen.html', AS_FRAME);
          return res.status === 200 && !(await res.text()).includes(gen);
        },
        { describe: 'the page served without the file git now ignores' },
      );
    } finally {
      LISTING_AGES.freshMs = saved;
    }
  });
});

describe('frameHtml', () => {
  it('reads a file named many times once, and refuses a page past its cap before reading on', async () => {
    const reads: string[] = [];
    const read = async (segs: string[]) => {
      reads.push(segs.join('/'));
      return new TextEncoder().encode('x'.repeat(300));
    };
    const many = `<head>${'<script src="a.js"></script>'.repeat(1000)}<script src="b.js"></script></head>`;
    const page = await frameHtml(many, ['index.html'], '/f/', read, 1_000_000);
    expect(page).not.toBeNull();
    expect(reads).toEqual(['a.js', 'b.js']);
    reads.length = 0;
    // A thousand copies of a 400-byte script pass a 100,000-byte cap.
    expect(await frameHtml(many, ['index.html'], '/f/', read, 100_000)).toBeNull();
    expect(reads).toEqual(['a.js']);
  });
});

describe('landsInside', () => {
  it('judges the open descriptor: inside, nothing hidden on the way, the type asked for', () => {
    const js = landsInside(`${sep}r`, 'text/javascript; charset=utf-8', null);
    expect(js(`${sep}r${sep}a.js`)).toBe(true);
    expect(js(`${sep}r${sep}.git${sep}a.js`)).toBe(false);
    expect(js(`${sep}r${sep}node_modules${sep}a.js`)).toBe(false);
    expect(js(`${sep}r${sep}a.txt`)).toBe(false);
    expect(js(`${sep}x${sep}a.js`)).toBe(false);
    expect(
      landsInside(`${sep}r`, 'text/javascript; charset=utf-8', () => false)(`${sep}r${sep}a.js`),
    ).toBe(false);
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
