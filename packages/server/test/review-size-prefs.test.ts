/**
 * The review size choice follows the signed-in person across devices: stored
 * per identity, read back on any device that session reaches, refused to
 * anybody not signed in. Fixture addresses only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogCodeSender } from '../src/auth/code-sender.ts';
import { ReviewSizePrefs } from '../src/review-size-prefs.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

describe('ReviewSizePrefs', () => {
  it('keeps one choice per identity across a restart, and survives a corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-size-prefs-'));
    try {
      const prefs = new ReviewSizePrefs(dir);
      expect(prefs.get('user-a')).toBeUndefined();
      prefs.set('user-a', 'easy');
      prefs.set('user-b', 'medium');
      prefs.set('user-a', 'hard');
      const reread = new ReviewSizePrefs(dir);
      expect([reread.get('user-a'), reread.get('user-b')]).toEqual(['hard', 'medium']);
      writeFileSync(join(dir, 'review-size-prefs.json'), '{"user-a":"enormous","user-b":"easy"}');
      expect(new ReviewSizePrefs(dir).get('user-a')).toBeUndefined();
      expect(new ReviewSizePrefs(dir).get('user-b')).toBe('easy');
      writeFileSync(join(dir, 'review-size-prefs.json'), '{nope');
      expect(new ReviewSizePrefs(dir).get('user-b')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('/api/review-size', () => {
  const codes: string[] = [];
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  const browser = () => ({
    origin: base,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
  });

  async function signIn(email: string): Promise<string> {
    const before = codes.length;
    const started = await fetch(`${base}/api/auth/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...browser() },
      body: JSON.stringify({ email }),
    });
    expect(started.status).toBe(200);
    expect(codes.length).toBe(before + 1);
    const res = await fetch(`${base}/api/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...browser() },
      body: JSON.stringify({ email, code: codes[codes.length - 1] }),
    });
    expect(res.status).toBe(200);
    return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  }

  const put = (size: unknown, cookie?: string) =>
    fetch(`${base}/api/review-size`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        ...browser(),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ size }),
    });
  const get = async (cookie?: string) =>
    (await (
      await fetch(`${base}/api/review-size`, { headers: cookie ? { cookie } : {} })
    ).json()) as { size: string | null };

  beforeAll(() => {
    const codeSender = createLogCodeSender(
      (line) => {
        const m = line.match(/login code for \S+: (\d{6})/);
        if (m?.[1]) codes.push(m[1]);
      },
      { printCode: true },
    );
    dataDir = mkdtempSync(join(tmpdir(), 'review-size-routes-'));
    handle = createServer({
      port: 0,
      dataDir,
      emailCodeSignIn: true,
      codeSender,
      spawnerAgentId: null,
    });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('stores the choice for the signed-in person and reads it back from another session', async () => {
    const ipad = await signIn('reviewer@example.com');
    expect((await get(ipad)).size).toBeNull();
    const res = await put('medium', ipad);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ size: 'medium' });
    // A second sign-in is a second device: same person, same choice.
    const phone = await signIn('reviewer@example.com');
    expect((await get(phone)).size).toBe('medium');
    // Somebody else's choice is their own.
    const other = await signIn('second@example.com');
    expect((await get(other)).size).toBeNull();
  });

  it('refuses a write with nobody signed in, and a size that is not one of the three', async () => {
    expect((await put('easy')).status).toBe(401);
    // Without browser headers the write gate reads an agent and lets it by;
    // the route's own session check is what refuses it.
    const agent = await fetch(`${base}/api/review-size`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: 'easy' }),
    });
    expect(agent.status).toBe(401);
    expect(await agent.json()).toEqual({ error: 'not_signed_in' });
    expect((await get()).size).toBeNull();
    const cookie = await signIn('third@example.com');
    expect((await put('enormous', cookie)).status).toBe(400);
    expect((await put(3, cookie)).status).toBe(400);
    expect((await get(cookie)).size).toBeNull();
  });
});
