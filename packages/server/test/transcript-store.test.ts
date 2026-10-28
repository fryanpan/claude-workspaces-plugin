/**
 * The transcript store's uploader (`infra/project-machine/store-upload.ts`):
 * which key each file is sealed to, which files never leave the machine, and
 * that a run cut short resumes without sending a byte twice or skipping one.
 *
 * Every transcript here is synthetic JSONL in a temp dir, every key is
 * generated inside the test, and the bucket is an in-memory map.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decryptFile,
  generateSnapshotKeys,
  openBytes,
  sealBytes,
} from '../../../infra/project-machine/snapshot.ts';
import {
  type BoardClass,
  type ObjectStore,
  type StoreKeys,
  type UploadSource,
  eventSources,
  ledgerResolver,
  openChunk,
  runOnce,
  transcriptSources,
} from '../../../infra/project-machine/store-upload.ts';

const scratch = mkdtempSync(join(tmpdir(), 'cw-store-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
function fresh(name: string): string {
  const dir = join(scratch, `${name}-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  /** Every key put, in order, including repeats. */
  readonly log: string[] = [];
  puts = 0;
  /** Throw on this put (1-based), before it lands. */
  failBefore = 0;
  /** Throw on this put (1-based), after it lands: the answer was lost. */
  failAfter = 0;
  async put(key: string, body: Uint8Array): Promise<void> {
    this.puts++;
    this.log.push(key);
    if (this.puts === this.failBefore) throw new Error('connection reset');
    this.objects.set(key, body);
    if (this.puts === this.failAfter) throw new Error('timed out reading the answer');
  }
  keysUnder(prefix: string): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

const review = generateSnapshotKeys();
const owner = generateSnapshotKeys();
const usage = generateSnapshotKeys();
const saltmarsh = generateSnapshotKeys();

/** Riverbend is ordinary, Saltmarsh is a client board, Harborlight is local-only. */
const classes: Record<string, BoardClass> = {
  riverbend: 'ordinary',
  saltmarsh: 'private',
  harborlight: 'local-only',
};
const keys: StoreKeys = {
  review: review.recipient,
  owner: owner.recipient,
  usage: usage.recipient,
  boards: { saltmarsh: saltmarsh.recipient },
};
const classOf = (board: string): BoardClass => {
  const c = classes[board];
  if (!c) throw new Error(`no class for ${board}`);
  return c;
};

function line(i: number, text = `turn ${i} from Alice`): string {
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: `2026-10-28T10:00:${String(i % 60).padStart(2, '0')}Z`,
    message: { model: 'claude-test', usage: { input_tokens: i, output_tokens: 2 }, content: text },
  })}\n`;
}

/** Every chunk under `prefix`, opened with `identity` and joined in offset order. */
function joined(store: MemoryStore, prefix: string, identity: string): string {
  const byOffset = store
    .keysUnder(prefix)
    .filter((k) => !k.slice(prefix.length).includes('/'))
    .map((k) => ({ offset: Number(k.slice(prefix.length).split('.')[0]), k }))
    .sort((a, b) => a.offset - b.offset);
  let out = '';
  for (const { offset, k } of byOffset) {
    // Contiguous: each chunk starts where the last one ended.
    expect(offset).toBe(Buffer.byteLength(out));
    const body = store.objects.get(k);
    if (!body) throw new Error(`missing ${k}`);
    out += openChunk(body, identity).toString('utf8');
  }
  return out;
}

/** A projects dir with one session per board, plus one no ledger names. */
function threeBoards(): { projects: string; ledger: string; files: Record<string, string> } {
  const projects = fresh('projects');
  const slug = join(projects, '-repo-riverbend');
  mkdirSync(join(slug, 'sess-river', 'subagents'), { recursive: true });
  const files = {
    riverbend: join(slug, 'sess-river.jsonl'),
    riverbendSub: join(slug, 'sess-river', 'subagents', 'agent-1.jsonl'),
    saltmarsh: join(slug, 'sess-salt.jsonl'),
    harborlight: join(slug, 'sess-harbor.jsonl'),
    loose: join(slug, 'sess-loose.jsonl'),
    twoBoards: join(slug, 'sess-both.jsonl'),
  };
  writeFileSync(files.riverbend, line(1) + line(2));
  writeFileSync(files.riverbendSub, line(3, 'subagent work for Bob'));
  writeFileSync(files.saltmarsh, line(4, 'Saltmarsh client notes'));
  writeFileSync(files.harborlight, line(5, 'Harborlight stays home'));
  writeFileSync(files.loose, line(6));
  writeFileSync(files.twoBoards, line(7));
  const ledger = join(fresh('ledger'), 'sessions.jsonl');
  writeFileSync(
    ledger,
    [
      { session: 'sess-river', board: 'riverbend' },
      { session: 'sess-salt', board: 'saltmarsh' },
      { session: 'sess-harbor', board: 'harborlight' },
      { session: 'sess-both', board: 'riverbend' },
      { session: 'sess-both', board: 'saltmarsh' },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n'),
  );
  return { projects, ledger, files };
}

describe('each file is sealed to its board’s key', () => {
  it('ordinary and private upload under different keys, local-only never, no board to the owner', async () => {
    const { projects, ledger, files } = threeBoards();
    const store = new MemoryStore();
    const sources = transcriptSources(projects, ledgerResolver(ledger));
    const state = join(fresh('state'), 'state.json');
    await runOnce({ sources, store, statePath: state, host: 'mac', keys, classOf });

    const river = 'mac/transcripts/riverbend/sess-river/';
    const salt = 'mac/transcripts/saltmarsh/sess-salt/';
    expect(joined(store, river, review.identity)).toBe(readFileSync(files.riverbend, 'utf8'));
    expect(joined(store, salt, saltmarsh.identity)).toBe(readFileSync(files.saltmarsh, 'utf8'));
    // A subagent transcript goes with its session.
    expect(
      joined(store, 'mac/transcripts/riverbend/sess-river/subagents/agent-1/', review.identity),
    ).toBe(readFileSync(files.riverbendSub, 'utf8'));

    // Different keys: the private chunk does not open with the review key.
    const saltKey = store.keysUnder(salt)[0] ?? '';
    const saltBody = store.objects.get(saltKey) ?? new Uint8Array();
    expect(() => openChunk(saltBody, review.identity)).toThrow(/did not decrypt/);

    // Local-only: nothing anywhere names it or holds its words.
    const all = [...store.objects.keys()];
    expect(all.some((k) => k.includes('harborlight') || k.includes('sess-harbor'))).toBe(false);

    // No board, and two boards, both land in unsorted under the owner's key.
    const loose = 'mac/transcripts/unsorted/sess-loose/';
    const both = 'mac/transcripts/unsorted/sess-both/';
    expect(joined(store, loose, owner.identity)).toBe(readFileSync(files.loose, 'utf8'));
    expect(joined(store, both, owner.identity)).toBe(readFileSync(files.twoBoards, 'utf8'));
    expect(() =>
      openChunk(
        store.objects.get(store.keysUnder(loose)[0] ?? '') ?? new Uint8Array(),
        review.identity,
      ),
    ).toThrow(/did not decrypt/);
  });

  it('a usage side file holds model and token counts, no text, under the usage key', async () => {
    const { projects, ledger } = threeBoards();
    const store = new MemoryStore();
    await runOnce({
      sources: transcriptSources(projects, ledgerResolver(ledger)),
      store,
      statePath: join(fresh('state'), 'state.json'),
      host: 'mac',
      keys,
      classOf,
    });
    const k = store.keysUnder('mac/usage/saltmarsh/sess-salt/')[0] ?? '';
    const rows = openChunk(store.objects.get(k) ?? new Uint8Array(), usage.identity)
      .toString('utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows).toEqual([
      {
        ts: '2026-10-28T10:00:04Z',
        model: 'claude-test',
        usage: { input_tokens: 4, output_tokens: 2 },
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain('Saltmarsh client notes');
    expect(store.keysUnder('mac/usage/harborlight/')).toEqual([]);
  });

  it('a board whose class cannot be read is private: it never gets the review key', async () => {
    const dir = fresh('t');
    const path = join(dir, 'x.jsonl');
    writeFileSync(path, line(1));
    const store = new MemoryStore();
    const sources: UploadSource[] = [{ path, kind: 'transcript', name: 'x', board: 'riverbend' }];
    await runOnce({
      sources,
      store,
      statePath: join(dir, 'state.json'),
      host: 'mac',
      keys,
      classOf: () => {
        throw new Error('server down');
      },
    });
    const body = store.objects.get('mac/transcripts/riverbend/x/0.jsonl.zst.cw');
    if (!body) throw new Error('nothing uploaded');
    // No board key is configured for riverbend, so it falls back to the owner.
    expect(openChunk(body, owner.identity).toString()).toBe(line(1));
    expect(() => openChunk(body, review.identity)).toThrow(/did not decrypt/);
  });
});

describe('the writing host', () => {
  it('is the first segment of every key, so its credential is the prefix <host>/', async () => {
    const { projects, ledger } = threeBoards();
    const data = fresh('data');
    mkdirSync(join(data, 'workspaces'));
    writeFileSync(join(data, 'workspaces', 'riverbend.events.jsonl'), line(1));
    const store = new MemoryStore();
    await runOnce({
      sources: [...transcriptSources(projects, ledgerResolver(ledger)), ...eventSources(data)],
      store,
      statePath: join(fresh('state'), 'state.json'),
      host: 'mac',
      keys,
      classOf,
    });
    // Every kind is present, so the check below is not vacuous.
    const kinds = new Set(store.log.map((k) => k.split('/')[1]));
    expect([...kinds].sort()).toEqual(['events', 'transcripts', 'usage']);
    expect(store.log.filter((k) => !k.startsWith('mac/'))).toEqual([]);
  });
});

describe('event logs', () => {
  it('a per-board log goes under its board; a whole-server log only with a fixed board', async () => {
    const data = fresh('data');
    mkdirSync(join(data, 'workspaces'));
    writeFileSync(join(data, 'workspaces', 'riverbend.events.jsonl'), line(1));
    writeFileSync(join(data, 'workspaces', 'harborlight.agent-notes.jsonl'), line(2));
    writeFileSync(join(data, 'workspaces', 'riverbend.json'), '{}');
    writeFileSync(join(data, 'activity.jsonl'), line(3));

    const mac = eventSources(data);
    expect(mac.map((s) => [s.name, s.board]).sort()).toEqual([
      ['harborlight.agent-notes', 'harborlight'],
      ['riverbend.events', 'riverbend'],
    ]);

    const store = new MemoryStore();
    await runOnce({
      sources: eventSources(data, 'saltmarsh'),
      store,
      statePath: join(fresh('state'), 's.json'),
      host: 'fly',
      keys,
      classOf,
    });
    // On a project machine every log is that machine's board.
    expect(store.keysUnder('fly/events/').sort()).toEqual([
      'fly/events/saltmarsh/activity/0.jsonl.zst.cw',
      'fly/events/saltmarsh/harborlight.agent-notes/0.jsonl.zst.cw',
      'fly/events/saltmarsh/riverbend.events/0.jsonl.zst.cw',
    ]);
    expect(store.keysUnder('fly/usage/')).toEqual([]);
  });
});

describe('a run resumes where it stopped', () => {
  async function interrupted(failure: 'failBefore' | 'failAfter'): Promise<void> {
    const dir = fresh('resume');
    const path = join(dir, 's.jsonl');
    let expected = '';
    for (let i = 0; i < 40; i++) expected += line(i);
    writeFileSync(path, expected);
    const sources: UploadSource[] = [{ path, kind: 'transcript', name: 's', board: 'riverbend' }];
    const statePath = join(dir, 'state.json');
    const store = new MemoryStore();
    // Small chunks so one run makes several puts; the third one fails.
    const opts = { sources, store, statePath, host: 'fly', keys, classOf, maxChunkBytes: 600 };
    store[failure] = 3;
    await expect(runOnce(opts)).rejects.toThrow();
    const landed = store.objects.size;
    expect(landed).toBe(failure === 'failBefore' ? 2 : 3);
    // The two puts that were answered are never sent again.
    const acknowledged = store.log.slice(0, 2);
    const firstRun = store.log.length;

    // The file grows while the uploader is down, half a line at the end.
    const more = line(40) + line(41);
    appendFileSync(path, more + line(42).slice(0, 10));
    expected += more;

    await runOnce(opts);
    const resent = store.log.slice(firstRun).filter((k) => acknowledged.includes(k));
    expect(resent).toEqual([]);
    const prefix = 'fly/transcripts/riverbend/s/';
    expect(joined(store, prefix, review.identity)).toBe(expected);

    // A third run with nothing new sends nothing.
    const before = store.puts;
    await runOnce(opts);
    expect(store.puts).toBe(before);

    // The half line goes once it is finished, and only then.
    appendFileSync(path, line(42).slice(10));
    await runOnce(opts);
    expect(joined(store, prefix, review.identity)).toBe(expected + line(42));
  }

  it('when a put fails before it lands', async () => {
    await interrupted('failBefore');
  });

  it('when a put lands but its answer is lost', async () => {
    await interrupted('failAfter');
  });

  it('a file that shrank or changed is re-sent whole, marked rewrite', async () => {
    const dir = fresh('rewrite');
    const path = join(dir, 'r.jsonl');
    writeFileSync(path, line(1) + line(2));
    const sources: UploadSource[] = [{ path, kind: 'transcript', name: 'r', board: 'riverbend' }];
    const opts = {
      sources,
      store: new MemoryStore(),
      statePath: join(dir, 'st.json'),
      host: 'mac',
      keys,
      classOf,
    };
    await runOnce(opts);
    writeFileSync(path, line(9) + line(2) + line(3));
    await runOnce(opts);
    expect(joined(opts.store, 'mac/transcripts/riverbend/r/rewrite-1/', review.identity)).toBe(
      line(9) + line(2) + line(3),
    );
    expect(joined(opts.store, 'mac/transcripts/riverbend/r/', review.identity)).toBe(
      line(1) + line(2),
    );
  });
});

describe('the seal', () => {
  it('opens only with the identity it was sealed to', () => {
    const plain = Buffer.from(line(1) + line(2));
    const sealed = sealBytes(plain, review.recipient);
    expect(openBytes(sealed, review.identity).equals(plain)).toBe(true);
    expect(() => openBytes(sealed, owner.identity)).toThrow(/did not decrypt/);
    expect(() => openBytes(sealed, saltmarsh.identity)).toThrow(/did not decrypt/);
  });

  it('spans more than one 64 KiB chunk, and a flipped byte fails', () => {
    const plain = Buffer.alloc(200_000, 7);
    const sealed = sealBytes(plain, owner.recipient);
    expect(openBytes(sealed, owner.identity).equals(plain)).toBe(true);
    sealed[sealed.length - 40] ^= 1;
    expect(() => openBytes(sealed, owner.identity)).toThrow(/did not decrypt/);
  });

  it('is the snapshot format, so the restore’s file decrypt opens it', () => {
    const dir = fresh('fmt');
    const plain = Buffer.from(line(3));
    writeFileSync(join(dir, 'c.cw'), sealBytes(plain, review.recipient));
    decryptFile(join(dir, 'c.cw'), review.identity, join(dir, 'out'));
    expect(readFileSync(join(dir, 'out')).equals(plain)).toBe(true);
  });
});
