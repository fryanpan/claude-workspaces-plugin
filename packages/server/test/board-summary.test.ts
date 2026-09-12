import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SUMMARY_MAX_CHARS,
  acceptBoardSummary,
  boardSummaryPrompt,
  createBoardSummaries,
} from '../src/board-summary.ts';
import type { BriefEventRow } from '../src/home-brief.ts';
import { ThreadSummarizer } from '../src/summarize.ts';

const HOUR = 60 * 60_000;
const NOW = 10 * HOUR;

const rows: BriefEventRow[] = [
  { event: 'task.transitioned', taskId: 't-1', to: 'in-progress', ts: NOW - 30 * 60_000 },
  { event: 'agent.heartbeat', ts: NOW - 60_000 },
  {
    event: 'task.noted',
    taskId: 't-1',
    text: 'Tide table renders from the buoy feed.',
    ts: NOW - 5 * 60_000,
  },
  { event: 'task.created', taskId: 't-2', ts: NOW - 3 * HOUR },
];
const titleOf = (id: string) => (id === 't-1' ? 'Tide table' : 'Old work');

function fakeApi(text: string, stopReason = 'end_turn') {
  const calls: Array<{ system: string; user: string }> = [];
  const impl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      system: string;
      messages: Array<{ content: string }>;
    };
    calls.push({ system: body.system, user: body.messages[0]?.content ?? '' });
    return new Response(JSON.stringify({ content: [{ text }], stop_reason: stopReason }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, summarizer: new ThreadSummarizer({ apiKey: 'test-key', fetchImpl: impl }) };
}

describe('boardSummaryPrompt', () => {
  it('reads only the last hour, without heartbeats, with task titles and notes', () => {
    const prompt = boardSummaryPrompt({ name: 'Saltmarsh', rows, titleOf, now: NOW }) ?? '';
    expect(prompt).toContain('"Tide table" → in-progress');
    expect(prompt).toContain('Tide table renders from the buoy feed.');
    expect(prompt).not.toContain('heartbeat');
    expect(prompt).not.toContain('Old work');
  });

  it('has nothing to say about a quiet hour', () => {
    expect(
      boardSummaryPrompt({ name: 'Saltmarsh', rows, titleOf, now: NOW + 5 * HOUR }),
    ).toBeNull();
  });
});

describe('acceptBoardSummary', () => {
  it('keeps a short sentence and refuses a long one rather than clipping it', () => {
    expect(acceptBoardSummary('  **Tide table** now reads the buoy feed. ')).toBe(
      'Tide table now reads the buoy feed.',
    );
    expect(acceptBoardSummary('x'.repeat(SUMMARY_MAX_CHARS + 1))).toBeNull();
    expect(acceptBoardSummary('')).toBeNull();
  });
});

describe('createBoardSummaries', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('refreshes at most once an hour and goes quiet after two', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'board-summary-'));
    dirs.push(dataDir);
    let clock = NOW;
    const api = fakeApi('Wiring the tide table to the buoy feed.');
    const summaries = createBoardSummaries({
      dataDir,
      summarizer: api.summarizer,
      titleOf,
      now: () => clock,
      readRows: () => rows,
    });
    const board = { id: 'w-salt', name: 'Saltmarsh' };

    await summaries.refresh(board);
    expect(summaries.read('w-salt')).toBe('Wiring the tide table to the buoy feed.');
    expect(api.calls).toHaveLength(1);

    clock += 30 * 60_000;
    await summaries.refresh(board);
    expect(api.calls).toHaveLength(1);

    // A restart keeps the sentence: it is read back from disk.
    const reread = createBoardSummaries({ dataDir, summarizer: null, titleOf, now: () => clock });
    expect(reread.read('w-salt')).toBe('Wiring the tide table to the buoy feed.');

    clock = NOW + 2 * HOUR;
    expect(summaries.read('w-salt')).toBeUndefined();
  });

  it('asks once for concurrent refreshes, and stores nothing from a cut reply', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'board-summary-'));
    dirs.push(dataDir);
    const api = fakeApi('Wiring the tide table', 'max_tokens');
    const summaries = createBoardSummaries({
      dataDir,
      summarizer: api.summarizer,
      titleOf,
      now: () => NOW,
      readRows: () => rows,
    });
    const board = { id: 'w-salt', name: 'Saltmarsh' };
    await Promise.all([summaries.refresh(board), summaries.refresh(board)]);
    expect(api.calls).toHaveLength(1);
    expect(summaries.read('w-salt')).toBeUndefined();
  });
});
