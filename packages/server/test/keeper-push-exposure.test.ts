/**
 * What a workflow pushed with a repo's new write deploy key could read
 * (`keeper/keeper-push-exposure.ts`), that the keeper's push-key answer
 * carries it (`keeper/keeper-push-keys.ts`), and that the keeper's GitHub
 * calls give up on a hung request (`keeper/keeper-exec.ts`).
 *
 * GitHub is an in-memory stand-in that records every call; no request leaves
 * the machine. Its secrets carry a value only so the test can show the value
 * never reaches the answer.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keeperExecutors } from '../src/keeper/keeper-exec.ts';
import {
  type RepoExposure,
  exposureLines,
  repoExposure,
} from '../src/keeper/keeper-push-exposure.ts';
import { type GithubApi, ed25519Pair, makePushKeys } from '../src/keeper/keeper-push-keys.ts';
import { openKeeperStore } from '../src/keeper/keeper-store.ts';
import type { GuardedFetch } from '../src/outbound-fetch.ts';

type Answer = { status: number; body: unknown };

interface FakeRepo {
  defaultBranch?: string;
  /** Name -> value. The real API never returns a value; the fake holds one to prove we never ask. */
  secrets?: Record<string, string>;
  /** Overrides total_count on the repository secrets page. */
  secretsTotal?: number;
  /** Replaces the repository secrets answer. */
  secretsAnswer?: Answer;
  orgSecrets?: string[];
  environments?: {
    name: string;
    deployment_branch_policy?: unknown;
    protection_rules?: { type: string }[];
    secrets?: string[];
  }[];
  /** Classic protection: a body for 200, or a full answer; absent is 404 "Branch not protected". */
  protection?: Record<string, unknown> | Answer;
  /** Active rules on the default branch, or a full answer. */
  rules?: { type: string; ruleset_id?: number }[] | Answer;
  /** Ruleset id -> its bypass actors (undefined: the field is left out), or a full answer. */
  rulesets?: Record<number, { actor_type: string }[] | undefined | Answer>;
  /** Answer 403 to every read under the repo except its keys. */
  forbidden?: boolean;
  /** Throw on any read under the repo except its keys. */
  throws?: boolean;
}

const isAnswer = (x: unknown): x is Answer =>
  typeof x === 'object' && x !== null && 'status' in x && 'body' in x;
const send = (a: Answer) => ({
  status: a.status,
  body: typeof a.body === 'string' ? a.body : JSON.stringify(a.body),
});
const ok = (body: unknown) => send({ status: 200, body });

function fakeGithub(repos: Record<string, FakeRepo>) {
  const calls: { method: string; path: string }[] = [];
  let next = 500;
  const api: GithubApi = async (method, path) => {
    calls.push({ method, path });
    const m = /^\/repos\/([^/]+\/[^/?]+)(\/[^?]*)?/.exec(path);
    const repo = repos[m?.[1] ?? ''];
    const rest = m?.[2] ?? '';
    if (!repo) return { status: 404, body: '{"message":"Not Found"}' };
    if (method === 'POST' && rest === '/keys') return send({ status: 201, body: { id: next++ } });
    if (method !== 'GET') return { status: 204, body: '' };
    if (rest === '/keys') return ok([]);
    if (repo.throws) throw new Error('socket hang up');
    if (repo.forbidden) return send({ status: 403, body: { message: 'Must have admin rights' } });
    if (rest === '') return ok({ default_branch: repo.defaultBranch ?? 'main' });
    if (rest === '/actions/secrets') {
      if (repo.secretsAnswer) return send(repo.secretsAnswer);
      const secrets = Object.entries(repo.secrets ?? {}).map(([name, value]) => ({ name, value }));
      return ok({ total_count: repo.secretsTotal ?? secrets.length, secrets });
    }
    if (rest === '/actions/organization-secrets') {
      const secrets = (repo.orgSecrets ?? []).map((name) => ({ name }));
      return ok({ total_count: secrets.length, secrets });
    }
    if (rest === '/environments') {
      const environments = repo.environments ?? [];
      return ok({ total_count: environments.length, environments });
    }
    const env = /^\/environments\/([^/]+)\/secrets$/.exec(rest);
    if (env) {
      const e = repo.environments?.find((x) => x.name === decodeURIComponent(env[1] ?? ''));
      const secrets = (e?.secrets ?? []).map((name) => ({ name }));
      return ok({ total_count: secrets.length, secrets });
    }
    if (rest.endsWith('/protection')) {
      if (isAnswer(repo.protection)) return send(repo.protection);
      return repo.protection
        ? ok(repo.protection)
        : send({ status: 404, body: { message: 'Branch not protected' } });
    }
    if (rest.startsWith('/rules/branches/'))
      return isAnswer(repo.rules) ? send(repo.rules) : ok(repo.rules ?? []);
    const rs = /^\/rulesets\/(\d+)$/.exec(rest);
    if (rs) {
      const id = Number(rs[1]);
      if (!repo.rulesets || !(id in repo.rulesets)) return send({ status: 404, body: {} });
      const v = repo.rulesets[id];
      if (isAnswer(v)) return send(v);
      return ok(v === undefined ? { id } : { id, bypass_actors: v });
    }
    return send({ status: 404, body: { message: 'Not Found' } });
  };
  return { api, calls };
}

const SECRET_VALUE = 'harborlight-value-never-shown';
const protectedOf = async (repo: FakeRepo) =>
  (await repoExposure(fakeGithub({ 'Riverbend/app': repo }).api, 'Riverbend/app'))
    .defaultBranchProtected;

describe('the secrets a side-branch workflow could read', () => {
  it('names repository, organization and open-environment secrets, by name only', async () => {
    const gh = fakeGithub({
      'Harborlight/app': {
        secrets: { FLY_API_TOKEN: SECRET_VALUE, NPM_TOKEN: SECRET_VALUE },
        orgSecrets: ['ORG_DEPLOY'],
        environments: [
          { name: 'preview', secrets: ['PREVIEW_KEY'] },
          {
            name: 'production',
            deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
            secrets: ['PROD_KEY'],
          },
          { name: 'staging', protection_rules: [{ type: 'required_reviewers' }], secrets: ['S'] },
        ],
      },
    });
    const r = await repoExposure(gh.api, 'Harborlight/app');
    expect(r).toEqual({
      repo: 'Harborlight/app',
      defaultBranch: 'main',
      defaultBranchProtected: false,
      repoSecrets: { items: ['FLY_API_TOKEN', 'NPM_TOKEN'], complete: true },
      orgSecrets: { items: ['ORG_DEPLOY'], complete: true },
      // Only the environment with no branch policy and no reviewers is open.
      openEnvironments: {
        items: [{ environment: 'preview', secrets: { items: ['PREVIEW_KEY'], complete: true } }],
        complete: true,
      },
    });
    expect(JSON.stringify(r)).not.toContain(SECRET_VALUE);
    expect(gh.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(exposureLines([r])).toEqual([
      'Harborlight/app: a workflow on any branch can read FLY_API_TOKEN, NPM_TOKEN (repository secrets)',
      'Harborlight/app: a workflow on any branch can read ORG_DEPLOY (organization secrets)',
      'Harborlight/app: a workflow on any branch can deploy to environment preview and read PREVIEW_KEY (environment preview secrets)',
      'Harborlight/app: default branch main does not refuse the deploy key, so it can push a workflow there and reach every secret, environment ones too',
    ]);
  });

  it('says a list is incomplete when GitHub has more than one page', async () => {
    const gh = fakeGithub({
      'Harborlight/app': { secrets: { A: SECRET_VALUE }, secretsTotal: 140 },
    });
    const r = await repoExposure(gh.api, 'Harborlight/app');
    expect(r.repoSecrets).toEqual({ items: ['A'], complete: false });
    expect(exposureLines([r])).toContain(
      'Harborlight/app: GitHub lists more repository secrets than one page; the list above is incomplete',
    );
  });

  it('says it could not read, never "none", when a read fails or answers nonsense', async () => {
    const refused = await repoExposure(
      fakeGithub({ 'Saltmarsh/app': { forbidden: true } }).api,
      'Saltmarsh/app',
    );
    expect(refused).toMatchObject({
      defaultBranchProtected: null,
      repoSecrets: null,
      orgSecrets: null,
      openEnvironments: null,
    });
    expect(exposureLines([refused])).toEqual([
      'Saltmarsh/app: could not read the names of its repository secrets',
      'Saltmarsh/app: could not read the names of its organization secrets',
      'Saltmarsh/app: could not read its environments',
      'Saltmarsh/app: could not read whether its default branch refuses the deploy key',
    ]);
    const malformed = await repoExposure(
      fakeGithub({ 'Saltmarsh/app': { secretsAnswer: { status: 200, body: 'not json' } } }).api,
      'Saltmarsh/app',
    );
    expect(malformed.repoSecrets).toBeNull();
    // Positive control for the same reads: an open, empty repo reads as empty, not null.
    const open = await repoExposure(fakeGithub({ 'Saltmarsh/app': {} }).api, 'Saltmarsh/app');
    expect(open).toMatchObject({
      defaultBranchProtected: false,
      repoSecrets: { items: [], complete: true },
      orgSecrets: { items: [], complete: true },
      openEnvironments: { items: [], complete: true },
    });
    expect(exposureLines([open])).toEqual([
      'Saltmarsh/app: no secret a side-branch workflow can read',
      'Saltmarsh/app: default branch main does not refuse the deploy key, so it can push a workflow there and reach every secret, environment ones too',
    ]);
  });

  it('prints "could not read" for an entry missing its parts, rather than throwing', () => {
    expect(exposureLines([{ repo: 'Riverbend/app' }, null])).toEqual([
      'Riverbend/app: could not read the names of its repository secrets',
      'Riverbend/app: could not read the names of its organization secrets',
      'Riverbend/app: could not read its environments',
      'Riverbend/app: could not read whether its default branch refuses the deploy key',
      'a repo: could not read the names of its repository secrets',
      'a repo: could not read the names of its organization secrets',
      'a repo: could not read its environments',
      'a repo: could not read whether its default branch refuses the deploy key',
    ]);
  });
});

describe('whether the default branch refuses the deploy key', () => {
  it('counts classic protection that requires a pull request, restricts pushers or locks the branch', async () => {
    expect(await protectedOf({ protection: { required_pull_request_reviews: {} } })).toBe(true);
    expect(await protectedOf({ protection: { restrictions: { users: [] } } })).toBe(true);
    expect(await protectedOf({ protection: { lock_branch: { enabled: true } } })).toBe(true);
    // Status checks alone do not stop a direct push.
    expect(await protectedOf({ protection: { required_status_checks: { strict: true } } })).toBe(
      false,
    );
  });

  it('counts a pull_request or update ruleset rule only when deploy keys may not bypass it', async () => {
    const holds = { 1: [{ actor_type: 'OrganizationAdmin' }] };
    expect(
      await protectedOf({ rules: [{ type: 'pull_request', ruleset_id: 1 }], rulesets: holds }),
    ).toBe(true);
    expect(await protectedOf({ rules: [{ type: 'update', ruleset_id: 1 }], rulesets: holds })).toBe(
      true,
    );
    // Classic protection that does not block, plus a ruleset that does.
    expect(
      await protectedOf({
        protection: { required_status_checks: { strict: true } },
        rules: [{ type: 'pull_request', ruleset_id: 1 }],
        rulesets: holds,
      }),
    ).toBe(true);
    // Deploy keys on the bypass list: the rule does not stop the key.
    expect(
      await protectedOf({
        rules: [{ type: 'pull_request', ruleset_id: 2 }],
        rulesets: { 2: [{ actor_type: 'DeployKey' }] },
      }),
    ).toBe(false);
    // A rule that does not stop a push counts for nothing.
    expect(
      await protectedOf({
        rules: [{ type: 'required_signatures', ruleset_id: 1 }],
        rulesets: holds,
      }),
    ).toBe(false);
  });

  it('is null when protection, the rules or a ruleset’s bypass list cannot be read', async () => {
    expect(
      await protectedOf({ protection: { status: 403, body: { message: 'Forbidden' } } }),
    ).toBeNull();
    expect(await protectedOf({ rules: { status: 500, body: {} } })).toBeNull();
    expect(
      await protectedOf({
        rules: [{ type: 'pull_request', ruleset_id: 3 }],
        rulesets: { 3: undefined },
      }),
    ).toBeNull();
    expect(
      await protectedOf({
        rules: [{ type: 'pull_request', ruleset_id: 3 }],
        rulesets: { 3: { status: 403, body: {} } },
      }),
    ).toBeNull();
    // But one ruleset that holds is enough, whatever another says.
    expect(
      await protectedOf({
        rules: [
          { type: 'pull_request', ruleset_id: 3 },
          { type: 'update', ruleset_id: 4 },
        ],
        rulesets: { 3: undefined, 4: [] },
      }),
    ).toBe(true);
  });
});

describe('the keeper’s push-key answer', () => {
  const deps = (github: GithubApi) => ({
    github,
    keygen: async (c: string) => ed25519Pair(c),
    fly: async () => ({ status: 0, stderr: '' }),
  });

  it('carries each repo’s report, names only, after the keys are in place', async () => {
    const gh = fakeGithub({
      'Harborlight/app': { secrets: { DEPLOY_TOKEN: SECRET_VALUE } },
      'Harborlight/notes': { protection: { restrictions: { users: [] } } },
    });
    const r = await makePushKeys(deps(gh.api), 'cw-harborlight', [
      'Harborlight/app',
      'Harborlight/notes',
    ]);
    expect(r.status, r.body).toBe(200);
    expect(r.body).not.toContain(SECRET_VALUE);
    const exposure = (JSON.parse(r.body) as { exposure: RepoExposure[] }).exposure;
    expect(exposure.map((e) => [e.repo, e.repoSecrets?.items, e.defaultBranchProtected])).toEqual([
      ['Harborlight/app', ['DEPLOY_TOKEN'], false],
      ['Harborlight/notes', [], true],
    ]);
  });

  it('keeps the keys and reports "unread" when a read throws', async () => {
    const gh = fakeGithub({ 'Harborlight/app': { throws: true } });
    const r = await makePushKeys(deps(gh.api), 'cw-harborlight', ['Harborlight/app']);
    expect(r.status, r.body).toBe(200);
    const body = JSON.parse(r.body) as { keys: unknown[]; exposure: RepoExposure[] };
    expect(body.keys).toHaveLength(1);
    expect(gh.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(body.exposure).toEqual([
      {
        repo: 'Harborlight/app',
        defaultBranch: null,
        defaultBranchProtected: null,
        repoSecrets: null,
        orgSecrets: null,
        openEnvironments: null,
      },
    ]);
  });
});

describe('the keeper’s GitHub calls', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'keeper-gh-timeout-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('give up on a call GitHub never answers', async () => {
    const dir = join(tmp, 'store');
    mkdirSync(dir, { mode: 0o700 });
    const store = openKeeperStore(dir);
    if ('error' in store) throw new Error(store.error);
    store.setCredential('github-token', 'riverbend-test-token');
    let aborted = false;
    // Answers only when aborted, as a hung connection would.
    const hang = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(init.signal?.reason);
        });
      })) as unknown as GuardedFetch;
    const exec = keeperExecutors({
      store,
      flyBin: '/bin/false',
      home: tmp,
      fetch: hang,
      githubTimeoutMs: 20,
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    // A deadline, not a wait: without the keeper's own timeout the call never settles.
    const outcome = await Promise.race([
      exec.github?.('GET', '/repos/Riverbend/app').then(
        () => 'answered',
        () => 'abandoned',
      ),
      new Promise((resolve) => {
        deadline = setTimeout(() => resolve('hung'), 5_000);
      }),
    ]);
    clearTimeout(deadline);
    expect(outcome).toBe('abandoned');
    expect(aborted).toBe(true);
  });
});
