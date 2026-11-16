# The secrets apps' workflows read from `cloudflare-prod`, written to GitHub
# and nothing else (README.md, "Apps' secrets"). The GitHub provider is the
# only one: it reads GITHUB_TOKEN from the environment, a classic token with
# repo scope. No Cloudflare token is needed, and the deploy token and R2 pair
# that `ci-secrets/` or the keeper wrote are not in this root, so no apply
# here can change or delete them.

provider "github" {
  owner = var.repository_owner
}

locals {
  # Names only, so the set can key for_each; the values stay sensitive.
  secret_names = toset(nonsensitive(keys(var.secrets)))
}

# The environment's secrets are safe only while a run from main alone can
# deploy to it: the keeper and `ci-secrets/` check the same before writing.
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

resource "github_actions_environment_secret" "app" {
  for_each = local.secret_names

  repository  = var.repository
  environment = var.environment
  secret_name = each.key
  value       = var.secrets[each.key]

  lifecycle {
    precondition {
      condition     = local.main_only
      error_message = "The environment must allow deployments from the branch main alone (Settings > Environments > Deployment branches and tags: Selected, with the one rule main); nothing was written."
    }
  }
}
