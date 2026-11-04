/**
 * `lead-key-check.ts` (security review L4): before the deploy hands a lead
 * its deploy key, GitHub must list that key read-only on a repo the lead
 * works in. GitHub is a stub here; the key is a real one `ssh-keygen` makes,
 * so the public half read out of it is checked against ssh-keygen's own.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertLeadKeyReadOnly,
  publicHalf,
} from '../../../infra/project-machine/lead-key-check.ts';
import type { RepoKeys } from '../../../infra/project-machine/wall-drift.ts';

const dir = mkdtempSync(join(tmpdir(), 'lead-key-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeKey(name: string): { pem: string; pub: string } {
  const path = join(dir, name);
  const made = spawnSync('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-C',
    'riverbend',
    '-f',
    path,
  ]);
  if (made.status !== 0) throw new Error('ssh-keygen failed');
  const pub = readFileSync(`${path}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
  return { pem: readFileSync(path, 'utf8'), pub };
}

const LEAD = makeKey('lead');
const OTHER = makeKey('other');
const REPO = 'alice/riverbend';

const github =
  (table: Record<string, RepoKeys>) =>
  (repo: string): RepoKeys =>
    table[repo] ?? null;

describe('publicHalf', () => {
  it('reads the same public half out of the private key as ssh-keygen wrote', () => {
    expect(publicHalf(LEAD.pem)).toBe(LEAD.pub);
    expect(publicHalf(OTHER.pem)).not.toBe(LEAD.pub);
  });

  it('refuses a value that is not an OpenSSH private key, without quoting it', () => {
    const bad =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nZml4dHVyZS1yaXZlcmJlbmQ=\n-----END OPENSSH PRIVATE KEY-----';
    expect(() => publicHalf(bad)).toThrow('not an OpenSSH private key');
    expect(() => publicHalf(bad)).not.toThrow('Zml4');
  });
});

describe('assertLeadKeyReadOnly', () => {
  it('passes a key GitHub lists read-only, naming the repo', () => {
    const keys = github({ [REPO]: [{ key: `${LEAD.pub} lead@riverbend`, read_only: true }] });
    expect(assertLeadKeyReadOnly(LEAD.pem, [REPO], keys)).toBe(REPO);
  });

  it('refuses the same key when GitHub lets it write', () => {
    const keys = github({ [REPO]: [{ key: LEAD.pub, read_only: false }] });
    expect(() => assertLeadKeyReadOnly(LEAD.pem, [REPO], keys)).toThrow(`can write to ${REPO}`);
  });

  it('refuses a key on none of the repos, and says which it could not read', () => {
    const keys = github({ [REPO]: [{ key: OTHER.pub, read_only: true }] });
    expect(() => assertLeadKeyReadOnly(LEAD.pem, [REPO, 'alice/saltmarsh'], keys)).toThrow(
      'not on alice/riverbend, alice/saltmarsh (could not read alice/saltmarsh)',
    );
  });

  it('refuses when no repo was named to look on', () => {
    expect(() => assertLeadKeyReadOnly(LEAD.pem, [], github({}))).toThrow('--lead-repo');
  });

  it('never puts any part of the key in a refusal', () => {
    const keys = github({ [REPO]: [{ key: LEAD.pub, read_only: false }] });
    const err = (() => {
      try {
        assertLeadKeyReadOnly(LEAD.pem, [REPO], keys);
      } catch (e) {
        return String(e);
      }
      return '';
    })();
    expect(err).not.toContain(LEAD.pub.split(' ')[1]?.slice(0, 16) ?? 'x');
  });
});
