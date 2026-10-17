/**
 * The lead sandbox's profiles. The first half reads the generated text; the
 * second runs it under the real `/usr/bin/sandbox-exec` against throwaway
 * folders and skips, saying so, where there is none (Linux CI).
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type LeadSandboxConfig,
  type Machine,
  SANDBOX_EXEC,
  buildProfile,
  checkTargets,
  parseConfig,
  transcriptSlug,
} from './lead-sandbox-lib.ts';

const HOME = '/fixture/home/saltmarsh';
const TWIN = '/fixture/data/saltmarsh';

/** A home whose `.claude` and `dev` are symlinks onto a data volume, as on the owner's Mac. */
const fakeMachine: Machine = {
  home: HOME,
  uid: 501,
  realpath: (p) =>
    p.startsWith(`${HOME}/.claude`) || p.startsWith(`${HOME}/dev`)
      ? `${TWIN}${p.slice(HOME.length)}`
      : p,
};

function config(): LeadSandboxConfig {
  const parsed = parseConfig(
    {
      leads: [
        { name: 'harborlight-lead', projects: [`${HOME}/dev/harborlight`] },
        { name: 'riverbend-lead', projects: [`${HOME}/dev/riverbend`] },
      ],
      protect: [TWIN],
    },
    HOME,
  );
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.config;
}

/** The rule lines, in order, without comments. */
function rules(profile: string): string[] {
  return profile
    .split('\n')
    .filter((l) => l.startsWith('(') && !l.startsWith('(version'))
    .map((l) => l.replace(/ ; .*$/, ''));
}

describe('parseConfig', () => {
  it('refuses what would make a broken or a wider profile', () => {
    const lead = (extra: object) => ({ leads: [{ name: 'harborlight-lead', ...extra }] });
    expect(parseConfig({ leads: [] }, HOME).ok).toBe(false);
    expect(parseConfig(lead({}), HOME).ok).toBe(false); // no project
    expect(parseConfig(lead({ projects: ['dev/harborlight'] }), HOME).ok).toBe(false);
    expect(parseConfig(lead({ projects: ['/'] }), HOME).ok).toBe(false);
    expect(parseConfig(lead({ projects: ['/a/../b'] }), HOME).ok).toBe(false);
    expect(parseConfig(lead({ projects: ['/a"(allow default)'] }), HOME).ok).toBe(false);
    expect(parseConfig({ leads: [{ name: 'Harborlight Lead', projects: ['/a'] }] }, HOME).ok).toBe(
      false,
    );
    const twice = { name: 'harborlight-lead', projects: ['/a'] };
    expect(parseConfig({ leads: [twice, twice] }, HOME).ok).toBe(false);
    expect(parseConfig(lead({ projects: ['/a'] }), HOME).ok).toBe(true);
    const tilde = parseConfig(lead({ projects: ['~/dev/harborlight'] }), HOME);
    expect(tilde.ok && tilde.config.leads[0]?.projects).toEqual([`${HOME}/dev/harborlight`]);
  });
});

describe('buildProfile', () => {
  const c = config();
  const [harborlight] = c.leads;
  if (!harborlight) throw new Error('fixture has no lead');
  const profile = buildProfile(harborlight, c, fakeMachine, ['/etc/lead-sandbox.json']);
  const lines = rules(profile);
  const at = (needle: string) => lines.findIndex((l) => l.includes(needle));

  it('denies the home, the prod root and the other lead, at both ends of a symlink', () => {
    expect(lines).toContain(`(deny file-read* file-write* (subpath "${HOME}"))`);
    expect(lines).toContain(`(deny file-read* file-write* (subpath "${TWIN}"))`);
    expect(lines).toContain(
      `(deny file-read* file-write* (subpath "${HOME}/Library/Application Support/claude-workspaces"))`,
    );
    expect(lines).toContain(`(deny file-read* file-write* (subpath "${HOME}/dev/riverbend"))`);
    expect(lines).toContain(`(deny file-read* file-write* (subpath "${TWIN}/dev/riverbend"))`);
  });

  it('reopens its own project after the denies that cover it, so the own project wins', () => {
    const own = at(`(allow file-read* file-write* (subpath "${TWIN}/dev/harborlight"))`);
    expect(own).toBeGreaterThan(at(`(subpath "${TWIN}"))`));
    expect(own).toBeGreaterThan(at(`(subpath "${HOME}"))`));
  });

  it('denies other transcripts again inside ~/.claude and reopens only its own', () => {
    const claude = at(`(allow file-read* file-write* (subpath "${TWIN}/.claude"))`);
    const projects = at(`(deny file-read* file-write* (subpath "${TWIN}/.claude/projects"))`);
    const slug = transcriptSlug(`${TWIN}/dev/harborlight`);
    const mine = at(`projects/${slug}(`);
    expect(claude).toBeGreaterThan(at(`(subpath "${TWIN}"))`));
    expect(projects).toBeGreaterThan(claude);
    expect(mine).toBeGreaterThan(projects);
    expect(lines.some((l) => l.includes(transcriptSlug(`${TWIN}/dev/riverbend`)))).toBe(false);
  });

  it('writes the wall itself and the prod root after every other rule', () => {
    const lookups = lines.filter((l) => l.includes('file-read-metadata')).length;
    expect(lines.slice(-2 - lookups, lines.length - lookups)).toEqual([
      '(deny file-read* file-write* (subpath "/etc/lead-sandbox.json"))',
      `(deny file-read* file-write* (subpath "${HOME}/Library/Application Support/claude-workspaces"))`,
    ]);
  });

  it('refuses writes to what runs outside the sandbox, after every grant', () => {
    const claude = at(`(allow file-read* file-write* (subpath "${TWIN}/.claude"))`);
    for (const needle of [
      `(deny file-write* (literal "${TWIN}/.claude"))`,
      `(deny file-write* (subpath "${TWIN}/.claude/hooks"))`,
      `(deny file-write* (subpath "${HOME}/.claude/plugins"))`,
      `(deny file-write* (literal "${TWIN}/.claude/CLAUDE.md"))`,
      `(deny file-write* (regex #"^${TWIN}/\\.claude/settings[^/]*$"))`,
      `(deny file-write* (regex #"^${HOME}/\\.claude\\.json[^/]*$"))`,
    ])
      expect(at(needle)).toBeGreaterThan(claude);
    expect(
      lines.some(
        (l) => l.startsWith('(allow file-read* file-write* (regex') && l.includes('.claude\\.json'),
      ),
    ).toBe(false);
  });

  it('keeps the prod root shut when a lead is allowed the folder above it', () => {
    const wide = parseConfig(
      { leads: [{ name: 'harborlight-lead', projects: ['/a'], allow: [`${HOME}/Library`] }] },
      HOME,
    );
    if (!wide.ok || !wide.config.leads[0]) throw new Error('fixture refused');
    const l = rules(buildProfile(wide.config.leads[0], wide.config, fakeMachine));
    const prod = l.findIndex((x) => x.includes('Application Support/claude-workspaces'));
    expect(prod).toBeGreaterThan(l.findIndex((x) => x.includes(`(subpath "${HOME}/Library")`)));
  });

  it('checks every other lead and protected folder, and not its own project', () => {
    const t = checkTargets(harborlight, c, fakeMachine);
    expect(t.own).toEqual([`${HOME}/dev/harborlight`]);
    expect(t.protected).toEqual([HOME, TWIN, `${HOME}/dev/riverbend`]);
  });
});

const HAVE_SANDBOX = process.platform === 'darwin' && existsSync(SANDBOX_EXEC);
if (!HAVE_SANDBOX)
  console.warn(`lead-sandbox: ${SANDBOX_EXEC} is missing, so the real-sandbox cases skip.`);

describe.skipIf(!HAVE_SANDBOX)('the profile under the real sandbox-exec', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lead-sandbox-test-')));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const twin = join(root, 'twin');
  const harborlight = join(home, 'dev', 'harborlight');
  const riverbend = join(twin, 'dev', 'riverbend');
  const configFile = join(root, 'lead-sandbox.json');
  const claudeDir = join(home, '.claude');
  for (const d of [
    harborlight,
    riverbend,
    join(home, 'Library'),
    join(twin, 'secrets'),
    join(twin, '.claude', 'hooks'),
  ])
    mkdirSync(d, { recursive: true });
  // The owner's home links onto the data volume, as `~/.claude` does.
  symlinkSync(join(twin, 'secrets'), join(home, 'secrets'));
  symlinkSync(join(twin, '.claude'), claudeDir);
  const settings = join(claudeDir, 'settings.json');
  const claudeJson = join(home, '.claude.json');
  writeFileSync(settings, '{}\n');
  writeFileSync(claudeJson, '{}\n');
  // A link planted inside the lead's own project, pointing at another lead's.
  symlinkSync(riverbend, join(harborlight, 'riverbend-link'));
  writeFileSync(join(harborlight, 'README.md'), 'harborlight\n');
  writeFileSync(join(riverbend, 'notes.md'), 'riverbend\n');
  writeFileSync(join(twin, 'secrets', 'key'), 'not-a-real-key\n');
  writeFileSync(configFile, '{}\n');

  const m: Machine = {
    home,
    uid: 99999,
    realpath: (p) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    },
  };
  const parsed = parseConfig(
    {
      leads: [
        { name: 'harborlight-lead', projects: [harborlight] },
        { name: 'riverbend-lead', projects: [riverbend] },
      ],
      protect: [twin],
    },
    home,
  );
  if (!parsed.ok) throw new Error(parsed.error);
  const lead = parsed.config.leads[0];
  if (!lead) throw new Error('fixture has no lead');
  const profileFile = join(root, 'harborlight-lead.sb');
  writeFileSync(profileFile, buildProfile(lead, parsed.config, m, [configFile, profileFile]));

  const sh = (script: string) =>
    spawnSync(SANDBOX_EXEC, ['-f', profileFile, '/bin/sh', '-c', script], {
      cwd: harborlight,
      encoding: 'utf8',
    });

  it('reads, lists and writes its own project (the control)', () => {
    expect(sh(`cat '${harborlight}/README.md'`).stdout).toBe('harborlight\n');
    expect(sh(`ls '${harborlight}'`).status).toBe(0);
    expect(sh(`echo ok > '${harborlight}/new.txt' && cat '${harborlight}/new.txt'`).stdout).toBe(
      'ok\n',
    );
  });

  it("cannot list, read or write another lead's project", () => {
    expect(sh(`ls '${riverbend}'`).status).not.toBe(0);
    expect(sh(`cat '${riverbend}/notes.md'`).status).not.toBe(0);
    expect(sh(`echo x > '${riverbend}/planted.txt'`).status).not.toBe(0);
    expect(existsSync(join(riverbend, 'planted.txt'))).toBe(false);
  });

  it('cannot reach a protected folder through a symlink, from either end', () => {
    expect(sh(`cat '${harborlight}/riverbend-link/notes.md'`).status).not.toBe(0);
    expect(sh(`cat '${home}/secrets/key'`).status).not.toBe(0);
    expect(sh(`cat '${twin}/secrets/key'`).status).not.toBe(0);
    expect(sh(`ls '${home}'`).status).not.toBe(0);
  });

  it('cannot add a hook to the settings or an MCP server to ~/.claude.json', () => {
    const hook =
      '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch /tmp/x"}]}]}}';
    const mcp = '{"mcpServers":{"planted":{"command":"/bin/sh"}}}';
    expect(sh(`cat '${settings}' '${claudeJson}'`).stdout).toBe('{}\n{}\n'); // the control
    expect(sh(`echo '${hook}' > '${settings}'`).status).not.toBe(0);
    expect(sh(`echo '${hook}' > '${claudeDir}/settings.local.json'`).status).not.toBe(0);
    expect(sh(`echo '${mcp}' > '${claudeJson}'`).status).not.toBe(0);
    // Claude Code's own way of writing it: a temporary file renamed over it.
    expect(
      sh(`echo '${mcp}' > '${harborlight}/c.json' && mv '${harborlight}/c.json' '${claudeJson}'`)
        .status,
    ).not.toBe(0);
    expect(readFileSync(settings, 'utf8')).toBe('{}\n');
    expect(readFileSync(claudeJson, 'utf8')).toBe('{}\n');
    expect(existsSync(join(claudeDir, 'settings.local.json'))).toBe(false);
  });

  it('cannot plant code in ~/.claude by any other path, and still writes its transcript', () => {
    for (const plant of [
      `echo x > '${claudeDir}/hooks/run.sh'`,
      `mkdir -p '${claudeDir}/plugins/planted'`,
      `mkdir -p '${claudeDir}/skills/planted'`,
      `echo x > '${claudeDir}/CLAUDE.md'`,
      `echo x > '${twin}/.claude/CLAUDE.md'`,
      // Renamed away, edited and put back.
      `mv '${twin}/.claude' '${harborlight}/stash'`,
      `rm '${claudeDir}'`,
      // A second name for the settings file, inside the lead's own project.
      `ln '${settings}' '${harborlight}/settings.json'`,
    ])
      expect(sh(plant).status, plant).not.toBe(0);
    for (const p of ['hooks/run.sh', 'plugins/planted', 'skills/planted', 'CLAUDE.md'])
      expect(existsSync(join(twin, '.claude', p)), p).toBe(false);
    expect(existsSync(join(harborlight, 'settings.json'))).toBe(false);
    const own = join(claudeDir, 'projects', transcriptSlug(harborlight));
    expect(
      sh(`mkdir -p '${own}' && echo t > '${own}/s.jsonl' && echo h >> '${claudeDir}/history.jsonl'`)
        .status,
    ).toBe(0);
  });

  it('cannot read or rewrite the config or its own profile', () => {
    expect(sh(`cat '${configFile}'`).status).not.toBe(0);
    expect(sh(`echo '(allow default)' >> '${profileFile}'`).status).not.toBe(0);
  });
});
