/**
 * What the board knows of its lead's model and effort. The lead's hooks report
 * what its session runs on (`routes/lead-mirror.ts`), and the state is kept on
 * disk.
 *
 * Switching from the board is off. On Claude Code 2.1.319 `/model` and
 * `/effort` also save the value as the default for every new session, so one
 * pick typed into a lead's terminal changed the fleet's defaults. Nothing here
 * calls `deps.pane`; `pane.ts` stays with its tests until switching has a way
 * to reach one session only.
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
  /** Never called while switching is off. */
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

  constructor(private readonly deps: LeadModelsDeps) {}

  /** What a page is shown. */
  read(workspaceId: string): LeadModelState {
    const { idle: _idle, ...shown } = this.state(workspaceId);
    return shown;
  }

  /**
   * What the lead's session reported. `started` is a session that just began,
   * which is between turns.
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
    if (report.started) this.flush(workspaceId);
  }

  turnStarted(workspaceId: string): void {
    const s = this.state(workspaceId);
    if (s.idle !== false) this.put(workspaceId, { ...s, idle: false }, false);
  }

  turnEnded(workspaceId: string): void {
    this.put(workspaceId, { ...this.state(workspaceId), idle: true }, false);
    this.flush(workspaceId);
  }

  /**
   * Sends nothing. A pick an older server left on disk would otherwise fire
   * at the next turn end, so it is dropped here, unsent, with its problem.
   */
  private flush(workspaceId: string): void {
    const { pending, problem, ...s } = this.state(workspaceId);
    if (pending || problem) this.put(workspaceId, s);
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
    const before = JSON.stringify(this.read(workspaceId));
    this.boards.set(workspaceId, next);
    const path = this.path(workspaceId);
    try {
      if (path) {
        mkdirSync(dirname(path), { recursive: true });
        // `idle` stays out: a turn may start while the server is down.
        writeFileSync(`${path}.tmp`, JSON.stringify(this.read(workspaceId)));
        renameSync(`${path}.tmp`, path);
      }
    } catch (err) {
      console.error(`[lead-chat] could not keep ${workspaceId}'s model: ${String(err)}`);
    }
    const state = this.read(workspaceId);
    if (announce && JSON.stringify(state) !== before) {
      this.deps.broadcast(workspaceId, { event: LEAD_CHAT_MODEL_EVENT, workspaceId, state });
    }
  }
}
