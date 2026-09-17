/**
 * The plugin's hooks have to RUN from sessions that were not launched by an
 * interactive shell — launchd, a GUI app, cron — and they have to say so when
 * they cannot.
 *
 * Two silent failures, one layer apart, and these tests cover both:
 *
 *  - `hooks.json` used to say `bun run <script>`. bun lives in ~/.bun/bin and
 *    gets onto PATH from ~/.zshrc, so a bare name resolves interactively and
 *    nowhere else; every other session spawned the hook, got ENOENT, and the
 *    hook did nothing with nobody told.
 *  - A session launched without `CW_WORKSPACE_ID` runs the Stop hook, which
 *    exits 0 posting nothing — indistinguishable from a quiet turn. Four fleet
 *    agents sat like that for weeks.
 *
 * So every case here is written against the question "what would this
 * observable be if the feature were broken?". The commands are taken from
 * `hooks.json` and EXECUTED rather than string-matched, because a string match
 * would pass against an entry that names a script which does not exist; and
 * each positive case has a negative one beside it, because "produced no
 * output" is the failure mode under test and would otherwise pass vacuously.
 *
 * Fixtures are synthetic; the board id below is invented.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '../../..');
const PLUGIN_ROOT = resolve(REPO, 'packages/plugin');
const SHIM = resolve(PLUGIN_ROOT, 'bin/claude-workspaces-hook.sh');
const HOOKS_JSON = resolve(PLUGIN_ROOT, 'hooks/hooks.json');

/** A PATH with the usual system dirs and no bun — what launchd hands a process. */
const BUNLESS_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const CASE_TIMEOUT = 30_000;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function sh(command: string, env: Record<string, string>, stdin = ''): Promise<Run> {
  return new Promise((done) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: REPO,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      stderr += String(err);
      done({ code: null, stdout, stderr });
    });
    child.on('close', (code) => done({ code, stdout, stderr }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

interface HookEntry {
  event: string;
  command: string;
  /** The hook script the command is meant to reach. */
  script: string;
}

/** The hook script a command runs, read out of the shell string. Quote-aware
 *  rather than whitespace-split, because the paths hooks.json substitutes are
 *  quoted precisely so they may contain a space. */
const scriptIn = (command: string) =>
  (command.match(/"([^"]*\.ts)"/) ?? command.match(/(\S+\.ts)/))?.[1] ?? '';

function hookEntries(root = PLUGIN_ROOT): HookEntry[] {
  // audit: not-source — hooks.json is CONFIGURATION, and it is parsed here to
  // get the commands this file then executes; nothing asserts on its text.
  const config = JSON.parse(readFileSync(HOOKS_JSON, 'utf8')) as {
    hooks: Record<string, { hooks: { command: string }[] }[]>;
  };
  const out: HookEntry[] = [];
  for (const [event, matchers] of Object.entries(config.hooks)) {
    for (const matcher of matchers) {
      for (const h of matcher.hooks) {
        const command = h.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', root);
        out.push({ event, command, script: scriptIn(command) });
      }
    }
  }
  return out;
}

const ENTRIES = hookEntries();
const sessionStart = () => {
  const entry = ENTRIES.find((e) => e.event === 'SessionStart');
  if (!entry) throw new Error('hooks.json declares no SessionStart hook');
  return entry;
};

/** A HOME with no ~/.bun, and a BUN_INSTALL holding a bun that logs its argv
 *  before handing off to the real one. Nothing resolvable on PATH. */
let sandbox: { home: string; bunInstall: string; log: string; realBun: string };

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-hook-launch-'));
  const home = join(dir, 'home');
  const bunInstall = join(dir, 'bun-root');
  const log = join(dir, 'argv.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(bunInstall, 'bin'), { recursive: true });
  // The bun this suite was launched with — resolved through a shell rather
  // than assumed to be `process.execPath`, which is the test RUNNER (node
  // under vitest), not bun.
  const realBun = execFileSync('/bin/sh', ['-c', 'command -v bun'], { encoding: 'utf8' }).trim();
  if (realBun === '') throw new Error('no bun on PATH: this suite cannot build its fixture');
  const fake = join(bunInstall, 'bin', 'bun');
  writeFileSync(
    fake,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realBun)} "$@"\n`,
  );
  chmodSync(fake, 0o755);
  writeFileSync(log, '');
  sandbox = { home, bunInstall, log, realBun };
});

const bunlessEnv = (extra: Record<string, string> = {}) => ({
  PATH: BUNLESS_PATH,
  HOME: sandbox.home,
  BUN_INSTALL: sandbox.bunInstall,
  ...extra,
});

describe('hook interpreter resolution', () => {
  it(
    'a bare `bun run` cannot start a hook on a bun-less PATH',
    async () => {
      // Positive control for the two cases below: proves this harness can
      // detect a hook that never ran, so "it produced its report" is not a
      // vacuous pass. This is the literal command hooks.json used to carry.
      const { stdout, stderr } = await sh(`bun run ${sessionStart().script}`, {
        PATH: BUNLESS_PATH,
        HOME: sandbox.home,
      });
      expect(stdout).toBe('');
      expect(stderr).toMatch(/not found|ENOENT|No such file/i);
    },
    CASE_TIMEOUT,
  );

  it(
    'every hooks.json command reaches bun with no bun on PATH',
    async () => {
      // Each entry is RUN, not matched: an entry naming a script that does not
      // exist, or an event wired to the wrong file, fails here.
      for (const entry of ENTRIES) {
        expect(existsSync(entry.script), `${entry.event} names a missing script`).toBe(true);
        const { stderr } = await sh(entry.command, bunlessEnv());
        expect(stderr, `${entry.event} could not start`).not.toMatch(
          /not found|ENOENT|could not find a bun binary/i,
        );
      }
      const argv = readFileSync(sandbox.log, 'utf8');
      for (const entry of ENTRIES) {
        expect(argv, `${entry.event} never reached bun`).toContain(entry.script);
      }
    },
    CASE_TIMEOUT,
  );

  it(
    'survives a plugin root with a space in it',
    async () => {
      // The command is a shell string, so an unquoted ${CLAUDE_PLUGIN_ROOT}
      // splits on the space and the hook silently does nothing — the exact
      // failure class this PR is about, one install path away. ~/.claude/plugins
      // has no space today, which is why nobody has hit it and why only a test
      // can hold the quoting in place.
      const dir = mkdtempSync(join(tmpdir(), 'cw-hook-spaced-'));
      const spacedRoot = join(dir, 'plugin root');
      symlinkSync(PLUGIN_ROOT, spacedRoot);

      const entry = hookEntries(spacedRoot).find((e) => e.event === 'SessionStart');
      expect(entry?.script).toContain('plugin root');

      const { code, stdout } = await sh(
        entry?.command ?? '',
        bunlessEnv({ CW_AGENT_NAME: 'Harborlight' }),
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim()).hookSpecificOutput.additionalContext).toContain(
        'CW_WORKSPACE_ID',
      );
    },
    CASE_TIMEOUT,
  );
});

describe('the SessionStart report', () => {
  it(
    'tells a session launched with no board, through the wiring hooks.json declares',
    async () => {
      const { code, stdout } = await sh(
        sessionStart().command,
        bunlessEnv({ CW_AGENT_NAME: 'Harborlight' }),
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('CW_WORKSPACE_ID');
    },
    CASE_TIMEOUT,
  );

  it(
    'says nothing to a session that has one',
    async () => {
      // The discriminator. Without this case the one above would pass against a
      // hook that printed the same warning unconditionally, which is a
      // different defect and a worse one.
      const { code, stdout } = await sh(
        sessionStart().command,
        bunlessEnv({ CW_AGENT_NAME: 'Harborlight', CW_WORKSPACE_ID: 'w-board' }),
      );
      expect(code).toBe(0);
      expect(stdout.trim()).toBe('');
    },
    CASE_TIMEOUT,
  );
});

describe('the shim, when no bun exists anywhere', () => {
  it(
    'fails loudly to stderr AND into the agent context, and never blocks',
    async () => {
      // The fixed fallback locations are baked into the script and a CI runner
      // may have a real /usr/bin/bun, so the environment alone cannot produce
      // "no bun anywhere" portably. Run a copy with those paths redirected.
      const dir = mkdtempSync(join(tmpdir(), 'cw-hook-nobun-'));
      const original = readFileSync(SHIM, 'utf8');
      const stripped = original.replace(
        /^(\s*)(\/opt\/homebrew|\/usr\/local|\/usr)\/bin\/bun(\s*\\?)$/gm,
        '$1/nonexistent$2/bin/bun$3',
      );
      // Non-vacuity: a rewrite that matched nothing would leave this asserting
      // against the unmodified shim, which could never fail for the right reason.
      expect(stripped).not.toBe(original);
      expect(stripped).toContain('/nonexistent/usr/bin/bun');
      const copy = join(dir, 'shim.sh');
      writeFileSync(copy, stripped);

      const env = { PATH: join(dir, 'empty-bin'), HOME: dir };
      const script = sessionStart().script;
      const { code, stdout, stderr } = await sh(
        `/bin/sh ${JSON.stringify(copy)} --tell-agent ${JSON.stringify(script)}`,
        env,
      );

      // Never blocks the turn.
      expect(code).toBe(0);
      // Names the interpreter it looked for, where it looked, and what did not
      // run. PATH here points at a directory that does not exist — the state
      // this whole file exists for — and the first version of the shim built
      // this sentence with `tr`, so `tr: command not found` ate the
      // substitution and the report named no script and no location at all.
      // These three are what that regression would take away.
      expect(stderr).toContain('no bun binary could be found');
      expect(stderr).toContain('/opt/homebrew/bin');
      expect(stderr).toContain(`${dir}/.bun/bin`);
      expect(stderr).toContain(script);
      // And the report reaches the agent, not only a log nobody opens.
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('INSTALLED BUT INERT');
    },
    CASE_TIMEOUT,
  );

  it(
    'keeps stdout clean on the events whose stdout is a protocol channel',
    async () => {
      // Without --tell-agent the report is stderr-only: a Stop hook's stdout is
      // its decision, and a PreToolUse hook's is its permission verdict. A
      // diagnostic line there would be parsed as one of those.
      const dir = mkdtempSync(join(tmpdir(), 'cw-hook-nobun2-'));
      const stripped = readFileSync(SHIM, 'utf8').replace(
        /^(\s*)(\/opt\/homebrew|\/usr\/local|\/usr)\/bin\/bun(\s*\\?)$/gm,
        '$1/nonexistent$2/bin/bun$3',
      );
      const copy = join(dir, 'shim.sh');
      writeFileSync(copy, stripped);

      const { code, stdout, stderr } = await sh(
        `/bin/sh ${JSON.stringify(copy)} ${JSON.stringify(resolve(PLUGIN_ROOT, 'hooks/stop-note.ts'))}`,
        { PATH: join(dir, 'empty-bin'), HOME: dir },
      );
      expect(code).toBe(0);
      expect(stdout).toBe('');
      expect(stderr).toContain('no bun binary could be found');
    },
    CASE_TIMEOUT,
  );

  it(
    'runs clean with no HOME and no PATH at all',
    async () => {
      // cron and a sanitized launchd job hand over an environment with neither.
      // A bare $HOME under `set -u` would abort with "HOME: unbound variable",
      // which reads like a crash in exactly the case this shim exists for.
      const { stderr } = await sh(
        `/bin/sh ${JSON.stringify(SHIM)} ${JSON.stringify(sessionStart().script)}`,
        {},
      );
      expect(stderr).not.toMatch(/unbound variable|parameter not set/);
    },
    CASE_TIMEOUT,
  );
});
