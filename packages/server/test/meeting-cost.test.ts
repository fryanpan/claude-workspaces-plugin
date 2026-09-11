/**
 * WHAT A MEETING COSTS, END TO END: every Claude call a tick makes is
 * recorded with its tokens, the stop sums them, the summary line says the
 * dollars, and the rolling per-hour figure the chooser reads moves.
 *
 * THE BUG THIS FILE IS ABOUT. The capture pass called Haiku on every tick and
 * threw its `usage` block away, so a meeting's recorded cost was the compose
 * alone — the figure a person read was a fraction of the bill. Every case
 * here that asserts a capture number would have read zero before the fix, and
 * the mutation control at the bottom makes that explicit by putting the old
 * behaviour back.
 *
 * The API is a fake `fetch`: no key, no network, and the usage blocks are
 * chosen so the arithmetic is checkable by hand. All fixtures are synthetic.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { meetingSpendPhrase, meetingSummaryLine } from '../src/meeting-notes-doc.ts';
import type { TaskCaptureBoard, TaskCaptureInput } from '../src/meeting-task-capture.ts';
import { createHaikuTaskCaptureExtractor } from '../src/meeting-task-capture.ts';
import { readPerHourByMethod, recordMeetingCost } from '../src/notes-cost-store.ts';
import type { NotesCallUsage } from '../src/notes-timing.ts';
import {
  type MeetingCalendarRoutesContext,
  handleMeetingCalendarRoutes,
} from '../src/routes/meetings-calendar.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { addNotes, createNotesTickHarness } from './notes-tick-harness.ts';
import { seedBoard } from './workspace-seed.ts';

const dirs: string[] = [];
const dataDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'cw-meeting-cost-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Tokens the fake capture API reports on every call. */
const CAPTURE_USAGE = {
  input_tokens: 2_000,
  output_tokens: 40,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/** A board with nothing on it: the capture pass runs, finds no ask, and
 *  files nothing — which is the ordinary tick, and still a billed call. */
const emptyBoard: TaskCaptureBoard = {
  listTasks: () => [],
  createTask: () => ({ ok: false as const, error: 'not used' }),
  transition: () => ({ ok: true as const }),
};

/**
 * The real Haiku extractor over a fake HTTP seam, answering an empty item
 * list and a usage block. Driving the real extractor is the point: the thing
 * under test is that IT reads `usage` off the reply, not that a stub can be
 * told to.
 */
/** `null` means the reply carries no usage block at all, which is different
 *  from one carrying zeros — a sentinel rather than `undefined`, because a
 *  default parameter cannot tell "not passed" from "passed as absent" and an
 *  earlier draft of this file silently tested the default instead. */
function fakeCaptureExtractor(usage: unknown, calls?: { n: number }) {
  const extractor = createHaikuTaskCaptureExtractor({
    apiKey: 'test-key-not-a-real-one',
    fetchImpl: (async (_url: unknown, _init?: RequestInit) => {
      if (calls) calls.n++;
      return new Response(
        JSON.stringify({
          content: [{ text: '[]' }],
          ...(usage === null ? {} : { usage }),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch,
  });
  if (!extractor) throw new Error('extractor did not build');
  return extractor;
}

/** A harness whose ticks compose one bullet and capture through the fake. */
function meetingWith(
  opts: {
    usage?: unknown;
    calls?: { n: number };
    dataDir?: string;
    composeUsage?: { inputTokens: number; outputTokens: number };
  } = {},
) {
  return createNotesTickHarness({
    workspaceId: 'w-test',
    captureBoard: emptyBoard,
    taskExtractor: fakeCaptureExtractor('usage' in opts ? opts.usage : CAPTURE_USAGE, opts.calls),
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
    compose: (input, n) => {
      // The composer's own seam, the same one the real Haiku composer uses
      // to report what the API charged.
      input.measure?.({ model: 'claude-haiku-4-5-20251001' });
      input.measure?.({
        usage: {
          inputTokens: opts.composeUsage?.inputTokens ?? 10_000,
          outputTokens: opts.composeUsage?.outputTokens ?? 200,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      });
      return addNotes(input, `- point ${n}`);
    },
  });
}

const capturesIn = (calls: readonly NotesCallUsage[]): readonly NotesCallUsage[] =>
  calls.filter((c) => c.call === 'capture');

describe('every Claude call a tick makes is recorded', () => {
  it('a tick records both its capture call and its compose call', async () => {
    const h = meetingWith();
    await h.speak('We should look at the tunnel timeout again.');
    await h.end();
    const rows = h.timing().rows();
    const first = rows[0];
    expect(first).toBeDefined();
    expect(first?.calls.map((c) => c.call)).toContain('compose');
    // THE FIX: this is the entry that did not exist.
    expect(first?.calls.map((c) => c.call)).toContain('capture');
  });

  it('the capture row carries the model and the tokens the API reported', async () => {
    const h = meetingWith();
    await h.speak('Anything at all.');
    await h.end();
    const capture = capturesIn(h.timing().rows()[0]?.calls ?? [])[0];
    expect(capture?.model).toBe('claude-haiku-4-5-20251001');
    expect(capture?.usage).toEqual({
      inputTokens: CAPTURE_USAGE.input_tokens,
      outputTokens: CAPTURE_USAGE.output_tokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('records one capture per tick, so a long meeting is billed per tick', async () => {
    const calls = { n: 0 };
    const h = meetingWith({ calls });
    await h.speak('First thing.');
    await h.speak('Second thing.');
    await h.speak('Third thing.');
    await h.end();
    const captures = h
      .timing()
      .rows()
      .flatMap((r) => capturesIn(r.calls));
    expect(captures.length).toBe(calls.n);
    expect(captures.length).toBeGreaterThanOrEqual(3);
  });

  it('a reply with no usage block records no capture call rather than a zero one', async () => {
    const h = meetingWith({ usage: null });
    await h.speak('Anything at all.');
    await h.end();
    expect(capturesIn(h.timing().rows()[0]?.calls ?? [])).toHaveLength(0);
  });
});

describe('what the meeting adds up to', () => {
  it("the summary's spend is the sum of the calls, split compose and capture", async () => {
    const h = meetingWith();
    await h.speak('One.');
    await h.speak('Two.');
    await h.end();
    const summary = h.summary();
    expect(summary?.spend).toBeDefined();
    const spend = summary?.spend;
    expect(spend?.byCall.capture).toBeGreaterThan(0);
    expect(spend?.byCall.compose).toBeGreaterThan(0);
    expect(spend?.totalUsd).toBeCloseTo(
      (spend?.byCall.compose ?? 0) + (spend?.byCall.capture ?? 0),
      9,
    );
  });

  it('capture is a real share of the bill, not a rounding error', async () => {
    // 2,000 input tokens per capture against 10,000 + 200 output per compose:
    // capture is about a seventh of the meeting. A figure that omits it is
    // wrong by more than any reader would tolerate in a price.
    const h = meetingWith();
    await h.speak('One.');
    await h.end();
    const spend = h.summary()?.spend;
    const share = (spend?.byCall.capture ?? 0) / (spend?.totalUsd ?? 1);
    expect(share).toBeGreaterThan(0.05);
  });

  it('the summary states how long the meeting ran, which is the per-hour denominator', async () => {
    const h = meetingWith();
    await h.speak('One.');
    await h.end();
    expect(h.summary()?.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

describe('the line a person reads', () => {
  it('states the total, the split, and the rate', async () => {
    const h = meetingWith();
    await h.speak('One.');
    await h.end();
    const summary = h.summary();
    expect(summary).not.toBeNull();
    // An elapsed time the line can take a rate over, without asserting on the
    // wall clock: the phrase is built from the summary, so the summary is
    // what the test supplies.
    const line = meetingSummaryLine({ ...summary!, elapsedMs: 3_600_000 }, undefined);
    expect(line).toMatch(/\$\d+\.\d\d \(compose \$\d+\.\d\d, capture \$\d+\.\d\d\)/);
    expect(line).toMatch(/— \$\d+\.\d\d\/hr/);
  });

  it('says nothing about money when the meeting reached no model', async () => {
    // A meeting with no spend did not cost nothing; it reported nothing, and
    // printing `$0.00` would be a measurement it never made.
    const h = createNotesTickHarness({ compose: (input, n) => addNotes(input, `- p${n}`) });
    await h.speak('One.');
    await h.end();
    const summary = h.summary();
    expect(summary?.spend).toBeUndefined();
    expect(meetingSpendPhrase(summary!)).toBe('');
    expect(meetingSummaryLine(summary!, undefined)).not.toContain('compose $');
  });

  it('drops the rate but keeps the total when the meeting had no measurable length', async () => {
    const h = meetingWith();
    await h.speak('One.');
    await h.end();
    const phrase = meetingSpendPhrase({ ...h.summary()!, elapsedMs: 0 });
    expect(phrase).toContain('compose $');
    expect(phrase).not.toContain('/hr');
  });
});

describe('the chooser figure moves', () => {
  it('a finished meeting leaves a measured per-hour figure behind it', async () => {
    const dir = dataDir();
    expect(readPerHourByMethod(dir)).toEqual({});
    const h = meetingWith({ dataDir: dir });
    await h.speak('One.');
    await h.speak('Two.');
    await h.end();
    // The doc has never been switched, so it ran on the default note-taker.
    expect(readPerHourByMethod(dir).original).toBeGreaterThan(0);
  });
});

describe('MUTATION CONTROL: the pre-fix pipeline', () => {
  /**
   * The capture pass as it was: it reads the reply and never looks at
   * `usage`. Rebuilt here rather than described, so "the test would have
   * failed" is a thing this file demonstrates rather than a claim in a PR
   * body.
   */
  const blindExtractor = {
    name: 'haiku',
    async extract(_input: TaskCaptureInput): Promise<never[]> {
      return [];
    },
  };

  it('records no capture call, and the meeting under-reports its bill', async () => {
    const h = createNotesTickHarness({
      workspaceId: 'w-test',
      captureBoard: emptyBoard,
      taskExtractor: blindExtractor,
      compose: (input, n) => {
        input.measure?.({ model: 'claude-haiku-4-5-20251001' });
        input.measure?.({
          usage: {
            inputTokens: 10_000,
            outputTokens: 200,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        });
        return addNotes(input, `- point ${n}`);
      },
    });
    await h.speak('One.');
    await h.end();
    const rows = h.timing().rows();
    expect(capturesIn(rows[0]?.calls ?? [])).toHaveLength(0);
    // And the consequence: capture reads as free, which is the number that
    // was on the chooser row.
    expect(h.summary()?.spend?.byCall.capture).toBe(0);
    expect(meetingSummaryLine({ ...h.summary()!, elapsedMs: 3_600_000 }, undefined)).toContain(
      'capture $0.00',
    );
  });
});

/**
 * THE FIGURE'S TRIP TO THE CHOOSER. The rolling per-hour number rides the
 * read the chooser already makes at mount, so a doc's note-taker and what an
 * hour of it has cost arrive together and nothing new is exposed.
 */
describe('the read the chooser makes', () => {
  let handle: ServerHandle;
  let dir: string;
  let base: string;
  let ws = '';

  const call = (path: string): Promise<Response> =>
    fetch(`${base}${path}`, { headers: { host: `localhost:${handle.port}` } });

  beforeAll(async () => {
    // Its own directory, removed in afterAll: the per-test cleanup above
    // would take the running server's data dir out from under it.
    dir = mkdtempSync(join(tmpdir(), 'cw-meeting-cost-route-'));
    handle = createServer({ port: 0, dataDir: dir });
    base = `http://127.0.0.1:${handle.port}`;
    ws = await seedBoard(base);
    const path = join(dir, 'd-cost.md');
    writeFileSync(path, '# d-cost\n\nNotes go here.\n');
    const made = await fetch(`${base}/workspaces/${ws}/docs`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'd-cost', sourceUrl: path, title: 'd-cost' }),
    });
    expect(made.status, await made.clone().text()).toBe(200);
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('carries no figure while no meeting has been measured', async () => {
    const r = await call(`/workspaces/${ws}/docs/d-cost/notes-method`);
    expect(r.status, await r.clone().text()).toBe(200);
    expect(((await r.json()) as { perHour: unknown }).perHour).toEqual({});
  });

  it('carries the measured figure once a meeting has finished on that method', async () => {
    recordMeetingCost(dir, 'original', { at: 1, ms: 3_600_000, usd: 2.44, calls: 12 });
    const r = await call(`/workspaces/${ws}/docs/d-cost/notes-method`);
    const body = (await r.json()) as { method: string; perHour: Record<string, number> };
    // Both halves of what the row renders, from one call.
    expect(body.method).toBe('original');
    expect(body.perHour.original).toBeCloseTo(2.44, 6);
  });

  it('a share visitor is refused the read, so the figure widens nothing', async () => {
    // Driven at the handler, because the refusal is this handler's decision
    // and a whole share-link flow would be testing the share instead.
    const rest = 'docs/d-cost/notes-method';
    const r = await handleMeetingCalendarRoutes(
      {
        docStore: { get: () => undefined },
        dataDir: dir,
        j: (status: number, body: unknown) => Response.json(body, { status }),
        isValidDocId: () => true,
      } as unknown as MeetingCalendarRoutesContext,
      {
        scope: { workspaceId: 'w-1', rest, board: {} } as never,
        req: new Request(`http://localhost/workspaces/w-1/${rest}`),
        url: new URL(`http://localhost/workspaces/w-1/${rest}`),
        pathname: `/workspaces/w-1/${rest}`,
        visitor: {} as never,
      },
    );
    expect(r?.status).toBe(403);
    expect(await r?.json()).toEqual({ error: 'not available to share visitors' });
  });
});

describe('a model the price table has never heard of', () => {
  /** The same tick pipeline, composing on a model with no price. */
  const onUnknownModel = (dir: string) =>
    createNotesTickHarness({
      workspaceId: 'w-test',
      captureBoard: emptyBoard,
      dataDir: dir,
      taskExtractor: fakeCaptureExtractor(CAPTURE_USAGE),
      compose: (input, n) => {
        input.measure?.({ model: 'claude-imaginary-9' });
        input.measure?.({
          usage: {
            inputTokens: 10_000,
            outputTokens: 200,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        });
        return addNotes(input, `- point ${n}`);
      },
    });

  it('is named on the meeting rather than counted as free', async () => {
    const h = onUnknownModel(dataDir());
    await h.speak('One.');
    await h.end();
    expect(h.summary()?.spend?.unpricedModels).toEqual(['claude-imaginary-9']);
  });

  it('keeps that meeting out of the rolling figure entirely', async () => {
    // Its dollars are short by whatever the unpriced calls cost while its
    // full length still counts in the denominator, so filing it would pull
    // the chooser's figure down by an amount nothing names. A frozen figure
    // is a stale number a person can reason about; this would be a confident
    // wrong one.
    const dir = dataDir();
    recordMeetingCost(dir, 'original', { at: 1, ms: 3_600_000, usd: 2, calls: 10 });
    const before = readPerHourByMethod(dir).original;
    const h = onUnknownModel(dir);
    await h.speak('One.');
    await h.end();
    expect(readPerHourByMethod(dir).original).toBe(before as number);
  });

  it('MUTATION CONTROL: the same meeting on a priced model IS recorded', async () => {
    const dir = dataDir();
    recordMeetingCost(dir, 'original', { at: 1, ms: 3_600_000, usd: 2, calls: 10 });
    const before = readPerHourByMethod(dir).original ?? 0;
    const h = meetingWith({ dataDir: dir });
    await h.speak('One.');
    await h.end();
    expect(readPerHourByMethod(dir).original).not.toBe(before);
  });
});
