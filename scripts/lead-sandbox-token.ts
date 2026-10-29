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
 *
 * The owner has more than one Claude account. The config labels them
 * (`claudeAccounts`), and the token for label X is the item named
 * `TOKEN_SERVICE.X`. A lead signs in as the account `--claude-account` names,
 * else its own `claudeAccount`, else `defaultClaudeAccount`, else the
 * un-labelled `TOKEN_SERVICE`.
 */
import { spawnSync } from 'node:child_process';
import { SANDBOX_EXEC } from './lead-sandbox-lib.ts';

export const TOKEN_ACCOUNT = 'claude-workspaces';
export const TOKEN_SERVICE = 'claude-workspaces-secret.claude-lead-oauth-token';
export const TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

/** The item `service`'s value as the keychain returns it (BASE64), or null when there is none. */
export type TokenReader = (service: string) => string | null;

export const readKeychainToken: TokenReader = (service) => {
  const r = spawnSync(
    '/usr/bin/security',
    ['find-generic-password', '-a', TOKEN_ACCOUNT, '-s', service, '-w'],
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

/** The keychain item that holds `account`'s token; the un-labelled one for none. */
export function tokenService(account: string | undefined): string {
  return account ? `${TOKEN_SERVICE}.${account}` : TOKEN_SERVICE;
}

export function missingToken(account: string | undefined): string {
  const card = tokenService(account).slice('claude-workspaces-secret.'.length);
  return `there is no Claude Code token to sign the lead in with${account ? ` as account ${account}` : ''}. The keychain item ${tokenService(account)} (account ${TOKEN_ACCOUNT}) is missing or not BASE64. Run \`claude setup-token\` outside the wall${account ? `, signed in as ${account},` : ''} then save the token it prints through a secret card named ${card}. The wall refuses the keychain, so without it the lead cannot answer.`;
}

/**
 * The account a lead signs in as, or undefined for the un-labelled item.
 * `override` is `--claude-account`, which must be a listed label.
 */
export function resolveAccount(
  lead: { claudeAccount?: string },
  config: { claudeAccounts: string[]; defaultClaudeAccount?: string },
  override?: string,
): { ok: true; account: string | undefined } | { ok: false; error: string } {
  if (override !== undefined && !config.claudeAccounts.includes(override))
    return {
      ok: false,
      error: `--claude-account ${override} is not one of claudeAccounts (${config.claudeAccounts.join(', ') || 'none listed'}), so there is no item ${tokenService(override)} to read`,
    };
  return { ok: true, account: override ?? lead.claudeAccount ?? config.defaultClaudeAccount };
}

/**
 * What the lead's environment gains: the account's token. A lead with
 * `allowKeychain` and no account named can still sign in from the keychain,
 * so for it the token is optional. Naming an account asks for that account.
 */
export function tokenEnv(
  lead: { allowKeychain: boolean },
  account: string | undefined,
  read: TokenReader,
): { ok: true; env: Record<string, string> } | { ok: false; error: string } {
  const token = decodeToken(read(tokenService(account)));
  if (token) return { ok: true, env: { [TOKEN_ENV]: token } };
  return lead.allowKeychain && account === undefined
    ? { ok: true, env: {} }
    : { ok: false, error: missingToken(account) };
}

export type Spawn = (
  file: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string | undefined> },
) => { status: number | null; stdout: string; stderr?: string };

const spawnCaptured: Spawn = (file, args, opts) => {
  const r = spawnSync(file, args, { ...opts, encoding: 'utf8', timeout: 180_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
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
    account: string | undefined;
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
  const as = opts.account ? ` as ${opts.account}` : '';
  const token = tokenEnv(lead, opts.account, opts.read);
  if (!token.ok) return { ran: true, ok: false, says: `claude turn${as}: ${token.error}` };
  const row = turnRow(profile, cwd, { ...opts.env, ...token.env }, opts.spawn);
  return { ran: true, ok: row.ok, says: row.says.replace('claude turn:', `claude turn${as}:`) };
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
  const first = (text: string) => {
    const line = text.trim().split('\n')[0] ?? '';
    // Before the cut, so no part of the token survives it.
    return (token ? line.replaceAll(token, '<token>') : line).slice(0, 80);
  };
  const answer = first(r.stdout);
  const ok = r.status === 0 && answer !== '';
  // A refused sign-in may say why on stderr only.
  const reply = answer || first(r.stderr ?? '');
  return {
    ok,
    says: `claude turn: \`claude -p "say ok"\` ${ok ? 'answered' : `exited ${r.status}`}${reply ? `: ${reply}` : ''} (must answer)`,
  };
}
