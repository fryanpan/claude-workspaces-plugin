/**
 * Two people in an app made by `bun run new-app`: each sees the other on a
 * doc page (an app page with no board), and the server refuses an edit from
 * the one the doc's owner made view-only, so it reaches neither the stored
 * doc nor the other person's page.
 *
 * Hermetic: password sign-in on the app's own SQLite, mail printed to the
 * app's stdout, no Google, no Cloudflare. The pages are the made app's own
 * page modules (`src/client/sync.ts`, `src/client/presence.ts`), imported from
 * the made app. `scripts/app-kit-harness.ts` says how the app is made and run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import {
  type RunningApp,
  makeBuiltApp,
  postForm,
  signUpVerified,
  startApp,
} from '../../../scripts/app-kit-harness.ts';
import type * as PresenceModule from '../../../templates/app-kit/src/client/presence.ts';
import { waitFor } from './wait-for.ts';

type ConnectDoc = typeof import('../../../templates/app-kit/src/client/sync.ts').connectDoc;
type ConnectPresence = typeof PresenceModule.connectPresence;

/** A sign-up address, built here so no artifact carries one written out. */
const address = (who: string): string => [who, 'example.com'].join('@');

let parent: string;
let dataDir: string;
let app: RunningApp;
let connectDoc: ConnectDoc;
let connectPresence: ConnectPresence;
let alice: string;
let bob: string;
let saltmarsh: string;
const closers: Array<() => void> = [];

beforeAll(async () => {
  parent = mkdtempSync(join(tmpdir(), 'app-kit-roles-'));
  const appDir = makeBuiltApp(parent, 'harborlight-notes');
  dataDir = join(parent, 'data');
  app = await startApp(appDir, dataDir);
  alice = await signUpVerified(app, address('alice'), 'Alice');
  bob = await signUpVerified(app, address('bob'), 'Bob');
  saltmarsh = await signUpVerified(app, address('saltmarsh'), 'Saltmarsh');
  ({ connectDoc } = (await import(join(appDir, 'src/client/sync.ts'))) as {
    connectDoc: ConnectDoc;
  });
  ({ connectPresence } = (await import(join(appDir, 'src/client/presence.ts'))) as {
    connectPresence: ConnectPresence;
  });
}, 120_000);

afterAll(async () => {
  for (const close of closers.splice(0)) close();
  await app?.stop();
  rmSync(parent, { recursive: true, force: true });
});

const presenceUrl = (docId: string): string => `${app.ws(docId).slice(0, -'/ws'.length)}/presence`;

function docPage(docId: string, cookie: string) {
  const sync = connectDoc(app.ws(docId), { headers: { cookie } });
  closers.push(sync.close);
  return sync;
}

function presence(docId: string, cookie: string) {
  const p = connectPresence(presenceUrl(docId), { headers: { cookie } });
  closers.push(p.close);
  return p;
}

const names = (p: { here(): Array<{ name: string }> }): string =>
  p
    .here()
    .map((x) => x.name)
    .join(',');

/** Open a doc's page as `cookie`, so the first to open it becomes its owner. */
async function openPage(docId: string, cookie: string): Promise<Response> {
  return fetch(`${app.base}/docs/${docId}`, { headers: { cookie }, redirect: 'manual' });
}

function setRole(docId: string, cookie: string, who: string, role: string) {
  return postForm(app.base, `/docs/${docId}/roles`, { email: address(who), role }, cookie);
}

/**
 * A doc socket that speaks the sync frames by hand, so a test can send one
 * update and then know the server has read it: the server answers a step 1
 * in order, after every frame sent before it on the same socket.
 */
async function rawSocket(docId: string, cookie: string) {
  const ws = new WebSocket(app.ws(docId), { headers: { cookie } } as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  const inbox: Uint8Array[] = [];
  ws.addEventListener('message', (ev) => inbox.push(new Uint8Array(ev.data as ArrayBuffer)));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('socket refused')));
  });
  closers.push(() => ws.close());
  const frame = (write: (enc: encoding.Encoder) => void): Uint8Array => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    write(enc);
    return encoding.toUint8Array(enc);
  };
  const isStep2 = (bytes: Uint8Array): boolean => {
    const dec = decoding.createDecoder(bytes);
    return decoding.readVarUint(dec) === 0 && decoding.readVarUint(dec) === 1;
  };
  return {
    /** Send an update that inserts `text` at the start of `body`. */
    insert(text: string): void {
      const doc = new Y.Doc();
      doc.getText('body').insert(0, text);
      ws.send(frame((enc) => syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(doc))));
    },
    /** Resolves once the server has read every frame sent before this call. */
    async fence(): Promise<void> {
      const before = inbox.filter(isStep2).length;
      ws.send(frame((enc) => syncProtocol.writeSyncStep1(enc, new Y.Doc())));
      await waitFor(() => inbox.filter(isStep2).length > before, {
        describe: 'the server to answer the fence',
      });
    },
  };
}

describe('presence in an app made by new-app', () => {
  it('shows each signed-in person the other on a doc page, live', async () => {
    expect((await openPage('harborlight', alice)).status).toBe(200);
    const a = presence('harborlight', alice);
    const b = presence('harborlight', bob);
    await waitFor(() => names(a) === 'Bob' && names(b) === 'Alice', {
      describe: 'Alice to see Bob and Bob to see Alice',
    });
    // Leaving is live too: Bob closes his page and Alice's empties.
    b.close();
    await waitFor(() => names(a) === '', { describe: 'Alice to see Bob leave' });
  });

  it('draws the presence strip on the doc page', async () => {
    const html = await (await openPage('harborlight', bob)).text();
    expect(html).toContain('id="here"');
  });

  it('refuses a presence socket from nobody', async () => {
    const res = await fetch(`${app.base}/docs/harborlight/presence`, {
      headers: { upgrade: 'websocket', connection: 'upgrade' },
    });
    expect(res.status).toBe(401);
  });
});

describe('roles in an app made by new-app', () => {
  it('makes the first person to open a doc its owner, and only the owner sets roles', async () => {
    expect((await openPage('riverbend', alice)).status).toBe(200);
    // Bob is not the owner: his role change is refused.
    expect((await setRole('riverbend', bob, 'saltmarsh', 'view')).status).toBe(403);
    // Control: the owner's same request is taken.
    expect((await setRole('riverbend', alice, 'saltmarsh', 'view')).status).toBe(303);
    // And a role change from another site is refused even for the owner.
    const cross = await fetch(`${app.base}/docs/riverbend/roles`, {
      method: 'POST',
      body: new URLSearchParams({ email: address('bob'), role: 'view' }),
      headers: { cookie: alice, origin: 'http://saltmarsh.example' },
      redirect: 'manual',
    });
    expect(cross.status).toBe(403);
  });

  it('refuses an edit from a view-only person: it reaches neither the other page nor the stored doc', async () => {
    const docId = 'saltmarsh';
    expect((await openPage(docId, alice)).status).toBe(200);
    const alicePage = docPage(docId, alice);
    await alicePage.synced;

    // Bob opens it while he may still edit; his edit is taken.
    const bobSocket = await rawSocket(docId, bob);
    bobSocket.insert('bob-before ');
    await waitFor(() => alicePage.doc.getText('body').toString().includes('bob-before'), {
      describe: 'Alice to see Bob’s edit while he may edit',
    });

    // The owner makes Bob view-only. His open socket loses its write.
    expect((await setRole(docId, alice, 'bob', 'view')).status).toBe(303);
    const page = await (await openPage(docId, bob)).text();
    expect(page).toContain('data-role="view"');

    bobSocket.insert('bob-after ');
    await bobSocket.fence(); // the server has read, and dropped, it

    // A writer's edit sent after the fence reaches Alice's page, so anything
    // the server sent her before it has already arrived.
    const writer = await rawSocket(docId, saltmarsh);
    writer.insert('control ');
    await waitFor(() => alicePage.doc.getText('body').toString().includes('control'), {
      describe: 'Alice to see the control edit',
    });
    expect(alicePage.doc.getText('body').toString()).not.toContain('bob-after');

    // A page opened now reads the server's copy: no refused edit there either.
    const fresh = docPage(docId, saltmarsh);
    await fresh.synced;
    expect(fresh.doc.getText('body').toString()).toContain('control');
    expect(fresh.doc.getText('body').toString()).not.toContain('bob-after');

    // And the stored doc, saved when the app stops, never held it.
    for (const close of closers.splice(0)) close();
    await app.stop();
    const stored = new Y.Doc();
    Y.applyUpdate(stored, new Uint8Array(readFileSync(join(dataDir, 'docs', `${docId}.ydoc`))));
    const text = stored.getText('body').toString();
    expect(text).toContain('bob-before');
    expect(text).toContain('control');
    expect(text).not.toContain('bob-after');
  });
});
