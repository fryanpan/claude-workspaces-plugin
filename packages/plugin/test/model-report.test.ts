/**
 * The lead's session telling the board what it runs on, and the one question
 * the board's `/model` is let past.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { allowSwitch, decideModelReport, runModelReport } from '../hooks/lib/model-report.ts';
import { markLead } from '../hooks/lib/session-mirror.ts';

const dir = mkdtempSync(join(tmpdir(), 'cw-model-report-'));
markLead('s-lead', true, dir);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('decideModelReport', () => {
  it('reports a session start from anybody: the server knows who the lead is', () => {
    expect(
      decideModelReport(
        { hook_event_name: 'SessionStart', session_id: 's-new', model: 'claude-opus-5-5' },
        dir,
      ),
    ).toEqual({ kind: 'model', started: true, model: 'claude-opus-5-5' });
    expect(decideModelReport({ hook_event_name: 'SessionStart', model: 'x y' }, dir)).toEqual({
      kind: 'model',
      started: true,
    });
  });

  it('reports a switch and an effort for the lead alone', () => {
    const lead = { session_id: 's-lead' };
    expect(
      decideModelReport(
        { ...lead, hook_event_name: 'PostModelSwitch', to_model: 'claude-haiku-5-5' },
        dir,
      ),
    ).toEqual({ kind: 'model', model: 'claude-haiku-5-5' });
    expect(
      decideModelReport({ ...lead, hook_event_name: 'Stop', effort: { level: 'high' } }, dir),
    ).toEqual({ kind: 'model', effort: 'high' });
    expect(
      decideModelReport(
        { session_id: 's-other', hook_event_name: 'Stop', effort: { level: 'high' } },
        dir,
      ),
    ).toBeUndefined();
    expect(decideModelReport({ ...lead, hook_event_name: 'Stop' }, dir)).toBeUndefined();
  });

  it('ignores a subagent', () => {
    expect(
      decideModelReport(
        {
          session_id: 's-lead',
          agent_id: 'a-1',
          hook_event_name: 'Stop',
          effort: { level: 'low' },
        },
        dir,
      ),
    ).toBeUndefined();
  });
});

describe('allowSwitch', () => {
  const ev = { hook_event_name: 'PreModelSwitch', session_id: 's-lead', source: 'command' };

  it('allows the board’s command in the lead’s session', () => {
    expect(JSON.parse(allowSwitch(ev, dir))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreModelSwitch', permissionDecision: 'allow' },
    });
  });

  it('gives no answer to anything else', () => {
    expect(allowSwitch({ ...ev, session_id: 's-other' }, dir)).toBe('');
    expect(allowSwitch({ ...ev, source: 'picker' }, dir)).toBe('');
    expect(allowSwitch({ ...ev, agent_id: 'a-1' }, dir)).toBe('');
    expect(allowSwitch(null, dir)).toBe('');
  });
});

describe('runModelReport', () => {
  it('posts to the agent’s mirror route on its board', async () => {
    const posts: { url: string; body: unknown }[] = [];
    const ok = await runModelReport(
      JSON.stringify({ hook_event_name: 'SessionStart', model: 'claude-opus-5-5' }),
      {
        env: { CW_AGENT_NAME: 'Harborlight Lead', CW_WORKSPACE_ID: 'w-harbor' },
        discoveryPort: () => 4321,
        mirrorDir: dir,
        fetch: (async (url: string, init: RequestInit) => {
          posts.push({ url, body: JSON.parse(String(init.body)) });
          return new Response('{}');
        }) as unknown as typeof fetch,
      },
    );
    expect(ok).toBe(true);
    expect(posts[0]?.url).toContain('/workspaces/w-harbor/agents/Harborlight%20Lead/mirror');
    expect(posts[0]?.body).toEqual({ kind: 'model', started: true, model: 'claude-opus-5-5' });
  });

  it('never throws on a payload it cannot read', async () => {
    expect(await runModelReport('not json', { env: {} })).toBe(false);
  });
});
