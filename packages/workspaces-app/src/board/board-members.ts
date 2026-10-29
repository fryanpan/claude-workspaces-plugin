/**
 * The settings subsection that says who can sign in to this board, and how
 * each person got in.
 *
 * A board's audience is a list of exact addresses and `@domain`s (Bryan, 29
 * Oct: "share a board with named emails or a whole domain, and only he can
 * change who is in"). The list draws each exact address — signed in or not
 * yet — then each domain with the people it let in indented under it. There
 * are no levels: every member's comment directs the agent the same way.
 *
 * Two readers, one list. The owner gets Remove on every row and the Add form;
 * a member gets the same names with no controls at all. **The missing controls
 * are not the enforcement**: every write goes to a route that asks the server
 * who you are (`routes/workspace-members.ts`), and an add from anything but
 * the owner's own signed-in browser becomes a proposal rather than a change.
 *
 * The access page (`settings/access-page.ts`) draws each board with this same
 * module, so the two cannot drift into two designs of one list.
 */

/** The two levels a board has. Wire values; `roleLabel` is what a person sees. */
export type BoardRole = 'owner' | 'member';

export interface BoardMemberEntry {
  email: string;
  role: BoardRole;
  /** When they first signed in. */
  addedAt?: number;
  /** The audience entry that admits them: their own address or an `@domain`. */
  entry?: string;
  /** The label of the link they came through, when it had one. */
  link?: string;
}

/** One line of the board's audience. */
export interface BoardAudienceEntry {
  match: string;
  addedAt: number;
  addedBy?: string;
}

/** What `GET /workspaces/<id>/members` answers, narrowed to what is drawn. */
export interface BoardMembersView {
  /** The reader. `email: null` is the operator on their own machine — an owner
   *  with no address, because none was ever proven and none is needed. */
  you: { email: string | null; role: BoardRole };
  members: BoardMemberEntry[];
  audience?: BoardAudienceEntry[];
  /** Access changes an agent proposed for this board, still unanswered. */
  openProposals?: number;
}

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
  /** Let an address or an `@domain` in. Absent draws no Add form. */
  add?: (match: string) => Promise<AccessWriteResult>;
  /** The Add form (an input named `match`) and the line under it. */
  form?: HTMLFormElement;
  error?: HTMLElement;
  /** The label of the link to the access page, rewritten after each read,
   *  and where the link goes given how many changes are waiting. */
  linkLabel?: HTMLElement;
  accessHref?: (openProposals: number) => string;
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

/** Bryan's words for the two levels, and the only place they are spelled. */
export function roleLabel(role: BoardRole): string {
  return role === 'owner' ? 'Owner' : 'Regular User';
}

const isDomain = (match: string): boolean => match.startsWith('@');

/** "9 Oct": the day is what a reader checks, never the time. */
export function shortDay(ts: number | undefined): string {
  if (ts === undefined || !Number.isFinite(ts)) return '';
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** A typed address or `@domain`, lower-cased, or null for anything else. */
export function readAccessMatch(raw: string): string | null {
  const m = raw.trim().toLowerCase();
  if (/^@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(m)) return m;
  if (/^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(m)) return m;
  return null;
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

/** One row the list draws: who, how they got in, and what Remove takes out. */
interface Row {
  key: string;
  title: string;
  meta: string;
  role?: BoardRole;
  under: boolean;
  /** What Remove sends; absent on a row with no control (your own). */
  remove?: string;
  ask: string;
}

function signedIn(m: BoardMemberEntry): string {
  const day = shortDay(m.addedAt);
  const when = day ? `Signed in ${day}` : 'Signed in';
  return m.link ? `${when} via link “${m.link}”` : when;
}

/** The rows in the order the mock draws them. */
export function accessRows(view: BoardMembersView): Row[] {
  const audience = view.audience ?? [];
  const yours = view.you.email;
  const rows: Row[] = [];
  const person = (m: BoardMemberEntry, under: boolean, meta: string, ask: string): Row => ({
    key: m.email,
    title: m.email === yours ? `${m.email} (you)` : m.email,
    meta,
    under,
    ask,
    ...(m.role === 'owner' ? { role: m.role } : {}),
    ...(m.email === yours ? {} : { remove: m.email }),
  });
  const listed = new Set<string>();
  for (const e of audience.filter((x) => !isDomain(x.match))) {
    const m = view.members.find((p) => p.email === e.match);
    listed.add(e.match);
    if (m) {
      rows.push(person(m, false, signedIn(m), `Remove ${m.email}?`));
    } else {
      rows.push({
        key: e.match,
        title: e.match,
        meta: `Added ${shortDay(e.addedAt)} · not signed in yet`,
        under: false,
        remove: e.match,
        ask: `Remove ${e.match}?`,
      });
    }
  }
  // A member the audience names no entry for: a board read before audiences
  // existed. Drawn as its own row, so nobody who can get in goes unlisted.
  for (const m of view.members) {
    if (listed.has(m.email) || (m.entry && isDomain(m.entry))) continue;
    listed.add(m.email);
    rows.push(person(m, false, m.addedAt ? signedIn(m) : '', `Remove ${m.email}?`));
  }
  for (const e of audience.filter((x) => isDomain(x.match))) {
    const under = view.members.filter((m) => m.entry === e.match);
    const n = under.length;
    const count =
      n === 0 ? 'nobody signed in yet' : n === 1 ? '1 person signed in' : `${n} people signed in`;
    const losing =
      n === 0 ? '' : ` ${n} signed-in ${n === 1 ? 'person loses' : 'people lose'} access.`;
    rows.push({
      key: e.match,
      title: `Everyone at ${e.match}`,
      meta: `Added ${shortDay(e.addedAt)} · ${count}`,
      under: false,
      remove: e.match,
      ask: `Stop letting in everyone at ${e.match}?${losing}`,
    });
    for (const m of under) {
      rows.push(
        person(m, true, signedIn(m), `Remove ${m.email}? ${e.match} will not let them back in.`),
      );
    }
  }
  return rows;
}

export function mountBoardMembers(deps: BoardMembersDeps): BoardMembersHandle {
  const doc = deps.list.ownerDocument;
  const btnClass = deps.buttonClass ?? 'board-btn';
  let inFlight: Promise<void> | null = null;
  let view: BoardMembersView | null = null;
  /** The row currently asking "are you sure" — one at a time, cleared by any
   *  repaint. Held here rather than in the DOM so a re-read wipes it. */
  let confirming: string | null = null;

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
    out.appendChild(el('span', 'board-member-who', row.ask));
    const go = button('Remove', 'board-member-remove');
    go.addEventListener('click', () => {
      run(async () => {
        const ok = await deps.remove(match);
        confirming = null;
        await refresh();
        deps.toast(ok ? `${match} no longer has access` : 'Could not remove that');
      });
    });
    const cancel = button('Cancel', 'board-member-cancel');
    cancel.addEventListener('click', () => {
      confirming = null;
      repaintSoon();
    });
    out.appendChild(go);
    out.appendChild(cancel);
    return out;
  }

  function drawRow(row: Row, canEdit: boolean): HTMLElement {
    if (confirming === row.key && row.remove) return confirmRow(row, row.remove);
    const out = el('div', `board-member${row.under ? ' acc-under' : ''}`);
    const who = el('span', 'acc-who');
    who.appendChild(el('span', 'board-member-who', row.title));
    if (row.meta) who.appendChild(el('span', 'acc-via', row.meta));
    out.appendChild(who);
    if (row.role) out.appendChild(el('span', 'board-member-role-text', roleLabel(row.role)));
    if (canEdit && row.remove) {
      const remove = button('Remove', 'board-member-remove');
      remove.setAttribute('aria-label', `Remove ${row.remove}`);
      remove.addEventListener('click', () => {
        confirming = row.key;
        repaintSoon();
      });
      out.appendChild(remove);
    }
    return out;
  }

  function paint(): void {
    while (deps.list.firstChild) deps.list.removeChild(deps.list.firstChild);
    deps.form?.classList.toggle('hidden', view?.you.role !== 'owner' || !deps.add);
    if (deps.linkLabel) {
      const waiting = view?.openProposals ?? 0;
      deps.linkLabel.textContent = accessLinkLabel(waiting);
      const a = deps.linkLabel.closest('a');
      if (a && deps.accessHref) a.href = deps.accessHref(waiting);
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
      you.appendChild(el('span', 'board-member-role-text', roleLabel(view.you.role)));
      deps.list.appendChild(you);
    }
    const rows = accessRows(view);
    for (const row of rows) deps.list.appendChild(drawRow(row, canEdit));
    deps.note.textContent =
      rows.length === 0
        ? 'Nobody else has been given access yet.'
        : 'Who can sign in to this board.';
  }

  async function refresh(): Promise<void> {
    show(await deps.read());
  }

  function show(next: BoardMembersView | null): void {
    view = next;
    confirming = null;
    // Before the paint, so the panel's other controls settle on the same turn
    // this list does rather than one behind it.
    deps.onRole?.(view ? view.you.role : null);
    paint();
  }

  async function changed(): Promise<void> {
    if (inFlight) return;
    const keep = confirming;
    view = await deps.read();
    confirming = keep && view && accessRows(view).some((r) => r.key === keep) ? keep : null;
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
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const input = form.elements.namedItem('match') as HTMLInputElement | null;
      const match = readAccessMatch(input?.value ?? '');
      const say = (text: string) => {
        if (error) error.textContent = text;
      };
      if (!match) {
        say('Type a full address (name@company.com) or a domain starting with @.');
        return;
      }
      if (view?.audience?.some((e) => e.match === match)) {
        say(`${match} is already on this board.`);
        return;
      }
      say('');
      run(async () => {
        const res = await add(match);
        if (!res.ok) {
          say(res.message ?? `Could not add ${match}.`);
          return;
        }
        form.reset();
        await refresh();
        deps.toast(
          res.proposed ? `Filed ${match} for the owner’s approval` : `${match} can now sign in`,
        );
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
