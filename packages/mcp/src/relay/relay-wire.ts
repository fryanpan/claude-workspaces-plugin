/**
 * The node relay's pure helpers: the identity headers, the protocol versions
 * `/mcp` speaks, and how a refusal reads. relay-core.ts holds the loop.
 */
export type Rpc = Record<string, unknown>;

/** The versions `/mcp` speaks (connector/protocol.ts), newest first. */
export const SUPPORTED_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
];

const present = (v: string | undefined): string | undefined =>
  v !== undefined && v.trim() !== '' ? v : undefined;

/** The headers identity.ts reads, from the environment the stdio child read. */
export function relayIdentityHeaders(
  env: Record<string, string | undefined>,
  cwd: string,
): Record<string, string> {
  const h: Record<string, string> = { 'x-cw-cwd': cwd };
  const agent = present(env.CW_AGENT_NAME);
  const legacy = present(env.FEEDBACK_AGENT_NAME);
  const workspace = present(env.CW_WORKSPACE_ID) ?? present(env.FEEDBACK_WORKSPACE_ID);
  const version = present(env.CW_RELAY_PLUGIN_VERSION);
  if (agent) h['x-cw-agent'] = agent;
  if (legacy) h['x-cw-agent-legacy'] = legacy;
  if (workspace) h['x-cw-workspace'] = workspace.trim();
  // identity.ts keeps only the last path segment, and only when it is a version.
  if (version) h['x-cw-plugin-root'] = `/${version.trim()}`;
  return h;
}

/** Whether a fetch failure happened before the request left this process. */
export function neverSent(e: unknown): boolean {
  const code =
    (e as { cause?: { code?: unknown }; code?: unknown })?.cause?.code ??
    (e as { code?: unknown })?.code;
  // ENOENT and EPERM: a board socket that is not there (the server is
  // restarting) or that the sandbox refused, before any byte was written.
  return (
    code === 'ECONNREFUSED' ||
    code === 'ConnectionRefused' ||
    code === 'ENOTFOUND' ||
    code === 'ENOENT' ||
    code === 'EPERM'
  );
}

export function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const isRecord = (v: unknown): v is Rpc =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** A route refusal (`{error, message}`) as the sentence a person reads. */
export function refusalText(status: number, body: string): string {
  const j = parse(body);
  const message = isRecord(j) && typeof j.message === 'string' ? j.message : body.slice(0, 300);
  const error = isRecord(j) && typeof j.error === 'string' ? ` ${j.error}` : '';
  return `the claude-workspaces server refused this session (${status}${error}): ${message}`;
}
