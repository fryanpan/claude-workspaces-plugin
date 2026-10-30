import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
/**
 * The discovery slot when somebody else can write its folder: a walled lead
 * can write most of `~/.claude`, so the file may be a FIFO or a link by the
 * time the server, a hook or an MCP child reads or replaces it.
 *
 * A FIFO read is run in a child process with a hard timeout, so a regression
 * fails this test instead of hanging the suite.
 */
import { describe, expect, test } from 'vitest';
import { publishDiscovery, readDiscovery } from '../src/discovery-file.ts';

const MODULE = resolve(__dirname, '../src/discovery-file.ts');

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'cw-discovery-hostile-'));
}

function slotDir(home: string): string {
  const dir = join(home, '.claude', 'claude-workspaces');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** `readDiscovery` in a bun child, killed after 5s. */
function readInChild(home: string): { timedOut: boolean; out: string } {
  const res = spawnSync(
    'bun',
    [
      '-e',
      `const m = await import(${JSON.stringify(MODULE)}); console.log(JSON.stringify(m.readDiscovery(${JSON.stringify(home)})));`,
    ],
    { timeout: 5_000, encoding: 'utf8' },
  );
  return { timedOut: res.signal !== null || res.error !== undefined, out: res.stdout.trim() };
}

describe('the discovery slot in a folder a lead can write', () => {
  test('a FIFO at server.json reads as no entry instead of blocking', () => {
    const home = freshHome();
    try {
      const made = spawnSync('mkfifo', [join(slotDir(home), 'server.json')]);
      expect(made.status).toBe(0);
      const res = readInChild(home);
      expect(res.timedOut).toBe(false);
      expect(res.out).toBe('null');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a link at server.json is not followed by the read', () => {
    const home = freshHome();
    try {
      const target = join(home, 'elsewhere.json');
      writeFileSync(target, JSON.stringify({ port: 9999, pid: 1 }));
      symlinkSync(target, join(slotDir(home), 'server.json'));
      expect(readDiscovery(home)).toBe(null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('publishing over a link replaces the link and leaves its target alone', () => {
    const home = freshHome();
    try {
      const victim = join(home, 'victim.txt');
      writeFileSync(victim, 'keep me\n');
      const slot = join(slotDir(home), 'server.json');
      symlinkSync(victim, slot);
      expect(publishDiscovery({ home, port: 8787, pid: 4242, isAlive: () => false })).toBe(
        'claimed',
      );
      expect(readFileSync(victim, 'utf8')).toBe('keep me\n');
      expect(lstatSync(slot).isSymbolicLink()).toBe(false);
      expect(readDiscovery(home)?.port).toBe(8787);
      // The temp file it wrote through is gone.
      expect(readdirSync(slotDir(home))).toEqual(['server.json']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('an oversized file reads as no entry', () => {
    const home = freshHome();
    try {
      writeFileSync(
        join(slotDir(home), 'server.json'),
        JSON.stringify({ port: 1, pid: 1, pad: 'x'.repeat(100_000) }),
      );
      expect(readDiscovery(home) === null).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
