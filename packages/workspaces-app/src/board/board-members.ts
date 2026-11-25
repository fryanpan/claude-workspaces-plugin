/**
 * The settings subsection that says who can sign in to this board, and how
 * each person got in.
 *
 * A board's audience is a list of exact addresses and `@domain`s (Bryan, 29
 * Oct: "share a board with named emails or a whole domain, and only he can
 * change who is in"). The list draws each exact address — signed in or not
 * yet — then each domain with the people it let in indented under it. Each
 * person and each domain shows what it may do: Owner, edit, comment or view
 * (`board-member-level.ts`).
 *
 * Two readers, one list. The owner gets a level select, Remove and the Add
 * form; a member gets the names and levels as text. **The missing controls
 * are not the enforcement**: every write goes to a route that asks the server
 * who you are (`routes/workspace-members.ts`). The access page
 * (`settings/access-page.ts`) draws each board with this same module.
 */

import { accessMatchProblem, readAccessMatch } from './access-match.ts';
import {
  type BoardAudienceEntry,
  type BoardMemberEntry,
  type BoardMembersView,
  type BoardRole,
  type Row,
  accessRows,
  isDomain,
  shortDay,
} from './board-access-rows.ts';
import {
  type AccessRole,
  LEVEL_LEGEND,
  levelSelect,
  levelText,
  levelToast,
  ownerAsk,
} from './board-member-level.ts';

export { accessMatchProblem, readAccessMatch };
export type { AccessRole, BoardAudienceEntry, BoardMemberEntry, BoardMembersView, BoardRole };
export { LEVEL_LEGEND, accessRows, shortDay };

/** What a write came back with. `message` is the server's, when it said one. */
export interface AccessWriteResult {
  ok: boolean;
  /** 202: filed for the owner's approval rather than applied. */
  proposed?: boolean;
  message?: string;
}

export interface BoardMembersDeps {
  /** The container the rows are drawn into. Emptied on every repaint. */
  list: HTMLElement;
  /** The line under the label: the empty state, or why the list is not there. */
  note: HTMLElement;
  /** Read the list. `null` is a failed read, never an empty board. */
  read: () => Promise<BoardMembersView | null>;
  /** Take an address or an `@domain` out. Resolves false when refused. */
  remove: (match: string) => Promise<boolean>;
  /** Change what a person or everyone at a `@domain` may do. Absent draws
   *  each level as text, the way a member reads it. */
  setRole?: (match: string, role: AccessRole) => Promise<AccessWriteResult>;
  /** The line under the list that says what each level means. */
  legend?: HTMLElement;
  /** Let an address or an `@domain` in. Absent draws no Add form. */
  add?: (match: string) => Promise<AccessWriteResult>;
  /** The Add form (an input named `match`) and the line under it. */
  form?: HTMLFormElement;
  error?: HTMLElement;
  /** The label of the link to the access page, rewritten after each read,
   *  and where the link goes given how many changes are waiting. */
  linkLabel?: HTMLElement;
  accessHref?: (openProposals: number) => string;
  /** The label of a row at the top that names the changes waiting, shown
   *  only while some are. With it, `linkLabel` always names the page. */
  waiting?: HTMLElement;
  /** The board's one-line report. */
  toast: (message: string) => void;
  /** `board-btn` on the board, `prompt-btn` on the settings page. */
  buttonClass?: string;
  /**
   * The reader's own level, handed on after every read — `null` when the read
   * failed and nobody knows.
   *
   * THIS LIST IS THE PANEL'S ONE READING OF WHO YOU ARE. The settings panel
   * has other controls that are the Owner's, and a second fetch to learn the
   * same fact is a second answer that can disagree with this one mid-panel.
   */
  onRole?: (role: BoardRole | null) => void;
}

export interface BoardMembersHandle {
  /** Re-read and repaint. Called every time the panel opens. */
  refresh(): Promise<void>;
  /**
   * Re-read because access changed elsewhere. A removal the reader is
   * confirming stays up while its row is still listed, and a write in
   * flight is left to repaint on its own.
   */
  changed(): Promise<void>;
  /** Paint a view somebody else read (the access page reads every board at once). */
  show(view: BoardMembersView | null): void;
  /** Resolves when any in-flight write has finished. Tests await it. */
  settled(): Promise<void>;
}

/**
 * What an applied add still needs. The board admits the person from their
 * next request, but a server behind Cloudflare Access lets nobody reach it
 * whom the Access policy does not name, and that policy is Terraform's.
 */
export function cloudflareStep(match: string): string {
  return `One more step if this board is behind Cloudflare Access: add ${match} to its Access policy, or they are stopped at sign-in.`;
}

/** Bryan's words for the two levels, and the only place they are spelled. */
export function roleLabel(role: BoardRole): string {
  return role === 'owner' ? 'Owner' : 'Regular User';
}

/** What a write's reply means for the Add form. */
export function accessWriteOf(res: {
  ok: boolean;
  status?: number;
  data?: Record<string, unknown> | null;
}): AccessWriteResult {
  if (res.ok) return res.status === 202 ? { ok: true, proposed: true } : { ok: true };
  // An add from a browser that proved nobody is refused as if it were an
  // agent's call, and that reply is written for an agent.
  if (res.data?.error === 'task-required') {
    return { ok: false, message: 'Only the board’s owner, signed in, can let someone new in.' };
  }
  const message = res.data?.message ?? res.data?.error;
  return typeof message === 'string' ? { ok: false, message } : { ok: false };
}

/** The link's words: the board's waiting changes, or the page itself. */
export function accessLinkLabel(openProposals: number): string {
  if (openProposals <= 0) return 'Everyone with access, on every board';
  return openProposals === 1
    ? '1 change an agent proposed for this board'
    : `${openProposals} changes an agent proposed for this board`;
}

export function mountBoardMembers(deps: BoardMembersDeps): BoardMembersHandle {
  const doc = deps.list.ownerDocument;
  const btnClass = deps.buttonClass ?? 'board-btn';
  let inFlight: Promise<void> | null = null;
  let view: BoardMembersView | null = null;
  /** The row currently asking "are you sure" — one at a time, cleared by any
   *  repaint. Held here rather than in the DOM so a re-read wipes it. */
  let confirming: string | null = null;
  /** The row asking "make them an Owner?" — the one level that hands over
   *  the board, so it is asked in the row first, like a removal. */
  let promoting: string | null = null;
  /** The row whose button takes focus after the next paint, so a keyboard or
   *  screen-reader user stays where they were rather than back at the top. */
  let focusAfter: string | null = null;
  /** Back on the level control rather than Remove: the reader was choosing a level. */
  let focusLevel = false;

  /**
   * Repaint on a LATER TURN, never inside the click that asked for it.
   *
   * `paint` replaces every row, so painting from a click handler detaches the
   * button the event is still travelling up from. The settings panel reads
   * "outside" off the tree as it is by the time the event reaches `document`,
   * so a synchronous repaint here once closed the whole panel on the tap that
   * opened this confirmation.
   */
  function repaintSoon(): void {
    setTimeout(paint, 0);
  }

  function el(tag: string, cls: string, text?: string): HTMLElement {
    const e = doc.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function button(label: string, extra: string): HTMLButtonElement {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = `${btnClass} ${extra}`;
    b.textContent = label;
    return b;
  }

  /** The confirmation, in the row rather than in a dialog. It names who is
   *  about to lose access, and for a domain how many people go with it. */
  function confirmRow(row: Row, match: string): HTMLElement {
    const out = el('div', `board-member board-member--confirm${row.under ? ' acc-under' : ''}`);
    out.dataset.key = row.key;
    out.appendChild(el('span', 'board-member-who', row.ask));
    const go = button('Remove', 'board-member-remove');
    go.addEventListener('click', () => {
      run(async () => {
        const ok = await deps.remove(match);
        confirming = null;
        // The row is gone, so focus moves to the one that took its place.
        focusAfter = nextKey(row.key);
        await refresh();
        deps.toast(ok ? `${match} no longer has access` : 'Could not remove that');
      });
    });
    const cancel = button('Cancel', 'board-member-cancel');
    cancel.addEventListener('click', () => {
      confirming = null;
      focusAfter = row.key;
      repaintSoon();
    });
    out.appendChild(go);
    out.appendChild(cancel);
    return out;
  }

  /** Change a level and say what it did, in the list's own words. */
  function setLevel(row: Row, match: string, next: AccessRole): void {
    const setRole = deps.setRole;
    if (!setRole || inFlight) return;
    // Every select waits while one level is written (`levelSelect`).
    for (const s of deps.list.querySelectorAll<HTMLSelectElement>('.board-member-level')) {
      s.disabled = true;
    }
    const who = isDomain(match) ? `Everyone at ${match}` : match;
    const before = row.level ?? 'edit';
    run(async () => {
      const res = await setRole(match, next);
      promoting = null;
      focusAfter = row.key;
      focusLevel = true;
      await refresh();
      if (!res.ok) deps.toast(res.message ?? `Could not change what ${who} can do`);
      else if (res.proposed) deps.toast(`Filed ${match} as an Owner for the owner’s approval`);
      else deps.toast(levelToast(who, before, next));
    });
  }

  function promoteRow(row: Row, match: string): HTMLElement {
    const out = el('div', `board-member board-member--confirm${row.under ? ' acc-under' : ''}`);
    out.dataset.key = row.key;
    out.appendChild(el('span', 'board-member-who', ownerAsk(match)));
    const go = button('Make Owner', 'board-member-promote');
    go.addEventListener('click', () => setLevel(row, match, 'owner'));
    const cancel = button('Cancel', 'board-member-cancel');
    const back = (): void => {
      promoting = null;
      focusAfter = row.key;
      focusLevel = true;
      repaintSoon();
    };
    cancel.addEventListener('click', back);
    // Escape is Cancel, so it never leaves focus on whatever came next.
    out.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      back();
    });
    out.appendChild(go);
    out.appendChild(cancel);
    return out;
  }

  function levelControl(row: Row, canEdit: boolean): HTMLElement | null {
    if (!row.level) return null;
    const match = row.setRole;
    if (!canEdit || !deps.setRole || !match) return levelText(doc, row.level);
    const domain = isDomain(match);
    return levelSelect(doc, {
      current: row.level,
      noOwner: row.seatless === true,
      aria: domain ? `What everyone at ${match} can do` : `What ${match} can do`,
      onPick: (next) => {
        if (next !== 'owner') {
          setLevel(row, match, next);
          return;
        }
        promoting = row.key;
        focusAfter = row.key;
        repaintSoon();
      },
    });
  }

  function drawRow(row: Row, canEdit: boolean): HTMLElement {
    if (confirming === row.key && row.remove) return confirmRow(row, row.remove);
    if (promoting === row.key && row.setRole) return promoteRow(row, row.setRole);
    const out = el('div', `board-member${row.under ? ' acc-under' : ''}`);
    out.dataset.key = row.key;
    const who = el('span', 'acc-who');
    who.appendChild(el('span', 'board-member-who', row.title));
    if (row.meta) who.appendChild(el('span', 'acc-via', row.meta));
    out.appendChild(who);
    const level = levelControl(row, canEdit);
    if (level) out.appendChild(level);
    else if (row.role) out.appendChild(el('span', 'board-member-role-text', roleLabel(row.role)));
    if (canEdit && row.remove) {
      const remove = button('Remove', 'board-member-remove');
      remove.setAttribute('aria-label', `Remove ${row.remove}`);
      remove.addEventListener('click', () => {
        confirming = row.key;
        focusAfter = row.key;
        repaintSoon();
      });
      out.appendChild(remove);
    } else if (canEdit && level) out.appendChild(removeGap());
    return out;
  }

  /** Where Remove would be, on a row with none (your own), so its level
   *  lines up with the level column above and below it. */
  function removeGap(): HTMLButtonElement {
    const gap = button('Remove', 'board-member-remove-gap');
    gap.disabled = true;
    gap.tabIndex = -1;
    gap.setAttribute('aria-hidden', 'true');
    return gap;
  }

  /** The key of the row after `key`, or the one before it when it was last. */
  function nextKey(key: string): string | null {
    const keys = view ? accessRows(view).map((r) => r.key) : [];
    const i = keys.indexOf(key);
    return keys[i + 1] ?? keys[i - 1] ?? null;
  }

  /** Put focus back on the row it belongs to: Cancel while confirming (never
   *  the Remove that would act on Enter), the row's Remove otherwise. */
  function restoreFocus(): void {
    const key = focusAfter;
    const toLevel = focusLevel;
    focusAfter = null;
    focusLevel = false;
    if (key === null) return;
    const row = Array.from(deps.list.querySelectorAll<HTMLElement>('[data-key]')).find(
      (r) => r.dataset.key === key,
    );
    const target =
      row?.querySelector<HTMLElement>('.board-member-cancel') ??
      (toLevel ? row?.querySelector<HTMLElement>('.board-member-level') : null) ??
      row?.querySelector<HTMLElement>('.board-member-remove') ??
      (deps.form?.elements.namedItem('match') as HTMLElement | null);
    target?.focus();
  }

  function paint(): void {
    while (deps.list.firstChild) deps.list.removeChild(deps.list.firstChild);
    deps.form?.classList.toggle('hidden', view?.you.role !== 'owner' || !deps.add);
    const waiting = view?.openProposals ?? 0;
    if (deps.waiting) {
      deps.waiting.textContent = accessLinkLabel(waiting);
      const a = deps.waiting.closest('a');
      a?.classList.toggle('hidden', waiting <= 0 || view?.you.role !== 'owner');
      if (a && deps.accessHref) a.href = deps.accessHref(waiting);
    }
    if (deps.linkLabel) {
      const shown = deps.waiting ? 0 : waiting;
      deps.linkLabel.textContent = accessLinkLabel(shown);
      const a = deps.linkLabel.closest('a');
      if (a && deps.accessHref) a.href = deps.accessHref(shown);
    }
    if (!view) {
      deps.note.textContent = 'Could not read who has access — reopen this page to try again.';
      return;
    }
    const canEdit = view.you.role === 'owner';
    // The owner holds no membership record — a board is owned by whoever
    // holds the machine it was made on — so their seat is drawn from `you`,
    // whether or not their browser proved an address.
    const yours = view.you.email;
    if (yours === null || !view.members.some((m) => m.email === yours)) {
      const you = el('div', 'board-member');
      you.appendChild(el('span', 'board-member-who', 'You'));
      you.appendChild(
        view.you.accessRole
          ? levelText(doc, view.you.accessRole)
          : el('span', 'board-member-role-text', roleLabel(view.you.role)),
      );
      if (canEdit && view.you.accessRole) you.appendChild(removeGap());
      deps.list.appendChild(you);
    }
    const rows = accessRows(view);
    for (const row of rows) deps.list.appendChild(drawRow(row, canEdit));
    if (deps.legend) {
      deps.legend.textContent = LEVEL_LEGEND;
      deps.legend.classList.toggle('hidden', !rows.some((r) => r.level));
    }
    deps.note.textContent =
      rows.length === 0
        ? 'Nobody else has been given access yet.'
        : 'Who can sign in to this board.';
    restoreFocus();
  }

  async function refresh(): Promise<void> {
    show(await deps.read());
  }

  function show(next: BoardMembersView | null): void {
    view = next;
    confirming = null;
    promoting = null;
    // Before the paint, so the panel's other controls settle on the same turn
    // this list does rather than one behind it.
    deps.onRole?.(view ? view.you.role : null);
    paint();
  }

  async function changed(): Promise<void> {
    if (inFlight) return;
    const keep = confirming;
    view = await deps.read();
    const listed = (key: string | null) =>
      key && view && accessRows(view).some((r) => r.key === key) ? key : null;
    confirming = listed(keep);
    // Made an Owner somewhere else meanwhile: nothing left to ask.
    const asked = listed(promoting);
    promoting =
      asked && view && accessRows(view).find((r) => r.key === asked)?.level !== 'owner'
        ? asked
        : null;
    deps.onRole?.(view ? view.you.role : null);
    paint();
  }

  function run(work: () => Promise<void>): void {
    inFlight = work().finally(() => {
      inFlight = null;
    });
  }

  const { form, error, add } = deps;
  if (form && add) {
    const input = form.elements.namedItem('match') as HTMLInputElement | null;
    /** A whole domain waiting for its second press: it lets in people nobody named. */
    let domainAsked: string | null = null;
    const say = (text: string, invalid = false) => {
      if (error) {
        error.textContent = text;
        error.classList.toggle('acc-ask', text !== '' && !invalid);
      }
      if (input) {
        if (invalid) input.setAttribute('aria-invalid', 'true');
        else input.removeAttribute('aria-invalid');
        if (error?.id) input.setAttribute('aria-describedby', error.id);
      }
    };
    input?.addEventListener('input', () => {
      domainAsked = null;
      say('');
    });
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const raw = input?.value ?? '';
      const match = readAccessMatch(raw);
      if (!match) {
        say(accessMatchProblem(raw), true);
        return;
      }
      if (view?.audience?.some((e) => e.match === match)) {
        say(`${match} is already on this board.`, true);
        return;
      }
      if (isDomain(match) && domainAsked !== match) {
        domainAsked = match;
        say(`This lets anyone with an ${match} address sign in. Press Add again to confirm.`);
        return;
      }
      domainAsked = null;
      say('');
      run(async () => {
        const res = await add(match);
        if (!res.ok) {
          say(res.message ?? `Could not add ${match}.`, true);
          return;
        }
        form.reset();
        await refresh();
        deps.toast(
          res.proposed ? `Filed ${match} for the owner’s approval` : `${match} can now sign in`,
        );
        // Kept under the form, not only toasted: the board lets them in now,
        // but Cloudflare Access is a separate gate kept by Terraform, and
        // nothing here changes it.
        if (!res.proposed) say(cloudflareStep(match));
      });
    });
  }

  return {
    refresh,
    changed,
    show,
    settled: async () => {
      await inFlight;
    },
  };
}
