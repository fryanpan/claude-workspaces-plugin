/**
 * The decisions `infra/project-machine/deploy.ts` makes before it touches
 * Fly, Tigris or the Keychain: what a project is called, which steps a run
 * still has to do, and how it reads what those services print. Nothing here
 * calls a network; the deploy itself was proved by running it (PR body).
 */
import { describe, expect, it } from 'bun:test';
import {
  type DrillPrint,
  type Observed,
  drillLimits,
  fingerprint,
  judgeDrill,
  logFingerprint,
  newestSnapshot,
  parseStorageCreate,
  plan,
  projectConfig,
  quickTunnelUrl,
  renderFlyToml,
  requiredSecrets,
  writeOnlyPolicy,
} from '../../../infra/project-machine/deploy-plan.ts';
import { signRequest } from '../../../infra/project-machine/sigv4.ts';
import { generateSnapshotKeys, recipientOf } from '../../../infra/project-machine/snapshot.ts';
import { lifecycleXml } from '../../../infra/project-machine/tigris.ts';

const SHA = 'a'.repeat(40);
const cfg = projectConfig({ project: 'riverbend-test', imageLabel: SHA });

function complete(): Observed {
  return {
    app: true,
    volumes: 1,
    keychain: new Set(Object.values(cfg.keychain)),
    lifecycle: true,
    secrets: new Set(requiredSecrets('quick')),
    machines: [{ id: 'm1', state: 'started', imageTag: SHA, memoryMb: 512 }],
  };
}

describe('projectConfig', () => {
  it('names every resource after the project', () => {
    expect(cfg.app).toBe('cw-riverbend-test');
    expect(cfg.network).toBe('cw-riverbend-test');
    expect(cfg.bucket).toBe('cw-riverbend-test-backups');
    expect(cfg.keychain.identity).toBe('cw-riverbend-test-backup-identity');
    expect(cfg.vmMemoryMb).toBe(512);
  });

  it('refuses a name that could not be a Fly app or a bucket', () => {
    for (const project of [
      'Riverbend',
      'rb',
      '-riverbend',
      'river_bend',
      'riverbend-',
      'a'.repeat(41),
    ]) {
      expect(() => projectConfig({ project, imageLabel: SHA })).toThrow('project name');
    }
  });

  it('refuses an image label that is not a full commit', () => {
    expect(() => projectConfig({ project: 'riverbend', imageLabel: 'HEAD' })).toThrow(
      'image label',
    );
  });

  it('refuses a size or tunnel mode outside what the script supports', () => {
    expect(() => projectConfig({ project: 'riverbend', imageLabel: SHA, vmMemoryMb: 100 })).toThrow(
      'memory',
    );
    expect(() => projectConfig({ project: 'riverbend', imageLabel: SHA, volumeGb: 0 })).toThrow(
      'volume',
    );
    expect(() =>
      projectConfig({ project: 'riverbend', imageLabel: SHA, tunnel: 'open' as never }),
    ).toThrow('tunnel');
  });
});

describe('plan', () => {
  it('does every step, in order, for a project that does not exist', () => {
    const actions = plan(cfg, {
      app: false,
      volumes: 0,
      keychain: new Set(),
      lifecycle: false,
      secrets: new Set(),
      machines: [],
    });
    expect(actions.map((a) => a.kind)).toEqual([
      'create-app',
      'create-volume',
      'make-backup-key',
      'create-bucket',
      'make-writer-key',
      'set-lifecycle',
      'set-secrets',
      'deploy',
    ]);
  });

  it('does nothing for a project that is complete', () => {
    expect(plan(cfg, complete())).toEqual([]);
  });

  it('only starts a machine that is stopped', () => {
    const obs = {
      ...complete(),
      machines: [{ id: 'm1', state: 'stopped', imageTag: SHA, memoryMb: 512 }],
    };
    expect(plan(cfg, obs)).toEqual([{ kind: 'start-machine', id: 'm1' }]);
  });

  it('redeploys a machine on another commit or another size', () => {
    const old = {
      ...complete(),
      machines: [{ id: 'm1', state: 'started', imageTag: 'b'.repeat(40), memoryMb: 512 }],
    };
    expect(plan(cfg, old)).toEqual([{ kind: 'deploy' }]);
    const big = {
      ...complete(),
      machines: [{ id: 'm1', state: 'started', imageTag: SHA, memoryMb: 2048 }],
    };
    expect(plan(cfg, big)).toEqual([{ kind: 'deploy' }]);
  });

  it('sets only the missing secret, then deploys so the machine reads it', () => {
    const secrets = new Set(requiredSecrets('quick').filter((n) => n !== 'BACKUP_RECIPIENT'));
    expect(plan(cfg, { ...complete(), secrets })).toEqual([
      { kind: 'set-secrets', names: ['BACKUP_RECIPIENT'] },
      { kind: 'deploy' },
    ]);
  });

  it('recreates a destroyed volume and machine without touching the keys', () => {
    const obs = { ...complete(), volumes: 0, machines: [] };
    expect(plan(cfg, obs)).toEqual([{ kind: 'create-volume' }, { kind: 'deploy' }]);
  });

  it('never makes a second key pair or bucket over existing Keychain entries', () => {
    const obs = { ...complete(), lifecycle: false };
    expect(plan(cfg, obs)).toEqual([{ kind: 'set-lifecycle' }]);
  });

  it('asks a named-tunnel machine for its tunnel token instead of the quick mode', () => {
    expect(requiredSecrets('named')).toContain('CLOUDFLARE_TUNNEL_TOKEN');
    expect(requiredSecrets('named')).not.toContain('CW_TUNNEL_MODE');
  });
});

describe('reading what the services print', () => {
  it('takes the bucket credential from fly storage create', () => {
    const out = [
      'Your Tigris project (cw-riverbend-test-backups) is ready.',
      'Set one or more of the following secrets on your target app.',
      'AWS_ENDPOINT_URL_S3: https://fly.storage.tigris.dev',
      'AWS_ACCESS_KEY_ID: tid_EXAMPLE',
      'AWS_SECRET_ACCESS_KEY: tsec_EXAMPLE',
      'AWS_REGION: auto',
      'BUCKET_NAME: cw-riverbend-test-backups',
    ].join('\n');
    expect(parseStorageCreate(out)).toEqual({
      endpoint: 'https://fly.storage.tigris.dev',
      accessKeyId: 'tid_EXAMPLE',
      secretAccessKey: 'tsec_EXAMPLE',
    });
  });

  it('fails on a partial credential without repeating any value', () => {
    let message = '';
    try {
      parseStorageCreate('AWS_ACCESS_KEY_ID: tid_EXAMPLE\n');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('AWS_ACCESS_KEY_ID');
    expect(message).not.toContain('tid_EXAMPLE');
  });

  it('reads the newest quick tunnel address from the logs', () => {
    const logs = [
      'INF |  https://first-old-name.trycloudflare.com  |',
      'INF Registered tunnel connection',
      'INF |  https://second-new-name.trycloudflare.com  |',
    ].join('\n');
    expect(quickTunnelUrl(logs)).toBe('https://second-new-name.trycloudflare.com');
    expect(quickTunnelUrl('nothing yet')).toBeNull();
  });

  it('picks the newest snapshot by its stamp, whichever machine wrote it', () => {
    expect(
      newestSnapshot([
        'snapshots/m2/2026-10-22T02-44-58Z-8be69c19.cwsnap',
        'snapshots/m1/2026-10-22T08-00-00Z-00000000.cwsnap',
        'snapshots/m1/2026-10-21T23-00-00Z-ffffffff.cwsnap',
        'snapshots/probe/2026-10-23T00-00-00Z.txt',
      ]),
    ).toBe('snapshots/m1/2026-10-22T08-00-00Z-00000000.cwsnap');
    expect(newestSnapshot([])).toBeNull();
  });
});

describe('fingerprint', () => {
  const a = { workspaceId: 'w-1', docId: 'd-1', text: 'Harborlight plan' };
  const b = { workspaceId: 'w-1', docId: 'd-2', text: 'Saltmarsh notes' };

  it('does not depend on the order docs were read in', () => {
    expect(fingerprint([a, b])).toEqual(fingerprint([b, a]));
    expect(fingerprint([a, b]).count).toBe(2);
  });

  it('changes when one word of one doc changes', () => {
    expect(fingerprint([a, { ...b, text: 'Saltmarsh note' }]).sha256).not.toBe(
      fingerprint([a, b]).sha256,
    );
  });
});

describe('what goes to Fly and Tigris', () => {
  it('writes the project and its size into fly.toml, replacing the [[vm]] block', () => {
    const base = [
      '# a comment naming [[vm]] must not be taken for the block',
      'app = "cw-project-placeholder"',
      'primary_region = "sjc"',
      '[[restart]]',
      '  policy = "always"',
      '[[vm]]',
      '  size = "shared-cpu-1x"',
      '  memory = "2gb"',
      '',
    ].join('\n');
    const out = renderFlyToml(
      base,
      projectConfig({ project: 'riverbend', imageLabel: SHA, region: 'iad', vmMemoryMb: 1024 }),
    );
    expect(out).toBe(
      [
        '# a comment naming [[vm]] must not be taken for the block',
        'app = "cw-riverbend"',
        'primary_region = "iad"',
        '[[restart]]',
        '  policy = "always"',
        '[[vm]]',
        '  size = "shared-cpu-1x"',
        '  memory = "1024mb"',
        '',
      ].join('\n'),
    );
  });

  it('grants the machine put under the prefix and nothing else', () => {
    expect(JSON.parse(writeOnlyPolicy('cw-riverbend-backups', 'snapshots/'))).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['s3:PutObject'],
          Resource: ['arn:aws:s3:::cw-riverbend-backups/snapshots/*'],
        },
      ],
    });
  });

  it('expires snapshots under the prefix after the given days', () => {
    const xml = lifecycleXml('snapshots/', 30);
    expect(xml).toContain('<Prefix>snapshots/</Prefix>');
    expect(xml).toContain('<Days>30</Days>');
    expect(xml).toContain('<Status>Enabled</Status>');
  });

  it("signs a request exactly as AWS's published SigV4 example does", () => {
    const headers = signRequest({
      method: 'GET',
      url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
      region: 'us-east-1',
      service: 'iam',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: '',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
  });

  it('derives the machine’s recipient from the stored identity alone', () => {
    const keys = generateSnapshotKeys();
    expect(recipientOf(keys.identity)).toBe(keys.recipient);
  });
});

describe("the drill's log comparison", () => {
  const events = { path: 'w-1.events.jsonl', text: '{"e":1}\n{"e":2}\n' };
  const transcript = { path: '-data-riverbend/s.jsonl', text: '{"type":"user"}\n' };

  it('hashes the prefix a backup held, so lines appended after it do not count', () => {
    const before = logFingerprint([events, transcript]);
    expect(before).toMatchObject({ files: 2, lines: 3 });
    const grown = { ...events, text: `${events.text}{"e":3}\n` };
    expect(logFingerprint([grown, transcript], before.linesByFile)).toEqual(before);
    expect(logFingerprint([grown, transcript]).sha256).not.toBe(before.sha256);
  });

  it('notices a lost or changed log', () => {
    const before = logFingerprint([events, transcript]);
    expect(logFingerprint([events], before.linesByFile).sha256).not.toBe(before.sha256);
    const edited = { ...transcript, text: '{"type":"assistant"}\n' };
    expect(logFingerprint([events, edited], before.linesByFile).sha256).not.toBe(before.sha256);
  });

  function print(over: Partial<DrillPrint> = {}): DrillPrint {
    const one = logFingerprint([events]);
    return {
      ...fingerprint([{ workspaceId: 'w-1', docId: 'd-1', text: 'Harborlight' }]),
      ydocs: 1,
      events: one,
      notes: one,
      transcripts: one,
      ...over,
    };
  }

  it('passes only when docs and all three logs came back the same', () => {
    expect(judgeDrill(print(), print()).ok).toBe(true);
    const lost = logFingerprint([], drillLimits(print()).transcripts);
    const verdict = judgeDrill(print(), print({ transcripts: lost }));
    expect(verdict.ok).toBe(false);
    expect(verdict.lines.find((l) => l.includes('transcripts'))).toStartWith('FAIL');
  });

  it('fails a log that was empty before the backup, since it proves nothing', () => {
    const empty = logFingerprint([]);
    expect(judgeDrill(print({ notes: empty }), print({ notes: empty })).ok).toBe(false);
  });
});
