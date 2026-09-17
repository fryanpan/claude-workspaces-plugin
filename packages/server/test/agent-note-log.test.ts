/**
 * The board's unplaced-note log, driven directly.
 *
 * `turn-note-many-rows.test.ts` proves the route uses it; this proves the
 * module keeps its own promises — append-only, torn-tail tolerant, bounded
 * from the tail, and never throwing at a caller that answered 202 before
 * durability was part of its contract.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentNoteLog, type LoggedAgentNote, agentNoteLogPath } from '../src/agent-note-log.ts';

const WS = 'ws-alpha';
const OTHER_WS = 'ws-beta';

describe('AgentNoteLog', () => {
  let dataDir: string;
  let log: AgentNoteLog;

  const note = (over: Partial<LoggedAgentNote> = {}): LoggedAgentNote => ({
    agent: 'Cartographer',
    kind: 'turn',
    text: 'Pushed the branch.',
    at: 1_757_000_000_000,
    workspaceId: WS,
    ambiguous: true,
    ...over,
  });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'agent-note-log-'));
    log = new AgentNoteLog(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('round-trips a note it has written', () => {
    expect(log.append(note())).toBe(true);
    expect(log.readFor(WS, 'Cartographer')).toEqual([note()]);
  });

  it('creates the workspaces directory rather than failing on a bare data dir', () => {
    // The route can be the first thing that ever writes to a fresh data
    // directory, so the log cannot assume the board's folder exists.
    expect(log.append(note())).toBe(true);
    expect(readFileSync(agentNoteLogPath(dataDir, WS), 'utf8')).toContain('Pushed the branch.');
  });

  it('appends: a second note never rewrites the first', () => {
    log.append(note({ at: 1, text: 'First' }));
    log.append(note({ at: 2, text: 'Second' }));
    const raw = readFileSync(agentNoteLogPath(dataDir, WS), 'utf8');
    expect(raw.trimEnd().split('\n')).toHaveLength(2);
    // Newest first on the way out, whatever order they went in.
    expect(log.readFor(WS, 'Cartographer').map((n) => n.text)).toEqual(['Second', 'First']);
  });

  it('keeps boards apart: another board is not this board', () => {
    log.append(note({ text: 'On Harborlight' }));
    log.append(note({ workspaceId: OTHER_WS, text: 'On Riverbend' }));
    expect(log.readFor(WS, 'Cartographer').map((n) => n.text)).toEqual(['On Harborlight']);
    expect(log.readFor(OTHER_WS, 'Cartographer').map((n) => n.text)).toEqual(['On Riverbend']);
  });

  it('folds the agent name the way the roster does', () => {
    log.append(note({ agent: 'Cartographer' }));
    expect(log.readFor(WS, 'cartographer')).toHaveLength(1);
    expect(log.readFor(WS, 'CARTOGRAPHER')).toHaveLength(1);
    expect(log.readFor(WS, 'Nomad')).toHaveLength(0);
  });

  it('skips a torn tail line and still reads the ones before it', () => {
    // A crash mid-append leaves a half-written last line. The whole point of
    // append-only JSONL is that it costs that line and nothing else.
    log.append(note({ at: 1, text: 'Whole' }));
    appendFileSync(agentNoteLogPath(dataDir, WS), '{"agent":"Cartographer","te');
    expect(log.readFor(WS, 'Cartographer').map((n) => n.text)).toEqual(['Whole']);
  });

  it('skips a line that parses but is not a note', () => {
    log.append(note({ at: 1, text: 'Whole' }));
    for (const junk of ['null', '[]', '"a string"', '{"agent":""}', '{"agent":"x","text":""}']) {
      appendFileSync(agentNoteLogPath(dataDir, WS), `${junk}\n`);
    }
    expect(log.readFor(WS, 'Cartographer').map((n) => n.text)).toEqual(['Whole']);
  });

  it('answers an empty list for a board that has never logged anything', () => {
    expect(log.readFor('ws-never', 'Cartographer')).toEqual([]);
    expect(log.lastTurnAt('ws-never', 'Cartographer')).toBeUndefined();
  });

  it('caps what one read hands back', () => {
    for (let i = 0; i < 30; i++) log.append(note({ at: 1000 + i, text: `note ${i}` }));
    expect(log.readFor(WS, 'Cartographer')).toHaveLength(20);
    expect(log.readFor(WS, 'Cartographer', 3).map((n) => n.text)).toEqual([
      'note 29',
      'note 28',
      'note 27',
    ]);
  });

  it('answers lastTurnAt with the latest TURN, ignoring other kinds and agents', () => {
    log.append(note({ at: 100, kind: 'turn' }));
    log.append(note({ at: 200, kind: 'status' }));
    log.append(note({ at: 300, kind: 'turn', agent: 'Nomad' }));
    log.append(note({ at: 150, kind: 'turn' }));
    expect(log.lastTurnAt(WS, 'Cartographer')).toBe(150);
    expect(log.lastTurnAt(WS, 'Nomad')).toBe(300);
    expect(log.lastTurnAt(OTHER_WS, 'Cartographer')).toBeUndefined();
  });

  it('answers false rather than throwing when the write cannot land', () => {
    // The route answers 202 whatever happens here. A read-only board folder
    // must cost the record and return the fact, not raise through the route.
    const dir = join(dataDir, 'workspaces');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    try {
      expect(log.append(note())).toBe(false);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('keeps the sessionId it was given and omits one it was not', () => {
    log.append(note({ at: 1, sessionId: 'sess-7' }));
    log.append(note({ at: 2 }));
    const [newest, oldest] = log.readFor(WS, 'Cartographer');
    expect(newest?.sessionId).toBeUndefined();
    expect(oldest?.sessionId).toBe('sess-7');
  });
});
