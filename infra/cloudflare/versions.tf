# Every Cloudflare resource this repo configures, in one OpenTofu config.
# Run it through `bun run cf:plan` / `bun run cf:apply` (README.md), which
# assemble the variables from the gitignored local configs and put the API
# token into tofu's environment only.

terraform {
  required_version = ">= 1.8.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.28"
    }
  }

  # Local state only, under a gitignored directory the wrapper keeps at mode
  # 700 with every file in it 600. There is no remote backend.
  backend "local" {
    path = "state/terraform.tfstate"
  }
}

# The token comes from CLOUDFLARE_API_TOKEN, which the wrapper sets for the
# tofu process alone. It is never a variable, so it never enters the state.
provider "cloudflare" {}
