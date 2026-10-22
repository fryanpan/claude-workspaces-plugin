#!/usr/bin/env bun
/**
 * Runs ON the machine, over `fly ssh console`, for the restore drill.
 *
 *   bun drill-probe.ts seed                   a test board with two fixture docs, a task,
 *                                             an agent note and a session transcript, once
 *   bun drill-probe.ts fingerprint [<limits>] count and hash the docs, the boards'
 *                                             events and agent notes, and the transcripts
 *
 * `<limits>` is the base64 JSON of an earlier fingerprint's `linesByFile`
 * per log, so the logs are compared on what the backup held (deploy-plan.ts,
 * `logFingerprint`).
 *
 * It talks to the board server on loopback only, the way the machine's own
 * health check does. `seed` refuses a data dir holding any board other than
 * its own, so it can never write into a real project's board.
 */
import {
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fingerprint, logFingerprint } from './deploy-plan.ts';

const BASE = 'http://127.0.0.1:8787';
const HOST = 'localhost:8787';
const BOARD = 'Riverbend drill';
const DATA = process.env.CW_DATA_DIR ?? '/data/cw';
const FIXTURES = '/data/drill-fixtures';
const TRANSCRIPTS = process.env.BACKUP_TRANSCRIPTS_DIR ?? '/data/claude-projects';
const AGENT = 'riverbend-drill-agent';
const SESSION = join('-data-riverbend-drill', '00000000-0000-4000-8000-000000000001.jsonl');
const TRANSCRIPT = [
  { type: 'user', message: { role: 'user', content: 'Summarise the Harborlight plan.' } },
  { type: 'assistant', message: { role: 'assistant', content: 'The ferry moves to spring.' } },
]
  .map((l) => JSON.stringify(l))
  .join('\n');

const DOCS = [
  {
    file: 'harborlight-plan.md',
    markdown: '# Harborlight plan\n\nThe ferry timetable moves to the spring schedule.\n',
  },
  {
    file: 'saltmarsh-notes.md',
    markdown: '# Saltmarsh notes\n\nSurvey results arrive on Thursday.\n',
  },
];

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { host: HOST, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

type Board = { id: string; name: string };

async function boards(): Promise<Board[]> {
  return ((await call('GET', '/workspaces')).boardWorkspaces ?? []) as Board[];
}

function ydocCount(): number {
  return readdirSync(DATA, { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith('.ydoc'))
    .length;
}

async function seed(): Promise<void> {
  const existing = await boards();
  const others = existing.filter((b) => b.name !== BOARD);
  if (others.length > 0) {
    throw new Error(`refusing to seed: this server holds ${others.length} other board(s)`);
  }
  const id =
    existing[0]?.id ?? ((await call('POST', '/workspaces', { name: BOARD })).workspace as Board).id;
  const ws = (await call('GET', `/workspaces/${id}?format=json`)).workspace as {
    docIds?: string[];
  };
  const have = ws.docIds?.length ?? 0;
  mkdirSync(FIXTURES, { recursive: true });
  // A board that already holds its docs is left as it is, so seeding twice adds nothing.
  if (have < DOCS.length) {
    for (const d of DOCS) {
      const path = join(FIXTURES, d.file);
      writeFileSync(path, d.markdown, { mode: 0o644 });
      await call('POST', `/workspaces/${id}/docs`, {
        docId: d.file.replace(/\.md$/, ''),
        type: 'markdown',
        sourceUrl: path,
        title: d.file,
      });
    }
  }
  const events = join(DATA, 'workspaces', `${id}.events.jsonl`);
  if (!existsSync(events)) {
    // A task is what writes the board's event log.
    await call('POST', `/workspaces/${id}/tasks`, {
      assignee: 'Alice',
      title: 'File the Saltmarsh survey',
    });
  }
  const notes = join(DATA, 'workspaces', `${id}.agent-notes.jsonl`);
  if (!existsSync(notes)) {
    // No row is claimed on this board, so the note goes to its unplaced-note log.
    await call('POST', `/workspaces/${id}/agents/${AGENT}/notes`, {
      kind: 'status',
      text: 'Riverbend drill: the Saltmarsh survey is filed.',
    });
  }
  const transcript = join(TRANSCRIPTS, SESSION);
  if (!existsSync(transcript)) {
    mkdirSync(join(TRANSCRIPTS, '-data-riverbend-drill'), { recursive: true });
    writeFileSync(transcript, `${TRANSCRIPT}\n`, { mode: 0o600 });
    // Written as root over ssh; the agent's own user owns its transcripts.
    chownSync(join(TRANSCRIPTS, '-data-riverbend-drill'), 10001, 10001);
    chownSync(transcript, 10001, 10001);
  }
  // Only worth backing up once both docs are on disk as .ydoc and both logs exist.
  const ready = () => ydocCount() >= DOCS.length && existsSync(events) && existsSync(notes);
  for (let i = 0; i < 100 && !ready(); i++) await Bun.sleep(100);
  if (!ready()) throw new Error('the docs, the event log or the agent-note log never reached disk');
  console.log(JSON.stringify({ seeded: have < DOCS.length, board: id, ydocs: ydocCount() }));
}

type Limits = Partial<Record<'events' | 'notes' | 'transcripts', Record<string, number>>>;

/** Every file under `root` whose name ends with `suffix`, keyed by its path inside `root`. */
function logs(root: string, suffix: string) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((p) => p.endsWith(suffix))
    .map((p) => ({ path: p, text: readFileSync(join(root, p), 'utf8') }));
}

async function print(limitsArg?: string): Promise<void> {
  const limits: Limits = limitsArg
    ? (JSON.parse(Buffer.from(limitsArg, 'base64').toString('utf8')) as Limits)
    : {};
  const docs = [];
  for (const b of await boards()) {
    const ws = (await call('GET', `/workspaces/${b.id}?format=json`)).workspace as {
      docIds?: string[];
    };
    for (const docId of ws.docIds ?? []) {
      const c = await call('GET', `/workspaces/${b.id}/docs/${docId}/content`);
      docs.push({ workspaceId: b.id, docId, text: String(c.plainText ?? '') });
    }
  }
  const boardLogs = join(DATA, 'workspaces');
  console.log(
    JSON.stringify({
      ...fingerprint(docs),
      ydocs: ydocCount(),
      events: logFingerprint(logs(boardLogs, '.events.jsonl'), limits.events),
      notes: logFingerprint(logs(boardLogs, '.agent-notes.jsonl'), limits.notes),
      transcripts: logFingerprint(logs(TRANSCRIPTS, '.jsonl'), limits.transcripts),
    }),
  );
}

const cmd = process.argv[2];
(cmd === 'seed'
  ? seed()
  : cmd === 'fingerprint'
    ? print(process.argv[3])
    : Promise.reject(new Error('seed or fingerprint'))
).catch((err: unknown) => {
  console.error(`[drill-probe] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
