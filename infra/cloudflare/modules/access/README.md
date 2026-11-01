# access

One Cloudflare Access application per project, over that project's own
hostnames, so each project's stamps carry an audience no other server accepts.

| Resource | Per | Name |
| --- | --- | --- |
| `cloudflare_zero_trust_access_application.project` | project | `<name_prefix>board <label>` |
| `cloudflare_zero_trust_access_policy.people` | project with emails or domains | `<name_prefix><label> people`, `allow` |
| `cloudflare_zero_trust_access_policy.service_tokens` | project with service tokens | `<name_prefix><label> service tokens`, `non_identity` |

A project with nobody listed gets no `allow` policy, so it admits no person.
Applications carry `prevent_destroy`. The email list is wrapped in
`sensitive()`, so a plan does not print it.

Inputs: `account_id`, `name_prefix`, `session_duration`, `projects` (label →
hosts, emails, email domains, service token names), `service_token_ids`
(token name → id). Output: `projects` (label → audience and hosts).
