/**
 * The page half of the fresh-sign-in check (`packages/server/src/fresh-signin.ts`).
 *
 * A destructive or access-widening request whose sign-in is older than ten
 * minutes comes back `403 {error: "confirm-required"}` and changes nothing.
 * `sendCounted` holds it and asks "Confirm it's you"; "Sign in again" leaves
 * the page for the sign-in, so the action is kept in sessionStorage first,
 * and `resumeHeld` asks "<Verb> <name> now?" when the page loads again.
 * Cancel and "Not now" change nothing. Only the server decides what counts:
 * a request it does not refuse is answered here exactly as `fetch` answered.
 */

/** One request the server may refuse until the person signs in again. */
export interface CountedRequest {
  method: 'POST' | 'PUT' | 'DELETE';
  url: string;
  body?: unknown;
  /** The button's verb, e.g. "Archive". */
  verb: string;
  /** The verb as a subject, e.g. "Archiving". */
  gerund: string;
  /** The action as a noun, e.g. "archive". */
  noun: string;
  /** What it acts on, e.g. the doc's title. */
  name: string;
}

export interface FreshSignInDeps {
  /** Shown when the person backs out. */
  toast: (message: string) => void;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** Leaves for the sign-in. */
  leave?: (url: string) => void;
  doc?: Document;
  here?: () => string;
  now?: () => number;
}

const HELD_KEY = 'cw-held-action';
/** A held action older than this is dropped unasked: nobody is waiting on it. */
const HELD_MAX_AGE_MS = 30 * 60 * 1000;

interface HeldAction {
  request: CountedRequest;
  page: string;
  at: number;
}

const hereOf = (deps: FreshSignInDeps) => deps.here?.() ?? `${location.pathname}${location.search}`;

async function send(req: CountedRequest, deps: FreshSignInDeps): Promise<Response> {
  return (deps.fetchImpl ?? fetch)(req.url, {
    method: req.method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req.body ?? {}),
  });
}

async function isConfirmRequired(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: unknown } | null;
  return body?.error === 'confirm-required';
}

/**
 * Send it; on a stale-sign-in refusal, ask. Answers the server's response,
 * or null when the person cancelled. When they choose to sign in again the
 * page leaves and the promise never settles.
 */
export async function sendCounted(
  req: CountedRequest,
  deps: FreshSignInDeps,
): Promise<Response | null> {
  const res = await send(req, deps);
  if (!(await isConfirmRequired(res))) return res;
  const doc = deps.doc ?? document;
  for (;;) {
    const why = doc.createElement('p');
    const name = doc.createElement('b');
    name.textContent = req.name;
    why.append(
      `${req.gerund} needs a sign-in from the last 10 minutes, and no passkey is set up yet. `,
      name,
      ' stays as it is until you sign in again.',
    );
    if (!(await ask(doc, "Confirm it's you", why, 'Cancel', 'Sign in again'))) break;
    const leaving = doc.createElement('p');
    leaving.textContent = `You'll sign in again, then come back here to confirm the ${req.noun}.`;
    if (!(await ask(doc, 'Sign in again', leaving, 'Cancel', 'Go to sign-in'))) continue;
    const page = hereOf(deps);
    const held: HeldAction = { request: req, page, at: (deps.now ?? Date.now)() };
    (deps.storage ?? sessionStorage).setItem(HELD_KEY, JSON.stringify(held));
    (deps.leave ?? ((url) => location.assign(url)))(
      `/api/auth/reauth?next=${encodeURIComponent(page)}`,
    );
    return new Promise<never>(() => {});
  }
  deps.toast('Nothing changed');
  return null;
}

/**
 * The action this page held before it left to sign in, offered once more.
 * Null when there is none, it was held on another page or long ago, or the
 * person says "Not now".
 */
export async function resumeHeld(
  deps: FreshSignInDeps,
): Promise<{ request: CountedRequest; response: Response } | null> {
  const storage = deps.storage ?? sessionStorage;
  const raw = storage.getItem(HELD_KEY);
  if (raw === null) return null;
  let held: HeldAction | null = null;
  try {
    held = JSON.parse(raw) as HeldAction;
  } catch {}
  if (!held?.request || held.page !== hereOf(deps)) return null;
  storage.removeItem(HELD_KEY);
  const age = (deps.now ?? Date.now)() - held.at;
  if (!(age >= 0 && age <= HELD_MAX_AGE_MS) || !isHeldRequest(held.request)) return null;
  const req = held.request;
  const doc = deps.doc ?? document;
  const note = doc.createElement('p');
  note.textContent = `You signed in again. This is the ${req.noun} you asked for before you left.`;
  if (!(await ask(doc, `${req.verb} ${req.name} now?`, note, 'Not now', req.verb))) {
    deps.toast('Nothing changed');
    return null;
  }
  const response = await sendCounted(req, deps);
  return response ? { request: req, response } : null;
}

const METHODS: readonly unknown[] = ['POST', 'PUT', 'DELETE'];

/**
 * Whether a stored value is a request this page could have held: one of the
 * three verbs, to a same-origin path, with string words. Anything else in
 * sessionStorage was planted, and is dropped without asking.
 */
function isHeldRequest(r: CountedRequest): boolean {
  return (
    METHODS.includes(r.method) &&
    typeof r.url === 'string' &&
    /^\/(?![/\\])/.test(r.url) &&
    !/[\s\\]/.test(r.url) &&
    [r.verb, r.gerund, r.noun, r.name].every((w) => typeof w === 'string')
  );
}

/** One card in the identity prompt's frame. True for the primary button. */
function ask(
  doc: Document,
  title: string,
  body: HTMLElement,
  cancelLabel: string,
  goLabel: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const scrim = doc.createElement('div');
    scrim.className = 'identity-prompt fresh-signin-prompt';
    const card = doc.createElement('div');
    card.className = 'identity-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    const h = doc.createElement('h2');
    h.id = `fresh-signin-title-${Math.random().toString(36).slice(2)}`;
    h.textContent = title;
    card.setAttribute('aria-labelledby', h.id);
    const actions = doc.createElement('div');
    actions.className = 'identity-actions';
    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.className = 'identity-skip';
    cancel.textContent = cancelLabel;
    const go = doc.createElement('button');
    go.type = 'submit';
    go.textContent = goLabel;
    actions.append(cancel, go);
    card.append(h, body, actions);
    scrim.append(card);
    const done = (yes: boolean) => {
      doc.removeEventListener('keydown', onKey);
      scrim.remove();
      resolve(yes);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done(false);
    };
    cancel.addEventListener('click', () => done(false));
    go.addEventListener('click', () => done(true));
    doc.addEventListener('keydown', onKey);
    doc.body.append(scrim);
    go.focus();
  });
}
