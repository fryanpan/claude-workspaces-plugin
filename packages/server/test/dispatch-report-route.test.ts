/**
 * The builder's closing report through the running server.
 *
 * What this file pins is what the lead actually gets: one POST carries the PR
 * number, the head commit, the check results and a verdict on every done-when
 * line, and a GET reads all five back off the board rather than out of a chat
 * message. Beside that, the two costs the report is required NOT to have — an
 * incomplete one is refused naming the missing part, and a SECOND report on the
 * same build reaches no session at all, proved against a positive control on
 * the same stream.
 *
 * All fixtures are synthetic — invented names (Riverbend, Harborlight).
 * The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';

const PERSON = { id: 'known-riverbend', name: 'Riverbend', kind: 'person' };
const LEAD = { id: 'agent-harborlight', name: 'Harborlight', kind: 'agent' };
const BUILDER = { id: 'agent-saltmarsh', name: 'Saltmarsh', kind: 'agent' };

const COMMIT = '274ebd28002854a3c5ece616526f504e3169a12c';

interface KeptReport {
  taskId: string;
  prNumber: number;
  headCommit: string;
  checks: Array<{ name: string; status: string; detail?: string }>;
  doneWhen: Array<{ id: string; verdict: string; note: string }>;
  attempt: number;
  agentName?: string;
}

describe('a builder’s closing report', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let workspaceId: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  /** A row with two done-when lines, and the ids the report has to answer. */
  async function rowWithLines(title: string): Promise<{ taskId: string; lines: string[] }> {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/workspaces/${workspaceId}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the lead reads a record.`,
        assignee: BUILDER.name,
        assigneeKind: 'agent',
        author: LEAD,
        doneWhen: [{ text: 'the route answers' }, { text: 'a repeat is silent' }],
      }),
    );
    const detail = await jj<{ task: { doneWhen?: Array<{ id: string }> } }>(
      await fetch(`${base}/workspaces/${workspaceId}/tasks/${task.id}/detail`),
    );
    return { taskId: task.id, lines: (detail.task.doneWhen ?? []).map((l) => l.id) };
  }

  const fullReport = (lines: string[], over: Record<string, unknown> = {}) => ({
    prNumber: 1104,
    headCommit: COMMIT,
    checks: [
      { name: 'verify', status: 'pass', detail: '29 of 31 — 2 held' },
      { name: 'check:client-boot', status: 'held', detail: 'browser-gated off this machine' },
    ],
    doneWhen: lines.map((id, i) => ({
      id,
      verdict: 'met',
      note: `measured by case ${i + 1}`,
    })),
    agentName: 'saltmarsh-builder',
    author: BUILDER,
    ...over,
  });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'dispatch-report-route-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name: 'report board', author: LEAD, leadAgentId: LEAD.id }),
    );
    workspaceId = workspace.id;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('takes one report and reads all five parts back off the board', async () => {
    const { taskId, lines } = await rowWithLines('Wire the report route');
    const filed = await jj<{ ok: boolean; repeat: boolean; report: KeptReport }>(
      await post(`/workspaces/${workspaceId}/dispatches/${taskId}/report`, fullReport(lines)),
    );
    expect(filed.repeat).toBe(false);

    const read = await jj<{ taskId: string; reports: KeptReport[] }>(
      await fetch(`${base}/workspaces/${workspaceId}/dispatches/${taskId}/report`),
    );
    const kept = read.reports[0];
    expect(kept).toBeDefined();
    if (!kept) return;
    // The five the lead would otherwise have had to read out of prose.
    expect(kept.taskId).toBe(taskId);
    expect(kept.prNumber).toBe(1104);
    expect(kept.headCommit).toBe(COMMIT);
    expect(kept.checks.map((c) => `${c.name}:${c.status}`)).toEqual([
      'verify:pass',
      'check:client-boot:held',
    ]);
    expect(kept.doneWhen.map((v) => v.id).sort()).toEqual([...lines].sort());
    expect(kept.doneWhen.every((v) => v.verdict === 'met' && v.note.length > 0)).toBe(true);
  });

  it('survives a restart — the record is what the lead comes back to', async () => {
    const { taskId, lines } = await rowWithLines('Outlive the process');
    await jj(
      await post(`/workspaces/${workspaceId}/dispatches/${taskId}/report`, fullReport(lines)),
    );
    await handle.stop();
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const read = await jj<{ reports: KeptReport[] }>(
      await fetch(`${base}/workspaces/${workspaceId}/dispatches/${taskId}/report`),
    );
    expect(read.reports).toHaveLength(1);
    expect(read.reports[0]?.headCommit).toBe(COMMIT);
  });

  it('refuses a report missing a part, and the 400 names the part', async () => {
    const { taskId, lines } = await rowWithLines('Refuse a half report');
    const cases: Array<{
      what: string;
      over: Record<string, unknown>;
      error: string;
      says: string;
    }> = [
      {
        what: 'no PR',
        over: { prNumber: undefined },
        error: 'missing-pr-number',
        says: 'prNumber',
      },
      {
        what: 'no commit',
        over: { headCommit: undefined },
        error: 'missing-head-commit',
        says: 'headCommit',
      },
      { what: 'no checks', over: { checks: [] }, error: 'missing-checks', says: 'checks' },
      {
        what: 'a line left out',
        over: { doneWhen: [{ id: lines[0], verdict: 'met', note: 'only the first' }] },
        error: 'missing-done-when-line',
        says: lines[1] ?? '',
      },
    ];
    for (const c of cases) {
      const res = await post(
        `/workspaces/${workspaceId}/dispatches/${taskId}/report`,
        fullReport(lines, c.over),
      );
      expect(res.status, c.what).toBe(400);
      const body = (await res.json()) as { error?: string; message?: string };
      expect(body.error, c.what).toBe(c.error);
      expect(body.message ?? '', c.what).toContain(c.says);
    }
    // Nothing was kept: four refusals leave the board with no report at all.
    const read = await jj<{ reports: KeptReport[] }>(
      await fetch(`${base}/workspaces/${workspaceId}/dispatches/${taskId}/report`),
    );
    expect(read.reports).toHaveLength(0);
  });

  it('refuses a report on a row this board does not hold', async () => {
    // The middleware's membership check, inherited because the route lives
    // under the `dispatches` collection. 404, not 400: a foreign id and an
    // unknown one answer the same.
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name: 'other board', author: LEAD }),
    );
    const { taskId, lines } = await rowWithLines('Stay on my own board');
    const res = await post(
      `/workspaces/${workspace.id}/dispatches/${taskId}/report`,
      fullReport(lines),
    );
    expect(res.status).toBe(404);
  });

  it('wakes the board once — the repeat rides no stream', async () => {
    const { taskId, lines } = await rowWithLines('Ring the bell once');
    const res = await fetch(
      `${base}/workspaces/${workspaceId}/events:stream?agentId=${encodeURIComponent(LEAD.id)}`,
      { headers: { accept: 'text/event-stream' } },
    );
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          text += decoder.decode(value, { stream: true });
        }
      } catch {}
    })();
    // The FRAME's own event line, not any occurrence of the word: a frame
    // spells the name twice (`event: <name>` and again inside the data
    // object), so counting substrings would read one wake as two.
    const reported = (): number => text.split('event: dispatch.reported').length - 1;
    try {
      await jj(
        await post(`/workspaces/${workspaceId}/dispatches/${taskId}/report`, fullReport(lines)),
      );
      await waitFor(() => (reported() > 0 ? reported() : undefined), {
        describe: 'the first report on the workspace stream',
      });
      expect(reported()).toBe(1);

      // The same build, reported again — the case the whole guard exists for.
      const again = await jj<{ repeat: boolean; report: KeptReport }>(
        await post(`/workspaces/${workspaceId}/dispatches/${taskId}/report`, fullReport(lines)),
      );
      expect(again.repeat).toBe(true);
      expect(again.report.attempt).toBe(2);

      // The positive control, on the SAME stream and AFTER the repeat: if the
      // stream were simply dead, the count below would read 1 either way.
      await jj(
        await post(`/workspaces/${workspaceId}/tasks/${taskId}/transition`, {
          to: 'todo',
          author: PERSON,
          workspaceId,
        }),
      );
      await waitFor(() => text.includes('task.transitioned') || undefined, {
        describe: 'the stream carries an event it is supposed to',
      });
      expect(reported()).toBe(1);
    } finally {
      await reader.cancel().catch(() => {});
      await pump;
    }
  });

  it('a rework on a new commit is a new build, and does wake the board', async () => {
    // The other half of the repeat rule: silencing a re-send must not silence
    // a second build.
    const { taskId, lines } = await rowWithLines('Report the rework');
    await jj(
      await post(`/workspaces/${workspaceId}/dispatches/${taskId}/report`, fullReport(lines)),
    );
    const reworked = await jj<{ repeat: boolean }>(
      await post(
        `/workspaces/${workspaceId}/dispatches/${taskId}/report`,
        fullReport(lines, { headCommit: 'deadbee' }),
      ),
    );
    expect(reworked.repeat).toBe(false);
    const read = await jj<{ reports: KeptReport[] }>(
      await fetch(`${base}/workspaces/${workspaceId}/dispatches/${taskId}/report`),
    );
    expect(read.reports).toHaveLength(2);
    expect(read.reports.map((r) => r.attempt)).toEqual([1, 1]);
  });

  it('can be filed after the dispatch is closed', async () => {
    // A builder whose row the board already moved to done had its dispatch
    // closed by that very move. It still has to be able to report.
    const { taskId, lines } = await rowWithLines('Report after the lane closed');
    await jj(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/transition`, {
        to: 'todo',
        author: PERSON,
        workspaceId,
      }),
    );
    const filed = await jj<{ ok: boolean }>(
      await post(`/workspaces/${workspaceId}/dispatches/${taskId}/report`, fullReport(lines)),
    );
    expect(filed.ok).toBe(true);
  });
});
