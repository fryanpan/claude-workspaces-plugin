/**
 * The lead chat's meeting, as the panel draws it: one heading row — a steady
 * red dot, "Meeting", up to four faces, End meeting — and the live notes box
 * under it, which every page of the board shows while the meeting runs.
 *
 * Drawing only; `lead-chat-mount.ts` decides what End meeting and the tap do.
 */
import type { LeadChatMeeting } from '@claude-workspaces/core/lead-chat';
import type { MeetingRunState } from './lead-chat-meeting.ts';

/** The faces the heading shows; the rest are a count. */
export const FACES_SHOWN = 4;
export const NOTES_EMPTY = 'Nothing said yet. Each line appears here as it is said.';

export const MEETING_STYLES = `
.lc-start { flex: none; height: 36px; margin: 0; padding: 0 12px; border: 1px solid var(--border, #d1d5da); border-radius: 8px; background: var(--bg, #fff); color: var(--fg, #1b1f23); font: inherit; font-size: 13.5px; font-weight: 600; cursor: pointer; white-space: nowrap; }
.lc-start:hover { background: var(--bg-hover, #f6f8fa); }
.lc-meet { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
.lc-meet-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #d1242f; }
.lc-meet-dot.lc-off { background: #8a8780; }
.lc-meet-name { flex: none; font-size: 15px; font-weight: 650; }
.lc-faces { display: flex; min-width: 0; }
.lc-face { flex: none; width: 26px; height: 26px; margin-left: -6px; border: 2px solid var(--bg, #fff); border-radius: 50%; background: #e5e0d6; color: #3d3a33; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 650; }
.lc-face:first-child { margin-left: 0; }
.lc-meet-sp { flex: 1; }
.lc-end { flex: none; height: 36px; margin: 0; padding: 0 12px; border: 1px solid #1a1a18; border-radius: 8px; background: #1a1a18; color: #fff; font: inherit; font-size: 13.5px; font-weight: 600; cursor: pointer; white-space: nowrap; }
.lc-end:disabled { opacity: .5; cursor: default; }
.lc-notes { flex: none; display: flex; flex-direction: column; max-height: 38%; border-bottom: 1px solid var(--border, #d1d5da); background: #faf8f3; }
.lc-notes-h { flex: none; display: flex; align-items: baseline; gap: 6px; padding: 8px 16px 4px; font-size: 12.5px; color: var(--fg-muted, #57606a); white-space: nowrap; }
.lc-notes-h b { color: var(--fg, #1b1f23); font-weight: 650; }
.lc-notes-doc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.lc-notes-n { flex: none; font-variant-numeric: tabular-nums; }
.lc-notes-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 16px 8px; display: flex; flex-direction: column; gap: 3px; overscroll-behavior: contain; }
.lc-line { font-size: 13.5px; line-height: 1.4; overflow-wrap: anywhere; }
.lc-line b { font-weight: 600; margin-right: 4px; }
.lc-line.lc-dim { color: var(--fg-muted, #57606a); }
.lc-notes-empty { margin: 2px 0; font-size: 13px; color: var(--fg-muted, #57606a); }
.lc-tap { flex: none; margin: 0 16px 8px; height: 40px; border: 1px solid #d1242f; border-radius: 8px; background: var(--bg, #fff); color: #d1242f; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
.lc-run-note { flex: none; margin: 0 16px 6px; font-size: 12.5px; color: var(--fg-muted, #57606a); }
`;

export interface MeetingViewModel {
  meeting: LeadChatMeeting | null;
  run: MeetingRunState;
  /** This page records the meeting. */
  recording: boolean;
  /** End meeting has been pressed and is waiting on the server. */
  ending: boolean;
}

export interface MeetingView {
  /** The heading row; drawn into the panel's header while a meeting runs. */
  head: HTMLElement;
  /** The live notes box, under the header. */
  notes: HTMLElement;
  end: HTMLButtonElement;
  tap: HTMLButtonElement;
  render(m: MeetingViewModel): void;
}

/** "Alice Riverbend" → "AR"; one word gives one letter. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function linesLabel(n: number): string {
  return n === 1 ? '1 line' : `${n} lines`;
}

export function createMeetingView(doc: Document): MeetingView {
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const e = doc.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const head = el('div', 'lc-meet');
  head.hidden = true;
  const dot = el('span', 'lc-meet-dot');
  dot.setAttribute('aria-hidden', 'true');
  const name = el('span', 'lc-meet-name', 'Meeting');
  const faces = el('span', 'lc-faces');
  const end = el('button', 'lc-end', 'End meeting');
  end.type = 'button';
  head.append(dot, name, faces, el('span', 'lc-meet-sp'), end);

  const notes = el('section', 'lc-notes');
  notes.hidden = true;
  notes.setAttribute('aria-label', 'Meeting notes');
  const nh = el('div', 'lc-notes-h');
  const docName = el('span', 'lc-notes-doc');
  const count = el('span', 'lc-notes-n');
  nh.append(el('b', '', 'Notes'), docName, count);
  const list = el('div', 'lc-notes-list');
  list.setAttribute('role', 'log');
  list.setAttribute('aria-live', 'polite');
  const runNote = el('p', 'lc-run-note');
  const tap = el('button', 'lc-tap', 'Tap to keep recording');
  tap.type = 'button';
  notes.append(nh, list, runNote, tap);

  let lastLines = -1;

  return {
    head,
    notes,
    end,
    tap,
    render(m) {
      const meeting = m.meeting;
      head.hidden = !meeting;
      notes.hidden = !meeting;
      if (!meeting) {
        lastLines = -1;
        return;
      }
      dot.classList.toggle('lc-off', m.recording && m.run.phase !== 'recording');
      faces.replaceChildren();
      for (const p of meeting.people.slice(0, FACES_SHOWN)) {
        const f = el('span', 'lc-face', initials(p.name));
        f.title = p.name;
        faces.append(f);
      }
      faces.setAttribute('aria-label', meeting.people.map((p) => p.name).join(', '));
      end.disabled = m.ending;
      docName.textContent =
        meeting.notes === 'none' ? '· not written down' : `· ${meeting.docTitle}`;
      count.textContent = linesLabel(meeting.lines.length);

      const atFoot = list.scrollHeight - list.scrollTop - list.clientHeight < 30;
      list.replaceChildren();
      if (meeting.lines.length === 0 && !m.run.partial) {
        list.append(el('p', 'lc-notes-empty', NOTES_EMPTY));
      }
      for (const l of meeting.lines) {
        const row = el('div', 'lc-line');
        row.dataset.turn = String(l.turn);
        row.append(el('b', '', l.who), l.text);
        list.append(row);
      }
      if (m.recording && m.run.partial) {
        const row = el('div', 'lc-line lc-dim');
        row.append(m.run.partial);
        list.append(row);
      }
      if (atFoot || lastLines !== meeting.lines.length) list.scrollTop = list.scrollHeight;
      lastLines = meeting.lines.length;

      tap.hidden = !(m.recording && m.run.phase === 'tap');
      const note =
        !m.recording || m.run.phase === 'tap'
          ? ''
          : m.run.phase === 'opening'
            ? 'Starting the recording…'
            : m.run.note;
      runNote.textContent = note;
      runNote.hidden = note === '';
    },
  };
}
