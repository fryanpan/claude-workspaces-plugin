# Adopt what already exists instead of creating a second copy. `discover.ts`
# finds each live resource by the name this config gives it and passes its id
# in `var.imports`; an id for a resource already in state is a no-op.

import {
  for_each = var.imports.access_apps
  to       = cloudflare_zero_trust_access_application.project[each.key]
  id       = "accounts/${var.account_id}/${each.value}"
}

import {
  for_each = var.imports.access_people_policies
  to       = cloudflare_zero_trust_access_policy.people[each.key]
  id       = "${var.account_id}/${each.value}"
}

import {
  for_each = var.imports.access_token_policies
  to       = cloudflare_zero_trust_access_policy.service_tokens[each.key]
  id       = "${var.account_id}/${each.value}"
}

import {
  for_each = { for k, v in var.imports.scripts : k => v if k == "board-router" }
  to       = cloudflare_workers_script.board_router
  id       = "${var.account_id}/${each.value}"
}

import {
  for_each = { for k, v in var.imports.scripts : k => v if k == "share-link-gate" }
  to       = cloudflare_workers_script.share_link[each.key]
  id       = "${var.account_id}/${each.value}"
}

import {
  for_each = { for k, v in var.imports.routes : k => v if contains(local.router_patterns, k) }
  to       = cloudflare_workers_route.board_router[each.key]
  id       = "${var.zone_id}/${each.value}"
}

import {
  for_each = { for k, v in var.imports.routes : k => v if contains(var.share_link_routes, k) }
  to       = cloudflare_workers_route.share_link[each.key]
  id       = "${var.zone_id}/${each.value}"
}

import {
  for_each = { for label, host in var.project_hosts : label => var.imports.dns_records[host] if contains(keys(var.imports.dns_records), host) }
  to       = cloudflare_dns_record.project_host[each.key]
  id       = "${var.zone_id}/${each.value}"
}

import {
  for_each = { for label, t in var.tunnels : label => var.imports.dns_records[t.origin] if contains(keys(var.imports.dns_records), t.origin) }
  to       = cloudflare_dns_record.origin[each.key]
  id       = "${var.zone_id}/${each.value}"
}

import {
  for_each = var.imports.tunnels
  to       = cloudflare_zero_trust_tunnel_cloudflared.project[each.key]
  id       = "${var.account_id}/${each.value}"
}

import {
  for_each = var.imports.tunnels
  to       = cloudflare_zero_trust_tunnel_cloudflared_config.project[each.key]
  id       = "${var.account_id}/${each.value}"
}
