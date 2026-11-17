/**
 * Every editor's component runs in the page (the components design, task 5).
 *
 * - A component file an agent saves in a declared folder, uncommitted, builds
 *   and reaches an already-open page within one sweep. The time is printed.
 * - A share visitor types a tag with a prop expression and an esm.sh import
 *   over their own socket; the server builds it, an already-open owner page
 *   receives the build, and the bundle is served to the owner and to the
 *   visitor alike. Drawn, it evaluates the expression with the CDN module.
 * - A read-only socket receives every build and the bundle is served to it,
 *   but nothing it writes — a new tag, an edited tag, a forged or deleted
 *   build entry — changes what is built or served. A writer's change in the
 *   same sequence lands, so a drop is told apart from a delay.
 *
 * Pages are raw Yjs clients on `/workspaces/<ws>/docs/<id>/y`. Read-only is
 * the server's own: with sign-in required to write, a browser socket that
 * proved nobody is stamped `readOnly` at the upgrade.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import {
  componentBuildOf,
  componentBuildsMap,
  componentInputs,
  mdxFlowSources,
} from '@claude-workspaces/core/mdx-components';
import { MDX_FLOW_LANGUAGE } from '@claude-workspaces/core/prose';
import { Window } from 'happy-dom';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import {
  type AccessHarness,
  type MintedShare,
  accessHarness,
  mintAccessShare,
} from './access-share.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const MSG_SYNC = 0;

/** A page holding the doc open. `synced()` resolves once the server has
 *  answered a step 1 sent after everything this page wrote so far. */
function openPage(url: string, headers?: Record<string, string>) {
  const ydoc = new Y.Doc();
  const ws = new WebSocket(url, (headers ? { headers } : {}) as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  let waiting: Array<() => void> = [];
  const opened = new Promise<void>((r) => ws.addEventListener('open', () => r()));
  ws.addEventListener('message', (ev) => {
    const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
    if (decoding.readVarUint(dec) !== MSG_SYNC) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    const kind = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    if (kind === syncProtocol.messageYjsSyncStep2) for (const r of waiting.splice(0)) r();
  });
  ydoc.on('update', (update: Uint8Array, from: unknown) => {
    if (from === ws || ws.readyState !== WebSocket.OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  });
  const synced = async () => {
    await opened;
    const done = new Promise<void>((r) => waiting.push(r));
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, ydoc);
    ws.send(encoding.toUint8Array(enc));
    await done;
  };
  return {
    ydoc,
    synced,
    close: () => {
      waiting = [];
      ws.close();
    },
  };
}

/** Append `mdx-flow` blocks to a page's prose, as the editor's Edit does. */
function appendBlocks(ydoc: Y.Doc, sources: string[]): void {
  const fragment = prose.getProseFragment(ydoc);
  ydoc.transact(() => {
    const els = sources.map((src) => {
      const el = new Y.XmlElement('codeBlock');
      el.setAttribute('language', MDX_FLOW_LANGUAGE);
      el.insert(0, [new Y.XmlText(src)]);
      return el;
    });
    fragment.insert(fragment.length, els);
  });
}

/** Rewrite the first block holding `from` so it holds `to` instead. */
function editBlock(ydoc: Y.Doc, from: string, to: string): void {
  const fragment = prose.getProseFragment(ydoc);
  for (const child of fragment.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    const text = child.toArray()[0];
    if (text instanceof Y.XmlText && text.toString() === from) {
      ydoc.transact(() => {
        text.delete(0, text.length);
        text.insert(0, to);
      });
      return;
    }
  }
  throw new Error(`no block holds ${from}`);
}

const keyOf = (blocks: string[]) => componentInputs(blocks)[0]?.key ?? '';

/** The fake esm.sh: one module, counting each time it runs. */
const CDN_URL = 'https://esm.sh/harborlight-double@1.0.0';
const CDN_MODULE =
  'globalThis.__doubleRan = (globalThis.__doubleRan ?? 0) + 1;\nexport default (n) => n * 2;\n';

const TIDE = `export default function mount(el: HTMLElement, props: { label: string; scale: number }) {
  const p = document.createElement('p');
  p.className = 'tide';
  p.textContent = \`\${props.label} \${props.scale}\`;
  el.append(p);
}
`;
const FERRY = `export default function mount(el: HTMLElement) {
  el.textContent = 'Saltmarsh ferry';
}
`;

const VISITOR_IMPORTS = [
  "import Tide from './components/tide.tsx'",
  `import double from '${CDN_URL}'`,
];
const VISITOR_TAG = '<Tide label="Riverbend" scale={double(21)} />';
const VISITOR_KEY = keyOf([...VISITOR_IMPORTS, VISITOR_TAG]);
const FERRY_IMPORT = "import Ferry from './agent/ferry.tsx'";
const FERRY_TAG = '<Ferry />';
const FERRY_KEY = keyOf([FERRY_IMPORT, FERRY_TAG]);

let root = '';
let repo = '';
let handle: ServerHandle;
let base = '';
let WS = '';
let access: AccessHarness;
let visitor: MintedShare;
const pageUrl = () => `ws://127.0.0.1:${handle.port}/workspaces/${WS}/docs/post/y`;
const bundlePath = (hash: string) => `/workspaces/${WS}/docs/post/components/${hash}.js`;

/** Draw a bundle's text in a fresh DOM; the host it drew into. */
async function draw(code: string, name: string): Promise<HTMLElement> {
  const win = new Window();
  const g = globalThis as Record<string, unknown>;
  const before = { document: g.document, Node: g.Node };
  g.document = win.document;
  g.Node = win.Node;
  try {
    const file = join(root, `${name}.mjs`);
    writeFileSync(file, code);
    const mod = (await import(file)) as { default: (h: HTMLElement, api: unknown) => unknown };
    const host = win.document.createElement('div') as unknown as HTMLElement;
    mod.default(host, { builtins: {} });
    return host;
  } finally {
    g.document = before.document;
    g.Node = before.Node;
  }
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'component-every-editor-')));
  repo = join(root, 'harborlight');
  mkdirSync(join(repo, 'components'), { recursive: true });
  mkdirSync(join(repo, 'agent'), { recursive: true });
  // Nothing is ever committed: a component is built from the work tree.
  spawnSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'components', 'component.json'), '{}');
  writeFileSync(join(repo, 'components', 'tide.tsx'), TIDE);
  writeFileSync(join(repo, 'agent', 'component.json'), '{}');
  writeFileSync(join(repo, 'post.mdx'), `# Riverbend\n\n${FERRY_IMPORT}\n\n${FERRY_TAG}\n`);
  access = await accessHarness();
  handle = createServer({
    port: 0,
    dataDir: join(root, 'data'),
    requireSignInToWrite: true,
    ...access.serverOptions,
    componentFetch: async (url) =>
      url.startsWith(CDN_URL) ? new Response(CDN_MODULE) : new Response('no', { status: 404 }),
  });
  base = `http://127.0.0.1:${handle.port}`;
  WS = await seedBoard(base);
  const created = await fetch(`${base}/workspaces/${WS}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId: 'post', type: 'markdown', sourceUrl: join(repo, 'post.mdx') }),
  });
  expect(created.ok).toBe(true);
  visitor = await mintAccessShare(base, { ...access, shareLinks: handle.shareLinks }, WS);
});

afterAll(async () => {
  await handle.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('a component an agent saves', () => {
  it('mounts on an already-open page within one sweep, with no commit', async () => {
    const page = openPage(pageUrl());
    try {
      await page.synced();
      const builds = componentBuildsMap(page.ydoc);
      // The tag is in the doc before its file exists: the build says so.
      const missing = await waitFor(() => componentBuildOf(builds, FERRY_KEY)?.error, {
        describe: 'the missing file reaching the page as an error',
      });
      expect(componentBuildOf(builds, FERRY_KEY)?.hash).toBeUndefined();
      expect(missing.length).toBeGreaterThan(0);
      const savedAt = performance.now();
      writeFileSync(join(repo, 'agent', 'ferry.tsx'), FERRY);
      const hash = await waitFor(() => componentBuildOf(builds, FERRY_KEY)?.hash, {
        describe: 'the saved component reaching the open page',
      });
      console.log(
        `[component agent save] ${Math.round(performance.now() - savedAt)} ms from the save to the open page's map`,
      );
      expect(componentBuildOf(builds, FERRY_KEY)?.error).toBeUndefined();
      const res = await fetch(`${base}${bundlePath(hash)}`);
      expect(res.status).toBe(200);
      expect((await draw(await res.text(), 'ferry')).textContent).toBe('Saltmarsh ferry');
    } finally {
      page.close();
    }
  });
});

describe('a tag a share visitor adds', () => {
  it('builds with its prop expression and CDN import, and runs for every reader', async () => {
    const owner = openPage(pageUrl());
    const guest = openPage(pageUrl(), visitor.headers);
    try {
      await Promise.all([owner.synced(), guest.synced()]);
      appendBlocks(guest.ydoc, [...VISITOR_IMPORTS, VISITOR_TAG]);
      await guest.synced();
      // The visitor's socket was writable: the tag is in the server's doc.
      expect(mdxFlowSources(prose.getProseFragment(owner.ydoc))).toContain(VISITOR_TAG);
      const hash = await waitFor(
        () => componentBuildOf(componentBuildsMap(owner.ydoc), VISITOR_KEY)?.hash,
        {
          describe: "the visitor's tag built and filed on the owner's open page",
        },
      );
      const asOwner = await fetch(`${base}${bundlePath(hash)}`);
      const asVisitor = await fetch(`${base}${bundlePath(hash)}`, { headers: visitor.headers });
      expect(asOwner.status).toBe(200);
      expect(asVisitor.status).toBe(200);
      const code = await asOwner.text();
      expect(await asVisitor.text()).toBe(code);
      const g = globalThis as Record<string, unknown>;
      const ranBefore = Number(g.__doubleRan ?? 0);
      const host = await draw(code, 'visitor-tide');
      expect(host.querySelector('.tide')?.textContent).toBe('Riverbend 42');
      expect(Number(g.__doubleRan)).toBe(ranBefore + 1);
    } finally {
      owner.close();
      guest.close();
    }
  });
});

describe('a read-only connection', () => {
  it('sees every component and cannot change a build', async () => {
    const writer = openPage(pageUrl());
    const reader = openPage(pageUrl(), { origin: base });
    try {
      await Promise.all([writer.synced(), reader.synced()]);
      const builds = () => componentBuildsMap(writer.ydoc);
      const hash = await waitFor(() => componentBuildOf(builds(), VISITOR_KEY)?.hash, {
        describe: 'the build on the writer page',
      });
      const ferry = componentBuildOf(builds(), FERRY_KEY)?.hash;
      expect(ferry).toBeDefined();
      // It sees every component: the builds reached it, and the bundles are served to it.
      const readerBuilds = componentBuildsMap(reader.ydoc);
      expect(componentBuildOf(readerBuilds, VISITOR_KEY)?.hash).toBe(hash);
      expect(componentBuildOf(readerBuilds, FERRY_KEY)?.hash).toBe(ferry);
      for (const h of [hash, ferry]) {
        const res = await fetch(`${base}${bundlePath(String(h))}`, { headers: { origin: base } });
        expect(res.status).toBe(200);
      }

      // A client that ignores being read-only and writes anyway.
      const bobTag = '<Tide label="Bob" scale={double(1)} />';
      appendBlocks(reader.ydoc, [bobTag]);
      editBlock(reader.ydoc, VISITOR_TAG, '<Tide label="Bob was here" scale={0} />');
      reader.ydoc.transact(() => {
        readerBuilds.set(VISITOR_KEY, { hash: String(ferry), at: Date.now() });
        readerBuilds.delete(FERRY_KEY);
      });
      // The REST rewrite a page might try instead of the socket.
      const rest = await fetch(`${base}/workspaces/${WS}/docs/post/content`, {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ markdown: `# Bob\n\n${bobTag}\n` }),
      });
      expect(rest.status).toBe(401);
      await reader.synced();

      // Positive control: a writer's tag through the same server lands and builds.
      const aliceTag = '<Tide label="Alice" scale={double(2)} />';
      appendBlocks(writer.ydoc, [aliceTag]);
      await writer.synced();
      const aliceKey = keyOf([...VISITOR_IMPORTS, aliceTag]);
      await waitFor(() => componentBuildOf(builds(), aliceKey)?.hash, {
        describe: "the writer's tag built",
      });

      const fresh = openPage(pageUrl());
      try {
        await fresh.synced();
        const sources = mdxFlowSources(prose.getProseFragment(fresh.ydoc));
        expect(sources).toContain(VISITOR_TAG);
        expect(sources).toContain(aliceTag);
        expect(sources).not.toContain(bobTag);
        const now = componentBuildsMap(fresh.ydoc);
        expect(componentBuildOf(now, VISITOR_KEY)?.hash).toBe(hash);
        expect(componentBuildOf(now, FERRY_KEY)?.hash).toBe(ferry);
        expect(componentBuildOf(now, keyOf([...VISITOR_IMPORTS, bobTag]))).toBeUndefined();
        expect((await fetch(`${base}${bundlePath(hash)}`)).status).toBe(200);
      } finally {
        fresh.close();
      }
    } finally {
      writer.close();
      reader.close();
    }
  });
});
