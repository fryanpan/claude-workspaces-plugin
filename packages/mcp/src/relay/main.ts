#!/usr/bin/env node
/**
 * The node relay's process: stdin lines in, stdout lines out, and nothing
 * else loaded. See relay-core.ts for what it does, and
 * packages/plugin/bin/claude-workspaces-mcp.sh for when it runs instead of
 * the compiled relay.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { serverFetch } from '../access-headers.ts';
import { createRelay } from './relay-core.ts';
import { unixSocketFetch } from './unix-fetch.ts';

// A walled lead's relay reaches its board only over that board's socket.
const boardSocket = process.env.CW_BOARD_SOCKET?.trim() || undefined;

const relay = createRelay({
  env: process.env,
  cwd: process.cwd(),
  homedir,
  existsSync,
  readFileSync,
  // A board socket is on this machine and never behind Access.
  fetch: boardSocket
    ? unixSocketFetch(boardSocket)
    : serverFetch(
        process.env,
        (url, init) => fetch(url, init),
        (line) => console.error(`[relay] ${line}`),
      ),
  ...(boardSocket ? { boardSocket } : {}),
  write: (line) => {
    process.stdout.write(`${line}\n`);
  },
  log: (...args) => console.error(...args),
  ...(process.env.CW_RELAY_INIT_WAIT_MS !== undefined
    ? { initWaitMs: Number(process.env.CW_RELAY_INIT_WAIT_MS) || 0 }
    : {}),
});

console.error(`[relay] node relay started${boardSocket ? ' on a board socket' : ''}`);
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  let nl = buf.indexOf('\n');
  while (nl >= 0) {
    relay.receive(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\n');
  }
});
process.stdin.on('end', () => {
  if (buf.trim() !== '') relay.receive(buf);
  void relay.close().finally(() => process.exit(0));
});
