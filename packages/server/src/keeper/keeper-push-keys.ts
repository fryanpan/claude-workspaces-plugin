/**
 * A project server's push credential: one write deploy key per repo, made
 * by the keeper during project setup.
 *
 * For each repo the keeper makes a new ed25519 key pair, registers the
 * public half on that repo (`POST /repos/{owner}/{repo}/keys`, `read_only`
 * false) with the GitHub token it holds, and then sets the Fly secret
 * `CW_GITHUB_PUSH_KEYS` on the project's app with the private halves, in
 * the form the server's push path reads (`git-push/credential.ts`). The
 * private halves go to that secret and nowhere else: not to GitHub, not to
 * the requester's answer, not to a log line, not to disk (`ed25519Pair`
 * makes each pair in memory). A deploy key
 * reaches one repo, so the machine can push to the repos listed here and
 * nothing else the token's account can reach, and the machine never holds
 * the token.
 *
 * It is always a passkey tap (`token.move`), never covered by a setup grant:
 * the repos are the requester's words, and a write key is a way into each
 * one. The approval page lists them. Only an app the keeper made or adopted
 * may get keys.
 *
 * If a key cannot be registered, or the secret cannot be set, every key this
 * run registered is deleted again, so a failed run leaves no write key on
 * GitHub that nothing holds. Once the secret is set, older keys this keeper
 * gave the same app (the same title) are deleted from each repo: the
 * machine's previous secret, which held them, is gone.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { PUSH_KEYS_ENV, encodePushKeys } from '../git-push/credential.ts';
import { isRepoName } from '../git-push/policy.ts';
import type { Verdict } from './keeper-policy.ts';
import { APP_NAME } from './keeper-store.ts';

export interface PushKeysCall {
  type: 'push-keys';
  app: string;
  repos: string[];
}

/** One call to GitHub's REST API, under `https://api.github.com`. */
export type GithubApi = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: string }>;

export interface KeyPair {
  /** OpenSSH private key text. */
  privateKey: string;
  /** `ssh-ed25519 <base64> <comment>`. */
  publicKey: string;
}

export interface PushKeysDeps {
  github: GithubApi;
  keygen: (comment: string) => Promise<KeyPair>;
  fly: (args: string[], input: string | undefined) => Promise<{ status: number; stderr: string }>;
}

export const MAX_PUSH_REPOS = 20;

/** The title every key for `app` carries on GitHub, so a later run finds its own. */
export function pushKeyTitle(app: string): string {
  return `${app} push (claude-workspaces keeper)`;
}

/** Hold for a tap, or refuse: never routine, never covered by a grant. */
export function classifyPushKeys(app: unknown, repos: unknown, apps: readonly string[]): Verdict {
  if (typeof app !== 'string' || !APP_NAME.test(app)) {
    return { kind: 'refused', reason: 'app must be a Fly app name' };
  }
  if (!apps.includes(app)) {
    return { kind: 'refused', reason: `${app} is not an app the keeper made or adopted` };
  }
  if (!Array.isArray(repos) || repos.length === 0 || repos.length > MAX_PUSH_REPOS) {
    return { kind: 'refused', reason: `repos must list 1-${MAX_PUSH_REPOS} owner/name repos` };
  }
  const seen = new Set<string>();
  for (const r of repos) {
    if (typeof r !== 'string' || !isRepoName(r)) {
      return { kind: 'refused', reason: 'every repo must be owner/name' };
    }
    if (seen.has(r.toLowerCase())) return { kind: 'refused', reason: `${r} is listed twice` };
    seen.add(r.toLowerCase());
  }
  return {
    kind: 'held',
    hold: 'token.move',
    app,
    summary: `make a write deploy key on ${repos.join(', ')} and set ${PUSH_KEYS_ENV} on ${app}`,
  };
}

interface Made {
  repo: string;
  id: number;
  publicKey: string;
}

function keyId(body: string): number | null {
  try {
    const id = (JSON.parse(body) as { id?: unknown }).id;
    return typeof id === 'number' && Number.isSafeInteger(id) ? id : null;
  } catch {
    return null;
  }
}

/** What GitHub or fly said, short, with no value of ours in it. */
function why(text: string): string {
  try {
    const m = (JSON.parse(text) as { message?: unknown }).message;
    if (typeof m === 'string') return m.slice(0, 200);
  } catch {}
  return text.trim().split('\n').slice(-1)[0]?.slice(0, 200) ?? '';
}

/**
 * Make, register and hand over the keys. The answer is JSON in the shape of
 * a Cloudflare result (`{status, body}`), so the keeper's request path
 * carries it unchanged; its body names each repo's key id and public half.
 */
export async function makePushKeys(
  deps: PushKeysDeps,
  app: string,
  repos: readonly string[],
): Promise<{ status: number; body: string }> {
  const title = pushKeyTitle(app);
  const made: Made[] = [];
  const privates = new Map<string, string>();
  const undo = async () => {
    for (const m of made) await deps.github('DELETE', `/repos/${m.repo}/keys/${m.id}`);
  };
  const fail = async (status: number, error: string) => {
    await undo();
    return {
      status,
      body: JSON.stringify({ error, removed: made.map((m) => `${m.repo}#${m.id}`) }),
    };
  };
  try {
    for (const repo of repos) {
      const pair = await deps.keygen(title);
      const res = await deps.github('POST', `/repos/${repo}/keys`, {
        title,
        key: pair.publicKey,
        read_only: false,
      });
      const id = res.status === 201 ? keyId(res.body) : null;
      if (id === null) {
        return await fail(
          502,
          `GitHub did not add a deploy key to ${repo}: ${res.status} ${why(res.body)}`,
        );
      }
      made.push({ repo, id, publicKey: pair.publicKey });
      privates.set(repo, pair.privateKey);
    }
    // Staged: the deploy that follows starts the machine with it.
    const set = await deps.fly(
      ['secrets', 'import', '--app', app, '--stage'],
      `${PUSH_KEYS_ENV}=${encodePushKeys(privates)}\n`,
    );
    if (set.status !== 0) {
      return await fail(502, `fly could not set ${PUSH_KEYS_ENV} on ${app}: ${why(set.stderr)}`);
    }
  } catch (err) {
    return await fail(500, `making the keys failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    privates.clear();
  }
  const retired: string[] = [];
  for (const m of made) {
    const list = await deps.github('GET', `/repos/${m.repo}/keys?per_page=100`);
    let keys: { id?: unknown; title?: unknown }[] = [];
    try {
      const parsed = JSON.parse(list.body) as unknown;
      if (list.status === 200 && Array.isArray(parsed)) keys = parsed;
    } catch {}
    for (const k of keys) {
      if (k.title !== title || typeof k.id !== 'number' || k.id === m.id) continue;
      const del = await deps.github('DELETE', `/repos/${m.repo}/keys/${k.id}`);
      if (del.status === 204) retired.push(`${m.repo}#${k.id}`);
    }
  }
  return {
    status: 200,
    body: JSON.stringify({
      secret: PUSH_KEYS_ENV,
      app,
      keys: made.map((m) => ({ repo: m.repo, id: m.id, publicKey: m.publicKey })),
      retired,
    }),
  };
}

/** One SSH wire-format string: a uint32 length, then the bytes. */
function sshString(b: Uint8Array | string): Buffer {
  const bytes = typeof b === 'string' ? Buffer.from(b) : Buffer.from(b);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length);
  return Buffer.concat([len, bytes]);
}

/**
 * A new ed25519 pair, made in memory and written in OpenSSH's own format,
 * so the private half never touches a disk. The format is OpenSSH's
 * PROTOCOL.key, unencrypted: one key, its check words, and padding to the
 * cipher's 8-byte block.
 */
export function ed25519Pair(comment: string): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const seed = Buffer.from(jwk.d ?? '', 'base64url');
  const pub = Buffer.from(
    (publicKey.export({ format: 'jwk' }) as { x?: string }).x ?? '',
    'base64url',
  );
  if (seed.length !== 32 || pub.length !== 32) throw new Error('ed25519 key of the wrong size');
  const type = 'ssh-ed25519';
  const wirePub = Buffer.concat([sshString(type), sshString(pub)]);
  const check = randomBytes(4);
  let inner = Buffer.concat([
    check,
    check,
    sshString(type),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(comment),
  ]);
  const pad = (8 - (inner.length % 8)) % 8;
  inner = Buffer.concat([inner, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(1);
  const blob = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    count,
    sshString(wirePub),
    sshString(inner),
  ]);
  const lines = blob.toString('base64').match(/.{1,70}/g) ?? [];
  seed.fill(0);
  inner.fill(0);
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `${type} ${wirePub.toString('base64')} ${comment}`,
  };
}
