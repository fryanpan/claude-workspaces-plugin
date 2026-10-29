/**
 * `GET /sharing-off`: the sharing notice on a page of its own, for the owner
 * away from this machine while the master switch is off.
 *
 * Off refuses the board itself on the owner's hostname, so the card on the
 * queue cannot be reached there. This page and the card's access door are the
 * two requests that hostname still takes (`sharing-off-door.ts`). It shows
 * what the card says and posts the card's own Approve to the access door,
 * which asks the owner's person proof from this server's own page like every
 * access card. Rendered on the server, one nonce'd script, never framed.
 *
 * Called from `routes/access.ts`, the owner's other page about who can reach
 * the boards, and refused to a share or collaboration visitor there.
 */
import { randomBytes } from 'node:crypto';

/** What the page reads, built in server.ts. */
export interface SharingOffView {
  enabled: boolean;
  /** The open card, while there is one. */
  card?: { path: string; change: unknown; headline: string; detail: string };
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The card's detail as paragraphs and a list, every value escaped. */
function detailHtml(detail: string): string {
  return detail
    .split('\n\n')
    .map((block) => {
      const lines = block.split('\n');
      if (lines.every((l) => l.startsWith('- '))) {
        return `<ul>${lines.map((l) => `<li>${esc(l.slice(2)).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</li>`).join('')}</ul>`;
      }
      return `<p>${esc(block)}</p>`;
    })
    .join('');
}

const SCRIPT = `
const btn = document.getElementById('on');
const say = (t) => { document.getElementById('status').textContent = t; };
btn.addEventListener('click', async () => {
  btn.disabled = true;
  say('Turning sharing back on…');
  const r = await fetch(btn.dataset.path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approve', access: JSON.parse(btn.dataset.change) }),
  }).catch(() => null);
  const body = r ? await r.json().catch(() => ({})) : {};
  if (r && r.ok) { say('Sharing is back on.'); document.getElementById('home').hidden = false; return; }
  btn.disabled = false;
  say(body.message || 'It could not be turned on. Reload and try again.');
});`;

export function renderSharingOffPage(view: SharingOffView): {
  html: string;
  headers: Record<string, string>;
} {
  const nonce = randomBytes(16).toString('base64');
  const home = '<p id="home"><a href="/">Open your boards</a></p>';
  let body: string;
  let script = '';
  if (view.enabled) {
    body = `<h1>Sharing is on</h1>${home}`;
  } else if (view.card) {
    const { card } = view;
    body = `<h1>${esc(card.headline)}</h1>${detailHtml(card.detail)}
<p><button id="on" type="button" data-path="${esc(card.path)}" data-change="${esc(JSON.stringify(card.change))}">Turn back on</button></p>
<p id="status" role="status"></p>${home.replace('<p id="home">', '<p id="home" hidden>')}`;
    script = `<script nonce="${nonce}">${SCRIPT}</script>`;
  } else {
    body =
      '<h1>Sharing is off</h1><p>No notice is open to turn it back on from here. Turn it on from this machine.</p>';
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sharing</title>
<style nonce="${nonce}">
body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#1d1d1f}
button{font:inherit;padding:.6rem 1.2rem;border-radius:8px;border:1px solid #0a66d8;background:#0a66d8;color:#fff;min-width:11rem;min-height:44px}
#status{min-height:1.5em}
</style></head><body>${body}${script}</body></html>`;
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
