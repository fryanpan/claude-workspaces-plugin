/**
 * A block is untouched when its content still equals what the file held, and
 * whoever changed the doc — nobody, a restart, a reparse, the meeting notes
 * writer, a browser keystroke — an untouched block keeps its bytes.
 *
 * The no-write cases stamp the file with an old mtime first and assert both
 * its bytes and that stamp afterwards, so a write of identical bytes still
 * counts as a write. Each ends with an edit that DOES write, which is the
 * positive control that the stamp can see one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { DocStore } from '../src/doc-store.ts';
import { applyNotesBlockEdits } from '../src/notes-doc-access.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { MD, MDX } from './keep-source-fixtures.ts';
import { pastWriteBack, waitFor, waitForFileToBe } from './wait-for.ts';

const OLD = new Date('2020-01-01T00:00:00Z');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('untouched blocks keep their bytes, whoever changed the doc', () => {
  let root: string;
  let dataDir: string;
  const stores: DocStore[] = [];

  function makeStore(): DocStore {
    const store = new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
      decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
    });
    stores.push(store);
    return store;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cw-untouched-'));
    dataDir = mkdtempSync(join(tmpdir(), 'cw-untouched-data-'));
  });

  afterEach(() => {
    for (const store of stores.splice(0)) store.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function bind(store: DocStore, name: string, text: string): Promise<string> {
    const path = join(root, name);
    writeFileSync(path, text);
    utimesSync(path, OLD, OLD);
    store.getOrCreate(name, { type: 'markdown', sourceUrl: path });
    expect((await store.attachFileAsync(name, path)).ok).toBe(true);
    return path;
  }

  function expectNoWrite(path: string, text: string): void {
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(statSync(path).mtimeMs).toBe(OLD.getTime());
  }

  for (const [name, text] of [
    ['post.mdx', MDX],
    ['notes.md', MD],
  ] as const) {
    it(`an unedited bound ${name} gets no disk write on attach, after a restart, or after a reparse`, async () => {
      const first = makeStore();
      const path = await bind(first, name, text);
      await waitFor(() => existsSync(join(dataDir, `${name}.ydoc`)) || undefined, {
        describe: 'the .ydoc snapshot a restart hydrates from',
      });
      // timed: a write-back would have landed inside this window.
      await sleep(pastWriteBack());
      expectNoWrite(path, text);

      // A deploy: the process goes away and a new one hydrates the .ydoc and
      // binds the file again. The file is now OLDER than the .ydoc.
      first.simulateCrash();
      const second = makeStore();
      expect(second.get(name)).toBeDefined();
      await waitFor(() => second.boundPathOf(name) === path || undefined, {
        describe: 'the hydrate to bind the file',
      });
      // timed: a boot-time reassert would have landed inside this window.
      await sleep(pastWriteBack());
      expectNoWrite(path, text);

      expect(second.reparseFromDisk(name).ok).toBe(true);
      // timed: a reparse-triggered write-back would have landed inside this window.
      await sleep(pastWriteBack());
      expectNoWrite(path, text);

      // The control: an edit after the restart writes, and still keeps
      // every block it did not touch.
      const [find, replace] = name.endsWith('.mdx')
        ? ['opens at dawn', 'opens at first light']
        : ['runs hourly', 'runs every half hour'];
      expect(second.findAndReplace(name, { find, replace }).ok).toBe(true);
      await waitForFileToBe(path, text.replace(find, replace));
      expect(statSync(path).mtimeMs).not.toBe(OLD.getTime());
    });
  }

  it('meeting notes inserted under a heading of a hand-formatted .md keep every other byte', async () => {
    const MEETING = `# Harborlight standup

Agenda items were
wrapped by hand.

## Notes

* Existing note
    * nested detail

## Actions

1. Call the harbor master
   - about the slip
`;
    const store = makeStore();
    const path = await bind(store, 'standup.md', MEETING);
    const heading = store
      .readOutline('standup.md')
      ?.blocks.find((b) => b.kind === 'heading' && b.text === 'Notes');
    expect(heading).toBeDefined();
    const result = applyNotesBlockEdits(store, 'standup.md', [
      {
        op: 'insert_under_heading',
        headingId: heading!.id,
        markdown: '- New idea from the meeting',
      },
    ]);
    expect(result.ok).toBe(true);
    await waitForFileToBe(
      path,
      MEETING.replace(
        '    * nested detail\n',
        '    * nested detail\n* New idea from the meeting\n',
      ),
    );
  });

  it('a browser (Yjs) edit re-serializes the paragraph it touched and keeps every other block', async () => {
    const store = makeStore();
    const path = await bind(store, 'notes.md', MD);
    const server = store.get('notes.md')!.ydoc;

    // A second client, as the editor in a browser is: it syncs the doc,
    // types into one paragraph, and its update reaches the server doc through
    // the same `Y.applyUpdate` the websocket sync applies, with the socket as
    // origin.
    const browser = new Y.Doc();
    Y.applyUpdate(browser, Y.encodeStateAsUpdate(server));
    const paragraph = prose
      .getProseFragment(browser)
      .toArray()
      .find(
        (b): b is Y.XmlElement =>
          b instanceof Y.XmlElement && b.toString().includes('A soft-wrapped paragraph'),
      );
    const text = paragraph?.toArray().find((c): c is Y.XmlText => c instanceof Y.XmlText);
    expect(text).toBeDefined();
    const before = Y.encodeStateVector(server);
    text!.insert(0, 'Still ');
    Y.applyUpdate(server, Y.encodeStateAsUpdate(browser, before), { socket: 'browser' });
    browser.destroy();

    await waitForFileToBe(
      path,
      MD.replace(
        'A soft-wrapped paragraph that the author\nbroke across three lines on purpose\nto keep diffs small.',
        'Still A soft-wrapped paragraph that the author broke across three lines on purpose to keep diffs small.',
      ),
    );
  });
});
