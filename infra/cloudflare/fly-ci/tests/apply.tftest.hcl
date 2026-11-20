# The Fly CI root against a mock provider: no token, no GitHub call, no
# state. Run by `bun run check:cloudflare-tf`.

mock_provider "github" {}

variables {
  repository_owner = "harborlight"
  repository       = "riverbend"
  deploy_tokens = {
    fly-saltmarsh      = "fixture-fly-token-saltmarsh"
    fly-harborlight    = "fixture-fly-token-harborlight"
    fly-appkit-staging = "fixture-fly-token-staging"
  }
  read_token = "fixture-fly-read-token"
}

run "each_environment_holds_its_own_token" {
  command = apply

  assert {
    condition     = output.environments == tolist(["fly-appkit-staging", "fly-harborlight", "fly-saltmarsh"])
    error_message = "one environment per token"
  }

  assert {
    condition = (
      github_actions_environment_secret.deploy_token["fly-saltmarsh"].value == "fixture-fly-token-saltmarsh" &&
      github_actions_environment_secret.deploy_token["fly-harborlight"].value == "fixture-fly-token-harborlight" &&
      github_actions_environment_secret.deploy_token["fly-appkit-staging"].value == "fixture-fly-token-staging"
    )
    error_message = "each environment holds its own app's token, never another's"
  }

  assert {
    condition = alltrue([
      for k, s in github_actions_environment_secret.deploy_token :
      s.environment == k && s.secret_name == "FLY_DEPLOY_TOKEN" && s.repository == "riverbend"
    ])
    error_message = "the token is FLY_DEPLOY_TOKEN in its own environment, never a repository secret"
  }
}

run "every_environment_admits_main_alone" {
  command = apply

  assert {
    condition = alltrue([
      for e in github_repository_environment.fly :
      e.deployment_branch_policy[0].custom_branch_policies == true &&
      e.deployment_branch_policy[0].protected_branches == false
    ])
    error_message = "custom branch policies, not protected-branches mode"
  }

  assert {
    condition     = alltrue([for p in github_repository_environment_deployment_policy.main : p.branch_pattern == "main"])
    error_message = "the one rule is main"
  }

  assert {
    condition     = length(github_repository_environment_deployment_policy.main) == 3
    error_message = "one rule per environment"
  }

  assert {
    condition     = alltrue([for e in github_repository_environment.fly : length(e.reviewers) == 0 && (e.wait_timer == null || e.wait_timer == 0)])
    error_message = "no required reviewer and no wait timer: a merge deploys with no step for a person"
  }
}

run "an_environment_left_out_is_not_made" {
  command = apply

  variables {
    deploy_tokens = {
      fly-saltmarsh = "fixture-fly-token-saltmarsh"
    }
  }

  assert {
    condition     = output.environments == tolist(["fly-saltmarsh"])
    error_message = "only the given environment is made"
  }
}

run "an_empty_token_is_refused" {
  command = plan

  variables {
    deploy_tokens = {
      fly-saltmarsh = ""
    }
  }

  expect_failures = [var.deploy_tokens]
}

run "a_name_that_is_not_fly_project_is_refused" {
  command = plan

  variables {
    deploy_tokens = {
      cloudflare-prod = "fixture-fly-token-saltmarsh"
    }
  }

  expect_failures = [var.deploy_tokens]
}

run "the_read_token_has_its_own_main_only_environment" {
  command = apply

  assert {
    condition     = output.read_environments == tolist(["fly-org-read"])
    error_message = "the read token gets fly-org-read"
  }

  assert {
    condition = (
      github_actions_environment_secret.read_token["fly-org-read"].value == "fixture-fly-read-token" &&
      github_actions_environment_secret.read_token["fly-org-read"].secret_name == "FLY_READ_TOKEN" &&
      github_actions_environment_secret.read_token["fly-org-read"].environment == "fly-org-read"
    )
    error_message = "the read token is FLY_READ_TOKEN in fly-org-read alone"
  }

  assert {
    condition     = !contains(output.environments, "fly-org-read")
    error_message = "the read token is never one of the deploy tokens"
  }

  assert {
    condition = (
      github_repository_environment.read["fly-org-read"].deployment_branch_policy[0].custom_branch_policies == true &&
      github_repository_environment.read["fly-org-read"].deployment_branch_policy[0].protected_branches == false &&
      github_repository_environment_deployment_policy.read_main["fly-org-read"].branch_pattern == "main"
    )
    error_message = "fly-org-read admits main alone"
  }
}

run "no_read_token_makes_no_read_environment" {
  command = apply

  variables {
    read_token = ""
  }

  assert {
    condition     = length(output.read_environments) == 0 && length(github_actions_environment_secret.read_token) == 0
    error_message = "an empty read token makes nothing"
  }
}
