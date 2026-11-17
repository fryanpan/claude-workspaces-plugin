/**
 * The sign-in page at `/`: password, magic link and Google, through the
 * template's API (`templates/signin/README.md`, "What the front end does").
 * One file, no build step, no dependency: the Turnstile script is the only
 * thing loaded from elsewhere.
 */

const escapeAttr = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function signInPage(turnstileSiteKey: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; background: #f6f6f4; color: #1d1d1b; }
  main { width: min(360px, calc(100vw - 32px)); }
  h1 { font-size: 22px; margin: 0 0 16px; }
  label { display: block; font-size: 14px; margin-top: 12px; }
  input { box-sizing: border-box; width: 100%; padding: 10px; font: inherit; border: 1px solid #c8c8c2; border-radius: 6px; }
  button { box-sizing: border-box; width: 100%; padding: 10px; margin-top: 10px; font: inherit; border-radius: 6px; border: 1px solid #1d1d1b; background: #fff; cursor: pointer; }
  button.primary { background: #1d1d1b; color: #fff; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .or { text-align: center; color: #6b6b66; margin: 16px 0 4px; font-size: 14px; }
  #status { min-height: 1.5em; margin-top: 12px; font-size: 14px; }
  .cf-turnstile { margin-top: 12px; min-height: 65px; }
  [hidden] { display: none; }
</style>
</head>
<body>
<main>
  <section id="signed-in" hidden>
    <h1>Signed in</h1>
    <p>You are signed in as <strong id="who"></strong>.</p>
    <button id="sign-out">Sign out</button>
  </section>
  <section id="signed-out">
    <h1>Sign in</h1>
    <form id="form">
      <label for="email">Email</label>
      <input id="email" type="email" autocomplete="email" required>
      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="current-password" minlength="8">
      <div class="cf-turnstile" data-sitekey="${escapeAttr(turnstileSiteKey)}"></div>
      <div class="row">
        <button class="primary" type="submit" data-action="sign-in">Sign in</button>
        <button type="submit" data-action="sign-up">Create account</button>
      </div>
      <button type="submit" data-action="magic-link">Email me a sign-in link</button>
    </form>
    <p class="or">or</p>
    <button id="google">Continue with Google</button>
  </section>
  <p id="status" role="status"></p>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const say = (text) => { $('status').textContent = text; };
  const post = (path, body, captcha) => fetch('/api/auth' + path, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, captcha ? { 'x-captcha-response': captcha } : {}),
    body: JSON.stringify(body),
  });
  const MESSAGES = {
    'sign-in': { 401: 'Wrong email or password.', 403: 'Verify your email first: we sent you a link.' },
    'sign-up': { 422: 'That email already has an account. Sign in instead.' },
  };
  const explain = (action, res) => {
    if (res.status === 429) return 'Too many attempts. Try again later.';
    if (res.status === 400) return 'Complete the check above, then try again.';
    return (MESSAGES[action] || {})[res.status] || 'That did not work (' + res.status + ').';
  };

  fetch('/api/auth/get-session').then((r) => r.json()).then((s) => {
    if (s && s.user) {
      $('who').textContent = s.user.email;
      $('signed-in').hidden = false;
      $('signed-out').hidden = true;
    }
  }).catch(() => {});

  $('sign-out').addEventListener('click', async () => {
    await post('/sign-out', {});
    location.reload();
  });

  $('google').addEventListener('click', async () => {
    say('');
    const res = await post('/sign-in/social', { provider: 'google', callbackURL: '/' });
    const body = await res.json().catch(() => null);
    if (res.ok && body && body.url) location.href = body.url;
    else say(explain('google', res));
  });

  $('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const action = event.submitter ? event.submitter.dataset.action : 'sign-in';
    const email = $('email').value.trim();
    const password = $('password').value;
    const captcha = window.turnstile ? window.turnstile.getResponse() : '';
    say('');
    let res;
    if (action === 'magic-link') {
      res = await post('/sign-in/magic-link', { email, callbackURL: '/' }, captcha);
      if (res.ok) say('Check your email for a sign-in link.');
    } else if (action === 'sign-up') {
      res = await post('/sign-up/email', { email, password, name: email.split('@')[0], callbackURL: '/' }, captcha);
      if (res.ok) say('Account created. Check your email for a link to verify it.');
    } else {
      res = await post('/sign-in/email', { email, password }, captcha);
      if (res.ok) location.reload();
    }
    if (!res.ok) say(explain(action, res));
    if (window.turnstile) window.turnstile.reset();
  });
})();
</script>
</body>
</html>
`;
}
