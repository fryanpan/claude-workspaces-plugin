/**
 * What `bun run new-app` hands an agent: an app that builds, serves its pages
 * in the shared theme behind password sign-in, and syncs a doc between two
 * signed-in pages through the collab core, keeping the doc and the session
 * across a restart.
 *
 * The app is made into a temp folder outside the repo and run as its own
 * process; `scripts/app-kit-harness.ts` says why its dependencies are linked
 * rather than installed. The two pages are the made app's own page client
 * (`src/client/sync.ts`), imported from the made app. The same flow in two
 * real browser tabs is `scripts/app-kit-browser.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kitManifest, tarballName } from '../../../packages/app-kit/scripts/pack.ts';
import {
  PASSWORD,
  type RunningApp,
  cookieFrom,
  makeBuiltApp,
  postForm,
  signIn,
  signUpVerified,
  startApp,
} from '../../../scripts/app-kit-harness.ts';
import { shiftIndex, splice } from '../../../templates/app-kit/src/client/text-binding.ts';
import { waitFor } from './wait-for.ts';

type ConnectDoc = typeof import('../../../templates/app-kit/src/client/sync.ts').connectDoc;

let parent: string;
let appDir: string;
let dataDir: string;
let app: RunningApp;
let connectDoc: ConnectDoc;
let alice: string;
let bob: string;
const closers: Array<() => void> = [];

beforeAll(async () => {
  parent = mkdtempSync(join(tmpdir(), 'app-kit-'));
  appDir = makeBuiltApp(parent);
  dataDir = join(parent, 'data');
  app = await startApp(appDir, dataDir);
  alice = await signUpVerified(app, 'alice@example.com', 'Alice');
  bob = await signUpVerified(app, 'bob@example.com', 'Bob');
  // The made app's own copy, not the template's: what ships is what syncs.
  ({ connectDoc } = (await import(join(appDir, 'src/client/sync.ts'))) as {
    connectDoc: ConnectDoc;
  });
}, 120_000);

afterAll(async () => {
  for (const close of closers.splice(0)) close();
  await app?.stop();
  rmSync(parent, { recursive: true, force: true });
});

function page(url: string, cookie: string) {
  const sync = connectDoc(url, { headers: { cookie } });
  closers.push(sync.close);
  return sync;
}

describe('an app made by new-app', () => {
  it('takes the collab core and the theme from the versioned kit package, not copies', async () => {
    const made = (await Bun.file(join(appDir, 'package.json')).json()) as {
      dependencies: Record<string, string>;
    };
    const { version } = kitManifest();
    expect(made.dependencies['@claude-workspaces/app-kit']).toBe(
      `file:./vendor/${tarballName(version)}`,
    );
    expect(made.dependencies['@claude-workspaces/core']).toBeUndefined();
    expect(existsSync(join(appDir, 'vendor', tarballName(version)))).toBe(true);
    expect(existsSync(join(appDir, 'src/collab'))).toBe(false);
    // The installed package is the packed one: its manifest has lost the
    // in-repo dependency the workspace copy carries.
    const installed = (await Bun.file(
      join(appDir, 'node_modules/@claude-workspaces/app-kit/package.json'),
    ).json()) as { version: string; dependencies: Record<string, string> };
    expect(installed.version).toBe(version);
    expect(installed.dependencies['@claude-workspaces/core']).toBeUndefined();
  });

  it('sends a signed-out visitor to sign-in, and a signed-in one to the app', async () => {
    const out = await fetch(`${app.base}/docs/harborlight`, { redirect: 'manual' });
    expect(out.status).toBe(303);
    expect(out.headers.get('location')).toBe('/auth/sign-in');

    const res = await fetch(`${app.base}/docs/harborlight`, { headers: { cookie: alice } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-doc="harborlight"');
    expect(html).toContain('label="Alice"');
  });

  it('serves the shared theme it links', async () => {
    const html = await (await fetch(`${app.base}/auth/sign-in`)).text();
    expect(html).toContain('href="/assets/theme.css"');
    const theme = await fetch(`${app.base}/assets/theme.css`);
    expect(theme.headers.get('content-type')).toContain('text/css');
    // The theme file's brand hue, and the Web Awesome base it imports.
    const css = await theme.text();
    expect(css).toContain('--wa-color-brand-50');
    expect(css).toContain('--wa-color-blue-50');
  });

  it('answers the health check its fly.toml names, signed out', async () => {
    const toml = Bun.TOML.parse(await Bun.file(join(appDir, 'fly.toml')).text()) as {
      http_service: { checks: Array<{ path: string }> };
    };
    const path = toml.http_service.checks[0]?.path ?? '';
    expect((await fetch(`${app.base}${path}`, { redirect: 'manual' })).status).toBe(200);
  });

  it('serves only the files its build wrote', async () => {
    expect((await fetch(`${app.base}/assets/main.js`)).status).toBe(200);
    expect((await fetch(`${app.base}/assets/..%2Fpackage.json`)).status).toBe(404);
    expect((await fetch(`${app.base}/assets/server.ts`)).status).toBe(404);
  });

  it('syncs a doc between two signed-in pages', async () => {
    const one = page(app.ws('harborlight'), alice);
    const two = page(app.ws('harborlight'), alice);
    await Promise.all([one.synced, two.synced]);
    one.doc.getText('body').insert(0, 'from page one');
    await waitFor(() => two.doc.getText('body').toString() === 'from page one', {
      describe: 'page two to see page one’s edit',
    });
    two.doc.getText('body').insert(0, 'and two: ');
    await waitFor(() => one.doc.getText('body').toString() === 'and two: from page one', {
      describe: 'page one to see page two’s edit',
    });
  });

  it('refuses a doc socket from nobody, and from another site', async () => {
    const upgrade = { upgrade: 'websocket', connection: 'upgrade' };
    const anon = await fetch(`${app.base}/docs/harborlight/ws`, { headers: upgrade });
    expect(anon.status).toBe(401);
    const cookie = alice;
    const cross = await fetch(`${app.base}/docs/harborlight/ws`, {
      headers: { ...upgrade, cookie, origin: 'http://saltmarsh.example' },
    });
    expect(cross.status).toBe(403);
    // Control: a socket from the app's own origin, same cookie, syncs.
    const own = connectDoc(app.ws('harborlight'), { headers: { cookie, origin: app.base } });
    closers.push(own.close);
    await own.synced;
    expect(own.status()).toBe('synced');
  });

  it('keeps a doc, and the session, across a restart', async () => {
    const cookie = bob;
    const writer = page(app.ws('riverbend'), cookie);
    await writer.synced;
    writer.doc.getText('body').insert(0, 'kept on disk');
    // A fresh page reading it back proves the server applied the edit before
    // the restart.
    const check = page(app.ws('riverbend'), cookie);
    await check.synced;
    await waitFor(() => check.doc.getText('body').toString() === 'kept on disk', {
      describe: 'the server to hold the edit',
    });
    for (const close of closers.splice(0)) close();
    await app.stop();
    app = await startApp(appDir, dataDir);
    // The same cookie: the session is in auth.sqlite, the secret in the data folder.
    const again = page(app.ws('riverbend'), bob);
    await again.synced;
    expect(again.doc.getText('body').toString()).toBe('kept on disk');
  });
});

describe('password sign-in', () => {
  it('refuses a password until the email is verified, then signs in', async () => {
    const email = 'harborlight@example.com';
    const made = await postForm(app.base, '/auth/sign-up', {
      name: 'Harborlight',
      email,
      password: PASSWORD,
    });
    expect(made.status).toBe(200);
    const early = await postForm(app.base, '/auth/sign-in', { email, password: PASSWORD });
    expect(early.status).toBe(403);
    expect(early.headers.getSetCookie()).toEqual([]);

    expect(
      (await fetch(await app.mailLink('verify-email', email), { redirect: 'manual' })).status,
    ).toBeLessThan(400);
    const cookie = await signIn(app, email);
    const home = await fetch(`${app.base}/`, { headers: { cookie }, redirect: 'manual' });
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('label="Harborlight"');
  });

  it('refuses a wrong password, and sets no session', async () => {
    const res = await postForm(app.base, '/auth/sign-in', {
      email: 'alice@example.com',
      password: 'not the password',
    });
    expect(res.status).toBe(401);
    expect(cookieFrom(res)).toBe('');
    // Control: the right password, same form, signs in.
    expect(await signIn(app, 'alice@example.com')).not.toBe('');
  });

  it('refuses a sign-in form posted from another site', async () => {
    const res = await fetch(`${app.base}/auth/sign-in`, {
      method: 'POST',
      body: new URLSearchParams({ email: 'alice@example.com', password: PASSWORD }),
      headers: { origin: 'http://saltmarsh.example' },
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
  });

  it('ends the session on sign-out', async () => {
    const cookie = await signIn(app, 'bob@example.com');
    const before = await fetch(`${app.base}/`, { headers: { cookie }, redirect: 'manual' });
    expect(before.status).toBe(200);
    expect((await postForm(app.base, '/auth/sign-out', {}, cookie)).status).toBe(303);
    const after = await fetch(`${app.base}/`, { headers: { cookie }, redirect: 'manual' });
    expect(after.status).toBe(303);
  });
});

describe('the textarea binding', () => {
  it('turns one edit into one splice', () => {
    expect(splice('hello world', 'hello, world')).toEqual({ index: 5, remove: 0, insert: ',' });
    expect(splice('abc', 'ac')).toEqual({ index: 1, remove: 1, insert: '' });
    expect(splice('aaa', 'aaaa')).toEqual({ index: 3, remove: 0, insert: 'a' });
  });

  it('keeps the cursor on its character when another tab edits', () => {
    // Text inserted before the cursor pushes it right; after it, not at all.
    expect(shiftIndex([{ insert: 'xy' }], 3)).toBe(5);
    expect(shiftIndex([{ retain: 5 }, { insert: 'xy' }], 3)).toBe(3);
    // Text deleted before it pulls it left; a delete spanning it lands at the start.
    expect(shiftIndex([{ delete: 2 }], 3)).toBe(1);
    expect(shiftIndex([{ retain: 1 }, { delete: 5 }], 3)).toBe(1);
    // Inserted exactly at the cursor goes after it.
    expect(shiftIndex([{ retain: 3 }, { insert: 'z' }], 3)).toBe(3);
  });
});
