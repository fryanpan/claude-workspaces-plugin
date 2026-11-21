#!/usr/bin/env bun
/**
 * Send what a project machine's readers left in their spools
 * (`store-spool.ts`) to the transcript store, as `cwstore`, the one user that
 * holds the store's credential and reads nothing but the spools.
 *
 *   bun infra/project-machine/store-sender.ts --spool <dir>:<host>:<uid> [--spool …] [--once]
 *
 * Each `--spool` names a directory, the host segment its keys must start
 * with, and the uid that writes it. A pass every STORE_INTERVAL_SECONDS (60
 * unless set). The credential is environment only, so `ps` never shows it:
 * STORE_S3_ENDPOINT, STORE_S3_BUCKET, STORE_S3_ACCESS_KEY_ID and
 * STORE_S3_SECRET_ACCESS_KEY, one that may create objects under this
 * machine's hosts and do nothing else.
 */
import { s3Bucket } from './store-s3.ts';
import { type SpoolSource, sendSpool } from './store-spool.ts';

export function parseSpoolArgs(argv: readonly string[]): SpoolSource[] {
  const out: SpoolSource[] = [];
  argv.forEach((a, i) => {
    if (a !== '--spool') return;
    const m = /^(\/[^:]+):([^:]+):(\d+)$/.exec(argv[i + 1] ?? '');
    if (!m?.[1] || !m[2] || !m[3]) throw new Error('--spool takes <absolute dir>:<host>:<uid>');
    out.push({ dir: m[1], host: m[2], ownerUid: Number(m[3]) });
  });
  if (out.length === 0) throw new Error('name at least one --spool');
  return out;
}

async function main(): Promise<void> {
  const sources = parseSpoolArgs(process.argv.slice(2));
  const env = process.env;
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };
  const bucket = s3Bucket(
    {
      endpoint: need('STORE_S3_ENDPOINT'),
      accessKeyId: need('STORE_S3_ACCESS_KEY_ID'),
      secretAccessKey: need('STORE_S3_SECRET_ACCESS_KEY'),
    },
    need('STORE_S3_BUCKET'),
  );
  const seconds = Number(env.STORE_INTERVAL_SECONDS ?? '60');
  if (!Number.isFinite(seconds) || seconds < 10)
    throw new Error('STORE_INTERVAL_SECONDS must be at least 10');
  for (;;) {
    try {
      const r = await sendSpool(sources, bucket);
      console.log(
        `[store] sent ${r.sent} objects (${r.bytes} bytes); ${r.refused.length} spool files refused`,
      );
      for (const f of r.refused) console.error(`[store] refused ${f.name}: ${f.reason}`);
      // A file whose put failed is still in its spool for the next pass.
      for (const f of r.failed) console.error(`[store] send failed for ${f.host}: ${f.error}`);
    } catch (err) {
      // The client's errors name the call and status, never the credential.
      console.error(`[store] send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (process.argv.includes('--once')) return;
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`[store] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
