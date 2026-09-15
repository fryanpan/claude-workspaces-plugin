/**
 * The hosted connector's smaller parts, each driven directly: the identity
 * headers, the snapshot file, the in-process event fetch, and the outbox's
 * gap notice. `connector-host.test.ts` covers how they compose.
 *
 * Names and paths are fictional.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIdentityHeaders, resolveIdentity } from '../src/connector/identity.ts';
import { createOutbox } from '../src/connector/outbox.ts';
import { inProcessEventsFetch } from '../src/connector/session-factory.ts';
import {
  loadConnectorSnapshot,
  saveConnectorSnapshot,
  snapshotPath,
} from '../src/connector/snapshot.ts';
import { waitFor } from './wait-for.ts';

describe('identity headers', () => {
  const read = (h: Record<string, string>) => readIdentityHeaders(new Headers(h));

  it('reads an unexpanded placeholder as unset', () => {
    const r = read({ 'x-cw-agent': '${CW_AGENT_NAME}', 'x-cw-cwd': '/work/riverbend' });
    expect(r).toEqual({ ok: true, headers: { cwd: '/work/riverbend' } });
  });

  it('keeps only a version from the plugin root, never the path', () => {
    expect(
      read({ 'x-cw-cwd': '/w', 'x-cw-plugin-root': '/cache/claude-workspaces/0.1.234' }),
    ).toEqual({
      ok: true,
      headers: { cwd: '/w', pluginVersion: '0.1.234' },
    });
    expect(read({ 'x-cw-cwd': '/w', 'x-cw-plugin-root': '/checkout/packages/plugin' })).toEqual({
      ok: true,
      headers: { cwd: '/w' },
    });
  });

  it('refuses a relative working directory, a control character and a malformed workspace id', () => {
    expect(read({ 'x-cw-cwd': 'work/riverbend' }).ok).toBe(false);
    expect(read({ 'x-cw-cwd': '/work/\triverbend' }).ok).toBe(false);
    expect(read({ 'x-cw-cwd': '/w', 'x-cw-workspace': '../boards' }).ok).toBe(false);
  });

  it('keys a named agent by directory and an unnamed one by session', () => {
    const named = resolveIdentity({ agent: 'Riverbend Alpha', cwd: '/w' }, 's-1');
    const unnamed = resolveIdentity({ cwd: '/w' }, 's-1');
    expect(named.ok && named.identity.key).toBe('agent-riverbend-alpha\n/w');
    expect(unnamed.ok && unnamed.identity.shared && unnamed.identity.key).toBe('shared\ns-1');
  });
});

describe('connector snapshot', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'connector-snapshot-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips identities in a file only its owner can read', () => {
    saveConnectorSnapshot(dir, [{ agent: 'Riverbend Alpha', cwd: '/work/riverbend' }]);
    expect(statSync(snapshotPath(dir)).mode & 0o777).toBe(0o600);
    expect(loadConnectorSnapshot(dir)).toEqual([
      { agent: 'Riverbend Alpha', cwd: '/work/riverbend' },
    ]);
  });

  it('reads a missing or unreadable file as nobody, and drops fields it does not know', () => {
    expect(loadConnectorSnapshot(dir)).toEqual([]);
    writeFileSync(snapshotPath(dir), '{ not json');
    expect(loadConnectorSnapshot(dir)).toEqual([]);
    writeFileSync(
      snapshotPath(dir),
      JSON.stringify({
        version: 1,
        identities: [{ cwd: '/w', token: 'x', agent: 7 }, { agent: 'no cwd' }],
      }),
    );
    expect(loadConnectorSnapshot(dir)).toEqual([{ cwd: '/w' }]);
  });
});

describe('in-process event fetch', () => {
  it('cancels the event stream when the caller aborts, as a socket would', async () => {
    let cancelled = false;
    let opened: { agentId: string; lastEventId: string | null } | null = null;
    const fetchEvents = inProcessEventsFetch((agentId, lastEventId) => {
      opened = { agentId, lastEventId };
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(':ok\n\n'));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const controller = new AbortController();
    const res = await fetchEvents('http://127.0.0.1:1/events/agent/agent-riverbend-alpha', {
      signal: controller.signal,
      headers: { 'Last-Event-ID': 'plan=4' },
    });
    expect(opened).toEqual({ agentId: 'agent-riverbend-alpha', lastEventId: 'plan=4' });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(':ok\n\n');
    controller.abort();
    await waitFor(() => cancelled, { describe: 'the inner stream to be cancelled' });
    expect((await reader.read()).done).toBe(true);
  });

  it('answers any other path 404', async () => {
    const fetchEvents = inProcessEventsFetch(() => new Response('unexpected'));
    expect((await fetchEvents('http://127.0.0.1:1/api/agents/a/watches')).status).toBe(404);
  });
});

describe('outbox', () => {
  it('tells a returning stream that frames aged out before it came back', () => {
    let clock = 0;
    const box = createOutbox({
      epoch: 'e1',
      maxAgeMs: 1_000,
      maxFrames: 10,
      retryMs: 15_000,
      now: () => clock,
      gapNotice: () => ({ gap: true }),
    });
    box.push({ n: 1 });
    clock = 5_000;
    box.push({ n: 2 });
    const written: string[] = [];
    box.attach({ order: 1, write: (t) => written.push(t) }, 'e1-0');
    expect(written.some((t) => t.includes('"gap":true'))).toBe(true);
    expect(written.some((t) => t.includes('"n":1'))).toBe(false);
    expect(written.some((t) => t.includes('"n":2'))).toBe(true);
  });
});
