/**
 * One page in a board's presence room, over a real `/y` socket: it syncs,
 * applies the awareness it hears, and announces its own. The same shape
 * `workspace-presence-room.test.ts` keeps inline.
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

export interface RoomPage {
  ydoc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  ready: Promise<void>;
  /** Send a raw frame, for a page that does not play by the protocol. */
  send(frame: Uint8Array): void;
  close(): void;
}

export function joinRoom(
  url: string,
  origin: string,
  headers: Record<string, string> = {},
): RoomPage {
  const ydoc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(ydoc);
  const ws = new WebSocket(url, { headers: { origin, ...headers } } as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  let synced: () => void = () => {};
  const ready = new Promise<void>((r) => {
    synced = r;
  });
  const announce = (): void => {
    if (ws.readyState !== WebSocket.OPEN || awareness.getLocalState() === null) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(awareness, [ydoc.clientID]),
    );
    ws.send(encoding.toUint8Array(enc));
  };
  awareness.on('update', (_: unknown, from: unknown) => {
    if (from === 'local') announce();
  });
  ws.addEventListener('open', () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, ydoc);
    ws.send(encoding.toUint8Array(enc));
    announce();
  });
  ws.addEventListener('message', (ev) => {
    const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
    const kind = decoding.readVarUint(dec);
    if (kind === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), ws);
      return;
    }
    if (kind !== MSG_SYNC) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    const type = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    if (type === syncProtocol.messageYjsSyncStep2) synced();
  });
  return { ydoc, awareness, ready, send: (frame) => ws.send(frame), close: () => ws.close() };
}

/** Every frame an agent's board stream is sent, in order. */
export async function agentFrames(base: string, workspaceId: string, agentId: string) {
  const abort = new AbortController();
  const res = await fetch(
    `${base}/workspaces/${workspaceId}/events:stream?agentId=${encodeURIComponent(agentId)}`,
    { headers: { accept: 'text/event-stream' }, signal: abort.signal },
  );
  if (!res.ok) throw new Error(`stream ${agentId}: HTTP ${res.status}`);
  const frames: Array<Record<string, unknown>> = [];
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
          const data = buf
            .slice(0, cut)
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('');
          buf = buf.slice(cut + 2);
          cut = buf.indexOf('\n\n');
          try {
            if (data) frames.push(JSON.parse(data) as Record<string, unknown>);
          } catch {
            // A keepalive or a non-JSON line.
          }
        }
      }
    } catch {
      // Aborted at close.
    }
  })();
  return { frames, close: () => abort.abort() };
}
