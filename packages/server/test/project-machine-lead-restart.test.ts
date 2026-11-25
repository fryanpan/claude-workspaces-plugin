/**
 * Team Lead restarting a project machine's lead through the org relay.
 *
 * Two halves. The supervisor (`lead.sh supervise`, on the stubs and the
 * pretend clock of `project-machine-harness.ts`): when `lead-restart.ts`
 * prints `restart`, the session is ended and started again at once, with no
 * backoff; without the relay's two settings the check never runs. And the
 * decision itself (`pickRestart`): only a thread the relay's own board token
 * opened on this board, reading exactly the relay's restart line for THIS
 * lead, fresh and not handled before. That the relay writes the line, and the
 * check reads it off a real server, is `org-relay-kinds-two-servers.test.ts`.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type InboxThread,
  RESTART_MAX_AGE_MS,
  pickRestart,
} from '../../../infra/project-machine/lead-restart.ts';
import { BASH, lines, machineDir, stubs } from './project-machine-harness.ts';
import { waitFor } from './wait-for.ts';

const leadScript = join(machineDir, 'lead.sh');
const scratch = mkdtempSync(join(tmpdir(), 'machine-lead-restart-'));
const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) if (c.pid && c.exitCode === null) process.kill(-c.pid, 'SIGKILL');
  rmSync(scratch, { recursive: true, force: true });
});

/** The supervisor on the pretend clock, with a check that answers `restart`
 *  once for each `.restart` file a test leaves. */
function supervisor(env: Record<string, string>) {
  const s = stubs(scratch, '0', ['mkdir', 'ln'], {
    sleep: `echo "$1" >> "$CLOCK.sleeps"; echo $(( $(cat "$CLOCK") + $1 )) > "$CLOCK.$$"; /bin/mv "$CLOCK.$$" "$CLOCK"; exec /bin/sleep 0.01`,
    date: `if [ "$1" = +%s ]; then cat "$CLOCK"; else exec /bin/date "$@"; fi`,
    bun: `case "$*" in *lead-restart.ts*)
  echo "$CW_LEAD_INBOX_DOC $CW_RELAY_AGENT_ID" >> "$LOG/.checks"
  [ -e "$LOG/.hang" ] && exec /bin/sleep 1000
  if [ -e "$LOG/.restart" ]; then /bin/rm "$LOG/.restart"; echo restart; fi;;
esac
exit 0`,
    // coreutils timeout, as far as lead.sh uses it, on the real clock.
    timeout: `t=$1; shift
"$@" & p=$!
( /bin/sleep "$t"; kill "$p" 2>/dev/null ) </dev/null >/dev/null 2>&1 & w=$!
wait "$p"; s=$?
kill "$w" 2>/dev/null
exit $s`,
  });
  const clock = join(s.log, '.clock');
  writeFileSync(clock, '1000000\n');
  const home = join(s.root, 'home', 'lead');
  mkdirSync(home, { recursive: true });
  const child = spawn(BASH as string, [leadScript, 'supervise'], {
    env: {
      PATH: `${s.bin}:/usr/bin:/bin`,
      HOME: home,
      CLOCK: clock,
      LOG: s.log,
      CW_LEAD_ROOT: join(s.volume, 'lead'),
      CW_AGENT_NAME: 'riverbend-lead',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-fixture-riverbend-lead',
      ...env,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const out: string[] = [];
  child.stdout?.on('data', (d: Buffer) => out.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => out.push(d.toString()));
  const pids = () => lines(s.log, '.claude-pids').map(Number);
  const now = () => Number(readFileSync(clock, 'utf8'));
  return { ...s, child, out, pids, now };
}

const RELAY = { CW_LEAD_INBOX_DOC: 'task:t-inbox', CW_RELAY_AGENT_ID: 'agent-relay' };

describe.skipIf(BASH === null)('the supervisor and a requested restart', () => {
  it('ends the session and starts it again at once when the check says restart', async () => {
    const sup = supervisor(RELAY);
    await waitFor(() => sup.pids().length === 1, { timeout: 10_000, describe: 'the session' });
    // POSITIVE CONTROL: the check runs, with the relay's settings, and a
    // check that answers nothing leaves the session alone.
    await waitFor(() => lines(sup.log, '.checks').length >= 1, {
      timeout: 10_000,
      describe: 'a first check',
    });
    expect(lines(sup.log, '.checks')[0]).toBe('task:t-inbox agent-relay');
    expect(sup.pids()).toHaveLength(1);

    writeFileSync(join(sup.log, '.restart'), '');
    await waitFor(() => sup.pids().length === 2, {
      timeout: 10_000,
      describe: 'a second session',
    });
    const text = sup.out.join('');
    expect(text).toContain('restart requested through the relay; ending the session');
    expect(text).toContain('session ended for a requested restart; starting it again');
    // No backoff wait: a restart is not a quick end.
    expect(text).not.toMatch(/starting it again in \d+s/);
  }, 30_000);

  it('a check that hangs is cut off, so a session that ended is started again', async () => {
    const sup = supervisor({ ...RELAY, CW_LEAD_RESTART_CHECK_TIMEOUT: '1' });
    writeFileSync(join(sup.log, '.hang'), '');
    await waitFor(() => sup.pids().length === 1, { timeout: 10_000, describe: 'the session' });
    // The supervisor is now inside a check that never answers.
    await waitFor(() => lines(sup.log, '.checks').length >= 1, {
      timeout: 10_000,
      describe: 'a hung check',
    });
    process.kill(sup.pids()[0] as number, 'SIGKILL');
    await waitFor(() => sup.pids().length === 2, {
      timeout: 10_000,
      describe: 'a second session after the session ended',
    });
    expect(sup.out.join('')).not.toContain('restart requested through the relay');
  }, 30_000);

  it('never runs the check without the relay settings', async () => {
    const sup = supervisor({});
    await waitFor(() => sup.pids().length === 1, { timeout: 10_000, describe: 'the session' });
    const since = sup.now();
    // Twelve polls: two check intervals.
    await waitFor(() => sup.now() - since >= 60, {
      timeout: 10_000,
      describe: 'a minute on the pretend clock',
    });
    expect(existsSync(join(sup.log, '.checks'))).toBe(false);
    expect(sup.pids()).toHaveLength(1);
  }, 30_000);
});

describe('pickRestart', () => {
  const NOW = 2_000_000_000_000;
  const line = 'Relay restart request from team-lead for agent-riverbend-lead.';
  const thread = (id: string, over: Partial<InboxThread> = {}, text = line): InboxThread => ({
    id,
    comments: [{ text, ts: NOW - 1000 }],
    openerProof: { agentId: 'agent-relay', boardId: 'w-riverbend' },
    ...over,
  });
  const ctx = {
    boardId: 'w-riverbend',
    relayAgentId: 'agent-relay',
    ownAgentId: 'agent-riverbend-lead',
    handled: new Set<string>(),
    now: NOW,
  };

  it('acts on the relay’s line for this lead', () => {
    expect(pickRestart([thread('a')], ctx)).toEqual({ act: 'a', seen: ['a'] });
  });

  it('ignores a thread the relay’s token did not open, or opened on another board', () => {
    const threads = [
      thread('no-proof', { openerProof: null }),
      thread('lead-token', {
        openerProof: { agentId: 'agent-riverbend-lead', boardId: 'w-riverbend' },
      }),
      thread('other-board', { openerProof: { agentId: 'agent-relay', boardId: 'w-harbor' } }),
    ];
    expect(pickRestart(threads, ctx)).toEqual({ act: null, seen: [] });
  });

  it('ignores another lead’s restart and any other words', () => {
    const threads = [
      thread('other-lead', {}, 'Relay restart request from team-lead for agent-harborlight-lead.'),
      thread('quoted', {}, `Relay message from team-lead.\n\n> ${line}`),
    ];
    expect(pickRestart(threads, ctx)).toEqual({ act: null, seen: [] });
  });

  it('records a stale or handled request without acting on it', () => {
    const stale = thread('stale', { comments: [{ text: line, ts: NOW - RESTART_MAX_AGE_MS - 1 }] });
    expect(pickRestart([stale], ctx)).toEqual({ act: null, seen: ['stale'] });
    expect(pickRestart([thread('a')], { ...ctx, handled: new Set(['a']) })).toEqual({
      act: null,
      seen: [],
    });
  });
});
