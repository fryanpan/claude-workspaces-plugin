/**
 * The voice page and its agent list: who may read them, and what the list
 * says. The gate is driven directly with each kind of caller; the list is
 * read once through the real server.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchRow } from '../src/routes/row-dispatch.ts';
import {
  type VoicePageRouteRequest,
  type VoicePageRoutesContext,
  handleVoicePageRoutes,
} from '../src/routes/voice-page.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { voiceAgentList } from '../src/voice-agent-list.ts';
import { rowAt } from './route-row.ts';

const ctx: VoicePageRoutesContext = {
  agents: () => [{ id: 'w-1', name: 'Harborlight', agents: [] }],
  renderPage: () => '<p>voice</p>',
  pageHeaders: { 'content-type': 'text/html' },
  stream: () => new Response('stream', { headers: { 'content-type': 'text/event-stream' } }),
  j: (status, body) => Response.json(body, { status }),
};

function ask(path: string, who: Partial<VoicePageRouteRequest> = {}) {
  return handleVoicePageRoutes(ctx, {
    req: new Request(`http://127.0.0.1${path}`),
    row: rowAt('voice-page.ts', new URL(`http://127.0.0.1${path}`).pathname),
    visitor: null,
    ownerProven: () => false,
    anyoneProven: () => false,
    mustSignIn: () => false,
    ...who,
  });
}

describe('who may open the voice page', () => {
  it('answers only its own two paths', () => {
    expect(matchRow('voice-page.ts', '/voices')).toBeNull();
    expect(matchRow('voice-page.ts', '/api/voice/agent')).toBeNull();
  });

  it('the owner, signed in, gets the page and the list', async () => {
    const owner = { ownerProven: () => true, anyoneProven: () => true, mustSignIn: () => false };
    expect(ask('/voice?agent=harborlight', owner)?.status).toBe(200);
    const list = ask('/api/voice/agents', owner);
    expect(await list?.json()).toEqual({
      boards: [{ id: 'w-1', name: 'Harborlight', agents: [] }],
    });
  });

  it('a share or collab visitor is refused, whatever else it proves', () => {
    const visitor = {
      visitor: { kind: 'share' },
      ownerProven: () => false,
      anyoneProven: () => true,
    };
    expect(ask('/voice', visitor)?.status).toBe(403);
    expect(ask('/api/voice/agents', visitor)?.status).toBe(403);
    expect(ask('/api/voice/events:stream', visitor)?.status).toBe(403);
  });

  it('the live stream sits behind the same owner check as the list', () => {
    const owner = { ownerProven: () => true, anyoneProven: () => true };
    expect(ask('/api/voice/events:stream', owner)?.headers.get('content-type')).toBe(
      'text/event-stream',
    );
    expect(ask('/api/voice/events:stream', { anyoneProven: () => true })?.status).toBe(403);
    expect(ask('/api/voice/events:stream', { mustSignIn: () => true })?.status).toBe(401);
  });

  it('a signed-in person who is not the owner is refused', () => {
    const bob = { anyoneProven: () => true, mustSignIn: () => false };
    expect(ask('/voice', bob)?.status).toBe(403);
    expect(ask('/api/voice/agents', bob)?.status).toBe(403);
  });

  it('nobody proven, where sign-in is on: the list is 401, and the page only says so', () => {
    expect(ask('/api/voice/agents', { mustSignIn: () => true })?.status).toBe(401);
    expect(ask('/voice?agent=harborlight', { mustSignIn: () => true })?.status).toBe(200);
  });

  it('nobody proven, where sign-in is off: the trusted local page every board serves', () => {
    expect(ask('/voice')?.status).toBe(200);
  });

  it('reads only', () => {
    const r = handleVoicePageRoutes(ctx, {
      req: new Request('http://127.0.0.1/api/voice/agents', { method: 'POST' }),
      row: rowAt('voice-page.ts', '/api/voice/agents'),
      visitor: null,
      ownerProven: () => true,
      anyoneProven: () => true,
      mustSignIn: () => false,
    });
    expect(r?.status).toBe(405);
  });
});

describe('voiceAgentList', () => {
  it('puts the lead first, then by name, and drops boards with nobody on them', () => {
    const list = voiceAgentList({
      boards: () => [
        { id: 'w-1', name: 'Harborlight', leadAgentId: 'riverbend' },
        { id: 'w-2', name: 'Saltmarsh' },
      ],
      attachments: (ws) =>
        ws === 'w-1'
          ? [
              { agentId: 'alice-helper', listening: false },
              { agentId: 'riverbend', listening: true },
            ]
          : [],
      displayName: (id) => (id === 'riverbend' ? 'Riverbend Lead' : undefined),
    });
    expect(list).toEqual([
      {
        id: 'w-1',
        name: 'Harborlight',
        agents: [
          { agentId: 'riverbend', name: 'Riverbend Lead', listening: true, lead: true },
          { agentId: 'alice-helper', name: 'alice-helper', listening: false, lead: false },
        ],
      },
    ]);
  });
});

describe('the list through the real server', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-voice-page-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const live = await fetch(`${base}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Harborlight' }),
    });
    const id = ((await live.json()) as { workspace: { id: string } }).workspace.id;
    handle.tasks.attachAgent(id, {
      agentId: 'harborlight-lead',
      agentName: 'Harborlight Lead',
      runtime: 'claude-code-local',
      endpoint: 'http://10.0.0.9:7777',
    });
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('names each agent and nothing about the machine it runs on', async () => {
    const res = await fetch(`${base}/api/voice/agents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { boards: Array<{ name: string; agents: unknown[] }> };
    const board = body.boards.find((b) => b.name === 'Harborlight');
    expect(board?.agents).toEqual([
      { agentId: 'harborlight-lead', name: 'Harborlight Lead', listening: false, lead: true },
    ]);
    expect(JSON.stringify(body)).not.toContain('10.0.0.9');
  });

  it('serves the page shell with its own script', async () => {
    const res = await fetch(`${base}/voice?agent=harborlight-lead`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});
