/**
 * An open page hears that a list it drew is stale, whoever changed it.
 *
 * Each case opens the stream the page holds FIRST, then makes the change the
 * way another tab or an agent makes it — over REST, or through the store a
 * route would call — and waits for the frame (`page-nudges.ts`). The page
 * side, re-reading and redrawing on that frame, is the workspaces-app suite.
 *
 * All fixtures are invented. Port 0, temp data dirs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOC_STORE_TIMINGS } from '../src/doc-store-timings.ts';
import { NUDGE_COALESCE_MS } from '../src/page-nudges.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const PERSON = { id: 'known-reviewer', name: 'Riverbend', kind: 'person' };

/** Every event name read off an open stream, until stopped. */
function framesOf(res: Response): { names: () => string[]; stop: () => void } {
  const names: string[] = [];
  let buf = '';
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const name = /^event: (.+)$/m.exec(buf.slice(0, sep))?.[1];
          if (name) names.push(name);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
        }
      }
    } catch {
      // Cancelled with a read in flight.
    }
  })();
  return { names: () => names, stop: () => void reader.cancel() };
}

describe('page nudges', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let WS = '';
  const host = { host: 'localhost' };
  const send = (path: string, method: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { ...host, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const open = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: host });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    return framesOf(res);
  };
  const boot = () => {
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'page-nudges-'));
    boot();
    WS = await seedBoard(base, { name: 'Harborlight' });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('an open Library hears a whiteboard made on its board, and lists it at its own page', async () => {
    const page = await open(`/workspaces/${WS}/events:stream`);
    try {
      const made = await send(`/workspaces/${WS}/whiteboards`, 'POST', { title: 'Ferry flow' });
      expect(made.status).toBe(200);
      const { docId } = (await made.json()) as { docId: string };
      await waitFor(() => page.names().includes('library.changed'));
      const items = (await (
        await fetch(`${base}/workspaces/${WS}/library/items`, { headers: host })
      ).json()) as { files: Array<{ name: string; href?: string }> };
      const row = items.files.find((f) => f.name === 'Ferry flow');
      expect(row?.href).toBe(`/workspaces/${WS}/whiteboards/${docId}`);
    } finally {
      page.stop();
    }
  });

  it('an open Library hears a doc filed on its board, then renamed', async () => {
    const page = await open(`/workspaces/${WS}/events:stream`);
    const agent = await open(`/workspaces/${WS}/events:stream?agentId=saltmarsh`);
    try {
      const path = join(dataDir, 'notes.md');
      writeFileSync(path, '# Notes\n\nBody.\n');
      const made = await send(`/workspaces/${WS}/docs`, 'POST', {
        docId: 'notes',
        type: 'markdown',
        sourceUrl: path,
      });
      expect(made.status).toBe(200);
      await waitFor(() => page.names().includes('library.changed'));
      const before = page.names().filter((n) => n === 'library.changed').length;
      const renamed = await send(`/workspaces/${WS}/docs/notes/title`, 'PUT', {
        title: 'Riverbend notes',
        author: PERSON,
      });
      expect(renamed.status).toBe(200);
      await waitFor(() => page.names().filter((n) => n === 'library.changed').length > before);
      // The agent's own stream on the same board never hears it.
      expect(agent.names()).not.toContain('library.changed');
    } finally {
      page.stop();
      agent.stop();
    }
  });

  it('an open members list hears a level changed elsewhere', async () => {
    await handle.stop();
    writeFileSync(
      join(dataDir, 'share-links.json'),
      JSON.stringify({
        links: [],
        members: [
          { workspaceId: WS, email: 'riverbend@example.com', addedAt: 1, viaLinkId: 'l-1' },
        ],
      }),
    );
    boot();
    const page = await open(`/workspaces/${WS}/events:stream`);
    try {
      const res = await send(
        `/workspaces/${WS}/members/${encodeURIComponent('riverbend@example.com')}/role`,
        'POST',
        { role: 'owner' },
      );
      expect(res.status).toBe(200);
      await waitFor(() => page.names().includes('members.changed'));
    } finally {
      page.stop();
    }
  });

  it('an open review sidebar hears a file join the folder it shows', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'page-nudges-folder-'));
    try {
      writeFileSync(join(folder, 'README.md'), '# Harborlight\n');
      writeFileSync(join(folder, 'guide.md'), '# Saltmarsh guide\n');
      const bound = await handle.docStore.bindFolder({ folderPath: folder });
      expect(bound.ok).toBe(true);
      if (!bound.ok) return;
      const page = await open(`/workspaces/${bound.workspaceId}/events:stream`);
      try {
        const opened = await handle.docStore.openContextFile(bound.workspaceId, 'guide.md');
        expect(opened.ok).toBe(true);
        await waitFor(() => page.names().includes('attachments.changed'));
      } finally {
        page.stop();
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('an open folder tree hears a re-scan that found a file on disk', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'page-nudges-rebind-'));
    try {
      writeFileSync(join(folder, 'README.md'), '# Harborlight\n');
      const first = await send('/workspaces', 'POST', { folderPath: folder });
      const { setId } = (await first.json()) as { setId: string };
      // timed: past the first bind's own persist and coalesced frame, so the
      // frame awaited below can only be the re-bind's.
      await new Promise((r) => setTimeout(r, DOC_STORE_TIMINGS.persistMs + NUDGE_COALESCE_MS * 2));
      const page = await open(`/workspaces/${setId}/events:stream`);
      try {
        // A file that only appears on disk changes no member doc: the sidebar
        // lists it from a scan, so the re-scan itself is the news.
        writeFileSync(join(folder, 'tides.txt'), 'Riverbend tides\n');
        const again = await send('/workspaces', 'POST', { folderPath: folder, setId });
        expect(again.status).toBe(200);
        await waitFor(() => page.names().includes('attachments.changed'));
      } finally {
        page.stop();
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('the voice page hears an agent start listening on a board', async () => {
    const page = await open('/api/voice/events:stream');
    const agent = await open(`/workspaces/${WS}/events:stream?agentId=saltmarsh`);
    try {
      await waitFor(() => page.names().includes('voice.changed'));
    } finally {
      page.stop();
      agent.stop();
    }
  });

  it('an open prompts page hears a prompt saved in another tab', async () => {
    const page = await open('/api/prompts/events:stream');
    try {
      const res = await send('/api/prompts/meeting-notes', 'PUT', {
        value: 'Write the notes as Harborlight would.',
        author: PERSON,
      });
      expect(res.status).toBe(200);
      await waitFor(() => page.names().includes('prompts.changed'));
    } finally {
      page.stop();
    }
  });
});
