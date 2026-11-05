/**
 * The deploy refuses to give a lead a deploy key GitHub would let write.
 *
 * Security review L4: `lead.sh` calls the lead's key read-only, and nothing
 * checked it. A writable key would let the lead push around the server's push
 * path and its rules (`git-push/policy.ts`). So before `machine:deploy` sets
 * CW_LEAD_GITHUB_DEPLOY_KEY it asks GitHub, through `gh api
 * repos/<repo>/keys`, for the deploy keys of the repos the lead works in
 * (`--lead-repo`, and the `--push-repo`s), finds the one whose public half
 * matches, and refuses unless GitHub lists it `read_only`. A key on no listed
 * repo, a repo it cannot read and no repo at all are refusals too: the check
 * fails closed. The daily wall check asks the same question of the key a
 * machine already holds (`deployKeyRows`, `wall-drift.ts`).
 *
 * The public half is read out of the private key's own file format, so the
 * private key goes to no other process and no file. Errors name the repo and
 * the verdict, never any part of the key.
 */
import { spawnSync } from 'node:child_process';
import type { RepoKeys } from './wall-drift.ts';

/** `<type> <base64>`, the public half of an OpenSSH private key, unencrypted or not. */
export function publicHalf(pem: string): string {
  const body = pem.replace(/-----(BEGIN|END) OPENSSH PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const buf = Buffer.from(body, 'base64');
  const MAGIC = 'openssh-key-v1\0';
  if (buf.subarray(0, MAGIC.length).toString('latin1') !== MAGIC) throw notAKey();
  let at = MAGIC.length;
  const field = (): Buffer => {
    if (at + 4 > buf.length) throw notAKey();
    const len = buf.readUInt32BE(at);
    at += 4;
    if (at + len > buf.length) throw notAKey();
    const out = buf.subarray(at, at + len);
    at += len;
    return out;
  };
  field(); // cipher
  field(); // kdf
  field(); // kdf options
  if (at + 4 > buf.length || buf.readUInt32BE(at) < 1) throw notAKey();
  at += 4;
  const blob = field();
  const typeLen = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
  const type = blob.subarray(4, 4 + typeLen).toString('latin1');
  if (!/^[a-z0-9@.-]+$/.test(type)) throw notAKey();
  return `${type} ${blob.toString('base64')}`;
}

function notAKey(): Error {
  return new Error('the lead deploy key is not an OpenSSH private key');
}

/** GitHub's deploy keys for a repo through `gh`, or null when they cannot be read. */
export function ghRepoKeys(repo: string): RepoKeys {
  const r = spawnSync('gh', ['api', `repos/${repo}/keys`], {
    encoding: 'utf8',
    // The PATH this process has now; Bun's spawnSync would use the one it started with.
    env: process.env,
  });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout) as RepoKeys;
  } catch {
    return null;
  }
}

/**
 * The repo GitHub lists the key on read-only, or a refusal. `repos` is where
 * to look; the first repo listing the key decides.
 */
export function assertLeadKeyReadOnly(
  pem: string,
  repos: readonly string[],
  repoKeys: (repo: string) => RepoKeys = ghRepoKeys,
): string {
  if (repos.length === 0) {
    throw new Error(
      'name the repo the lead deploy key is registered on (--lead-repo owner/name), so the deploy can check GitHub lists it read-only',
    );
  }
  const want = publicHalf(pem);
  const unread: string[] = [];
  for (const repo of repos) {
    const keys = repoKeys(repo);
    if (keys === null) {
      unread.push(repo);
      continue;
    }
    const hit = keys.find((k) => k.key.trim().split(/\s+/).slice(0, 2).join(' ') === want);
    if (!hit) continue;
    if (!hit.read_only) {
      throw new Error(
        `the lead deploy key can write to ${repo}; GitHub must list it read-only (review L4). Replace it with a read-only key`,
      );
    }
    return repo;
  }
  throw new Error(
    `the lead deploy key is not on ${repos.join(', ')}${unread.length ? ` (could not read ${unread.join(', ')})` : ''}, so the deploy cannot check it is read-only`,
  );
}
