/**
 * Where the Mac keeps what CI handed it: a folder in prod's own folder, which
 * walled leads and other macOS users cannot open
 * (`~/Library/Application Support/claude-workspaces/handoff`, or
 * CW_HANDOFF_DIR). The folder is mode 700 and every file in it 600:
 *
 *   key                 the Mac's handoff private key (`keygen.ts`)
 *   seen.json           the workflow runs already pulled
 *   fly-tokens/<app>    {token, notAfter} for one Fly app (`mac-ops.ts`)
 *
 * The rest of what CI hands over goes where it went before: the Keychain.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The repository whose workflows hand off. */
export const HANDOFF_REPO = 'fryanpan/claude-workspaces-plugin';

const APP = /^cw-[a-z0-9][a-z0-9-]{0,62}$/;

export function handoffDir(env: Record<string, string | undefined> = process.env): string {
  const set = env.CW_HANDOFF_DIR?.trim();
  return set || join(homedir(), 'Library', 'Application Support', 'claude-workspaces', 'handoff');
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Write one file, mode 600, its folder 700. */
export function writePrivate(path: string, content: string): void {
  ensureDir(join(path, '..'));
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export interface AppToken {
  token: string;
  /** Seconds since the epoch. */
  notAfter: number;
}

function tokenPath(dir: string, app: string): string {
  if (!APP.test(app)) throw new Error(`${app} is not a project app`);
  return join(dir, 'fly-tokens', `${app}.json`);
}

/** The app's token, or null when there is none or it ends within an hour. */
export function readAppToken(dir: string, app: string, nowMs: number): string | null {
  const p = tokenPath(dir, app);
  if (!existsSync(p)) return null;
  try {
    const t = JSON.parse(readFileSync(p, 'utf8')) as AppToken;
    if (typeof t.token !== 'string' || !Number.isSafeInteger(t.notAfter)) return null;
    return t.notAfter * 1000 - nowMs > 3_600_000 ? t.token : null;
  } catch {
    return null;
  }
}

/** Keep the token that lasts longer; true when this one was stored. */
export function storeAppToken(dir: string, app: string, t: AppToken): boolean {
  const p = tokenPath(dir, app);
  if (existsSync(p)) {
    try {
      const old = JSON.parse(readFileSync(p, 'utf8')) as AppToken;
      if (Number.isSafeInteger(old.notAfter) && old.notAfter >= t.notAfter) return false;
    } catch {}
  }
  writePrivate(p, JSON.stringify({ token: t.token, notAfter: t.notAfter }));
  return true;
}

export function readSeen(dir: string): Set<string> {
  const p = join(dir, 'seen.json');
  if (!existsSync(p)) return new Set();
  try {
    const list = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    return new Set(Array.isArray(list) ? list.map(String) : []);
  } catch {
    return new Set();
  }
}

/** Keep the newest 500 run ids: older artifacts have expired anyway. */
export function writeSeen(dir: string, seen: Set<string>): void {
  writePrivate(join(dir, 'seen.json'), JSON.stringify([...seen].slice(-500)));
}

export function readPrivateKey(dir: string): string {
  const p = join(dir, 'key');
  if (!existsSync(p)) {
    throw new Error(`no handoff key at ${p}: run bun run handoff:keygen mac once`);
  }
  return readFileSync(p, 'utf8').trim();
}
