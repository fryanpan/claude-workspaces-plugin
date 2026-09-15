/**
 * Who a `/mcp` request speaks for, read from its headers.
 *
 * A stdio connector learned its identity from the environment Claude Code
 * launched it with. An HTTP connection has no environment, so the plugin's
 * `.mcp.json` sends the same values as headers, expanded by Claude Code from
 * the session's own environment:
 *
 *   x-cw-agent         CW_AGENT_NAME
 *   x-cw-agent-legacy  FEEDBACK_AGENT_NAME, the pre-rename spelling
 *   x-cw-cwd           the session's working directory
 *   x-cw-workspace     CW_WORKSPACE_ID
 *   x-cw-plugin-root   CLAUDE_PLUGIN_ROOT, whose last segment is the version
 *
 * Claude Code sends a header whose variable is unset as the literal
 * placeholder (measured: `${CW_AGENT_NAME}` arrives as those characters), so
 * a value shaped like one means "not set".
 *
 * Every value is checked here, before anything is built from it, and none of
 * them grants anything: the endpoint is loopback-only, and a loopback caller
 * can already mint a token for any agent id. What the checks buy is that a
 * malformed value is refused with a sentence rather than carried into a
 * session, a file path or a log line.
 */
import { resolveAgentAuthor } from '../../../mcp/src/author.ts';
import type { AgentAuthor } from '../../../mcp/src/author.ts';
import { isSharedIdentity } from '../../../mcp/src/watch-registry.ts';
import { isValidAgentId } from '../agent-watches.ts';

/** The header values an identity is resolved from, after validation. Also
 *  the shape the shutdown snapshot stores. */
export interface IdentityHeaders {
  agent?: string;
  agentLegacy?: string;
  cwd: string;
  workspace?: string;
  pluginVersion?: string;
}

export interface ConnectorIdentity {
  /** The table key: one hosted session per agent and working directory. */
  key: string;
  author: AgentAuthor;
  /** True for the shared `agent` identity, which is never pooled. */
  shared: boolean;
  headers: IdentityHeaders;
}

export type IdentityRead = { ok: true; headers: IdentityHeaders } | { ok: false; message: string };

const NAME_MAX = 200;
const CWD_MAX = 4096;
const PLACEHOLDER = /^\$\{[^}]*\}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f]/;
const WORKSPACE_ID = /^[a-zA-Z0-9_.:~-]{1,100}$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

/** A header's value, or undefined when absent, empty or an unexpanded placeholder. */
function headerValue(headers: Headers, name: string): string | undefined {
  const raw = headers.get(name)?.trim();
  if (!raw || PLACEHOLDER.test(raw)) return undefined;
  return raw;
}

/** Validate the identity headers. Refuses with a sentence naming the header. */
export function readIdentityHeaders(headers: Headers): IdentityRead {
  const agent = headerValue(headers, 'x-cw-agent');
  const agentLegacy = headerValue(headers, 'x-cw-agent-legacy');
  for (const [name, v] of [
    ['x-cw-agent', agent],
    ['x-cw-agent-legacy', agentLegacy],
  ] as const) {
    if (v !== undefined && (v.length > NAME_MAX || CONTROL.test(v))) {
      return {
        ok: false,
        message: `${name} must be a name of at most ${NAME_MAX} characters`,
      };
    }
  }
  const cwd = headerValue(headers, 'x-cw-cwd');
  if (cwd === undefined) {
    return {
      ok: false,
      message: 'x-cw-cwd is required: the session’s working directory',
    };
  }
  if (!cwd.startsWith('/') || cwd.length > CWD_MAX || CONTROL.test(cwd)) {
    return {
      ok: false,
      message: `x-cw-cwd must be an absolute path of at most ${CWD_MAX} characters`,
    };
  }
  const workspace = headerValue(headers, 'x-cw-workspace');
  if (workspace !== undefined && (!WORKSPACE_ID.test(workspace) || workspace.startsWith('.'))) {
    return { ok: false, message: 'x-cw-workspace is not a workspace id' };
  }
  // Only the version is kept, and only when the last path segment is one: the
  // path itself is never used, logged or stored.
  const root = headerValue(headers, 'x-cw-plugin-root');
  const lastSegment = root?.split('/').filter(Boolean).pop();
  const pluginVersion = lastSegment && VERSION.test(lastSegment) ? lastSegment : undefined;
  return {
    ok: true,
    headers: {
      ...(agent !== undefined ? { agent } : {}),
      ...(agentLegacy !== undefined ? { agentLegacy } : {}),
      cwd,
      ...(workspace !== undefined ? { workspace } : {}),
      ...(pluginVersion !== undefined ? { pluginVersion } : {}),
    },
  };
}

/**
 * The identity those headers name, or a refusal.
 *
 * The author is resolved by the same function the stdio child runs over its
 * environment, so an agent is the same id on both transports. `CW_AUTHOR` is
 * the value the plugin pins for every peer.
 *
 * A shared identity — no agent name at all — is keyed per SESSION, never per
 * directory: every unnamed session would otherwise pool into one hosted
 * session and read each other's pushes.
 */
export function resolveIdentity(
  headers: IdentityHeaders,
  sessionId: string,
): { ok: true; identity: ConnectorIdentity } | { ok: false; message: string } {
  const author = resolveAgentAuthor({
    ...(headers.agent !== undefined ? { CW_AGENT_NAME: headers.agent } : {}),
    ...(headers.agentLegacy !== undefined ? { FEEDBACK_AGENT_NAME: headers.agentLegacy } : {}),
    CW_AUTHOR: 'agent',
  });
  const shared = isSharedIdentity(author.id);
  if (!shared && !isValidAgentId(author.id)) {
    return {
      ok: false,
      message: 'x-cw-agent does not resolve to a valid agent id',
    };
  }
  const key = shared ? `shared\n${sessionId}` : `${author.id}\n${headers.cwd}`;
  return { ok: true, identity: { key, author, shared, headers } };
}

/** Snapshot values back into headers, so a restored identity passes exactly
 *  the checks a request's would. */
export function headersOf(saved: IdentityHeaders): Headers {
  const h = new Headers();
  if (saved.agent) h.set('x-cw-agent', saved.agent);
  if (saved.agentLegacy) h.set('x-cw-agent-legacy', saved.agentLegacy);
  h.set('x-cw-cwd', saved.cwd);
  if (saved.workspace) h.set('x-cw-workspace', saved.workspace);
  if (saved.pluginVersion) h.set('x-cw-plugin-root', `/${saved.pluginVersion}`);
  return h;
}
