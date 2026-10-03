/**
 * "Your coach" on the front page: where Workflow A starts and is reviewed,
 * and where he sets how readily the coach speaks up.
 *
 * Calm by default (the owner, 2026-09-13): a heading, his goals as a plain
 * list, and at most one offer. No badge, no count asking for attention. The
 * how-readily control is three buttons of one width, and its hint is sized
 * for the longest, so pressing one moves nothing beside it.
 *
 * Only the owner's own signed-in session gets this HTML (the caller decides).
 * Every string here is his or the coach's, and all of it is escaped.
 */
import { escapeHtml } from '@claude-workspaces/core';
import type { CoachWeek } from './store.ts';
import { COACH_READINESS, type CoachReadiness } from './types.ts';

export interface CoachSectionInput {
  /** The goals doc's page, once it exists. */
  docUrl: string | null;
  name: string;
  /** A coach session is listening. Without one the coach says nothing. */
  online: boolean;
  /** Goal titles, in the doc's order. */
  goals: readonly string[];
  /** Goals with no "Act differently when" yet: the coach cannot use them. */
  unready: number;
  reviewDue: boolean;
  readiness: CoachReadiness;
  week: CoachWeek;
}

const READINESS_LABEL: Record<CoachReadiness, string> = {
  less: 'Less',
  normal: 'Normal',
  more: 'More',
};
/** Told to the coach session, which weighs it; no timer reads it. */
const READINESS_HINT: Record<CoachReadiness, string> = {
  less: 'only when it is plain',
  normal: 'when it sees a clear match',
  more: 'also when it is less sure',
};

function setupBlock(): string {
  return `<p class="coach-quiet">Your coach helps with habits you want to change. It asks you, out loud, what you want to do better and when it should speak up, and writes your answers into one doc.</p><div class="coach-acts"><button type="button" class="board-btn board-btn-ink" data-act="setup">Set up my coach</button></div>`;
}

function goalsBlock(input: CoachSectionInput, docUrl: string): string {
  const list =
    input.goals.length === 0
      ? `<p class="coach-quiet">No goals yet. Open <a href="${escapeHtml(docUrl)}">Learning goals</a> and tap Talk.</p>`
      : `<ol class="coach-goals">${input.goals.map((g) => `<li>${escapeHtml(g)}</li>`).join('')}</ol>`;
  const unready =
    input.unready > 0
      ? `<p class="coach-sub">${input.unready === 1 ? 'One goal needs' : `${input.unready} goals need`} “Act differently when” before the coach can use it.</p>`
      : '';
  const review = input.reviewDue
    ? `<div class="coach-review"><p class="coach-q">Your goals haven’t changed in a week. Are they still right?</p><div class="coach-acts"><a class="board-btn" href="${escapeHtml(docUrl)}">Review my goals</a><button type="button" class="board-btn" data-review="no-update">No update needed</button></div></div>`
    : '';
  const often = `<div class="coach-often"><span class="coach-often-label" id="coach-often-l">How readily</span><div class="coach-seg" role="group" aria-labelledby="coach-often-l">${COACH_READINESS.map(
    (r) =>
      `<button type="button" class="coach-seg-btn" data-readiness="${r}" aria-pressed="${r === input.readiness}" title="${READINESS_HINT[r]}">${READINESS_LABEL[r]}</button>`,
  ).join(
    '',
  )}</div><span class="coach-sub coach-often-hint">${READINESS_HINT[input.readiness]}</span></div>`;
  const w = input.week;
  const week =
    w.moments > 0
      ? `<p class="coach-sub">This week: ${w.moments} ${w.moments === 1 ? 'moment' : 'moments'} · Thanks ${w.thanks} · Not now ${w.notNow} · Not this ${w.notThis} · Left ${w.unanswered}</p>`
      : '';
  const events =
    w.eventsToday > 0
      ? `<p class="coach-sub">Today it read ${w.eventsToday} ${w.eventsToday === 1 ? 'event' : 'events'}.</p>`
      : '';
  const offline = input.online
    ? ''
    : '<p class="coach-sub">Offline. No coach session is running, so it will not speak up.</p>';
  return `${offline}${list}${unready}<div class="coach-acts"><button type="button" class="board-btn" data-act="add-goal">Add a goal</button></div>${review}${often}${week}${events}`;
}

export function renderCoachSection(input: CoachSectionInput): string {
  const link = input.docUrl
    ? `<a class="coach-doc-link" href="${escapeHtml(input.docUrl)}">Learning goals</a>`
    : '';
  return `<section id="coach" class="coach-front" aria-labelledby="coach-h"><div class="coach-head"><h2 id="coach-h">${escapeHtml(input.name)}</h2>${link}</div>${
    input.docUrl ? goalsBlock(input, input.docUrl) : setupBlock()
  }</section>`;
}

/** The section's styles, in the front page's own palette (`LANDING_CSS`). */
export const COACH_SECTION_CSS = `
.coach-front{--border:#e6e9ed;--fg:#1b1f23;--fg-muted:#6e7781;--bg-panel:#fff;--bg-hover:#f8f9fb;--radius:8px;margin:0 0 22px}
.coach-head{display:flex;align-items:center;gap:4px 12px;min-height:36px;margin:0 0 4px}
.coach-head h2{flex:1 1 auto;margin:0}
.coach-doc-link{font-size:13px;color:var(--fg-muted);text-underline-offset:3px}
.coach-goals{margin:0 0 8px;padding:0 0 0 1.6em}
.coach-goals li{padding:4px 0;line-height:1.4}
.coach-quiet{margin:0 0 8px;padding:6px 0 0;font-size:14px;line-height:1.45;color:var(--fg-muted)}
.coach-q{margin:0 0 8px;line-height:1.4}
.coach-sub{margin:2px 0 8px;font-size:12.5px;line-height:1.4;color:var(--fg-muted)}
.coach-review{margin:10px 0 0;padding:10px 0 0;border-top:1px solid var(--border)}
.coach-acts{display:flex;flex-wrap:wrap;gap:8px}
.coach-front .board-btn{display:inline-flex;align-items:center;justify-content:center;min-height:36px;min-width:150px;padding:4px 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-panel);color:var(--fg);font:inherit;font-size:14px;text-decoration:none;cursor:pointer}
.coach-front .board-btn:hover{background:var(--bg-hover)}
.coach-front .board-btn-ink{background:var(--fg);border-color:var(--fg);color:var(--bg-panel)}
.coach-front .board-btn:disabled{opacity:.6;cursor:default}
.coach-often{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:12px 0 4px}
.coach-often-label{font-size:13px;color:var(--fg-muted)}
.coach-seg{display:inline-flex;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.coach-seg-btn{min-width:76px;min-height:34px;padding:0 10px;border:none;border-left:1px solid var(--border);background:var(--bg-panel);color:var(--fg);font:inherit;font-size:13.5px;cursor:pointer}
.coach-seg-btn:first-child{border-left:none}
.coach-seg-btn[aria-pressed="true"]{background:var(--fg);color:var(--bg-panel)}
.coach-often-hint{margin:0;min-width:13em}
`;
