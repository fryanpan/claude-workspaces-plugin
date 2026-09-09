/**
 * WHAT A DOC'S VIEWER LEARNS ABOUT A BOT, through the real server, on the one
 * stream a browser holds.
 *
 * Its sibling `recall-transcript-stream.test.ts` drives the WORDS. This
 * drives the other channel — the vendor's status webhook, signed the way
 * Recall signs one — and asserts the fact the Record button reads: a
 * `meeting.bot` frame saying `recording`, carrying the meeting's URL and its
 * platform, so the control can say what the source is and offer to send the
 * bot home. Then a terminal state, which is what takes the control back.
 *
 * The 2026-09-09 failure was a browser listening on a deleted address, so the
 * server half was never in doubt — but nothing until now asserted that a
 * status webhook reaches the doc's stream at all, and that is precisely the
 * hop a person watched fail. The client half is
 * `packages/workspaces-app/test/meeting-bot-client.test.ts`.
 *
 * The vendor is a fake and every credential here is a literal this file
 * invents. Fixtures are synthetic; the repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreateBotArgs, RecallBot, RecallClient, RecallConfig } from '../src/recall.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

const WEBHOOK_SECRET = `whsec_${btoa('claude-workspaces-bot-surface-test')}`;

type Frame = { event: string; id?: string; data?: Record<string, unknown> };

/** Read an SSE body into frames until told to stop. */
function listenFrames(res: Response): { frames: Frame[]; stop: () => Promise<void> } {
  const frames: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  let buf = '';
  const pump = (async () => {
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
          const frame: Frame = { event: 'message' };
          for (const line of raw.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) frame.event = line.slice(6).trim();
            else if (line.startsWith('id:')) frame.id = line.slice(3).trim();
            else if (line.startsWith('data:')) {
              try {
                frame.data = JSON.parse(line.slice(5).trimStart()) as Record<string, unknown>;
              } catch {}
            }
          }
          if (frame.data || frame.id || frame.event !== 'message') frames.push(frame);
        }
      }
    } catch {}
  })();
  return {
    frames,
    stop: async () => {
      stopped = true;
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
}

const waitFor = async (pred: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

class FakeRecall implements RecallClient {
  readonly created: CreateBotArgs[] = [];
  readonly left: string[] = [];
  readonly config: RecallConfig = {
    region: 'us-east-1',
    publicWsBase: 'wss://recall.example.test',
    retentionHours: 24,
    separateStreams: true,
    botName: 'Meeting Assistant',
  };
  createBot(args: CreateBotArgs): Promise<RecallBot> {
    this.created.push(args);
    return Promise.resolve({ id: `bot_${this.created.length}` });
  }
  getBot(botId: string): Promise<RecallBot> {
    return Promise.resolve({ id: botId });
  }
  leaveCall(botId: string): Promise<void> {
    this.left.push(botId);
    return Promise.resolve();
  }
  checkKeyRegion() {
    return Promise.resolve({ ok: true as const, region: 'us-east-1' as const });
  }
  requestRecordingPermission(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/** Svix headers for a body, signed the way Recall's backend signs one. */
async function signBody(body: string, id: string): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const raw = WEBHOOK_SECRET.slice('whsec_'.length);
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)) as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
  );
  return {
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${btoa(String.fromCharCode(...mac))}`,
  };
}

let WS = '';

describe("a bot's state on the doc's own event stream", () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let docId = '';
  const vendor = new FakeRecall();

  /** One status-change delivery, in the shape the vendor documents. */
  const status = async (code: string, at: string, deliveryId: string): Promise<Response> => {
    const body = JSON.stringify({
      event: `bot.${code}`,
      data: {
        data: { code, updated_at: at },
        bot: { id: 'bot_1', metadata: {} },
      },
    });
    return fetch(`${base}/recall/status`, {
      method: 'POST',
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...(await signBody(body, deliveryId)),
      },
      body,
    });
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-recall-surface-'));
    handle = createServer({
      port: 0,
      dataDir,
      meetingBot: vendor,
      meetingBotWebhookSecret: WEBHOOK_SECRET,
    });
    base = `http://localhost:${handle.port}`;
    WS = await seedBoard(base);
    const path = join(dataDir, 'harborlight-sync.md');
    writeFileSync(path, '# Harborlight sync\n\nAgenda.\n');
    const res = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        docId: 'harborlight-sync',
        sourceUrl: path,
        title: 'Harborlight sync',
      }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    docId = ((await res.json()) as { docId: string }).docId;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('says recording, names the call it is in, and goes quiet when the bot leaves', async () => {
    const viewer = listenFrames(
      await fetch(`${base}/workspaces/${WS}/docs/${docId}/events:stream`),
    );
    const meetingUrl = 'https://meet.google.com/abc-defg-hij';
    const invited = await fetch(`${base}/workspaces/${WS}/docs/${docId}/meeting-bot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meetingUrl }),
    });
    expect(invited.status, await invited.clone().text()).toBe(200);

    const bot = () => viewer.frames.filter((f) => f.event === 'meeting.bot');
    await waitFor(() => bot().length > 0, 'the invite to reach the doc');

    // THE VENDOR REPORTS IT IS RECORDING, and the doc's viewers are told.
    // This is the frame the Record button reads to say "Recording", and the
    // one that puts "Send the bot home" behind it.
    expect((await status('in_call_recording', '2026-09-09T08:33:10Z', 'msg_rec')).status).toBe(200);
    await waitFor(
      () => bot().some((f) => f.data?.state === 'recording'),
      'the recording state on the doc stream',
    );
    const recording = bot().find((f) => f.data?.state === 'recording') as Frame;
    expect(recording.data).toMatchObject({
      docId,
      botId: 'bot_1',
      state: 'recording',
      // What the control needs to name the SOURCE: this is a bot in a call,
      // not a microphone in the room.
      meetingUrl,
      platform: 'google_meet',
    });
    // Buffered, unlike the words: a tab that reconnects mid-meeting is told
    // the bot is there.
    expect(recording.id).toBeTruthy();

    // AND THE READ ROUTE AGREES — the answer a tab opened mid-call gets
    // before any frame arrives.
    const read = await fetch(`${base}/workspaces/${WS}/docs/${docId}/meeting-bot`);
    expect(await read.json()).toMatchObject({
      configured: true,
      bot: { state: 'recording', meetingUrl, platform: 'google_meet' },
    });

    // The call ends. A terminal state is what takes the control back.
    expect((await status('call_ended', '2026-09-09T08:35:00Z', 'msg_end')).status).toBe(200);
    await waitFor(
      () => bot().some((f) => f.data?.state === 'left'),
      'the terminal state on the doc stream',
    );
    await viewer.stop();
  });
});
