/**
 * Typing a fixed slash command into the terminal of a board's lead.
 *
 * Claude Code has no outside door for switching a running session's model:
 * `/model` and `/effort` must arrive as keystrokes (the owner chose tmux for
 * this, 2026-11-03). That is the sharpest thing this server does, so the
 * rules are strict.
 *
 * - **Nothing a lead says picks the pane.** A walled lead is refused the tmux
 *   socket because a pane in reach is a way out of the wall (`security.md`),
 *   so a pane a lead named would hand that back. The server lists the panes
 *   itself, walks each one's process tree to its `claude`, and reads that
 *   process's own launch environment. A session cannot change the environment
 *   of a process in another pane. Exactly one pane must match, or nothing is
 *   sent. An env value is compared and dropped, never logged.
 * - **Nothing a person types reaches a pane.** `keysFor` takes the two
 *   allowlists from core and nothing else, and they go with `send-keys -l`,
 *   argv only, no shell.
 * - **Never at a question.** An Enter at a permission prompt approves it. The
 *   caller sends only between turns (`lead-model.ts`), and a subagent can
 *   still ask while the lead is idle, so the visible screen is read first and
 *   a pane in copy mode or showing a choice is left alone.
 *
 * tmux runs on this user's default socket, the one leads are started on. A
 * server that cannot reach it (a project machine, whose lead is another user)
 * finds no pane and says so.
 */
import { agentIdForName } from '@claude-workspaces/core/identity';
import {
  type LeadEffort,
  type LeadModelAlias,
  type LeadModelProblem,
  isLeadEffort,
  isLeadModelAlias,
} from '@claude-workspaces/core/lead-chat';

export type RunResult = { code: number; stdout: string };
export type Run = (argv: string[]) => Promise<RunResult>;

export interface LeadPaneDeps {
  run?: Run;
  /** A private tmux socket; tests start their own. */
  socket?: string;
  wait?: (ms: number) => Promise<void>;
}

const RUN_TIMEOUT_MS = 3_000;
/** Claude Code reads text arriving all at once as a paste, whose Enter is a
 *  newline, so the Enter waits. */
const KEY_GAP_MS = 300;
/** Between the two commands, for the first to finish. */
const COMMAND_GAP_MS = 500;
const PANE_ID = /^%\d+$/;
/** What a choice waiting on the screen looks like. */
const ASKING = /do you want|would you like|esc to cancel|\(y\/n\)|^\s*[❯>]\s*\d+\.\s/im;

/** Where tmux lives when the server's PATH is launchd's. */
const SEARCH_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].join(':');

const realRun: Run = async (argv) => {
  try {
    const proc = Bun.spawn(argv, {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined },
      timeout: RUN_TIMEOUT_MS,
    });
    const stdout = await new Response(proc.stdout).text();
    return { code: await proc.exited, stdout };
  } catch {
    return { code: 127, stdout: '' };
  }
};

/** The slash commands for a pick. Effort first: a switch of model can be
 *  answered by a prompt, and `/effort` on the current models is not. */
export function keysFor(pick: { model?: LeadModelAlias; effort?: LeadEffort }): string[] {
  const keys: string[] = [];
  if (isLeadEffort(pick.effort)) keys.push(`/effort ${pick.effort}`);
  if (isLeadModelAlias(pick.model)) keys.push(`/model ${pick.model}`);
  return keys;
}

interface Proc {
  pid: number;
  ppid: number;
  args: string;
}

export function parseProcs(out: string): Proc[] {
  const list: Proc[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) list.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] ?? '' });
  }
  return list;
}

/** `claude`, or an interpreter running a file named `claude`. */
const isClaude = (args: string): boolean =>
  args
    .split(/\s+/)
    .slice(0, 2)
    .some((w) => w.split('/').pop() === 'claude');

/** The first `claude` under `root`, nearest first: a session's own subagents
 *  sit below it and say nothing about which pane it is. */
export function claudeUnder(root: number, procs: readonly Proc[]): number | null {
  let level = [root];
  const seen = new Set(level);
  while (level.length > 0) {
    const next: number[] = [];
    for (const p of procs) {
      if (!level.includes(p.pid) && !level.includes(p.ppid)) continue;
      if (isClaude(p.args)) return p.pid;
      if (level.includes(p.ppid) && !seen.has(p.pid)) {
        seen.add(p.pid);
        next.push(p.pid);
      }
    }
    level = next;
  }
  return null;
}

/** The agent name in `ps eww` output. Values hold spaces, so a value runs to
 *  the next `NAME=`. The current name wins, as it does for the hooks. */
export function agentNameIn(psLine: string): string | null {
  const read = (key: string): string | null => {
    const m = psLine.match(new RegExp(` ${key}=(.*?)(?= [A-Za-z_][A-Za-z0-9_]*=|$)`, 's'));
    const v = m?.[1]?.trim();
    return v ? v : null;
  };
  return read('CW_AGENT_NAME') ?? read('FEEDBACK_AGENT_NAME');
}

/** A board's lead, matched the way `LeadChat.isLead` matches it. */
export interface LeadRef {
  agentId: string;
  name?: string;
}

export type PaneSend = { ok: true } | { ok: false; problem: LeadModelProblem };

export class LeadPane {
  private readonly run: Run;
  private readonly wait: (ms: number) => Promise<void>;
  private tmuxBin: string | null | undefined;

  constructor(private readonly deps: LeadPaneDeps = {}) {
    this.run = deps.run ?? realRun;
    this.wait = deps.wait ?? ((ms) => Bun.sleep(ms));
  }

  private tmux(args: string[]): Promise<RunResult> {
    if (this.tmuxBin === undefined) {
      this.tmuxBin = this.deps.run
        ? 'tmux'
        : Bun.which('tmux', { PATH: `${process.env.PATH ?? ''}:${SEARCH_PATH}` });
    }
    if (this.tmuxBin === null) return Promise.resolve({ code: 127, stdout: '' });
    const socket = this.deps.socket ? ['-S', this.deps.socket] : [];
    return this.run([this.tmuxBin, ...socket, ...args]);
  }

  /** The pane running `lead`, or why there is not exactly one. */
  private async find(
    lead: LeadRef,
  ): Promise<{ pane: string } | { problem: LeadModelProblem & string }> {
    const panes = await this.tmux(['list-panes', '-a', '-F', '#{pane_id} #{pane_pid}']);
    if (panes.code !== 0) return { problem: 'no-terminal' };
    const procs = await this.run(['ps', '-axww', '-o', 'pid=,ppid=,args=']);
    if (procs.code !== 0) return { problem: 'no-terminal' };
    const list = parseProcs(procs.stdout);
    const matches: string[] = [];
    for (const line of panes.stdout.split('\n')) {
      const [pane = '', pid = ''] = line.trim().split(' ');
      if (!PANE_ID.test(pane) || !/^\d+$/.test(pid)) continue;
      const claude = claudeUnder(Number(pid), list);
      if (claude === null) continue;
      const env = await this.run(['ps', 'eww', '-p', String(claude)]);
      if (env.code !== 0) continue;
      const name = agentNameIn(env.stdout);
      if (name && (agentIdForName(name) === lead.agentId || name === lead.name)) {
        matches.push(pane);
      }
    }
    if (matches.length === 0) return { problem: 'no-terminal' };
    if (matches.length > 1) return { problem: 'many-terminals' };
    return { pane: matches[0] as string };
  }

  /** Whether the pane can take keys now. */
  private async ready(pane: string): Promise<boolean> {
    const mode = await this.tmux(['display-message', '-p', '-t', pane, '#{pane_in_mode}']);
    if (mode.code !== 0 || mode.stdout.trim() !== '0') return false;
    const screen = await this.tmux(['capture-pane', '-p', '-t', pane]);
    return screen.code === 0 && !ASKING.test(screen.stdout);
  }

  /** Send a pick to the lead's pane. */
  async send(
    lead: LeadRef,
    pick: { model?: LeadModelAlias; effort?: LeadEffort },
  ): Promise<PaneSend> {
    const keys = keysFor(pick);
    if (keys.length === 0) return { ok: true };
    const found = await this.find(lead);
    if ('problem' in found) return { ok: false, problem: found.problem };
    for (const [i, line] of keys.entries()) {
      if (i > 0) await this.wait(COMMAND_GAP_MS);
      if (!(await this.ready(found.pane))) return { ok: false, problem: 'asking' };
      const typed = await this.tmux(['send-keys', '-t', found.pane, '-l', '--', line]);
      if (typed.code !== 0) return { ok: false, problem: 'send-failed' };
      await this.wait(KEY_GAP_MS);
      const entered = await this.tmux(['send-keys', '-t', found.pane, 'Enter']);
      if (entered.code !== 0) return { ok: false, problem: 'send-failed' };
    }
    return { ok: true };
  }
}
