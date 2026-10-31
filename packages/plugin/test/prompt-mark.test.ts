/**
 * The UserPromptSubmit hook's classifier and post: a prompt is typed unless
 * it starts with a wrapper the harness injects. A typed prompt's mark carries
 * its text, reduced like a turn note; an injected or headless one carries
 * none, except a board channel event, which carries one reduced line for the
 * lead chat.
 */
import { describe, expect, it } from 'vitest';
import {
  CHANNEL_TEXT_CAP,
  PROMPT_TEXT_CAP,
  channelLine,
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
      'Activity was observed in the bound conversation:\nan edit',
      'Your background observer (o-1) sent a report:\nbuild is green',
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
      { prompt: '<system-reminder>Move berth 4</system-reminder>' },
      { agent: 'Harborlight lead', now: 5 },
    );
    expect(injected).toEqual({ post: { agent: 'Harborlight lead', typed: false, at: 5 } });
    const channel = decidePromptMark(
      { prompt: '<channel source="x">Move berth 4</channel>' },
      { agent: 'Harborlight lead', now: 5 },
    );
    expect(channel).toEqual({
      post: {
        agent: 'Harborlight lead',
        typed: false,
        channel: { text: 'Move berth 4', author: 'x' },
        at: 5,
      },
    });
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

describe('a lead behind the board wall', () => {
  it('posts its mark over its board’s socket, and never asks for the joined board', async () => {
    const calls: { url: string; unix?: string }[] = [];
    const ok = await runPromptHook(JSON.stringify({ prompt: 'hello' }), {
      env: { CW_AGENT_NAME: 'Harborlight lead', CW_BOARD_SOCKET: '/private/tmp/b/w-harbor.sock' },
      discoveryPort: () => 8799,
      joinedBoard: true,
      fetch: (async (url: string, init: RequestInit & { unix?: string }) => {
        calls.push({ url, unix: init.unix });
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch,
    });
    expect(ok).toBe(true);
    expect(calls).toEqual([
      {
        url: 'http://board/workspaces/w-harbor/agents/Harborlight%20lead/prompts',
        unix: '/private/tmp/b/w-harbor.sock',
      },
    ]);
  });
});

describe('Remote Control', () => {
  it('marks every prompt from a bridged session as remote, and none from a terminal', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const hook = (env: Record<string, string>, prompt: string) =>
      runPromptHook(JSON.stringify({ prompt, session_id: 's-1' }), {
        env: { ...ENV, ...env },
        now: () => 9,
        discoveryPort: () => 8799,
        fetch: fetchImpl,
      });
    await hook({ CLAUDE_CODE_BRIDGE_SESSION_ID: 'b-1', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, 'hi');
    await hook({ CLAUDE_CODE_BRIDGE_SESSION_ID: 'b-1' }, '<channel source="x">ping</channel>');
    await hook({}, 'hi');
    expect(bodies.map((b) => [b.typed, b.remote])).toEqual([
      [true, true],
      [false, true],
      [true, undefined],
    ]);
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

/**
 * The whole payload a UserPromptSubmit hook reads, as Claude Code 2.1.302
 * builds it. It names no origin: past the common fields there is only
 * `prompt` and `session_title`, so the prompt's opening is the one signal.
 * Each prompt below is the text the harness writes for that kind of
 * delivery, read off the same binary.
 */
const payload = (prompt: string) => ({
  session_id: 's-harbor',
  transcript_path: '/work/harborlight/.transcripts/s-harbor.jsonl',
  cwd: '/work/harborlight',
  permission_mode: 'auto',
  agent_type: 'main',
  hook_event_name: 'UserPromptSubmit',
  prompt,
  session_title: 'Harborlight berths',
});
const typedOf = (prompt: string) => {
  const d = decidePromptMark(payload(prompt), { agent: 'Harborlight lead', now: 5 });
  return 'post' in d ? d.post.typed : d.skip;
};

describe('what the harness delivers into a turn', () => {
  it('reads a subagent’s hand-back to its parent as not typed', () => {
    expect(
      typedOf(
        '<agent-message from="riverbend-builder">\nPR 12 is open; verify 61 of 63.\n</agent-message>',
      ),
    ).toBe(false);
  });

  it('reads a teammate’s or another session’s message as not typed', () => {
    expect(
      typedOf(
        '<teammate-message teammate_id="team-lead" summary="brief">\nRead the brief.\n</teammate-message>',
      ),
    ).toBe(false);
    expect(
      typedOf(
        '<cross-session-message from="u-1" from-name="Saltmarsh">\nCan you rebase?\n</cross-session-message>',
      ),
    ).toBe(false);
    expect(
      typedOf(
        'A peer session sent a message while you were working:\n<cross-session-message from="u-1">\nhi\n</cross-session-message>',
      ),
    ).toBe(false);
  });

  it('reads a channel event and a task notification as not typed', () => {
    expect(
      typedOf('<channel source="claude-hive" from_id="p-1">Harborlight is idle.</channel>'),
    ).toBe(false);
    expect(
      typedOf(
        '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>',
      ),
    ).toBe(false);
    expect(
      typedOf(
        '[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\n\n<task-notification>\n<task-id>b1</task-id>\n</task-notification>',
      ),
    ).toBe(false);
    expect(
      typedOf(
        '[SCHEDULED TASK - AUTOMATED FIRING OF A CONFIGURED PROMPT]\nCheck the Riverbend board.',
      ),
    ).toBe(false);
  });

  it('reads a typed prompt as typed, even one that names a wrapper mid-text', () => {
    expect(typedOf(SECRET)).toBe(true);
    expect(typedOf('Why did the <agent-message from="x"> count as typed?')).toBe(true);
    expect(typedOf('Quote <teammate-message> and <channel> in the doc')).toBe(true);
  });
});

describe('a channel event’s line, for the lead chat', () => {
  it('names who caused it, keeps its words and finds the queue row it delivered', () => {
    const prompt =
      '<channel source="claude-workspaces" workspace_id="w-harbor" event="voice.request" author="Alice">' +
      '[voice.request] by Alice: "Is berth 4 free?" — Answer with answer_voice(workspaceId="w-harbor", queueId="vq_9fZ-2", text)' +
      '</channel>';
    expect(channelLine(prompt)).toEqual({
      text: expect.stringContaining('Is berth 4 free?'),
      author: 'Alice',
      queueId: 'vq_9fZ-2',
    });
  });

  it('falls back to the source, reduces a secret and caps the words', () => {
    const line = channelLine(
      `<channel source="github">token ghp_${'A'.repeat(36)} and ${'word '.repeat(400)}</channel>`,
    );
    expect(line?.author).toBe('github');
    expect(line?.text).not.toContain('ghp_');
    expect(line?.text.length).toBeLessThanOrEqual(CHANNEL_TEXT_CAP);
    expect(line?.queueId).toBeUndefined();
  });

  it('has no line for any other prompt, nor for a channel with no words', () => {
    expect(channelLine(SECRET)).toBeUndefined();
    expect(channelLine('<system-reminder>x</system-reminder>')).toBeUndefined();
    expect(channelLine('<channel source="x">   </channel>')).toBeUndefined();
    expect(channelLine(42)).toBeUndefined();
  });
});
