/**
 * A served mock is a host page holding a sandboxed frame, and a write relayed
 * out of that frame is recorded as sent from inside the mock.
 *
 * Two halves. The header, host-page and injection helpers are pure and driven
 * directly. The serve and the stamp go through the real route table: open the
 * mock both ways and read the headers the browser received; post a comment,
 * a reply, a resolve and a ticket answer with and without the relay's mark and
 * read back what the server stored; push a thread into the doc over a relayed
 * socket and over a plain one, and see which landed.
 *
 * Fixtures are fictional — a lemonade stand's price board.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createThread } from '@claude-workspaces/core';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import {
  MOCK_FRAME_CSP,
  fileSandboxHeaders,
  frameSrcFor,
  injectFrameScripts,
  isMockFrameRequest,
  mayTouchFrom,
  renderMockHost,
  socketViaOf,
  writeViaOf,
} from '../src/mockup-frame.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';

describe('the frame and host helpers', () => {
  it('reads the frame flag as exactly "1"', () => {
    const u = (q: string) => new URL(`http://board.test/workspaces/w/mockups/d${q}`);
    expect(isMockFrameRequest(u('?cw-frame=1'))).toBe(true);
    for (const q of ['', '?cw-frame=0', '?cw-frame=true', '?cw-frame=', '?cw-frame=11']) {
      expect(isMockFrameRequest(u(q))).toBe(false);
    }
  });

  it('sandboxes the frame without ever giving the mock the board origin back', () => {
    expect(MOCK_FRAME_CSP.startsWith('sandbox ')).toBe(true);
    expect(MOCK_FRAME_CSP).toContain("frame-ancestors 'self'");
    expect(MOCK_FRAME_CSP).toContain('allow-scripts');
    expect(MOCK_FRAME_CSP).not.toContain('allow-same-origin');
  });

  it('sandboxes a served file with no scripts, except a PDF the browser would not render', () => {
    expect(fileSandboxHeaders('/tmp/board.svg')).toEqual({ 'content-security-policy': 'sandbox' });
    expect(fileSandboxHeaders('/tmp/board.HTML')).toEqual({
      'content-security-policy': 'sandbox',
    });
    expect(fileSandboxHeaders('/tmp/menu.PDF')).toEqual({});
  });

  it('takes the mark only in its one spelling', () => {
    const req = (v?: string) =>
      new Request('http://board.test/x', { headers: v === undefined ? {} : { 'x-cw-via': v } });
    expect(writeViaOf(req('mock-frame'))).toBe('mock-frame');
    for (const v of [undefined, '', 'Mock-Frame', 'mock-frame,x', 'agent']) {
      expect(writeViaOf(req(v))).toBeUndefined();
    }
    expect(socketViaOf(new URL('http://b.test/y?cw-via=mock-frame'))).toBe('mock-frame');
    expect(socketViaOf(new URL('http://b.test/y?cw-via=other'))).toBeUndefined();
    expect(socketViaOf(new URL('http://b.test/y'))).toBeUndefined();
  });

  it('lets a relayed edit reach only what was itself written from inside the mock', () => {
    expect(mayTouchFrom('mock-frame', { via: 'mock-frame' })).toBe(true);
    expect(mayTouchFrom('mock-frame', {})).toBe(false);
    expect(mayTouchFrom('mock-frame', undefined)).toBe(false);
    expect(mayTouchFrom(undefined, {})).toBe(true);
    expect(mayTouchFrom(undefined, undefined)).toBe(true);
  });

  it("passes the page's own query to the frame, with one frame flag", () => {
    const src = frameSrcFor(
      new URL('http://b.test/workspaces/w/mockups/d?v=2&thread=t1&cw-frame=0'),
    );
    const q = new URLSearchParams(src.slice(1));
    expect(q.get('v')).toBe('2');
    expect(q.get('thread')).toBe('t1');
    expect(q.getAll('cw-frame')).toEqual(['1']);
  });

  it('renders a host page whose frame is sandboxed, unloaded, and names no mock markup', () => {
    const html = renderMockHost({
      workspaceId: 'w-stand',
      docId: 'd"><x',
      html: '<html><head><title>Price board</title></head><body><script>steal()</script></body></html>',
      url: new URL('http://b.test/workspaces/w-stand/mockups/d?v=3'),
      items: [{ taskId: 't-1', reviewItemId: 'r-1' }],
    });
    const frame = html.match(/<iframe\b[^>]*>/)?.[0] ?? '';
    expect(frame).toContain('sandbox="allow-scripts');
    expect(frame).not.toContain('allow-same-origin');
    expect(frame).not.toMatch(/\ssrc=/);
    expect(frame).toContain('data-src="?v=3&amp;cw-frame=1"');
    expect(html).toContain('<title>Price board</title>');
    expect(html).not.toContain('steal()');
    expect(html).not.toContain('d"><x');
    expect(html).toContain('data-items="[[&quot;t-1&quot;,&quot;r-1&quot;]]"');
  });

  it('inlines the bridge first, and the widget and live scripts in place of their tags', () => {
    const dist = mkdtempSync(join(tmpdir(), 'mock-frame-dist-'));
    writeFileSync(join(dist, 'mock-bridge.js'), 'window.bridge=1;');
    writeFileSync(join(dist, 'widget.iife.js'), 'var s="</script><!--";');
    writeFileSync(join(dist, 'mockup-live.js'), 'window.live=1;');
    const page =
      '<!doctype html><html><head><script>mine()</script></head><body>' +
      '<script src="/widget.iife.js"></script>' +
      '<script src="/widget/mockup-live.js" data-cw-live data-doc-id="d-1" data-versions="[1,2]"></script>' +
      '</body></html>';
    const out = injectFrameScripts(page, dist);
    rmSync(dist, { recursive: true, force: true });
    expect(out.indexOf('window.bridge=1')).toBeLessThan(out.indexOf('mine()'));
    expect(out).not.toContain('src="/widget.iife.js"');
    expect(out).not.toContain('src="/widget/mockup-live.js"');
    expect(out).toContain('<script data-feedback-widget>var s="<\\/script><\\!--";</script>');
    expect(out).toContain(
      '<script data-feedback-widget data-cw-live data-doc-id="d-1" data-versions="[1,2]">window.live=1;</script>',
    );
    // Without a built bundle the page is left exactly as it was.
    expect(injectFrameScripts(page, null)).toBe(page);
  });
});

describe('serving a mock through its host, and stamping what the frame sends', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let ws = '';
  let mock = '';
  let taskId = '';
  const LOCAL = () => ({ host: `localhost:${handle.port}` });
  const AGENT = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };
  const PERSON = { id: 'person:reviewer', name: 'Reviewer', kind: 'person' };
  const RELAYED = { 'x-cw-via': 'mock-frame' };

  const post = async (path: string, body: unknown, extra: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...LOCAL(), ...extra },
      body: JSON.stringify(body),
    });
    expect(res.ok, `${path} ${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<Record<string, unknown>>;
  };
  const get = (path: string) => fetch(`${base}${path}`, { headers: LOCAL() });
  interface StoredThread {
    status: string;
    statusVia?: string;
    comments: Array<{ text: string; via?: string }>;
  }
  const thread = async (id: string) =>
    (
      (await (await get(`/workspaces/${ws}/docs/${mock}/threads/${id}`)).json()) as {
        thread: StoredThread;
      }
    ).thread;
  const newThread = async (text: string, extra: Record<string, string> = {}) =>
    (
      (await post(
        `/workspaces/${ws}/docs/${mock}/threads`,
        { author: PERSON, text, anchor: { kind: 'subject' } },
        extra,
      )) as { thread: { id: string } }
    ).thread.id;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mockup-frame-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    ws = (
      (await post('/workspaces', { name: 'Lemonade stand', author: AGENT })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    const file = join(dataDir, 'price-board.html');
    writeFileSync(
      file,
      '<!doctype html><html><head><title>Price board</title></head><body><h1>Riverbend prices</h1></body></html>',
    );
    mock = (
      (await post(`/workspaces/${ws}/docs`, {
        docId: 'price-board',
        type: 'mockup',
        sourceUrl: file,
      })) as { docId: string }
    ).docId;
    await post(`/workspaces/${ws}/docs:attach`, { docId: mock });
    taskId = (
      (await post(`/workspaces/${ws}/tasks`, {
        title: 'Price board',
        assignee: 'Cartographer',
        author: AGENT,
      })) as { task: { id: string } }
    ).task.id;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("answers the mock's address with the host page, and ?cw-frame=1 with the sandboxed mock", async () => {
    const host = await get(`/workspaces/${ws}/mockups/${mock}?v=1`);
    const hostHtml = await host.text();
    expect(host.status).toBe(200);
    expect(host.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    expect(hostHtml).toContain('data-src="?v=1&amp;cw-frame=1"');
    expect(hostHtml).toContain('/widget/mock-host.js');
    expect(hostHtml).not.toContain('Riverbend prices');

    const frame = await get(`/workspaces/${ws}/mockups/${mock}?v=1&cw-frame=1`);
    expect(frame.status).toBe(200);
    expect(frame.headers.get('content-security-policy')).toBe(MOCK_FRAME_CSP);
    expect(frame.headers.get('x-mockup-version')).toBe('1');
    const frameHtml = await frame.text();
    expect(frameHtml).toContain('Riverbend prices');
    expect(frameHtml).toContain('claude-feedback-widget');

    // An unknown round is a 404 at the host too, not a frame of nothing.
    expect((await get(`/workspaces/${ws}/mockups/${mock}?v=99`)).status).toBe(404);
  });

  it('sandboxes a mock that is an SVG file', async () => {
    const svg = join(dataDir, 'menu.svg');
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"><script>steal()</script></svg>');
    const id = (
      (await post(`/workspaces/${ws}/docs`, {
        docId: 'menu-svg',
        type: 'mockup',
        sourceUrl: svg,
      })) as { docId: string }
    ).docId;
    const res = await get(`/workspaces/${ws}/mockups/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
  });

  it('lists on the host the ticket items docked on this mock', async () => {
    const filed = (await post(`/workspaces/${ws}/tasks/${taskId}/review-items`, {
      author: AGENT,
      review: {
        shape: 'review',
        headline: 'Is the price board readable from the street?',
        detail: `Check [the board](/workspaces/${ws}/mockups/${mock}) at phone width.`,
      },
    })) as { item: { id: string }; held?: boolean };
    if (filed.held) {
      await post(`/workspaces/${ws}/tasks/${taskId}/review-items/${filed.item.id}/release`, {
        author: PERSON,
      });
    }
    const html = await (await get(`/workspaces/${ws}/mockups/${mock}`)).text();
    const items = JSON.parse(
      (html.match(/data-items="([^"]*)"/)?.[1] ?? '[]').replace(/&quot;/g, '"'),
    );
    expect(items).toEqual([[taskId, filed.item.id]]);

    // A ticket answer through the relay carries the mark; the task stores it.
    await post(
      `/workspaces/${ws}/tasks/${taskId}/review-items/${filed.item.id}/answer`,
      { author: PERSON, text: 'Readable.' },
      RELAYED,
    );
    const answered = handle.tasks.listReviewItems(taskId).find((r) => r.id === filed.item.id);
    expect(answered?.answer?.via).toBe('mock-frame');
  });

  it('stamps a relayed comment, reply and resolve — and leaves the direct ones unmarked', async () => {
    const relayed = await newThread('The prices are too small.', RELAYED);
    const direct = await newThread('The prices look fine.');
    expect((await thread(relayed)).comments[0]?.via).toBe('mock-frame');
    expect((await thread(direct)).comments[0]?.via).toBeUndefined();

    await post(
      `/workspaces/${ws}/docs/${mock}/threads/${direct}/comments`,
      { author: PERSON, text: 'From inside.' },
      RELAYED,
    );
    await post(`/workspaces/${ws}/docs/${mock}/threads/${relayed}/comments`, {
      author: PERSON,
      text: 'From the board.',
    });
    expect((await thread(direct)).comments.map((c) => c.via)).toEqual([undefined, 'mock-frame']);
    expect((await thread(relayed)).comments.map((c) => c.via)).toEqual(['mock-frame', undefined]);

    await post(
      `/workspaces/${ws}/docs/${mock}/threads/${relayed}/resolve`,
      { author: PERSON },
      RELAYED,
    );
    await post(`/workspaces/${ws}/docs/${mock}/threads/${direct}/resolve`, { author: PERSON });
    const r = await thread(relayed);
    const d = await thread(direct);
    expect([r.status, r.statusVia]).toEqual(['resolved', 'mock-frame']);
    expect([d.status, d.statusVia]).toEqual(['resolved', undefined]);

    // A later unmarked reopen clears the mark: it names the LAST status change.
    await post(`/workspaces/${ws}/docs/${mock}/threads/${relayed}/reopen`, { author: PERSON });
    expect((await thread(relayed)).statusVia).toBeUndefined();
  });

  it('lets voice feedback tidy and re-pin its own comment from inside the mock, and nothing typed on the board', async () => {
    const spoken = await newThread('The prices are to small.', RELAYED);
    const typed = await newThread('The prices are fine.');
    const firstComment = async (id: string) =>
      (
        (await get(`/workspaces/${ws}/docs/${mock}/threads/${id}`)).json() as Promise<{
          thread: { comments: Array<{ id: string; text: string }>; anchor: { kind: string } };
        }>
      ).then((j) => j.thread);
    const edit = (id: string, commentId: string, text: string, extra: Record<string, string>) =>
      fetch(`${base}/workspaces/${ws}/docs/${mock}/threads/${id}/edit-comment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...LOCAL(), ...extra },
        body: JSON.stringify({ author: PERSON, commentId, text }),
      });
    const reanchor = (id: string, extra: Record<string, string>) =>
      fetch(`${base}/workspaces/${ws}/docs/${mock}/threads/${id}/reanchor`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...LOCAL(), ...extra },
        body: JSON.stringify({
          anchor: { kind: 'element', selector: 'h1', textSnippet: 'Riverbend prices' },
        }),
      });

    const s0 = await firstComment(spoken);
    const t0 = await firstComment(typed);
    expect(
      (await edit(spoken, s0.comments[0]?.id ?? '', 'The prices are too small.', RELAYED)).status,
    ).toBe(200);
    expect((await reanchor(spoken, RELAYED)).status).toBe(200);
    expect((await firstComment(spoken)).comments[0]?.text).toBe('The prices are too small.');

    const refusedEdit = await edit(
      typed,
      t0.comments[0]?.id ?? '',
      'The prices are wrong.',
      RELAYED,
    );
    expect([refusedEdit.status, ((await refusedEdit.json()) as { error: string }).error]).toEqual([
      403,
      'mock_frame_edit_refused',
    ]);
    expect((await reanchor(typed, RELAYED)).status).toBe(403);
    const t1 = await firstComment(typed);
    expect(t1.comments[0]?.text).toBe('The prices are fine.');
    expect(t1.anchor.kind).toBe('subject');

    // The same edit from the board itself is judged as it always was.
    expect((await edit(typed, t0.comments[0]?.id ?? '', 'The prices are wrong.', {})).status).toBe(
      200,
    );
    expect((await reanchor(typed, {})).status).toBe(200);
  });

  it('creates no doc for a relayed live socket naming one that does not exist', async () => {
    const wsBase = base.replace(/^http/, 'ws');
    const open = (docId: string, q: string) =>
      new Promise<string>((resolve) => {
        const sock = new WebSocket(`${wsBase}/workspaces/${ws}/docs/${docId}/y?type=mockup${q}`, {
          headers: LOCAL(),
        } as unknown as string[]);
        sock.addEventListener('open', () => {
          resolve('open');
          sock.close();
        });
        sock.addEventListener('error', () => resolve('refused'));
      });
    expect(await open('d-unmade', '&cw-via=mock-frame')).toBe('refused');
    expect(handle.docStore.get('d-unmade')).toBeFalsy();
    // CONTROL: the same socket without the mark makes the doc, as the widget's first visit does.
    expect(await open('d-plainnew', '')).toBe('open');
    expect(handle.docStore.get('d-plainnew')).toBeTruthy();
  });

  it('takes no edit from a relayed live socket, and the same edit from a plain one', async () => {
    const wsBase = base.replace(/^http/, 'ws');
    const push = async (via: boolean, threadId: string) => {
      const q = via ? '?cw-via=mock-frame' : '';
      const sock = new WebSocket(`${wsBase}/workspaces/${ws}/docs/${mock}/y${q}`, {
        headers: LOCAL(),
      } as unknown as string[]);
      sock.binaryType = 'arraybuffer';
      const replies: number[] = [];
      sock.addEventListener('message', (ev) => {
        const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
        if (decoding.readVarUint(dec) === 0) replies.push(decoding.readVarUint(dec));
      });
      await new Promise((r) => sock.addEventListener('open', r, { once: true }));
      const local = new Y.Doc();
      createThread(local, {
        threadId,
        anchor: { kind: 'subject' },
        createdBy: { id: 'anon-x', kind: 'known', name: 'Mallory', color: '#000' },
        firstComment: { id: `${threadId}-c`, text: 'planted' },
      });
      const up = encoding.createEncoder();
      encoding.writeVarUint(up, 0);
      syncProtocol.writeUpdate(up, Y.encodeStateAsUpdate(local));
      sock.send(encoding.toUint8Array(up));
      // A step 1 AFTER the update: its reply proves the server has read the
      // update frame, since one socket's frames are handled in order.
      const ask = encoding.createEncoder();
      encoding.writeVarUint(ask, 0);
      syncProtocol.writeSyncStep1(ask, new Y.Doc());
      sock.send(encoding.toUint8Array(ask));
      await waitFor(
        () => replies.filter((t) => t === syncProtocol.messageYjsSyncStep2).length >= 1,
      );
      sock.close();
    };
    await push(false, 'th-plain-socket');
    await push(true, 'th-relayed-socket');
    // CONTROL: the plain socket's thread is in the doc, so the handshake and
    // the update are real and the absence below is the read-only rule.
    expect((await get(`/workspaces/${ws}/docs/${mock}/threads/th-plain-socket`)).status).toBe(200);
    expect((await get(`/workspaces/${ws}/docs/${mock}/threads/th-relayed-socket`)).status).toBe(
      404,
    );
  });
});
