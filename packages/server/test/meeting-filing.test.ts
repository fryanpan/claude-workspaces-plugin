/**
 * A meeting lives in its project — driven through the real routes.
 *
 * Rule 5 of the docs decision, end to end: the lead names the project's
 * meetings folder, both huddle buttons file into it, the filing record says
 * which project and which lead seat the conversation belonged to, a person can
 * rename it afterwards, and the project's Library lists it.
 *
 * Every refusal here is paired with a positive control on the same server,
 * because "no file in the folder" and "no folder" read alike: the control is
 * a board with NO project, whose meeting still lands in the data dir exactly
 * where every meeting landed before this existed.
 *
 * Fixtures are invented — Riverbend, Harborlight, Saltmarsh. The repo is
 * public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEETING_GITIGNORE_BODY,
  type MeetingFiling,
  listMeetingFilings,
  meetingGitignorePath,
} from '../src/meeting-home.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

const LEAD = 'agent-harborlight-lead';

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

interface LibraryRow {
  name: string;
  href?: string;
  /** Set instead of `href` on a project file no doc holds yet. */
  open?: string;
}

describe('a meeting filed into its project', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let repo: string;
  let WS = '';

  const at = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${handle.port}${path}`, {
      ...init,
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
    });
  const send = (method: string, path: string, body: unknown) =>
    at(path, { method, body: JSON.stringify(body) });
  const ok = async <T>(res: Response): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as T;
  };

  /** The lead's tool: where meetings live, what is kept, and git's view. */
  const setMeetings = (body: Record<string, unknown>) =>
    send('PUT', '/api/mounts/meetings', { path: repo, ...body });
  const startHuddle = (ws: string, kind: 'plan' | 'discussion') =>
    send('POST', `/workspaces/${ws}/huddles`, { kind });
  const filingFor = (docId: string): MeetingFiling | undefined =>
    listMeetingFilings(dataDir).find((f) => f.docId === docId);
  const meetingsFolder = () => join(repo, 'docs', 'meetings');
  const filesIn = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith('.md'))
          .sort()
      : [];

  beforeEach(async () => {
    dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'cw-filing-data-')));
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'cw-filing-repo-')));
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'handbook.md'), '# Volunteer handbook\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    handle = createServer({ port: 0, dataDir });
    WS = await seedBoard(`http://127.0.0.1:${handle.port}`);
    await ok(
      await send('PUT', `/workspaces/${WS}/lead`, {
        leadAgentId: LEAD,
        author: { id: LEAD, name: 'Harborlight lead', kind: 'agent' },
      }),
    );
    // The board works in this project: one bound doc is what says so, the
    // same rule the Library already reads the project off.
    await ok(
      await send('POST', `/workspaces/${WS}/docs`, {
        docId: 'handbook',
        type: 'markdown',
        sourceUrl: join(repo, 'handbook.md'),
        title: 'Volunteer handbook',
      }),
    );
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('files both huddle kinds into the folder the lead named, with their owner on the record', async () => {
    const set = await ok<{ repoKey: string; meetings: { relPath: string } }>(
      await setMeetings({ meetingsPath: 'docs/meetings', retention: 'transcripts' }),
    );
    expect(set.meetings.relPath).toBe('docs/meetings');

    const plan = await ok<{ docId: string }>(await startHuddle(WS, 'plan'));
    const talk = await ok<{ docId: string }>(await startHuddle(WS, 'discussion'));

    // Two files, in the project, where a person greps.
    expect(filesIn(meetingsFolder())).toHaveLength(2);

    for (const [docId, kind] of [
      [plan.docId, 'plan'],
      [talk.docId, 'discussion'],
    ] as const) {
      const filed = filingFor(docId);
      expect(filed?.kind).toBe(kind);
      // Which project, and who was leading it when the button was pressed.
      expect(filed?.repoKey).toBe(set.repoKey);
      expect(filed?.leadAgentId).toBe(LEAD);
      expect(filed?.workspaceId).toBe(WS);
      // Nobody has been heard yet, and saying so is the point of the field.
      expect(filed?.provider).toBe('none');
      expect(filed?.retention).toBe('transcripts');
      // The path on the record is the file that exists.
      expect(filed?.relPath?.startsWith('docs/meetings/')).toBe(true);
      expect(existsSync(join(repo, filed?.relPath ?? 'nowhere'))).toBe(true);
    }
  });

  it('leaves a project that never chose exactly where it was', async () => {
    expect(
      await ok<{ meetings: null }>(
        await at(`/api/mounts/meetings?path=${encodeURIComponent(repo)}`),
      ),
    ).toMatchObject({ meetings: null });

    const talk = await ok<{ docId: string }>(await startHuddle(WS, 'discussion'));
    // Nothing written into the checkout, and the record says the meeting
    // belongs to no folder — not to a folder this server picked.
    expect(filesIn(meetingsFolder())).toEqual([]);
    const filed = filingFor(talk.docId);
    expect(filed?.relPath).toBeUndefined();
    expect(filed?.retention).toBe('transcripts-and-audio');
    // The positive control: the meeting exists, in the data dir, as before.
    expect(filesIn(join(dataDir, 'huddles'))).toHaveLength(1);
  });

  it("keeps the folder out of git when the project says so, and puts it back when it doesn't", async () => {
    await ok(await setMeetings({ meetingsPath: 'docs/meetings', gitignore: true }));
    expect(readFileSync(meetingGitignorePath(meetingsFolder()), 'utf8')).toBe(
      MEETING_GITIGNORE_BODY,
    );
    // Proof it is git's view that changed, not just a file's presence.
    await startHuddle(WS, 'discussion');
    expect(git(repo, 'status', '--porcelain', '--', 'docs/meetings')).toBe('');

    await ok(await setMeetings({ meetingsPath: 'docs/meetings', gitignore: false }));
    expect(existsSync(meetingGitignorePath(meetingsFolder()))).toBe(false);
    expect(git(repo, 'status', '--porcelain', '--', 'docs/meetings')).not.toBe('');
  });

  it('refuses a folder outside the project and a retention nobody offers', async () => {
    const escape = await setMeetings({ meetingsPath: '../elsewhere' });
    expect(escape.status).toBe(400);
    const bad = await setMeetings({ meetingsPath: 'docs/meetings', retention: 'audio-only' });
    expect(bad.status).toBe(400);
    // Neither refusal wrote anything, and the positive control on the same
    // server accepts the same call with the values corrected.
    expect(existsSync(meetingsFolder())).toBe(false);
    await ok(await setMeetings({ meetingsPath: 'docs/meetings', retention: 'none' }));
    const stored = await ok<{ meetings: { retention: string } }>(
      await at(`/api/mounts/meetings?path=${encodeURIComponent(repo)}`),
    );
    expect(stored.meetings.retention).toBe('none');
  });

  it('changes nothing when the folder cannot be made', async () => {
    await ok(await setMeetings({ meetingsPath: 'docs/meetings' }));
    // A file where the folder would go: the choice cannot be applied, so it
    // must not be stored either. A refused settings call that still moved
    // every future meeting would break the feature while reporting failure.
    mkdirSync(join(repo, 'notes'), { recursive: true });
    writeFileSync(join(repo, 'notes', 'archive'), 'not a folder\n');
    const refused = await setMeetings({ meetingsPath: 'notes/archive' });
    expect(refused.status).toBe(400);

    const stored = await ok<{ meetings: { relPath: string } }>(
      await at(`/api/mounts/meetings?path=${encodeURIComponent(repo)}`),
    );
    expect(stored.meetings.relPath).toBe('docs/meetings');
    // And a meeting still lands where the project actually said.
    const talk = await ok<{ docId: string }>(await startHuddle(WS, 'discussion'));
    expect(filingFor(talk.docId)?.relPath?.startsWith('docs/meetings/')).toBe(true);
  });

  it('lets a person rename the meeting, and refuses a blank name', async () => {
    await ok(await setMeetings({ meetingsPath: 'docs/meetings' }));
    const talk = await ok<{ docId: string; meta: { title: string } }>(
      await startHuddle(WS, 'discussion'),
    );
    // The name it is born with is the clock, which is what makes renaming it
    // the point: a week later a list of those is a column of timestamps.
    expect(talk.meta.title).toMatch(/^Meeting notes \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    const renamed = await ok<{ title: string }>(
      await send('PUT', `/workspaces/${WS}/docs/${talk.docId}/title`, {
        title: '  Saltmarsh   tide walk  ',
      }),
    );
    expect(renamed.title).toBe('Saltmarsh tide walk');

    const blank = await send('PUT', `/workspaces/${WS}/docs/${talk.docId}/title`, { title: '   ' });
    expect(blank.status).toBe(400);
    const essay = await send('PUT', `/workspaces/${WS}/docs/${talk.docId}/title`, {
      title: 'x'.repeat(201),
    });
    expect(essay.status).toBe(400);

    // It stuck, read back off the board rather than out of the reply.
    const docs = await ok<{ docs: Array<{ docId: string; title?: string }> }>(
      await at(`/workspaces/${WS}/docs`),
    );
    expect(docs.docs.find((d) => d.docId === talk.docId)?.title).toBe('Saltmarsh tide walk');
  });

  it("lists a meeting with no ticket on the project's Library, under its new name", async () => {
    await ok(await setMeetings({ meetingsPath: 'docs/meetings' }));
    const plan = await ok<{ docId: string }>(await startHuddle(WS, 'plan'));
    await ok(
      await send('PUT', `/workspaces/${WS}/docs/${plan.docId}/title`, {
        title: 'Riverbend winter plan',
      }),
    );

    const lib = await ok<{ meetings: LibraryRow[]; files: LibraryRow[] }>(
      await at(`/workspaces/${WS}/library/items`),
    );
    expect(lib.meetings.map((m) => m.name)).toEqual(['Riverbend winter plan']);
    expect(lib.meetings[0]?.href).toBe(`/workspaces/${WS}/docs/${plan.docId}`);
    // And it is a MEETING, not another project file in the other column.
    expect(lib.files.some((f) => f.name === 'Riverbend winter plan')).toBe(false);
    // Nor is its raw file offered beside it. The meeting holds the project's
    // address, so the file listing does not offer a second bind over the same
    // bytes — which would be one conversation under two names with two comment
    // sets. The positive control is the row above: the listing DID build.
    expect(lib.files.some((f) => f.open?.startsWith('docs/meetings/'))).toBe(false);
  });

  it('mounts the folder it files into, so the Library can open what it lists', async () => {
    const set = await ok<{ mountId: string | null }>(
      await setMeetings({ meetingsPath: 'docs/meetings' }),
    );
    expect(set.mountId).toStartWith('m-');
    mkdirSync(meetingsFolder(), { recursive: true });
    writeFileSync(join(meetingsFolder(), 'earlier.md'), '# An earlier meeting\n');
    const files = await ok<{ files: Array<{ relPath: string }> }>(
      await at(`/api/mounts/files?path=${encodeURIComponent(repo)}&limit=1000`),
    );
    expect(files.files.some((f) => f.relPath === 'docs/meetings/earlier.md')).toBe(true);
  });
});
