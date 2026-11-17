/**
 * The JSON file a `<StreetMap src="…">` tag names beside its `.mdx` doc is
 * served on the doc's files route, and nothing else beside it is: not a
 * sibling the tag does not name, not a gitignored file it does name, not a
 * file another doc's tag names, and not a path that climbs out. Each refusal
 * sits beside a served control from the same folder.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

const REPORTS = JSON.stringify({ markers: [{ lat: 37.77, lng: -122.42, label: 'Harborlight' }] });
const HALLS = JSON.stringify({ points: [{ lat: 37.78, lng: -122.41, category: 'Riverbend' }] });

const DOC = `# Harborlight reports

<StreetMap title="Reports" src="data/reports.json" rings={[150, 300]} />

<StreetMap src="./halls.json" />

<StreetMap src="data/ignored.json" />

<StreetMap src="../outside.json" />
`;

describe('GET …/docs/<id>/files/<a StreetMap src>', () => {
  let handle: ServerHandle;
  let root: string;
  let base: string;
  let ws: string;

  const write = (rel: string, text: string) => {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
  };
  const get = (doc: string, path: string) =>
    fetch(`${base}/workspaces/${ws}/docs/${doc}/files/${path}`);

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'doc-map-data-'));
    write('outside.json', '{"outside":true}');
    const repo = join(root, 'repo');
    mkdirSync(repo);
    spawnSync('git', ['init', '-q'], { cwd: repo });
    write('repo/reports.mdx', DOC);
    write('repo/plain.mdx', '# Saltmarsh\n\nNo map here.\n');
    write('repo/.gitignore', 'data/ignored.json\n');
    write('repo/data/reports.json', REPORTS);
    write('repo/data/sibling.json', '{"sibling":true}');
    write('repo/data/ignored.json', '{"ignored":true}');
    write('repo/halls.json', HALLS);
    write('repo/config.json', '{"config":true}');
    handle = createServer({ port: 0, dataDir: join(root, 'data') });
    base = `http://127.0.0.1:${handle.port}`;
    ws = await seedBoard(base, { name: 'Harborlight' });
    for (const [docId, file] of [
      ['reports', 'reports.mdx'],
      ['plain', 'plain.mdx'],
    ] as const) {
      const r = await fetch(`${base}/workspaces/${ws}/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId, type: 'markdown', sourceUrl: join(repo, file) }),
      });
      expect(r.ok, await r.text()).toBe(true);
    }
  });

  afterAll(async () => {
    await handle?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('serves the file a tag names, in a subfolder and at the doc’s own level', async () => {
    const reports = await get('reports', 'data/reports.json');
    expect(reports.status).toBe(200);
    expect(reports.headers.get('content-type')).toContain('application/json');
    expect(reports.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await reports.text()).toBe(REPORTS);
    const halls = await get('reports', 'halls.json');
    expect(halls.status).toBe(200);
    expect(await halls.text()).toBe(HALLS);
  });

  it('refuses a sibling no tag names, beside the one it serves', async () => {
    expect((await get('reports', 'data/sibling.json')).status).toBe(404);
    expect((await get('reports', 'config.json')).status).toBe(404);
  });

  it('refuses a named file git ignores', async () => {
    expect((await get('reports', 'data/ignored.json')).status).toBe(404);
  });

  it('refuses a path that climbs out, named or not', async () => {
    for (const path of ['..%2Foutside.json', '%2e%2e/outside.json', '%2e%2e%2Foutside.json']) {
      const r = await get('reports', path);
      expect([400, 404]).toContain(r.status);
      expect(await r.text()).not.toContain('"outside":true');
    }
  });

  it('serves nothing for a doc whose tags name no file', async () => {
    expect((await get('plain', 'data/reports.json')).status).toBe(404);
    expect((await get('plain', 'halls.json')).status).toBe(404);
  });
});
