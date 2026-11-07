/**
 * Typing into the lead's terminal. The pure half runs on a fake runner, and
 * reads the argv: what must never happen here is a free string reaching tmux.
 * The real half starts its own tmux server on a private socket with a fake
 * `claude` in each pane, and reads what those panes received. No test touches
 * the default socket.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentIdForName } from '@claude-workspaces/core/identity';
import {
  LeadPane,
  type Run,
  agentNameIn,
  claudeUnder,
  keysFor,
  parseProcs,
} from '../src/lead-chat/pane.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

const LEAD = 'Harborlight Lead';
const LEAD_ID = { agentId: agentIdForName(LEAD) };

/** tmux and ps, answered from a table; `calls` is every argv. */
function fakeRunner(opts: {
  panes?: string;
  procs?: string;
  env?: string;
  screen?: string;
  mode?: string;
}) {
  const calls: string[][] = [];
  const run: Run = async (argv) => {
    calls.push(argv);
    const verb = argv[1];
    if (verb === 'list-panes') return { code: 0, stdout: opts.panes ?? '%3 100\n' };
    if (verb === '-axww') {
      return { code: 0, stdout: opts.procs ?? '100 1 -zsh\n101 100 /bin/claude --resume\n' };
    }
    if (verb === 'eww') {
      return { code: 0, stdout: opts.env ?? `PID TT\n101 s0 claude HOME=/h CW_AGENT_NAME=${LEAD}` };
    }
    if (verb === 'display-message') return { code: 0, stdout: `${opts.mode ?? '0'}\n` };
    if (verb === 'capture-pane') return { code: 0, stdout: opts.screen ?? '> \n' };
    return { code: 0, stdout: '' };
  };
  return { run, calls, typed: () => calls.filter((c) => c[1] === 'send-keys') };
}

describe('keysFor', () => {
  it('builds only the allowlisted commands, effort first', () => {
    expect(keysFor({ model: 'opus', effort: 'high' })).toEqual(['/effort high', '/model opus']);
    expect(keysFor({ effort: 'max' })).toEqual(['/effort max']);
  });

  it('drops a value that came round the types', () => {
    const hostile = { model: 'opus; rm -rf /', effort: 'high\n/exit' } as never;
    expect(keysFor(hostile)).toEqual([]);
  });
});

describe('reading a pane', () => {
  it('finds the nearest claude under the pane, skipping its subagents', () => {
    const procs = parseProcs(
      [
        '100 1 -zsh',
        '101 100 /Users/x/.local/bin/claude --resume',
        '102 101 claude --subagent',
        '200 1 -zsh',
        '201 200 bun /tmp/fake/claude',
        '300 1 -zsh',
        '301 300 vim notes.md',
      ].join('\n'),
    );
    expect(claudeUnder(100, procs)).toBe(101);
    expect(claudeUnder(200, procs)).toBe(201);
    expect(claudeUnder(300, procs)).toBeNull();
  });

  it('reads a name with spaces and stops at the next variable', () => {
    const line = 'claude --x HOME=/h CW_AGENT_NAME=Harborlight Lead LANG=en PATH=/bin';
    expect(agentNameIn(line)).toBe('Harborlight Lead');
    expect(agentNameIn('claude FEEDBACK_AGENT_NAME=Riverbend TERM=xterm')).toBe('Riverbend');
    expect(agentNameIn('claude HOME=/h')).toBeNull();
    // An argument is not the environment.
    expect(agentNameIn('claude--CW_AGENT_NAME=x')).toBeNull();
  });
});

describe('sending', () => {
  const quick = { wait: async () => {} };

  it('types each command literally, then Enter, and only into the pane it found', async () => {
    const f = fakeRunner({});
    const pane = new LeadPane({ run: f.run, ...quick });
    expect(await pane.send(LEAD_ID, { model: 'sonnet', effort: 'low' })).toEqual({ ok: true });
    expect(f.typed()).toEqual([
      ['tmux', 'send-keys', '-t', '%3', '-l', '--', '/effort low'],
      ['tmux', 'send-keys', '-t', '%3', 'Enter'],
      ['tmux', 'send-keys', '-t', '%3', '-l', '--', '/model sonnet'],
      ['tmux', 'send-keys', '-t', '%3', 'Enter'],
    ]);
  });

  it('sends nothing to a pane running somebody else', async () => {
    const f = fakeRunner({ env: 'claude CW_AGENT_NAME=Riverbend' });
    const pane = new LeadPane({ run: f.run, ...quick });
    expect(await pane.send(LEAD_ID, { model: 'opus' })).toEqual({
      ok: false,
      problem: 'no-terminal',
    });
    expect(f.typed()).toEqual([]);
  });

  it('knows a lead by the name it attached under', async () => {
    const f = fakeRunner({ env: 'claude CW_AGENT_NAME=Riverbend Seat' });
    const pane = new LeadPane({ run: f.run, ...quick });
    const lead = { agentId: 'a-registered-apart', name: 'Riverbend Seat' };
    expect(await pane.send(lead, { effort: 'low' })).toEqual({ ok: true });
  });

  it('will not guess between two panes', async () => {
    const f = fakeRunner({
      panes: '%3 100\n%4 200\n',
      procs: '100 1 zsh\n101 100 claude\n200 1 zsh\n201 200 claude\n',
    });
    const pane = new LeadPane({ run: f.run, ...quick });
    expect(await pane.send(LEAD_ID, { model: 'opus' })).toEqual({
      ok: false,
      problem: 'many-terminals',
    });
    expect(f.typed()).toEqual([]);
  });

  it('leaves alone a screen showing a question, or a pane in copy mode', async () => {
    for (const opts of [
      { screen: 'Do you want to proceed?\n ❯ 1. Yes\n   2. No\n' },
      { screen: ' ❯ 1. Yes\n' },
      { screen: 'Esc to cancel\n' },
      { mode: '1' },
    ]) {
      const f = fakeRunner(opts);
      const pane = new LeadPane({ run: f.run, ...quick });
      expect(await pane.send(LEAD_ID, { model: 'opus' })).toEqual({ ok: false, problem: 'asking' });
      expect(f.typed()).toEqual([]);
    }
  });

  it('stops before the second command when a question appears after the first', async () => {
    let captures = 0;
    const f = fakeRunner({});
    const run: Run = async (argv) => {
      if (argv[1] === 'capture-pane' && ++captures === 2) {
        return { code: 0, stdout: 'Do you want to switch?\n' };
      }
      return f.run(argv);
    };
    const pane = new LeadPane({ run, ...quick });
    expect(await pane.send(LEAD_ID, { model: 'opus', effort: 'high' })).toEqual({
      ok: false,
      problem: 'asking',
    });
    expect(f.typed().flat()).not.toContain('/model opus');
  });

  it('says so when tmux will not answer', async () => {
    const pane = new LeadPane({ run: async () => ({ code: 1, stdout: '' }), ...quick });
    expect(await pane.send(LEAD_ID, { model: 'opus' })).toEqual({
      ok: false,
      problem: 'no-terminal',
    });
  });
});

const TMUX = Bun.which('tmux', { PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` });

/** A throwaway tmux server on a socket this file made. */
describe.skipIf(TMUX === null)('a real tmux, on a private socket', () => {
  let dir = '';
  let socket = '';
  const tmux = async (...args: string[]) => {
    const proc = Bun.spawn([TMUX as string, '-S', socket, ...args], {
      env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    expect(await proc.exited).toBe(0);
  };
  /** A fake `claude`: it writes each line it gets to its own log. It is bun
   *  because macOS hides the environment of its platform binaries from `ps`,
   *  which is true of /bin/sh and not of the real claude. */
  const start = async (session: string, agent: string) => {
    const script = join(dir, session, 'claude');
    await Bun.write(
      script,
      `const log = ${JSON.stringify(join(dir, `${session}.log`))};
const fs = require('node:fs');
fs.writeFileSync(log, '');
for await (const chunk of Bun.stdin.stream()) {
  fs.appendFileSync(log, Buffer.from(chunk).toString());
}
`,
    );
    await tmux(
      'new-session',
      '-d',
      '-s',
      session,
      '-e',
      `CW_AGENT_NAME=${agent}`,
      `exec ${process.execPath} ${script}`,
    );
    const log = join(dir, `${session}.log`);
    await waitFor(() => Bun.file(log).exists());
    return () => readFileSync(log, 'utf8');
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cw-pane-'));
    socket = join(dir, 's');
  });

  afterAll(async () => {
    const proc = Bun.spawn([TMUX as string, '-S', socket, 'kill-server'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  });

  it('reaches the lead’s pane and no other', async () => {
    const lead = await start('lead', LEAD);
    const other = await start('other', 'Riverbend Builder');
    const pane = new LeadPane({ socket, wait: (ms) => Bun.sleep(Math.min(ms, 50)) });
    expect(await pane.send(LEAD_ID, { model: 'haiku', effort: 'medium' })).toEqual({ ok: true });
    await waitFor(() => lead().includes('/model haiku'));
    expect(lead().split(/\r?\n/).filter(Boolean)).toEqual(['/effort medium', '/model haiku']);
    expect(other()).toBe('');
  });

  it('refuses a pane whose screen shows a question', async () => {
    const lead = await start('asking', 'Saltmarsh Lead');
    await tmux('send-keys', '-t', 'asking', '-l', 'Do you want to proceed?');
    const pane = new LeadPane({ socket, wait: async () => {} });
    await waitFor(async () => {
      const r = await pane.send({ agentId: agentIdForName('Saltmarsh Lead') }, { effort: 'low' });
      return !r.ok && r.problem === 'asking';
    });
    expect(lead()).not.toContain('/effort');
  });
});
