#!/usr/bin/env bun
/**
 * The coach's fixture days, played to a real coach session.
 *
 * `bun scripts/coach-eval.ts`
 *
 * The coach's judgement is its Claude Code session, so this runs one: a
 * print-mode `claude` on the coach's model, with the coaching skill as its
 * instructions, fed each line the real session would read. The lines come
 * from the real loop (`createCoach`, the stream's dedupe, and the MCP
 * child's `coachLine`), and a moment the session raises goes through the
 * server's own check (`raise`), so a moment with a bad quote is refused here
 * exactly as it would be on his page. A card it raises stays open until the
 * day moves him on, and the session reads that answer too.
 *
 * Two days, one session each:
 *
 *  1. The drifting day, scored at each labelled point (`LABELLED_POINTS`):
 *     a moment on the right goal where a good coach speaks, none where it
 *     stays quiet. A moment after a signal with no label is reported too.
 *  2. The on-track day: the moments it raised (zero is right).
 *
 * It also measures what a turn costs, since every event is one turn of this
 * session: the cost per event, from the CLI's own per-turn figures.
 *
 * Rehearsal differences, all in the session's instructions below: it has no
 * tools, so it answers with a moment's arguments as JSON, a memory line as
 * text, or `quiet`; its start-up reads are done for it.
 *
 * SPENDS MONEY, on the eval key: the key is resolved the way the server
 * resolves it outside prod (`claude-key-source.ts`) and handed to the child
 * as its environment, never printed. `--bare` keeps the child off this
 * machine's hooks, plugins, MCP servers and settings. Fixture text only.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coachLine } from '../packages/mcp/src/coach-line.ts';
import { claudeKeyServices } from '../packages/server/src/claude-key-source.ts';
import { readGoalsDoc } from '../packages/server/src/coach/goals-doc.ts';
import { createCoach } from '../packages/server/src/coach/moment.ts';
import type { SessionNews } from '../packages/server/src/coach/session-feed.ts';
import { MEMORY_TEMPLATE } from '../packages/server/src/coach/setup.ts';
import { CoachStore } from '../packages/server/src/coach/store.ts';
import { CoachStream } from '../packages/server/src/coach/stream.ts';
import { readKeychainPassword } from '../packages/server/src/share/keychain.ts';
import {
  DRIFTING_DAY,
  GOALS_DOC,
  LABELLED_POINTS,
  ON_TRACK_DAY,
  type Signal,
  WS,
  ZONE,
  at,
  label,
} from '../packages/server/test/coach-fixtures.ts';

const MODEL = 'claude-opus-5-5';
const SKILL = readFileSync(
  join(import.meta.dir, '../packages/plugin/skills/coaching/SKILL.md'),
  'utf8',
).replace(/^---[\s\S]*?---\n/, '');

const REHEARSAL = `
## This run is a rehearsal

You have no tools. Your start-up reads are done: both docs are in the first message. Answer every line with exactly one of:
- a coach_moment call, written as its arguments in one JSON object and nothing else, such as {"goal":1,"matched":"...","observed":"...","line":"..."};
- \`memory: <the line you would write>\`, for an answer or a preference;
- \`quiet\`.`;

function evalKey(): string | null {
  for (const service of claudeKeyServices(process.env)) {
    try {
      return readKeychainPassword(service);
    } catch {
      // Not there: try the next, then give up below.
    }
  }
  return null;
}

const key = evalKey();
if (!key) {
  console.error('No eval key in this process; nothing was sent.');
  process.exit(2);
}

interface Turn {
  reply: string;
  costUsd: number;
}

/** One coach session: a turn per `say`, and its cost. */
function session() {
  const proc = Bun.spawn(
    [
      'claude',
      '--bare',
      '-p',
      '--model',
      MODEL,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--tools',
      '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--append-system-prompt',
      `${SKILL}\n${REHEARSAL}`,
    ],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
      env: { ...process.env, ANTHROPIC_API_KEY: key ?? '' },
    },
  );
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let spent = 0;
  const nextResult = async (): Promise<Record<string, unknown>> => {
    for (;;) {
      const nl = buffered.indexOf('\n');
      if (nl >= 0) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.type === 'result') return msg;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('the session ended before answering');
      buffered += decoder.decode(value, { stream: true });
    }
  };
  return {
    async say(text: string): Promise<Turn> {
      proc.stdin.write(
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`,
      );
      await proc.stdin.flush();
      const r = await nextResult();
      // The figure is the session's running total; a turn is its step.
      const total = typeof r.total_cost_usd === 'number' ? r.total_cost_usd : spent;
      const costUsd = Math.max(0, total - spent);
      spent = Math.max(spent, total);
      return { reply: String(r.result ?? '').trim(), costUsd };
    },
    async close() {
      proc.stdin.end();
      await proc.exited;
    },
    get spent() {
      return spent;
    },
  };
}

const fmtTime = (t: number) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(t);

interface DayResult {
  /** Index of the signal after which each accepted moment was raised, and its goal. */
  moments: { after: number; goal: number; line: string }[];
  refused: { after: number; message: string }[];
  eventTurns: number;
  eventCostUsd: number;
  totalUsd: number;
}

async function playDay(name: string, day: readonly Signal[]): Promise<DayResult> {
  console.log(`\n== ${name}`);
  const dir = mkdtempSync(join(tmpdir(), 'coach-eval-'));
  const s = session();
  const result: DayResult = {
    moments: [],
    refused: [],
    eventTurns: 0,
    eventCostUsd: 0,
    totalUsd: 0,
  };
  try {
    let clock = at(8);
    const store = new CoachStore(dir, clock);
    store.noteTimeZone(ZONE);
    let queued: { news: SessionNews; at: number }[] = [];
    const coach = createCoach({
      store,
      stream: new CoachStream(),
      readGoals: () => readGoalsDoc(GOALS_DOC),
      label,
      boardName: () => 'Harborlight',
      workspaceOf: () => WS,
      tell: (news, t) => {
        queued.push({ news, at: t });
        return true;
      },
      publish: () => {},
      now: () => clock,
    });
    await s.say(`Learning goals:\n\n${GOALS_DOC}\n\nCoach memory:\n\n${MEMORY_TEMPLATE}`);
    for (const [i, signal] of day.entries()) {
      clock = signal.at;
      if ('here' in signal) coach.here(signal.here);
      else coach.activity(signal.row);
      const lines = queued;
      queued = [];
      for (const { news, at: t } of lines) {
        const line = coachLine(news.event, { ...news, at: t }, ZONE);
        if (!line) continue;
        const turn = await s.say(line);
        if (news.event === 'coach.event') {
          result.eventTurns += 1;
          result.eventCostUsd += turn.costUsd;
        }
        const shown = turn.reply.length > 120 ? `${turn.reply.slice(0, 117)}...` : turn.reply;
        console.log(`  [${i}] ${line.split('\n')[0]}\n      -> ${shown}`);
        const json = turn.reply.match(/\{[\s\S]*\}/)?.[0];
        if (!json || news.event !== 'coach.event') continue;
        let body: Record<string, unknown> | null = null;
        try {
          body = JSON.parse(json) as Record<string, unknown>;
        } catch {
          // Not JSON after all: counted as quiet.
        }
        const raised = coach.raise(body);
        if (raised.ok) {
          result.moments.push({ after: i, goal: Number(body?.goal), line: String(body?.line) });
        } else {
          result.refused.push({ after: i, message: `${raised.error}: ${raised.message}` });
          console.log(`      refused: ${raised.error}: ${raised.message}`);
        }
      }
    }
  } finally {
    await s.close();
    result.totalUsd = s.spent;
    rmSync(dir, { recursive: true, force: true });
  }
  return result;
}

const drifting = await playDay('the drifting day', DRIFTING_DAY);
let right = 0;
console.log('\n  at each labelled point:');
for (const point of LABELLED_POINTS) {
  const m = drifting.moments.find((x) => x.after === point.after);
  const said = m ? 'speak' : 'quiet';
  const ok = said === point.expect && (!m || m.goal - 1 === point.goalIndex);
  if (ok) right += 1;
  const when = DRIFTING_DAY[point.after]?.at ?? 0;
  console.log(
    `  ${ok ? 'right' : 'WRONG'} ${fmtTime(when)} expected ${point.expect}, got ${said}${m ? ` on goal ${m.goal}` : ''} (${point.why})`,
  );
}
const labelled = new Set(LABELLED_POINTS.map((p) => p.after));
const unlabelled = drifting.moments.filter((m) => !labelled.has(m.after));
console.log(`  ${right} of ${LABELLED_POINTS.length} labelled points right`);
console.log(`  moments after an unlabelled signal: ${unlabelled.length}`);

const onTrack = await playDay('the on-track day', ON_TRACK_DAY);
console.log(`\n  moments raised on the on-track day: ${onTrack.moments.length} (0 is right)`);

const turns = drifting.eventTurns + onTrack.eventTurns;
const perEvent = (drifting.eventCostUsd + onTrack.eventCostUsd) / Math.max(1, turns);
console.log(
  `\n== cost: $${(drifting.totalUsd + onTrack.totalUsd).toFixed(4)} for both days; ${turns} event turns at $${perEvent.toFixed(4)} each on average`,
);
