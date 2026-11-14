/**
 * What a workflow pushed with a repo's new write deploy key could read
 * (`keeper/keeper-push-exposure.ts`), and that the keeper's push-key answer
 * carries it (`keeper/keeper-push-keys.ts`).
 *
 * GitHub is an in-memory stand-in that records every call; no request leaves
 * the machine. Its secrets carry a value only so the test can show the value
 * never reaches the answer.
 */
import { describe, expect, it } from 'bun:test';
import {
  type RepoExposure,
  exposureLines,
  repoExposure,
} from '../src/keeper/keeper-push-exposure.ts';
import { type GithubApi, ed25519Pair, makePushKeys } from '../src/keeper/keeper-push-keys.ts';

interface FakeRepo {
  defaultBranch?: string;
  /** Name -> value. The real API never returns a value; the fake holds one to prove we never ask. */
  secrets?: Record<string, string>;
  /** Classic protection body; absent means 404 "Branch not protected". */
  protection?: Record<string, unknown>;
  /** Active ruleset rules on the default branch. */
  rules?: { type: string }[];
  /** Answer 403 to every read under the repo. */
  forbidden?: boolean;
}

function fakeGithub(repos: Record<string, FakeRepo>) {
  const calls: { method: string; path: string }[] = [];
  let next = 500;
  const api: GithubApi = async (method, path) => {
    calls.push({ method, path });
    const m = /^\/repos\/([^/]+\/[^/?]+)(\/[^?]*)?/.exec(path);
    const repo = repos[m?.[1] ?? ''];
    const rest = m?.[2] ?? '';
    if (!repo) return { status: 404, body: '{"message":"Not Found"}' };
    if (method === 'POST' && rest === '/keys')
      return { status: 201, body: JSON.stringify({ id: next++ }) };
    if (method !== 'GET') return { status: 204, body: '' };
    if (repo.forbidden && rest !== '/keys')
      return { status: 403, body: '{"message":"Must have admin rights"}' };
    if (rest === '')
      return {
        status: 200,
        body: JSON.stringify({ default_branch: repo.defaultBranch ?? 'main' }),
      };
    if (rest === '/keys') return { status: 200, body: '[]' };
    if (rest === '/actions/secrets') {
      const secrets = Object.entries(repo.secrets ?? {}).map(([name, value]) => ({ name, value }));
      return { status: 200, body: JSON.stringify({ total_count: secrets.length, secrets }) };
    }
    if (rest.endsWith('/protection'))
      return repo.protection
        ? { status: 200, body: JSON.stringify(repo.protection) }
        : { status: 404, body: '{"message":"Branch not protected"}' };
    if (rest.startsWith('/rules/branches/'))
      return { status: 200, body: JSON.stringify(repo.rules ?? []) };
    return { status: 404, body: '{"message":"Not Found"}' };
  };
  return { api, calls };
}

const SECRET_VALUE = 'harborlight-value-never-shown';

describe('what a workflow pushed with the deploy key could read', () => {
  it('names every repository secret, and an unprotected default branch', async () => {
    const gh = fakeGithub({
      'Harborlight/app': { secrets: { FLY_API_TOKEN: SECRET_VALUE, NPM_TOKEN: SECRET_VALUE } },
    });
    const r = await repoExposure(gh.api, 'Harborlight/app');
    expect(r).toEqual({
      repo: 'Harborlight/app',
      defaultBranch: 'main',
      defaultBranchProtected: false,
      repoSecrets: ['FLY_API_TOKEN', 'NPM_TOKEN'],
      sideBranchReadable: ['FLY_API_TOKEN', 'NPM_TOKEN'],
    });
    expect(JSON.stringify(r)).not.toContain(SECRET_VALUE);
    // Reads only.
    expect(gh.calls.every((c) => c.method === 'GET')).toBe(true);
    const lines = exposureLines([r]).join('\n');
    expect(lines).toContain('a workflow on any branch can read FLY_API_TOKEN, NPM_TOKEN');
    expect(lines).toContain('default branch main is not protected');
  });

  it('counts a branch protected by a required pull request or a ruleset, and not one with neither', async () => {
    const gh = fakeGithub({
      'Riverbend/classic': {
        protection: { required_pull_request_reviews: { required_approving_review_count: 1 } },
      },
      'Riverbend/ruleset': { defaultBranch: 'trunk', rules: [{ type: 'pull_request' }] },
      'Riverbend/status-only': {
        protection: { required_status_checks: { strict: true } },
        rules: [{ type: 'required_signatures' }],
      },
    });
    expect((await repoExposure(gh.api, 'Riverbend/classic')).defaultBranchProtected).toBe(true);
    const ruleset = await repoExposure(gh.api, 'Riverbend/ruleset');
    expect(ruleset).toMatchObject({ defaultBranch: 'trunk', defaultBranchProtected: true });
    // Status checks alone do not stop a direct push.
    expect((await repoExposure(gh.api, 'Riverbend/status-only')).defaultBranchProtected).toBe(
      false,
    );
    expect(exposureLines([ruleset])).toEqual(['Riverbend/ruleset: no repository secrets']);
  });

  it('says it could not read, never "none", when GitHub refuses', async () => {
    const gh = fakeGithub({ 'Saltmarsh/app': { forbidden: true } });
    const r = await repoExposure(gh.api, 'Saltmarsh/app');
    expect(r).toMatchObject({ defaultBranchProtected: null, repoSecrets: null });
    // Positive control for the same reads: an open repo reads as empty, not null.
    const open = await repoExposure(fakeGithub({ 'Saltmarsh/app': {} }).api, 'Saltmarsh/app');
    expect(open).toMatchObject({ defaultBranchProtected: false, repoSecrets: [] });
    expect(exposureLines([r])).toEqual([
      'Saltmarsh/app: could not read its Actions secret names',
      'Saltmarsh/app: could not read whether its default branch is protected',
    ]);
  });
});

describe('the keeper’s push-key answer', () => {
  it('carries each repo’s report, names only, after the keys are in place', async () => {
    const gh = fakeGithub({
      'Harborlight/app': { secrets: { DEPLOY_TOKEN: SECRET_VALUE } },
      'Harborlight/notes': { protection: { restrictions: { users: [] } } },
    });
    const r = await makePushKeys(
      {
        github: gh.api,
        keygen: async (c) => ed25519Pair(c),
        fly: async () => ({ status: 0, stderr: '' }),
      },
      'cw-harborlight',
      ['Harborlight/app', 'Harborlight/notes'],
    );
    expect(r.status, r.body).toBe(200);
    expect(r.body).not.toContain(SECRET_VALUE);
    const exposure = (JSON.parse(r.body) as { exposure: RepoExposure[] }).exposure;
    expect(exposure.map((e) => [e.repo, e.sideBranchReadable, e.defaultBranchProtected])).toEqual([
      ['Harborlight/app', ['DEPLOY_TOKEN'], false],
      ['Harborlight/notes', [], true],
    ]);
  });
});
