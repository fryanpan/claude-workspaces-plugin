# One GitHub Environment per Fly app CI deploys, each holding a Fly token cut
# down to that app alone (README.md, "Fly's CI tokens"). A job in
# `fly-<project>` sees that project's token and no other: no org token, no
# Cloudflare token, no state key. The GitHub provider is the only one: it
# reads GITHUB_TOKEN from the environment, a classic token with repo scope.
# Fly has no maintained provider, so the tokens are cut on the Mac by
# `fly tokens attenuate` and handed in.

provider "github" {
  owner = var.repository_owner
}

locals {
  # Names only, so the set can key for_each; the tokens stay sensitive.
  environments = toset(nonsensitive(keys(var.deploy_tokens)))
}

# Deployments from main alone, set here rather than by hand: custom branch
# policies (not protected-branches mode) with the one rule below. No required
# reviewer and no wait timer, so a merge deploys with no step for a person.
resource "github_repository_environment" "fly" {
  for_each = local.environments

  repository  = var.repository
  environment = each.key

  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}

resource "github_repository_environment_deployment_policy" "main" {
  for_each = local.environments

  repository     = var.repository
  environment    = github_repository_environment.fly[each.key].environment
  branch_pattern = "main"
}

# Written only once the environment admits main alone.
resource "github_actions_environment_secret" "deploy_token" {
  for_each = local.environments

  repository  = var.repository
  environment = github_repository_environment.fly[each.key].environment
  secret_name = "FLY_DEPLOY_TOKEN"
  value       = var.deploy_tokens[each.key]

  depends_on = [github_repository_environment_deployment_policy.main]
}

locals {
  # Whether a read token was handed in; the value itself stays sensitive.
  read_environments = nonsensitive(var.read_token != "") ? toset(["fly-org-read"]) : toset([])
}

# The read token's environment: main alone and no reviewer, like the others.
resource "github_repository_environment" "read" {
  for_each = local.read_environments

  repository  = var.repository
  environment = each.key

  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}

resource "github_repository_environment_deployment_policy" "read_main" {
  for_each = local.read_environments

  repository     = var.repository
  environment    = github_repository_environment.read[each.key].environment
  branch_pattern = "main"
}

resource "github_actions_environment_secret" "read_token" {
  for_each = local.read_environments

  repository  = var.repository
  environment = github_repository_environment.read[each.key].environment
  secret_name = "FLY_READ_TOKEN"
  value       = var.read_token

  depends_on = [github_repository_environment_deployment_policy.read_main]
}
