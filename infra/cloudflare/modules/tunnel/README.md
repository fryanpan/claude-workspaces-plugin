# tunnel

Each Fly project machine's named tunnel (`docs/process/project-machine.md`).

| Resource | Per |
| --- | --- |
| `cloudflare_zero_trust_tunnel_cloudflared.project` | project; configured from Cloudflare; `prevent_destroy` |
| `cloudflare_zero_trust_tunnel_cloudflared_config.project` | project; the project hostname to `service`, everything else 404 |
| `cloudflare_dns_record.origin` | project; proxied CNAME `<origin>` to `<tunnel id>.cfargotunnel.com` |

Nothing secret enters the state: `tunnel_secret` is unset, so Cloudflare
generates the secret and the provider stores none. The tunnel's token is not
read here; `machine:deploy` reads it from the API with the id in `tunnels`.

Inputs: `account_id`, `zone_id`, `service` (default `http://localhost:8787`),
`tunnels` (label → name, origin, public host). Output: `tunnels` (label →
account id, tunnel id and names; no credential).
