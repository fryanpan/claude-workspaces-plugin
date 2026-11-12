/**
 * `cf:plan` through the keeper (`keeper-terraform.ts`): a plan runs at once
 * and hands the run only what it needs; an apply is refused, because applies
 * run in CI. A real listener with a stand-in Terraform runner; nothing runs
 * terraform or calls Cloudflare. The config sync, the one held request that
 * plans first, is `keeper-cf-sync.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { keeperTerraform } from '../src/keeper/keeper-client.ts';
import { keeperJobPlist } from '../src/keeper/keeper-launchd.ts';
import type { Executors } from '../src/keeper/keeper-requests.ts';
import { classifyTerraform } from '../src/keeper/keeper-terraform.ts';
import { type LiveKeeper, startLiveKeeper } from './keeper-live-harness.ts';

const STATE = { accessKeyId: 'fixture-r2-id-Saltmarsh', secretAccessKey: 'fixture-r2-secret-0001' };
const INPUT = JSON.stringify({
  configs: { access: '{"projects":{}}' },
  state: STATE,
  // A requester cannot ask for a kept plan, the sign-in list or tokens.
  planId: 'requester-chosen-plan-id-0001',
  access: true,
  expect: { evil: 'evil' },
});

const runs: Array<{ mode: string; env: string; stdin: Record<string, unknown> }> = [];
const exec: Executors = {
  fly: async () => ({ status: 0, stdout: '', stderr: '' }),
  cloudflare: async () => ({ status: 200, body: '{}' }),
  terraform: async (mode, env, stdin) => {
    runs.push({ mode, env, stdin: JSON.parse(stdin) });
    return {
      status: 0,
      stdout: `${JSON.stringify({ ok: true, mode: 'plan', text: 'plan', changes: 1, missing: {} })}\n`,
      stderr: '',
    };
  },
};

let k: LiveKeeper;
beforeAll(async () => {
  k = await startLiveKeeper(exec, 'keeper-terraform');
});
afterAll(async () => k?.stop());

describe('classifyTerraform', () => {
  it('a plan is routine; an apply is refused with a pointer to CI; anything else is refused', () => {
    expect(classifyTerraform('plan', 'prod', INPUT).kind).toBe('routine');
    const apply = classifyTerraform('apply', 'staging', INPUT);
    expect(apply.kind).toBe('refused');
    expect(apply.kind === 'refused' && apply.reason).toContain('cf:sync-config');
    expect(classifyTerraform('destroy', 'prod', INPUT).kind).toBe('refused');
    expect(classifyTerraform('plan', '../prod', INPUT).kind).toBe('refused');
    expect(classifyTerraform('plan', 'prod', '{"configs":{}}').kind).toBe('refused');
    expect(classifyTerraform('plan', 'prod', 'not json').kind).toBe('refused');
  });
});

describe('a plan', () => {
  it('runs at once and hands the run only the configs, the state credential and its own fields', async () => {
    runs.length = 0;
    const r = await k.submit('/v1/terraform', { command: 'plan', env: 'prod', input: INPUT });
    expect(r.status).toBe(200);
    expect(r.held).toBe(false);
    expect(runs).toEqual([
      {
        mode: 'plan',
        env: 'prod',
        stdin: { configs: { access: '{"projects":{}}' }, state: STATE, access: false },
      },
    ]);
  });

  it('the client answers with the run report', async () => {
    const r = await keeperTerraform(k.keeper.origin, 'plan', 'staging', INPUT, {
      callerToken: k.caller,
      fetchImpl: fetch,
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, mode: 'plan' });
  });

  it('an apply is refused before anything runs', async () => {
    runs.length = 0;
    const r = await k.submit('/v1/terraform', { command: 'apply', env: 'prod', input: INPUT });
    expect(r.status).toBe(403);
    expect(runs).toEqual([]);
  });
});

describe("the keeper's launchd job", () => {
  it('names the fixed terraform binary beside bun and fly', () => {
    const p = keeperJobPlist({
      root: '/Users/cw-relay/keeper',
      home: '/Users/cw-relay',
      port: 41234,
      socketPath: '/s',
    });
    expect(p).toContain('<key>CW_KEEPER_TERRAFORM_BIN</key>');
    expect(p).toContain('<string>/Users/cw-relay/keeper/bin/terraform</string>');
  });
});
