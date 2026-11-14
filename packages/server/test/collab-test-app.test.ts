/**
 * The collab core, driven over real sockets by an app with no Workspaces
 * imports (`collab-app/app.ts`), saving through the server's own doc-state
 * store. Also: private messages kept in their own store are never seen by a
 * doc path reading the same data folder.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CollabStorage, MemoryCollabStorage } from '@claude-workspaces/core/collab';
import * as Y from 'yjs';
import { DiskDocStateStore } from '../src/doc-state/disk.ts';
import { FilePrivateMessageStore } from '../src/private-messages.ts';
import { startCollabApp } from './collab-app/app.ts';
import { waitFor } from './wait-for.ts';
import { openYPage } from './y-page.ts';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'collab-app-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function app(storage: CollabStorage = new MemoryCollabStorage()) {
  const a = startCollabApp(storage);
  cleanup.push(a.stop);
  return a;
}

function pageAs(url: string, person: string) {
  const p = openYPage(url, { 'x-person': person });
  cleanup.push(p.close);
  return p;
}

describe('collab test app', () => {
  it('syncs a doc between two pages through the core', async () => {
    const a = app();
    const one = pageAs(a.ws('harborlight'), 'alice');
    const two = pageAs(a.ws('harborlight'), 'alice');
    await one.synced();
    await two.synced();
    one.ydoc.getText('t').insert(0, 'from page one');
    await waitFor(() => two.ydoc.getText('t').toString() === 'from page one', {
      describe: 'page two to see page one’s edit',
    });
  });

  it('saves through the server doc-state store and reopens from it', async () => {
    const dataDir = tmp();
    const store = new DiskDocStateStore(dataDir);
    const a = app(store);
    const one = pageAs(a.ws('riverbend'), 'alice');
    await one.synced();
    one.ydoc.getText('t').insert(0, 'kept on disk');
    await waitFor(() => store.has('riverbend'), { describe: 'riverbend.ydoc to be written' });
    await waitFor(
      () => {
        const saved = store.read('riverbend');
        if (!saved) return false;
        const doc = new Y.Doc();
        Y.applyUpdate(doc, saved);
        return doc.getText('t').toString() === 'kept on disk';
      },
      { describe: 'the saved state to carry the edit' },
    );
    a.stop();
    const again = app(new DiskDocStateStore(dataDir));
    const two = pageAs(again.ws('riverbend'), 'alice');
    await two.synced();
    expect(two.ydoc.getText('t').toString()).toBe('kept on disk');
  });

  it('gives a view page the doc and never applies its edits', async () => {
    const a = app();
    const editor = pageAs(a.ws('harborlight'), 'alice');
    await editor.synced();
    editor.ydoc.getText('t').insert(0, 'original');
    const viewer = pageAs(a.ws('harborlight'), 'bob');
    await viewer.synced();
    expect(viewer.ydoc.getText('t').toString()).toBe('original');
    viewer.ydoc.getText('t').insert(0, 'defaced ');
    // A fresh editor page reads what the server holds, after the viewer's
    // update was handled: the socket is handled in order.
    await viewer.synced();
    const check = pageAs(a.ws('harborlight'), 'alice');
    await check.synced();
    expect(check.ydoc.getText('t').toString()).toBe('original');
  });

  it('refuses a socket from somebody the role function gives nothing', async () => {
    const a = app();
    const res = await fetch(`${a.base}/rooms/harborlight/ws`, {
      headers: { 'x-person': 'saltmarsh', upgrade: 'websocket' },
    });
    expect(res.status).toBe(403);
    expect(a.host.openRooms()).toEqual([]);
  });

  it('refuses an action whose body names a board, and runs it when it does not', async () => {
    const a = app();
    const post = (body: unknown) =>
      fetch(`${a.base}/rooms/harborlight/actions/append`, {
        method: 'POST',
        headers: { 'x-person': 'alice', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const refused = await post({ text: 'x', boardId: 'riverbend' });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe('room-in-body');
    const ok = await post({ text: 'hello' });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { value: string }).value).toBe('hello');
  });
});

describe('collab test app, a view principal', () => {
  it('cannot change the doc through an action, and can read it', async () => {
    const a = app();
    const post = (person: string, name: string, body: unknown) =>
      fetch(`${a.base}/rooms/harborlight/actions/${name}`, {
        method: 'POST',
        headers: { 'x-person': person, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post('alice', 'append', { text: 'kept' })).status).toBe(200);
    const refused = await post('bob', 'append', { text: ' defaced' });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe('read-only');
    const read = await post('bob', 'read', {});
    expect(((await read.json()) as { value: string }).value).toBe('kept');
  });
});

describe('private messages beside rooms', () => {
  it('are never read by a doc path sharing the data folder', async () => {
    const dataDir = tmp();
    const docs = new DiskDocStateStore(dataDir);
    const messages = new FilePrivateMessageStore(dataDir);
    const secret = 'only for Alice and Harborlight';
    messages.append({
      personId: 'alice',
      agentId: 'harborlight',
      from: 'person',
      author: { id: 'alice', name: 'Alice' },
      text: secret,
    });
    expect(messages.page('alice', 'harborlight').messages.map((m) => m.text)).toEqual([secret]);
    expect(messages.page('bob', 'harborlight').messages).toEqual([]);

    // The doc-state store lists no doc for it, under any name it might take.
    expect(docs.list()).toEqual([]);
    for (const id of [
      'private-messages',
      'alice~harborlight',
      'private-messages/alice~harborlight',
    ]) {
      expect(docs.has(id)).toBe(false);
      expect(docs.read(id)).toBeNull();
    }

    // A room opened on the same folder, under the pair's own name, carries
    // nothing of it.
    const a = app(docs);
    const page = pageAs(a.ws('alice-harborlight'), 'alice');
    await page.synced();
    expect(JSON.stringify(page.ydoc.toJSON())).not.toContain(secret);
    expect(page.ydoc.share.size).toBe(0);

    // Positive control: the same store does list a doc a room saved.
    page.ydoc.getText('t').insert(0, 'room text');
    await waitFor(() => docs.has('alice-harborlight'), { describe: 'the room to be saved' });
    expect(docs.list()).toEqual(['alice-harborlight']);
  });
});
