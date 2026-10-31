/**
 * `middleware/lead-scope.ts` on its own: what a lead on Harborlight reaches
 * beyond a member's scope, and that each of those is refused for Riverbend.
 * The server-level cases, over a real socket and a held token, are
 * `board-socket-lead.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { boardAgentScopeAllows } from '../src/middleware/board-agent-door.ts';
import { boardSocketScopeAllows } from '../src/middleware/board-socket-door.ts';
import { leadScopeAllows } from '../src/middleware/lead-scope.ts';

const HARBORLIGHT = 'w-harbor';
const RIVERBEND = 'w-river';
/** Docs and rows: one on each board. */
const owners: Record<string, string[]> = {
  'harbor-plan': [HARBORLIGHT],
  'river-plan': [RIVERBEND],
  'task:t-harbor': [HARBORLIGHT],
  'task:t-river': [RIVERBEND],
};
const workspacesOf = (id: string) => owners[id] ?? [];
const allows = (path: string, method: string) =>
  leadScopeAllows(path, method, HARBORLIGHT, workspacesOf);

/** Each new path, on Harborlight and the same path on Riverbend. */
const CASES: Array<[string, string, string]> = [
  ['GET', `/workspaces/${HARBORLIGHT}/docs`, `/workspaces/${RIVERBEND}/docs`],
  [
    'POST',
    `/workspaces/${HARBORLIGHT}/docs/harbor-plan/content`,
    `/workspaces/${RIVERBEND}/docs/river-plan/content`,
  ],
  [
    'POST',
    `/workspaces/${HARBORLIGHT}/agents/Harborlight%20Lead/notes`,
    `/workspaces/${RIVERBEND}/agents/Harborlight%20Lead/notes`,
  ],
  [
    'POST',
    `/workspaces/${HARBORLIGHT}/agents/Harborlight%20Lead/prompts`,
    `/workspaces/${RIVERBEND}/agents/Harborlight%20Lead/prompts`,
  ],
  [
    'POST',
    `/workspaces/${HARBORLIGHT}/agents/Harborlight%20Lead/mirror`,
    `/workspaces/${RIVERBEND}/agents/Harborlight%20Lead/mirror`,
  ],
  [
    'POST',
    `/workspaces/${HARBORLIGHT}/tasks/t-harbor/notes`,
    `/workspaces/${RIVERBEND}/tasks/t-river/notes`,
  ],
  ['POST', `/workspaces/${HARBORLIGHT}/git/push`, `/workspaces/${RIVERBEND}/git/push`],
  [
    'GET',
    `/workspaces/${HARBORLIGHT}/git/pushes/${'a'.repeat(24)}`,
    `/workspaces/${RIVERBEND}/git/pushes/${'a'.repeat(24)}`,
  ],
];

describe('leadScopeAllows', () => {
  it('reaches each lead path on its own board, and none of them on another', () => {
    for (const [method, own, other] of CASES) {
      expect(allows(own, method), own).toBe(true);
      expect(allows(other, method), other).toBe(false);
    }
  });

  it('refuses another board’s row spelled under its own board', () => {
    expect(allows(`/workspaces/${HARBORLIGHT}/tasks/t-river/notes`, 'POST')).toBe(false);
  });

  it('reaches the folder bind path, which names no board; the route holds its body', () => {
    expect(allows('/workspaces', 'POST')).toBe(true);
    expect(allows('/workspaces', 'GET')).toBe(false);
  });

  it('refuses a rewrite of another board’s doc spelled under its own board', () => {
    expect(allows(`/workspaces/${HARBORLIGHT}/docs/river-plan/content`, 'POST')).toBe(false);
    expect(allows(`/workspaces/${HARBORLIGHT}/docs/harbor-plan/content`, 'GET')).toBe(false);
  });

  it('names its verbs, and nothing else', () => {
    for (const [method, path] of [
      ['POST', `/workspaces/${HARBORLIGHT}/docs`],
      ['DELETE', `/workspaces/${HARBORLIGHT}/docs/harbor-plan`],
      ['POST', `/workspaces/${HARBORLIGHT}/docs/harbor-plan/reparse_from_disk`],
      ['GET', `/workspaces/${HARBORLIGHT}/docs/harbor-plan/content/extra`],
      ['GET', `/workspaces/${HARBORLIGHT}/agents/Harborlight%20Lead/notes`],
      ['POST', `/workspaces/${HARBORLIGHT}/attachments`],
      ['POST', `/workspaces/${HARBORLIGHT}/mounts`],
      ['POST', '/api/board-tokens'],
      ['GET', `/workspaces/${HARBORLIGHT}/git/push`],
      ['POST', `/workspaces/${HARBORLIGHT}/git/pushes/${'a'.repeat(24)}`],
      ['GET', `/workspaces/${HARBORLIGHT}/git/pushes/../push`],
    ] as const)
      expect(allows(path, method), `${method} ${path}`).toBe(false);
  });
});

describe('the two doors that use it', () => {
  const grant = { tokenId: 't-held', agentId: 'agent-alice', boardId: HARBORLIGHT };

  it('a held board token reaches the lead paths on its board, and an ordinary one does not', () => {
    for (const [method, own, other] of CASES) {
      expect(boardAgentScopeAllows(own, method, grant, workspacesOf, true), own).toBe(true);
      expect(boardAgentScopeAllows(other, method, grant, workspacesOf, true), other).toBe(false);
      // The control: a token an operator minted is a member, and is refused.
      expect(boardAgentScopeAllows(own, method, grant, workspacesOf, false), own).toBe(false);
    }
  });

  it('a request on the board’s socket reaches them on its board alone', () => {
    for (const [method, own, other] of CASES) {
      expect(boardSocketScopeAllows(own, method, HARBORLIGHT, null, workspacesOf), own).toBe(true);
      expect(boardSocketScopeAllows(other, method, HARBORLIGHT, null, workspacesOf), other).toBe(
        false,
      );
    }
  });
});
