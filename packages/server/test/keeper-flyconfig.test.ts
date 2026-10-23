import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectConfig, renderFlyToml } from '../../../infra/project-machine/deploy-plan.ts';
import { cleanFlyConfig } from '../src/keeper/keeper-flyconfig.ts';

/** The deploy script's own fly.toml shape, as renderFlyToml writes it. */
const DEPLOYED = `# a comment
app = "cw-harborlight"
primary_region = "sjc"

[env]
  CW_DATA_DIR = "/data/cw"
  BACKUP_INTERVAL_HOURS = "6"

[mounts]
  source = "cw_data"
  destination = "/data"

[[restart]]
  policy = "always"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
`;

describe('cleanFlyConfig', () => {
  it("keeps the deploy script's config, rewritten from its parsed keys", () => {
    const r = cleanFlyConfig(DEPLOYED);
    if ('error' in r) throw new Error(r.error);
    expect(r.toml).not.toContain('# a comment');
    expect(Bun.TOML.parse(r.toml)).toEqual(Bun.TOML.parse(DEPLOYED));
  });

  it('keeps the fly.toml the deploy script writes from the one in infra/', () => {
    const base = readFileSync(
      join(import.meta.dir, '../../../infra/project-machine/fly.toml'),
      'utf8',
    );
    const written = renderFlyToml(
      base,
      projectConfig({
        project: 'harborlight',
        imageLabel: 'a'.repeat(40),
        region: 'sjc',
        vmMemoryMb: 512,
      }),
    );
    const r = cleanFlyConfig(written);
    if ('error' in r) throw new Error(r.error);
    expect(Bun.TOML.parse(r.toml)).toEqual(Bun.TOML.parse(written));
  });

  it.each([
    [
      '[[files]]\nguest_path = "/x"\nlocal_path = "/Users/cw-relay/keeper/state/credentials.json"\n',
    ],
    ['[build]\ndockerfile = "/Users/cw-relay/keeper/state/credentials.json"\n'],
    ['[build]\nignorefile = "/x"\n'],
    ['[http_service]\ninternal_port = 8080\n'],
    ['[mounts]\nsource = "v"\ndestination = "/d"\ninitial_size = "1gb"\n'],
    ['[[vm]]\nsize = "x"\nfile = "/y"\n'],
    ['[env]\n"A B" = "x"\n'],
    ['[env]\nA = 1\n'],
    ['app = ["x"]\n'],
    ['not toml at all ='],
  ])('refuses a key outside the allowlist: %j', (text) => {
    expect('error' in cleanFlyConfig(text)).toBe(true);
  });

  it('escapes what it writes, so a value cannot add a key', () => {
    const r = cleanFlyConfig('[env]\nA = "x\\"\\n[[files]]\\nlocal_path = \\"/etc/hosts"\n');
    if ('error' in r) throw new Error(r.error);
    expect(Bun.TOML.parse(r.toml)).toEqual({
      env: { A: 'x"\n[[files]]\nlocal_path = "/etc/hosts' },
    });
  });
});
