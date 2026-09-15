/**
 * Which agents the hosted connector was serving, handed from one server
 * process to the next.
 *
 * A restart empties every in-memory table, and the agents do not come back at
 * once: Claude Code redials its event stream on its own schedule, and until it
 * does nothing is subscribed on its behalf. Anything broadcast in that window
 * is gone — measured on the stdio connector, which has the same window. So the
 * stopping server writes down who it was serving, and the booting one
 * subscribes each of them before it answers its first request. The pushes of
 * that window then wait in each agent's outbox for its stream to return.
 *
 * WHAT IS IN THE FILE. For each agent: the header values it connected with —
 * the agent name, the working directory, the workspace id and the plugin
 * version. No token, key, session id or event. Names and paths are facts
 * about this machine, so the file is written mode 600, as every other file in
 * the data directory that names one is.
 *
 * Written atomically (temp file, then rename) so a crash mid-write leaves the
 * previous snapshot rather than half of one; a missing or unreadable file
 * means there is nobody to bring back, never a failed boot.
 */
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IdentityHeaders } from './identity.ts';

export const CONNECTOR_SNAPSHOT_FILE = 'connector-identities.json';

interface SnapshotFile {
  version: 1;
  savedAt: number;
  identities: IdentityHeaders[];
}

export function snapshotPath(dataDir: string): string {
  return join(dataDir, CONNECTOR_SNAPSHOT_FILE);
}

export function saveConnectorSnapshot(
  dataDir: string,
  identities: IdentityHeaders[],
  now: number = Date.now(),
): void {
  const path = snapshotPath(dataDir);
  const tmp = `${path}.tmp`;
  const body: SnapshotFile = { version: 1, savedAt: now, identities };
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  // `mode` only applies when the file is created; a stale temp file keeps its own.
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Only the string fields a snapshot may carry, so a hand-edited file cannot
 *  smuggle anything else into an identity. The values are re-validated as
 *  headers by the caller before use. */
function asHeaders(raw: unknown): IdentityHeaders | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.cwd !== 'string') return undefined;
  const out: IdentityHeaders = { cwd: r.cwd };
  for (const k of ['agent', 'agentLegacy', 'workspace', 'pluginVersion'] as const) {
    if (typeof r[k] === 'string') out[k] = r[k];
  }
  return out;
}

export function loadConnectorSnapshot(dataDir: string): IdentityHeaders[] {
  try {
    const parsed = JSON.parse(readFileSync(snapshotPath(dataDir), 'utf8')) as Partial<SnapshotFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.identities)) return [];
    return parsed.identities.map(asHeaders).filter((h): h is IdentityHeaders => h !== undefined);
  } catch {
    return [];
  }
}
