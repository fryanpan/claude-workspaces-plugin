/**
 * How the keeper starts its Terraform run (`runTerraform`, `keeper-exec.ts`):
 * `keeper-run.ts` from the keeper's release, the token in an environment
 * built from nothing and never in an argument, one run at a time, and a
 * plain failure when the keeper holds no token or no terraform. A stand-in
 * `bun` records what it was given; nothing runs terraform.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keeperExecutors, runTerraform } from '../src/keeper/keeper-exec.ts';
import type { KeeperStore } from '../src/keeper/keeper-store.ts';

const tmp = mkdtempSync(join(tmpdir(), 'keeper-tf-exec-'));
const TOKEN = 'fixture-cf-token-Harborlight-000000';
const seen = join(tmp, 'seen');
const bun = join(tmp, 'bun');
// Records argv, cwd, env and stdin, one block per run, around a short pause.
writeFileSync(
  bun,
  `#!/bin/sh\n{ echo start; echo "ARGV $*"; echo "CWD $(pwd)"; env | sort; echo "STDIN $(cat)"; } >> "${seen}"\nsleep 0.2\necho end >> "${seen}"\necho '{"ok":true}'\n`,
);
chmodSync(bun, 0o755);
const setup = {
  root: tmp,
  terraformBin: '/Users/cw-relay/keeper/bin/terraform',
  workDir: join(tmp, 'work'),
  bunBin: bun,
};

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const storeWith = (apiToken?: string) =>
  ({ credentials: () => (apiToken ? { cloudflare: { apiToken } } : {}) }) as unknown as KeeperStore;

describe('runTerraform', () => {
  it('starts keeper-run.ts from the release with the token in its environment only', async () => {
    writeFileSync(seen, '');
    const r = await runTerraform(setup, '/Users/cw-relay', TOKEN, 'plan', 'prod', '{"x":1}');
    expect(r.status).toBe(0);
    const out = readFileSync(seen, 'utf8');
    const argv = out.split('\n').find((l) => l.startsWith('ARGV ')) ?? '';
    expect(argv).toBe(`ARGV ${join(tmp, 'infra', 'cloudflare', 'keeper-run.ts')} plan prod`);
    expect(argv).not.toContain(TOKEN);
    expect(out).toContain(`CLOUDFLARE_API_TOKEN=${TOKEN}`);
    expect(out).toContain('CW_TERRAFORM_BIN=/Users/cw-relay/keeper/bin/terraform');
    expect(out).toContain(`CW_TF_WORK_DIR=${join(tmp, 'work')}`);
    expect(out).toContain('PATH=/usr/bin:/bin');
    expect(out).toContain('STDIN {"x":1}');
    // Nothing of the keeper's own environment is passed on.
    expect(out).not.toContain('USER=');
  });
});

describe("the keeper's Terraform executor", () => {
  it('runs one at a time', async () => {
    writeFileSync(seen, '');
    const exec = keeperExecutors({
      store: storeWith(TOKEN),
      flyBin: '/bin/false',
      home: tmp,
      fetch: (async () => new Response('{}')) as never,
      terraform: setup,
    });
    await Promise.all([
      exec.terraform?.('plan', 'prod', '{}'),
      exec.terraform?.('plan', 'staging', '{}'),
    ]);
    const marks = readFileSync(seen, 'utf8')
      .split('\n')
      .filter((l) => l === 'start' || l === 'end');
    expect(marks).toEqual(['start', 'end', 'start', 'end']);
  });

  it('fails plainly without a token or without terraform', async () => {
    const noToken = keeperExecutors({
      store: storeWith(),
      flyBin: '/bin/false',
      home: tmp,
      fetch: (async () => new Response('{}')) as never,
      terraform: setup,
    });
    expect((await noToken.terraform?.('plan', 'prod', '{}'))?.stderr).toBe(
      'the keeper holds no Cloudflare token',
    );
    const noBin = keeperExecutors({
      store: storeWith(TOKEN),
      flyBin: '/bin/false',
      home: tmp,
      fetch: (async () => new Response('{}')) as never,
    });
    expect((await noBin.terraform?.('plan', 'prod', '{}'))?.stderr).toBe(
      'the keeper has no terraform',
    );
  });
});
