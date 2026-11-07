/**
 * Photos and files in the lead chat, through the REAL server: an upload is
 * stored under its board, a sent message carries it to an already-open page
 * and to the lead, and the read and the write refuse everybody they should.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEAD_CHAT_FILE_MAX_BYTES,
  type LeadChatAttachment,
  type LeadChatMessage,
} from '@claude-workspaces/core/lead-chat';
import { fileLabel } from '../src/lead-chat/files.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { agentStream } from './agent-voice-stream.ts';
import { pageStream } from './lead-chat-page-stream.ts';
import { type ShareProofServer, startShareProofServer } from './share-proof-harness.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const BRYAN = { id: 'known-bryan', name: 'Bryan', kind: 'known' };

describe('lead chat files', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let boardId = '';
  let otherBoard = '';

  const json = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const upload = (bytes: Uint8Array, name: string, board = boardId) =>
    fetch(`${base}/workspaces/${board}/lead-chat/files?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      body: bytes as BodyInit,
      // The server answers an oversized upload without reading it, and that
      // connection cannot carry the next request.
      keepalive: false,
    });
  const stored = async (res: Response): Promise<LeadChatAttachment> =>
    ((await res.json()) as { file: LeadChatAttachment }).file;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-lead-chat-files-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const make = async (name: string) =>
      ((await (await json('/workspaces', { name })).json()) as { workspace: { id: string } })
        .workspace.id;
    boardId = await make('Harborlight');
    otherBoard = await make('Riverbend');
    handle.tasks.attachAgent(boardId, {
      agentId: 'harborlight-lead',
      agentName: 'Harborlight Lead',
      runtime: 'claude-code-local',
    });
    handle.tasks.setLeadAgent(boardId, 'harborlight-lead', { actor: BRYAN });
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reaches an open page and the lead, and the image reads back as its bytes', async () => {
    const page = await pageStream(base, boardId);
    const lead = await agentStream(base, boardId, 'harborlight-lead');
    const res = await upload(PNG, 'IMG_2041.png');
    expect(res.status).toBe(201);
    const file = await stored(res);
    expect(file).toMatchObject({ name: 'IMG_2041.png', type: 'image/png', image: true });

    const sent = await json(`/workspaces/${boardId}/lead-chat`, {
      text: '',
      author: BRYAN,
      attachments: [file.id],
    });
    expect(sent.status).toBe(201);

    await waitFor(() => page.messages.some((m) => m.attachments?.[0]?.id === file.id));
    const shown = page.messages.find((m) => m.attachments) as LeadChatMessage;
    expect(shown.text).toBe('');
    expect(shown.attachments).toEqual([file]);

    await waitFor(() => lead.voice.length > 0);
    expect(lead.voice[0]?.transcript).toContain(`fileId="${file.id}"`);

    const read = await fetch(`${base}/workspaces/${boardId}/lead-chat/files/${file.id}`);
    expect(read.status).toBe(200);
    expect(read.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(PNG);

    const forChild = await fetch(
      `${base}/workspaces/${boardId}/lead-chat/files/${file.id}?encoding=base64`,
    );
    const body = (await forChild.json()) as { data: string };
    expect(Buffer.from(body.data, 'base64')).toEqual(Buffer.from(PNG));

    // A reload reads it back out of the log.
    const again = (await (await fetch(`${base}/workspaces/${boardId}/lead-chat`)).json()) as {
      messages: LeadChatMessage[];
    };
    expect(again.messages.at(-1)?.attachments).toEqual([file]);
    page.close();
    lead.close();
  });

  it('stores under the board, readable by this user alone', async () => {
    const file = await stored(await upload(PNG, 'plan.png'));
    const folder = join(dataDir, 'workspaces', `${boardId}.lead-chat-files`);
    expect(readdirSync(folder)).toContain(file.id);
    expect(statSync(join(folder, file.id)).mode & 0o077).toBe(0);
  });

  it('refuses a file over the limit and stores nothing of it', async () => {
    const res = await upload(new Uint8Array(LEAD_CHAT_FILE_MAX_BYTES + 1), 'huge.bin', otherBoard);
    expect(res.status).toBe(413);
    expect(existsSync(join(dataDir, 'workspaces', `${otherBoard}.lead-chat-files`))).toBe(false);
  });

  it('never trusts the name: a page disguised as a photo is an opaque download', async () => {
    const html = new TextEncoder().encode('<script>alert(1)</script>');
    const file = await stored(await upload(html, '../../../etc/photo.png'));
    expect(file.name).toBe('photo.png');
    expect(file.image).toBeUndefined();
    expect(file.type).toBe('application/octet-stream');
    const read = await fetch(`${base}/workspaces/${boardId}/lead-chat/files/${file.id}`);
    expect(read.headers.get('content-type')).toBe('application/octet-stream');
    expect(read.headers.get('content-disposition')).toStartWith('attachment');
    expect(read.headers.get('x-content-type-options')).toBe('nosniff');
    expect(read.headers.get('content-security-policy')).toContain('sandbox');
  });

  it('keeps a file on its board', async () => {
    const file = await stored(await upload(PNG, 'mine.png'));
    const other = await fetch(`${base}/workspaces/${otherBoard}/lead-chat/files/${file.id}`);
    expect(other.status).toBe(404);
    const sent = await json(`/workspaces/${otherBoard}/lead-chat`, {
      text: 'look',
      author: BRYAN,
      attachments: [file.id],
    });
    expect(sent.status).toBe(400);
  });

  it('refuses an id that is not an id', async () => {
    for (const id of ['..%2F..%2Fsecret', 'lf-short', 'lf-aaaaaaaaaaaa.json']) {
      const res = await fetch(`${base}/workspaces/${boardId}/lead-chat/files/${id}`);
      expect(res.status).toBe(404);
    }
  });

  it('reduces a name to a label', () => {
    expect(fileLabel('a\\b/c\nd.txt')).toBe('c d.txt');
    expect(fileLabel('..')).toBe('file');
    expect(fileLabel(null)).toBe('file');
    expect(fileLabel(`${'x'.repeat(300)}.png`)).toEndWith('.png');
  });
});

describe('lead chat files and a share visitor', () => {
  let s: ShareProofServer;
  const dir = mkdtempSync(join(tmpdir(), 'cw-lead-files-proof-'));
  const VISITOR = 'alice@harborlight.test';

  beforeAll(async () => {
    s = await startShareProofServer('Harborlight');
    s.handle.shareLinks.addToAudience(s.board, ['@harborlight.test'], 'Bryan');
    expect(await s.join(VISITOR)).toBe(302);
  });

  afterAll(async () => {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a visitor both the read and the write', async () => {
    const up = await s.owner(`${s.scope}/lead-chat/files?name=a.png`, {
      method: 'POST',
      body: PNG as BodyInit,
    });
    expect(up.status).toBe(201);
    const { file } = (await up.json()) as { file: LeadChatAttachment };
    // Positive control: the owner reads what the visitor may not.
    expect((await s.owner(`${s.scope}/lead-chat/files/${file.id}`)).status).toBe(200);
    const read = await s.visitor(VISITOR, `${s.scope}/lead-chat/files/${file.id}`);
    expect(read.status).toBe(403);
    const write = await s.visitor(VISITOR, `${s.scope}/lead-chat/files?name=b.png`, {
      method: 'POST',
      body: PNG as BodyInit,
    });
    expect(write.status).toBe(403);
  });
});
