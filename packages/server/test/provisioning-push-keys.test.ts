/**
 * A project's push credential: one write deploy key per repo
 * (`provisioning/push-keys.ts`), which `fly-provision.yml` makes.
 *
 * GitHub is a stand-in that records every call; no request leaves the
 * machine. The key pairs are real ones from `ssh-keygen`, so the test can
 * say where each private half went: into the Fly secret, in the form the
 * server's push path reads (`git-push/credential.ts`), and nowhere else.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PUSH_KEYS_ENV, pushCredentialFor } from '../src/git-push/credential.ts';
import {
  type GithubApi,
  type KeyPair,
  ed25519Pair,
  makePushKeys,
  pushKeyTitle,
} from '../src/provisioning/push-keys.ts';

const tmp = mkdtempSync(join(tmpdir(), 'provisioning-push-keys-'));
const APP = 'cw-harborlight';
const REPOS = ['Harborlight/notes', 'Harborlight/app'];

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** GitHub's deploy-key endpoints, in memory. `failPostOn` answers 422 for that repo. */
function fakeGithub(opts: { failPostOn?: string; existing?: Record<string, unknown[]> } = {}) {
  const calls: Call[] = [];
  let next = 100;
  const api: GithubApi = async (method, path, body) => {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    const repo = /^\/repos\/([^/]+\/[^/]+)\/keys/.exec(path)?.[1] ?? '';
    if (method === 'POST') {
      if (repo === opts.failPostOn)
        return { status: 422, body: '{"message":"key is already in use"}' };
      return { status: 201, body: JSON.stringify({ id: next++, read_only: false }) };
    }
    if (method === 'GET') return { status: 200, body: JSON.stringify(opts.existing?.[repo] ?? []) };
    if (method === 'DELETE') return { status: 204, body: '' };
    return { status: 404, body: '' };
  };
  return { api, calls };
}

function recordingKeygen() {
  const pairs: KeyPair[] = [];
  return {
    pairs,
    keygen: async (comment: string) => {
      const p = ed25519Pair(comment);
      pairs.push(p);
      return p;
    },
  };
}

function recordingFly(status = 0) {
  const calls: { args: string[]; input: string | undefined }[] = [];
  return {
    calls,
    fly: async (args: string[], input: string | undefined) => {
      calls.push({ args, input });
      return { status, stderr: status ? 'Error: app not found' : '' };
    },
  };
}

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('making a project’s push keys', () => {
  it('registers one write key per repo and gives only the private halves to the push path', async () => {
    const gh = fakeGithub({
      existing: {
        'Harborlight/notes': [
          { id: 7, title: pushKeyTitle(APP) },
          { id: 8, title: 'someone else’s key' },
        ],
      },
    });
    const kg = recordingKeygen();
    const fly = recordingFly();
    const r = await makePushKeys({ github: gh.api, keygen: kg.keygen, fly: fly.fly }, APP, REPOS);
    expect(r.status, r.body).toBe(200);

    // One key pair, and one registration of its PUBLIC half, per repo.
    expect(kg.pairs).toHaveLength(2);
    const posts = gh.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.path)).toEqual([
      '/repos/Harborlight/notes/keys',
      '/repos/Harborlight/app/keys',
    ]);
    posts.forEach((c, i) => {
      expect(c.body).toEqual({
        title: pushKeyTitle(APP),
        key: kg.pairs[i]?.publicKey,
        read_only: false,
      });
    });

    // The private halves went to the app's Fly secret, once, in the form the
    // server's push path reads: each repo answers with its own key.
    expect(fly.calls).toHaveLength(1);
    expect(fly.calls[0]?.args).toEqual(['secrets', 'import', '--app', APP, '--stage']);
    const line = fly.calls[0]?.input ?? '';
    expect(line.startsWith(`${PUSH_KEYS_ENV}=`)).toBe(true);
    const cred = pushCredentialFor({
      FLY_APP_NAME: APP,
      [PUSH_KEYS_ENV]: line.slice(PUSH_KEYS_ENV.length + 1).trim(),
    });
    expect(await cred('Harborlight/notes')).toEqual({
      kind: 'ssh-key',
      key: kg.pairs[0]?.privateKey,
    });
    expect(await cred('Harborlight/app')).toEqual({
      kind: 'ssh-key',
      key: kg.pairs[1]?.privateKey,
    });
    expect(await cred('Harborlight/other')).toBeNull();

    // And nowhere else: not to GitHub, not in the answer, not left on disk.
    const elsewhere = JSON.stringify(gh.calls) + r.body;
    for (const p of kg.pairs) {
      const body = p.privateKey.split('\n')[1] ?? '';
      expect(body.length).toBeGreaterThan(16);
      expect(elsewhere).not.toContain(body);
    }
    expect(elsewhere).not.toContain('PRIVATE KEY');

    // An older key this workflow made for this app goes; another key on the repo stays.
    const deletes = gh.calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
    expect(deletes).toEqual(['/repos/Harborlight/notes/keys/7']);
    expect(JSON.parse(r.body)).toMatchObject({
      keys: [
        { repo: 'Harborlight/notes', id: 100 },
        { repo: 'Harborlight/app', id: 101 },
      ],
      retired: ['Harborlight/notes#7'],
    });
  });

  it('takes back every key it registered when GitHub refuses one, and sets no secret', async () => {
    const gh = fakeGithub({ failPostOn: 'Harborlight/app' });
    const fly = recordingFly();
    const kg = recordingKeygen();
    const r = await makePushKeys({ github: gh.api, keygen: kg.keygen, fly: fly.fly }, APP, REPOS);
    expect(r.status).toBe(502);
    expect(JSON.parse(r.body).error).toContain('Harborlight/app');
    expect(fly.calls).toEqual([]);
    expect(gh.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
      '/repos/Harborlight/notes/keys/100',
    ]);
  });

  it('takes back every key when fly cannot set the secret', async () => {
    const gh = fakeGithub();
    const kg = recordingKeygen();
    const r = await makePushKeys(
      { github: gh.api, keygen: kg.keygen, fly: recordingFly(1).fly },
      APP,
      REPOS,
    );
    expect(r.status).toBe(502);
    expect(r.body).not.toContain('PRIVATE KEY');
    expect(gh.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
      '/repos/Harborlight/notes/keys/100',
      '/repos/Harborlight/app/keys/101',
    ]);
  });
});

describe('a key pair made in memory', () => {
  it('is a key OpenSSH reads, whose public half is the one sent to GitHub', () => {
    const pair = ed25519Pair(pushKeyTitle(APP));
    const file = join(tmp, 'interop.key');
    writeFileSync(file, pair.privateKey, { mode: 0o600 });
    const r = spawnSync('ssh-keygen', ['-y', '-f', file], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const [type, body] = pair.publicKey.split(' ');
    expect(r.stdout.trim().split(' ').slice(0, 2)).toEqual([type, body]);
    // Two pairs are never the same key.
    expect(ed25519Pair('x').publicKey).not.toBe(ed25519Pair('x').publicKey);
  });
});
