import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, type Harness, signUpVerified, signedIn, startHarness } from './harness.ts';

let h: Harness;
let admin: Client;
let plain: Client;
let agentKey: string;

beforeAll(async () => {
  h = await startHarness();
  const adminId = await signUpVerified(h, 'harborlight@example.com', 'Harborlight');
  await signUpVerified(h, 'bob@example.com', 'Bob');
  // How the first admin is made in a real deployment too: one SQL update.
  await h.env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = ?1").bind(adminId).run();
  admin = await signedIn(h, 'harborlight@example.com');
  plain = await signedIn(h, 'bob@example.com');
  const minted = await admin.post('/api/agent-keys', { name: 'onboarding agent' });
  expect(minted.status).toBe(201);
  agentKey = ((await minted.json()) as { key: string }).key;
}, 60_000);
afterAll(() => h.dispose());

const newUser = (n: number) => ({ email: `riverbend${n}@example.com`, name: `Riverbend ${n}` });

async function exists(email: string): Promise<boolean> {
  const row = await h.env.DB.prepare('SELECT role FROM user WHERE email = ?1')
    .bind(email)
    .first<{ role: string | null }>();
  return row !== null;
}

describe('registering a user', () => {
  it('an admin can, by session', async () => {
    const res = await admin.post('/api/users', newUser(1));
    expect(res.status).toBe(201);
    expect(await exists('riverbend1@example.com')).toBe(true);
  });

  it("the admin's agent can, by its scoped API key", async () => {
    const res = await h
      .client()
      .post('/api/users', newUser(2), { headers: { 'x-api-key': agentKey } });
    expect(res.status).toBe(201);
    const row = await h.env.DB.prepare('SELECT role FROM user WHERE email = ?1')
      .bind('riverbend2@example.com')
      .first<{ role: string | null }>();
    expect(row?.role).toBe('user');
  });

  it('a plain user cannot, by session', async () => {
    const res = await plain.post('/api/users', newUser(3));
    expect(res.status).toBe(403);
    expect(await exists('riverbend3@example.com')).toBe(false);
  });

  it('a plain user cannot mint an agent key, nor use a key of their own', async () => {
    expect((await plain.post('/api/agent-keys', {})).status).toBe(403);
    // Any user may create an API key through Better Auth, but without the
    // users:create permission, which only the server can grant.
    const own = await plain.post('/api/auth/api-key/create', { name: 'mine' });
    expect(own.status).toBe(200);
    const { key } = (await own.json()) as { key: string };
    const res = await h.client().post('/api/users', newUser(4), { headers: { 'x-api-key': key } });
    expect(res.status).toBe(403);
    expect(await exists('riverbend4@example.com')).toBe(false);
  });

  it("an admin's key without the users:create permission cannot", async () => {
    // The key an admin makes through Better Auth's own route carries no
    // permissions; only /api/agent-keys grants users:create.
    const unscoped = await admin.post('/api/auth/api-key/create', { name: 'read-only' });
    expect(unscoped.status).toBe(200);
    const { key } = (await unscoped.json()) as { key: string };
    const res = await h.client().post('/api/users', newUser(8), { headers: { 'x-api-key': key } });
    expect(res.status).toBe(403);
    expect(await exists('riverbend8@example.com')).toBe(false);
  });

  it('a plain user cannot grant the permission to their own key', async () => {
    const res = await plain.post('/api/auth/api-key/create', {
      name: 'sneaky',
      permissions: { users: ['create'] },
    });
    expect(res.status).toBe(400);
  });

  it('the agent key stops working when its admin is demoted, and grants no session', async () => {
    const asAgent = h.client();
    const session = await asAgent.call('/api/auth/get-session', {
      headers: { 'x-api-key': agentKey },
    });
    expect(await session.json()).toBeNull();

    await h.env.DB.prepare(
      "UPDATE user SET role = 'user' WHERE email = 'harborlight@example.com'",
    ).run();
    const res = await asAgent.post('/api/users', newUser(5), {
      headers: { 'x-api-key': agentKey },
    });
    expect(res.status).toBe(403);
    expect(await exists('riverbend5@example.com')).toBe(false);
  });

  it('nobody signed out can, and a made-up key is refused', async () => {
    expect((await h.client().post('/api/users', newUser(6))).status).toBe(403);
    const res = await h
      .client()
      .post('/api/users', newUser(7), { headers: { 'x-api-key': 'not-a-real-key' } });
    expect(res.status).toBe(403);
  });
});

describe('refusing a bad registration', () => {
  it('answers 400 for a malformed body and a taken address, creating nothing', async () => {
    await h.env.DB.prepare(
      "UPDATE user SET role = 'admin' WHERE email = 'harborlight@example.com'",
    ).run();
    expect(
      (await admin.post('/api/users', { email: 'not-an-address', name: 'Saltmarsh' })).status,
    ).toBe(400);
    expect(
      (await admin.post('/api/users', { email: 'saltmarsh@example.com', name: '' })).status,
    ).toBe(400);
    const taken = await admin.post('/api/users', { email: 'bob@example.com', name: 'Bob' });
    expect(taken.status).toBe(400);
  });
});
