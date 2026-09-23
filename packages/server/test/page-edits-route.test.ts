/**
 * An edit made on the page itself, through the REAL server to the agent.
 *
 * The widget's edit mode never writes the page. It posts a thread whose first
 * comment carries `pageEdits` — the element, the words before and the words
 * after — and the agent applies them to whatever generated the page. So what
 * has to hold is the far end: the frame an attached agent's stream carries,
 * and the channel line its MCP child renders out of that frame, both name all
 * three. A POST that returns 200 proves none of that.
 *
 * All fixtures synthetic; port 0; no production server is touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type PageEdit, pageEditsText } from '@claude-workspaces/core/page-edits';
import { type ChannelNotification, createChannelMessages } from '../../mcp/src/channel-messages.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const AGENT = 'agent-harborlight';
const PERSON = { id: 'known-reviewer', name: 'Alice', kind: 'known', color: '#2e7dd7' };

const EDIT: PageEdit = {
  anchor: {
    kind: 'element',
    fingerprint: {
      tag: 'H1',
      stableAttrs: {},
      classes: [],
      text: 'Harborlight Street Projects',
      path: 'H1[0] > BODY[0]',
      dataAttrs: {},
    },
    snippet: { text: 'Harborlight Street Projects' },
  },
  selector: 'body > h1',
  before: 'Harborlight Street Projects',
  after: 'Harborlight Street Works',
};

type Frame = { event: string; data: Record<string, unknown> };

function listen(res: Response): { frames: Frame[]; stop: () => void } {
  const frames: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          if (raw.startsWith(':')) continue;
          const f: Frame = { event: 'message', data: {} };
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) f.event = line.slice(6).trim();
            else if (line.startsWith('data:')) f.data = JSON.parse(line.slice(5).trim());
          }
          frames.push(f);
        }
      }
    } catch {
      // Cancelled with a read in flight; the frames collected still stand.
    }
  })();
  return { frames, stop: () => void reader.cancel().catch(() => {}) };
}

describe('a page edit posted from the widget', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let srcDir: string;
  let base: string;
  let WS = '';
  let docId = '';
  let mdPath = '';

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { host: `localhost:${handle.port}` } });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'page-edits-'));
    srcDir = mkdtempSync(join(tmpdir(), 'page-edits-src-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base);
    mdPath = join(srcDir, 'harborlight.md');
    writeFileSync(mdPath, '# Harborlight Street Projects\n\nBody.\n');
    const res = await post(`/workspaces/${WS}/docs`, {
      docId: 'harborlight',
      sourceUrl: mdPath,
      title: 'harborlight',
    });
    expect(res.status).toBe(200);
    docId = ((await res.json()) as { docId: string }).docId;
    await post(`/api/agents/${AGENT}/watches`, { add: [docId] });
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  it('reaches the watching agent with the element, the words before and the words after', async () => {
    const heard = listen(await get(`/events/agent/${AGENT}`));
    const res = await post(`/workspaces/${WS}/docs/${docId}/threads`, {
      author: PERSON,
      text: 'ignored: the server writes the line from the edits',
      anchor: EDIT.anchor,
      pageEdits: [EDIT],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const { thread } = (await res.json()) as { thread: { id: string } };

    // The MCP read shape: get_thread / list_threads pass this answer through.
    const read = (await (
      await get(`/workspaces/${WS}/docs/${docId}/threads/${thread.id}`)
    ).json()) as { thread?: { comments: Array<{ text: string; pageEdits?: PageEdit[] }> } };
    const first = (read.thread ?? (read as unknown as { comments: never[] })).comments[0];
    expect(first?.pageEdits).toEqual([EDIT]);
    expect(first?.text).toBe(pageEditsText([EDIT]));

    // The frame on the agent's own stream …
    const frame = await waitFor(
      () => heard.frames.find((f) => f.event === 'thread.created' && f.data.threadId === thread.id),
      { describe: 'thread.created on the agent stream' },
    );
    heard.stop();

    // … and the channel line its MCP child renders from that frame.
    const sent: ChannelNotification[] = [];
    const channel = createChannelMessages({
      notify: async (n) => {
        sent.push(n);
      },
      http: async () => ({}),
      authorId: AGENT,
    });
    await channel.emitChannelMessage('thread.created', frame.data);
    expect(sent).toHaveLength(1);
    const meta = sent[0]?.params.meta as Record<string, unknown>;
    expect(JSON.parse(String(meta.page_edits))).toEqual([
      { selector: 'body > h1', before: EDIT.before, after: EDIT.after },
    ]);
    expect(sent[0]?.params.content).toContain('Harborlight Street Works');

    // The widget wrote nothing to the page's source.
    expect(readFileSync(mdPath, 'utf8')).toBe('# Harborlight Street Projects\n\nBody.\n');
  }, 30_000);

  it('refuses an edit list that is not one', async () => {
    for (const pageEdits of [
      [],
      [{ selector: 'h1' }],
      'body > h1',
      [{ ...EDIT, after: EDIT.before }],
    ]) {
      const res = await post(`/workspaces/${WS}/docs/${docId}/threads`, {
        author: PERSON,
        text: 'x',
        anchor: EDIT.anchor,
        pageEdits,
      });
      expect(res.status).toBe(400);
    }
  });

  it('refuses an edit whose element anchor the server cannot store', async () => {
    const res = await post(`/workspaces/${WS}/docs/${docId}/threads`, {
      author: PERSON,
      text: 'x',
      anchor: EDIT.anchor,
      pageEdits: [{ ...EDIT, anchor: { ...EDIT.anchor, fingerprint: { tag: 'H1' } } }],
    });
    expect(res.status).toBe(400);
  });
});
