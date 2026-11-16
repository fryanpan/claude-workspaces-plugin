/**
 * `lockDownState` (infra/cloudflare/terraform.ts) runs after every terraform
 * call in a work dir. That dir can hold a subdirectory: the sign-in test sets
 * `TF_DATA_DIR` inside it, and `init` writes its module manifest there. A
 * subdirectory set to 0600 loses its search bit, so the next `plan` cannot
 * open the manifest and the cleanup's `rm` fails with EACCES.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockDownState } from '../../../infra/cloudflare/terraform.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('lockDownState', () => {
  it('keeps files private and a nested data dir readable by its owner', () => {
    const work = mkdtempSync(join(tmpdir(), 'tf-lockdown-'));
    dirs.push(work);
    writeFileSync(join(work, 'backend.hcl'), 'bucket = "x"\n');
    const data = join(work, 'tf-data', 'modules');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'modules.json'), '{"Modules":[]}');

    lockDownState(work);

    expect(statSync(work).mode & 0o777).toBe(0o700);
    expect(statSync(join(work, 'backend.hcl')).mode & 0o777).toBe(0o600);
    expect(statSync(join(work, 'tf-data')).mode & 0o777).toBe(0o700);
    // The read terraform plan makes after init.
    expect(readFileSync(join(data, 'modules.json'), 'utf8')).toBe('{"Modules":[]}');
    // The cleanup deploy.ts runs once the dispatch ends.
    rmSync(work, { recursive: true, force: true });
    expect(() => statSync(work)).toThrow();
  });
});
