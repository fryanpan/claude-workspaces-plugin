# tunnel

Each Fly project machine's named tunnel (`docs/process/project-machine.md`).

| Resource | Per |
| --- | --- |
| `cloudflare_zero_trust_tunnel_cloudflared.project` | project; configured from Cloudflare; `prevent_destroy` |
| `cloudflare_zero_trust_tunnel_cloudflared_config.project` | project; the project hostname to `service`, everything else 404 |
| `cloudflare_dns_record.origin` | project; proxied CNAME `<origin>` to `<tunnel id>.cfargotunnel.com` |
| `data.cloudflare_zero_trust_tunnel_cloudflared_token.project` | project; read back for `machine:deploy` |

The token data source puts each tunnel's token in the state. The state bucket
is private and the `tokens` output is sensitive.

Inputs: `account_id`, `zone_id`, `service` (default `http://localhost:8787`),
`tunnels` (label → name, origin, public host). Outputs: `tunnels` (label →
id and names, no credential), `tokens` (sensitive).
