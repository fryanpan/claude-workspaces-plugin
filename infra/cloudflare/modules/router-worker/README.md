# router-worker

The board router Worker (`infra/board-router-worker/`), and what puts it in
front of each project's hostname.

| Resource | Per |
| --- | --- |
| `cloudflare_workers_script.router` | one; the routing tables are plain-text vars |
| `cloudflare_workers_script_subdomain.router` | one; workers.dev and previews off |
| `cloudflare_workers_route.router` | project, plus `one-address/workspaces` when `bind_board_paths` |
| `cloudflare_dns_record.project_host` | project; proxied AAAA `100::` |

Routes and records are keyed by project label, so a plan's addresses carry no
hostname.

Inputs: `account_id`, `zone_id`, `script_name`, `worker_source`,
`compatibility_date`, `one_address`, `project_origins`, `project_hosts`,
`board_origins`, `bind_board_paths`, `one_address_origin`. Output: `routes`
(key → pattern).
