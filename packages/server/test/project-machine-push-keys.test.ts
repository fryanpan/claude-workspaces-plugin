/**
 * The secrets a project machine's deploy gives it for pushing
 * (`infra/project-machine/deploy-plan.ts`, `push-keys.ts`).
 *
 * The server pushes with a write deploy key per repo, which fly-provision.yml
 * makes and sets (`project-machine-provision.test.ts`); it never holds a
 * classic GitHub token. So no plan ever
 * sets `CW_GITHUB_PUSH_TOKEN`, and a plan over an app that has one unsets it.
 */
import { describe, expect, it } from 'bun:test';
import {
  CLASSIC_PUSH_TOKEN_SECRET,
  type Observed,
  PUSH_KEYS_SECRET,
  type ProjectConfig,
  plan,
  projectConfig,
  requiredSecrets,
} from '../../../infra/project-machine/deploy-plan.ts';

const SHA = 'a'.repeat(40);
const REPOS = ['Riverbend/notes', 'Riverbend/app'];
const base = projectConfig({ project: 'riverbend-test', imageLabel: SHA });

function complete(cfg: ProjectConfig, extra: string[] = []): Observed {
  return {
    app: true,
    volumes: 1,
    keychain: new Set([cfg.keychain.identity, cfg.keychain.bucketAdmin, cfg.keychain.writer]),
    snapshots: true,
    lifecycle: false,
    secrets: new Set([...requiredSecrets(cfg.tunnel), ...extra]),
    machines: [{ id: 'm1', state: 'started', imageTag: SHA, memoryMb: cfg.vmMemoryMb }],
    browser: true,
  };
}

describe('the deploy plan’s secret list', () => {
  it('never sets a classic GitHub token, whatever the project', () => {
    const configs = [
      base,
      projectConfig({ project: 'riverbend-test', imageLabel: SHA, tunnel: 'named' }),
      projectConfig({
        project: 'riverbend-test',
        imageLabel: SHA,
        leadBoard: 'w-riverbend',
        vmMemoryMb: 2048,
        refreshLead: true,
      }),
      projectConfig({ project: 'riverbend-test', imageLabel: SHA, pushRepos: REPOS }),
    ];
    for (const cfg of configs) {
      expect(requiredSecrets(cfg.tunnel, true, ['CW_LEAD_BOARD'])).not.toContain(
        CLASSIC_PUSH_TOKEN_SECRET,
      );
      const fresh: Observed = { ...complete(cfg), app: false, secrets: new Set(), machines: [] };
      for (const obs of [fresh, complete(cfg)]) {
        const set = plan(cfg, obs).flatMap((a) => (a.kind === 'set-secrets' ? a.names : []));
        expect(set).not.toContain(CLASSIC_PUSH_TOKEN_SECRET);
        expect(set).not.toContain(PUSH_KEYS_SECRET);
      }
    }
  });

  it('unsets a classic token it finds on the app, then deploys so the server drops it', () => {
    expect(plan(base, complete(base, [CLASSIC_PUSH_TOKEN_SECRET]))).toEqual([
      { kind: 'unset-secrets', names: [CLASSIC_PUSH_TOKEN_SECRET] },
      { kind: 'deploy' },
    ]);
    // Positive control: the same app without one plans nothing.
    expect(plan(base, complete(base))).toEqual([]);
  });

  it('makes a deploy key per repo once, and again only when told to', () => {
    const cfg = projectConfig({ project: 'riverbend-test', imageLabel: SHA, pushRepos: REPOS });
    expect(plan(cfg, complete(cfg))).toEqual([
      { kind: 'make-push-keys', repos: REPOS },
      { kind: 'deploy' },
    ]);
    expect(plan(cfg, complete(cfg, [PUSH_KEYS_SECRET]))).toEqual([]);
    const again = projectConfig({
      project: 'riverbend-test',
      imageLabel: SHA,
      pushRepos: REPOS,
      refreshPushKeys: true,
    });
    expect(plan(again, complete(again, [PUSH_KEYS_SECRET]))).toEqual([
      { kind: 'make-push-keys', repos: REPOS },
      { kind: 'deploy' },
    ]);
  });

  it('refuses a push repo that is not owner/name, and a refresh with no repo', () => {
    expect(() =>
      projectConfig({ project: 'riverbend-test', imageLabel: SHA, pushRepos: ['../x'] }),
    ).toThrow('owner/name');
    expect(() =>
      projectConfig({ project: 'riverbend-test', imageLabel: SHA, refreshPushKeys: true }),
    ).toThrow('--push-repo');
  });
});
