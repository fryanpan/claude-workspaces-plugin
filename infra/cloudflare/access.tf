# One Access application per project, over that project's own hostnames
# (infra/access-apps/README.md). Each issues stamps with an audience of its
# own, so a stamp minted for one project verifies on no other project's
# server (`packages/server/src/middleware/cf-access.ts`).
#
# People and whole email domains share one `allow` policy; service tokens get
# a `non_identity` policy of their own, which admits a token and never a
# person. A project with nobody listed gets no `allow` policy, so its
# application admits no person at all rather than everyone.
#
# Share applications are not here: the server makes one per share when a
# person shares a board (`packages/server/src/share/cf-api.ts`), and this
# config neither knows nor touches them.

locals {
  people_projects = {
    for label, p in var.access_projects : label => p
    if length(p.emails) + length(p.email_domains) > 0
  }
  token_projects = {
    for label, p in var.access_projects : label => p
    if length(p.service_tokens) > 0
  }
}

resource "cloudflare_zero_trust_access_policy" "people" {
  for_each   = local.people_projects
  account_id = var.account_id
  name       = "${each.key} people"
  decision   = "allow"
  # Addresses are marked sensitive so a plan does not print them.
  include = sensitive(concat(
    [for e in each.value.emails : { email = { email = e }, email_domain = null }],
    [for d in each.value.email_domains : { email = null, email_domain = { domain = d } }],
  ))
}

resource "cloudflare_zero_trust_access_policy" "service_tokens" {
  for_each   = local.token_projects
  account_id = var.account_id
  name       = "${each.key} service tokens"
  decision   = "non_identity"
  include = [
    for name in each.value.service_tokens : { service_token = { token_id = var.service_token_ids[name] } }
  ]
}

resource "cloudflare_zero_trust_access_application" "project" {
  for_each                   = var.access_projects
  account_id                 = var.account_id
  name                       = "board ${each.key}"
  type                       = "self_hosted"
  domain                     = each.value.hosts[0]
  destinations               = [for h in each.value.hosts : { type = "public", uri = h }]
  session_duration           = var.access_session_duration
  app_launcher_visible       = false
  http_only_cookie_attribute = true
  same_site_cookie_attribute = "lax"
  policies = concat(
    contains(keys(local.people_projects), each.key) ? [
      { id = cloudflare_zero_trust_access_policy.people[each.key].id, precedence = 1 }
    ] : [],
    contains(keys(local.token_projects), each.key) ? [
      { id = cloudflare_zero_trust_access_policy.service_tokens[each.key].id, precedence = 2 }
    ] : [],
  )
}
