/**
 * The sealed token drop (`src/token-drop/`): CI's pair sealed to the Mac's
 * key, opened and stored over the old pair through an injected Keychain, and
 * every refusal — another token's key, a tampered box, another client id, an
 * old drop put back. A stand-in Keychain and bucket; nothing leaves.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { tokenServices } from '../../../infra/cloudflare/service-tokens.ts';
import { openSealedBox, sealedBox } from '../src/keeper/keeper-sealed-box.ts';
import type { SecretRunner } from '../src/secret-store.ts';
import { dropKey, openDrop, sealDrop } from '../src/token-drop/token-drop-blob.ts';
import {
  type DropKeys,
  type PullIo,
  ensureDropKeys,
  pullDrops,
} from '../src/token-drop/token-drop-pull.ts';
import {
  PRIVATE_KEY_SERVICE,
  bucketConfig,
  keyIo,
  tokenDropPass,
} from '../src/token-drop/token-drop-start.ts';

const NAME = 'agent harborlight';
const CLIENT = 'c0ffee.access';
const OLD_SECRET = 'deadbeef'.repeat(8);
const NEW_SECRET = 'feedface'.repeat(8);
const AT = '2026-11-16T09:00:00.000Z';

function testKeys(): DropKeys {
  const p = nacl.box.keyPair();
  return {
    publicKeyB64: Buffer.from(p.publicKey).toString('base64'),
    secretKeyB64: Buffer.from(p.secretKey).toString('base64'),
  };
}

function drop(
  keys: DropKeys,
  over: Partial<{ name: string; clientId: string; rotatedAt: string }> = {},
) {
  return sealDrop(
    { name: NAME, clientId: CLIENT, secret: NEW_SECRET, rotatedAt: AT, ...over },
    keys.publicKeyB64,
  );
}

describe('sealing', () => {
  it('opens what it sealed, and a one-bit change does not open', () => {
    const k = testKeys();
    const box = sealedBox('hello Riverbend', k.publicKeyB64);
    expect(openSealedBox(box, k.publicKeyB64, k.secretKeyB64)).toBe('hello Riverbend');
    const bytes = Buffer.from(box, 'base64');
    bytes[40] = (bytes[40] ?? 0) ^ 1;
    expect(openSealedBox(bytes.toString('base64'), k.publicKeyB64, k.secretKeyB64)).toBeNull();
    expect(openSealedBox(box, testKeys().publicKeyB64, testKeys().secretKeyB64)).toBeNull();
  });

  it('keeps the secret out of the envelope and opens the pair back', () => {
    const k = testKeys();
    const text = drop(k);
    expect(text).not.toContain(NEW_SECRET);
    expect(text).not.toContain(CLIENT);
    expect(openDrop(text, dropKey(NAME), k)).toEqual({
      ok: true,
      pair: { name: NAME, clientId: CLIENT, secret: NEW_SECRET, rotatedAt: AT },
    });
  });

  it("refuses a drop stored under another token's key, and layers that disagree", () => {
    const k = testKeys();
    expect(openDrop(drop(k), dropKey('agent riverbend'), k)).toEqual({
      ok: false,
      refused: 'wrong-key',
    });
    const relabelled = JSON.parse(drop(k));
    relabelled.name = 'agent riverbend';
    expect(openDrop(JSON.stringify(relabelled), dropKey('agent riverbend'), k)).toEqual({
      ok: false,
      refused: 'mismatch',
    });
    expect(openDrop('not json', dropKey(NAME), k)).toEqual({ ok: false, refused: 'not-a-drop' });
  });
});

function fakePull(
  k: DropKeys | null,
  objects: Record<string, string>,
  keychain: Record<string, string>,
) {
  const logs: string[] = [];
  const stored: Array<[string, string]> = [];
  let applied: Record<string, string> = {};
  const io: PullIo = {
    list: async (prefix) => Object.keys(objects).filter((o) => o.startsWith(prefix)),
    get: async (key) => objects[key] ?? null,
    keys: async () => k,
    keychainRead: async (s) => keychain[s] ?? null,
    replaceToken: async (services, clientId, secret) => {
      keychain[services.clientId] = clientId;
      keychain[services.secret] = secret;
      stored.push([services.clientId, services.secret]);
    },
    applied: () => applied,
    recordApplied: (name, at) => {
      applied = { ...applied, [name]: at };
    },
    log: (l) => logs.push(l),
  };
  return { io, logs, stored, keychain };
}

describe('pullDrops', () => {
  const s = tokenServices(NAME);

  it('stores the new pair over the old one, once', async () => {
    const k = testKeys();
    const f = fakePull(
      k,
      { [dropKey(NAME)]: drop(k) },
      {
        [s.clientId]: CLIENT,
        [s.secret]: OLD_SECRET,
      },
    );
    expect((await pullDrops(f.io))?.map((r) => r.outcome)).toEqual(['stored']);
    expect(f.keychain[s.secret]).toBe(NEW_SECRET);
    expect((await pullDrops(f.io))?.map((r) => r.outcome)).toEqual(['already-stored']);
    expect(f.stored).toHaveLength(1);
    expect(f.logs.join('\n')).not.toContain(NEW_SECRET);
  });

  it('refuses an older drop put back after a newer one was stored', async () => {
    const k = testKeys();
    const objects = { [dropKey(NAME)]: drop(k) };
    const f = fakePull(k, objects, { [s.clientId]: CLIENT, [s.secret]: OLD_SECRET });
    await pullDrops(f.io);
    objects[dropKey(NAME)] = drop(k, { rotatedAt: '2026-11-10T09:00:00.000Z' });
    expect((await pullDrops(f.io))?.map((r) => r.outcome)).toEqual(['already-stored']);
    expect(f.stored).toHaveLength(1);
  });

  it('refuses another client id, a token this Mac does not hold, and a tampered box', async () => {
    const k = testKeys();
    const other = fakePull(
      k,
      { [dropKey(NAME)]: drop(k, { clientId: 'b0b.access' }) },
      {
        [s.clientId]: CLIENT,
      },
    );
    expect((await pullDrops(other.io))?.map((r) => r.outcome)).toEqual(['other-client-id']);
    const notHeld = fakePull(k, { [dropKey(NAME)]: drop(k) }, {});
    expect((await pullDrops(notHeld.io))?.map((r) => r.outcome)).toEqual(['not-held']);
    const env = JSON.parse(drop(k));
    const box = Buffer.from(env.box, 'base64');
    box[box.length - 1] = (box[box.length - 1] ?? 0) ^ 1;
    env.box = box.toString('base64');
    const tampered = fakePull(
      k,
      { [dropKey(NAME)]: JSON.stringify(env) },
      {
        [s.clientId]: CLIENT,
      },
    );
    expect((await pullDrops(tampered.io))?.map((r) => r.outcome)).toEqual(['cannot-open']);
    for (const f of [other, notHeld, tampered]) expect(f.stored).toHaveLength(0);
  });

  it('reads nothing without a private key, and pulls one name when asked', async () => {
    expect(await pullDrops(fakePull(null, {}, {}).io)).toBeNull();
    const k = testKeys();
    const f = fakePull(k, {}, {});
    expect(await pullDrops(f.io, 'agent riverbend')).toEqual([
      { key: dropKey('agent riverbend'), outcome: 'missing' },
    ]);
  });
});

/** A stand-in `security`: find-generic-password and `-i` add lines. */
function fakeSecurity(items = new Map<string, string>()) {
  const calls: Array<{ args: string[]; stdin: string }> = [];
  const run: SecretRunner = async (_file, args, stdin) => {
    calls.push({ args, stdin });
    if (args[0] === '-i') {
      const m = /^add-generic-password( -U)? -a (\S+) -s (\S+) -w "([^"]*)"\n$/.exec(stdin);
      if (!m?.[3] || m[4] === undefined) return { code: 1, stdout: '', stderr: '' };
      if (!m[1] && items.has(m[3])) return { code: 45, stdout: '', stderr: '' };
      items.set(m[3], m[4]);
      return { code: 0, stdout: '', stderr: '' };
    }
    const service = args[args.indexOf('-s') + 1] ?? '';
    const v = items.get(service);
    return v === undefined
      ? { code: 44, stdout: '', stderr: '' }
      : { code: 0, stdout: `${v}\n`, stderr: '' };
  };
  return { run, items, calls };
}

describe('the Mac key pair', () => {
  it('is made once, private half in the Keychain only, and never replaced', async () => {
    const sec = fakeSecurity();
    const first = await ensureDropKeys(keyIo(sec.run));
    expect(first?.created).toBe(true);
    expect(sec.items.get(PRIVATE_KEY_SERVICE)).toBe(first?.secretKeyB64);
    // The value went on stdin, never in an argument.
    for (const c of sec.calls) expect(c.args.join(' ')).not.toContain(first?.secretKeyB64 ?? '?');
    const again = await ensureDropKeys(keyIo(sec.run));
    expect(again).toEqual({ ...(first as DropKeys), created: false });
  });

  it('is not believed when the store kept nothing', async () => {
    const run: SecretRunner = async () => ({ code: 0, stdout: '', stderr: '' });
    expect(await ensureDropKeys(keyIo(run))).toBeNull();
  });
});

describe('the prod pass', () => {
  it('makes the key, writes the public half, and says once what is missing', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'token-drop-'));
    const sec = fakeSecurity();
    const logs: string[] = [];
    const said = new Set<string>();
    const opts = { dataDir, env: {}, log: (l: string) => logs.push(l), run: sec.run };
    await tokenDropPass(opts, said);
    await tokenDropPass(opts, said);
    const pub = readFileSync(join(dataDir, 'token-drop.pub'), 'utf8').trim();
    expect(pub).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(logs.filter((l) => l.startsWith('not pulling'))).toHaveLength(1);
    expect(logs.join('\n')).not.toContain(sec.items.get(PRIVATE_KEY_SERVICE) ?? '?');
  });

  it('reads the bucket key and account from the secret store', async () => {
    const enc = (v: string) => Buffer.from(v).toString('base64');
    const sec = fakeSecurity(
      new Map([
        [
          'claude-workspaces-secret.cloudflare-r2-tfstate',
          enc('{"accessKeyId":"k","secretAccessKey":"s"}'),
        ],
        ['claude-workspaces-secret.cloudflare-account-id', enc('a'.repeat(32))],
      ]),
    );
    expect(await bucketConfig(sec.run, {})).toEqual({
      ok: true,
      endpoint: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`,
      bucket: 'claude-workspaces-tfstate',
      accessKeyId: 'k',
      secretAccessKey: 's',
    });
  });

  it('stores a drop end to end through the fake Keychain and bucket', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'token-drop-'));
    const s = tokenServices(NAME);
    const enc = (v: string) => Buffer.from(v).toString('base64');
    const sec = fakeSecurity(
      new Map([
        [
          'claude-workspaces-secret.cloudflare-r2-tfstate',
          enc('{"accessKeyId":"k","secretAccessKey":"s"}'),
        ],
        [s.clientId, CLIENT],
        [s.secret, OLD_SECRET],
      ]),
    );
    const keys = await ensureDropKeys(keyIo(sec.run));
    const objects: Record<string, string> = { [dropKey(NAME)]: drop(keys as DropKeys) };
    const s3 = {
      list: async ({ prefix }: { prefix: string }) => ({
        contents: Object.keys(objects)
          .filter((o) => o.startsWith(prefix))
          .map((key) => ({ key })),
      }),
      file: (key: string) => ({
        exists: async () => key in objects,
        text: async () => objects[key] ?? '',
      }),
    } as unknown as Bun.S3Client;
    const logs: string[] = [];
    await tokenDropPass(
      {
        dataDir,
        env: { CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32) },
        log: (l) => logs.push(l),
        run: sec.run,
        s3: () => s3,
      },
      new Set(),
    );
    expect(sec.items.get(s.secret)).toBe(NEW_SECRET);
    expect(logs).toContain(`"${NAME}": stored the new pair`);
    expect(logs.join('\n')).not.toContain(NEW_SECRET);
    const record = join(dataDir, 'token-drop-applied.json');
    expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({ [NAME]: AT });
    expect(statSync(record).mode & 0o777).toBe(0o600);
  });
});
