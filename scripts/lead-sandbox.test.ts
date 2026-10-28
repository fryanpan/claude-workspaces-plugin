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
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { escapeRows, keychainRow } from './lead-sandbox-escapes.ts';
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

/** A home whose `.claude`, `.local` and `dev` are symlinks onto a data volume, as on the owner's Mac. */
const fakeMachine: Machine = {
  home: HOME,
  uid: 501,
  realpath: (p) =>
    ['.claude', '.local', 'dev'].some((d) => p.startsWith(`${HOME}/${d}`))
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

  it('writes the wall itself, the prod root and the tmux sockets after every other rule', () => {
    const files = lines.filter((l) => /^\((allow|deny) file-(read|write)/.test(l));
    const metadata = files.filter((l) => l.includes('file-read-metadata')).length;
    expect(files.slice(-4 - metadata, files.length - metadata)).toEqual([
      '(deny file-read* file-write* (subpath "/etc/lead-sandbox.json"))',
      `(deny file-read* file-write* (subpath "${HOME}/Library/Application Support/claude-workspaces"))`,
      '(deny file-read* file-write* (subpath "/tmp/tmux-501"))',
      '(deny file-read* file-write* (subpath "/private/tmp/tmux-501"))',
    ]);
  });

  it("refuses the keychain unless the lead's config says allowKeychain", () => {
    const deny =
      '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd"))';
    expect(lines).toContain(deny);
    const own = parseConfig(
      { leads: [{ name: 'harborlight-lead', projects: ['/a'], allowKeychain: true }] },
      HOME,
    );
    if (!own.ok || !own.config.leads[0]) throw new Error('fixture refused');
    expect(rules(buildProfile(own.config.leads[0], own.config, fakeMachine))).not.toContain(deny);
    const bad = { leads: [{ name: 'harborlight-lead', projects: ['/a'], allowKeychain: 1 }] };
    expect(parseConfig(bad, HOME).ok).toBe(false);
  });

  it('leaves tmux reachable only for a lead whose config says allowTmux', () => {
    const own = parseConfig(
      { leads: [{ name: 'harborlight-lead', projects: ['/a'], allowTmux: true }] },
      HOME,
    );
    if (!own.ok || !own.config.leads[0]) throw new Error('fixture refused');
    const l = rules(buildProfile(own.config.leads[0], own.config, fakeMachine));
    expect(l.some((x) => x.includes('tmux-'))).toBe(false);
    expect(l).toContain('(deny lsopen)');
    expect(lines.some((x) => x.includes('tmux-'))).toBe(true); // the default
    const bad = { leads: [{ name: 'harborlight-lead', projects: ['/a'], allowTmux: 'yes' }] };
    expect(parseConfig(bad, HOME).ok).toBe(false);
  });

  it('refuses the tmux socket at both spellings, open and Apple events', () => {
    expect(lines).toEqual(
      expect.arrayContaining([
        '(deny network-outbound (remote unix-socket (subpath "/tmp/tmux-501")))',
        '(deny network-outbound (remote unix-socket (subpath "/private/tmp/tmux-501")))',
        '(deny lsopen)',
        '(deny appleevent-send)',
        '(deny mach-lookup (global-name "com.apple.siri.VoiceShortcuts.xpc"))',
      ]),
    );
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

  it("refuses writes to Claude Code's install and its launcher, at both ends, after every grant", () => {
    const wide = parseConfig(
      { leads: [{ name: 'harborlight-lead', projects: ['/a'], allow: [`${HOME}/.local`] }] },
      HOME,
    );
    if (!wide.ok || !wide.config.leads[0]) throw new Error('fixture refused');
    for (const l of [lines, rules(buildProfile(wide.config.leads[0], wide.config, fakeMachine))]) {
      const grant = Math.max(
        ...l.map((x, i) => (x.startsWith('(allow file-read* file-write* (subpath') ? i : -1)),
      );
      for (const end of [HOME, TWIN]) {
        expect(
          l.indexOf(`(deny file-write* (subpath "${end}/.local/share/claude"))`),
        ).toBeGreaterThan(grant);
        expect(
          l.indexOf(`(deny file-write* (literal "${end}/.local/bin/claude"))`),
        ).toBeGreaterThan(grant);
      }
      expect(l).not.toContain(
        `(allow file-read* file-write* (subpath "${TWIN}/.local/share/claude"))`,
      );
    }
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

  it("lets bun list its own project's parent, at both ends, and nothing below it", () => {
    for (const parent of [`${HOME}/dev`, `${TWIN}/dev`]) {
      const list = at(`(allow file-read-data (literal "${parent}"))`);
      expect(list, parent).toBeGreaterThan(at(`(subpath "${dirname(parent)}"))`));
      expect(lines).not.toContain(`(allow file-read* (subpath "${parent}"))`);
      expect(lines.some((l) => l.startsWith('(allow') && l.includes(`(subpath "${parent}")`))).toBe(
        false,
      );
    }
  });

  it("does not list a parent inside another lead's project", () => {
    const nested = parseConfig(
      {
        leads: [
          { name: 'harborlight-lead', projects: [`${HOME}/dev/harborlight/tools`] },
          { name: 'riverbend-lead', projects: [`${HOME}/dev/harborlight`] },
        ],
      },
      HOME,
    );
    if (!nested.ok || !nested.config.leads[0]) throw new Error('fixture refused');
    const l = rules(buildProfile(nested.config.leads[0], nested.config, fakeMachine));
    expect(l.some((x) => x.startsWith('(allow file-read-data'))).toBe(false);
  });

  it('checks every other lead and protected folder, and not its own project', () => {
    const t = checkTargets(harborlight, c, fakeMachine);
    expect(t.own).toEqual([`${HOME}/dev/harborlight`]);
    expect(t.protected).toEqual([HOME, TWIN, `${HOME}/dev/riverbend`]);
  });
});

const HAVE_SANDBOX = process.platform === 'darwin' && existsSync(SANDBOX_EXEC);
const HAVE_TMUX = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
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

  it('starts bun with its environment, and still cannot list a sibling project', () => {
    const bun = spawnSync(
      SANDBOX_EXEC,
      ['-f', profileFile, 'bun', '-e', 'console.log(Object.keys(process.env).length)'],
      { cwd: harborlight, encoding: 'utf8' },
    );
    expect(Number(bun.stdout.trim()), bun.stderr).toBeGreaterThan(0);
    const sibling = join(home, 'dev', 'saltmarsh');
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'notes.md'), 'saltmarsh\n');
    expect(sh(`ls '${join(home, 'dev')}'`).status).toBe(0); // the parent lists
    expect(sh(`ls '${sibling}'`).status).not.toBe(0);
    expect(sh(`cat '${sibling}/notes.md'`).status).not.toBe(0);
  });

  // The tmux row needs this user's own socket folder, so its uid is the real one.
  const escapesProfile = (drop?: RegExp) => {
    const text = buildProfile(lead, parsed.config, { ...m, uid: process.getuid?.() ?? 0 }, []);
    const file = join(root, `escapes-${drop ? 'mutated' : 'full'}.sb`);
    writeFileSync(
      file,
      text
        .split('\n')
        .filter((l) => !drop?.test(l))
        .join('\n'),
    );
    return escapeRows(file, harborlight, process.getuid?.() ?? 0);
  };

  it('cannot start a process outside the wall through tmux, open, osascript, shortcuts or launchd', () => {
    const rows = escapesProfile();
    expect(rows.filter((r) => !r.ok).map((r) => r.says)).toEqual([]);
    expect(rows).toHaveLength(5);
  }, 60_000);

  it('fails the row of each escape whose rule is removed (the mutation control)', () => {
    for (const [drop, row] of [
      [/network-outbound.*tmux/, 0],
      [/file-read\* file-write\* \(subpath "[^"]*tmux-/, 0],
      [/\(deny lsopen\)/, 1],
      [/\(deny appleevent-send\)/, 2],
      [/VoiceShortcuts/, 3],
    ] as const) {
      if (row === 0 && !HAVE_TMUX) continue;
      const rows = escapesProfile(drop);
      expect(rows[row]?.ok, `${drop}: ${rows[row]?.says}`).toBe(false);
      expect(rows.filter((r, i) => i !== row && !r.ok).map((r) => r.says)).toEqual([]);
    }
  }, 120_000);

  it('cannot read a keychain item, and can once the rule is removed', () => {
    const full = join(root, 'keychain-full.sb');
    const text = buildProfile(lead, parsed.config, m, []);
    writeFileSync(full, text);
    expect(keychainRow(full, harborlight)).toMatchObject({ ok: true });
    const mutated = join(root, 'keychain-mutated.sb');
    writeFileSync(mutated, text.replace(/^\(deny mach-lookup.*securityd.*$/m, ''));
    expect(keychainRow(mutated, harborlight).ok).toBe(false);
  }, 60_000);

  it('cannot read or rewrite the config or its own profile', () => {
    expect(sh(`cat '${configFile}'`).status).not.toBe(0);
    expect(sh(`echo '(allow default)' >> '${profileFile}'`).status).not.toBe(0);
  });
});
