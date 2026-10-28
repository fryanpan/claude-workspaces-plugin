/**
 * The transcript store's command (`infra/project-machine/store-uploader.ts`):
 * its keys file holds public keys only, a board it was not told about counts
 * as private, and against a stand-in bucket on loopback a pass makes PUTs and
 * nothing else.
 *
 * Keys are generated inside the test; the bucket is a Bun.serve on 127.0.0.1.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSnapshotKeys } from '../../../infra/project-machine/snapshot.ts';
import { openChunk } from '../../../infra/project-machine/store-upload.ts';
import {
  configFromEnv,
  hostSegment,
  parseKeysFile,
} from '../../../infra/project-machine/store-uploader.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scratch = mkdtempSync(join(tmpdir(), 'cw-store-cli-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const review = generateSnapshotKeys();
const owner = generateSnapshotKeys();
const saltmarsh = generateSnapshotKeys();

const keysText = JSON.stringify({
  review: review.recipient,
  owner: owner.recipient,
  boards: { saltmarsh: saltmarsh.recipient },
  classes: { riverbend: 'ordinary', saltmarsh: 'private', harborlight: 'local-only' },
});

describe('the keys file', () => {
  it('names each board’s class, and a board it does not name is private', () => {
    const { keys, classOf } = parseKeysFile(keysText);
    expect(keys.boards.saltmarsh).toBe(saltmarsh.recipient);
    expect(classOf('riverbend')).toBe('ordinary');
    expect(classOf('harborlight')).toBe('local-only');
    expect(classOf('bob-new-board')).toBe('private');
  });

  it('is refused when it holds an identity, or a key that is not one', () => {
    const withIdentity = JSON.stringify({ review: review.recipient, owner: owner.identity });
    expect(() => parseKeysFile(withIdentity)).toThrow(/public keys only/);
    expect(() => parseKeysFile(JSON.stringify({ review: 'x', owner: owner.recipient }))).toThrow(
      /recipient/,
    );
    expect(() =>
      parseKeysFile(
        JSON.stringify({
          review: review.recipient,
          owner: owner.recipient,
          classes: { a: 'open' },
        }),
      ),
    ).toThrow(/not a class/);
  });

  it('makes the host one safe path segment', () => {
    expect(hostSegment('Alices-MacBook.local')).toBe('alices-macbook');
    expect(hostSegment('../..')).toBe('host');
  });
});

describe('on a project machine', () => {
  it('every transcript and log is the machine’s board', () => {
    const dir = mkdtempSync(join(scratch, 'fly-'));
    const projects = join(dir, 'projects', '-cw');
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, 'sess-a.jsonl'), '{}\n');
    writeFileSync(join(dir, 'keys.json'), keysText);
    const config = configFromEnv({
      STORE_KEYS_FILE: join(dir, 'keys.json'),
      STORE_STATE_FILE: join(dir, 'state.json'),
      STORE_TRANSCRIPTS_DIR: join(dir, 'projects'),
      STORE_BOARD: 'saltmarsh',
      STORE_HOST: 'fly',
    });
    expect(config.sources().map((s) => [s.name, s.board])).toEqual([['sess-a', 'saltmarsh']]);
    expect(config.intervalMs).toBe(300_000);
  });
});

describe('a pass against a bucket', () => {
  it('only PUTs, and what it puts opens with the board’s key', async () => {
    const dir = mkdtempSync(join(scratch, 'pass-'));
    const projects = join(dir, 'projects', '-cw');
    mkdirSync(projects, { recursive: true });
    const text = `${JSON.stringify({ type: 'user', message: { content: 'Saltmarsh survey' } })}\n`;
    writeFileSync(join(projects, 'sess-s.jsonl'), text);
    writeFileSync(join(dir, 'keys.json'), keysText);
    const seen: string[] = [];
    const objects = new Map<string, Uint8Array>();
    const bucket = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        seen.push(`${req.method} ${url.pathname}`);
        if (req.method !== 'PUT') return new Response('AccessDenied', { status: 403 });
        objects.set(url.pathname, new Uint8Array(await req.arrayBuffer()));
        return new Response('', { status: 200, headers: { etag: '"x"' } });
      },
    });
    try {
      const child = Bun.spawn(
        ['bun', join(repoRoot, 'infra', 'project-machine', 'store-uploader.ts'), '--once'],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            ...process.env,
            STORE_KEYS_FILE: join(dir, 'keys.json'),
            STORE_STATE_FILE: join(dir, 'state.json'),
            STORE_TRANSCRIPTS_DIR: join(dir, 'projects'),
            STORE_BOARD: 'saltmarsh',
            STORE_HOST: 'fly',
            STORE_S3_ENDPOINT: `http://127.0.0.1:${bucket.port}`,
            STORE_S3_BUCKET: 'cw-store-test',
            // Obviously fake: the stand-in bucket checks no signature.
            STORE_S3_ACCESS_KEY_ID: 'test-access-key',
            STORE_S3_SECRET_ACCESS_KEY: 'test-secret-key',
          },
        },
      );
      const status = await child.exited;
      expect(await new Response(child.stderr).text()).toBe('');
      expect(status).toBe(0);
      const path = '/cw-store-test/fly/transcripts/saltmarsh/sess-s/0.jsonl.zst.cw';
      expect(seen).toEqual([`PUT ${path}`]);
      const body = objects.get(path) ?? new Uint8Array();
      expect(openChunk(body, saltmarsh.identity).toString()).toBe(text);
      expect(() => openChunk(body, review.identity)).toThrow(/did not decrypt/);
    } finally {
      bucket.stop(true);
    }
  }, 30_000);
});
