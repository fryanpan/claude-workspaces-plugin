/**
 * An org's own Claude sign-in, made during project setup with one browser
 * approval (re-review finding H2, approved by Bryan on 5 Nov: "Approve per
 * org").
 *
 * `claude setup-token` opens Bryan's browser, he approves, and it prints a
 * token that lasts a year. The deploy runs it once for an org whose machine
 * holds no token made for it, and hands the token straight to that org's Fly
 * app (`CLAUDE_CODE_OAUTH_TOKEN`, beside `CW_LEAD_TOKEN_ORG` naming the org).
 * It is never stored on the Mac: not the Keychain, not a file. So the only
 * copy outside Anthropic is the one on that org's machine, which gives it to
 * the lead's user and no other (`entrypoint.sh`), and each org's token can be
 * revoked alone at claude.ai/settings/claude-code.
 *
 * `claude setup-token` is a terminal UI, so it runs under `script(1)` for a
 * terminal of its own, wide enough that the token is never wrapped. What it
 * shows passes through to whoever runs the deploy with every `sk-ant-` run
 * replaced (`Redactor`), because an agent running the deploy keeps its
 * output in a transcript. When the deploy's stdin is not a terminal, the
 * approval's stdin is a pipe held open, so `script` never passes on an
 * end-of-file, which the UI would read as Ctrl-D.
 *
 * Unchecked against a real `claude setup-token` (the build hands every test a
 * stand-in): whether its UI runs under `script` with its output piped, and
 * whether the browser's answer reaches it with no code to paste. Both are
 * seen on the first real run, and a failure sets nothing.
 */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** Any Anthropic credential on the screen: hidden whole, whatever its kind. */
const ANY_KEY = /sk-ant-[A-Za-z0-9_-]*/g;
const KEY_START = 'sk-ant-';
/** The token `claude setup-token` prints. */
const SETUP_TOKEN = /sk-ant-oat\d*-[A-Za-z0-9_-]+/g;
const HIDDEN = '[token hidden]';
/** Long enough to read the page and approve; the run stops after it. */
const APPROVAL_LIMIT_MS = 10 * 60 * 1000;

/** Colour, cursor and title sequences, which a terminal UI wraps its text in. */
export function plainText(screen: string): string {
  return (
    screen
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are the input
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are the input
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are the input
      .replace(/\x1b[@-_]/g, '')
  );
}

/**
 * What a stream of screen output may show: every `sk-ant-` run replaced,
 * including one split across writes. A tail that could still become a token
 * is held until the next write settles it, or `end`.
 */
export class Redactor {
  private held = '';

  push(chunk: string): string {
    const s = this.held + chunk;
    // A token is complete once a character that cannot be in one follows it.
    const masked = s.replace(/sk-ant-[A-Za-z0-9_-]*(?=[^A-Za-z0-9_-])/g, HIDDEN);
    const cut = unsettledTail(masked);
    this.held = masked.slice(cut);
    return masked.slice(0, cut);
  }

  end(): string {
    const rest = this.held.replace(ANY_KEY, HIDDEN);
    this.held = '';
    return rest;
  }
}

/** Where the text stops being safe to show: a token still being written, or a start of one. */
function unsettledTail(s: string): number {
  const open = /sk-ant-[A-Za-z0-9_-]*$/.exec(s);
  if (open) return open.index;
  for (let k = Math.min(KEY_START.length - 1, s.length); k > 0; k--) {
    if (KEY_START.startsWith(s.slice(-k))) return s.length - k;
  }
  return s.length;
}

/**
 * The one token on the screen, or null. A redraw prints the same token again,
 * so repeats count once; two different tokens are refused rather than guessed
 * between.
 */
export function tokenIn(screen: string): string | null {
  const found = [...new Set(plainText(screen).match(SETUP_TOKEN) ?? [])];
  return found.length === 1 ? (found[0] ?? null) : null;
}

/**
 * Under `bun test`, the `claude` and `script` that would run must be a test's
 * stand-ins in a temp folder: a test that forgot them would otherwise open
 * Bryan's browser and make him a real token.
 */
export function testRefusal(): string | null {
  if (process.env.NODE_ENV !== 'test') return null;
  const temp = [tmpdir(), realpathSync(tmpdir())];
  for (const name of ['claude', 'script']) {
    const found = Bun.which(name, { PATH: process.env.PATH ?? '' });
    if (!found || !temp.some((t) => found.startsWith(t)))
      return `a test reached the real ${name}; put a stand-in for it on PATH`;
  }
  return null;
}

export interface ApprovalIo {
  /** Where the approval's screen is shown, already redacted. */
  show: (text: string) => void;
}

/**
 * Run `claude setup-token` for `project` and return the token it prints. The
 * errors name what went wrong, never any part of the output.
 */
export function approveOrgSignIn(project: string, io: ApprovalIo): Promise<string> {
  const refusal = testRefusal();
  if (refusal) return Promise.reject(new Error(refusal));
  const interactive = process.stdin.isTTY === true;
  const child = spawn(
    'script',
    ['-q', '/dev/null', 'sh', '-c', 'stty rows 50 cols 400 2>/dev/null; exec claude setup-token'],
    { stdio: [interactive ? 'inherit' : 'pipe', 'pipe', 'pipe'], env: process.env },
  );
  const out = new Redactor();
  const err = new Redactor();
  let screen = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (d: string) => {
    screen += d;
    io.show(out.push(d));
  });
  child.stderr?.on('data', (d: string) => io.show(err.push(d)));
  return new Promise((resolve, reject) => {
    const limit = setTimeout(() => child.kill('SIGTERM'), APPROVAL_LIMIT_MS);
    child.on('error', (e) => {
      clearTimeout(limit);
      reject(new Error(`could not run claude setup-token for ${project}: ${e.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(limit);
      io.show(out.end() + err.end());
      child.stdin?.end();
      const token = tokenIn(screen);
      screen = '';
      if (token) resolve(token);
      else
        reject(
          new Error(
            `claude setup-token printed no token for ${project} (${signal ? `stopped by ${signal}` : `exit ${code}`}); nothing was set`,
          ),
        );
    });
  });
}
