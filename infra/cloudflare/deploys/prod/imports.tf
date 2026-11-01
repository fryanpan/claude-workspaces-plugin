# Adopt what already exists in prod instead of creating a second copy.
# `discover.ts` finds each live resource by the name this config gives it and
# passes its id in `var.imports`; an id for a resource already in state is a
# no-op. Routes arrive keyed as the modules key them (project label, the
# one address's board paths, a share host without the zone); DNS records
# arrive keyed by hostname and are matched to their label here.

import {
  for_each = var.imports.access_apps
  to       = module.stack.module.access.cloudflare_zero_trust_access_application.project[each.key]
  id       = "accounts/${var.account_id}/${each.value}"
}

import {
  for_each = var.imports.access_people_policies
  to       = module.stack.module.access.cloudflare_zero_trust_access_policy.people[each.key]
  id       = "${var.account_id}/${each.value}"
}

import {
  for_each = var.imports.access_token_policies
  to       = module.stack.module.access.cloudflare_zero_trust_access_policy.service_tokens[each.key]
  id       = "${var.account_id}/${each.value}"
}

import {
  for_each = { for k, v in var.imports.scripts : k => v if k == var.router_script_name }
  to       = module.stack.module.router.cloudflare_workers_script.router
  id       = "${var.account_id}/${each.value}"
}

import {
  for_each = { for k, v in var.imports.scripts : k => v if k == var.share_link_script_name }
  to       = module.stack.module.share_link.cloudflare_workers_script.share_link[each.key]
  id       = "${var.account_id}/${each.value}"
}

import {
  for_each = var.imports.routes
  to       = module.stack.module.router.cloudflare_workers_route.router[each.key]
  id       = "${var.zone_id}/${each.value}"
}

import {
  for_each = var.imports.share_routes
  to       = module.stack.module.share_link.cloudflare_workers_route.share_link[each.key]
  id       = "${var.zone_id}/${each.value}"
}

import {
  for_each = { for label, host in var.project_hosts : label => var.imports.dns_records[host] if contains(keys(var.imports.dns_records), host) }
  to       = module.stack.module.router.cloudflare_dns_record.project_host[each.key]
  id       = "${var.zone_id}/${each.value}"
}

import {
  for_each = { for label, t in var.tunnels : label => var.imports.dns_records[t.origin] if contains(keys(var.imports.dns_records), t.origin) }
  to       = module.stack.module.tunnel.cloudflare_dns_record.origin[each.key]
  id       = "${var.zone_id}/${each.value}"
}

import {
  for_each = var.imports.tunnels
  to       = module.stack.module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.project[each.key]
  id       = "${var.account_id}/${each.value}"
}

import {
  for_each = var.imports.tunnels
  to       = module.stack.module.tunnel.cloudflare_zero_trust_tunnel_cloudflared_config.project[each.key]
  id       = "${var.account_id}/${each.value}"
}
