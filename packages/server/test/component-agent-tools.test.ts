/**
 * An agent's component tools over the real routes: a state write reaches a
 * page that already has the doc open, a placed tag is inserted and built,
 * and a state whose tag is deleted is listed as unplaced.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import { readComponentState } from '@claude-workspaces/core/mdx-component-state';
import { mdxFlowSources } from '@claude-workspaces/core/mdx-components';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';
import { openYPage } from './y-page.ts';

const AUTHOR = { id: 'agent-riverbend', name: 'Riverbend Bot', color: '#336699' };
const PIN =
  'export default function mount(el: HTMLElement) { el.textContent = "Saltmarsh pier"; }\n';

let handle: ServerHandle;
let root = '';
let base = '';
let WS = '';
const doc = () => `${base}/workspaces/${WS}/docs/post`;
const pageUrl = () => `ws://127.0.0.1:${handle.port}/workspaces/${WS}/docs/post/y`;
const postJson = (path: string, body: unknown) =>
  fetch(`${doc()}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

interface Row {
  id: string | null;
  placed: boolean;
  hasState: boolean;
  tag: string | null;
  build: { status: string; hash?: string; error?: string } | null;
}
const list = async (): Promise<Row[]> =>
  ((await (await fetch(`${doc()}/agent-components`)).json()) as { components: Row[] }).components;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'component-agent-tools-')));
  const repo = join(root, 'harborlight');
  mkdirSync(join(repo, 'components'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'components', 'component.json'), '{}');
  writeFileSync(join(repo, 'components', 'pin.tsx'), PIN);
  writeFileSync(join(repo, 'post.mdx'), '# Riverbend\n\nThe ferry notes.\n');
  handle = createServer({
    port: 0,
    dataDir: join(root, 'data'),
    componentFetch: async () => new Response('offline', { status: 503 }),
  });
  base = `http://127.0.0.1:${handle.port}`;
  WS = await seedBoard(base);
  const created = await fetch(`${base}/workspaces/${WS}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId: 'post', type: 'markdown', sourceUrl: join(repo, 'post.mdx') }),
  });
  expect(created.ok).toBe(true);
});

afterAll(async () => {
  await handle.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("an agent's component tools", () => {
  it('writes state that reaches an already-open page', async () => {
    const page = openYPage(pageUrl());
    try {
      await page.synced();
      const at = performance.now();
      const res = await postJson('agent-components/ferry/state', {
        ops: [
          { op: 'set', path: 'pins.harborlight', value: { lat: 37.8 } },
          { op: 'push', path: 'log', value: 'Alice docked' },
        ],
        author: AUTHOR,
      });
      expect(res.status).toBe(200);
      // Polled, with the time printed for the report, rather than asserted
      // against the clock (testing-standards 3).
      await waitFor(() => (readComponentState(page.ydoc, 'ferry').log ? true : undefined), {
        // The page synced before the write and is never reopened, so the
        // write can only arrive as a push. The ceiling is generous because
        // the claim rests on that push, not on how fast the runner is.
        timeout: 10_000,
        describe: "the agent's write reaching the open page",
      });
      console.log(
        `[component tools] ${Math.round(performance.now() - at)} ms from the agent's call to the open page`,
      );
      expect(readComponentState(page.ydoc, 'ferry')).toEqual({
        pins: { harborlight: { lat: 37.8 } },
        log: ['Alice docked'],
      });
      const got = await fetch(`${doc()}/agent-components/ferry/state?path=pins.harborlight`);
      expect(await got.json()).toEqual(
        expect.objectContaining({ id: 'ferry', value: { lat: 37.8 }, placed: false }),
      );
    } finally {
      page.close();
    }
  }, 15_000);

  it('refuses a bad write whole, an unattributed write, and a bad id', async () => {
    const bad = await postJson('agent-components/ferry/state', {
      ops: [
        { op: 'set', path: 'ok', value: 1 },
        { op: 'rename', path: 'x' },
      ],
      author: AUTHOR,
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('ops[1]');
    const got = (await (await fetch(`${doc()}/agent-components/ferry/state`)).json()) as {
      value: Record<string, unknown>;
    };
    expect(got.value.ok).toBeUndefined();
    const anon = await postJson('agent-components/ferry/state', {
      ops: [{ op: 'set', path: 'ok', value: 1 }],
    });
    expect(anon.status).toBe(400);
    const badId = await postJson('agent-components/Ferry!/state', {
      ops: [{ op: 'set', path: 'ok', value: 1 }],
      author: AUTHOR,
    });
    expect(badId.status).toBe(400);
  });

  it('places a tag with its import, and it builds', async () => {
    const page = openYPage(pageUrl());
    try {
      await page.synced();
      const res = await postJson('agent-components/place', {
        importPath: './components/pin.tsx',
        props: { id: 'pier', label: 'Saltmarsh' },
        author: AUTHOR,
      });
      expect(res.status).toBe(200);
      const placed = (await res.json()) as {
        tag: string;
        addedImport: boolean;
        build: { status: string; hash?: string };
      };
      expect(placed.tag).toBe('<Pin id="pier" label="Saltmarsh" />');
      expect(placed.addedImport).toBe(true);
      expect(placed.build.status).toBe('built');
      await waitFor(
        () =>
          mdxFlowSources(prose.getProseFragment(page.ydoc)).includes(placed.tag) ? true : undefined,
        { describe: 'the placed tag reaching the open page' },
      );
      const bundle = await fetch(`${doc()}/components/${placed.build.hash}.js`);
      expect(bundle.status).toBe(200);
      expect(await bundle.text()).toContain('Saltmarsh pier');
      const row = (await list()).find((r) => r.id === 'pier');
      expect(row).toEqual(expect.objectContaining({ placed: true, tag: placed.tag }));

      // A second tag from the same file reuses the import the doc has.
      const again = await postJson('agent-components/place', {
        importPath: './components/pin.tsx',
        props: { id: 'pier-two' },
        author: AUTHOR,
      });
      expect(((await again.json()) as { addedImport: boolean }).addedImport).toBe(false);
    } finally {
      page.close();
    }
  });

  it('refuses a tag with no id, or an import it could never build', async () => {
    const noId = await postJson('agent-components/place', {
      importPath: './components/pin.tsx',
      props: { label: 'Bob' },
      author: AUTHOR,
    });
    expect(noId.status).toBe(400);
    const bare = await postJson('agent-components/place', {
      importPath: 'leaflet',
      props: { id: 'map' },
      author: AUTHOR,
    });
    expect(bare.status).toBe(400);
  });

  it('lists a state as unplaced once its tag is deleted', async () => {
    const res = await postJson('agent-components/place', {
      importPath: './components/pin.tsx',
      props: { id: 'harbor-map' },
      author: AUTHOR,
    });
    expect(res.status).toBe(200);
    const { tag } = (await res.json()) as { tag: string };
    await postJson('agent-components/harbor-map/state', {
      ops: [{ op: 'set', path: 'zoom', value: 12 }],
      author: AUTHOR,
    });
    expect((await list()).find((r) => r.id === 'harbor-map')).toEqual(
      expect.objectContaining({ placed: true, hasState: true }),
    );

    // A person deletes the tag in the editor.
    const page = openYPage(pageUrl());
    try {
      await page.synced();
      const frag = prose.getProseFragment(page.ydoc);
      const at = frag
        .toArray()
        .findIndex(
          (n) =>
            n instanceof Y.XmlElement &&
            n.nodeName === 'codeBlock' &&
            n.toString().includes('harbor-map'),
        );
      expect(at).toBeGreaterThanOrEqual(0);
      page.ydoc.transact(() => frag.delete(at, 1));
      await page.synced();
    } finally {
      page.close();
    }
    const rows = await list();
    expect(rows.some((r) => r.tag === tag)).toBe(false);
    expect(rows.find((r) => r.id === 'harbor-map')).toEqual(
      expect.objectContaining({ placed: false, hasState: true, tag: null, build: null }),
    );
    const state = await fetch(`${doc()}/agent-components/harbor-map/state`);
    expect(await state.json()).toEqual(
      expect.objectContaining({ value: { zoom: 12 }, placed: false }),
    );
  });
});
