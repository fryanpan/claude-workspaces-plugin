import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Renders the real server template through render_plist, the function
 * install.sh calls, and parses the output with Python's plistlib. Parsing it
 * proves the rendered file is a valid plist and reads each key the way launchd
 * would, instead of matching text. install.sh itself is not run: it kills
 * whatever listens on :8787, which on this machine is production.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, 'render-plist.sh');
const DEFAULT_LABEL = 'com.fryanpan.claude-workspaces';
const TEMPLATE = join(HERE, `${DEFAULT_LABEL}.plist.template`);

type Plist = Record<string, unknown> & { EnvironmentVariables: Record<string, string> };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'render-plist-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function render(label: string): Plist {
  const out = join(dir, 'out.plist');
  execFileSync(
    'bash',
    [
      '-c',
      `set -euo pipefail; . "$LIB"; render_plist "$TEMPLATE" "$DEFAULT_LABEL" "$LABEL" > "$OUT"`,
    ],
    {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LIB,
        TEMPLATE,
        DEFAULT_LABEL,
        LABEL: label,
        OUT: out,
        HOME: '/synthetic/home',
        REPO_DIR: '/synthetic/repo',
        BUN_BIN: '/synthetic/bun/bin/bun',
        BUN_DIR: '/synthetic/bun/bin',
        DATA_DIR: '/synthetic/data',
        LOG_DIR: '/synthetic/logs',
        PUBLIC_BASE_URL: 'https://riverbend.example',
        REQUIRE_EMAIL_AUTH: '1',
        OWNER_EMAIL: 'alice@example.com',
        SHARE_PUBLIC_HOSTNAME: '',
        ACCESS_TUNNEL_HOSTS: '',
        PROXIED_TRUSTED_HOSTS: '',
        PROXIED_TRUSTED_EMAILS: '',
        ACCESS_TEAM_DOMAIN: '',
        ACCESS_AUD: '',
      },
    },
  );
  const json = execFileSync(
    'python3',
    [
      '-I',
      '-c',
      'import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1],"rb"))))',
      out,
    ],
    { encoding: 'utf8' },
  );
  return JSON.parse(json) as Plist;
}

describe('render_plist on the server template', () => {
  it('runs the job as Interactive, so launchd does not throttle its CPU and I/O', () => {
    expect(render(DEFAULT_LABEL).ProcessType).toBe('Interactive');
  });

  it('fills every placeholder', () => {
    const plist = render(DEFAULT_LABEL);
    expect(JSON.stringify(plist)).not.toContain('{{');
    expect(plist.WorkingDirectory).toBe('/synthetic/repo');
    expect(plist.ProgramArguments).toEqual([
      '/synthetic/bun/bin/bun',
      'run',
      'scripts/serve.ts',
      '--no-watch',
    ]);
    expect(plist.EnvironmentVariables.CW_DATA_DIR).toBe('/synthetic/data');
    expect(plist.EnvironmentVariables.CW_PUBLIC_BASE_URL).toBe('https://riverbend.example');
  });

  it('renames the label and its log files when another label is asked for', () => {
    const plist = render('com.example.harborlight');
    expect(plist.Label).toBe('com.example.harborlight');
    expect(plist.StandardErrorPath).toBe('/synthetic/logs/com.example.harborlight.err.log');
    expect(plist.ProcessType).toBe('Interactive');
  });
});
