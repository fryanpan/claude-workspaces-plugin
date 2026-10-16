/**
 * The UserPromptSubmit hook's classifier and post: a prompt is typed unless
 * it starts with a wrapper the harness injects. A typed prompt's mark carries
 * its text, reduced like a turn note; an injected or headless one carries
 * none.
 */
import { describe, expect, it } from 'vitest';
import {
  PROMPT_TEXT_CAP,
  decidePromptMark,
  isHeadless,
  isTypedPrompt,
  runPromptHook,
} from '../hooks/lib/prompt-mark.ts';

const ENV = { CW_AGENT_NAME: 'Harborlight lead', CW_WORKSPACE_ID: 'w-harbor' };
const SECRET = 'Move berth 4 to Riverbend before the tide.';

describe('isTypedPrompt', () => {
  it('reads what a person typed as typed, and each injected wrapper as not', () => {
    expect(isTypedPrompt(SECRET)).toBe(true);
    expect(isTypedPrompt('/ship-it')).toBe(true);
    expect(isTypedPrompt('<b>bold</b> is fine to type')).toBe(true);
    for (const injected of [
      '<channel source="claude-workspaces" doc_id="d-1">Softer shadow?</channel>',
      '\n  <teammate-message teammate_id="team-lead">Rework it</teammate-message>',
      '<task-notification><task-id>b1</task-id></task-notification>',
      '<system-reminder>Tools loaded.</system-reminder>',
      '<cross-session-message from="Riverbend">hi</cross-session-message>',
      'Another Claude session sent a message: hello',
      'This session is being continued from a previous conversation that ran out of context.',
      'Self-wake (keep-moving protocol): check the board.',
    ]) {
      expect(isTypedPrompt(injected)).toBe(false);
    }
  });

  it('has no answer for a payload with no prompt', () => {
    expect(isTypedPrompt(undefined)).toBeUndefined();
    expect(isTypedPrompt('   ')).toBeUndefined();
    expect(isTypedPrompt(7)).toBeUndefined();
  });
});

describe('the mark', () => {
  it('carries typed, session, cwd and the typed prompt’s text', () => {
    const d = decidePromptMark(
      { prompt: SECRET, session_id: 's-1', cwd: '/work/harborlight', hook_event_name: 'x' },
      { agent: 'Harborlight lead', now: 5 },
    );
    expect(d).toEqual({
      post: {
        agent: 'Harborlight lead',
        typed: true,
        sessionId: 's-1',
        cwd: '/work/harborlight',
        text: SECRET,
        at: 5,
      },
    });
    expect(decidePromptMark({ prompt: SECRET }, { now: 5 })).toEqual({ skip: 'no agent name' });
  });

  it('carries no text for an injected prompt, nor for a headless run', () => {
    const injected = decidePromptMark(
      { prompt: '<channel source="x">Move berth 4</channel>' },
      { agent: 'Harborlight lead', now: 5 },
    );
    expect(injected).toEqual({ post: { agent: 'Harborlight lead', typed: false, at: 5 } });
    const headless = decidePromptMark(
      { prompt: SECRET },
      { agent: 'Harborlight lead', now: 5, headless: true },
    );
    expect(headless).toEqual({ post: { agent: 'Harborlight lead', typed: false, at: 5 } });
  });

  it('caps the text and reduces what the notes reduce', () => {
    const d = decidePromptMark(
      { prompt: `see https://riverbend.example/x ${'y'.repeat(PROMPT_TEXT_CAP)}` },
      { agent: 'Harborlight lead', now: 5 },
    );
    const text = 'post' in d ? (d.post.text ?? '') : '';
    expect(text.length).toBeLessThanOrEqual(PROMPT_TEXT_CAP);
    expect(text).toContain('[url]');
    expect(text).not.toContain('riverbend.example');
  });

  it('posts to the board’s prompts route with the text, and never throws', async () => {
    const calls: { url: string; body: string }[] = [];
    const ok = await runPromptHook(JSON.stringify({ prompt: SECRET, session_id: 's-1' }), {
      env: ENV,
      now: () => 9,
      discoveryPort: () => 8799,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, body: String(init.body) });
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch,
    });
    expect(ok).toBe(true);
    expect(calls).toEqual([
      {
        url: 'http://127.0.0.1:8799/workspaces/w-harbor/agents/Harborlight%20lead/prompts',
        body: JSON.stringify({
          agent: 'Harborlight lead',
          typed: true,
          sessionId: 's-1',
          text: SECRET,
          at: 9,
        }),
      },
    ]);
    const failing = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    expect(await runPromptHook('{"prompt":"hi"}', { env: ENV, fetch: failing })).toBe(false);
    expect(await runPromptHook('not json', { env: ENV, fetch: failing })).toBe(false);
    expect(await runPromptHook('{"prompt":"hi"}', { env: {}, fetch: failing })).toBe(false);
  });

  it('falls back to the board the session joined when its launch env names none', async () => {
    const calls: string[] = [];
    const listening = (on: boolean) =>
      (async (url: string) => {
        calls.push(url);
        if (url.endsWith('/api/voice/agents')) {
          return Response.json({
            boards: [{ id: 'w-river', agents: [{ name: 'Riverbend lead', listening: on }] }],
          });
        }
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch;
    const run = (on: boolean, joinedBoard = true) =>
      runPromptHook(JSON.stringify({ prompt: SECRET }), {
        env: { CW_AGENT_NAME: 'Riverbend lead' },
        discoveryPort: () => 8799,
        fetch: listening(on),
        joinedBoard,
      });
    expect(await run(true)).toBe(true);
    expect(calls).toEqual([
      'http://127.0.0.1:8799/api/voice/agents',
      'http://127.0.0.1:8799/workspaces/w-river/agents/Riverbend%20lead/prompts',
    ]);
    expect(await run(false)).toBe(false);
    expect(await run(true, false)).toBe(false);
    expect(calls).toHaveLength(3);
  });
});

describe('isHeadless', () => {
  it('reads claude -p and the SDK as headless, unless Remote Control is driving it', () => {
    for (const entry of ['sdk-cli', 'sdk-ts', 'sdk-py']) {
      expect(isHeadless({ CLAUDE_CODE_ENTRYPOINT: entry })).toBe(true);
      expect(
        isHeadless({ CLAUDE_CODE_ENTRYPOINT: entry, CLAUDE_CODE_BRIDGE_SESSION_ID: 'b-1' }),
      ).toBe(false);
    }
    expect(isHeadless({ CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe(false);
    expect(isHeadless({})).toBe(false);
  });
});
