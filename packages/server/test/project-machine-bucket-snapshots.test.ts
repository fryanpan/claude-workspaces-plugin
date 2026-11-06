/**
 * Security review L5: the backup bucket keeps what an overwrite replaced, so
 * the machine's write-only credential, which may overwrite a snapshot whose
 * name it knows, cannot destroy one. Tigris does not implement
 * PutBucketVersioning (a real deploy got 501), so the deploy makes the bucket
 * a Tigris snapshot bucket, after removing any lifecycle rule, which Tigris
 * refuses to convert.
 *
 * The S3 calls go to a loopback server that answers the way the Tigris
 * requests are documented to. Nothing reaches Tigris.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  type Observed,
  plan,
  projectConfig,
  requiredSecrets,
} from '../../../infra/project-machine/deploy-plan.ts';
import {
  deleteLifecycle,
  enableSnapshots,
  hasLifecycle,
  hasSnapshots,
} from '../../../infra/project-machine/tigris.ts';

const SHA = 'a'.repeat(40);
const cfg = projectConfig({ project: 'riverbend-test', imageLabel: SHA });
const BUCKET = 'cw-riverbend-test-backups';

function complete(): Observed {
  return {
    app: true,
    volumes: 1,
    keychain: new Set([cfg.keychain.identity, cfg.keychain.bucketAdmin, cfg.keychain.writer]),
    snapshots: true,
    lifecycle: false,
    secrets: new Set(requiredSecrets('quick')),
    machines: [{ id: 'm1', state: 'started', imageTag: SHA, memoryMb: 512 }],
    browser: true,
  };
}

describe('plan: a snapshot bucket', () => {
  it('makes a new bucket a snapshot bucket right after creating it', () => {
    const kinds = plan(cfg, {
      app: false,
      volumes: 0,
      keychain: new Set(),
      snapshots: false,
      lifecycle: false,
      secrets: new Set(),
      machines: [],
      browser: true,
    }).map((a) => a.kind);
    expect(kinds.indexOf('enable-snapshots')).toBeGreaterThan(kinds.indexOf('create-bucket'));
    expect(kinds).not.toContain('remove-lifecycle');
  });

  it('converts an existing regular bucket, and touches nothing else', () => {
    expect(plan(cfg, { ...complete(), snapshots: false })).toEqual([{ kind: 'enable-snapshots' }]);
  });

  it("removes an older run's lifecycle rule before converting", () => {
    expect(plan(cfg, { ...complete(), snapshots: false, lifecycle: true })).toEqual([
      { kind: 'remove-lifecycle' },
      { kind: 'enable-snapshots' },
    ]);
  });

  it('leaves a snapshot bucket alone', () => {
    expect(plan(cfg, complete())).toEqual([]);
  });
});

describe('the bucket calls', () => {
  let server: ReturnType<typeof Bun.serve>;
  /** The stand-in bucket: its type, its lifecycle rules, and every request. */
  let type = 0;
  let rules = '';
  let patchAnswer: { status: number; body: string } | null = null;
  const seen: { method: string; query: string; body: string; type: string | null }[] = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url);
        const body = await req.text();
        seen.push({
          method: req.method,
          query: url.search,
          body,
          type: req.headers.get('content-type'),
        });
        if (url.pathname !== `/${BUCKET}`) return new Response('', { status: 404 });
        if (!req.headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256 '))
          return new Response('', { status: 403 });
        if (url.searchParams.has('versioning'))
          return new Response('<Error><Code>NotImplemented</Code></Error>', { status: 501 });
        if (url.searchParams.has('lifecycle')) {
          if (req.method === 'DELETE') {
            rules = '';
            return new Response('', { status: 204 });
          }
          return rules
            ? new Response(`<LifecycleConfiguration>${rules}</LifecycleConfiguration>`)
            : new Response('<Error><Code>NoSuchLifecycleConfiguration</Code></Error>', {
                status: 404,
              });
        }
        if (url.searchParams.has('metadata')) return Response.json({ name: BUCKET, type });
        if (req.method === 'PATCH') {
          if (patchAnswer) return new Response(patchAnswer.body, { status: patchAnswer.status });
          // Tigris refuses the switch while a lifecycle rule exists.
          if (rules)
            return Response.json(
              { status: 'error', message: 'bucket has lifecycle rules' },
              { status: 400 },
            );
          type = (JSON.parse(body) as { type: number }).type;
          return Response.json({ status: 'success' });
        }
        return new Response('', { status: 400 });
      },
    });
  });
  afterAll(() => server.stop(true));
  beforeEach(() => {
    type = 0;
    rules = '';
    patchAnswer = null;
    seen.length = 0;
  });

  const cred = () => ({
    endpoint: `http://127.0.0.1:${server.port}`,
    accessKeyId: 'test-id',
    secretAccessKey: 'test-secret',
  });

  it('reads a regular bucket as off and a snapshot bucket as on', async () => {
    expect(await hasSnapshots(cred(), BUCKET)).toBe(false);
    type = 1;
    expect(await hasSnapshots(cred(), BUCKET)).toBe(true);
  });

  it('converts the bucket with the SDK request, and the read sees it', async () => {
    await enableSnapshots(cred(), BUCKET);
    const patch = seen.find((r) => r.method === 'PATCH');
    expect(patch).toEqual({
      method: 'PATCH',
      query: '',
      body: '{"type":1}',
      type: 'application/json',
    });
    expect(await hasSnapshots(cred(), BUCKET)).toBe(true);
  });

  it('removes a lifecycle rule so the conversion is accepted', async () => {
    rules = '<Rule><ID>expire-snapshots</ID></Rule>';
    expect(await hasLifecycle(cred(), BUCKET)).toBe(true);
    await expect(enableSnapshots(cred(), BUCKET)).rejects.toThrow(/HTTP 400/);
    await deleteLifecycle(cred(), BUCKET);
    expect(await hasLifecycle(cred(), BUCKET)).toBe(false);
    await enableSnapshots(cred(), BUCKET);
    expect(await hasSnapshots(cred(), BUCKET)).toBe(true);
  });

  it('fails on a refusal, including a 200 whose body says error', async () => {
    patchAnswer = { status: 403, body: '<Error><Code>AccessDenied</Code></Error>' };
    await expect(enableSnapshots(cred(), BUCKET)).rejects.toThrow('HTTP 403: AccessDenied');
    patchAnswer = { status: 200, body: '{"status":"error","message":"not allowed"}' };
    await expect(enableSnapshots(cred(), BUCKET)).rejects.toThrow('not allowed');
    expect(await hasSnapshots(cred(), BUCKET)).toBe(false);
  });

  it('never asks for PutBucketVersioning, which Tigris answers 501', async () => {
    rules = '<Rule><ID>expire-snapshots</ID></Rule>';
    await hasSnapshots(cred(), BUCKET);
    await hasLifecycle(cred(), BUCKET);
    await deleteLifecycle(cred(), BUCKET);
    await enableSnapshots(cred(), BUCKET);
    expect(seen.some((r) => r.query.includes('versioning'))).toBe(false);
  });
});
