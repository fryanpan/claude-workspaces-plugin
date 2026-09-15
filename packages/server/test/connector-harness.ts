/**
 * A raw Streamable HTTP client for the `/mcp` tests: initialize, open a GET
 * stream, post a message — each one call, so a test can hold two sessions of
 * the same agent open at once, present an old session id to a new server, or
 * reconnect with a chosen `Last-Event-ID`. The SDK's own client does none of
 * those on demand; `connector-route.test.ts` uses it for the one end-to-end
 * case where its behaviour is the thing under test.
 */

/** One SSE event as it came off the wire. */
export interface WireEvent {
  id: string | null;
  retry: number | null;
  /** The parsed JSON-RPC message, or null for an event with no data. */
  message: Record<string, unknown> | null;
}

export interface Feed {
  events: WireEvent[];
  /** Comment lines (`:ka`), counted so a test can prove a stream is alive. */
  comments: number;
  /** The `content` of every channel notification received, in order. */
  channelTexts(): string[];
  stop(): void;
}

export function listen(res: Response): Feed {
  const events: WireEvent[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let stopped = false;
  const feed: Feed = {
    events,
    comments: 0,
    channelTexts: () =>
      events
        .map((e) => e.message)
        .filter((m) => m?.method === 'notifications/claude/channel')
        .map((m) => String((m?.params as { content?: unknown }).content)),
    stop: () => {
      stopped = true;
      void reader.cancel().catch(() => {});
    },
  };
  void (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          const lines = raw.split('\n');
          if (lines.every((l) => l.startsWith(':'))) {
            feed.comments += 1;
            continue;
          }
          const e: WireEvent = { id: null, retry: null, message: null };
          for (const line of lines) {
            if (line.startsWith('id:')) e.id = line.slice(3).trim();
            else if (line.startsWith('retry:')) e.retry = Number(line.slice(6).trim());
            else if (line.startsWith('data:')) {
              const data = line.slice(5).trim();
              if (data) e.message = JSON.parse(data) as Record<string, unknown>;
            }
          }
          events.push(e);
        }
      }
    } catch {
      // Cancelled with a read in flight; what was collected stands.
    }
  })();
  return feed;
}

/** The identity headers the plugin's `.mcp.json` sends. */
export function identityHeaders(agent: string | null, cwd: string): Record<string, string> {
  return {
    ...(agent ? { 'x-cw-agent': agent } : {}),
    'x-cw-cwd': cwd,
    'x-cw-plugin-root': '/plugins/cache/claude-workspaces/0.1.999',
  };
}

/** Anything that answers a Request: a host directly, or a real server via fetch. */
export type Send = (
  method: string,
  headers: Record<string, string>,
  body?: unknown,
) => Promise<Response>;

export function initializeBody(id = 1): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'connector-test', version: '0.0.0' },
    },
  };
}

export async function initialize(send: Send, headers: Record<string, string>): Promise<string> {
  const res = await send('POST', headers, initializeBody());
  const sid = res.headers.get('mcp-session-id');
  if (res.status !== 200 || !sid)
    throw new Error(`initialize answered ${res.status}: ${await res.text()}`);
  await res.body?.cancel();
  return sid;
}

export async function rpc(
  send: Send,
  sid: string,
  headers: Record<string, string>,
  method: string,
  params: unknown = {},
  id = 2,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await send(
    'POST',
    { ...headers, 'mcp-session-id': sid },
    { jsonrpc: '2.0', id, method, params },
  );
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

export function openStream(
  send: Send,
  sid: string,
  headers: Record<string, string>,
  lastEventId?: string,
): Promise<Response> {
  return send('GET', {
    ...headers,
    accept: 'text/event-stream',
    'mcp-session-id': sid,
    ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
  });
}
