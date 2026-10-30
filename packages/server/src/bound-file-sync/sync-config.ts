/**
 * The bound-file sync's config: one board on another server, and the `.md`
 * files on this machine its docs keep in step with. One file per board, off
 * until it says `"enabled": true`. `machine:move-board --sync-config` writes
 * one with `enabled: false`.
 *
 *   {"baseUrl": "https://<project>-workspaces.<zone>",
 *    "workspaceId": "w-…", "enabled": true,
 *    "auth": {"boardTokenService": "<Keychain service holding the at2>",
 *             "accessClientId": "<…>.access",
 *             "accessSecretService": "<Keychain service>"},
 *    "docs": [{"docId": "d-…", "path": "/abs/path/plan.md"}]}
 *
 * The file holds no secret: it names the Keychain services, read at start.
 * It is refused when group or others can write it, since it decides which
 * files on this machine the sync writes. A board not on loopback needs the
 * Access service token; every board needs its `at2`, the token that holds
 * the sync to that one board (`auth/board-agent-token.ts`).
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';

export interface SyncDoc {
  docId: string;
  path: string;
}

export interface SyncConfig {
  baseUrl: string;
  workspaceId: string;
  boardToken: string;
  access: { clientId: string; clientSecret: string } | null;
  docs: SyncDoc[];
}

export type SecretReader = (service: string) => string;

const BOARD_ID = /^w-[A-Za-z0-9_-]{6,64}$/;
const DOC_ID = /^(?!\.)[A-Za-z0-9:._-]{1,200}$/;
const SERVICE = /^[A-Za-z0-9._-]{1,128}$/;
const CLIENT_ID = /^[A-Za-z0-9._-]{1,256}\.access$/;
const AT2 = /^at2\.[A-Za-z0-9._-]{1,1024}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function origin(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('baseUrl must be a URL');
  const url = new URL(raw);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('baseUrl must be a bare origin');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new Error('baseUrl must be https unless it is on a loopback host');
  }
  return url.origin;
}

/** The config from its text, or why it is refused. `null` when it is off. */
export function parseSyncConfig(
  text: string,
  secret: SecretReader,
): SyncConfig | null | { error: string } {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw.enabled !== true) return null;
    const baseUrl = origin(raw.baseUrl);
    if (typeof raw.workspaceId !== 'string' || !BOARD_ID.test(raw.workspaceId)) {
      throw new Error('workspaceId is not a board id');
    }
    const auth = (raw.auth ?? {}) as Record<string, unknown>;
    if (typeof auth.boardTokenService !== 'string' || !SERVICE.test(auth.boardTokenService)) {
      throw new Error('auth.boardTokenService must name a Keychain service');
    }
    const boardToken = secret(auth.boardTokenService).trim();
    if (!AT2.test(boardToken)) throw new Error('the board token in the Keychain is not an at2');
    let access: SyncConfig['access'] = null;
    if (!baseUrl.startsWith('http://')) {
      if (typeof auth.accessClientId !== 'string' || !CLIENT_ID.test(auth.accessClientId)) {
        throw new Error('auth.accessClientId is not an Access client id');
      }
      if (typeof auth.accessSecretService !== 'string' || !SERVICE.test(auth.accessSecretService)) {
        throw new Error('auth.accessSecretService must name a Keychain service');
      }
      access = {
        clientId: auth.accessClientId,
        clientSecret: secret(auth.accessSecretService).trim(),
      };
    }
    if (!Array.isArray(raw.docs) || raw.docs.length === 0)
      throw new Error('docs must list at least one doc');
    const docs: SyncDoc[] = [];
    const paths = new Set<string>();
    for (const d of raw.docs as Record<string, unknown>[]) {
      if (
        typeof d?.docId !== 'string' ||
        !DOC_ID.test(d.docId) ||
        d.docId.startsWith('task:') ||
        d.docId.startsWith('ws:')
      ) {
        throw new Error(`not a doc id: ${String(d?.docId).slice(0, 80)}`);
      }
      const p = d.path;
      if (typeof p !== 'string' || !isAbsolute(p) || normalize(p) !== p || !p.endsWith('.md')) {
        throw new Error(`${d.docId}: path must be an absolute, normalized .md path`);
      }
      if (paths.has(p)) throw new Error(`${p} is named twice`);
      paths.add(p);
      docs.push({ docId: d.docId, path: p });
    }
    return { baseUrl, workspaceId: raw.workspaceId, boardToken, access, docs };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function loadSyncConfig(
  path: string,
  secret: SecretReader,
): SyncConfig | null | { error: string } {
  try {
    if ((statSync(path).mode & 0o022) !== 0) {
      return { error: `${path} is writable by group or others; chmod 600 it` };
    }
    return parseSyncConfig(readFileSync(path, 'utf8'), secret);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
