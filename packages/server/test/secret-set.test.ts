/**
 * `bun run secret:set` and `bun run signin:callbacks`.
 *
 * `security` on PATH is a stand-in that keeps each entry as a file in a temp
 * folder and records every argument list it is given, so a test can show the
 * value never reached argv. Nothing reaches the real Keychain.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TfOutputs } from '../../../infra/cloudflare/outputs.ts';
import { callbackLines } from '../../../infra/project-machine/signin-callbacks.ts';

const REPO = join(import.meta.dir, '..', '..', '..');
const SCRIPT = join(REPO, 'infra', 'project-machine', 'secret-set.ts');
const tmp = mkdtempSync(join(tmpdir(), 'secret-set-'));
const bin = join(tmp, 'bin');
const kc = join(tmp, 'keychain');
const argvLog = join(tmp, 'argv');
mkdirSync(bin);
writeFileSync(
  join(bin, 'security'),
  `#!/bin/sh
echo "$*" >> "${argvLog}"
if [ "$1" = "-i" ]; then
  while IFS= read -r line; do
    svc=$(printf '%s' "$line" | sed -n 's/.* -s \\([^ ]*\\) .*/\\1/p')
    b64=$(printf '%s' "$line" | sed -n 's/.* -w "\\(.*\\)"$/\\1/p')
    printf '%s' "$b64" | base64 -d > "${kc}/\${svc#claude-workspaces-secret.}"
  done
  exit 0
fi
svc=""; prev=""
for a in "$@"; do [ "$prev" = "-s" ] && svc="$a"; prev="$a"; done
[ -f "${kc}/\${svc#claude-workspaces-secret.}" ] || exit 44
exit 0
`,
);
chmodSync(join(bin, 'security'), 0o755);

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const run = (args: string[], input: string) => {
  // Never the CI path: no secret from the environment, no handoff.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => k !== 'CW_SECRETS_FROM_ENV' && !k.startsWith('CW_SECRET_'),
    ),
  );
  env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8', env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const stored = (entry: string) => {
  const f = join(kc, entry);
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
};
const argvSeen = () => (existsSync(argvLog) ? readFileSync(argvLog, 'utf8') : '');

describe('secret:set', () => {
  beforeEach(() => {
    rmSync(kc, { recursive: true, force: true });
    mkdirSync(kc);
    rmSync(argvLog, { force: true });
  });

  it('stores a piped value through stdin only, and prints only the entry', () => {
    const value = 'harborlight-client-secret-value';
    const r = run(['cw-google-signin-client-secret'], `${value}\n`);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('stored cw-google-signin-client-secret\n');
    expect(r.stderr).not.toContain(value);
    expect(stored('cw-google-signin-client-secret')).toBe(value);
    const seen = argvSeen();
    expect(seen).toContain('-i');
    expect(seen).not.toContain(value);
    expect(seen).not.toContain(Buffer.from(value).toString('base64'));
  });

  it('refuses an entry outside the sign-in list, asking the Keychain nothing', () => {
    const r = run(['fly-org-token'], 'riverbend-value\n');
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(argvSeen()).toBe('');
  });

  it('replaces an existing entry only with --replace', () => {
    expect(run(['cw-turnstile-site-key'], 'first-site-key\n').status).toBe(0);
    const again = run(['cw-turnstile-site-key'], 'second-site-key\n');
    expect(again.status).toBe(1);
    expect(again.stdout).toBe('');
    expect(stored('cw-turnstile-site-key')).toBe('first-site-key');
    const replaced = run(['cw-turnstile-site-key', '--replace'], 'second-site-key\n');
    expect(replaced.status).toBe(0);
    expect(replaced.stdout).toBe('stored cw-turnstile-site-key\n');
    expect(stored('cw-turnstile-site-key')).toBe('second-site-key');
  });

  it('refuses an empty value', () => {
    const r = run(['cw-google-signin-client-id'], '\n');
    expect(r.status).toBe(1);
    expect(stored('cw-google-signin-client-id')).toBeNull();
  });
});

describe('signin:callbacks', () => {
  const outputs = (): TfOutputs => ({
    access: { riverbend: { aud: 'aud-1', hosts: ['riverbend-workspaces.harborlight.test'] } },
    accessTeamDomain: 'team.harborlight.test',
    tunnels: {},
    routerRoutes: {},
  });

  it("lists the Mac and each project's sign-in host, as machine:deploy derives it", () => {
    const lines = callbackLines('workspaces.harborlight.test', ['riverbend', 'saltmarsh'], outputs);
    expect(lines).toEqual([
      'Authorized redirect URIs:',
      '  https://workspaces.harborlight.test/api/auth/callback/google    (the Mac)',
      '  https://riverbend-workspaces.harborlight.test/api/auth/callback/google    (riverbend)',
      'Authorized JavaScript origins:',
      '  https://workspaces.harborlight.test    (the Mac)',
      '  https://riverbend-workspaces.harborlight.test    (riverbend)',
      'Not listed:',
      '  saltmarsh: the Terraform state routes no host for saltmarsh (add it to router.local.json; bun run cf:sync-config)',
    ]);
  });

  it('lists a project with no Access application at its router host', () => {
    const lines = callbackLines('workspaces.harborlight.test', ['riverbend', 'saltmarsh'], () => ({
      ...outputs(),
      routerRoutes: { saltmarsh: 'saltmarsh-workspaces.harborlight.test/*' },
    }));
    expect(lines).toContain(
      '  https://saltmarsh-workspaces.harborlight.test/api/auth/callback/google    (saltmarsh)',
    );
    expect(lines).toContain('  https://saltmarsh-workspaces.harborlight.test    (saltmarsh)');
    // CONTROL: the existing project keeps its address, and nothing is unlisted.
    expect(lines).toContain('  https://riverbend-workspaces.harborlight.test    (riverbend)');
    expect(lines).not.toContain('Not listed:');
  });

  it('still lists the Mac when the Terraform outputs cannot be read', () => {
    const lines = callbackLines('workspaces.harborlight.test', ['riverbend'], () => {
      throw new Error('no state credential');
    });
    expect(lines[1]).toBe(
      '  https://workspaces.harborlight.test/api/auth/callback/google    (the Mac)',
    );
    expect(lines.at(-1)).toContain('could not read the Terraform outputs (no state credential)');
  });
});
