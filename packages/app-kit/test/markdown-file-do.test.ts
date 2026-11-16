/**
 * `markdownFileRoom` on the `./do` adapter in a real workerd: the file is the
 * doc two sockets edit, an edit reaches the file after the debounce even when
 * the object is evicted first, and an outside edit to the file reaches every
 * open page as one splice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DocSync, connectDoc } from '../src/client/sync.ts';
import { until } from './poll.ts';
import { type LocalWorker, hibernate, startWorker } from './workerd-harness.ts';

let worker: LocalWorker;
const open: DocSync[] = [];

function connect(doc: string, user: string): DocSync {
  const sync = connectDoc(`${worker.ws}/docs/${doc}/ws?user=${user}&role=edit`, {
    retryMs: 50,
    maxRetryMs: 200,
  });
  open.push(sync);
  return sync;
}

const text = (s: DocSync): string => s.doc.getText('body').toString();
const fileText = async (name: string): Promise<string> =>
  (await fetch(`${worker.http}/files/${name}`)).text();
const putFile = (name: string, body: string): Promise<Response> =>
  fetch(`${worker.http}/files/${name}`, { method: 'PUT', body });

beforeAll(async () => {
  worker = await startWorker('file-worker.ts', { DOC: 'DocFile', FILES: 'FileStore' });
}, 60_000);

afterAll(async () => {
  for (const s of open) s.close();
  await worker?.dispose();
});

describe('a markdown file as a live doc in a Durable Object', { timeout: 20_000 }, () => {
  it('opens the file into both sockets and writes their edits back to it', async () => {
    await putFile('harborlight', '# Harborlight\n');
    const a = connect('harborlight', 'alice');
    const b = connect('harborlight', 'bob');
    await Promise.all([a.synced, b.synced]);
    expect(text(b)).toBe('# Harborlight\n');
    a.doc.getText('body').insert(14, 'Tide tables.\n');
    await until('bob to see the edit', () => text(b) === '# Harborlight\nTide tables.\n');
    await until(
      'the file to be written',
      async () => (await fileText('harborlight')) === '# Harborlight\nTide tables.\n',
    );
  });

  it('writes an edit to the file even when the object is evicted inside the debounce', async () => {
    await putFile('riverbend', 'draft');
    const a = connect('riverbend', 'alice');
    await a.synced;
    const first = await (await fetch(`${worker.http}/docs/riverbend/instance`)).text();
    a.doc.getText('body').insert(5, ' two');
    await until(
      'the object to hold the edit',
      async () =>
        (await (await fetch(`${worker.http}/docs/riverbend/text`)).text()) === 'draft two',
    );
    await hibernate(worker, 'DocFile', 'riverbend');
    // The eviction came first: the file does not have the edit yet.
    expect(await fileText('riverbend')).toBe('draft');
    await until(
      'the alarm to write the file from a new instance',
      async () => (await fileText('riverbend')) === 'draft two',
    );
    expect(await (await fetch(`${worker.http}/docs/riverbend/instance`)).text()).not.toBe(first);
    expect(a.status()).toBe('synced');
  });

  it('merges an outside edit to the file into every open page', async () => {
    await putFile('saltmarsh', 'alpha beta gamma');
    const a = connect('saltmarsh', 'alice');
    const b = connect('saltmarsh', 'bob');
    await Promise.all([a.synced, b.synced]);
    await putFile('saltmarsh', 'alpha BETA gamma');
    await fetch(`${worker.http}/docs/saltmarsh/refresh`, { method: 'POST' });
    await until('alice to see the outside edit', () => text(a) === 'alpha BETA gamma');
    await until('bob to see the outside edit', () => text(b) === 'alpha BETA gamma');
  });
});
