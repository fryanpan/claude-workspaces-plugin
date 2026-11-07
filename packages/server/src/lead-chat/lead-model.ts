/**
 * What the board knows of its lead's model and effort, and a person's pick
 * of new ones.
 *
 * The lead's hooks report what its session runs on (`routes/lead-mirror.ts`).
 * A pick is typed into the lead's terminal (`pane.ts`), only between its
 * turns: a prompt that appears mid-turn must never meet the Enter. So a pick
 * made while the lead works is held, shown as pending, and sent when the turn
 * ends. The state is kept on disk, and a server that does not know whether
 * the lead is working treats it as working until a hook says otherwise.
 *
 * Every change goes to the board's pages as a `lead-chat.model` frame and to
 * no agent stream.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  LEAD_CHAT_MODEL_EVENT,
  type LeadChatModelFrame,
  type LeadEffort,
  type LeadModelAlias,
  type LeadModelState,
} from '@claude-workspaces/core/lead-chat';
import { leadChatLogPath } from './log.ts';
import type { LeadRef, PaneSend } from './pane.ts';

export interface LeadModelsDeps {
  dataDir: string;
  /** The board's lead, by id; null when the seat is empty. */
  leadOf(workspaceId: string): LeadRef | null;
  pane: { send(lead: LeadRef, pick: LeadModelPick): Promise<PaneSend> };
  broadcast(workspaceId: string, frame: LeadChatModelFrame): void;
}

export interface LeadModelPick {
  model?: LeadModelAlias;
  effort?: LeadEffort;
}

interface Held extends LeadModelState {
  /** A hook has said the lead's session sits between turns. */
  idle?: boolean;
}

export class LeadModels {
  private readonly boards = new Map<string, Held>();
  private readonly sending = new Set<string>();

  constructor(private readonly deps: LeadModelsDeps) {}

  /** What a page is shown. */
  read(workspaceId: string): LeadModelState {
    const { idle: _idle, ...shown } = this.state(workspaceId);
    return shown;
  }

  /**
   * What the lead's session reported. `started` is a session that just began,
   * which is between turns. A report that agrees with a pick clears it.
   */
  observed(
    workspaceId: string,
    report: { model?: string; effort?: string; started?: boolean },
  ): void {
    const s = { ...this.state(workspaceId) };
    if (report.model) s.model = report.model;
    if (report.effort) s.effort = report.effort;
    if (report.started) s.idle = true;
    this.put(workspaceId, s);
    if (report.started) void this.flush(workspaceId);
  }

  turnStarted(workspaceId: string): void {
    const s = this.state(workspaceId);
    if (s.idle !== false) this.put(workspaceId, { ...s, idle: false }, false);
  }

  turnEnded(workspaceId: string): void {
    this.put(workspaceId, { ...this.state(workspaceId), idle: true }, false);
    void this.flush(workspaceId);
  }

  /** Hold a pick and send it as soon as the lead is between turns. Resolves
   *  with the state once a send it could make has been made. */
  async pick(workspaceId: string, pick: LeadModelPick): Promise<LeadModelState> {
    const s = this.state(workspaceId);
    const { problem: _problem, ...rest } = s;
    this.put(workspaceId, { ...rest, pending: { ...s.pending, ...pick } });
    await this.flush(workspaceId);
    return this.read(workspaceId);
  }

  private async flush(workspaceId: string): Promise<void> {
    if (this.sending.has(workspaceId)) return;
    const s = this.state(workspaceId);
    const lead = this.deps.leadOf(workspaceId);
    if (!s.pending || s.idle !== true || !lead) return;
    this.sending.add(workspaceId);
    const pick = s.pending;
    try {
      const sent = await this.deps.pane.send(lead, pick);
      this.settle(workspaceId, pick, sent);
    } finally {
      this.sending.delete(workspaceId);
    }
  }

  private settle(workspaceId: string, pick: LeadModelPick, sent: PaneSend): void {
    const { pending, problem: _problem, ...s } = this.state(workspaceId);
    // A pick made while this send was out goes on the next one.
    const newer = pending && JSON.stringify(pending) !== JSON.stringify(pick) ? pending : undefined;
    if (sent.ok) {
      this.put(workspaceId, {
        ...s,
        ...(pick.model ? { model: pick.model } : {}),
        ...(pick.effort ? { effort: pick.effort } : {}),
        ...(newer ? { pending: newer } : {}),
      });
      if (newer) void this.flush(workspaceId);
      return;
    }
    // A terminal waiting on a question may be free when the turn ends. A
    // terminal that cannot be found is told to the reader, and nothing stays
    // queued to fire later by surprise.
    const keep = sent.problem === 'asking' ? (pending ?? pick) : newer;
    this.put(workspaceId, {
      ...s,
      problem: sent.problem,
      ...(keep ? { pending: keep } : {}),
    });
  }

  private path(workspaceId: string): string | null {
    const log = leadChatLogPath(this.deps.dataDir, workspaceId);
    return log ? log.replace(/\.lead-chat\.jsonl$/, '.lead-model.json') : null;
  }

  private state(workspaceId: string): Held {
    const held = this.boards.get(workspaceId);
    if (held) return held;
    let read: Held = {};
    const path = this.path(workspaceId);
    try {
      if (path) read = JSON.parse(readFileSync(path, 'utf8')) as Held;
    } catch {
      // No report yet.
    }
    this.boards.set(workspaceId, read);
    return read;
  }

  private put(workspaceId: string, next: Held, announce = true): void {
    this.boards.set(workspaceId, next);
    const path = this.path(workspaceId);
    try {
      if (path) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(`${path}.tmp`, JSON.stringify(next));
        renameSync(`${path}.tmp`, path);
      }
    } catch (err) {
      console.error(`[lead-chat] could not keep ${workspaceId}'s model: ${String(err)}`);
    }
    if (announce) {
      this.deps.broadcast(workspaceId, {
        event: LEAD_CHAT_MODEL_EVENT,
        workspaceId,
        state: this.read(workspaceId),
      });
    }
  }
}
