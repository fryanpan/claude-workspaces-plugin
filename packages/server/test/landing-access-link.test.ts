/**
 * The workspaces list (`/`) links to the access page for the owner, and for
 * nobody else (Bryan, 30 Oct: "a way to get to this page from the main
 * workspaces page").
 *
 * Through the real route: the owner signed in with the session cookie the
 * emailed-code sign-in sets, another signed-in person, and a request that
 * proves nobody. The access page refuses the last two anyway; the list just
 * does not offer them a link that would be refused.
 *
 * All fixtures are synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { signedInPerson } from './signed-in-person.ts';

const OWNER_EMAIL = 'owner@harborlight.test';
const ACCESS_LINK = '<a class="top-link" href="/access">Who has access</a>';

let root: string;
let dataDir: string;
let handle: ServerHandle;
let base: string;

const landing = async (headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}/`, { headers: { accept: 'text/html', ...headers } });
  expect(r.status).toBe(200);
  return r.text();
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'landing-access-link-'));
  dataDir = join(root, 'data');
  handle = createServer({ port: 0, dataDir, ownerEmail: OWNER_EMAIL });
  base = `http://127.0.0.1:${handle.port}`;
  handle.tasks.createWorkspace('Harborlight');
});

afterAll(async () => {
  await handle?.stop();
  resetOwnerIdentities();
  rmSync(root, { recursive: true, force: true });
});

describe('the workspaces list links to the access page', () => {
  it('shows the owner the link, in the title row', async () => {
    const owner = signedInPerson(handle, dataDir, base, { email: OWNER_EMAIL });
    const html = await landing(owner.headers);
    expect(html).toContain(`<header class="top"><h1>Workspaces</h1>${ACCESS_LINK}</header>`);
  });

  it('does not show it to another signed-in person', async () => {
    const alice = signedInPerson(handle, dataDir, base, { email: 'alice@harborlight.test' });
    const html = await landing(alice.headers);
    expect(html).toContain('<h1>Workspaces</h1>');
    expect(html).not.toContain('href="/access"');
  });

  it('does not show it to a request that proves nobody', async () => {
    const html = await landing();
    expect(html).toContain('<h1>Workspaces</h1>');
    expect(html).not.toContain('href="/access"');
  });
});
