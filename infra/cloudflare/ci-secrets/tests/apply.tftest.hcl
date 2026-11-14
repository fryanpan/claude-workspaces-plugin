# The CI credentials root against mock providers: no token, no account, no
# GitHub call, no state. Run by `bun run check:cloudflare-tf`. Each run
# "applies" against the mocks, so the token's value and id are the
# fixtures below and the derived R2 key can be checked against them.

mock_provider "cloudflare" {}

mock_provider "github" {}

override_data {
  target = data.github_repository_environment_deployment_policies.deploy
  values = {
    policies = tolist([{ pattern = "main", type = "branch" }])
  }
}

override_data {
  target = data.github_rest_api.environment
  values = {
    body = "{\"deployment_branch_policy\":{\"protected_branches\":false,\"custom_branch_policies\":true}}"
  }
}

override_resource {
  target = cloudflare_account_token.ci_deploy
  values = {
    id    = "0123456789abcdef0123456789abcdef"
    value = "fixture-token-riverbend"
  }
}

variables {
  permission_groups = [
    { id = "g-apps", name = "Access: Apps and Policies Write", scopes = ["com.cloudflare.api.account"] },
    { id = "g-svc", name = "Access: Service Tokens Write", scopes = ["com.cloudflare.api.account"] },
    { id = "g-org", name = "Access: Organizations, Identity Providers, and Groups Read", scopes = ["com.cloudflare.api.account"] },
    { id = "g-tun", name = "Cloudflare Tunnel Write", scopes = ["com.cloudflare.api.account"] },
    { id = "g-wrk", name = "Workers Scripts Write", scopes = ["com.cloudflare.api.account"] },
    { id = "g-zone", name = "Zone Read", scopes = ["com.cloudflare.api.account.zone"] },
    { id = "g-dns", name = "DNS Write", scopes = ["com.cloudflare.api.account.zone"] },
    { id = "g-ssl", name = "SSL and Certificates Read", scopes = ["com.cloudflare.api.account.zone"] },
    { id = "g-rts", name = "Workers Routes Write", scopes = ["com.cloudflare.api.account.zone"] },
    { id = "g-r2", name = "Workers R2 Storage Bucket Item Write", scopes = ["com.cloudflare.edge.r2.bucket"] },
    # Same name, another scope: must not be picked for the bucket.
    { id = "g-r2-acct", name = "Workers R2 Storage Bucket Item Write", scopes = ["com.cloudflare.api.account"] },
    # A token-making permission exists; the CI token must not get it.
    { id = "g-tok", name = "API Tokens Write", scopes = ["com.cloudflare.api.user"] },
  ]
  account_id       = "fedcba9876543210fedcba9876543210"
  repository_owner = "harborlight"
  repository       = "riverbend"
}

run "the_token_holds_what_the_workflows_need_and_no_more" {
  command = apply

  assert {
    condition = jsonencode([for p in cloudflare_account_token.ci_deploy.policies : sort([for g in p.permission_groups : g.id])]) == jsonencode([
      sort(["g-apps", "g-svc", "g-org", "g-tun", "g-wrk"]),
      sort(["g-zone", "g-dns", "g-ssl", "g-rts"]),
      ["g-r2"],
    ])
    error_message = "the token's permission groups are the account, zone and bucket lists, each resolved in its own scope"
  }

  assert {
    condition = jsonencode([for p in cloudflare_account_token.ci_deploy.policies : jsondecode(p.resources)]) == jsonencode([
      { "com.cloudflare.api.account.fedcba9876543210fedcba9876543210" = "*" },
      { "com.cloudflare.api.account.fedcba9876543210fedcba9876543210" = { "com.cloudflare.api.account.zone.*" = "*" } },
      { "com.cloudflare.edge.r2.bucket.fedcba9876543210fedcba9876543210_default_claude-workspaces-tfstate" = "*" },
    ])
    error_message = "R2 access is the state bucket alone; the rest is the one account and its zones"
  }

  assert {
    condition     = alltrue([for p in cloudflare_account_token.ci_deploy.policies : p.effect == "allow"])
    error_message = "every policy allows"
  }
}

run "the_r2_key_is_derived_from_the_token" {
  command = apply

  assert {
    condition     = github_actions_environment_secret.deploy["R2_ACCESS_KEY_ID"].value == "0123456789abcdef0123456789abcdef"
    error_message = "the R2 access key id is the token's id"
  }

  assert {
    condition     = github_actions_environment_secret.deploy["R2_SECRET_ACCESS_KEY"].value == sha256("fixture-token-riverbend")
    error_message = "the R2 secret is the SHA-256 of the token's value"
  }

  assert {
    condition     = github_actions_environment_secret.deploy["CLOUDFLARE_API_TOKEN"].value == "fixture-token-riverbend"
    error_message = "the environment gets the token itself"
  }

  assert {
    condition     = alltrue([for s in github_actions_environment_secret.deploy : s.environment == "cloudflare-prod" && s.repository == "riverbend"])
    error_message = "the deploy credentials go to cloudflare-prod only"
  }

  assert {
    condition     = output.environment_secrets == tolist(["CLOUDFLARE_API_TOKEN", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"])
    error_message = "no Fly token given, so no FLY_API_TOKEN is written"
  }

  assert {
    condition     = length(output.repository_secrets) == 0
    error_message = "no config given, so no repository secret is written"
  }
}

run "configs_and_the_fly_token_are_written_when_given" {
  command = apply

  variables {
    router_config     = "{\"zone\":\"harborlight.test\"}"
    access_config     = "{\"projects\":{}}"
    share_link_config = "name = \"share-link-gate\""
    fly_api_token     = "fixture-fly-riverbend"
  }

  assert {
    condition     = output.repository_secrets == tolist(["CF_ACCESS_CONFIG", "CF_ROUTER_CONFIG", "CF_SHARE_LINK_CONFIG"])
    error_message = "each config given is a repository secret"
  }

  assert {
    condition     = github_actions_secret.config["CF_ROUTER_CONFIG"].value == "{\"zone\":\"harborlight.test\"}"
    error_message = "a config secret holds the file's text"
  }

  assert {
    condition     = github_actions_environment_secret.deploy["FLY_API_TOKEN"].value == "fixture-fly-riverbend"
    error_message = "the Fly token goes to the environment"
  }
}

run "a_permission_cloudflare_does_not_list_stops_the_token" {
  command = plan

  variables {
    permission_groups = [
      { id = "g-zone", name = "Zone Read", scopes = ["com.cloudflare.api.account.zone"] },
    ]
  }

  expect_failures = [cloudflare_account_token.ci_deploy]
}

run "an_environment_other_branches_can_deploy_to_gets_no_secret" {
  command = plan

  override_data {
    target = data.github_repository_environment_deployment_policies.deploy
    values = {
      policies = tolist([{ pattern = "*", type = "branch" }])
    }
  }

  expect_failures = [cloudflare_account_token.ci_deploy]
}

run "main_beside_a_tag_rule_is_not_main_alone" {
  command = plan

  override_data {
    target = data.github_repository_environment_deployment_policies.deploy
    values = {
      policies = tolist([{ pattern = "main", type = "branch" }, { pattern = "v*", type = "tag" }])
    }
  }

  expect_failures = [cloudflare_account_token.ci_deploy]
}

run "protected_branches_mode_is_not_main_alone" {
  command = plan

  override_data {
    target = data.github_rest_api.environment
    values = {
      body = "{\"deployment_branch_policy\":{\"protected_branches\":true,\"custom_branch_policies\":true}}"
    }
  }

  expect_failures = [cloudflare_account_token.ci_deploy]
}

run "a_token_with_no_value_writes_nothing" {
  command = apply
  # Its own state: the runs above already hold a token with a value.
  state_key = "no-value"

  override_resource {
    target = cloudflare_account_token.ci_deploy
    values = {
      id    = "0123456789abcdef0123456789abcdef"
      value = ""
    }
  }

  expect_failures = [cloudflare_account_token.ci_deploy]
}
