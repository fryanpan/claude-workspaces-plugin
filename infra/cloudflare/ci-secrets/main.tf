# CI's credentials, made and handed to GitHub in one apply, so nobody pastes
# a value (README.md, "CI's credentials"). One Cloudflare token does
# everything `cloudflare.yml` and `fly.yml` do; the state bucket's S3 key is
# derived from it, the way Cloudflare documents an R2 key made from an API
# token: the access key id is the token's id, the secret is the SHA-256 of
# its value.
#
# The Cloudflare provider reads CLOUDFLARE_API_TOKEN and the GitHub provider
# GITHUB_TOKEN, both from the environment. The Cloudflare token must be able
# to make account-owned tokens (Account API Tokens Edit). The deploy token is
# account-owned too, so it outlives any one person's login.

provider "cloudflare" {}

provider "github" {
  owner = var.repository_owner
}

locals {
  account_scope = "com.cloudflare.api.account"
  zone_scope    = "com.cloudflare.api.account.zone"
  bucket_scope  = "com.cloudflare.edge.r2.bucket"

  # What the two workflows need. The account and zone halves are the apply
  # token's list in packages/server/src/keeper/keeper-setup-ci.ts
  # (CF_APPLY_PERMISSIONS); keep the two the same.
  permissions = {
    account = [
      "Access: Apps and Policies Write",
      "Access: Service Tokens Write",
      "Access: Organizations, Identity Providers, and Groups Read",
      "Cloudflare Tunnel Write",
      "Workers Scripts Write",
    ]
    zone = [
      "Zone Read",
      "DNS Write",
      "SSL and Certificates Read",
      "Workers Routes Write",
    ]
    bucket = [
      "Workers R2 Storage Bucket Item Write",
    ]
  }
  scope_of = {
    account = local.account_scope
    zone    = local.zone_scope
    bucket  = local.bucket_scope
  }

  # name -> ids, per scope. A name Cloudflare does not list, or lists twice
  # for one scope, fails the token's precondition below.
  group_ids = {
    for kind, names in local.permissions : kind => {
      for name in names : name => [
        for g in local.groups : g.id if g.name == name && contains(g.scopes, local.scope_of[kind])
      ]
    }
  }
  unresolved = flatten([
    for kind, by_name in local.group_ids : [
      for name, ids in by_name : "${name} (${kind})" if length(ids) != 1
    ]
  ])

  account_resource = "com.cloudflare.api.account.${var.account_id}"
  resources = {
    account = { (local.account_resource) = "*" }
    zone    = { (local.account_resource) = { "com.cloudflare.api.account.zone.*" = "*" } }
    bucket  = { "com.cloudflare.edge.r2.bucket.${var.account_id}_default_${var.state_bucket}" = "*" }
  }
}

# Read from Cloudflare unless var.permission_groups gives the list.
data "cloudflare_account_api_token_permission_groups_list" "all" {
  count      = var.permission_groups == null ? 1 : 0
  account_id = var.account_id
  max_items  = 1000
}

locals {
  groups = var.permission_groups != null ? var.permission_groups : [
    for g in data.cloudflare_account_api_token_permission_groups_list.all[0].result :
    { id = g.id, name = g.name, scopes = g.scopes }
  ]
}

resource "cloudflare_account_token" "ci_deploy" {
  account_id = var.account_id
  name       = var.token_name

  policies = [
    for kind in ["account", "zone", "bucket"] : {
      effect            = "allow"
      resources         = jsonencode(local.resources[kind])
      permission_groups = [for name in local.permissions[kind] : { id = one(local.group_ids[kind][name]) }]
    }
  ]

  lifecycle {
    precondition {
      condition     = length(local.unresolved) == 0
      error_message = "Cloudflare lists no single permission group for: ${join(", ", local.unresolved)}."
    }
    # Checked here, before anything is made: the secrets need the token.
    precondition {
      condition     = local.main_only
      error_message = "The environment must allow deployments from the branch main alone (Settings > Environments > Deployment branches and tags: Selected, with the one rule main); nothing was made."
    }
    # Cloudflare returns a token's value only to the call that made it. An
    # in-place update that lost it would write empty secrets.
    postcondition {
      condition     = self.value != null && self.value != ""
      error_message = "The token has no value in the state; nothing more was written. Replace it on purpose: terraform apply -replace=cloudflare_account_token.ci_deploy (through cf:ci-secrets, with --drop)."
    }
  }
}

locals {
  # The state bucket's S3 key, from the token.
  r2_access_key_id     = cloudflare_account_token.ci_deploy.id
  r2_secret_access_key = sha256(cloudflare_account_token.ci_deploy.value)

  environment_secrets = merge(
    {
      CLOUDFLARE_API_TOKEN = cloudflare_account_token.ci_deploy.value
      R2_ACCESS_KEY_ID     = local.r2_access_key_id
      R2_SECRET_ACCESS_KEY = local.r2_secret_access_key
    },
    nonsensitive(var.fly_api_token != null) ? { FLY_API_TOKEN = var.fly_api_token } : {},
  )

  # Names only, so the set can key for_each; the values stay sensitive.
  environment_secret_names = toset(nonsensitive(keys(local.environment_secrets)))

  config_values = {
    CF_ROUTER_CONFIG     = var.router_config
    CF_ACCESS_CONFIG     = var.access_config
    CF_SHARE_LINK_CONFIG = var.share_link_config
  }
  repository_secret_names = toset([
    for name, value in local.config_values : name if nonsensitive(value != null)
  ])
}

# The environment's write credentials are safe only while a run from main
# alone can deploy to it: the keeper checks the same before its own write
# (packages/server/src/keeper/keeper-github.ts). The token's precondition
# reads this.
data "github_repository_environment_deployment_policies" "deploy" {
  repository  = var.repository
  environment = var.environment
}

data "github_rest_api" "environment" {
  endpoint = "repos/${var.repository_owner}/${var.repository}/environments/${var.environment}"
}

locals {
  branch_policy = try(jsondecode(data.github_rest_api.environment.body).deployment_branch_policy, null)
  main_only = (
    try(local.branch_policy.custom_branch_policies, false) == true &&
    try(local.branch_policy.protected_branches, false) != true &&
    jsonencode(data.github_repository_environment_deployment_policies.deploy.policies) == jsonencode([
      { pattern = "main", type = "branch" },
    ])
  )
}

resource "github_actions_environment_secret" "deploy" {
  for_each = local.environment_secret_names

  repository  = var.repository
  environment = var.environment
  secret_name = each.key
  value       = local.environment_secrets[each.key]
}

resource "github_actions_secret" "config" {
  for_each = local.repository_secret_names

  repository  = var.repository
  secret_name = each.key
  value       = local.config_values[each.key]
}
