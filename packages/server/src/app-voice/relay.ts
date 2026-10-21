/**
 * The app voice sockets, one `AppVoiceSession` each: what the websocket
 * handler hands a `kind: 'app-voice'` socket's frames to. The upgrade has
 * already checked the token (`routes/upgrade-stream.ts`, `gate.ts`).
 *
 * A doc has at most `socketsPerDoc` of them open; one more is closed as it
 * opens, with `APP_VOICE_CLOSE_TOO_MANY`, before a session exists. Every
 * session shares one daily budget (`limits.ts`).
 */
import {
  APP_VOICE_CLOSE_TOO_MANY,
  type AppVoiceServerMessage,
} from '@claude-workspaces/core/app-voice';
import type { SpokenEngines } from '../spoken-reply/session.ts';
import { APP_VOICE_LIMITS, AppVoiceBudget, type AppVoiceLimits } from './limits.ts';
import { AppVoiceSession, type AppVoiceSessionDeps } from './session.ts';

export interface AppVoiceWs {
  data: { docId: string; workspaceId?: string };
  send(payload: string | Uint8Array): unknown;
  close(code?: number, reason?: string): void;
}

export interface AppVoiceRelayDeps {
  engines: SpokenEngines;
  /** The write to doc `docId`'s dev server, or null when it is not an app. */
  sayFor(docId: string): ((text: string) => Promise<number>) | null;
  mint(workspaceId: string, docId: string): { token: string; expiresAt: number };
  every?: AppVoiceSessionDeps['every'];
  now?: () => number;
  limits?: AppVoiceLimits;
}

export class AppVoiceRelay {
  private readonly sessions = new WeakMap<AppVoiceWs, AppVoiceSession>();
  /** Open sessions per board and doc. */
  private readonly perDoc = new Map<string, number>();
  private readonly limits: AppVoiceLimits;
  private readonly budget: AppVoiceBudget;

  constructor(private readonly deps: AppVoiceRelayDeps) {
    this.limits = deps.limits ?? APP_VOICE_LIMITS;
    this.budget = new AppVoiceBudget(this.limits, deps.now);
  }

  onOpen(ws: AppVoiceWs): void {
    const { docId } = ws.data;
    const workspaceId = ws.data.workspaceId ?? '';
    const key = `${workspaceId}\n${docId}`;
    const open = this.perDoc.get(key) ?? 0;
    if (open >= this.limits.socketsPerDoc) {
      ws.close(APP_VOICE_CLOSE_TOO_MANY, 'too many app voice sockets open on this doc');
      return;
    }
    this.perDoc.set(key, open + 1);
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
      ...(this.deps.now ? { now: this.deps.now } : {}),
      hangUp: (code, reason) => ws.close(code, reason),
      budget: this.budget,
      limits: this.limits,
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
    const session = this.sessions.get(ws);
    // A socket closed as it opened never held a session or a place.
    if (!session) return;
    session.close();
    this.sessions.delete(ws);
    const key = `${ws.data.workspaceId ?? ''}\n${ws.data.docId}`;
    const left = (this.perDoc.get(key) ?? 1) - 1;
    if (left > 0) this.perDoc.set(key, left);
    else this.perDoc.delete(key);
  }
}
