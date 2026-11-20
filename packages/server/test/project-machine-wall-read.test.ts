/**
 * The wall report's CI read (`infra/project-machine/wall-read.ts`) and the
 * Mac's side of it (`wall-read-pull.ts`): what CI reads and seals, what the
 * Mac will open, which runs it trusts, and when a read is too old to judge
 * by. Against stand-ins: nothing here calls Cloudflare, Fly or GitHub.
 */
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import type { TfOutputs } from '../../../infra/cloudflare/outputs.ts';
import { HANDOFF_REPO } from '../../../infra/handoff/mac-store.ts';
import { generateHandoffKeys } from '../../../infra/handoff/seal.ts';
import type { CloudflareApi } from '../../../infra/project-machine/cloudflare.ts';
import {
  MAX_AGE_MS,
  type WallReadPullIo,
  ciReadRow,
  pullWallRead,
} from '../../../infra/project-machine/wall-read-pull.ts';
import {
  type CloudflareRead,
  openWallRead,
  readCloudflare,
  readFly,
  sealWallRead,
} from '../../../infra/project-machine/wall-read.ts';

const ACCOUNT = 'f'.repeat(32);
const TUNNEL = '11111111-2222-4333-8444-555555555555';
const OUTPUTS: TfOutputs = {
  access: { riverbend: { aud: 'aud-riverbend', hosts: ['riverbend.harborlight.test'] } },
  accessTeamDomain: 'saltmarsh.cloudflareaccess.test',
  tunnels: {
    riverbend: {
      account_id: ACCOUNT,
      id: TUNNEL,
      name: 'cw-riverbend',
      origin: 'riverbend-origin.harborlight.test',
      public_host: 'riverbend.harborlight.test',
    },
  },
  routerRoutes: { riverbend: 'riverbend.harborlight.test/*' },
};

function cfRead(over: Partial<CloudflareRead> = {}): CloudflareRead {
  return {
    part: 'cloudflare',
    readAt: Date.UTC(2026, 10, 18),
    outputs: OUTPUTS,
    ingress: { [TUNNEL]: { ingress: [{ hostname: 'riverbend.harborlight.test' }] } },
    access: { apps: [{ name: 'riverbend', policies: [] }], tokenNames: [['t1', 'riverbend']] },
    plan: { status: 0, summary: 'No changes.\n' },
    ...over,
  };
}

/** A Cloudflare API stand-in that answers by path and records each one asked. */
function fakeApi(answers: Record<string, unknown>, asked: string[]): CloudflareApi {
  const api = (async (method: string, path: string) => {
    asked.push(`${method} ${path}`);
    if (!(path in answers)) throw new Error(`${method} ${path} failed (403)`);
    return answers[path];
  }) as CloudflareApi;
  api.all = async <T>(path: string) => {
    asked.push(`ALL ${path}`);
    if (!(path in answers)) throw new Error(`GET ${path} failed (403)`);
    return answers[path] as T[];
  };
  return api;
}

describe('what CI reads', () => {
  it('reads each tunnel, the Access applications and the plan, keeping only what the report judges', async () => {
    const asked: string[] = [];
    const read = await readCloudflare({
      outputs: () => OUTPUTS,
      api: fakeApi(
        {
          [`/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/configurations`]: {
            config: { ingress: [{ hostname: 'riverbend.harborlight.test', service: 'x' }] },
          },
          [`/accounts/${ACCOUNT}/access/apps`]: [
            {
              name: 'riverbend',
              aud: 'dropped',
              domain: 'dropped.harborlight.test',
              policies: [{ decision: 'allow', include: [{ everyone: {} }], id: 'dropped' }],
            },
          ],
          [`/accounts/${ACCOUNT}/access/service_tokens`]: [
            { id: 't1', name: 'riverbend', client_id: 'dropped' },
          ],
        },
        asked,
      ),
      plan: async () => ({ status: 0, summary: 'No changes.\n' }),
      now: () => 42,
    });
    expect(read.ingress[TUNNEL]).toEqual({
      ingress: [{ hostname: 'riverbend.harborlight.test', service: 'x' }],
    });
    expect(read.access).toEqual({
      apps: [{ name: 'riverbend', policies: [{ decision: 'allow', include: [{ everyone: {} }] }] }],
      tokenNames: [['t1', 'riverbend']],
    });
    expect(read.plan).toEqual({ status: 0, summary: 'No changes.\n' });
    expect(read.readAt).toBe(42);
    expect(asked).toEqual([
      `GET /accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/configurations`,
      `ALL /accounts/${ACCOUNT}/access/apps`,
      `ALL /accounts/${ACCOUNT}/access/service_tokens`,
    ]);
  });

  it('records a read that failed as unread, so the Mac fails its row rather than passing it', async () => {
    const read = await readCloudflare({
      outputs: () => OUTPUTS,
      api: fakeApi({}, []),
      plan: async () => ({ status: 1, summary: '' }),
      now: () => 1,
    });
    expect(read.ingress).toEqual({ [TUNNEL]: null });
    expect(read.access).toBeNull();
  });

  it('keeps each project app from fly apps list, and no other app', () => {
    expect(
      readFly(
        [
          { Name: 'cw-riverbend', Network: 'cw-riverbend' },
          { name: 'cw-harborlight', network: 'cw-harborlight' },
          { Name: 'saltmarsh-builder', Network: 'default' },
          { Name: 'cw-Bad Name' },
        ],
        7,
      ),
    ).toEqual({
      part: 'fly',
      readAt: 7,
      apps: [
        { Name: 'cw-riverbend', Network: 'cw-riverbend' },
        { Name: 'cw-harborlight', Network: 'cw-harborlight' },
      ],
    });
  });
});

describe('the sealed read', () => {
  const mac = generateHandoffKeys();

  it('opens with the Mac key to what CI read, and its text names no host', () => {
    const text = JSON.stringify(sealWallRead(mac.publicKey, cfRead()));
    expect(text).not.toContain('harborlight');
    expect(openWallRead(mac.privateKey, text, 'cloudflare')).toEqual(cfRead());
  });

  it('opens with no other key', () => {
    const text = JSON.stringify(sealWallRead(mac.publicKey, cfRead()));
    expect(() => openWallRead(generateHandoffKeys().privateKey, text, 'cloudflare')).toThrow(
      'does not open',
    );
  });

  it('opens only as the part it holds, outside and in', () => {
    const fly = sealWallRead(mac.publicKey, readFly([{ Name: 'cw-riverbend' }], 1));
    expect(() => openWallRead(mac.privateKey, JSON.stringify(fly), 'cloudflare')).toThrow(
      'a fly read, not cloudflare',
    );
    const relabelled = JSON.stringify({ ...fly, part: 'cloudflare' });
    expect(() => openWallRead(mac.privateKey, relabelled, 'cloudflare')).toThrow(
      'the envelope holds a fly read',
    );
    expect(() =>
      openWallRead(mac.privateKey, JSON.stringify({ ...fly, kind: 'keychain' }), 'fly'),
    ).toThrow('not a wall read');
  });
});

interface FakeRun {
  id: number;
  at: string;
  event?: string;
  repo?: string;
  /** The sealed file, or the stderr gh gives when it cannot download. */
  file?: string;
  error?: string;
}

function pullWorld(runs: FakeRun[], key: string) {
  const asked: string[] = [];
  const files = new Map<string, string>();
  let n = 0;
  const io: WallReadPullIo = {
    gh: (args) => {
      if (args[0] === 'api') {
        asked.push(`list ${args.find((a) => a.includes('/workflows/'))}`);
        const rows = runs.map((r) => ({
          id: r.id,
          created_at: r.at,
          event: r.event ?? 'schedule',
          head_branch: 'main',
          head_repository: { full_name: r.repo ?? HANDOFF_REPO },
        }));
        return { status: 0, stdout: JSON.stringify({ workflow_runs: rows }), stderr: '' };
      }
      asked.push(`download ${args[2]} ${args[args.indexOf('--name') + 1]}`);
      const run = runs.find((r) => String(r.id) === args[2]);
      if (!run?.file)
        return {
          status: 1,
          stdout: '',
          stderr: run?.error ?? 'no artifact matches any of the names or patterns provided',
        };
      files.set(join(args[args.indexOf('--dir') + 1] ?? '', 'cloudflare.json'), run.file);
      return { status: 0, stdout: '', stderr: '' };
    },
    privateKey: () => key,
    tempDir: () => `/fake/${++n}`,
    readFile: (p) => files.get(p) ?? '',
    listFiles: (d) =>
      [...files.keys()].filter((p) => p.startsWith(`${d}/`)).map((p) => p.slice(d.length + 1)),
    remove: (d) => {
      for (const p of [...files.keys()]) if (p.startsWith(`${d}/`)) files.delete(p);
    },
  };
  return { io, asked };
}

describe("the Mac's pull", () => {
  const mac = generateHandoffKeys();
  const sealed = (readAt: number) =>
    JSON.stringify(sealWallRead(mac.publicKey, cfRead({ readAt })));

  it('takes the newest trusted run that holds the part, past runs it cannot trust', () => {
    const w = pullWorld(
      [
        { id: 1, at: '2026-11-16', file: sealed(1) },
        { id: 2, at: '2026-11-17', file: sealed(2) },
        { id: 3, at: '2026-11-18' },
        { id: 4, at: '2026-11-19', event: 'pull_request', file: sealed(4) },
        { id: 5, at: '2026-11-19', repo: 'riverbend/fork', file: sealed(5) },
      ],
      mac.privateKey,
    );
    const got = pullWallRead(w.io, 'cloudflare');
    expect(got.runId).toBe('2');
    expect(got.read.readAt).toBe(2);
    expect(w.asked).toEqual([
      `list repos/${HANDOFF_REPO}/actions/workflows/wall-read.yml/runs`,
      'download 3 wall-read-cloudflare',
      'download 2 wall-read-cloudflare',
    ]);
  });

  it('says what to dispatch when no run holds a read it can open', () => {
    const other = generateHandoffKeys().publicKey;
    const w = pullWorld(
      [
        { id: 1, at: 'a', file: JSON.stringify(sealWallRead(other, cfRead())) },
        { id: 2, at: 'b', error: 'HTTP 404: Not Found' },
      ],
      mac.privateKey,
    );
    expect(() => pullWallRead(w.io, 'cloudflare')).toThrow(
      /run 2: gh run download failed; run 1: the envelope does not open with this key\): gh workflow run wall-read.yml --ref main/,
    );
  });
});

describe("each read's own row", () => {
  const now = Date.UTC(2026, 10, 19, 12);
  const pulled = (ageMs: number) => ({ runId: '9', read: { readAt: now - ageMs } });

  it('passes a read under 36 hours old and names its run', () => {
    expect(ciReadRow('cloudflare', pulled(3 * 3_600_000), now)).toEqual({
      project: '(all)',
      check: 'CI read of Cloudflare',
      answer: 'run 9, 3h old',
      ok: true,
    });
  });

  it('fails a stale read, a read from the future and a missing one', () => {
    expect(ciReadRow('fly', pulled(MAX_AGE_MS + 60_000), now).ok).toBe(false);
    expect(ciReadRow('fly', pulled(-3_600_000), now).ok).toBe(false);
    expect(ciReadRow('fly', new Error('no run'), now)).toEqual({
      project: '(all)',
      check: 'CI read of fly apps list',
      answer: 'no run',
      ok: false,
    });
  });
});
