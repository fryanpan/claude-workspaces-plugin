# Share-link edge Worker

Validates signed share links (`/share/<id>?exp=<unix-seconds>&sig=<hex>`) at
the Cloudflare edge before the request reaches the tunnel. A tampered,
expired, or unsigned `/share/*` URL gets a 404 from Cloudflare itself; a
valid one is proxied to origin unchanged. Every other path passes straight
through — the app authorizes those with its own session cookies.

This is defense-in-depth, not the security boundary: the server re-validates
signature + expiry on every `/share/*` request and re-checks the share
registry (so early revocation works even against a validly signed URL). The
Worker exists to keep guessing traffic and dead links off the tunnel.

## Deploying

The Worker and its routes are part of the one OpenTofu config in
`../cloudflare/` (`share-link.tf`). The committed `wrangler.toml` carries
placeholder hostnames; copy it to `wrangler.local.toml` (gitignored) and fill
in the routes. The config manages this Worker only once that file lists
routes, each a `<host>/share/*` pattern in `router.local.json`'s zone:

```sh
bun run cf:plan
bun run cf:apply
```

The Worker has no workers.dev address. Its HMAC key is the one step outside
the config, so the key never enters the OpenTofu state: set it as a Worker
**secret** named `SHARE_LINK_KEY`, once, after the first apply. The key is
the content of `share-url.key` in the server's data directory (the server
generates it, mode 600, on the first signed link it mints). Pipe it in
without printing it:

```sh
npx wrangler secret put SHARE_LINK_KEY -c wrangler.local.toml < /path/to/data/share-url.key
```

An apply keeps that secret (`keep_bindings`), so it is set once, not after
every apply.

The verification convention (shared with `packages/server/src/share/url-signing.ts`):
HMAC-SHA256 over the string `<id>.<exp>`, keyed by the UTF-8 bytes of the key
file's content as-is — no hex decoding. Both sides use Web Crypto
(`crypto.subtle`), and `packages/server/test/share-url-signing.test.ts`
cross-verifies server-minted signatures against this Worker's verify function.

With no `SHARE_LINK_KEY` configured the Worker fails closed: every
`/share/*` request 404s. If share links stop working at the edge but redeem
fine over the tailnet, check the secret before anything else.

## Hygiene

The signed URL is the credential, so every `/share/*` response — the 302 and
both sides' 404s — carries `Referrer-Policy: no-referrer`, and neither the
Worker nor the server logs request URLs. Any future log line that must carry
a share URL goes through `scrubShareUrl` (server, `share/url-signing.ts`),
which redacts the `sig` param. Cloudflare's own request logging (observability
/ `wrangler tail`) is a separate account-level surface — keep it off for this
route, or accept that it sees full URLs.
