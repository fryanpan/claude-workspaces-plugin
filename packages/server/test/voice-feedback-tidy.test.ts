/**
 * The tidier: the prompt it builds, the reply it trusts, and the real
 * completer driven through an injected fetch — nothing here reaches the
 * network, and the credential is a fake handed in by the test.
 *
 * All fixtures are synthetic — the Riverbend register. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import type { VoiceTarget } from '@claude-workspaces/core';
import {
  TIDY_MODEL,
  type TidyInput,
  buildTidyPrompt,
  createHaikuTidy,
  parseTidyReply,
  tidyDollars,
} from '../src/voice-feedback-tidy.ts';

const TARGETS: VoiceTarget[] = [
  { i: 0, tag: 'header', text: 'Riverbend', hint: 'top-bar' },
  { i: 1, tag: 'button', text: 'Save', parent: 0 },
  { i: 2, tag: 'span', text: 'done', label: 'Status', parent: 0 },
];

const input = (over: Partial<TidyInput> = {}): TidyInput => ({
  targets: TARGETS,
  open: null,
  words: 'the save button is hard to find',
  ...over,
});

describe('buildTidyPrompt', () => {
  it('lists the catalog, the open comment, the pin and the new words', () => {
    const { system, user } = buildTidyPrompt(
      input({ open: { text: 'Header is too tall.', target: 0, fixed: true }, pinned: 2 }),
    );
    expect(system).toContain('JSON only');
    expect(user).toContain('e1 <button> "Save" in e0');
    expect(user).toContain('e2 <span> "done" label="Status" in e0');
    expect(user).toContain('<open element="e0" fixed>Header is too tall.</open>');
    expect(user).toContain('<pinned>e2</pinned>');
    expect(user).toContain('<new_words>the save button is hard to find</new_words>');
  });

  it('says none for no open comment, and page for a null pin', () => {
    const { user } = buildTidyPrompt(input({ pinned: null }));
    expect(user).toContain('<open>none</open>');
    expect(user).toContain('<pinned>page</pinned>');
    expect(buildTidyPrompt(input()).user).not.toContain('<pinned>');
  });
});

describe('parseTidyReply', () => {
  it('reads comments and maps element ids to catalog indices', () => {
    expect(
      parseTidyReply(
        '{"comments":[{"continues":false,"text":" The Save button is hard to find. ","element":"e1"}]}',
        input(),
      ),
    ).toEqual([{ continues: false, text: 'The Save button is hard to find.', target: 1 }]);
  });

  it('turns an element outside the catalog, or a malformed id, into the page', () => {
    const out = parseTidyReply(
      JSON.stringify({
        comments: [
          { text: 'one', element: 'e42' },
          { text: 'two', element: '1' },
          { text: 'three', element: null },
        ],
      }),
      input(),
    );
    expect(out?.map((c) => c.target)).toEqual([null, null, null]);
  });

  it('lets only the first comment continue, and only when one is open', () => {
    const reply = JSON.stringify({
      comments: [
        { continues: true, text: 'grown', element: 'e0' },
        { continues: true, text: 'second', element: 'e1' },
      ],
    });
    const open = { text: 'Header.', target: 0, fixed: false };
    expect(parseTidyReply(reply, input({ open }))?.map((c) => c.continues)).toEqual([true, false]);
    expect(parseTidyReply(reply, input())?.map((c) => c.continues)).toEqual([false, false]);
  });

  it('skips empty and non-object entries without counting them as first', () => {
    const reply = JSON.stringify({
      comments: [null, { text: '   ' }, { continues: true, text: 'real', element: 'e2' }],
    });
    const out = parseTidyReply(reply, input({ open: { text: 'x', target: null, fixed: false } }));
    expect(out).toEqual([{ continues: true, text: 'real', target: 2 }]);
  });

  it('tolerates prose around the JSON', () => {
    const out = parseTidyReply(
      'Here you go:\n```json\n{"comments":[{"text":"Status chip is unclear.","element":"e2"}]}\n```\nHope that helps.',
      input(),
    );
    expect(out).toEqual([{ continues: false, text: 'Status chip is unclear.', target: 2 }]);
  });

  it('returns null for a reply that is not one, and [] for no feedback', () => {
    expect(parseTidyReply('I could not parse that.', input())).toBeNull();
    expect(parseTidyReply('{not json}', input())).toBeNull();
    expect(parseTidyReply('{"answer":"nope"}', input())).toBeNull();
    expect(parseTidyReply('{"comments":[]}', input())).toEqual([]);
  });
});

describe('createHaikuTidy', () => {
  const FAKE_KEY = 'fake-key-for-tests';

  it('is null when no credential resolves', () => {
    expect(createHaikuTidy({ env: {}, read: () => null })).toBeNull();
  });

  it('sends the injected key, the model and the prompt, and maps usage', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          content: [{ text: '{"comments":' }, { text: '[]}' }],
          usage: {
            input_tokens: 1200,
            output_tokens: 40,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 6,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const tidy = createHaikuTidy({ env: {}, read: () => FAKE_KEY, fetchImpl });
    expect(tidy).not.toBeNull();

    const reply = await tidy?.({ system: 'SYS', user: 'USER' });

    expect(calls).toHaveLength(1);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(FAKE_KEY);
    expect(headers.authorization).toBeUndefined();
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.model).toBe(TIDY_MODEL);
    expect(body.system).toBe('SYS');
    expect(body.messages).toEqual([{ role: 'user', content: 'USER' }]);
    expect(reply).toEqual({
      text: '{"comments":[]}',
      usage: { inputTokens: 1200, outputTokens: 40, cacheReadTokens: 5, cacheWriteTokens: 6 },
    });
    expect(tidyDollars(reply?.usage)).toBeGreaterThan(0);
    expect(tidyDollars(undefined)).toBe(0);
  });

  it('throws on a non-2xx answer so the relay falls back to the raw words', async () => {
    const fetchImpl = (async () =>
      new Response('overloaded', { status: 529 })) as unknown as typeof fetch;
    const tidy = createHaikuTidy({ env: {}, read: () => FAKE_KEY, fetchImpl });
    await expect(tidy?.({ system: 's', user: 'u' })).rejects.toThrow('HTTP 529');
  });
});
