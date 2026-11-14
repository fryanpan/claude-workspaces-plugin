/**
 * Docs saved by the code before the storage interface reopen identical after
 * it.
 *
 * `fixtures/doc-state-main/` holds four `.ydoc` files written by origin/main
 * at ad8c9f521 through its own DocStore — a markdown doc, a board, a
 * whiteboard and a doc holding component state — and `expected.json`, what a
 * second DocStore from that same checkout read back from them. Each is opened
 * here through both backends and compared with what the old code saw, then
 * reopened once more after a restart.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskDocStateStore } from '../src/doc-state/disk.ts';
import { MemoryDocStateStore } from '../src/doc-state/memory.ts';
import type { DocStateStore } from '../src/doc-state/store.ts';
import { DocStore } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { DOC_KINDS, viewOf } from './doc-state-docs.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'doc-state-main');

interface ExpectedDoc {
  docId: string;
  file: string;
  bytes: number;
  stateVector: string;
  text: Record<string, string>;
  maps: Record<string, unknown>;
}
const EXPECTED = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as {
  docs: ExpectedDoc[];
};

const dirs: string[] = [];
const stores: DocStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function open(dataDir: string, docState: DocStateStore): DocStore {
  const s = new DocStore({
    dataDir,
    docState,
    sse: new SseBus(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
  });
  stores.push(s);
  return s;
}

/** Put the fixture where each backend keeps state, as the old server left it. */
const backends = [
  {
    name: 'disk',
    seed: (dataDir: string, docId: string, file: string): DocStateStore => {
      copyFileSync(join(FIXTURES, file), join(dataDir, `${docId}.ydoc`));
      return new DiskDocStateStore(dataDir);
    },
  },
  {
    name: 'memory',
    seed: (_dataDir: string, docId: string, file: string): DocStateStore => {
      const store = new MemoryDocStateStore();
      store.write(docId, new Uint8Array(readFileSync(join(FIXTURES, file))));
      return store;
    },
  },
];

describe('the origin/main fixture set', () => {
  it('covers all four kinds of doc', () => {
    expect(EXPECTED.docs.map((d) => d.file).sort()).toEqual(DOC_KINDS.map((k) => k.file).sort());
  });
});

for (const backend of backends) {
  describe(`a .ydoc written by origin/main, opened through the ${backend.name} backend`, () => {
    for (const kind of DOC_KINDS) {
      it(`reads as the old code read it, and survives a restart: ${kind.kind}`, () => {
        const expected = EXPECTED.docs.find((d) => d.file === kind.file)!;
        const fileBytes = new Uint8Array(readFileSync(join(FIXTURES, kind.file)));
        expect(fileBytes.length).toBe(expected.bytes);
        const dataDir = mkdtempSync(join(tmpdir(), 'cw-doc-state-fixture-'));
        dirs.push(dataDir);
        const state = backend.seed(dataDir, expected.docId, kind.file);

        const first = open(dataDir, state);
        const doc = first.get(expected.docId);
        expect(doc).toBeDefined();
        const view = viewOf(doc!.ydoc, kind);
        expect(Buffer.from(view.stateVector).toString('base64')).toBe(expected.stateVector);
        expect(view.text).toEqual(expected.text);
        expect(view.maps).toEqual(expected.maps);
        // Re-encoding gives back the very bytes the old code wrote.
        expect(view.update).toEqual(fileBytes);
        first.flush();
        first.stop();

        const second = open(dataDir, state);
        const again = viewOf(second.get(expected.docId)!.ydoc, kind);
        expect(again).toEqual(view);
      });
    }
  });
}
