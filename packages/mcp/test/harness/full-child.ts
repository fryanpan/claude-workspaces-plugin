/**
 * How a test starts the full stdio MCP child.
 *
 * The plugin no longer ships the child's bundle (`packages/plugin/mcp/index.js`
 * — its last release is the git tag `mcp-full-child-rollback`). Its tool code
 * still runs: the server hosts it per session at `/mcp`, and the relay every
 * session now runs forwards to that. So the tests that drive a tool over the
 * MCP wire start the child from its source entry under bun, which runs
 * TypeScript directly. There is no build step to forget and no committed copy
 * to drift.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** `packages/mcp/src/mcp.ts`, the full child's stdio entry. */
export const MCP_SOURCE: string = resolve(import.meta.dirname, '../../src/mcp.ts');

/**
 * The bun binary that runs it: this process when the suite runs under bun,
 * otherwise the one on PATH (vitest runs under node; CI installs bun).
 */
export const BUN_BIN: string = process.versions.bun
  ? process.execPath
  : execFileSync('/bin/sh', ['-c', 'command -v bun'], { encoding: 'utf8' }).trim() || 'bun';
