/**
 * The keeper's three pages: the list of waiting requests, one request's
 * approval page, and the passkey enrollment page.
 *
 * Every value that came from a requester is escaped, and the page's own
 * script runs under a nonce with every other source refused. The pages may
 * not be framed, so no other page can lay a button over "Approve".
 */
import { randomBytes } from 'node:crypto';
import type { HoldKind } from './keeper-policy.ts';
import { type HeldRequest, secretNames } from './keeper-requests.ts';

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const WHAT: Record<HoldKind, string> = {
  'project.create':
    'Creates a new Fly app. Approving also lets the rest of this project’s setup run on it for 30 minutes without another tap: volumes, secrets, the image and a shell.',
  'token.move':
    'Puts a secret on a machine, or opens a shell on it as root. A shell can read and change every secret the machine holds.',
  'access.open':
    'Creates a Cloudflare Access application. Approving also lets its policy, which says who may sign in, be written in the next 10 minutes.',
  other: 'A change the keeper does not run without you.',
};

/** Shared helpers for the two ceremony scripts. */
const B64 = `
const b2u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
const u2b = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const say = (t) => { document.getElementById('status').textContent = t; };
const post = async (path, body) => {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
};`;

export interface Page {
  html: string;
  headers: Record<string, string>;
}

function page(title: string, body: string, script = ''): Page {
  const nonce = randomBytes(16).toString('base64');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">
body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#1d1d1f}
pre{white-space:pre-wrap;word-break:break-all;background:#f5f5f7;padding:.75rem;border-radius:6px}
button{font:inherit;padding:.6rem 1.2rem;border-radius:8px;border:1px solid #888;margin-right:.5rem;min-width:11rem}
#approve,#enroll{background:#0a66d8;color:#fff;border-color:#0a66d8}
dt{font-weight:600}dd{margin:0 0 .5rem 0}
#status{min-height:1.5em}
</style></head><body>${body}${script ? `<script nonce="${nonce}">${B64}\n${script}</script>` : ''}</body></html>`;
  return {
    html,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      'x-frame-options': 'DENY',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  };
}

export function indexPage(pending: readonly HeldRequest[]): Page {
  const rows = pending.length
    ? `<ul>${pending
        .map(
          (r) =>
            `<li><a href="/approve/${encodeURIComponent(r.id)}">${escapeHtml(r.hold)}: ${escapeHtml(r.summary.slice(0, 160))}</a></li>`,
        )
        .join('')}</ul>`
    : '<p>Nothing is waiting.</p>';
  return page('Keeper', `<h1>Waiting for your passkey</h1>${rows}`);
}

/** `pageToken` names this one served page; its challenge is its own. */
export function approvePage(r: HeldRequest, pageToken: string | null): Page {
  const details: string[] = [
    `<dt>What</dt><dd>${escapeHtml(WHAT[r.hold])}</dd>`,
    `<dt>Asked by (as the caller says)</dt><dd>${escapeHtml(r.requester || 'an unnamed caller')}</dd>`,
    `<dt>Asked at</dt><dd>${escapeHtml(new Date(r.createdAt).toISOString())}</dd>`,
  ];
  if (r.app) details.push(`<dt>App</dt><dd>${escapeHtml(r.app)}</dd>`);
  if (r.call.type === 'fly') {
    const names = secretNames(r.call.input);
    if (names.length)
      details.push(`<dt>Secrets it sets</dt><dd>${escapeHtml(names.join(', '))}</dd>`);
    for (const l of r.local ?? []) {
      const inside = l.entries.length ? `<pre>${escapeHtml(l.entries.join('\n'))}</pre>` : '';
      details.push(
        `<dt>Local path it reads</dt><dd><code>${escapeHtml(l.path)}</code>${inside}</dd>`,
      );
    }
  } else if (r.call.body) {
    details.push(`<dt>Body</dt><dd><pre>${escapeHtml(r.call.body.slice(0, 4000))}</pre></dd>`);
  }
  const state =
    r.status === 'pending' && pageToken
      ? `<p><button id="approve" type="button">Approve with passkey</button><button id="deny" type="button">Deny</button></p>`
      : r.status === 'pending'
        ? '<p>Too many pages are open on this request. Use the one you opened first.</p>'
        : `<p>This request is ${escapeHtml(r.status)}.</p>`;
  const body = `<h1>Approve ${escapeHtml(r.hold)}?</h1>
<pre id="summary">${escapeHtml(r.summary)}</pre>
<dl>${details.join('')}</dl>${state}<p id="status" role="status"></p>`;
  const script = `
const id = ${JSON.stringify(r.id)};
const pageToken = ${JSON.stringify(pageToken ?? '')};
const base = '/v1/requests/' + encodeURIComponent(id);
const buttons = () => ['approve', 'deny'].map((b) => document.getElementById(b));
// Approving and denying are both a passkey tap on this page's own challenge.
const tap = async () => {
  const c = await post(base + '/challenge', { page: pageToken });
  const cred = await navigator.credentials.get({ publicKey: {
    challenge: u2b(c.challenge), rpId: c.rpId, timeout: 120000, userVerification: 'required',
    allowCredentials: c.allow.map((p) => ({ type: 'public-key', id: u2b(p) })) } });
  const a = cred.response;
  return { page: pageToken, credentialId: b2u(cred.rawId), clientDataJSON: b2u(a.clientDataJSON),
    authenticatorData: b2u(a.authenticatorData), signature: b2u(a.signature) };
};
document.getElementById('approve')?.addEventListener('click', async () => {
  try {
    say('Waiting for your passkey…');
    const done = await post(base + '/approve', await tap());
    say('Approved. ' + (done.error ? 'The command failed: ' + done.error : 'It ran with exit ' + done.status + '.'));
    for (const b of buttons()) b.disabled = true;
  } catch (e) { say('Not approved: ' + e.message); }
});
document.getElementById('deny')?.addEventListener('click', async () => {
  try {
    say('Waiting for your passkey…');
    await post(base + '/deny', await tap());
    say('Denied.');
    for (const b of buttons()) b.disabled = true;
  } catch (e) { say('Not denied: ' + e.message); }
});`;
  return page(`Approve ${r.hold}`, body, r.status === 'pending' && pageToken ? script : '');
}

export function enrollPage(): Page {
  const body = `<h1>Register your passkey</h1>
<p>This link came from <code>keeper-bin.ts enroll</code>, which needs your admin password. It works once.</p>
<p><button id="enroll" type="button">Register passkey</button></p><p id="status" role="status"></p>`;
  const script = `
document.getElementById('enroll').addEventListener('click', async () => {
  try {
    const token = location.hash.slice(1);
    if (!token) throw new Error('this link carries no enrollment token');
    const o = await post('/v1/enroll/options', { token });
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: u2b(o.challenge), rp: { id: o.rpId, name: 'Claude Workspaces keeper' },
      user: { id: u2b(o.userId), name: 'owner', displayName: 'Owner' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], attestation: 'none', timeout: 120000,
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' } } });
    await post('/v1/enroll', { session: o.session, clientDataJSON: b2u(cred.response.clientDataJSON),
      attestationObject: b2u(cred.response.attestationObject) });
    say('Registered.');
    document.getElementById('enroll').disabled = true;
  } catch (e) { say('Not registered: ' + e.message); }
});`;
  return page('Register a passkey', body, script);
}
