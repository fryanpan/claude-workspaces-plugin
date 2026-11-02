/**
 * The caller token's own parts (`keeper-callers.ts`) and the setup step that
 * hands it out (`keeper-setup-callers.ts`): a token file is used only when
 * it is a plain file of this user's that nobody else may read, it is written
 * mode 600, and setup keeps a token the keeper accepts and replaces one it
 * does not. The token in each case is made here.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CALLER_TOKEN_FILE,
  callerTokenPath,
  callerVerdict,
  mintCallerToken,
  readCallerToken,
  writeCallerToken,
} from '../src/keeper/keeper-callers.ts';
import { ensureCallerToken } from '../src/keeper/keeper-setup-callers.ts';
import { openKeeperStore } from '../src/keeper/keeper-store.ts';

const tmp = mkdtempSync(join(tmpdir(), 'keeper-callers-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const TOKEN = 'caller-token-for-tests-only-Harborlight-0123456789';

const freshStore = (name: string) => {
  const dir = join(tmp, name);
  mkdirSync(dir, { mode: 0o700 });
  const s = openKeeperStore(dir);
  if ('error' in s) throw new Error(s.error);
  return s;
};

describe('the token and the store', () => {
  it('is none before one is made, then only the newest token passes', () => {
    const store = freshStore('store-a');
    expect(callerVerdict(store, TOKEN)).toBe('none');
    const first = mintCallerToken(store);
    expect(callerVerdict(store, first)).toBe('ok');
    expect(callerVerdict(store, null)).toBe('wrong');
    expect(callerVerdict(store, TOKEN)).toBe('wrong');
    const second = mintCallerToken(store);
    expect(callerVerdict(store, first)).toBe('wrong');
    expect(callerVerdict(store, second)).toBe('ok');
    // The store keeps a hash, never the token.
    expect(JSON.stringify(store.callerTokenHash())).not.toContain(second);
  });
});

describe('the token file', () => {
  it('lives under prod’s root unless the variable names another', () => {
    expect(callerTokenPath({}, '/Users/alice')).toBe(join('/Users/alice', CALLER_TOKEN_FILE));
    expect(callerTokenPath({ CW_KEEPER_CALLER_TOKEN_FILE: '/x/t' }, '/Users/alice')).toBe('/x/t');
  });

  it('is written mode 600 and read back', () => {
    const path = join(tmp, 'deep', 'folder', 'token');
    writeCallerToken(path, TOKEN);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(tmp, 'deep', 'folder')).mode & 0o777).toBe(0o700);
    expect(readCallerToken(path)).toEqual({ token: TOKEN });
  });

  it('is refused when missing, readable by others, a link, another user’s, or not a token', () => {
    const problem = (path: string, uid?: number) => {
      const r = readCallerToken(path, uid);
      return 'problem' in r ? r.problem : '';
    };
    expect(problem(join(tmp, 'absent'))).toContain('does not exist');
    const loose = join(tmp, 'loose');
    writeFileSync(loose, TOKEN, { mode: 0o644 });
    chmodSync(loose, 0o644);
    expect(problem(loose)).toContain('mode 644');
    const good = join(tmp, 'good');
    writeCallerToken(good, TOKEN);
    const link = join(tmp, 'link');
    symlinkSync(good, link);
    expect(problem(link)).toContain('could not be opened');
    expect(problem(good, 4_000_000)).toContain('not this user');
    const junk = join(tmp, 'junk');
    writeFileSync(junk, 'short', { mode: 0o600 });
    expect(problem(junk)).toContain('does not hold a caller token');
  });
});

describe('the setup step', () => {
  /** A keeper that accepts only the token its store holds. */
  const fakeKeeper = (store: ReturnType<typeof freshStore>) => {
    let mints = 0;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const presented = new Headers(init?.headers).get('x-cw-keeper-caller');
      return new Response('{}', { status: callerVerdict(store, presented) === 'ok' ? 404 : 401 });
    }) as typeof fetch;
    const mint = () => {
      mints++;
      return { status: 0, stdout: `${mintCallerToken(store)}\n`, stderr: '' };
    };
    return { fetchImpl, mint, mints: () => mints };
  };

  it('mints and writes a token when there is none, then keeps it on the next run', async () => {
    const store = freshStore('store-b');
    const k = fakeKeeper(store);
    const path = join(tmp, 'setup-b', 'token');
    const deps = {
      path,
      url: 'http://localhost:1',
      dryRun: false,
      fetch: k.fetchImpl,
      mint: k.mint,
    };
    const first = await ensureCallerToken(deps);
    expect(first).toMatchObject({ said: expect.stringContaining('wrote') });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const second = await ensureCallerToken(deps);
    expect(second).toMatchObject({ said: expect.stringContaining('already') });
    expect(k.mints()).toBe(1);
  });

  it('replaces a token the keeper no longer accepts, and a dry run changes nothing', async () => {
    const store = freshStore('store-c');
    const k = fakeKeeper(store);
    const path = join(tmp, 'setup-c', 'token');
    writeCallerToken(path, TOKEN);
    const dry = await ensureCallerToken({
      path,
      url: 'http://localhost:1',
      dryRun: true,
      fetch: k.fetchImpl,
      mint: k.mint,
    });
    expect(dry).toMatchObject({ token: null });
    expect(k.mints()).toBe(0);
    const real = await ensureCallerToken({
      path,
      url: 'http://localhost:1',
      dryRun: false,
      fetch: k.fetchImpl,
      mint: k.mint,
    });
    expect(real).toMatchObject({ said: expect.stringContaining('wrote') });
    const read = readCallerToken(path);
    expect('token' in read && callerVerdict(store, read.token)).toBe('ok');
  });

  it('stops when the keeper makes no token', async () => {
    const r = await ensureCallerToken({
      path: join(tmp, 'setup-d', 'token'),
      url: 'http://localhost:1',
      dryRun: false,
      fetch: (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch,
      mint: () => ({ status: 1, stdout: '', stderr: 'refused' }),
    });
    expect(r).toEqual({ stop: 'the keeper did not make a caller token: refused' });
  });
});
