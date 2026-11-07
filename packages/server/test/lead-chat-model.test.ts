/**
 * Switching the lead's model from the board: when a pick is sent, who may
 * make one, and that an open page sees the change. The terminal is a fake
 * runner, so no test here can reach a real pane.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentIdForName } from '@claude-workspaces/core/identity';
import type { LeadChatModelFrame } from '@claude-workspaces/core/lead-chat';
import { leadModelLabel } from '@claude-workspaces/core/lead-chat';
import { type LeadModelPick, LeadModels } from '../src/lead-chat/lead-model.ts';
import type { PaneSend } from '../src/lead-chat/pane.ts';
import { pageStream } from './lead-chat-page-stream.ts';
import { type ShareProofServer, post, startShareProofServer } from './share-proof-harness.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

const BOARD = 'w-harbor';

function models(answers: PaneSend[] = []) {
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
          return answers.shift() ?? { ok: true };
        },
      },
      broadcast: (_ws, f) => frames.push(f),
    });
  return { m: make(), make, sent, frames, cleanup: () => rmSync(dir, { recursive: true }) };
}

describe('LeadModels', () => {
  it('holds a pick while the lead works and sends it when the turn ends', async () => {
    const t = models();
    t.m.turnStarted(BOARD);
    const held = await t.m.pick(BOARD, { model: 'opus' });
    expect(held.pending).toEqual({ model: 'opus' });
    expect(t.sent).toEqual([]);
    t.m.turnEnded(BOARD);
    await waitFor(() => t.sent.length === 1);
    expect(t.sent).toEqual([{ model: 'opus' }]);
    await waitFor(() => t.m.read(BOARD).pending === undefined);
    expect(t.m.read(BOARD).model).toBe('opus');
    t.cleanup();
  });

  it('sends nothing until a hook has said the lead is between turns', async () => {
    const t = models();
    await t.m.pick(BOARD, { effort: 'high' });
    expect(t.sent).toEqual([]);
    t.m.observed(BOARD, { started: true });
    await waitFor(() => t.sent.length === 1);
    t.cleanup();
  });

  it('sends at once when the lead is idle, and merges two picks made in a turn', async () => {
    const t = models();
    t.m.turnEnded(BOARD);
    await t.m.pick(BOARD, { effort: 'low' });
    expect(t.sent).toEqual([{ effort: 'low' }]);
    t.m.turnStarted(BOARD);
    await t.m.pick(BOARD, { model: 'haiku' });
    await t.m.pick(BOARD, { effort: 'max' });
    t.m.turnEnded(BOARD);
    await waitFor(() => t.sent.length === 2);
    expect(t.sent[1]).toEqual({ model: 'haiku', effort: 'max' });
    t.cleanup();
  });

  it('keeps a pick a question stopped, and retries it at the next turn end', async () => {
    const t = models([{ ok: false, problem: 'asking' }]);
    t.m.turnEnded(BOARD);
    const asked = await t.m.pick(BOARD, { model: 'opus' });
    expect(asked).toMatchObject({ pending: { model: 'opus' }, problem: 'asking' });
    t.m.turnEnded(BOARD);
    await waitFor(() => t.sent.length === 2);
    await waitFor(() => t.m.read(BOARD).problem === undefined);
    t.cleanup();
  });

  it('drops a pick with no terminal to go to, and says why', async () => {
    const t = models([{ ok: false, problem: 'no-terminal' }]);
    t.m.turnEnded(BOARD);
    const s = await t.m.pick(BOARD, { model: 'opus' });
    expect(s.pending).toBeUndefined();
    expect(s.problem).toBe('no-terminal');
    expect(s.model).toBeUndefined();
    t.m.turnEnded(BOARD);
    expect(t.sent).toHaveLength(1);
    t.cleanup();
  });

  it('a hook’s report replaces what was sent, and survives a restart', async () => {
    const t = models();
    t.m.turnEnded(BOARD);
    await t.m.pick(BOARD, { model: 'opus' });
    expect(t.m.read(BOARD).model).toBe('opus');
    t.m.observed(BOARD, { model: 'claude-opus-5-5', effort: 'high' });
    const again = t.make();
    expect(again.read(BOARD)).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
    t.cleanup();
  });

  it('sends a pick made while another send is out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-lead-model-'));
    const sent: LeadModelPick[] = [];
    let release: () => void = () => {};
    const m = new LeadModels({
      dataDir: dir,
      leadOf: () => ({ agentId: 'harborlight-lead' }),
      pane: {
        send: async (_id, pick) => {
          sent.push(pick);
          if (sent.length === 1) await new Promise<void>((r) => (release = r));
          return { ok: true };
        },
      },
      broadcast: () => {},
    });
    m.turnEnded(BOARD);
    const first = m.pick(BOARD, { model: 'opus' });
    await waitFor(() => sent.length === 1);
    await m.pick(BOARD, { model: 'haiku' });
    release();
    await first;
    await waitFor(() => sent.length === 2);
    expect(sent[1]?.model).toBe('haiku');
    await waitFor(() => m.read(BOARD).pending === undefined);
    rmSync(dir, { recursive: true });
  });

  it('after a restart, holds a pick until a hook says the lead is between turns', async () => {
    const t = models();
    t.m.turnEnded(BOARD);
    const again = t.make();
    await again.pick(BOARD, { model: 'opus' });
    expect(t.sent).toEqual([]);
    again.turnEnded(BOARD);
    await waitFor(() => t.sent.length === 1);
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
  const typed: string[][] = [];
  let s: ShareProofServer;
  const path = () => `${s.scope}/lead-chat/model`;

  beforeAll(async () => {
    s = await startShareProofServer('Harborlight', {
      leadPane: {
        wait: async () => {},
        run: async (argv) => {
          const verb = argv[1];
          if (verb === 'send-keys') typed.push(argv);
          if (verb === 'list-panes') return { code: 0, stdout: '%7 100\n' };
          if (verb === '-axww') return { code: 0, stdout: '100 1 zsh\n101 100 claude\n' };
          if (verb === 'eww') return { code: 0, stdout: `claude CW_AGENT_NAME=${LEAD}` };
          if (verb === 'display-message') return { code: 0, stdout: '0\n' };
          return { code: 0, stdout: '' };
        },
      },
    });
    s.handle.shareLinks.addToAudience(s.board, ['@harborlight.test'], 'Bryan');
    expect(await s.join(VISITOR)).toBe(302);
  });

  afterAll(() => s.stop());

  it('refuses every caller but the owner on the board’s page, before any lead', async () => {
    expect((await s.local(path(), post({ model: 'opus' }))).status).toBe(403);
    expect((await s.visitor(VISITOR, path(), post({ model: 'opus' }))).status).toBe(403);
    expect((await s.owner(path(), post({ model: 'opus' }), {})).status).toBe(403);
    expect((await s.owner(path(), post({ model: 'opus' }))).status).toBe(409);
    expect(typed).toEqual([]);
  });

  it('takes only allowlisted values, and sends them to the lead’s pane', async () => {
    s.handle.tasks.attachAgent(s.board, {
      agentId: LEAD_ID,
      agentName: LEAD,
      runtime: 'claude-code-local',
    });
    s.handle.tasks.setLeadAgent(s.board, LEAD_ID, {
      actor: { id: 'known-bryan', name: 'Bryan', kind: 'known' },
    });
    for (const bad of [
      {},
      { model: 'opus; rm -rf /' },
      { effort: 'high\n/exit' },
      { model: 'claude-opus-5-5' },
      { model: 'opus', effort: 'turbo' },
    ]) {
      expect((await s.owner(path(), post(bad))).status).toBe(400);
    }
    expect(typed).toEqual([]);

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

    const res = await s.owner(path(), post({ model: 'sonnet', effort: 'high' }));
    expect(res.status).toBe(200);
    expect(typed).toEqual([
      ['tmux', 'send-keys', '-t', '%7', '-l', '--', '/effort high'],
      ['tmux', 'send-keys', '-t', '%7', 'Enter'],
      ['tmux', 'send-keys', '-t', '%7', '-l', '--', '/model sonnet'],
      ['tmux', 'send-keys', '-t', '%7', 'Enter'],
    ]);

    // The next turn's reports replace what was sent.
    await report({ kind: 'model', model: 'claude-sonnet-5-5' });
    const snap = await (await s.owner(`${s.scope}/lead-chat`)).json();
    expect((snap as { leadModel: unknown }).leadModel).toEqual({
      model: 'claude-sonnet-5-5',
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
