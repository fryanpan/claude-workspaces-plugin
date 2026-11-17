# The apps' secrets root against a mock provider: no token, no GitHub call,
# no state. Run by `bun run check:cloudflare-tf`.

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

variables {
  repository_owner = "harborlight"
  repository       = "riverbend"
  secrets = {
    RESEND_API_KEY                   = "fixture-resend-saltmarsh"
    SIGNIN_TEST_GOOGLE_CLIENT_ID     = "fixture-client-harborlight"
    SIGNIN_TEST_GOOGLE_CLIENT_SECRET = "fixture-secret-riverbend"
  }
}

run "each_secret_goes_to_the_environment_with_its_own_value" {
  command = apply

  assert {
    condition = output.environment_secrets == tolist([
      "RESEND_API_KEY", "SIGNIN_TEST_GOOGLE_CLIENT_ID", "SIGNIN_TEST_GOOGLE_CLIENT_SECRET",
    ])
    error_message = "the three go to the environment"
  }

  assert {
    condition = (
      github_actions_environment_secret.app["RESEND_API_KEY"].value == "fixture-resend-saltmarsh" &&
      github_actions_environment_secret.app["SIGNIN_TEST_GOOGLE_CLIENT_ID"].value == "fixture-client-harborlight" &&
      github_actions_environment_secret.app["SIGNIN_TEST_GOOGLE_CLIENT_SECRET"].value == "fixture-secret-riverbend"
    )
    error_message = "each secret holds its own value"
  }

  assert {
    condition     = alltrue([for s in github_actions_environment_secret.app : s.environment == "cloudflare-prod" && s.repository == "riverbend"])
    error_message = "every secret is in cloudflare-prod, none a repository secret a pull request could read"
  }
}

run "a_name_left_out_is_not_written" {
  command = apply

  variables {
    secrets = {
      RESEND_API_KEY = "fixture-resend-saltmarsh"
    }
  }

  assert {
    condition     = output.environment_secrets == tolist(["RESEND_API_KEY"])
    error_message = "only the given name is written"
  }
}

run "an_empty_value_is_refused" {
  command = plan

  variables {
    secrets = {
      RESEND_API_KEY = ""
    }
  }

  expect_failures = [var.secrets]
}

run "a_lower_case_name_is_refused" {
  command = plan

  variables {
    secrets = {
      resend_api_key = "fixture-resend-saltmarsh"
    }
  }

  expect_failures = [var.secrets]
}

run "an_environment_other_branches_can_deploy_to_gets_no_secret" {
  command = plan

  override_data {
    target = data.github_repository_environment_deployment_policies.deploy
    values = {
      policies = tolist([{ pattern = "*", type = "branch" }])
    }
  }

  expect_failures = [github_actions_environment_secret.app]
}

run "protected_branches_mode_is_not_main_alone" {
  command = plan

  override_data {
    target = data.github_rest_api.environment
    values = {
      body = "{\"deployment_branch_policy\":{\"protected_branches\":true,\"custom_branch_policies\":false}}"
    }
  }

  expect_failures = [github_actions_environment_secret.app]
}
