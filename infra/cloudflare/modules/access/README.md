# access

One Cloudflare Access application per project, over that project's own
hostnames, so each project's stamps carry an audience no other server accepts.

| Resource | Per | Name |
| --- | --- | --- |
| `cloudflare_zero_trust_access_application.project` | project | `<name_prefix>board <label>` |
| `cloudflare_zero_trust_access_policy.people` | project with emails or domains | `<name_prefix><label> people`, `allow` |
| `cloudflare_zero_trust_access_policy.service_tokens` | project with service tokens | `<name_prefix><label> service tokens`, `non_identity` |
| `cloudflare_zero_trust_access_service_token.project` | service token name, across projects | `<name_prefix><name>` |

A project with nobody listed gets no `allow` policy, so it admits no person.
Applications and service tokens carry `prevent_destroy`. A token is never
created by an apply: `cf:apply` makes a missing one first, keeps its secret in
the Keychain, and the root imports it (`../../service-tokens.ts`), so no
`client_secret` enters the state. The email list is wrapped in
`sensitive()`, so a plan does not print it.

Inputs: `account_id`, `name_prefix`, `session_duration`, `projects` (label →
hosts, emails, email domains, service token names). Output: `projects` (label → audience and hosts).
