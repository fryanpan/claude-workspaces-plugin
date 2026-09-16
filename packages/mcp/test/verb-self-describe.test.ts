/**
 * Two verbs that have to say what they can do, in their own answers.
 *
 * A capability announced only in a skill goes unused: a skill is read once,
 * near the start of a session, and the two measured cases on this board are
 * the folder-mount pointer (in both skills for three days, learned by nobody
 * from their own path) and a scheduled rule's output folder (shipped, and
 * declared by no rule until somebody was told by hand). So `attach_agent`
 * carries a `mounts` brief and `set_task_schedule` carries an `output` line,
 * and what has to hold is that BOTH survive the trip through the MCP child to
 * the caller — a handler that assembles a response field by field is exactly
 * where a new field is silently dropped.
 *
 * Driven through the committed bundle, the artifact a peer loads, with a stub
 * standing in for the board. All fixtures are synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BundleHarness, startBundle } from './harness/mcp-bundle.ts';

/** A board whose project serves two folders. */
const MOUNTED = {
  project: 'git:example/harborlight',
  count: 2,
  folders: ['docs/mocks', 'reports'],
  note: 'This project serves 2 mounted folders (docs/mocks, reports). list_mounts reads the table and mount_folder adds one. A mount is a filesystem walk, so ignored and uncommitted files under it are served too — .gitignore is not a privacy control.',
};

/** A board with nothing mounted, which is the case the field exists for. */
const NONE = {
  project: null,
  count: 0,
  note: 'No folder of this project is mounted, so none of its files are on the board. mount_folder(path) mounts one: the server walks that folder on disk and serves every file under it. It is a filesystem walk, not a git listing — .gitignore is not a privacy control.',
};

const scheduleBody = (output?: { folder: string }) => ({
  task: {
    id: 't-stub',
    schedule: {
      rule: { kind: 'every', everyMs: 3_600_000 },
      armedAt: Date.now(),
      ...(output ? { output } : {}),
    },
  },
});

let mounted: BundleHarness;
let bare: BundleHarness;

beforeAll(async () => {
  mounted = await startBundle((r) => {
    if (r.method === 'POST' && r.path.endsWith('/agents')) {
      return { ok: true, attachment: { agentId: 'agent-harness' }, mounts: MOUNTED };
    }
    if (r.method === 'POST' && r.path.endsWith('/schedule')) {
      return scheduleBody({ folder: 'digests' });
    }
    return {};
  });
  bare = await startBundle((r) => {
    if (r.method === 'POST' && r.path.endsWith('/agents')) {
      return { ok: true, attachment: { agentId: 'agent-harness' }, mounts: NONE };
    }
    if (r.method === 'POST' && r.path.endsWith('/schedule')) return scheduleBody();
    return {};
  });
}, 60_000);

afterAll(async () => {
  await mounted?.stop();
  await bare?.stop();
});

describe('attach_agent hands the mount brief to the session', () => {
  it('carries the count, the folders and the note for a project that serves some', async () => {
    const res = await mounted.call('attach_agent', { workspaceId: 'w-stub' });
    const body = res.json as { mounts?: typeof MOUNTED; agentId?: string };
    // Positive control: a real attach result, so a field assertion is an
    // assertion about a response that happened.
    expect(body.agentId).toBe('agent-harness');
    expect(body.mounts?.count).toBe(2);
    expect(body.mounts?.folders).toEqual(['docs/mocks', 'reports']);
    expect(body.mounts?.note).toContain('.gitignore is not a privacy control');
  });

  it('carries the what-a-mount-is sentence for a board with none', async () => {
    const res = await bare.call('attach_agent', { workspaceId: 'w-stub' });
    const body = res.json as { mounts?: typeof NONE; agentId?: string };
    expect(body.agentId).toBe('agent-harness');
    expect(body.mounts?.count).toBe(0);
    expect(body.mounts?.note).toContain('mount_folder');
  });

  it('points at the field in the declaration a client reads', async () => {
    const decl = mounted.tool('attach_agent');
    expect(decl?.description).toContain('mounts');
    expect(decl?.description).toContain('mount_folder');
  });
});

describe('mount_folder says what a mount exposes', () => {
  it('declares the filesystem walk and the .gitignore caveat', async () => {
    // The text every session is handed at tools/list, not a source literal.
    const decl = mounted.tool('mount_folder');
    expect(decl?.description).toContain('.gitignore is not a privacy control');
    expect(decl?.description?.toLowerCase()).toContain('walks the folder on disk');
  });
});

describe('set_task_schedule says what the rule writes', () => {
  it('echoes a declared folder and what it buys', async () => {
    const res = await mounted.call('set_task_schedule', {
      workspaceId: 'w-stub',
      taskId: 't-stub',
      rule: { kind: 'every', everyMs: 3_600_000 },
      output: { folder: 'digests' },
    });
    const body = res.json as { output?: { folder: string | null; note: string }; taskId?: string };
    expect(body.taskId).toBe('t-stub');
    expect(body.output?.folder).toBe('digests');
    expect(body.output?.note).toContain('digests');
    expect(body.output?.note).toContain('review item');
  });

  it('tells a rule with no folder that it can declare one', async () => {
    const res = await bare.call('set_task_schedule', {
      workspaceId: 'w-stub',
      taskId: 't-stub',
      rule: { kind: 'every', everyMs: 3_600_000 },
    });
    const body = res.json as { output?: { folder: string | null; note: string }; taskId?: string };
    expect(body.taskId).toBe('t-stub');
    // Null, never absent: absent would read as "this bundle is too old to
    // know", and the point of the line is that the bundle always knows.
    expect(body.output?.folder).toBeNull();
    expect(body.output?.note).toContain('output');
    expect(body.output?.note).toContain('review item');
  });

  it('points at the field in the declaration a client reads', async () => {
    const decl = mounted.tool('set_task_schedule');
    expect(decl?.description).toContain('output');
  });
});
