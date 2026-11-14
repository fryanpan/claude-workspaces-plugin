/**
 * Which events reach `.github/workflows/cloudflare.yml`'s apply job: a merge
 * to main (a push) and the keeper's dispatch on main do, with no step a
 * person must take; a pull request, and a dispatch on any other branch, do
 * not. The workflow is parsed as YAML and each job's `if` is evaluated
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

const WORKFLOWS = join(import.meta.dir, '..', '..', '..', '.github', 'workflows');

interface Job {
  if?: string;
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
  on: Record<string, { paths?: string[]; branches?: string[] } | null>;
  jobs: Record<string, Job>;
}

const load = (name: string) =>
  Bun.YAML.parse(readFileSync(join(WORKFLOWS, name), 'utf8')) as Workflow;
const wf = load('cloudflare.yml');
const fly = load('fly.yml');

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

  it("the keeper's dispatch on main is accepted and reaches the apply job", () => {
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
      steps.some(
        (s) =>
          s.run ===
          'bun infra/cloudflare/ci-credentials.ts -- bun infra/cloudflare/run.ts apply prod --ci',
      ),
    ).toBe(true);
    expect(JSON.stringify(wf.jobs)).not.toMatch(/manual-approval|wait-for-approval|trstringer/i);
  });
});

describe('fly.yml', () => {
  it('deploys on a push to main and a dispatch on main, in cloudflare-prod, and nowhere else', () => {
    expect(runs('deploy', event('push', MAIN), fly)).toBe(true);
    expect(runs('deploy', event('workflow_dispatch', MAIN), fly)).toBe(true);
    expect(runs('deploy', event('workflow_dispatch', 'refs/heads/riverbend'), fly)).toBe(false);
    expect(Object.keys(fly.on)).not.toContain('pull_request');
    expect(fly.jobs.deploy?.environment).toBe('cloudflare-prod');
  });

  it('hands the Fly and Cloudflare tokens to the deploy step alone', () => {
    const steps = fly.jobs.deploy?.steps ?? [];
    const values = (env?: Record<string, string>) => Object.values(env ?? {}).join(' ');
    expect(values(fly.jobs.deploy?.env)).not.toMatch(/secrets\./);
    const holders = steps.filter(
      (st) =>
        /secrets\.(FLY_API_TOKEN|CLOUDFLARE_API_TOKEN|R2_SECRET)/.test(values(st.env)) &&
        !/!= ''/.test(values(st.env)),
    );
    expect(holders.map((st) => st.name)).toEqual(['Deploy each project machine']);
    expect(steps.find((st) => st.run?.includes('bun install'))?.env).toBeUndefined();
  });
});
