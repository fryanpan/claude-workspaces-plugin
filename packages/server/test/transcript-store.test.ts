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

/** A chunk's byte offset, from its name `<offset>-<random>.jsonl.zst.cw`. */
const offsetOf = (key: string): number => Number((key.split('/').at(-1) ?? '').split('-')[0]);

/**
 * Every chunk directly under `prefix`, opened with `identity` and joined in
 * offset order. Two chunks at one offset (a put whose answer was lost, sent
 * again) must hold the same bytes, and count once.
 */
function joined(store: MemoryStore, prefix: string, identity: string): string {
  const byOffset = new Map<number, string>();
  for (const k of store.keysUnder(prefix)) {
    if (k.slice(prefix.length).includes('/')) continue;
    expect(k).toMatch(/\/\d+-[0-9a-f]{16}\.jsonl\.zst\.cw$/);
    const body = store.objects.get(k);
    if (!body) throw new Error(`missing ${k}`);
    const text = openChunk(body, identity).toString('utf8');
    const seen = byOffset.get(offsetOf(k));
    if (seen !== undefined) expect(text).toBe(seen);
    byOffset.set(offsetOf(k), text);
  }
  let out = '';
  for (const [offset, text] of [...byOffset].sort((a, b) => a[0] - b[0])) {
    // Contiguous: each chunk starts where the last one ended.
    expect(offset).toBe(Buffer.byteLength(out));
    out += text;
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

describe('each file is sealed to its board’s key and the review key', () => {
  it('every board uploads, each to its own key as well as the review key; no board to the owner', async () => {
    const { projects, ledger, files } = threeBoards();
    const store = new MemoryStore();
    const sources = transcriptSources(projects, ledgerResolver(ledger));
    const state = join(fresh('state'), 'state.json');
    await runOnce({ sources, store, statePath: state, host: 'mac', keys, classOf });

    const river = 'mac/transcripts/riverbend/sess-river/';
    const salt = 'mac/transcripts/saltmarsh/sess-salt/';
    expect(joined(store, river, review.identity)).toBe(readFileSync(files.riverbend, 'utf8'));
    expect(joined(store, salt, saltmarsh.identity)).toBe(readFileSync(files.saltmarsh, 'utf8'));
    // The weekly review reads everything, client boards included.
    expect(joined(store, salt, review.identity)).toBe(readFileSync(files.saltmarsh, 'utf8'));
    // A subagent transcript goes with its session.
    expect(
      joined(store, 'mac/transcripts/riverbend/sess-river/subagents/agent-1/', review.identity),
    ).toBe(readFileSync(files.riverbendSub, 'utf8'));

    // An ordinary board's chunk is the review key's alone.
    const riverBody = store.objects.get(store.keysUnder(river)[0] ?? '') ?? new Uint8Array();
    expect(() => openChunk(riverBody, owner.identity)).toThrow(/did not decrypt/);
    // A client board's chunk does not open with another board's key.
    const saltBody = store.objects.get(store.keysUnder(salt)[0] ?? '') ?? new Uint8Array();
    expect(() => openChunk(saltBody, owner.identity)).toThrow(/did not decrypt/);

    // Local-only boards upload too (Bryan, 30 Oct: uniform treatment), like a
    // private board with no key of its own: the owner's and the review key.
    const harbor = 'mac/transcripts/harborlight/sess-harbor/';
    expect(joined(store, harbor, owner.identity)).toBe(readFileSync(files.harborlight, 'utf8'));
    expect(joined(store, harbor, review.identity)).toBe(readFileSync(files.harborlight, 'utf8'));

    // No board, and two boards, both land in unsorted under the owner's key and the review key.
    const loose = 'mac/transcripts/unsorted/sess-loose/';
    const both = 'mac/transcripts/unsorted/sess-both/';
    expect(joined(store, loose, owner.identity)).toBe(readFileSync(files.loose, 'utf8'));
    expect(joined(store, both, owner.identity)).toBe(readFileSync(files.twoBoards, 'utf8'));
    expect(joined(store, loose, review.identity)).toBe(readFileSync(files.loose, 'utf8'));
    const looseBody = store.objects.get(store.keysUnder(loose)[0] ?? '') ?? new Uint8Array();
    expect(() => openChunk(looseBody, saltmarsh.identity)).toThrow(/did not decrypt/);
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
    expect(() => openChunk(store.objects.get(k) ?? new Uint8Array(), review.identity)).toThrow(
      /did not decrypt/,
    );
  });

  it('a board whose class cannot be read is private: its own key, or the owner’s', async () => {
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
    const body = store.objects.get(store.keysUnder('mac/transcripts/riverbend/x/')[0] ?? '');
    if (!body) throw new Error('nothing uploaded');
    // No board key is configured for riverbend, so it falls back to the owner.
    expect(openChunk(body, owner.identity).toString()).toBe(line(1));
    expect(openChunk(body, review.identity).toString()).toBe(line(1));
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
      now: () => new Date('2026-10-29T12:00:00Z'),
    });
    // On a project machine every log is that machine's board, and each UTC
    // day of a log is a folder of its own.
    const rand = (k: string) => k.replace(/\/0-[0-9a-f]{16}\.jsonl\.zst\.cw$/, '/0-R');
    expect(store.keysUnder('fly/events/').map(rand).sort()).toEqual([
      'fly/events/saltmarsh/activity/2026-10-29/0-R',
      'fly/events/saltmarsh/harborlight.agent-notes/2026-10-29/0-R',
      'fly/events/saltmarsh/riverbend.events/2026-10-29/0-R',
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
    const now = () => new Date('2026-10-29T12:00:00Z');
    const opts = { sources, store, statePath, host: 'fly', keys, classOf, now, maxChunkBytes: 600 };
    store[failure] = 3;
    await expect(runOnce(opts)).rejects.toThrow();
    const landed = store.objects.size;
    expect(landed).toBe(failure === 'failBefore' ? 2 : 3);
    // The two puts that were answered are never sent again.
    const acknowledged = store.log.slice(0, 2).map(offsetOf);
    const firstRun = store.log.length;

    // The file grows while the uploader is down, half a line at the end.
    const more = line(40) + line(41);
    appendFileSync(path, more + line(42).slice(0, 10));
    expected += more;

    await runOnce(opts);
    const resent = store.log.slice(firstRun).filter((k) => acknowledged.includes(offsetOf(k)));
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

describe('a day’s manifest', () => {
  const at = (iso: string) => () => new Date(iso);

  it('names every chunk a file sent that day, closed by the first pass after midnight', async () => {
    const dir = fresh('manifest');
    const t = join(dir, 't.jsonl');
    const e = join(dir, 'e.jsonl');
    writeFileSync(t, line(1));
    writeFileSync(e, line(2));
    const sources: UploadSource[] = [
      { path: t, kind: 'transcript', name: 'sess-m', board: 'saltmarsh' },
      { path: e, kind: 'event', name: 'saltmarsh.events', board: 'saltmarsh' },
    ];
    const store = new MemoryStore();
    const base = { sources, store, statePath: join(dir, 'st.json'), host: 'mac', keys, classOf };
    await runOnce({ ...base, now: at('2026-10-29T23:58:00Z') });
    appendFileSync(t, line(3));
    await runOnce({ ...base, now: at('2026-10-29T23:59:00Z') });
    expect(store.keysUnder('mac/manifests/')).toEqual([]);

    // Bytes written just before midnight go up in the first pass after it,
    // and that pass closes the old day, so its manifest covers them.
    appendFileSync(t, line(4));
    await runOnce({ ...base, now: at('2026-10-30T00:00:30Z') });
    const mKey = 'mac/manifests/2026-10-29/transcripts/saltmarsh/sess-m.json.zst.cw';
    expect(store.keysUnder('mac/manifests/').sort()).toEqual([
      'mac/manifests/2026-10-29/events/saltmarsh/saltmarsh.events.json.zst.cw',
      mKey,
    ]);
    const body = store.objects.get(mKey) ?? new Uint8Array();
    // Bookkeeping, sealed to the review key.
    const m = JSON.parse(openChunk(body, review.identity).toString('utf8'));
    const chunks = store.keysUnder('mac/transcripts/saltmarsh/sess-m/');
    expect(m).toMatchObject({ version: 1, host: 'mac', day: '2026-10-29', gen: 0 });
    expect(m.chunks.map((c: { key: string }) => c.key).sort()).toEqual(chunks);
    const sizes = [line(1), line(3), line(4)].map((l) => Buffer.byteLength(l));
    expect(m.chunks.map((c: { offset: number; bytes: number }) => [c.offset, c.bytes])).toEqual([
      [0, sizes[0]],
      [sizes[0], sizes[1]],
      [(sizes[0] ?? 0) + (sizes[1] ?? 0), sizes[2]],
    ]);
    const plain = openChunk(
      store.objects.get(chunks[0] ?? '') ?? new Uint8Array(),
      review.identity,
    );
    const { createHash } = await import('node:crypto');
    expect(m.chunks[0].sha256).toBe(createHash('sha256').update(plain).digest('hex'));

    // The next pass starts the new day: its chunk is not in the closed manifest,
    // and an event chunk goes in the new day's folder.
    appendFileSync(e, line(5));
    await runOnce({ ...base, now: at('2026-10-30T00:01:30Z') });
    expect(store.keysUnder('mac/events/saltmarsh/saltmarsh.events/2026-10-30/')).toHaveLength(1);
    expect(store.keysUnder('mac/manifests/2026-10-30/')).toEqual([]);
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

  it('sealed to two keys, opens with either and with no third', () => {
    const plain = Buffer.alloc(150_000, 3);
    const sealed = sealBytes(plain, [saltmarsh.recipient, review.recipient]);
    expect(openBytes(sealed, saltmarsh.identity).equals(plain)).toBe(true);
    expect(openBytes(sealed, review.identity).equals(plain)).toBe(true);
    expect(() => openBytes(sealed, owner.identity)).toThrow(/did not decrypt/);
    sealed[sealed.length - 40] ^= 1;
    expect(() => openBytes(sealed, review.identity)).toThrow(/did not decrypt/);
  });

  it('the restore’s file decrypt opens a chunk sealed to two keys', () => {
    const dir = fresh('fmt2');
    const plain = Buffer.from(line(4) + line(5));
    writeFileSync(join(dir, 'c.cw'), sealBytes(plain, [owner.recipient, review.recipient]));
    decryptFile(join(dir, 'c.cw'), owner.identity, join(dir, 'out'));
    expect(readFileSync(join(dir, 'out')).equals(plain)).toBe(true);
  });

  it('is the snapshot format, so the restore’s file decrypt opens it', () => {
    const dir = fresh('fmt');
    const plain = Buffer.from(line(3));
    writeFileSync(join(dir, 'c.cw'), sealBytes(plain, review.recipient));
    decryptFile(join(dir, 'c.cw'), review.identity, join(dir, 'out'));
    expect(readFileSync(join(dir, 'out')).equals(plain)).toBe(true);
  });
});
