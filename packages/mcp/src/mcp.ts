#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolveAgentAuthor } from './author.ts';
import { CONNECTOR_INSTRUCTIONS } from './connector-instructions.ts';
import { createConnectorSession } from './connector-session.ts';
import { resolveBaseUrl as baseUrlFrom } from './http-client.ts';

/**
 * Thin MCP server that proxies tool calls to a running feedback server
 * over HTTP. Agents launch this binary via stdio; it calls the main
 * server's REST API so state is authoritative there.
 *
 * Base URL resolution (first hit wins):
 *   1. $CW_BASE_URL — explicit override
 *   2. ~/.claude/claude-workspaces/server.json — written by scripts/serve.ts
 *      on startup so the MCP auto-finds whichever port the server landed on.
 *      Deliberately NOT renamed with the plugin: the writer and this reader
 *      ship in different artifacts and restart independently, so moving it
 *      needs a dual-write transition rather than a rename.
 *   3. http://localhost:8787 — last-resort default
 *
 * env:
 *   CW_BASE_URL    — optional override; usually discovery handles it
 *   CW_AGENT_NAME  — this agent's display name, as a person would say it;
 *                          wins over CW_AUTHOR, which the plugin's
 *                          .mcp.json pins to `agent` for every peer
 *   CW_AUTHOR      — fallback author key/name (default: agent)
 *   CW_WORKSPACE_ID — the board a bare post_status (no taskId) lands on;
 *                          the same setting the Stop hook reads
 */

/** Resolved per request, not frozen at module load — see http-client.ts. */
const resolveBaseUrl = () => baseUrlFrom({ env: process.env, homedir, existsSync, readFileSync });

const AUTHOR = resolveAgentAuthor(process.env);
/**
 * Must match packages/plugin/.claude-plugin/plugin.json — this is the version
 * a client sees in the initialize handshake, and it had drifted three minor
 * releases behind. Asserted against the manifest, through the real bundle, in
 * packages/mcp/test/launcher.test.ts.
 *
 * One constant rather than a literal per use: the same value is reported to
 * the board on attach, so the board can say which sessions are running an older
 * bundle than the deploy source would install. A second literal would be a
 * fourth version site, and this file's history is that version sites drift.
 */
const PLUGIN_VERSION = '0.1.258';

/**
 * One nonce per PROCESS, minted at module load and sent on every attach.
 * The server compares it against the attachment's recorded nonce to answer
 * the question the ack grace window turns on: is this attach a fresh process
 * (bypass the grace — whatever was in flight went to a process that is gone)
 * or the same live one re-attaching (respect it — a frame already on the
 * wire to THIS process must not be handed over a second time through the
 * attach response). See AgentAttachment.processId on the server side.
 */
const PROCESS_ID = randomUUID();

const server = new Server(
  {
    name: 'claude-workspaces',
    version: PLUGIN_VERSION,
  },
  {
    capabilities: {
      tools: {},
      // Declares this server as a Claude Code channel — incoming feedback
      // events get pushed to the session as <channel source="claude-workspaces" …>
      // via `notifications/claude/channel`.
      experimental: { 'claude/channel': {} },
    },
    instructions: CONNECTOR_INSTRUCTIONS,
  },
);

/**
 * This process's one session. Everything it holds — the watch registry, the
 * dedup window, the deferred emitter, the event stream — is built in
 * connector-session.ts from what is passed here, so the shared server can
 * build the same thing per agent.
 */
const session = createConnectorSession({
  author: AUTHOR,
  cwd: process.cwd(),
  // Read per call, as the handler did before it moved: the same setting the
  // Stop hook reads.
  defaultWorkspaceId: () =>
    (process.env.CW_WORKSPACE_ID ?? process.env.FEEDBACK_WORKSPACE_ID ?? '').trim(),
  pluginVersion: () => PLUGIN_VERSION,
  processId: PROCESS_ID,
  notify: (n) => server.notification(n),
  resolveBaseUrl,
  fetch: (url, init) => fetch(url, init),
  log: (...args) => console.error(...args),
});

server.setRequestHandler(ListToolsRequestSchema, async () => session.listTools());
server.setRequestHandler(CallToolRequestSchema, (req) => session.callTool(req));

const transport = new StdioServerTransport();
// Once the client has finished initializing (not merely connected — the MCP
// spec has the server hold notifications until then), ask the server for
// this identity's watch set and re-wire it, so the respawn keeps its feedback
// loop without waiting for a tool call. A tool call arriving meanwhile awaits
// the same in-flight restore.
server.oninitialized = () => {
  void session.ensureWatchesRestored();
};
await server.connect(transport);
// Best-effort startup banner. Fall back gracefully if discovery isn't ready
// at child-start — http() will resolve fresh per request anyway.
let bannerBase: string;
try {
  bannerBase = resolveBaseUrl();
} catch {
  bannerBase = '<discovery pending — server not yet running>';
}
console.error(`[mcp] connected — base ${bannerBase}, author ${AUTHOR.name}`);
