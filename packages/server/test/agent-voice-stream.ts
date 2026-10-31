/**
 * An agent's own board stream for a voice test: every `voice.request` it is
 * sent, kept in order. Shared by the converse-socket and voice-API tests.
 */

export interface VoiceFrame {
  transcript?: string;
  to?: string;
  queueId?: string;
  conversationId?: string;
  conversation?: Array<{ from: string; text: string }>;
  actor?: { id?: string; name?: string };
  context?: { surface?: string; link?: string };
}

/** An agent's own board stream, keeping every `voice.request` it is sent. */
export async function agentStream(base: string, workspaceId: string, agentId: string) {
  const controller = new AbortController();
  const res = await fetch(
    `${base}/workspaces/${workspaceId}/events:stream?agentId=${encodeURIComponent(agentId)}`,
    { signal: controller.signal, headers: { accept: 'text/event-stream' } },
  );
  if (!res.ok) throw new Error(`stream ${agentId}: HTTP ${res.status}`);
  const voice: VoiceFrame[] = [];
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  void (async () => {
    if (!reader) return;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let cut = buf.indexOf('\n\n');
        while (cut !== -1) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          cut = buf.indexOf('\n\n');
          const data = block
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('');
          if (!data) continue;
          try {
            const p = JSON.parse(data) as { event?: string } & VoiceFrame;
            if (p.event === 'voice.request') voice.push(p);
          } catch {
            // A keepalive or a non-JSON line.
          }
        }
      }
    } catch {
      // Aborted by close().
    }
  })();
  return {
    voice,
    close: () => controller.abort(),
  };
}
