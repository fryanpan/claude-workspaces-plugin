import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementAnchor, User } from '@claude-workspaces/core';
import { type CommentAttempt, commentLogLine, logCommentAttempt } from '../src/comment-log.ts';
import { STAMP_PATTERN } from '../src/log-stamp.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

const AT = Date.parse('2026-09-15T10:20:30.400Z');

function attempt(over: Partial<CommentAttempt> = {}): CommentAttempt {
  return {
    docId: 'task:t-abc',
    threadId: null,
    authorId: 'u-1',
    chars: 42,
    landedThreadId: 'th-1',
    landedCommentId: 'c-1',
    ...over,
  };
}

describe('the comment log line', () => {
  it('carries the address, the author and where the write landed', () => {
    const line = commentLogLine(attempt(), AT);
    expect(line).toContain('doc=task:t-abc');
    expect(line).toContain('onto=new');
    expect(line).toContain('author=u-1');
    expect(line).toContain('chars=42');
    expect(line).toContain('-> thread=th-1 comment=c-1');
  });

  it('is stamped, because when is the question asked of it', () => {
    expect(commentLogLine(attempt(), AT)).toMatch(STAMP_PATTERN);
    expect(commentLogLine(attempt(), AT)).toContain('2026-09-15T10:20:30.400Z');
  });

  it('says a reply is a reply, by naming the thread it went onto', () => {
    expect(commentLogLine(attempt({ threadId: 'th-9' }), AT)).toContain('onto=th-9');
  });

  it('records a comment that ARRIVED and did not land', () => {
    const line = commentLogLine(
      attempt({ landedThreadId: null, landedCommentId: null, chars: 7 }),
      AT,
    );
    expect(line).toContain('-> refused');
    expect(line).toContain('chars=7');
  });

  it('never carries the words themselves — only how many there were', () => {
    // The whole point of `chars`: a log read over a shoulder, in a public
    // repo, must not be able to quote anybody.
    const secret = 'the sentence nobody else should read';
    const line = commentLogLine(attempt({ chars: secret.length }), AT);
    expect(line).not.toContain(secret);
    expect(line).not.toContain('sentence');
    expect(line).toContain(`chars=${secret.length}`);
  });

  it('writes through the sink it is given', () => {
    const lines: string[] = [];
    logCommentAttempt(attempt(), (l) => lines.push(l), AT);
    expect(lines).toEqual([commentLogLine(attempt(), AT)]);
  });
});

/**
 * And the line is actually written, by the one choke point every comment
 * passes through. A module that composes a perfect line nothing calls is the
 * exact shape of the gap this change exists to close.
 */
describe('every comment that reaches the server leaves a line', () => {
  const reviewer: User = {
    id: 'known-reviewer',
    name: 'Reviewer',
    kind: 'known',
    color: '#2e7dd7',
  };
  const anchor: ElementAnchor = {
    kind: 'element',
    fingerprint: {
      tag: 'P',
      stableAttrs: {},
      classes: [],
      text: 'some text',
      path: 'P[0] > BODY[0]',
      dataAttrs: {},
    },
    snippet: { text: 'some text' },
  };
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let ws: string;
  const lines: string[] = [];
  let realLog: typeof console.log;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-comment-log-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    ws = await seedBoard(base);
    realLog = console.log;
  });
  afterAll(async () => {
    console.log = realLog;
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function capture(): void {
    lines.length = 0;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
  }
  const commentLines = () => lines.filter((l) => l.includes('[comment]'));

  it('records the thread a comment opened and the reply that followed it', async () => {
    const file = join(dataDir, 'comment-log-doc.md');
    writeFileSync(file, '# Doc\n\nsome text\n');
    const post = (path: string, body: unknown) =>
      fetch(`${base}/workspaces/${ws}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    // The server assigns the doc's real id; the requested one is a hint.
    const doc = (await (
      await post('/docs', { docId: 'comment-log-doc', type: 'markdown', sourceUrl: file })
    ).json()) as { docId: string };
    const docId = doc.docId;

    const secret = 'the sentence nobody else should read';
    capture();
    const created = (await (
      await post(`/docs/${docId}/threads`, { author: reviewer, text: secret, anchor })
    ).json()) as { thread: { id: string } };
    await post(`/docs/${docId}/threads/${created.thread.id}/comments`, {
      author: reviewer,
      text: 'and a reply',
    });
    console.log = realLog;

    const found = commentLines();
    expect(found.length, found.join('\n')).toBe(2);
    expect(found[0]).toContain(`doc=${docId}`);
    expect(found[0]).toContain('onto=new');
    expect(found[0]).toContain('author=known-reviewer');
    expect(found[0]).toContain(`chars=${secret.length}`);
    expect(found[0]).toContain(`-> thread=${created.thread.id}`);
    expect(found[1]).toContain(`onto=${created.thread.id}`);
    expect(found[1]).toContain('chars=11');
    // The record exists so a lost comment can be traced, not so it can be read.
    expect(found.join('\n')).not.toContain(secret);
  });
});
