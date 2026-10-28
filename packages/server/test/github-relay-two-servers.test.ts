/**
 * The GitHub relay between an isolated broker and two real board servers.
 *
 * Harborlight's board subscribes to `harborlight/app`; Riverbend's to
 * `riverbend/site`, and to `harborlight/app` for CI only. Each board's push
 * key is minted on its own server from loopback, as the lead would, and
 * handed to the relay through a stand-in for the Keychain. The broker is
 * `fake-github-broker.ts` on a free port: nothing here reaches GitHub, and
 * the live broker on 7902 is never touched.
 *
 * What this proves: a merge on `harborlight/app` reaches the agent on
 * Harborlight's board and not the agent on Riverbend's, a CI line reaches
 * both, and after the broker restarts on the same port — forgetting every
 * session — the relay registers again and the next event still arrives.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type GithubRelayConfig,
  parseGithubRelayConfig,
} from '../src/github-relay/relay-config.ts';
import { type GithubRelay, createGithubRelay } from '../src/github-relay/relay.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type FakeBroker, startFakeBroker } from './fake-github-broker.ts';
import { type FrameListener, listenFrames } from './sse-frames.ts';
import { waitFor } from './wait-for.ts';

const MERGE =
  '🔀 PR #7 merged on `harborlight/app`: **Harborlight search**\nhttps://github.com/harborlight/app/pull/7';
const CI = '✅ CI **success** on `harborlight/app` (`main` @ 1a2b3c4)';
const RIVER = '🆕 New issue on `riverbend/site`: **Saltmarsh map is blank**';

interface Side {
  name: string;
  handle: ServerHandle;
  board: string;
  agent: string;
  stream: FrameListener;
}

describe('the GitHub relay between a broker and two boards', () => {
  const dirs: string[] = [];
  let broker: FakeBroker;
  let relay: GithubRelay;
  let config: GithubRelayConfig;
  const sides: Side[] = [];
  const keychain = new Map<string, string>();
  const logs: string[] = [];

  const post = async (h: ServerHandle, path: string, body: unknown, method = 'POST') => {
    const res = await fetch(`http://127.0.0.1:${h.port}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  const githubFrames = (s: Side) =>
    s.stream.frames.filter((f) => f.event === 'workspace.github_event').map((f) => f.data?.text);

  async function side(name: string, subscriptions: unknown): Promise<Side> {
    const dir = mkdtempSync(join(tmpdir(), `gh-relay-${name}-`));
    dirs.push(dir);
    const handle = createServer({ port: 0, dataDir: dir });
    const { workspace } = (await post(handle, '/workspaces', { name: `${name} board` })) as {
      workspace: { id: string };
    };
    const agent = `agent-${name.toLowerCase()}`;
    await post(handle, `/workspaces/${workspace.id}/agents`, {
      agentId: agent,
      agentName: name,
      runtime: 'claude-code-local',
    });
    await post(handle, `/api/agents/${agent}/watches`, { add: [`ws:${workspace.id}`] });
    const stream = listenFrames(
      await fetch(`http://127.0.0.1:${handle.port}/events/agent/${agent}`),
    );
    await post(
      handle,
      `/workspaces/${workspace.id}/github-subscriptions`,
      { subscriptions },
      'PUT',
    );
    const { key } = (await post(handle, '/api/github-push-keys', {
      workspaceId: workspace.id,
    })) as {
      key: string;
    };
    keychain.set(`cw-github-push-${name.toLowerCase()}`, key);
    return { name, handle, board: workspace.id, agent, stream };
  }

  beforeAll(async () => {
    broker = startFakeBroker();
    sides.push(await side('Harborlight', [{ repo: 'harborlight/app', kinds: ['merge', 'ci'] }]));
    sides.push(
      await side('Riverbend', [
        { repo: 'riverbend/site', kinds: ['issue'] },
        { repo: 'harborlight/app', kinds: ['ci'] },
      ]),
    );
    const parsed = parseGithubRelayConfig(
      JSON.stringify({
        broker: broker.url,
        boards: Object.fromEntries(
          sides.map((s) => [
            s.name.toLowerCase(),
            {
              baseUrl: `http://127.0.0.1:${s.handle.port}`,
              workspaceId: s.board,
              pushKeyService: `cw-github-push-${s.name.toLowerCase()}`,
            },
          ]),
        ),
      }),
      (service) => {
        const v = keychain.get(service);
        if (!v) throw new Error(`no Keychain entry ${service}`);
        return v;
      },
    );
    if ('error' in parsed) throw new Error(parsed.error);
    config = parsed;
    relay = createGithubRelay({ config, log: (l) => logs.push(l) });
  });

  afterAll(async () => {
    for (const s of sides) {
      await s.stream.stop();
      await s.handle.stop();
    }
    await broker.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const [harbor, river] = [() => sides[0] as Side, () => sides[1] as Side];

  it('registers one broker session per board, watching that board’s repos', async () => {
    await relay.pollOnce();
    const state = await broker.state();
    const byId = new Map(state.map((s) => [s.id, s.repos.sort()]));
    const sessions = relay.sessions();
    expect(byId.get(sessions.harborlight ?? '')).toEqual(['harborlight/app']);
    expect(byId.get(sessions.riverbend ?? '')).toEqual(['harborlight/app', 'riverbend/site']);
  });

  it('a merge reaches the subscribed board only; CI reaches both', async () => {
    expect(await broker.inject('harborlight/app', MERGE)).toBe(2);
    await relay.pollOnce();
    // A sentinel both boards want, after the merge, bounds the window.
    expect(await broker.inject('harborlight/app', CI)).toBe(2);
    await relay.pollOnce();
    await waitFor(() => githubFrames(river()).includes(CI) || undefined, {
      describe: 'the CI frame on Riverbend',
    });
    await waitFor(() => githubFrames(harbor()).includes(CI) || undefined, {
      describe: 'the CI frame on Harborlight',
    });
    expect(githubFrames(harbor())).toEqual([MERGE, CI]);
    expect(githubFrames(river())).toEqual([CI]);
  });

  it('a line about a repo only one board watches reaches that board', async () => {
    expect(await broker.inject('riverbend/site', RIVER)).toBe(1);
    await relay.pollOnce();
    await waitFor(() => githubFrames(river()).includes(RIVER) || undefined, {
      describe: 'the issue frame on Riverbend',
    });
    expect(githubFrames(harbor())).not.toContain(RIVER);
  });

  it('registers again after the broker restarts and forgets every session', async () => {
    const before = relay.sessions();
    await broker.stop();
    // The relay rides out the outage without losing its place.
    await relay.pollOnce();
    expect(logs.some((l) => l.includes('broker not answering'))).toBe(true);
    broker = startFakeBroker(config.broker ? Number(new URL(config.broker).port) : 0);
    expect(await broker.state()).toEqual([]);
    // POSITIVE CONTROL: with no session, the broker queues the line nowhere.
    expect(await broker.inject('harborlight/app', MERGE)).toBe(0);

    await relay.pollOnce();
    const after = relay.sessions();
    expect(after.harborlight).not.toBeNull();
    expect(after.harborlight).not.toBe(before.harborlight);
    expect(logs.some((l) => l.includes('re-registered'))).toBe(true);
    const merged = `${MERGE} (after the restart)`;
    expect(await broker.inject('harborlight/app', merged)).toBe(2);
    await relay.pollOnce();
    await waitFor(() => githubFrames(harbor()).includes(merged) || undefined, {
      describe: 'the post-restart merge on Harborlight',
    });
    expect(githubFrames(river())).not.toContain(merged);
  });

  it('never logs a push key or an event’s text', () => {
    const all = logs.join('\n');
    for (const key of keychain.values()) expect(all).not.toContain(key);
    expect(all).not.toContain('Harborlight search');
  });
});
