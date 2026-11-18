/**
 * The daily wall report's rows for CI's Fly tokens and the live Access
 * policies (wall-off review H1, M5 and N1): the judges in `wall-drift.ts`
 * and the GitHub reader in `wall-drift-read.ts`, against stand-ins. Nothing
 * here calls GitHub or Cloudflare.
 */
import { describe, expect, it } from 'bun:test';
import type { StaticVars } from '../../../infra/cloudflare/vars.ts';
import { readGithub } from '../../../infra/project-machine/wall-drift-read.ts';
import {
  type GithubView,
  type LiveAccessApp,
  ciTokenRows,
  liveAccessRows,
} from '../../../infra/project-machine/wall-drift.ts';

const NOW = Date.UTC(2026, 10, 18);
const ENVS = [
  { project: 'riverbend', environment: 'fly-riverbend' },
  { project: '(staging)', environment: 'fly-appkit-staging' },
];
const fresh = { name: 'FLY_DEPLOY_TOKEN', updated_at: '2026-11-01T00:00:00Z' };
const good = (): GithubView => ({
  repoSecrets: ['CF_ROUTER_CONFIG'],
  environments: [
    { name: 'cloudflare-prod', mainOnly: true, secrets: [{ name: 'CLOUDFLARE_API_TOKEN' }] },
    { name: 'fly-riverbend', mainOnly: true, secrets: [fresh] },
    { name: 'fly-appkit-staging', mainOnly: true, secrets: [fresh] },
  ],
});
const failing = (rows: Array<{ check: string; answer: string; ok: boolean }>) =>
  rows.filter((r) => !r.ok).map((r) => `${r.check}: ${r.answer}`);

describe("CI's Fly tokens", () => {
  it('passes when no secret is the org token and each app has its own fresh, main-only token', () => {
    const rows = ciTokenRows(ENVS, good(), NOW);
    expect(failing(rows)).toEqual([]);
    expect(rows.map((r) => r.answer)).toEqual([
      'none',
      'main alone, FLY_DEPLOY_TOKEN 17 day(s) old',
      'main alone, FLY_DEPLOY_TOKEN 17 day(s) old',
    ]);
  });

  it('fails the org token anywhere: an environment or the repository (review M5)', () => {
    const v = good();
    v.environments?.[0]?.secrets?.push({ name: 'FLY_API_TOKEN' });
    v.repoSecrets?.push('FLY_API_TOKEN');
    expect(failing(ciTokenRows(ENVS, v, NOW))).toEqual([
      'no Fly org token in GitHub: FLY_API_TOKEN in the repository, cloudflare-prod',
    ]);
  });

  it('fails what it could not read rather than reading it as clean', () => {
    expect(failing(ciTokenRows(ENVS, { environments: null, repoSecrets: [] }, NOW))).toEqual([
      'no Fly org token in GitHub: not every secret list could be read',
      'fly-riverbend environment: could not be read',
      'fly-appkit-staging environment: could not be read',
    ]);
  });

  it('fails a missing environment, a wider branch rule, a missing token and a stale one', () => {
    const cases: Array<[GithubView['environments'], string]> = [
      [[], 'missing: run bun run fly:ci-tokens apply'],
      [
        [{ name: 'fly-riverbend', mainOnly: false, secrets: [fresh] }],
        'admits a branch other than main',
      ],
      [[{ name: 'fly-riverbend', mainOnly: true, secrets: [] }], 'holds no FLY_DEPLOY_TOKEN'],
      [
        [
          {
            name: 'fly-riverbend',
            mainOnly: true,
            secrets: [{ name: 'FLY_DEPLOY_TOKEN', updated_at: '2026-09-01T00:00:00Z' }],
          },
        ],
        'FLY_DEPLOY_TOKEN is 78 days old; the monthly fly:ci-tokens apply did not run',
      ],
    ];
    for (const [environments, answer] of cases) {
      const rows = ciTokenRows(
        [ENVS[0] as (typeof ENVS)[0]],
        { environments, repoSecrets: [] },
        NOW,
      );
      expect(failing(rows)).toEqual([`fly-riverbend environment: ${answer}`]);
    }
  });
});

describe('the GitHub reader', () => {
  const REPO = 'harborlight/riverbend';
  const answers: Record<string, unknown> = {
    [`repos/${REPO}/environments?per_page=100`]: {
      environments: [
        {
          name: 'fly-riverbend',
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
        },
        {
          name: 'fly-saltmarsh',
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
        },
        { name: 'open', deployment_branch_policy: null },
        { name: 'bad name/..', deployment_branch_policy: null },
      ],
    },
    [`repos/${REPO}/actions/secrets?per_page=100`]: { secrets: [{ name: 'CF_ROUTER_CONFIG' }] },
    [`repos/${REPO}/environments/fly-riverbend/secrets?per_page=100`]: {
      secrets: [{ name: 'FLY_DEPLOY_TOKEN', updated_at: '2026-11-01T00:00:00Z' }],
    },
    [`repos/${REPO}/environments/fly-riverbend/deployment-branch-policies`]: {
      branch_policies: [{ name: 'main', type: 'branch' }],
    },
    [`repos/${REPO}/environments/fly-saltmarsh/secrets?per_page=100`]: { secrets: [] },
    [`repos/${REPO}/environments/fly-saltmarsh/deployment-branch-policies`]: {
      branch_policies: [{ name: 'main' }, { name: 'riverbend/*' }],
    },
    [`repos/${REPO}/environments/open/secrets?per_page=100`]: { secrets: [] },
  };

  it('reads names, times and branch rules, and reports an unreadable name as unread', () => {
    const asked: string[] = [];
    const view = readGithub(REPO, (path) => {
      asked.push(path);
      return answers[path] ?? null;
    });
    expect(view.repoSecrets).toEqual(['CF_ROUTER_CONFIG']);
    expect(view.environments).toEqual([
      {
        name: 'fly-riverbend',
        mainOnly: true,
        secrets: [{ name: 'FLY_DEPLOY_TOKEN', updated_at: '2026-11-01T00:00:00Z' }],
      },
      { name: 'fly-saltmarsh', mainOnly: false, secrets: [] },
      { name: 'open', mainOnly: false, secrets: [] },
      { name: 'bad name/..', mainOnly: null, secrets: null },
    ]);
    // A name that cannot go in a path is never put in one.
    expect(asked.some((p) => p.includes('bad name'))).toBe(false);
  });

  it('reads a failed list as unread', () => {
    expect(readGithub(REPO, () => null)).toEqual({ environments: null, repoSecrets: null });
  });
});

describe('the live Access policies', () => {
  const config = {
    riverbend: {
      hosts: ['riverbend.harborlight.test'],
      emails: ['Alice@harborlight.test'],
      email_domains: ['saltmarsh.test'],
      service_tokens: ['riverbend-agent'],
    },
  } as unknown as StaticVars['access_projects'];
  const tokens = new Map([['tok-1', 'riverbend-agent']]);
  const app = (include: Array<Record<string, unknown>>, decision = 'allow'): LiveAccessApp[] => [
    { name: 'board riverbend', policies: [{ decision, include }] },
  ];

  it('passes an application admitting only whom the config lists, and prints no address', () => {
    const rows = liveAccessRows(
      config,
      app([
        { email: { email: 'alice@harborlight.test' } },
        { email_domain: { domain: 'saltmarsh.test' } },
        { service_token: { token_id: 'tok-1' } },
      ]),
      tokens,
    );
    expect(failing(rows)).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain('alice@');
  });

  it('fails everyone, a bypass, an unlisted address or token, and an include kind the config never writes', () => {
    const rows = liveAccessRows(
      config,
      app(
        [
          { everyone: {} },
          { email: { email: 'bob@harborlight.test' } },
          { service_token: { token_id: 'tok-other' } },
          { group: { id: 'g-1' } },
        ],
        'bypass',
      ),
      tokens,
    );
    expect(failing(rows)).toEqual([
      'live Access policies: admits what access.local.json does not list: a bypass policy, everyone, email, service_token, group',
    ]);
    expect(JSON.stringify(rows)).not.toContain('bob@');
  });

  it('fails a missing application, and a list it could not read', () => {
    expect(failing(liveAccessRows(config, [], tokens))).toEqual([
      'live Access policies: no application',
    ]);
    expect(failing(liveAccessRows(config, null, tokens))).toEqual([
      'live Access policies: could not be read',
    ]);
  });

  it("matches staging's prefixed names", () => {
    const staged: LiveAccessApp[] = [
      {
        name: 'staging board riverbend',
        policies: [
          { decision: 'non_identity', include: [{ service_token: { token_id: 'tok-1' } }] },
        ],
      },
    ];
    const names = new Map([['tok-1', 'staging riverbend-agent']]);
    expect(failing(liveAccessRows(config, staged, names, 'staging '))).toEqual([]);
  });
});
