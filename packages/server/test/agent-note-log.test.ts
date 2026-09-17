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
import {
  AgentNoteLog,
  type LoggedAgentNote,
  READ_BYTES_CAP,
  agentNoteLogPath,
} from '../src/agent-note-log.ts';

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
    // Written newest-`at` FIRST, so append order and `at` order DISAGREE.
    // With them agreeing this case passed on a read that merely reversed the
    // file, which is not what "newest" means to any of its callers: a
    // restart, a clock adjustment or a hook's own timestamp separates the
    // two, and those are the conditions this log exists for.
    log.append(note({ at: 2, text: 'Second' }));
    log.append(note({ at: 1, text: 'First' }));
    const raw = readFileSync(agentNoteLogPath(dataDir, WS), 'utf8');
    expect(raw.trimEnd().split('\n')).toHaveLength(2);
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
    // The 150 goes in BEFORE the 100, so "latest" cannot be read off the end
    // of the file — the greatest `at` and the last line are different notes.
    log.append(note({ at: 150, kind: 'turn' }));
    log.append(note({ at: 200, kind: 'status' }));
    log.append(note({ at: 300, kind: 'turn', agent: 'Nomad' }));
    log.append(note({ at: 100, kind: 'turn' }));
    expect(log.lastTurnAt(WS, 'Cartographer')).toBe(150);
    expect(log.lastTurnAt(WS, 'Nomad')).toBe(300);
    expect(log.lastTurnAt(OTHER_WS, 'Cartographer')).toBeUndefined();
  });

  describe('readBoard — every agent, for the board feed', () => {
    it('answers one board’s notes across agents, newest first', () => {
      log.append(note({ agent: 'Cartographer', at: 100, text: 'held two rows' }));
      log.append(note({ agent: 'Nomad', at: 300, text: 'held none' }));
      log.append(note({ agent: 'Cartographer', at: 200, text: 'still two' }));
      // Another board's line must not leak into this board's feed.
      log.append(note({ agent: 'Nomad', at: 400, workspaceId: OTHER_WS, text: 'other board' }));
      expect(log.readBoard(WS).map((n) => [n.agent, n.text])).toEqual([
        ['Nomad', 'held none'],
        ['Cartographer', 'still two'],
        ['Cartographer', 'held two rows'],
      ]);
      expect(log.readBoard(OTHER_WS).map((n) => n.text)).toEqual(['other board']);
    });

    it('is empty for a board that has never logged one', () => {
      expect(log.readBoard('ws-never')).toEqual([]);
    });

    it('caps what it hands back, keeping the newest', () => {
      for (let i = 0; i < 10; i++) log.append(note({ at: 1000 + i, text: `note ${i}` }));
      expect(log.readBoard(WS, 3).map((n) => n.text)).toEqual(['note 9', 'note 8', 'note 7']);
      expect(log.readBoard(WS, 0)).toEqual([]);
    });

    it('reads from the TAIL rather than parsing a long file', () => {
      // The board feed is the read that runs on a board that has been alive
      // for months, so it takes the same two bounds as `readFor`. Driven
      // through the parse cap seam, which is the one a fixture can reach.
      const impatient = new AgentNoteLog(dataDir, READ_BYTES_CAP, 4);
      for (let i = 0; i < 40; i++) impatient.append(note({ at: 1000 + i, text: `note ${i}` }));
      expect(impatient.readBoard(WS, 20).map((n) => n.text)).toEqual([
        'note 39',
        'note 38',
        'note 37',
        'note 36',
      ]);
    });

    it('drops a torn line rather than the whole read', () => {
      log.append(note({ at: 100, text: 'good one' }));
      appendFileSync(agentNoteLogPath(dataDir, WS), '{"agent":"Cartographer","te');
      appendFileSync(agentNoteLogPath(dataDir, WS), '\n');
      log.append(note({ at: 200, text: 'good two' }));
      expect(log.readBoard(WS).map((n) => n.text)).toEqual(['good two', 'good one']);
    });
  });

  describe('when one agent’s notes sit behind hundreds of another’s', () => {
    // The board this file was written for is a BUSY board — that is what
    // holding many rows means. Reading the file's last N lines and filtering
    // after would answer nothing for the quiet agent, because the cut happens
    // before anyone asks whose notes these are. The cut has to be per agent.
    const BUSY = 600;

    const twoAgents = (instance: AgentNoteLog) => {
      for (let i = 0; i < 5; i++) {
        instance.append(note({ agent: 'Nomad', at: 100 + i, text: `quiet ${i}` }));
      }
      for (let i = 0; i < BUSY; i++) {
        instance.append(note({ agent: 'Cartographer', at: 1000 + i, text: `busy ${i}` }));
      }
    };

    it('still finds the quiet agent, and still answers the busy one from the tail', () => {
      twoAgents(log);
      expect(log.readFor(WS, 'Nomad').map((n) => n.text)).toEqual([
        'quiet 4',
        'quiet 3',
        'quiet 2',
        'quiet 1',
        'quiet 0',
      ]);
      expect(log.lastTurnAt(WS, 'Nomad')).toBe(104);
      expect(log.readFor(WS, 'Cartographer', 1).map((n) => n.text)).toEqual([`busy ${BUSY - 1}`]);
    });

    it('gives up rather than parsing the whole file when the walk runs long', () => {
      // The reach is per agent; the WORK is still bounded, or a four-megabyte
      // file would be twenty thousand parses on a route that answers a hook.
      // Driven with a small parse cap rather than a five-thousand-line
      // fixture — the same seam the byte cap uses.
      const impatient = new AgentNoteLog(dataDir, READ_BYTES_CAP, 10);
      twoAgents(impatient);
      expect(impatient.readFor(WS, 'Nomad')).toEqual([]);
      expect(impatient.lastTurnAt(WS, 'Nomad')).toBeUndefined();
      // And it gave up looking rather than returning nothing at all: the
      // agent whose notes are inside the budget is answered normally.
      expect(impatient.readFor(WS, 'Cartographer', 1).map((n) => n.text)).toEqual([
        `busy ${BUSY - 1}`,
      ]);
    });
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

  describe('when the file is past the byte cap and the read has to seek', () => {
    // The branch that cannot be reasoned about by reading it: a seek lands
    // mid-line and mid-character, and the buffer is longer than the read.
    // Driven with a small cap rather than a four-megabyte fixture.
    const smallCap = 400;

    it('still returns the newest note, not a line padded with the buffer’s zeros', () => {
      const seeking = new AgentNoteLog(dataDir, smallCap);
      for (let i = 0; i < 40; i++) seeking.append(note({ at: 1000 + i, text: `note ${i}` }));
      expect(seeking.readFor(WS, 'Cartographer', 1).map((n) => n.text)).toEqual(['note 39']);
      expect(seeking.lastTurnAt(WS, 'Cartographer')).toBe(1039);
    });

    it('drops only the line the seek cut, not the ones after it', () => {
      const seeking = new AgentNoteLog(dataDir, smallCap);
      for (let i = 0; i < 40; i++) seeking.append(note({ at: 1000 + i, text: `note ${i}` }));
      const got = seeking.readFor(WS, 'Cartographer', 100);
      // Fewer than all forty (the cap cut the file), but every one it did
      // return parsed — a partial line would have thrown or come back junk.
      expect(got.length).toBeGreaterThan(0);
      expect(got.length).toBeLessThan(40);
      expect(got.every((n) => n.text.startsWith('note '))).toBe(true);
      // Contiguous from the newest backwards: nothing in the middle was lost.
      expect(got.map((n) => n.at)).toEqual(got.map((_, i) => 1039 - i));
    });

    it('does not mangle a multi-byte character in a line it keeps whole', () => {
      const seeking = new AgentNoteLog(dataDir, smallCap);
      for (let i = 0; i < 40; i++) seeking.append(note({ at: 1000 + i, text: `café ${i} ✅` }));
      expect(seeking.readFor(WS, 'Cartographer', 1).map((n) => n.text)).toEqual(['café 39 ✅']);
    });
  });

  it('keeps the sessionId it was given and omits one it was not', () => {
    log.append(note({ at: 1, sessionId: 'sess-7' }));
    log.append(note({ at: 2 }));
    const [newest, oldest] = log.readFor(WS, 'Cartographer');
    expect(newest?.sessionId).toBeUndefined();
    expect(oldest?.sessionId).toBe('sess-7');
  });
});
