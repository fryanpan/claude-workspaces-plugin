/**
 * The note hooks' two touches of `~/.claude/claude-workspaces`, when a walled
 * lead has been at that folder: the discovery read must not block on a FIFO
 * or follow a link, and the shape marker must not write through a link.
 *
 * Each case runs in a bun child under a throwaway HOME with a hard timeout,
 * so a regression to a blocking read fails here instead of hanging the run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const HOOK_MAIN = resolve(__dirname, '../hooks/lib/hook-main.ts');

function freshHome(): { home: string; slot: string } {
  const home = mkdtempSync(join(tmpdir(), 'cw-hook-hostile-'));
  const slot = join(home, '.claude', 'claude-workspaces');
  mkdirSync(slot, { recursive: true });
  return { home, slot };
}

function inChild(home: string, body: string): { timedOut: boolean; out: string } {
  const res = spawnSync(
    'bun',
    ['-e', `const m = await import(${JSON.stringify(HOOK_MAIN)}); ${body}`],
    { timeout: 5_000, encoding: 'utf8', env: { ...process.env, HOME: home } },
  );
  return { timedOut: res.signal !== null || res.error !== undefined, out: res.stdout.trim() };
}

describe('the note hooks in a discovery folder a lead can write', () => {
  test('a FIFO at server.json gives no port instead of blocking', () => {
    const { home, slot } = freshHome();
    try {
      expect(spawnSync('mkfifo', [join(slot, 'server.json')]).status).toBe(0);
      const res = inChild(home, 'console.log(String(m.discoveryPort()));');
      expect(res.timedOut).toBe(false);
      expect(res.out).toBe('undefined');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a link at server.json is not followed', () => {
    const { home, slot } = freshHome();
    try {
      const elsewhere = join(home, 'lead.json');
      writeFileSync(elsewhere, JSON.stringify({ port: 9999 }));
      symlinkSync(elsewhere, join(slot, 'server.json'));
      expect(inChild(home, 'console.log(String(m.discoveryPort()));').out).toBe('undefined');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a plain server.json still gives its port (control)', () => {
    const { home, slot } = freshHome();
    try {
      writeFileSync(join(slot, 'server.json'), JSON.stringify({ port: 8787, pid: 1 }));
      expect(inChild(home, 'console.log(String(m.discoveryPort()));').out).toBe('8787');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the shape marker does not create a file through a dangling link', () => {
    const { home, slot } = freshHome();
    try {
      const victim = join(home, 'victim.txt');
      symlinkSync(victim, join(slot, 'hook-shape-turn.seen'));
      inChild(home, "console.log(String(m.shapeSeen('turn')));");
      expect(existsSync(victim)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
