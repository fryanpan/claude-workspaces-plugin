#!/usr/bin/env bun
/**
 * Runs ON a project machine, over `fly ssh console`, for the daily wall
 * report (`wall-report.ts`).
 *
 *   bun wall-probe.ts mint             one value of each expiring signed type,
 *                                      signed with this server's key, as JSON
 *   bun wall-probe.ts verify <batch>   this server's verdict on another's batch
 *                                      (base64 JSON, as `mint` printed it)
 *   bun wall-probe.ts machine          what this machine's walls are set to
 *                                      (`machine-facts.ts`)
 *
 * The question is the one `cross-server-walls.test.ts` asks: does a server
 * accept a credential another server signed? Every signed type derives its
 * key from the server's `share-cookie.key` under its own domain
 * (`auth/signed-token.ts`), so a refusal here, for the signature, is the
 * key file differing.
 *
 * Every value minted here EXPIRED an hour before it was made, and names a
 * board, doc and person that do not exist, so none is a credential anywhere:
 * a route would refuse it on its expiry alone. Each is verified at a time
 * inside its window instead, which reaches the signature check and nothing
 * else. That is why only the four types that carry an expiry are minted;
 * `at1`, `at2`, `gp1`, `vk1` and the session cookie never expire, so a
 * minted one would be a live credential, and their keys come from the same
 * file.
 *
 * Reads the key file and never writes it: a missing key is an error, not a
 * reason to make one.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { appVoiceToken } from '../../packages/server/src/app-voice/token.ts';
import {
  type TokenFormat,
  mintToken,
  tokenKey,
  verifyToken,
} from '../../packages/server/src/auth/signed-token.ts';
import { boardWidgetToken } from '../../packages/server/src/auth/widget-token.ts';
import { frameCookie, frameTicket } from '../../packages/server/src/frame-ticket.ts';
import { type FactsIo, type Proc, readFacts } from './machine-facts.ts';

export const WALL_TYPES = ['wt2', 'ft1', 'fc1', 'app-voice'] as const;
export type WallType = (typeof WALL_TYPES)[number];

export interface Batch {
  /** The ms time inside every value's window, to verify at. */
  at: number;
  tokens: Record<WallType, string>;
}

/** `accepted`, or the reason the signing module refused. */
export type Answer = 'accepted' | string;

const BOARD = 'w-wallcheck';
const HOST = 'wall-check.invalid';

// biome-ignore lint/suspicious/noExplicitAny: one table over four claim shapes; each entry pairs its own format and claims
type AnyFormat = TokenFormat<any>;

function formats(expiresAt: number): Record<WallType, { format: AnyFormat; claims: unknown }> {
  const frame = { frameHost: HOST, workspaceId: BOARD, expiresAt, appVoice: false };
  return {
    wt2: {
      format: boardWidgetToken,
      claims: {
        identityId: 'wall-check',
        workspaceId: BOARD,
        origin: `https://${HOST}`,
        sessionId: null,
        issuedAt: expiresAt - 60_000,
        expiresAt,
      },
    },
    ft1: { format: frameTicket, claims: frame },
    fc1: { format: frameCookie, claims: frame },
    'app-voice': {
      format: appVoiceToken,
      claims: { workspaceId: BOARD, docId: 'wall-check', expiresAt },
    },
  };
}

/** One value of each type under `cookieKey`, expired an hour before `now`. */
export function mintExpired(cookieKey: string, now: number = Date.now()): Batch {
  const expiresAt = Math.floor((now - 3_600_000) / 1000) * 1000;
  const table = formats(expiresAt);
  const tokens = {} as Record<WallType, string>;
  for (const t of WALL_TYPES) {
    const { format, claims } = table[t];
    tokens[t] = mintToken(format, claims, tokenKey(cookieKey, format));
  }
  return { at: expiresAt - 1000, tokens };
}

/** This key's verdict on each value in `batch`, at the batch's own time. */
export function verifyBatch(cookieKey: string, batch: Batch): Record<WallType, Answer> {
  const table = formats(0);
  const out = {} as Record<WallType, Answer>;
  for (const t of WALL_TYPES) {
    const { format } = table[t];
    const r = verifyToken(format, batch.tokens[t], tokenKey(cookieKey, format), batch.at);
    out[t] = r.ok ? 'accepted' : r.reason;
  }
  return out;
}

/** The server's key, read only. */
export function readServerKey(dataDir: string): string {
  let key = '';
  try {
    key = readFileSync(join(dataDir, 'share-cookie.key'), 'utf8').trim();
  } catch {
    throw new Error(`no share-cookie.key in ${dataDir}`);
  }
  if (key.length < 32) throw new Error(`share-cookie.key in ${dataDir} is too short to be a key`);
  return key;
}

const readOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/** /proc, /etc/passwd and the volume, read as root. */
const realFactsIo: FactsIo = {
  procs: () =>
    readdirSync('/proc')
      .filter((d) => /^\d+$/.test(d))
      .map((pid): Proc | null => {
        const cmd = readOrNull(`/proc/${pid}/cmdline`);
        if (cmd === null) return null;
        return {
          cmdline: cmd.split('\0').filter(Boolean),
          environ: () =>
            Object.fromEntries(
              (readOrNull(`/proc/${pid}/environ`) ?? '')
                .split('\0')
                .filter((kv) => kv.includes('='))
                .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]),
            ),
        };
      })
      .filter((p): p is Proc => p !== null),
  read: readOrNull,
  dirs: (path) => {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(path, d.name));
    } catch {
      return [];
    }
  },
  publicKey: (path) => {
    if (!existsSync(path)) return null;
    const r = spawnSync('ssh-keygen', ['-y', '-f', path], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout : null;
  },
};

if (import.meta.main) {
  const dataDir = process.env.CW_DATA_DIR ?? '/data/cw';
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'machine') {
      console.log(JSON.stringify(readFacts(realFactsIo)));
      process.exit(0);
    }
    const key = readServerKey(dataDir);
    if (cmd === 'mint') console.log(JSON.stringify(mintExpired(key)));
    else if (cmd === 'verify' && arg)
      console.log(
        JSON.stringify(
          verifyBatch(key, JSON.parse(Buffer.from(arg, 'base64').toString('utf8')) as Batch),
        ),
      );
    else throw new Error('usage: wall-probe.ts mint | verify <base64 batch> | machine');
  } catch (err) {
    console.error(`[wall-probe] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
