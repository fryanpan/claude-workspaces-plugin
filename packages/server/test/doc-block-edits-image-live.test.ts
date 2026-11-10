/**
 * An agent puts images into a doc a person is editing, through
 * `POST /workspaces/<ws>/docs/<id>/block_edits`, with no whole-doc rewrite.
 *
 * Three edits in one batch: an image line replaced by a sized one carrying a
 * footnote, a person's placeholder paragraph replaced by an image, and an
 * image added at the end. The person's own edit, made on an open page while
 * the batch lands, has to survive; another open page has to show the images
 * without a reload; and the `.md` on disk has to carry the widths and the
 * footnote in the syntax it was given.
 *
 * Fixtures are synthetic. The repo is public. Port 0, temp data dir.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { getProseFragment } from '../../core/src/prose.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type DocEditorSocket, connectDocEditor } from './doc-editor-socket.ts';
import { waitFor, waitForFile } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const AGENT = { id: 'agent:charts', name: 'Charts', color: '#4a90d9' };

const DOC = [
  '# Harborlight',
  '',
  'Tide heights by month.',
  '',
  'Chart goes here.',
  '',
  '![old chart](img/tides-v1.png)',
  '',
  'End.',
  '',
].join('\n');

const SIZED = '![tide chart](img/tides-v2.png){width=480}^[Harborlight survey, 2024.]';
const PIER = '![pier](img/pier.png){width=320}';
const MAP = '![map](img/map.png){width=600}';

interface OutlineEntry {
  id: string;
  nodeName: string;
  text: string;
}

/** Every image on a page, as `src@width`. */
function imagesOn(ydoc: Y.Doc): string[] {
  return (getProseFragment(ydoc).toArray() as Y.XmlElement[])
    .filter((el) => el instanceof Y.XmlElement && el.nodeName === 'image')
    .map((el) => `${el.getAttribute('src')}@${el.getAttribute('width') ?? ''}`);
}

describe('images put into a doc a person is editing', () => {
  let handle: ServerHandle | null = null;
  let dataDir = '';
  const sockets: DocEditorSocket[] = [];

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    await handle?.stop();
    handle = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('land without a rewrite, keep the person’s edit, and reach an open page', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-block-edits-image-live-'));
    const path = join(dataDir, 'harborlight.md');
    writeFileSync(path, DOC);
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const base = `http://127.0.0.1:${handle.port}`;
    const ws = await seedBoard(base);
    const post = (p: string, body: unknown) =>
      fetch(`${base}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'harborlight',
          type: 'markdown',
          sourceUrl: path,
        })
      ).ok,
    ).toBe(true);

    const url = `ws://127.0.0.1:${handle.port}/workspaces/${ws}/docs/harborlight/y`;
    const person = connectDocEditor(url, base);
    const watcher = connectDocEditor(url, base);
    sockets.push(person, watcher);
    await Promise.all([person.ready, watcher.ready]);

    const outline = (await (
      await fetch(`${base}/workspaces/${ws}/docs/harborlight/outline`)
    ).json()) as { blocks: OutlineEntry[] };
    const idOf = (pick: (b: OutlineEntry) => boolean): string => {
      const found = outline.blocks.find(pick);
      if (!found) throw new Error('block not in the outline');
      return found.id;
    };
    const oldChart = idOf((b) => b.nodeName === 'image');
    const placeholder = idOf((b) => b.text.includes('Chart goes here'));

    // The person types on their open page while the agent's batch is built.
    const tide = (getProseFragment(person.ydoc).toArray() as Y.XmlElement[]).find((el) =>
      el.toString().includes('Tide heights'),
    );
    const text = tide?.get(0);
    if (!(text instanceof Y.XmlText)) throw new Error('no tide paragraph on the page');
    text.insert(text.length, ' Alice checked these.');

    const res = await post(`/workspaces/${ws}/docs/harborlight/block_edits`, {
      author: AGENT,
      edits: [
        { op: 'replace_block', blockId: oldChart, markdown: SIZED },
        { op: 'replace_block', blockId: placeholder, markdown: PIER },
        { op: 'insert_at_end', markdown: MAP },
      ],
    });
    const body = (await res.json()) as { failed: number; outcomes: { status: string }[] };
    expect(body.failed).toBe(0);
    expect(body.outcomes.map((o) => o.status)).toEqual(['applied', 'suggested', 'applied']);

    // The other open page shows all three, at their widths, without a reload.
    await waitFor(
      () =>
        imagesOn(watcher.ydoc).join(' ') ===
        'img/pier.png@320 img/tides-v2.png@480 img/map.png@600',
      { timeout: 1000, describe: 'the three sized images on the open page' },
    );

    // The file carries the person's words, the widths and the footnote. The
    // placeholder stays on disk until somebody accepts its strike.
    await waitForFile(
      path,
      (t) =>
        t ===
        [
          '# Harborlight',
          '',
          'Tide heights by month. Alice checked these.',
          '',
          'Chart goes here.',
          '',
          PIER,
          '',
          SIZED,
          '',
          'End.',
          '',
          MAP,
          '',
        ].join('\n'),
    );
  });
});
