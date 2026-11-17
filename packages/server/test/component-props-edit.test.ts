/**
 * A props edit in a bound `.mdx` doc, made as the editor makes it: keystrokes
 * into the tag's text over the doc socket. The server rebuilds the tag under
 * its new key, so every open page redraws it, and the `.mdx` on disk after the
 * write-back is byte for byte the text with that one edit — the odd
 * indentation, the quote styles, the `.astro` import and the prose around it
 * untouched. An edit to the prose beside the tag files no new build.
 *
 * Pages are raw Yjs clients on `/workspaces/<ws>/docs/<id>/y`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import {
  componentBuildOf,
  componentBuildsMap,
  componentInputs,
  mdxFlowSources,
} from '@claude-workspaces/core/mdx-components';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const MSG_SYNC = 0;

/** A page holding the doc open: it syncs, and sends what it writes. */
function openPage(url: string) {
  const ydoc = new Y.Doc();
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  let synced = false;
  ws.addEventListener('open', () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, ydoc);
    ws.send(encoding.toUint8Array(enc));
  });
  ws.addEventListener('message', (ev) => {
    const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
    if (decoding.readVarUint(dec) !== MSG_SYNC) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    const kind = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
    if (kind === syncProtocol.messageYjsSyncStep2) synced = true;
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
  });
  ydoc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === ws || ws.readyState !== WebSocket.OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  });
  return { ydoc, synced: () => synced, close: () => ws.close() };
}

const FERRY =
  'export default function mount(el: HTMLElement, props: { route: string; zoom: number }) {\n' +
  '  el.textContent = `${props.route} at ${props.zoom}`;\n}\n';

const TAG = `<Ferry
    id="ferry"
  route='Harborlight'
  stops={["Saltmarsh", "Riverbend"]}
  zoom={12}
/>`;
const POST = `# Riverbend

Ferries leave from the pier.

import Ferry from './components/ferry.tsx'
import Map from './components/map.astro'

${TAG}

<Map zoom={3} />

Alice reads the timetable.
`;

let handle: ServerHandle;
let root = '';
let repo = '';
let WS = '';

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'component-props-edit-')));
  repo = join(root, 'harborlight');
  mkdirSync(join(repo, 'components'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'components', 'component.json'), '{}');
  writeFileSync(join(repo, 'components', 'ferry.tsx'), FERRY);
  writeFileSync(join(repo, 'components', 'map.astro'), '<div>map</div>\n');
  writeFileSync(join(repo, 'post.mdx'), POST);
  handle = createServer({
    port: 0,
    dataDir: join(root, 'data'),
    componentFetch: async () => new Response('offline', { status: 503 }),
  });
  const base = `http://127.0.0.1:${handle.port}`;
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

const url = () => `ws://127.0.0.1:${handle.port}/workspaces/${WS}/docs/post/y`;
const onDisk = () => readFileSync(join(repo, 'post.mdx'));
const keyOn = (ydoc: Y.Doc, startsWith: string) =>
  componentInputs(mdxFlowSources(prose.getProseFragment(ydoc))).find((i) =>
    i.tag.startsWith(startsWith),
  )?.key;

/** The text node of the first block whose text starts with `head`. */
function textOf(ydoc: Y.Doc, head: string): Y.XmlText {
  let found: Y.XmlText | null = null;
  const walk = (node: Y.XmlFragment | Y.XmlElement): void => {
    for (const child of node.toArray()) {
      if (found) return;
      if (child instanceof Y.XmlText) {
        if (child.toString().startsWith(head)) found = child;
      } else if (child instanceof Y.XmlElement) walk(child);
    }
  };
  walk(prose.getProseFragment(ydoc));
  if (!found) throw new Error(`no block starting ${head}`);
  return found;
}

/** Replace `from` with `to` in a block's text one keystroke at a time, each
 *  its own transaction, as typing in the editor sends them. */
function typeOver(ydoc: Y.Doc, text: Y.XmlText, from: string, to: string): void {
  const at = text.toString().indexOf(from);
  if (at < 0) throw new Error(`no ${from}`);
  for (let i = from.length - 1; i >= 0; i--) ydoc.transact(() => text.delete(at + i, 1));
  [...to].forEach((ch, i) => ydoc.transact(() => text.insert(at + i, ch)));
}

describe('a props edit in a bound .mdx', () => {
  it('rebuilds the tag under its new key, and writes the exact text to disk', async () => {
    const page = openPage(url());
    const other = openPage(url());
    try {
      await waitFor(() => page.synced() && other.synced(), { describe: 'both pages synced' });
      const builds = componentBuildsMap(other.ydoc);
      const firstKey = keyOn(page.ydoc, '<Ferry') ?? '';
      const first = await waitFor(() => componentBuildOf(builds, firstKey)?.hash, {
        describe: 'the first build on the other page',
      });
      // The .astro tag is not a component: nothing is built for it.
      expect(keyOn(page.ydoc, '<Map')).toBeUndefined();

      const tag = textOf(page.ydoc, '<Ferry');
      typeOver(page.ydoc, tag, '12', '14');
      typeOver(page.ydoc, tag, 'Harborlight', 'Saltmarsh');
      const edited = TAG.replace('12', '14').replace('Harborlight', 'Saltmarsh');
      expect(tag.toString()).toBe(edited);

      const newKey = keyOn(page.ydoc, '<Ferry') ?? '';
      expect(newKey).not.toBe(firstKey);
      const next = await waitFor(
        () => {
          const h = componentBuildOf(builds, newKey)?.hash;
          return h && h !== first ? h : undefined;
        },
        { describe: 'the rebuilt tag reaching the other page under its new key' },
      );
      // The old key's build is dropped, so no page follows it any more.
      await waitFor(() => !builds.has(firstKey) || undefined, { describe: 'the old key dropped' });
      const served = await fetch(
        `http://127.0.0.1:${handle.port}/workspaces/${WS}/docs/post/components/${next}.js`,
      );
      expect(await served.text()).toContain('Saltmarsh');

      const want = Buffer.from(POST.replace(TAG, edited));
      await waitFor(() => onDisk().equals(want) || undefined, {
        describe: 'the .mdx on disk matching the edited text byte for byte',
      });
      expect(onDisk().toString()).toBe(want.toString());
    } finally {
      page.close();
      other.close();
    }
  });

  it('files no new build when the prose beside the tag is edited', async () => {
    const page = openPage(url());
    try {
      await waitFor(() => page.synced(), { describe: 'the page synced' });
      const builds = componentBuildsMap(page.ydoc);
      const key = keyOn(page.ydoc, '<Ferry') ?? '';
      const before = await waitFor(() => componentBuildOf(builds, key), {
        describe: 'the build on the page',
      });
      const changes: string[] = [];
      builds.observe((e) => changes.push(...e.keysChanged));
      const prose1 = textOf(page.ydoc, 'Ferries leave');
      typeOver(page.ydoc, prose1, 'pier', 'north pier');
      const want = onDisk().toString().replace('the pier', 'the north pier');
      await waitFor(() => onDisk().toString() === want || undefined, {
        describe: 'the prose edit written back',
      });
      // Positive control on the same map: touching the component file does
      // rebuild, so a quiet map above is a no-rebuild and not a dead sweep.
      expect(componentBuildOf(builds, key)).toEqual(before);
      expect(changes).toEqual([]);
      writeFileSync(join(repo, 'components', 'ferry.tsx'), FERRY.replace(' at ', ' zoom '));
      await waitFor(() => changes.includes(key) || undefined, {
        describe: 'a saved component file rebuilding the tag',
      });
    } finally {
      page.close();
    }
  });
});
