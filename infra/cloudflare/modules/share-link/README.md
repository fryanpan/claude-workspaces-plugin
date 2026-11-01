# share-link

The share-link edge Worker (`infra/share-link-worker/`) on `<host>/share/*`
routes. With no routes it makes nothing.

| Resource | Per |
| --- | --- |
| `cloudflare_workers_script.share_link` | one, when routes are listed |
| `cloudflare_workers_route.share_link` | route |

`keep_bindings = ["secret_text"]` keeps the `SHARE_LINK_KEY` secret, set with
`wrangler secret put`, across an apply, so the key never enters the state.
Observability is off because request logs would carry signed URLs. The
Worker's workers.dev setting is not managed.

Inputs: `account_id`, `zone_id`, `script_name`, `worker_source`,
`compatibility_date`, `routes` (key → pattern). Output: `routes`.
