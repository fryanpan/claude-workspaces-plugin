import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestHarness, createTestHarness } from 'wrangler';

// The other files run the app in node. This one bundles src/index.ts the way
// `wrangler dev --local` does and runs it in workerd, so a dependency that
// only breaks on the Workers runtime fails here. No request leaves the
// machine: every call below is answered before Turnstile or Google is asked.
process.env.WRANGLER_SEND_METRICS = 'false';
const CONFIG = join(dirname(fileURLToPath(import.meta.url)), '..', 'wrangler.jsonc');

let server: TestHarness;
beforeAll(async () => {
  server = createTestHarness({
    workers: [
      {
        configPath: CONFIG,
        secrets: {
          BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
          GOOGLE_CLIENT_SECRET: crypto.randomUUID(),
          TURNSTILE_SECRET_KEY: crypto.randomUUID(),
        },
      },
    ],
  });
  await server.listen();
  await server.getWorker().applyD1Migrations('DB');
}, 120_000);
afterAll(() => server?.close());

describe('the Worker on workerd', () => {
  it('boots and answers', async () => {
    const res = await server.fetch('http://localhost:8797/health');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('serves Better Auth from D1: no session without a cookie', async () => {
    const res = await server.fetch('http://localhost:8797/api/auth/get-session');
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it('applies the migrations with wrangler, and the D1 rate limiter runs', async () => {
    const send = () =>
      server.fetch('http://localhost:8797/api/auth/sign-in/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:8797',
          'cf-connecting-ip': '192.0.2.1',
        },
        body: JSON.stringify({ email: 'alice@example.com', password: 'correct-horse-battery' }),
      });
    // No Turnstile token: refused before any siteverify call.
    for (let i = 0; i < 3; i++) expect((await send()).status).toBe(400);
    expect((await send()).status).toBe(429);
  });

  it('refuses registration to a caller with no session or key', async () => {
    const res = await server.fetch('http://localhost:8797/api/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.com', name: 'Bob' }),
    });
    expect(res.status).toBe(403);
  });
});
