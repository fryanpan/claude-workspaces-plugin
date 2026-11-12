# One Access application per project, over that project's own hostnames
# (infra/access-apps/README.md). Each issues stamps with an audience of its
# own, so a stamp minted for one project verifies on no other project's
# server (`packages/server/src/middleware/cf-access.ts`).
#
# People and whole email domains share one `allow` policy; service tokens are
# managed here too, and get a `non_identity` policy of their own, which admits a token and never a
# person. A project with nobody listed gets no `allow` policy, so its
# application admits no person at all rather than everyone.
#
# Share applications are not here: the server makes one per share when a
# person shares a board (`packages/server/src/share/cf-api.ts`), and this
# config neither knows nor touches them.

locals {
  people_projects = {
    for label, p in var.projects : label => p
    if length(p.emails) + length(p.email_domains) > 0
  }
  token_projects = {
    for label, p in var.projects : label => p
    if length(p.service_tokens) > 0
  }
  service_token_names = toset(flatten([for p in var.projects : p.service_tokens]))
}

# Every service token a project names. The apply never makes one: `cf:sync-config`
# makes a missing token first, through the keeper, and keeps its secret in the Keychain
# (`infra/cloudflare/service-tokens.ts`), and each root imports it by id, so
# the state never holds a `client_secret` (Cloudflare returns it only to the
# call that made the token). A plan for a token that does not exist yet still
# shows the create.
resource "cloudflare_zero_trust_access_service_token" "project" {
  for_each   = local.service_token_names
  account_id = var.account_id
  name       = "${var.name_prefix}${each.key}"

  # Destroying a token locks out every agent that holds it.
  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_policy" "people" {
  for_each   = local.people_projects
  account_id = var.account_id
  name       = "${var.name_prefix}${each.key} people"
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
  name       = "${var.name_prefix}${each.key} service tokens"
  decision   = "non_identity"
  include = [
    for name in each.value.service_tokens : { service_token = { token_id = cloudflare_zero_trust_access_service_token.project[name].id } }
  ]
}

resource "cloudflare_zero_trust_access_application" "project" {
  for_each                   = var.projects
  account_id                 = var.account_id
  name                       = "${var.name_prefix}board ${each.key}"
  type                       = "self_hosted"
  domain                     = each.value.hosts[0]
  destinations               = [for h in each.value.hosts : { type = "public", uri = h }]
  session_duration           = var.session_duration
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

  # Removing an application exposes what it guarded and gives the project a
  # new audience, which every server must be redeployed with. A plan that
  # would destroy one fails; removing one is a deliberate edit here first.
  lifecycle {
    prevent_destroy = true
  }
}
