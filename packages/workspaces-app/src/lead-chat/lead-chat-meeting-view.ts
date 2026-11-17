/**
 * The lead chat's meeting, as the panel draws it: one heading row — a steady
 * red dot, "Meeting", up to four faces, End meeting — and the live notes as
 * ONE line just above the typing box, which every page of the board shows
 * while the meeting runs. The line is the newest thing said (or the words
 * still being heard on the recording tab), and keeps its end in view as it
 * grows (`lead-chat-tail.ts` draws it). The whole record is the notes doc.
 * It was a box of every line under the header, which took up to 38% of the
 * panel (the owner, 13 Nov: "the raw notes take half the chat").
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
.lc-notes { flex: none; display: flex; flex-direction: column; border-top: 1px solid var(--border, #d1d5da); background: #faf8f3; }
.lc-notes-row { display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 16px; }
.lc-line { flex: 1; min-width: 0; font-size: 13.5px; line-height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lc-line b { font-weight: 600; }
.lc-line.lc-dim { color: var(--fg-muted, #57606a); }
.lc-notes-n { flex: none; font-size: 12.5px; color: var(--fg-muted, #57606a); font-variant-numeric: tabular-nums; }
.lc-tap { flex: none; margin: 4px 16px 8px; height: 40px; border: 1px solid #d1242f; border-radius: 8px; background: var(--bg, #fff); color: #d1242f; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
.lc-run-note { flex: none; margin: 0 16px 6px; font-size: 12.5px; color: var(--fg-muted, #57606a); }
`;

export interface MeetingViewModel {
  meeting: LeadChatMeeting | null;
  run: MeetingRunState;
  /** This page records the meeting. */
  recording: boolean;
  /** End meeting has been pressed and is waiting on the server. */
  ending: boolean;
  /** Lines the lead said that this page is playing, or has played. */
  playing?: number | null;
  said?: ReadonlySet<number>;
}

/** The one line of notes: who said it and what, as `lead-chat-tail.ts`
 *  draws it. `live` is words still being heard, which grow at the end. */
export interface NoteLine {
  who: string;
  text: string;
  live?: boolean;
  dim?: boolean;
  /** A line the board's lead said, and whether this page is playing it or
   *  has played it. */
  lead?: boolean;
  said?: 'playing' | 'said';
}

/** The newest thing the meeting heard: the words in progress on the tab
 *  recording, else the last line, else that nothing was said yet. */
export function newestLine(m: MeetingViewModel): NoteLine | null {
  const meeting = m.meeting;
  if (!meeting) return null;
  if (m.recording && m.run.partial) {
    return { who: 'Heard', text: m.run.partial, live: true, dim: true };
  }
  const l = meeting.lines.at(-1);
  if (!l) return { who: 'Notes', text: NOTES_EMPTY, dim: true };
  const line: NoteLine = { who: l.who, text: l.text.replace(/\s+/g, ' ') };
  if (l.lead) {
    line.lead = true;
    if (m.playing === l.turn) line.said = 'playing';
    else if (m.said?.has(l.turn)) line.said = 'said';
  }
  return line;
}

export interface MeetingView {
  /** The heading row; drawn into the panel's header while a meeting runs. */
  head: HTMLElement;
  /** The live notes: one line, just above the typing box. */
  notes: HTMLElement;
  /** The notes' one line, which the panel fills with `newestLine`. */
  line: HTMLElement;
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
  const row = el('div', 'lc-notes-row');
  const line = el('div', 'lc-line');
  line.setAttribute('role', 'log');
  line.setAttribute('aria-live', 'polite');
  const count = el('span', 'lc-notes-n');
  row.append(line, count);
  const runNote = el('p', 'lc-run-note');
  const tap = el('button', 'lc-tap', 'Tap to keep recording');
  tap.type = 'button';
  notes.append(row, runNote, tap);

  return {
    head,
    notes,
    line,
    end,
    tap,
    render(m) {
      const meeting = m.meeting;
      head.hidden = !meeting;
      notes.hidden = !meeting;
      if (!meeting) return;
      dot.classList.toggle('lc-off', m.recording && m.run.phase !== 'recording');
      faces.replaceChildren();
      for (const p of meeting.people.slice(0, FACES_SHOWN)) {
        const f = el('span', 'lc-face', initials(p.name));
        f.title = p.name;
        faces.append(f);
      }
      faces.setAttribute('aria-label', meeting.people.map((p) => p.name).join(', '));
      end.disabled = m.ending;
      // Where the notes go is the row's tooltip: the row is one line.
      row.title =
        meeting.notes === 'none' ? 'Notes: not written down' : `Notes: ${meeting.docTitle}`;
      count.textContent = linesLabel(meeting.lines.length);

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
