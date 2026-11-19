/**
 * Which events reach `.github/workflows/cloudflare.yml`'s apply job: a merge
 * to main (a push) and `cf:sync-config`'s dispatch on main do, with no step a
 * person must take; a pull request, and a dispatch on any other branch, do
 * not. The same for the workflows that replaced the keeper (fly-provision,
 * fly-ci-tokens, cf-rotate-token): main only, each secret on the steps that
 * use it, and every input through the environment rather than a script. The workflow is parsed as YAML and each job's `if` is evaluated
 * against the context GitHub would give that event, by a small evaluator of
 * the expression syntax the file uses (context paths, string literals, `==`,
 * `!=`, `!`, `&&`, `||`, parentheses), so the test follows the condition's
 * meaning rather than its spelling.
 *
 * What it cannot see: the `cloudflare-prod` environment's protection rules
 * live on GitHub, not in the file. "No human step" also needs that
 * environment to have no required reviewer, which is set there.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAC_ARTIFACT, WORKFLOWS as WORKFLOWS_PULLED } from '../../../infra/handoff/pull.ts';
import {
  STAGING_APP,
  STAGING_ENVIRONMENT,
  environmentFor,
} from '../../../infra/project-machine/ci-tokens.ts';

const WORKFLOWS = join(import.meta.dir, '..', '..', '..', '.github', 'workflows');

interface Job {
  if?: string;
  concurrency?: { group?: string } | string;
  needs?: string | string[];
  environment?: string;
  env?: Record<string, string>;
  steps?: {
    name?: string;
    run?: string;
    if?: string;
    uses?: string;
    env?: Record<string, string>;
  }[];
}
interface Workflow {
  on: Record<string, { paths?: string[]; branches?: string[]; inputs?: unknown } | null>;
  jobs: Record<string, Job>;
}

const load = (name: string) =>
  Bun.YAML.parse(readFileSync(join(WORKFLOWS, name), 'utf8')) as Workflow;
const wf = load('cloudflare.yml');
const fly = load('fly.yml');
const appKit = load('app-kit-staging.yml');
const provision = load('fly-provision.yml');
const ciTokens = load('fly-ci-tokens.yml');
const rotate = load('cf-rotate-token.yml');

type Ctx = Record<string, string>;

/** Evaluate one GitHub Actions expression over flat `a.b` context paths. */
function evaluate(expr: string, ctx: Ctx): boolean | string {
  const tokens = expr.match(/'[^']*'|==|!=|&&|\|\||[()!]|[A-Za-z_][A-Za-z0-9_.-]*/g) ?? [];
  if (tokens.join('').replace(/\s/g, '') !== expr.replace(/\s/g, '')) {
    throw new Error(`the evaluator cannot read: ${expr}`);
  }
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++] as string;
  const truthy = (v: boolean | string) => v !== false && v !== '';
  const primary = (): boolean | string => {
    const t = next();
    if (t === '(') {
      const v = or();
      if (next() !== ')') throw new Error('unbalanced parentheses');
      return v;
    }
    if (t === '!') return !truthy(primary());
    if (t.startsWith("'")) return t.slice(1, -1);
    if (t === 'true' || t === 'false') return t === 'true';
    return ctx[t] ?? '';
  };
  const compare = (): boolean | string => {
    const left = primary();
    const op = peek();
    if (op === '==' || op === '!=') {
      next();
      const right = primary();
      return op === '==' ? left === right : left !== right;
    }
    return left;
  };
  const and = (): boolean | string => {
    let v = compare();
    while (peek() === '&&') {
      next();
      const r = compare();
      v = truthy(v) ? r : v;
    }
    return v;
  };
  const or = (): boolean | string => {
    let v = and();
    while (peek() === '||') {
      next();
      const r = and();
      v = truthy(v) ? v : r;
    }
    return v;
  };
  const v = or();
  if (i !== tokens.length) throw new Error(`trailing tokens in: ${expr}`);
  return v;
}

/** Whether a job runs for this event: its `if` holds, and so does every job it needs. */
function runs(job: string, ctx: Ctx, w: Workflow = wf): boolean {
  const j = w.jobs[job];
  if (!j) throw new Error(`no job ${job}`);
  const needs = j.needs === undefined ? [] : Array.isArray(j.needs) ? j.needs : [j.needs];
  if (!needs.every((n) => runs(n, ctx, w))) return false;
  if (j.if === undefined) return true;
  const v = evaluate(j.if.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), ctx);
  return v !== false && v !== '';
}

const event = (name: string, ref: string): Ctx => ({
  'github.event_name': name,
  'github.ref': ref,
});
const MAIN = 'refs/heads/main';

describe('the evaluator', () => {
  it('reads the operators the workflow uses the way GitHub does', () => {
    const ctx = { 'github.event_name': 'push', 'github.ref': MAIN };
    expect(evaluate("github.event_name == 'push'", ctx)).toBe(true);
    expect(evaluate("github.event_name != 'push'", ctx)).toBe(false);
    expect(
      evaluate("(github.event_name == 'x' || github.ref == 'refs/heads/main') && true", ctx),
    ).toBe(true);
    expect(evaluate("github.event_name == 'x' || github.event_name == 'y' && true", ctx)).toBe(
      false,
    );
    expect(evaluate("!(github.event_name == 'push')", ctx)).toBe(false);
    expect(() => evaluate('github.event_name ~= 1', ctx)).toThrow('cannot read');
  });
});

describe('cloudflare.yml', () => {
  it('a merged pull request (a push to main) reaches the apply job, in cloudflare-prod', () => {
    expect(runs('apply', event('push', MAIN))).toBe(true);
    expect(runs('plan', event('push', MAIN))).toBe(false);
    expect(wf.jobs.apply?.environment).toBe('cloudflare-prod');
  });

  it("cf:sync-config's dispatch on main is accepted and reaches the apply job", () => {
    expect(Object.keys(wf.on)).toContain('workflow_dispatch');
    expect(runs('apply', event('workflow_dispatch', MAIN))).toBe(true);
  });

  it("the apply job's write secrets reach only the Apply prod step, never bun install", () => {
    const apply = wf.jobs.apply;
    const secretIn = (env?: Record<string, string>) =>
      Object.values(env ?? {}).some((v) => /\bsecrets\.(CLOUDFLARE_API_TOKEN|R2_)/.test(v));
    const values = (env?: Record<string, string>) => Object.values(env ?? {}).join(' ');
    expect(secretIn(apply?.env)).toBe(false);
    const steps = apply?.steps ?? [];
    const install = steps.find((st) => st.run?.includes('bun install'));
    expect(install).toBeDefined();
    expect(install?.env).toBeUndefined();
    const step = steps.find((st) => st.name === 'Apply prod');
    expect(values(step?.env)).toContain('secrets.CLOUDFLARE_API_TOKEN');
    expect(values(step?.env)).toContain('secrets.R2_SECRET_ACCESS_KEY');
    const holders = steps.filter(
      (st) =>
        /secrets\.(CLOUDFLARE_API_TOKEN|R2_SECRET)/.test(values(st.env)) &&
        !/!= ''/.test(values(st.env)),
    );
    expect(holders.map((st) => st.name)).toEqual(['Apply prod']);
  });

  it('a dispatch on another branch, and a pull request, apply nothing', () => {
    expect(runs('apply', event('workflow_dispatch', 'refs/heads/riverbend'))).toBe(false);
    expect(runs('apply', event('pull_request', 'refs/pull/7/merge'))).toBe(false);
    expect(runs('plan', event('pull_request', 'refs/pull/7/merge'))).toBe(true);
  });

  it('keeps the path filters on push and pull request, and both run the check', () => {
    const paths = ['infra/cloudflare/**', '.github/workflows/cloudflare.yml'];
    for (const on of ['push', 'pull_request']) {
      for (const p of paths) expect(wf.on[on]?.paths).toContain(p);
    }
    expect(wf.on.push?.branches).toEqual(['main']);
    for (const name of ['push', 'workflow_dispatch', 'pull_request']) {
      expect(runs('check', event(name, MAIN))).toBe(true);
    }
  });

  it('applies with run.ts apply --ci and has no step that waits on a person', () => {
    const steps = wf.jobs.apply?.steps ?? [];
    expect(
      steps.some((s) =>
        s.run?.includes(
          'bun infra/cloudflare/ci-credentials.ts -- bun infra/cloudflare/run.ts apply prod --ci',
        ),
      ),
    ).toBe(true);
    // A service token it makes is sealed to the Mac and handed on, even after a failure.
    expect(steps.find((s) => s.name === 'Apply prod')?.env?.CW_HANDOFF_OUT).toContain(
      'handoff-mac',
    );
    const upload = steps.find((s) => s.uses?.startsWith('actions/upload-artifact'));
    expect(upload?.if).toContain('always()');
    expect(JSON.stringify(wf.jobs)).not.toMatch(/manual-approval|wait-for-approval|trstringer/i);
  });
});

describe('fly.yml', () => {
  const MATRIX = { 'needs.projects.outputs.matrix': '["harborlight"]' };

  it('deploys on a push to main and a dispatch on main, one job per project in its own environment', () => {
    expect(runs('deploy', { ...event('push', MAIN), ...MATRIX }, fly)).toBe(true);
    expect(runs('deploy', { ...event('workflow_dispatch', MAIN), ...MATRIX }, fly)).toBe(true);
    expect(
      runs('deploy', { ...event('workflow_dispatch', 'refs/heads/riverbend'), ...MATRIX }, fly),
    ).toBe(false);
    // An empty matrix is an error to GitHub, so no project means no job.
    expect(
      runs('deploy', { ...event('push', MAIN), 'needs.projects.outputs.matrix': '[]' }, fly),
    ).toBe(false);
    expect(Object.keys(fly.on)).not.toContain('pull_request');
    expect(fly.jobs.deploy?.environment).toBe(`${environmentFor('${{ matrix.project }}')}`);
    expect(fly.jobs.projects?.environment).toBeUndefined();
  });

  it("hands the project's own token to the deploy step alone, and nothing else", () => {
    const steps = fly.jobs.deploy?.steps ?? [];
    const values = (env?: Record<string, string>) => Object.values(env ?? {}).join(' ');
    expect(values(fly.jobs.deploy?.env)).not.toMatch(/secrets\./);
    const holders = steps.filter(
      (st) => /secrets\./.test(values(st.env)) && !/!= ''/.test(values(st.env)),
    );
    expect(holders.map((st) => st.name)).toEqual(['Deploy the project machine']);
    // The app-scoped token, and no org token, Cloudflare token, state key or address.
    const used = [...values(holders[0]?.env).matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect(used).toEqual(['FLY_DEPLOY_TOKEN']);
    const all = JSON.stringify(fly);
    for (const gone of [
      'FLY_API_TOKEN }}',
      'CLOUDFLARE_API_TOKEN',
      'R2_SECRET_ACCESS_KEY',
      'CW_SECRET_',
      'cloudflare-prod',
    ])
      expect(all).not.toContain(gone);
    expect(holders[0]?.run).toContain('--no-terraform-outputs');
    expect(steps.find((st) => st.run?.includes('bun install'))?.env).toBeUndefined();
    for (const st of fly.jobs.projects?.steps ?? [])
      expect(values(st.env)).not.toMatch(/secrets\./);
    // A secret spelled inside a script would reach the log's command echo.
    for (const w of [fly, wf, appKit]) {
      for (const job of Object.values(w.jobs)) {
        for (const st of job.steps ?? []) expect(st.run ?? '').not.toContain('secrets.');
      }
    }
  });
});

describe('app-kit-staging.yml', () => {
  it('deploys the one trial app on a dispatch on main, in its own environment, and on nothing else', () => {
    expect(Object.keys(appKit.on)).toEqual(['workflow_dispatch']);
    // No input: the token reaches one app, so the app is not the caller's to name.
    expect(appKit.on.workflow_dispatch).toEqual({});
    expect(runs('deploy', event('workflow_dispatch', MAIN), appKit)).toBe(true);
    expect(runs('deploy', event('workflow_dispatch', 'refs/heads/riverbend'), appKit)).toBe(false);
    expect(appKit.jobs.deploy?.environment).toBe(STAGING_ENVIRONMENT);
    const deploy = appKit.jobs.deploy?.steps?.find((st) => st.run?.includes('deploy:staging'));
    expect(deploy?.env?.APP_NAME).toBe(STAGING_APP);
    expect(deploy?.env?.FLY_API_TOKEN).toBe('${{ secrets.FLY_DEPLOY_TOKEN }}');
  });

  it('hands the Fly token to the deploy step alone, and the clock starts before new-app', () => {
    const steps = appKit.jobs.deploy?.steps ?? [];
    const values = (env?: Record<string, string>) => Object.values(env ?? {}).join(' ');
    expect(values(appKit.jobs.deploy?.env)).not.toMatch(/secrets\./);
    const holders = steps.filter((st) => /secrets\./.test(values(st.env)));
    expect(holders.map((st) => st.name)).toEqual(['Deploy to staging and wait for a 200']);
    const at = (name: string) => steps.findIndex((st) => st.name === name);
    expect(at('Start the clock')).toBeGreaterThanOrEqual(0);
    expect(at('Start the clock')).toBeLessThan(at('Make the app'));
    expect(holders[0]?.run).toContain('--started-at "$STARTED_AT"');
  });
});

describe('the workflows that replaced the keeper', () => {
  const values = (env?: Record<string, string>) => Object.values(env ?? {}).join(' ');
  const secretsOf = (env?: Record<string, string>) =>
    [...values(env).matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  /** The steps that hold a secret's value, by name; a presence check holds none. */
  const holders = (job: Job | undefined) =>
    (job?.steps ?? [])
      .filter((st) => /secrets\./.test(values(st.env)) && !/!= ''/.test(values(st.env)))
      .map((st) => st.name);

  it('run on main only, each job in the environment that holds its secrets', () => {
    expect(runs('provision', event('workflow_dispatch', MAIN), provision)).toBe(true);
    expect(runs('provision', event('workflow_dispatch', 'refs/heads/riverbend'), provision)).toBe(
      false,
    );
    expect(provision.jobs.outputs?.environment).toBe('cloudflare-prod');
    expect(provision.jobs.provision?.environment).toBe('fly-org');
    expect(provision.jobs.provision?.needs).toBe('outputs');
    expect(runs('apply', event('schedule', MAIN), ciTokens)).toBe(true);
    expect(runs('apply', event('workflow_dispatch', 'refs/heads/riverbend'), ciTokens)).toBe(false);
    expect(ciTokens.jobs.apply?.environment).toBe('fly-org');
    expect(runs('rotate', event('workflow_dispatch', MAIN), rotate)).toBe(true);
    expect(runs('rotate', event('workflow_dispatch', 'refs/heads/riverbend'), rotate)).toBe(false);
    expect(rotate.jobs.rotate?.environment).toBe('cloudflare-prod');
    for (const w of [provision, ciTokens, rotate]) expect(Object.keys(w.on)).not.toContain('push');
  });

  it('give the org token and the admin token to the steps that call Fly and GitHub alone', () => {
    expect(holders(provision.jobs.provision)).toEqual([
      "Make the project's machine",
      "Cut the narrow tokens again, the new app's among them",
    ]);
    const make = provision.jobs.provision?.steps?.find((st) => st.name?.startsWith('Make'));
    expect(secretsOf(make?.env).sort()).toEqual([
      'FLY_API_TOKEN',
      'GH_ADMIN_TOKEN',
      'HANDOFF_PRIVATE_KEY',
    ]);
    expect(make?.env?.CW_SECRETS_FROM_ENV).toBe('1');
    expect(make?.env?.CW_HANDOFF_OUT).toContain('handoff-mac');
    expect(holders(provision.jobs.outputs)).toEqual([
      'Seal the tunnel token and the Access settings to fly-org',
    ]);
    expect(holders(ciTokens.jobs.apply)).toEqual(['Cut and write the tokens']);
    expect(holders(rotate.jobs.rotate)).toEqual(['Rotate and seal the new pair to the Mac']);
    for (const w of [provision, ciTokens, rotate]) {
      for (const job of Object.values(w.jobs)) {
        expect(values(job.env)).not.toMatch(/secrets\./);
        const install = job.steps?.find((st) => st.run?.includes('bun install'));
        if (install) expect(install.env).toBeUndefined();
      }
    }
  });

  it('pass every input and secret through the environment, never a script’s text', () => {
    for (const w of [provision, ciTokens, rotate]) {
      for (const job of Object.values(w.jobs)) {
        for (const st of job.steps ?? []) {
          expect(st.run ?? '').not.toContain('secrets.');
          expect(st.run ?? '').not.toContain('inputs.');
        }
      }
    }
  });

  it('hand the Mac what they made as one artifact name, the one handoff:pull asks for', () => {
    for (const job of [provision.jobs.provision, ciTokens.jobs.apply, rotate.jobs.rotate]) {
      const upload = job?.steps?.find((st) => st.uses?.startsWith('actions/upload-artifact'));
      expect((upload as { with?: { name?: string } } | undefined)?.with?.name).toBe(MAC_ARTIFACT);
    }
    expect(WORKFLOWS_PULLED).toEqual(
      expect.arrayContaining(['fly-provision.yml', 'fly-ci-tokens.yml', 'cf-rotate-token.yml']),
    );
  });

  it('pin every action by commit, so a moved tag cannot run in a job that holds a secret', () => {
    for (const w of [wf, provision, ciTokens, rotate]) {
      for (const job of Object.values(w.jobs)) {
        for (const st of job.steps ?? []) {
          if (st.uses) expect(st.uses).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
        }
      }
    }
  });

  it('remove the Terraform work folder at the end of every job that writes one, even on a failure', () => {
    const writers = [provision.jobs.provision, ciTokens.jobs.apply];
    for (const job of writers) {
      const steps = job?.steps ?? [];
      expect(steps.some((st) => st.env?.CW_TF_WORK_DIR?.includes('runner.temp'))).toBe(true);
      const last = steps.at(-1);
      expect(last?.if).toBe('always()');
      expect(last?.run).toContain('rm -rf "$RUNNER_TEMP/tf"');
    }
  });
});
