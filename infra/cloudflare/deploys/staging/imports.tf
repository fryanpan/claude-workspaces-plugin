# Staging adopts nothing but its own service tokens. The keeper's token run
# (`keeper-run.ts tokens`) makes a missing token (named `staging <name>`) before terraform runs and keeps its
# secret in the Keychain, then this imports it, so the provider never creates
# one and the state never holds a `client_secret`
# (`infra/cloudflare/service-tokens.ts`).

import {
  for_each = var.service_token_ids
  to       = module.stack.module.access.cloudflare_zero_trust_access_service_token.project[each.key]
  id       = "accounts/${var.account_id}/${each.value}"
}
