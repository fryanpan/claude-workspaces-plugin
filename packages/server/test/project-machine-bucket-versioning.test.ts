/**
 * Security review L5: the backup bucket keeps every version of an object, so
 * the machine's write-only credential, which may overwrite a snapshot whose
 * name it knows, cannot destroy one. The deploy turns versioning on, reads
 * whether it is on, and the lifecycle rule prunes the old versions on the
 * same clock as the current ones.
 *
 * The S3 calls go to a loopback server. Nothing reaches Tigris.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  type Observed,
  plan,
  projectConfig,
  requiredSecrets,
} from '../../../infra/project-machine/deploy-plan.ts';
import {
  hasLifecycle,
  hasVersioning,
  lifecycleXml,
  setVersioning,
  versioningXml,
} from '../../../infra/project-machine/tigris.ts';

const SHA = 'a'.repeat(40);
const cfg = projectConfig({ project: 'riverbend-test', imageLabel: SHA });

function complete(): Observed {
  return {
    app: true,
    volumes: 1,
    keychain: new Set([cfg.keychain.identity, cfg.keychain.bucketAdmin, cfg.keychain.writer]),
    lifecycle: true,
    versioning: true,
    secrets: new Set(requiredSecrets('quick')),
    machines: [{ id: 'm1', state: 'started', imageTag: SHA, memoryMb: 512 }],
    browser: true,
  };
}

describe('plan: bucket versioning', () => {
  it('turns versioning on for a new bucket, before the lifecycle rule', () => {
    const kinds = plan(cfg, {
      app: false,
      volumes: 0,
      keychain: new Set(),
      lifecycle: false,
      versioning: false,
      secrets: new Set(),
      machines: [],
      browser: true,
    }).map((a) => a.kind);
    expect(kinds.indexOf('set-versioning')).toBeGreaterThan(kinds.indexOf('create-bucket'));
    expect(kinds.indexOf('set-versioning')).toBeLessThan(kinds.indexOf('set-lifecycle'));
  });

  it('turns it on for an existing bucket that has it off, and touches nothing else', () => {
    expect(plan(cfg, { ...complete(), versioning: false })).toEqual([{ kind: 'set-versioning' }]);
  });

  it('leaves a bucket that has it on alone', () => {
    expect(plan(cfg, complete())).toEqual([]);
  });
});

describe('the lifecycle rule prunes old versions too', () => {
  it('expires noncurrent versions after the same days', () => {
    const xml = lifecycleXml('snapshots/', 30);
    expect(xml).toContain(
      '<NoncurrentVersionExpiration><NoncurrentDays>30</NoncurrentDays></NoncurrentVersionExpiration>',
    );
  });
});

describe('the versioning calls', () => {
  let server: ReturnType<typeof Bun.serve>;
  let state = '';
  let lifecycle = '';
  const puts: { body: string; md5: string | null }[] = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== '/cw-riverbend-test-backups') return new Response('', { status: 404 });
        if (url.searchParams.has('lifecycle')) return new Response(lifecycle);
        if (!url.searchParams.has('versioning')) return new Response('', { status: 400 });
        if (req.method === 'PUT') {
          puts.push({ body: await req.text(), md5: req.headers.get('content-md5') });
          return new Response('');
        }
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><VersioningConfiguration>${state}</VersioningConfiguration>`,
        );
      },
    });
  });
  afterAll(() => server.stop(true));

  const cred = () => ({
    endpoint: `http://127.0.0.1:${server.port}`,
    accessKeyId: 'test-id',
    secretAccessKey: 'test-secret',
  });

  it('reads a bucket that never had versioning as off', async () => {
    state = '';
    expect(await hasVersioning(cred(), 'cw-riverbend-test-backups')).toBe(false);
  });

  it('reads a suspended bucket as off', async () => {
    state = '<Status>Suspended</Status>';
    expect(await hasVersioning(cred(), 'cw-riverbend-test-backups')).toBe(false);
  });

  it('reads an enabled bucket as on', async () => {
    state = '<Status>Enabled</Status>';
    expect(await hasVersioning(cred(), 'cw-riverbend-test-backups')).toBe(true);
  });

  it('puts an Enabled configuration, with its MD5', async () => {
    await setVersioning(cred(), 'cw-riverbend-test-backups');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.body).toBe(versioningXml());
    expect(puts[0]?.body).toContain('<Status>Enabled</Status>');
    expect(puts[0]?.md5).toBeTruthy();
  });

  it('reads a lifecycle rule without the noncurrent expiry as missing', async () => {
    lifecycle =
      '<LifecycleConfiguration><Rule><Filter><Prefix>snapshots/</Prefix></Filter><Status>Enabled</Status><Expiration><Days>30</Days></Expiration></Rule></LifecycleConfiguration>';
    expect(await hasLifecycle(cred(), 'cw-riverbend-test-backups', 'snapshots/', 30)).toBe(false);
    lifecycle = lifecycleXml('snapshots/', 30);
    expect(await hasLifecycle(cred(), 'cw-riverbend-test-backups', 'snapshots/', 30)).toBe(true);
  });
});
