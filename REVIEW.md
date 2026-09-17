# Review instructions

For the Code Review agents on this repo. Project context is in
[CLAUDE.md](CLAUDE.md); this file only changes how a review behaves.

## What Important means here

Reserve Important for a finding that leaks data, destroys user content, or
ships something nobody can reach:

- A secret, key, token, real person's name or absolute `/Users/<name>/…` path
  in any committed file.
- A route, webhook or share surface that widens what an unauthenticated or
  share visitor can read.
- A hard delete where a soft delete exists.
- A new board or doc event missing from any of the three sinks below.
- A `packages/plugin/**` change with no version bump, or one that does not move
  past `origin/main`.

Style, naming and refactoring are Nit at most.

## Always check

**Security review.** A diff touching a route, a token or signing scheme, a
share surface, a webhook or an auth default answers the seven headings in
`.claude/rules/security-review.md` in the PR body. An unanswered heading blocks
the merge.

**Public-repo scrub.** This repo is public. No real names, hostnames, keys or
customer content in code, tests, fixtures, docs, commit messages or the PR
body. Fixtures use Harborlight, Riverbend, Saltmarsh, Alice or Bob. Flag any
new file extension that the leak gate does not scan.

**Launch discipline.** A capability nobody can find is not shipped. A new MCP
verb, skill or board flow updates the skill or rules file an agent reads at
session start, and the PR body names which one. A feature reachable only by
someone who read the diff is Important.

**Events reach all three sinks.** A new board or doc event says in the PR body
what each of these gets:

1. **Weekly-review analytics** — the audit log row, written before any
   listener runs.
2. **Agent notification** — on the SSE fan-out, or in `ANALYTICS_ONLY_EVENTS`
   with a reason. An agent is never woken by its own action.
3. **Human status** — what changes on Bryan's board, or why nothing does.

**Tests.** Behaviour, not source shape. A new module under
`packages/server/src` lands with a unit test that drives it directly.

## Do not report

- Anything `bun run verify` already enforces: lint, formatting, types, file
  length, import direction, import cycles, coverage, bundle size.
- Generated files: `packages/plugin/mcp/index.js`, lockfiles, `.coverage/`.
- Test code that intentionally violates a production rule.

## Cap the nits

At most five Nits per review. If there are more, say "plus N similar" in the
summary rather than posting them inline.

## Re-review

After the first round, report Important findings only, and open the summary
with one line naming what the previous round raised that is now fixed.
