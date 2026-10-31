/**
 * A board stream for a lead-chat test — a page's, or with `agentId` an
 * agent's own: every frame's event name, and each lead-chat message, kept in
 * order. Shared by the chat's route test and the mirror's.
 */
import { LEAD_CHAT_EVENT, type LeadChatMessage } from '@claude-workspaces/core/lead-chat';

/** A board stream — a page's, or with `agentId` an agent's own: every frame's
 *  event name, and each lead-chat message. */
export async function pageStream(base: string, workspaceId: string, agentId?: string) {
  const controller = new AbortController();
  const q = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
  const res = await fetch(`${base}/workspaces/${workspaceId}/events:stream${q}`, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' },
  });
  if (!res.ok) throw new Error(`page stream: HTTP ${res.status}`);
  const messages: LeadChatMessage[] = [];
  const events: string[] = [];
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
            const p = JSON.parse(data) as { event?: string; message?: LeadChatMessage };
            if (p.event) events.push(p.event);
            if (p.event === LEAD_CHAT_EVENT && p.message) messages.push(p.message);
          } catch {
            // A keepalive.
          }
        }
      }
    } catch {
      // Aborted by close().
    }
  })();
  return { messages, events, close: () => controller.abort() };
}
