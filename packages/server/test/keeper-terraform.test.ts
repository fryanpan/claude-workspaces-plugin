/**
 * `cf:plan` / `cf:apply` through the keeper (`keeper-terraform.ts`): a plan
 * runs at once; an apply is planned first and held with that plan on the
 * approval page, and the owner's tap applies exactly that saved plan; a plan
 * that changes nothing runs no tap; a missing service token is a tap of its
 * own whose secret goes back to the requester and never to the page. A real
 * listener with a stand-in Terraform runner; nothing runs terraform or
 * calls Cloudflare.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintCallerToken } from '../src/keeper/keeper-callers.ts';
import { keeperTerraform } from '../src/keeper/keeper-client.ts';
import { keeperJobPlist } from '../src/keeper/keeper-launchd.ts';
import type { Executors, FlyResult } from '../src/keeper/keeper-requests.ts';
import { type RunningKeeper, serveKeeper } from '../src/keeper/keeper-serve.ts';
import { type KeeperStore, hashToken, openKeeperStore } from '../src/keeper/keeper-store.ts';
import { classifyTerraform } from '../src/keeper/keeper-terraform.ts';
import { TestPasskey } from './keeper-authenticator.ts';

const tmp = mkdtempSync(join(tmpdir(), 'keeper-terraform-'));
const STATE = { accessKeyId: 'fixture-r2-id-Saltmarsh', secretAccessKey: 'fixture-r2-secret-0001' };
const INPUT = JSON.stringify({
  configs: { access: '{"projects":{}}' },
  state: STATE,
  // A requester cannot choose the plan to apply or the tokens to make.
  planId: 'requester-chosen-plan-id-0001',
  expect: { evil: 'evil' },
});
const SECRET = 'feedface'.repeat(8);
const PLAN_TEXT = 'module.access.cloudflare_zero_trust_access_policy.people will be updated <b>';

interface Run {
  mode: string;
  env: string;
  stdin: Record<string, unknown>;
}
const runs: Run[] = [];
interface Next {
  changes: number;
  missing: Record<string, string>;
  access?: unknown;
  cut?: { shown: number; total: number };
}
/** What the stand-in plan reports next. */
let next: Next = { changes: 1, missing: {} };
const ALICE = 'alice@harborlight.test';
const BOB = 'bob@harborlight.test';

const report = (r: Record<string, unknown>): FlyResult => ({
  status: r.ok === false ? 1 : 0,
  stdout: `${JSON.stringify(r)}\n`,
  stderr: '',
});

const exec: Executors = {
  fly: async () => ({ status: 0, stdout: '', stderr: '' }),
  cloudflare: async () => ({ status: 200, body: '{}' }),
  terraform: async (mode, env, stdin) => {
    runs.push({ mode, env, stdin: JSON.parse(stdin) });
    if (mode === 'plan') {
      return report({
        ok: true,
        mode: 'plan',
        text: PLAN_TEXT,
        summary: `Cloudflare plan for ${env}: ${next.changes} to change.`,
        changes: next.changes,
        missing: next.missing,
        // A kept plan reports its sign-in changes, as `keeper-run.ts` does.
        ...(JSON.parse(stdin).keep === true ? { access: next.access ?? [] } : {}),
        ...(next.cut ? { cut: next.cut } : {}),
      });
    }
    if (mode === 'mint') {
      return report({
        ok: true,
        mode: 'mint',
        minted: [
          {
            name: 'agent moi',
            id: 'token-1',
            services: {
              clientId: 'cw-agent-moi-access-client-id',
              secret: 'cw-agent-moi-access-secret',
            },
            clientId: 'c0ffee.access',
            secret: SECRET,
          },
        ],
      });
    }
    return report({ ok: true, mode: 'apply', text: 'Apply complete!', audiences: [] });
  },
};

let store: KeeperStore;
let CALLER = '';
let keeper: RunningKeeper;
let base: string;
const owner = new TestPasskey();

const post = (path: string, body: unknown = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: keeper.origin },
    body: JSON.stringify(body),
  });

const submit = async (command: string, env = 'prod', input = INPUT) => {
  const r = await fetch(`${base}/v1/terraform`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-cw-keeper': '1',
      'x-cw-keeper-caller': CALLER,
    },
    body: JSON.stringify({ command, env, input }),
  });
  return {
    status: r.status,
    held: r.headers.has('x-cw-keeper-held'),
    body: (await r.json()) as Record<string, unknown>,
  };
};

const approve = async (id: string) => {
  const html = await (await fetch(`${base}/approve/${id}`)).text();
  const page = /const pageToken = "([^"]+)"/.exec(html)?.[1] ?? '';
  const c = (await (await post(`/v1/requests/${id}/challenge`, { page })).json()) as {
    challenge: string;
  };
  const signed = owner.assert({ challenge: c.challenge, origin: keeper.origin, rpId: 'localhost' });
  const r = await post(`/v1/requests/${id}/approve`, { page, ...signed });
  return { status: r.status, text: await r.text() };
};

const poll = async (id: string, pollToken: string) =>
  (await (
    await fetch(`${base}/v1/requests/${id}`, {
      headers: { 'x-cw-keeper': '1', 'x-cw-keeper-caller': CALLER, 'x-cw-keeper-poll': pollToken },
    })
  ).json()) as { status: string; result?: FlyResult };

beforeAll(async () => {
  const dir = join(tmp, 'store');
  mkdirSync(dir, { mode: 0o700 });
  const s = openKeeperStore(dir);
  if ('error' in s) throw new Error(s.error);
  store = s;
  CALLER = mintCallerToken(store);
  keeper = serveKeeper({ store, exec, port: 0, keeperUid: 4_000_000 });
  base = `http://127.0.0.1:${keeper.port}`;
  store.saveEnroll({
    tokenHash: hashToken('owner-link'),
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
  });
  const o = (await (await post('/v1/enroll/options', { token: 'owner-link' })).json()) as {
    challenge: string;
    session: string;
  };
  const reg = owner.register({ challenge: o.challenge, origin: keeper.origin, rpId: 'localhost' });
  expect((await post('/v1/enroll', { session: o.session, ...reg })).status).toBe(200);
});

afterAll(async () => {
  await keeper?.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe('classifyTerraform', () => {
  it('a plan is routine, an apply is held, and anything else is refused', () => {
    expect(classifyTerraform('plan', 'prod', INPUT).kind).toBe('routine');
    expect(classifyTerraform('apply', 'staging', INPUT)).toMatchObject({
      kind: 'held',
      hold: 'cloudflare.apply',
    });
    expect(classifyTerraform('destroy', 'prod', INPUT).kind).toBe('refused');
    expect(classifyTerraform('plan', '../prod', INPUT).kind).toBe('refused');
    expect(classifyTerraform('plan', 'prod', '{"configs":{}}').kind).toBe('refused');
    expect(classifyTerraform('plan', 'prod', 'not json').kind).toBe('refused');
  });
});

describe('a plan', () => {
  it('runs at once, keeps no saved plan, and hands the run only what it needs', async () => {
    runs.length = 0;
    const r = await submit('plan');
    expect(r.status).toBe(200);
    expect(r.held).toBe(false);
    expect(runs).toHaveLength(1);
    const run = runs[0] as Run;
    expect(run.mode).toBe('plan');
    expect(run.stdin.keep).toBe(false);
    expect(run.stdin.state).toEqual(STATE);
    expect(run.stdin.planId).not.toBe('requester-chosen-plan-id-0001');
    expect(run.stdin.expect).toBeUndefined();
  });

  it('the client answers with the run report', async () => {
    const r = await keeperTerraform(keeper.origin, 'plan', 'staging', INPUT, {
      callerToken: CALLER,
      fetchImpl: fetch,
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, mode: 'plan' });
  });
});

describe('an apply', () => {
  it('is planned, held with that plan on the page, and the tap applies that saved plan', async () => {
    runs.length = 0;
    next = { changes: 2, missing: {} };
    const r = await submit('apply');
    expect(r.status).toBe(202);
    expect(runs.map((x) => x.mode)).toEqual(['plan']);
    const planId = (runs[0] as Run).stdin.planId as string;
    expect((runs[0] as Run).stdin.keep).toBe(true);

    const id = r.body.id as string;
    const page = await (await fetch(`${base}/approve/${id}`)).text();
    expect(page).toContain('people will be updated &#60;b&#62;');
    expect(page).toContain('2 to change');

    expect((await approve(id)).status).toBe(200);
    expect(runs.map((x) => x.mode)).toEqual(['plan', 'apply']);
    expect((runs[1] as Run).stdin.planId).toBe(planId);
    const done = await poll(id, r.body.pollToken as string);
    expect(done.status).toBe('done');
    expect(JSON.parse(done.result?.stdout ?? '{}')).toMatchObject({ mode: 'apply' });
  });

  it("names on the page each address the plan adds to a project's sign-in list, and tells the requester none of them", async () => {
    runs.length = 0;
    next = {
      changes: 1,
      missing: {},
      access: [{ project: 'riverbend', added: [ALICE], removed: [BOB] }],
    };
    const r = await submit('apply');
    expect(r.status).toBe(202);
    const id = r.body.id as string;
    const page = await (await fetch(`${base}/approve/${id}`)).text();
    const signIn = /<dd id="sign-in">([\s\S]*?)<\/dd>/.exec(page)?.[1] ?? '';
    const project = /<li data-project="riverbend">([\s\S]*?)<\/ul><\/li>/.exec(signIn)?.[1] ?? '';
    expect(project).toContain(`<li>adds <code>${ALICE}</code></li>`);
    expect(project).toContain(`<li>removes <code>${BOB}</code></li>`);
    expect(page).toContain('id="approve"');

    // The requester's answers carry the plan summary, never the addresses.
    expect(JSON.stringify(r.body)).not.toContain(ALICE);
    expect(JSON.stringify(await poll(id, r.body.pollToken as string))).not.toContain(ALICE);
    const approved = await approve(id);
    expect(approved.text).not.toContain(ALICE);
    expect(JSON.stringify(await poll(id, r.body.pollToken as string))).not.toContain(ALICE);
    next = { changes: 1, missing: {} };
  });

  it('says on the page that the configs are the requester’s and the Terraform files the keeper’s', async () => {
    next = { changes: 1, missing: {} };
    const r = await submit('apply');
    const page = await (await fetch(`${base}/approve/${r.body.id as string}`)).text();
    expect(page).toContain(
      'planned it with its own release&#39;s Terraform files, from the configs the requester sent',
    );
    expect(page).not.toContain('its own copy of the config');
    expect(/<dd id="configs-sent">([^<]*)<\/dd>/.exec(page)?.[1]).toBe('access');
  });

  it('with a plan cut at the size limit says so on the page and applies nothing on a tap', async () => {
    runs.length = 0;
    next = { changes: 1, missing: {}, cut: { shown: 524_288, total: 600_000 } };
    const r = await submit('apply');
    expect(r.status).toBe(202);
    const id = r.body.id as string;
    const page = await (await fetch(`${base}/approve/${id}`)).text();
    expect(page).toContain('The plan, cut short');
    expect(page).toContain(
      'Cut here. The plan is 600000 characters and this page shows the first 524288.',
    );
    expect(page).not.toContain('id="approve"');
    expect(page).toContain('id="deny"');

    // A tap that reaches the API anyway still applies nothing.
    const approved = await approve(id);
    expect(approved.text).toContain('longer than the approval page showed');
    expect(runs.map((x) => x.mode)).toEqual(['plan']);
    next = { changes: 1, missing: {} };
  });

  it('whose run reports no readable sign-in list is not held', async () => {
    runs.length = 0;
    next = { changes: 1, missing: {}, access: [{ project: 'riverbend', added: 'x' }] };
    const r = await submit('apply');
    expect(r.held).toBe(false);
    expect(JSON.stringify(r.body)).toContain('did not say who it lets sign in');
    next = { changes: 1, missing: {} };
  });

  it('that changes nothing runs no tap', async () => {
    runs.length = 0;
    next = { changes: 0, missing: {} };
    const r = await submit('apply');
    expect(r.status).toBe(200);
    expect(r.held).toBe(false);
    expect(runs.map((x) => x.mode)).toEqual(['plan']);
  });

  it('with a missing service token makes exactly that token on a tap, and the secret reaches only the requester', async () => {
    runs.length = 0;
    next = { changes: 3, missing: { 'agent moi': 'agent moi' } };
    const r = await submit('apply');
    expect(r.status).toBe(202);
    const id = r.body.id as string;
    expect(r.body.summary).toBe('make Access service tokens for prod: agent moi');
    const page = await (await fetch(`${base}/approve/${id}`)).text();
    expect(page).toContain('<li><code>agent moi</code></li>');

    const approved = await approve(id);
    expect(approved.status).toBe(200);
    expect(approved.text).not.toContain(SECRET);
    expect(runs.map((x) => x.mode)).toEqual(['plan', 'mint']);
    expect((runs[1] as Run).stdin.expect).toEqual({ 'agent moi': 'agent moi' });

    const done = await poll(id, r.body.pollToken as string);
    expect(done.result?.stdout).toContain(SECRET);
    next = { changes: 1, missing: {} };
  });

  it('is never run by a grant, and its input is dropped once it ran', async () => {
    runs.length = 0;
    next = { changes: 1, missing: {} };
    const r = await submit('apply');
    const id = r.body.id as string;
    expect(keeper.requests.get(id)?.status).toBe('pending');
    await approve(id);
    const call = keeper.requests.get(id)?.call;
    expect(call?.type === 'terraform' && call.input).toBe('');
  });

  it('with input the keeper cannot read is refused before anything runs', async () => {
    runs.length = 0;
    const r = await submit(
      'apply',
      'prod',
      JSON.stringify({ configs: {}, state: { accessKeyId: 'x' } }),
    );
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
