/**
 * The Claude Code sign-in a walled lead runs on. The profile refuses the
 * keychain (`keychainRules` in `lead-sandbox-lib.ts`), and Claude Code keeps
 * its sign-in there: measured 28 October 2026, 21:20 PT, `claude -p "say ok"`
 * inside a profile answered "OAuth token revoked", and answered "Ok." from the
 * same profile with only the keychain deny removed. So the launcher reads a
 * long-lived token from `claude setup-token` OUTSIDE the wall and hands it to
 * the lead as `CLAUDE_CODE_OAUTH_TOKEN`.
 *
 * The token is stored the way a board's secret card stores a value: BASE64,
 * account `claude-workspaces`, service `claude-workspaces-secret.<name>`.
 * The value goes into the child's environment and nowhere else: never a log
 * line, an error, the dry run or a file.
 */
import { spawnSync } from 'node:child_process';
import { SANDBOX_EXEC } from './lead-sandbox-lib.ts';

export const TOKEN_ACCOUNT = 'claude-workspaces';
export const TOKEN_SERVICE = 'claude-workspaces-secret.claude-lead-oauth-token';
export const TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

/** The stored value as the keychain returns it (BASE64), or null when there is none. */
export type TokenReader = () => string | null;

export const readKeychainToken: TokenReader = () => {
  const r = spawnSync(
    '/usr/bin/security',
    ['find-generic-password', '-a', TOKEN_ACCOUNT, '-s', TOKEN_SERVICE, '-w'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return r.status === 0 ? r.stdout : null;
};

/** BASE64 to the token, or null when the value is empty or not BASE64. */
export function decodeToken(stored: string | null): string | null {
  const b64 = stored?.trim() ?? '';
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const token = Buffer.from(b64, 'base64').toString('utf8').trim();
  return /^[\x21-\x7e]+$/.test(token) ? token : null;
}

export const MISSING_TOKEN = `there is no Claude Code token to sign the lead in with. The keychain item ${TOKEN_SERVICE} (account ${TOKEN_ACCOUNT}) is missing or not BASE64. Run \`claude setup-token\` outside the wall, then save the token it prints through a secret card named claude-lead-oauth-token. The wall refuses the keychain, so without it the lead cannot answer.`;

/**
 * What the lead's environment gains: the token. A lead with `allowKeychain`
 * can still sign in from the keychain, so for it the token is optional.
 */
export function tokenEnv(
  lead: { allowKeychain: boolean },
  read: TokenReader,
): { ok: true; env: Record<string, string> } | { ok: false; error: string } {
  const token = decodeToken(read());
  if (token) return { ok: true, env: { [TOKEN_ENV]: token } };
  return lead.allowKeychain ? { ok: true, env: {} } : { ok: false, error: MISSING_TOKEN };
}

export type Spawn = (
  file: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string | undefined> },
) => { status: number | null; stdout: string };

const spawnCaptured: Spawn = (file, args, opts) => {
  const r = spawnSync(file, args, { ...opts, encoding: 'utf8', timeout: 180_000 });
  return { status: r.status, stdout: r.stdout ?? '' };
};

/**
 * The turn row for one lead in `--check`: not run without `--turn`, a
 * failure when a walled lead has no token, else `turnRow`.
 */
export function turnCheck(
  lead: { allowKeychain: boolean },
  profile: string,
  cwd: string,
  opts: {
    turn: boolean;
    read: TokenReader;
    env: Record<string, string | undefined>;
    spawn?: Spawn;
  },
): { ran: false; says: string } | { ran: true; ok: boolean; says: string } {
  if (!opts.turn)
    return {
      ran: false,
      says: 'claude turn: not run (`--turn` runs it, and spends one model turn)',
    };
  const token = tokenEnv(lead, opts.read);
  if (!token.ok) return { ran: true, ok: false, says: `claude turn: ${token.error}` };
  return { ran: true, ...turnRow(profile, cwd, { ...opts.env, ...token.env }, opts.spawn) };
}

/**
 * `--check --turn`'s row: one `claude -p` turn from inside the profile must
 * answer. It spends a model turn, so it runs only when asked for.
 */
export function turnRow(
  profile: string,
  cwd: string,
  env: Record<string, string | undefined>,
  spawn: Spawn = spawnCaptured,
): { ok: boolean; says: string } {
  const r = spawn(SANDBOX_EXEC, ['-f', profile, 'claude', '-p', 'say ok'], { cwd, env });
  const token = env[TOKEN_ENV];
  let reply = (r.stdout.trim().split('\n')[0] ?? '').slice(0, 80);
  if (token) reply = reply.replaceAll(token, '<token>');
  const ok = r.status === 0 && reply !== '';
  return {
    ok,
    says: `claude turn: \`claude -p "say ok"\` ${ok ? 'answered' : `exited ${r.status}`}${reply ? `: ${reply}` : ''} (must answer)`,
  };
}
