# stack

One deployment's whole Cloudflare configuration: `access`, `router-worker`,
`share-link` and `tunnel` wired together, plus the Access organization read
back for its team domain. Each root under `deploys/` calls it once.

Worker sources are found relative to this module
(`../../../board-router-worker/worker.js`, `../../../share-link-worker/worker.js`).
Share-link routes are keyed by host without the zone.

Inputs: every value a deployment varies, all without defaults that name a real
account, zone, host or person (see `variables.tf`). Outputs: `access`,
`access_team_domain`, `tunnels`, `tunnel_tokens` (sensitive),
`router_routes`, `share_link_routes`.
