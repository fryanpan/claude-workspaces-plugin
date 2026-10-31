/**
 * The MessageDisplay and PostToolBatch hooks: nothing posts until the
 * prompts route has said the session is the lead; a streaming message posts
 * its whole text so far, reduced like a turn note; a tool batch posts each
 * call reduced and capped; and a server that says "not the lead" stops it.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPromptHook } from '../hooks/lib/prompt-mark.ts';
import {
  TOOL_OUTPUT_CAP,
  decideMirror,
  isMarkedLead,
  markLead,
  runMirrorHook,
  toolsBody,
} from '../hooks/lib/session-mirror.ts';

const ENV = { CW_AGENT_NAME: 'Harborlight lead', CW_WORKSPACE_ID: 'w-harbor' };
/** A token shape note-redact.ts reduces. */
const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-session-mirror-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const flush = (index: number, final: boolean, delta: string) => ({
  hook_event_name: 'MessageDisplay',
  session_id: 's-lead',
  message_id: 'm-1',
  index,
  final,
  delta,
});

describe('decideMirror', () => {
  it('posts nothing for a session not marked as the lead', () => {
    expect(decideMirror(flush(0, true, 'hello\n'), dir)).toEqual({ skip: 'not the lead' });
  });

  it('posts the whole message so far, reduced across flushes, and clears its parts at the end', () => {
    markLead('s-lead', true, dir);
    const a = decideMirror(flush(0, false, 'Running it:\n```\n'), dir);
    expect(a).toEqual({
      post: { kind: 'text', messageId: 'm-1', index: 0, final: false, text: 'Running it:\n```' },
    });
    const b = decideMirror(flush(1, false, `export TOKEN=${TOKEN}\n`), dir);
    const text = 'post' in b && b.post.kind === 'text' ? b.post.text : '';
    expect(text.startsWith('Running it:\n```\nexport TOKEN=')).toBe(true);
    expect(text).not.toContain(TOKEN);
    const c = decideMirror(flush(2, true, '```\nDone.'), dir);
    expect('post' in c && c.post.kind === 'text' && c.post.final).toBe(true);
    expect('post' in c && c.post.kind === 'text' && c.post.text.endsWith('```\nDone.')).toBe(true);
    expect(existsSync(join(dir, 's-lead.parts', 'm-1'))).toBe(false);
  });

  it('builds a late flush from the parts up to its own index only', () => {
    markLead('s-lead', true, dir);
    decideMirror(flush(0, false, 'one\n'), dir);
    decideMirror(flush(2, false, 'three\n'), dir);
    const late = decideMirror(flush(1, false, 'two\n'), dir);
    expect('post' in late && late.post.kind === 'text' && late.post.text).toBe('one\ntwo');
  });

  it('posts a tool batch, and nothing for another event', () => {
    markLead('s-lead', true, dir);
    const batch = {
      hook_event_name: 'PostToolBatch',
      session_id: 's-lead',
      tool_calls: [{ tool_name: 'Bash', tool_input: { command: 'git status' }, tool_use_id: 't1' }],
    };
    expect(decideMirror(batch, dir)).toEqual({
      post: { kind: 'tools', calls: [{ name: 'Bash', input: 'git status' }] },
    });
    expect(decideMirror({ hook_event_name: 'Stop', session_id: 's-lead' }, dir)).toEqual({
      skip: 'nothing to show',
    });
  });
});

describe('toolsBody', () => {
  it('shows a command, its stdout and stderr, a path, and a failure; reduces and caps each', () => {
    const body = toolsBody({
      tool_calls: [
        {
          tool_name: 'Bash',
          tool_input: { command: `curl -H "Authorization: ${TOKEN}" x` },
          tool_response: { stdout: 'ok', stderr: 'warn' },
        },
        {
          tool_name: 'Read',
          tool_input: { file_path: 'docs/plan.md' },
          tool_response: 'x'.repeat(9000),
        },
        { tool_name: 'Grep', tool_input: { pattern: 'tide' }, tool_response: { is_error: true } },
        { tool_input: {} },
      ],
    });
    expect(body?.calls.length).toBe(3);
    const [bash, read, grep] = body?.calls ?? [];
    expect(bash?.input).not.toContain(TOKEN);
    expect(bash?.output).toBe('ok\nwarn');
    expect(read?.input).toBe('docs/plan.md');
    expect(read?.output?.length).toBeLessThanOrEqual(TOOL_OUTPUT_CAP);
    expect(grep?.input).toBe('{"pattern":"tide"}');
    expect(grep?.failed).toBe(true);
  });
});

describe('the lead marker', () => {
  const answering = (body: unknown, calls: string[]) =>
    (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(body), { status: 202 });
    }) as unknown as typeof fetch;

  it('is kept while the prompts route says lead, and dropped when it stops saying so', async () => {
    const prompt = JSON.stringify({ prompt: '<channel>x</channel>', session_id: 's-lead' });
    const calls: string[] = [];
    const deps = { env: ENV, discoveryPort: () => 8799, mirrorDir: dir };
    await runPromptHook(prompt, { ...deps, fetch: answering({ ok: true, lead: true }, calls) });
    expect(isMarkedLead('s-lead', dir)).toBe(true);
    await runPromptHook(prompt, { ...deps, fetch: answering({ ok: true }, calls) });
    expect(isMarkedLead('s-lead', dir)).toBe(false);
  });

  it('posts to the mirror route while marked, and stops once the server says not mirrored', async () => {
    markLead('s-lead', true, dir);
    const calls: string[] = [];
    const deps = { env: ENV, discoveryPort: () => 8799, mirrorDir: dir };
    const stdin = JSON.stringify(flush(0, true, 'hello'));
    expect(
      await runMirrorHook(stdin, {
        ...deps,
        fetch: answering({ ok: true, mirrored: true }, calls),
      }),
    ).toBe(true);
    expect(calls).toEqual([
      'http://127.0.0.1:8799/workspaces/w-harbor/agents/Harborlight%20lead/mirror',
    ]);
    expect(await runMirrorHook(stdin, { ...deps, fetch: answering({ ok: true }, calls) })).toBe(
      false,
    );
    expect(isMarkedLead('s-lead', dir)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    // Unmarked, it makes no request at all.
    await runMirrorHook(stdin, { ...deps, fetch: answering({ ok: true, mirrored: true }, calls) });
    expect(calls.length).toBe(2);
  });

  it('refuses a session id that is not a plain file name', () => {
    markLead('../escape', true, dir);
    expect(readdirSync(dir)).toEqual([]);
    expect(isMarkedLead('../escape', dir)).toBe(false);
  });
});
