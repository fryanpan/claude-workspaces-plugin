#!/usr/bin/env bun
/**
 * Run the transcript store's uploader (`store-upload.ts`) on this machine.
 *
 *   bun infra/project-machine/store-uploader.ts           a pass now, then every 5 minutes
 *   bun infra/project-machine/store-uploader.ts --once    one pass, then exit
 *
 * SIGUSR1 starts the next pass early, so the Stop hook only has to signal.
 *
 * Configuration is environment only, so no credential is an argument `ps`
 * would show:
 *
 *   STORE_STATE_FILE              how far each file has been sent (mode 600)
 *   STORE_KEYS_FILE               public keys and board classes (below)
 *   STORE_HOST                    optional; this machine's path segment, else its hostname
 *   STORE_TRANSCRIPTS_DIR         optional; Claude Code's projects dir
 *   STORE_DATA_DIR                optional; a board server's data dir, for its event logs
 *   STORE_BOARD                   optional; a project machine's one board, which every file here is
 *   STORE_LEDGER                  optional; session -> board lines, where many boards share a machine
 *   STORE_INTERVAL_SECONDS        optional; 300 when unset
 *   STORE_S3_ENDPOINT, STORE_S3_BUCKET, STORE_S3_REGION (optional, "auto"),
 *   STORE_S3_ACCESS_KEY_ID, STORE_S3_SECRET_ACCESS_KEY
 *                                 a credential that may create objects and nothing else
 *
 * The keys file holds public keys only, and is refused if it holds an
 * identity: a machine that uploads must not be able to read the store.
 *
 *   { "review": "cwsnap-pub-…", "owner": "cwsnap-pub-…", "usage": "cwsnap-pub-…",
 *     "boards": { "<board>": "cwsnap-pub-…" },
 *     "classes": { "<board>": "ordinary" | "private" | "local-only" } }
 *
 * A board missing from `classes` counts as private.
 */
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { checkRecipient } from './snapshot.ts';
import {
  type BoardClass,
  type ObjectStore,
  type StoreKeys,
  type UploadSource,
  eventSources,
  ledgerResolver,
  runOnce,
  transcriptSources,
} from './store-upload.ts';

export interface UploaderConfig {
  statePath: string;
  host: string;
  keys: StoreKeys;
  classOf: (board: string) => BoardClass;
  sources: () => UploadSource[];
  intervalMs: number;
}

const CLASSES: readonly BoardClass[] = ['ordinary', 'private', 'local-only'];

/** Reads and checks the keys file's text. */
export function parseKeysFile(text: string): {
  keys: StoreKeys;
  classOf: (board: string) => BoardClass;
} {
  if (text.includes('cwsnap-key-')) {
    throw new Error('the keys file holds an identity; it must hold public keys only');
  }
  const raw = JSON.parse(text) as {
    review?: unknown;
    owner?: unknown;
    usage?: unknown;
    boards?: unknown;
    classes?: unknown;
  };
  const recipient = (v: unknown, what: string): string => {
    if (typeof v !== 'string') throw new Error(`keys file: ${what} is missing`);
    checkRecipient(v);
    return v;
  };
  const record = (v: unknown): Record<string, unknown> =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  const boards: Record<string, string> = {};
  for (const [id, key] of Object.entries(record(raw.boards))) {
    boards[id] = recipient(key, `boards.${id}`);
  }
  const classes = new Map<string, BoardClass>();
  for (const [id, cls] of Object.entries(record(raw.classes))) {
    if (!CLASSES.includes(cls as BoardClass))
      throw new Error(`keys file: classes.${id} is not a class`);
    classes.set(id, cls as BoardClass);
  }
  const keys: StoreKeys = {
    review: recipient(raw.review, 'review'),
    owner: recipient(raw.owner, 'owner'),
    boards,
    ...(raw.usage === undefined ? {} : { usage: recipient(raw.usage, 'usage') }),
  };
  return { keys, classOf: (board) => classes.get(board) ?? 'private' };
}

/** `hostname()` as one safe path segment. */
export function hostSegment(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/\.local$/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-]+|[-]+$/g, '');
  return s.slice(0, 63) || 'host';
}

export function configFromEnv(env: Record<string, string | undefined>): UploaderConfig {
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };
  const opt = (name: string): string | undefined => env[name]?.trim() || undefined;
  const { keys, classOf } = parseKeysFile(readFileSync(need('STORE_KEYS_FILE'), 'utf8'));
  const board = opt('STORE_BOARD');
  const ledger = opt('STORE_LEDGER');
  const transcripts = opt('STORE_TRANSCRIPTS_DIR');
  const dataDir = opt('STORE_DATA_DIR');
  const seconds = Number(opt('STORE_INTERVAL_SECONDS') ?? '300');
  if (!Number.isFinite(seconds) || seconds < 10)
    throw new Error('STORE_INTERVAL_SECONDS must be at least 10');
  return {
    statePath: need('STORE_STATE_FILE'),
    host: opt('STORE_HOST') ?? hostSegment(hostname()),
    keys,
    classOf,
    intervalMs: seconds * 1000,
    // Re-read every pass: new sessions appear, and the ledger grows.
    sources: () => {
      const boardOf =
        board !== undefined
          ? () => board
          : ledger !== undefined
            ? ledgerResolver(ledger)
            : () => null;
      return [
        ...(transcripts ? transcriptSources(transcripts, boardOf) : []),
        ...(dataDir ? eventSources(dataDir, board) : []),
      ];
    },
  };
}

function bucketFromEnv(env: Record<string, string | undefined>): ObjectStore {
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };
  const client = new Bun.S3Client({
    endpoint: need('STORE_S3_ENDPOINT'),
    bucket: need('STORE_S3_BUCKET'),
    region: env.STORE_S3_REGION?.trim() || 'auto',
    accessKeyId: need('STORE_S3_ACCESS_KEY_ID'),
    secretAccessKey: need('STORE_S3_SECRET_ACCESS_KEY'),
  });
  return {
    put: async (key, body) => {
      await client.write(key, body, { type: 'application/octet-stream' });
    },
  };
}

async function pass(config: UploaderConfig, store: ObjectStore): Promise<void> {
  const report = await runOnce({ ...config, sources: config.sources(), store });
  const bytes = report.uploaded.reduce((sum, u) => sum + u.bytes, 0);
  console.log(
    `[store] sent ${report.uploaded.length} objects (${bytes} bytes); held ${report.held.length} files`,
  );
}

async function main(): Promise<void> {
  const config = configFromEnv(process.env);
  const store = bucketFromEnv(process.env);
  if (process.argv.includes('--once')) {
    await pass(config, store);
    return;
  }
  let wake: (() => void) | null = null;
  process.on('SIGUSR1', () => wake?.());
  for (;;) {
    try {
      await pass(config, store);
    } catch (err) {
      // The S3 client's errors name the request, never the secret key. What
      // landed is saved; the next pass carries on from there.
      console.error(`[store] pass failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, config.intervalMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wake = null;
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`[store] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
