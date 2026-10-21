/**
 * The app voice sockets, one `AppVoiceSession` each: what the websocket
 * handler hands a `kind: 'app-voice'` socket's frames to. The upgrade has
 * already checked the token (`routes/upgrade-stream.ts`, `gate.ts`).
 */
import type { AppVoiceServerMessage } from '@claude-workspaces/core/app-voice';
import type { SpokenEngines } from '../spoken-reply/session.ts';
import { AppVoiceSession, type AppVoiceSessionDeps } from './session.ts';

export interface AppVoiceWs {
  data: { docId: string; workspaceId?: string };
  send(payload: string | Uint8Array): unknown;
}

export interface AppVoiceRelayDeps {
  engines: SpokenEngines;
  /** The write to doc `docId`'s dev server, or null when it is not an app. */
  sayFor(docId: string): ((text: string) => Promise<number>) | null;
  mint(workspaceId: string, docId: string): { token: string; expiresAt: number };
  every?: AppVoiceSessionDeps['every'];
}

export class AppVoiceRelay {
  private readonly sessions = new WeakMap<AppVoiceWs, AppVoiceSession>();

  constructor(private readonly deps: AppVoiceRelayDeps) {}

  onOpen(ws: AppVoiceWs): void {
    const { docId } = ws.data;
    const workspaceId = ws.data.workspaceId ?? '';
    const send = (payload: string | Uint8Array): void => {
      try {
        ws.send(payload);
      } catch {
        // The page went; the close handler tidies up.
      }
    };
    const { voices, listener } = this.deps.engines;
    const session = new AppVoiceSession({
      voice: voices[1] ?? voices[2] ?? null,
      listener,
      say: this.deps.sayFor(docId),
      sendJson: (msg: AppVoiceServerMessage) => send(JSON.stringify(msg)),
      sendAudio: send,
      freshToken: () => this.deps.mint(workspaceId, docId),
      ...(this.deps.every ? { every: this.deps.every } : {}),
    });
    this.sessions.set(ws, session);
    session.open();
  }

  onText(ws: AppVoiceWs, text: string): void {
    this.sessions.get(ws)?.onText(text);
  }

  onAudio(ws: AppVoiceWs, pcm: Uint8Array): void {
    this.sessions.get(ws)?.onAudio(pcm);
  }

  onClose(ws: AppVoiceWs): void {
    this.sessions.get(ws)?.close();
    this.sessions.delete(ws);
  }
}
