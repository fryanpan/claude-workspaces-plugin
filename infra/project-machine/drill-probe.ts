#!/usr/bin/env bun
/**
 * Runs ON the machine, over `fly ssh console`, for the restore drill.
 *
 *   bun drill-probe.ts seed          make a test board with two fixture docs, once
 *   bun drill-probe.ts fingerprint   print the docs' count and one hash over their text
 *
 * It talks to the board server on loopback only, the way the machine's own
 * health check does. `seed` refuses a data dir holding any board other than
 * its own, so it can never write into a real project's board.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprint } from './deploy-plan.ts';

const BASE = 'http://127.0.0.1:8787';
const HOST = 'localhost:8787';
const BOARD = 'Riverbend drill';
const DATA = process.env.CW_DATA_DIR ?? '/data/cw';
const FIXTURES = '/data/drill-fixtures';

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
  if (others.length > 0)
    throw new Error(`refusing to seed: this server holds ${others.length} other board(s)`);
  if (existing.length > 0) {
    console.log(JSON.stringify({ seeded: false, board: existing[0]?.id }));
    return;
  }
  mkdirSync(FIXTURES, { recursive: true });
  const ws = (await call('POST', '/workspaces', { name: BOARD })).workspace as { id: string };
  for (const d of DOCS) {
    const path = join(FIXTURES, d.file);
    writeFileSync(path, d.markdown, { mode: 0o644 });
    await call('POST', `/workspaces/${ws.id}/docs`, {
      type: 'markdown',
      sourceUrl: path,
      title: d.file,
    });
  }
  // The board is only worth backing up once both docs are on disk as .ydoc.
  for (let i = 0; i < 100 && ydocCount() < DOCS.length; i++) await Bun.sleep(100);
  console.log(JSON.stringify({ seeded: true, board: ws.id, ydocs: ydocCount() }));
}

async function print(): Promise<void> {
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
  console.log(JSON.stringify({ ...fingerprint(docs), ydocs: ydocCount() }));
}

const cmd = process.argv[2];
(cmd === 'seed'
  ? seed()
  : cmd === 'fingerprint'
    ? print()
    : Promise.reject(new Error('seed or fingerprint'))
).catch((err: unknown) => {
  console.error(`[drill-probe] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
