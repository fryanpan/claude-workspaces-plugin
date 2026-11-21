/**
 * A project lead's spend on its Fly machine reaches budget watch on the Mac
 * (`infra/project-machine/lead-turns.ts` on the machine,
 * `machine-burn.ts` on the Mac, `machine:tokens burn`).
 *
 * Budget watch lives in the fleet repo and is not run here. `budgetWatchRead`
 * below is its read, restated: every `*.jsonl` under a folder of
 * `~/.claude/projects`, one count per request id, the four usage fields
 * summed, turns at or after the window's start, billed to the folder's name
 * (`window_burn`, `transcripts_under` and `project_of` in
 * `scripts/fleet_budget_watch.py`). If budget watch changes how it reads,
 * this restatement is what has to follow it.
 *
 * Nothing reaches Fly: `fly` is the token harness's stand-in, and the
 * machine's side runs here under stand-ins for `setpriv` and `timeout`.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { requiredSecrets } from '../../../infra/project-machine/deploy-plan.ts';
import { turnsSince } from '../../../infra/project-machine/lead-turns.ts';
import {
  KEEP_MS,
  burnReadCommand,
  parseTurns,
  pullBurn,
  pullProjectBurn,
} from '../../../infra/project-machine/machine-burn.ts';
import { runTokens } from '../../../infra/project-machine/tokens.ts';
import { repoRoot } from './project-machine-harness.ts';
import {
  appDir,
  flyCalls,
  flySecrets,
  tmp,
  useTokenStandIns,
} from './project-machine-token-harness.ts';

useTokenStandIns();

const NOW = Math.floor(Date.now() / 1000) * 1000;
const H = 3_600_000;
const TEXT = 'private-answer-text-riverbend';

/** A transcript line as Claude Code writes one for a content block of an answer. */
const answer = (
  at: number,
  requestId: string,
  usage: Record<string, number>,
  model = 'claude-opus-5-5',
) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    requestId,
    cwd: '/data/lead/work',
    message: {
      id: `msg_${requestId}`,
      model,
      role: 'assistant',
      content: [{ type: 'text', text: TEXT }],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        ...usage,
      },
    },
  });

/** A lead root as the machine has one: transcripts under claude-projects. */
function leadRoot(): string {
  const root = mkdtempSync(join(tmp, 'lead-root-'));
  const convo = join(root, 'claude-projects', '-data-lead-work');
  mkdirSync(join(convo, 'session-a', 'subagents'), { recursive: true });
  writeFileSync(
    join(convo, 'session-a.jsonl'),
    [
      JSON.stringify({
        type: 'user',
        timestamp: new Date(NOW - H).toISOString(),
        message: { content: TEXT },
      }),
      // Two content blocks of one request: counted once.
      answer(NOW - H, 'req_harbor1', {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 1000,
      }),
      answer(NOW - H, 'req_harbor1', {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 1000,
      }),
      answer(NOW - 30 * 60_000, 'req_harbor2', {
        input_tokens: 5,
        cache_creation_input_tokens: 400,
      }),
      // Before the window: not read.
      answer(NOW - 10 * 24 * H, 'req_harbor0', { input_tokens: 999_999 }),
      'not json',
    ].join('\n'),
  );
  writeFileSync(
    join(convo, 'session-a', 'subagents', 'agent-1.jsonl'),
    `${answer(NOW - 20 * 60_000, 'req_harbor3', { output_tokens: 70 }, 'claude-haiku-5-5')}\n`,
  );
  // A link the lead planted is not followed.
  const outside = join(tmp, 'outside.jsonl');
  writeFileSync(outside, `${answer(NOW - H, 'req_planted', { input_tokens: 5_000_000 })}\n`);
  symlinkSync(outside, join(convo, 'planted.jsonl'));
  return root;
}

/** `setpriv` and `timeout` stand-ins, so the read runs here as it would there. */
function machineStubs(): string {
  const stub = mkdtempSync(join(tmp, 'stub-'));
  writeFileSync(join(stub, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n');
  writeFileSync(
    join(stub, 'setpriv'),
    `#!/bin/sh\necho "$*" >> "${stub}/setpriv.log"\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`,
  );
  chmodSync(join(stub, 'timeout'), 0o755);
  chmodSync(join(stub, 'setpriv'), 0o755);
  return stub;
}

/** The machine: runs a read the way `fly ssh console` would, with ssh's banner first. */
function machine(root: string, stub: string) {
  const commands: string[] = [];
  const read = (_app: string, command: string) => {
    commands.push(command);
    // The command names the image's paths; here they are the repo and the fixture.
    const local = command.replace('/data/lead', root).replace(/\/app\//, `${repoRoot}/`);
    const path = `${stub}:${dirname(process.execPath)}:/usr/bin:/bin`;
    const r = spawnSync('sh', ['-c', local.replace(/PATH=\S+/, `PATH=${path}`)], {
      encoding: 'utf8',
    });
    return `Connecting to fdaa::3...\n${r.stdout}`;
  };
  return { read, commands };
}

interface Row {
  tokens: number;
  turns: number;
}

/** Budget watch's read of `projects`, restated (see the header): tokens per project since `cutoff`. */
function budgetWatchRead(projects: string, cutoff: number): Map<string, Row> {
  const rows = new Map<string, Row>();
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : n.endsWith('.jsonl') ? [p] : [];
    });
  for (const project of readdirSync(projects)) {
    for (const file of walk(join(projects, project))) {
      const seen = new Set<string>();
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        let o: {
          timestamp?: string;
          requestId?: string;
          message?: { id?: string; usage?: Record<string, number> };
        };
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        const t = Date.parse(o.timestamp ?? '');
        const u = o.message?.usage;
        if (!Number.isFinite(t) || t < cutoff || !u) continue;
        const rid = o.requestId ?? o.message?.id;
        if (rid !== undefined) {
          if (seen.has(rid)) continue;
          seen.add(rid);
        }
        const row = rows.get(project) ?? { tokens: 0, turns: 0 };
        row.tokens +=
          (u.input_tokens ?? 0) +
          (u.output_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0);
        row.turns += 1;
        rows.set(project, row);
      }
    }
  }
  return rows;
}

/** The Mac's ~/.claude/projects, with one session of its own. */
function macProjects(): string {
  const dest = mkdtempSync(join(tmp, 'mac-projects-'));
  const own = join(dest, '-Users-alice-dev-saltmarsh');
  mkdirSync(own);
  writeFileSync(
    join(own, 'mac-session.jsonl'),
    `${answer(NOW - H, 'req_mac1', { input_tokens: 2000 })}\n`,
  );
  return dest;
}

describe('the machine side', () => {
  it('prints each billed request once, as numbers, and no text', async () => {
    const turns = await turnsSince(join(leadRoot(), 'claude-projects'), NOW - 8 * 24 * H);
    expect(turns.map((t) => t.r)).toEqual(['req_harbor1', 'req_harbor2', 'req_harbor3']);
    expect(turns.map((t) => t.s)).toEqual([0, 0, 1]);
    expect(turns[0]).toMatchObject({ i: 10, o: 20, cc: 0, cr: 1000, m: 'claude-opus-5-5' });
    expect(JSON.stringify(turns)).not.toContain(TEXT);
  });

  it('runs as the lead', () => {
    const stub = machineStubs();
    const m = machine(leadRoot(), stub);
    const turns = parseTurns(
      m.read('cw-harborlight', burnReadCommand(NOW - 2 * H)),
      NOW - 2 * H,
      NOW,
    );
    expect(turns).toHaveLength(3);
    expect(readFileSync(join(stub, 'setpriv.log'), 'utf8')).toContain('--reuid=lead');
  });
});

describe('the Mac side', () => {
  it('puts the machine’s spend in what budget watch reads, beside the Mac’s own', () => {
    const dest = macProjects();
    const before = budgetWatchRead(dest, NOW - 5 * H);
    expect([...before.keys()]).toEqual(['-Users-alice-dev-saltmarsh']);

    const m = machine(leadRoot(), machineStubs());
    const [r] = pullBurn(['harborlight'], { dest, now: NOW, read: m.read });
    expect(r?.error).toBeUndefined();
    expect(r?.added).toBe(3);

    const after = budgetWatchRead(dest, NOW - 5 * H);
    // The Mac's row is unchanged, and the machine's is beside it.
    expect(after.get('-Users-alice-dev-saltmarsh')).toEqual({ tokens: 2000, turns: 1 });
    expect(after.get('cw-machine-harborlight')).toEqual({
      tokens: 10 + 20 + 1000 + 5 + 400 + 70,
      turns: 3,
    });
    expect(r?.lastFiveHours).toBe(1505);
    // Main sessions at the top, subagents below, where budget watch looks for each.
    const folder = join(dest, 'cw-machine-harborlight');
    expect(readFileSync(join(folder, 'lead.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(existsSync(join(folder, 'subagents', 'agents.jsonl'))).toBe(true);
    expect(statSync(join(folder, 'lead.jsonl')).mode & 0o777).toBe(0o600);
    for (const f of ['lead.jsonl', join('subagents', 'agents.jsonl')]) {
      expect(readFileSync(join(folder, f), 'utf8')).not.toContain(TEXT);
    }
  });

  it('pulls only what is new, counts nothing twice, and keeps eight days', () => {
    const dest = macProjects();
    const root = leadRoot();
    const m = machine(root, machineStubs());
    pullProjectBurn('harborlight', { dest, now: NOW, read: m.read });
    // An hour before the newest turn copied.
    const second = pullProjectBurn('harborlight', { dest, now: NOW, read: m.read });
    expect(second.added).toBe(0);
    expect(m.commands[1]).toContain(`lead-turns.ts /data/lead ${NOW - 20 * 60_000 - H}`);
    expect(budgetWatchRead(dest, NOW - 5 * H).get('cw-machine-harborlight')?.turns).toBe(3);

    // Nine days on, the old turns have gone and the folder stays.
    const later = pullProjectBurn('harborlight', { dest, now: NOW + 9 * 24 * H, read: m.read });
    expect(later.error).toBeUndefined();
    expect(m.commands[2]).toContain(`${NOW + 9 * 24 * H - KEEP_MS}`);
    expect(readFileSync(join(dest, 'cw-machine-harborlight', 'lead.jsonl'), 'utf8')).toBe('');
  });

  it('takes nothing but checked numbers from what a steered lead could write', () => {
    const good = { t: NOW - H, r: 'req_ok', m: 'claude-opus-5-5', s: 0, i: 1, o: 2, cc: 3, cr: 4 };
    const answerText = [
      'Connecting...',
      'cw-turns-start',
      JSON.stringify(good),
      JSON.stringify({ ...good, r: 'req_text', i: TEXT }),
      JSON.stringify({ ...good, r: 'req_huge', o: 1e300 }),
      JSON.stringify({ ...good, r: 'req_neg', cc: -5 }),
      JSON.stringify({ ...good, r: 'bad id\u001b[2J' }),
      JSON.stringify({ ...good, r: 'req_model', m: `x\u001b[2J${TEXT}` }),
      JSON.stringify({ ...good, r: 'req_future', t: NOW + 86_400_000 }),
      JSON.stringify({ ...good, r: 'req_old', t: NOW - 3 * H }),
      JSON.stringify({ ...good, r: 'req_sub', s: 2 }),
      TEXT,
    ].join('\n');
    const turns = parseTurns(answerText, NOW - 2 * H, NOW);
    expect(turns.map((t) => t.r)).toEqual(['req_ok']);
    expect(() => parseTurns('no marker here', 0, NOW)).toThrow('did not run the read');
  });

  it('a machine that does not answer costs its own row and leaves the copy as it was', () => {
    const dest = macProjects();
    const m = machine(leadRoot(), machineStubs());
    pullProjectBurn('harborlight', { dest, now: NOW, read: m.read });
    const copied = readFileSync(join(dest, 'cw-machine-harborlight', 'lead.jsonl'), 'utf8');
    const failed = pullProjectBurn('harborlight', {
      dest,
      now: NOW,
      read: () => {
        throw new Error('no machine answered');
      },
    });
    expect(failed.error).toContain('could not read');
    expect(readFileSync(join(dest, 'cw-machine-harborlight', 'lead.jsonl'), 'utf8')).toBe(copied);
  });

  it('machine:tokens burn reads each app with a lead over fly ssh, into ~/.claude/projects', async () => {
    const dest = macProjects();
    process.env.CW_BUDGET_PROJECTS_DIR = dest;
    try {
      flySecrets('harborlight', [...requiredSecrets('quick'), 'CW_LEAD_BOARD']);
      flySecrets('riverbend', requiredSecrets('quick'));
      const line = {
        t: NOW - H,
        r: 'req_fly1',
        m: 'claude-opus-5-5',
        s: 0,
        i: 7,
        o: 0,
        cc: 0,
        cr: 0,
      };
      writeFileSync(
        join(appDir('harborlight'), 'ssh-out'),
        `cw-turns-start\n${JSON.stringify(line)}\n`,
      );
      expect(await runTokens(['burn', '--project', 'harborlight'])).toBe(0);
      expect(flyCalls()).toContain('ssh console --app cw-harborlight');
      expect(flyCalls()).not.toContain('cw-riverbend');
      expect(budgetWatchRead(dest, NOW - 5 * H).get('cw-machine-harborlight')).toEqual({
        tokens: 7,
        turns: 1,
      });
      expect(await runTokens(['burn', '--every', '5'])).toBe(2);
    } finally {
      Reflect.deleteProperty(process.env, 'CW_BUDGET_PROJECTS_DIR');
    }
  });
});
