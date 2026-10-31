/**
 * Home's section bar names the sections the viewer's page carries (Bryan,
 * 31 Oct: "a navbar to go between review items, inbox, projects, coach").
 *
 * Through the real route: the owner signed in with the session cookie the
 * emailed-code sign-in sets, another signed-in person, and a request that
 * proves nobody. Inbox and Coach are the owner's sections, so only the owner's
 * bar has entries for them, and every entry points at a section on the page.
 * That the bar shows only at mobile width and scrolls is the browser test
 * (`packages/workspaces-app/test/home-nav-browser.test.ts`).
 *
 * All fixtures are synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { signedInPerson } from './signed-in-person.ts';

const OWNER_EMAIL = 'owner@harborlight.test';

let root: string;
let dataDir: string;
let handle: ServerHandle;
let base: string;

const landing = async (headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}/`, { headers: { accept: 'text/html', ...headers } });
  expect(r.status).toBe(200);
  return r.text();
};

/** The bar's entries as [target id, label], and whether each target exists. */
function navOf(html: string): Array<{ id: string; label: string; onPage: boolean }> {
  const bar = html.match(/<nav class="home-nav"[^>]*>(.*?)<\/nav>/s)?.[1];
  if (bar === undefined) throw new Error('no section bar on the page');
  return [...bar.matchAll(/<a href="#([^"]+)">([^<]+)<\/a>/g)].map((m) => ({
    id: m[1] ?? '',
    label: m[2] ?? '',
    onPage: html.includes(`id="${m[1]}"`),
  }));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'landing-section-nav-'));
  dataDir = join(root, 'data');
  // An inbox that has been set up, so the owner's page carries the section.
  mkdirSync(join(dataDir, 'inbox'), { recursive: true });
  writeFileSync(
    join(dataDir, 'inbox', 'config.json'),
    JSON.stringify({
      readerAgentId: 'agent-reader',
      slack: [{ workspace: 'harbor', label: 'Harbor', host: 'harborlight' }],
    }),
  );
  handle = createServer({
    port: 0,
    dataDir,
    ownerEmail: OWNER_EMAIL,
    // Never the real Keychain.
    inboxTransport: { ready: () => false, send: async () => ({ ok: false, error: 'unused' }) },
  });
  base = `http://127.0.0.1:${handle.port}`;
  handle.tasks.createWorkspace('Harborlight');
});

afterAll(async () => {
  await handle?.stop();
  resetOwnerIdentities();
  rmSync(root, { recursive: true, force: true });
});

describe("Home's section bar", () => {
  it('gives the owner Review items, Inbox, Projects and Coach, each pointing at its section', async () => {
    const owner = signedInPerson(handle, dataDir, base, { email: OWNER_EMAIL });
    const nav = navOf(await landing(owner.headers));
    expect(nav).toEqual([
      { id: 'landing-review', label: 'Review items', onPage: true },
      { id: 'inbox', label: 'Inbox', onPage: true },
      { id: 'landing-boards', label: 'Projects', onPage: true },
      { id: 'coach', label: 'Coach', onPage: true },
    ]);
  });

  it('gives another signed-in person no Inbox or Coach entry', async () => {
    const alice = signedInPerson(handle, dataDir, base, { email: 'alice@harborlight.test' });
    expect(navOf(await landing(alice.headers)).map((e) => e.label)).toEqual([
      'Review items',
      'Projects',
    ]);
  });

  it('gives a request that proves nobody no Inbox or Coach entry', async () => {
    expect(navOf(await landing()).map((e) => e.label)).toEqual(['Review items', 'Projects']);
  });
});
