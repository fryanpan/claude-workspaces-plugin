/**
 * The lead's model on the board: what its hooks report, that an open page sees
 * it, and that switching is off, so nothing reaches a pane. The terminal is a
 * fake, so no test here can reach a real pane.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { agentIdForName } from '@claude-workspaces/core/identity';
import type { LeadChatModelFrame } from '@claude-workspaces/core/lead-chat';
import { leadModelLabel } from '@claude-workspaces/core/lead-chat';
import { type LeadModelPick, LeadModels } from '../src/lead-chat/lead-model.ts';
import { leadChatLogPath } from '../src/lead-chat/log.ts';
import { pageStream } from './lead-chat-page-stream.ts';
import { type ShareProofServer, post, startShareProofServer } from './share-proof-harness.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

const BOARD = 'w-harbor';

function models() {
  const dir = mkdtempSync(join(tmpdir(), 'cw-lead-model-'));
  const sent: LeadModelPick[] = [];
  const frames: LeadChatModelFrame[] = [];
  const make = () =>
    new LeadModels({
      dataDir: dir,
      leadOf: () => ({ agentId: 'harborlight-lead' }),
      pane: {
        send: async (_id, pick) => {
          sent.push(pick);
          return { ok: true };
        },
      },
      broadcast: (_ws, f) => frames.push(f),
    });
  /** The file a server built before switching went off left behind. */
  const seed = (held: unknown) => {
    const log = leadChatLogPath(dir, BOARD);
    if (!log) throw new Error('no path for the board');
    const path = log.replace(/\.lead-chat\.jsonl$/, '.lead-model.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(held));
    return path;
  };
  return { m: make(), make, seed, sent, frames, cleanup: () => rmSync(dir, { recursive: true }) };
}

describe('LeadModels', () => {
  it('sends nothing for a pick left on disk, and drops it at the turn end', async () => {
    const t = models();
    const path = t.seed({ model: 'opus', effort: 'high', pending: { model: 'haiku' } });
    const m = t.make();
    m.turnStarted(BOARD);
    m.turnEnded(BOARD);
    expect(m.read(BOARD)).toEqual({ model: 'opus', effort: 'high' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ model: 'opus', effort: 'high' });
    expect(t.frames.at(-1)?.state).toEqual({ model: 'opus', effort: 'high' });
    expect(t.sent).toEqual([]);
    t.cleanup();
  });

  it('sends nothing when a new session starts over a pick left on disk', async () => {
    const t = models();
    t.seed({ pending: { effort: 'max' }, problem: 'asking' });
    const m = t.make();
    m.observed(BOARD, { model: 'claude-fable-5-1', started: true });
    expect(m.read(BOARD)).toEqual({ model: 'claude-fable-5-1' });
    expect(t.sent).toEqual([]);
    t.cleanup();
  });

  it('a hook’s report survives a restart', () => {
    const t = models();
    t.m.observed(BOARD, { model: 'claude-opus-5-5', effort: 'high' });
    const again = t.make();
    expect(again.read(BOARD)).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
    t.cleanup();
  });

  it('tells pages each change that shows, not each turn', async () => {
    const t = models();
    t.m.turnStarted(BOARD);
    t.m.turnEnded(BOARD);
    expect(t.frames).toEqual([]);
    t.m.observed(BOARD, { effort: 'low' });
    expect(t.frames.at(-1)?.state.effort).toBe('low');
    t.m.observed(BOARD, { effort: 'low' });
    expect(t.frames).toHaveLength(1);
    t.cleanup();
  });
});

describe('leadModelLabel', () => {
  it('names an alias and a model id, and nothing it cannot read', () => {
    expect(leadModelLabel('opus')).toBe('Opus 5.5');
    expect(leadModelLabel('claude-fable-5-1')).toBe('Fable 5.1');
    expect(leadModelLabel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5');
    expect(leadModelLabel('claude-haiku-5-5-20261001')).toBe('Haiku 5.5');
    expect(leadModelLabel('gpt-9')).toBeNull();
    expect(leadModelLabel(undefined)).toBeNull();
  });
});

describe('the route', () => {
  const VISITOR = 'visitor@harborlight.test';
  const LEAD = 'Harborlight Lead';
  const LEAD_ID = agentIdForName(LEAD);
  const ran: string[][] = [];
  let s: ShareProofServer;
  const path = () => `${s.scope}/lead-chat/model`;

  beforeAll(async () => {
    s = await startShareProofServer('Harborlight', {
      leadPane: {
        wait: async () => {},
        run: async (argv) => {
          ran.push(argv);
          return { code: 0, stdout: '' };
        },
      },
    });
    s.handle.shareLinks.addToAudience(s.board, ['@harborlight.test'], 'Bryan');
    expect(await s.join(VISITOR)).toBe(302);
  });

  afterAll(() => s.stop());

  it('refuses every caller but the owner with a 403, and the owner with the switch off', async () => {
    expect((await s.local(path(), post({ model: 'opus' }))).status).toBe(403);
    expect((await s.visitor(VISITOR, path(), post({ model: 'opus' }))).status).toBe(403);
    expect((await s.owner(path(), post({ model: 'opus' }), {})).status).toBe(403);
    const off = await s.owner(path(), post({ model: 'opus' }));
    expect(off.status).toBe(409);
    expect(((await off.json()) as { error: string }).error).toBe('model-switch-off');
    expect(ran).toEqual([]);
  });

  it('shows an open page what the hooks report, and reaches no terminal', async () => {
    s.handle.tasks.attachAgent(s.board, {
      agentId: LEAD_ID,
      agentName: LEAD,
      runtime: 'claude-code-local',
    });
    s.handle.tasks.setLeadAgent(s.board, LEAD_ID, {
      actor: { id: 'known-bryan', name: 'Bryan', kind: 'known' },
    });
    const base = `http://127.0.0.1:${s.handle.port}`;
    const page = await pageStream(base, s.board);
    const agent = await pageStream(base, s.board, LEAD_ID);
    const report = (body: unknown) =>
      s.local(`${s.scope}/agents/${encodeURIComponent(LEAD)}/mirror`, post(body));

    // The session reports in: an open page sees it, and it is now between turns.
    const said = await report({ kind: 'model', model: 'claude-fable-5-1', started: true });
    expect(said.status).toBe(202);
    await waitFor(() => page.events.includes('lead-chat.model'), { timeout: 1000 });
    expect(agent.events).not.toContain('lead-chat.model');

    // With a lead between turns, every body gets the same answer.
    for (const body of [{}, { model: 'sonnet', effort: 'high' }, { model: 'opus; rm -rf /' }]) {
      const res = await s.owner(path(), post(body));
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('model-switch-off');
    }
    expect(ran).toEqual([]);

    await report({ kind: 'model', effort: 'high' });
    const snap = await (await s.owner(`${s.scope}/lead-chat`)).json();
    expect((snap as { leadModel: unknown }).leadModel).toEqual({
      model: 'claude-fable-5-1',
      effort: 'high',
    });
    page.close();
    agent.close();
  });

  it('refuses a report that is not a model id', async () => {
    const report = await s.local(
      `${s.scope}/agents/${encodeURIComponent(LEAD)}/mirror`,
      post({ kind: 'model', model: 'x"><script>' }),
    );
    expect(report.status).toBe(400);
  });

  it('does not show a share visitor the chat it lives in', async () => {
    expect((await s.visitor(VISITOR, `${s.scope}/lead-chat`)).status).toBe(403);
  });
});
