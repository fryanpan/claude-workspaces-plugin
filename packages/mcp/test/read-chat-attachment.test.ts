/**
 * `read_chat_attachment` hands the session a file it can read: the bytes the
 * server sent, at a private path, and a small image inline as well.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { INLINE_IMAGE_MAX_BYTES, readChatAttachment } from '../src/tools/chat-attachment.ts';

const root = mkdtempSync(join(tmpdir(), 'cw-chat-attachment-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ID = 'lf-AAAAaaaaBBBB';
const err = (message: string) => ({
  isError: true,
  content: [{ type: 'text' as const, text: message }],
});

function serving(file: Record<string, unknown>, bytes: Buffer) {
  const asked: string[] = [];
  return {
    asked,
    ctx: {
      tempRoot: root,
      err,
      http: async (_m: string, path: string) => {
        asked.push(path);
        return { file, data: bytes.toString('base64') };
      },
    },
  };
}
const pathOf = (r: Awaited<ReturnType<typeof readChatAttachment>>): string => {
  const first = r.content[0];
  return JSON.parse(first?.type === 'text' ? first.text : '{}').path;
};

describe('read_chat_attachment', () => {
  it('writes a file the session can read, and shows a small image inline', async () => {
    const bytes = Buffer.from([1, 2, 3]);
    const file = { id: ID, name: 'IMG 2041.png', type: 'image/png', size: 3, image: true };
    const { ctx, asked } = serving(file, bytes);
    const r = await readChatAttachment(ctx, 'w-1', ID);
    expect(asked[0]).toBe(`/workspaces/w-1/lead-chat/files/${ID}?encoding=base64`);
    const path = pathOf(r);
    expect(readFileSync(path)).toEqual(bytes);
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(statSync(dirname(path)).mode & 0o077).toBe(0);
    expect(r.content[1]).toEqual({
      type: 'image',
      data: bytes.toString('base64'),
      mimeType: 'image/png',
    });
  });

  it('gives a plain file, and an image too large to inline, by path alone', async () => {
    const doc = { id: ID, name: 'notes.pdf', type: 'application/octet-stream', size: 3 };
    const plain = await readChatAttachment(serving(doc, Buffer.from('abc')).ctx, 'w-1', ID);
    expect(plain.content).toHaveLength(1);
    const big = { id: ID, name: 'b.png', type: 'image/png', size: INLINE_IMAGE_MAX_BYTES + 1 };
    const large = await readChatAttachment(
      serving({ ...big, image: true }, Buffer.from('abc')).ctx,
      'w-1',
      ID,
    );
    expect(large.content).toHaveLength(1);
  });

  it('keeps a hostile name out of the path', async () => {
    const file = { id: ID, name: '../../.ssh/config', type: 'application/octet-stream', size: 1 };
    const path = pathOf(await readChatAttachment(serving(file, Buffer.from('x')).ctx, 'w-1', ID));
    expect(dirname(dirname(path))).toBe(root);
  });

  it('refuses an id that is not a chat file id before asking the server', async () => {
    const { ctx, asked } = serving({}, Buffer.alloc(0));
    const r = await readChatAttachment(ctx, 'w-1', '../secret');
    expect(r.isError).toBe(true);
    expect(asked).toEqual([]);
  });
});
