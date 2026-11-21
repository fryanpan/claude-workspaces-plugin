/**
 * A server makes its signing key when it starts, not when it first mints
 * something. The wall report's cross-project probe (`wall-probe.ts`) reads
 * the key file and refuses a missing one, so a server that had never served
 * a page failed the probe. Nothing here reads a real key.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readServerKey } from '../../../infra/project-machine/wall-probe.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { loadCookieKey } from '../src/share/link-session.ts';

describe('the signing key exists from boot', () => {
  const dirs: string[] = [];
  const handles: ServerHandle[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'key-at-boot-'));
    dirs.push(d);
    return d;
  };
  afterEach(async () => {
    for (const h of handles.splice(0)) await h.stop();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('a server that has answered no request already has its key, mode 600', () => {
    const dataDir = join(tmp(), 'data');
    handles.push(createServer({ port: 0, dataDir }));
    const path = join(dataDir, 'share-cookie.key');
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // The wall probe reads it, and reads the same key the server signs with.
    expect(readServerKey(dataDir)).toBe(loadCookieKey(dataDir));
  });

  it('a restart keeps the key it made', async () => {
    const dataDir = tmp();
    const first = createServer({ port: 0, dataDir });
    const key = readServerKey(dataDir);
    await first.stop();
    handles.push(createServer({ port: 0, dataDir }));
    expect(readServerKey(dataDir)).toBe(key);
  });

  it('CONTROL: the probe refuses a data dir with no key', () => {
    expect(() => readServerKey(tmp())).toThrow('no share-cookie.key');
  });
});
