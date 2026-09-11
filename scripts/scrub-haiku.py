#!/usr/bin/env python3
"""Haiku-based diff scrub pass — catches leaks the regex check can't.

Invoked by .githooks/pre-push AFTER scripts/scrub-check.py passes. The regex
check is fast and deterministic for known patterns (registry project names,
denylist entries). Haiku adds a context-aware AI scan for things the regex
can't anticipate: unrecognized real names, contextual identifiers, quotes
that reveal a private person, financial/health specifics in personal context.

Usage:
  scrub-haiku.py --push-tip SHA [--remote NAME] [--already-public SHA]...
                                       # what this push makes public (the hook's mode)
  scrub-haiku.py --diff-range A..B    # scan diff in range
  scrub-haiku.py                       # read diff from stdin

`--push-tip` is the mode the pre-push hook uses. It asks about the COMMITS a
push would publish rather than comparing two trees, because a tree comparison
re-presents everything `main` gained since the branch point as an addition the
moment the branch merges `main` — which the conventions require before the
final push. See scrub_git.py for the measurement and why `--cc` is load-bearing.

Exit codes:
  0  clean — or this layer could not run and UNAVAILABLE_POLICY says warn
  1  blocked — leaks found, or this layer could not run and the policy says
     block. Either way the hook fails the push.

There is no quiet third code any more. "Could not run" used to return 2, and
main() turned every 2 into 0 behind one line of stderr, so a gate that could
not look answered a push exactly as it answers one it looked at and found
clean. A real name reached this public repo's main branch that way. Now the
three ways it can fail to run are told apart, said out loud in a banner, and
each has a recorded answer below.

Bypass entirely with SCRUB_SKIP=1. Skip just Haiku with SCRUB_SKIP_HAIKU=1.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from typing import NamedTuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scrub_git  # noqa: E402

MODEL = "claude-haiku-4-5-20251001"
# Overridable so the self-test can drive every failure case against a stub on
# loopback without spending a key or reaching the network, and so a deployment
# behind a gateway can point this at the gateway. Unset, it is the real API.
API_URL = os.environ.get("SCRUB_HAIKU_API_URL") or "https://api.anthropic.com/v1/messages"
API_TIMEOUT_SEC = 30
# Approx chars-to-tokens (Anthropic English ~3.5 chars/token; be conservative at 4).
# 80K tokens of diff caps out a Haiku call comfortably.
MAX_DIFF_CHARS = 80_000 * 4

SYSTEM_PROMPT = """You are a sensitive-content scanner. You will be shown a git diff that's about to be pushed to a public GitHub repository. Your job is to spot anything that would leak private information once that push lands.

**What counts as a leak (flag it):**
- Real personal names, except any listed under "This repository's maintainers" below
- Email addresses, phone numbers, postal addresses, SSNs, financial account numbers
- Specific dollar amounts in personal context (taxes, donations, balances, salaries)
- Tax-document names tied to a specific person (Form 8606, Schedule D, kiddie tax, IRA backdoor, capital loss carryover, etc.)
- Health/medical specifics (CGM readings, HbA1c values, medications, diagnoses, doctor visits)
- Specific travel destinations + dates in personal context (e.g., "Berlin trip in June")
- Names of OTHER private projects — codenames the maintainer hasn't already published elsewhere
- API keys, OAuth tokens, bot tokens, Discord user IDs, webhook secrets
- Private internal URLs (Linear/Notion/Asana IDs that aren't already shared publicly)
- Quoted chat conversations or first-person snippets that identify a private person
- Filesystem paths containing a real username (e.g., `/Users/realname/...`)

**What does NOT count as a leak (don't flag):**
- The repo's own name in self-references (a repo's README / CLAUDE.md / package metadata legitimately names itself)
- A maintainer name listed below, wherever it appears — prose, docs, comments, metadata
- The literal placeholder `<commit identity already public on the remote>` —
  it marks a git Author/Co-authored-by line whose identity this tool already
  verified is on the remote and redacted before you saw the diff
- Public technical references (Anthropic, Claude, GitHub URLs to known public repos, well-known libraries)
- Generic placeholders: <user>, <your-tailnet>, your-username/example, my-project, the user
- Function/variable/class names, programming jargon, code comments about the code itself
- Standard package descriptions ("a Python module that does X")
- **Anything on a line that is not being ADDED.** A line being removed by this
  push is not a leak: a commit that deletes one is the fix, not the leak, and
  flagging it blocks the one change that improves the situation. Judge only
  added lines and, for context, unchanged ones. If a name appears only on
  removed lines, that is a removal — say nothing.

  Read the markers carefully, because merge commits are shown as **combined
  diffs** with TWO marker columns rather than one (`--`, `-` followed by a
  space, ` -`, `+ `, ` +`, `++`). A line is an addition only if a `+` appears
  in one of those leading columns. Markers that are only `-` or blank mean the
  line is being removed or is unchanged — including the very common case where
  a conflict was resolved by keeping one side, which renders the discarded
  side as removals. That content is not going anywhere new.

**Output format — respond in EXACTLY this shape:**

If clean:
VERDICT: CLEAN

If leaks found:
VERDICT: LEAKS_FOUND
LEAKS:
- <file>:<line> — <one-line description of leak>
- <file>:<line> — <one-line description of leak>

**Only the VERDICT line is read.** A tool blocks or allows the push on that
word alone; explanatory notes reach a person only after it has already blocked.
So do not list an item you have concluded is safe and then explain why — apply
the rules above first, and if nothing survives them, the answer is
`VERDICT: CLEAN` with no LEAKS section. Listing removed-line content with a
note saying "this is a removal, the push is safe" blocks the push and says the
opposite of what you meant.

Be conservative about content that IS being added — when borderline, flag it.
The human can override with SCRUB_SKIP=1 after reviewing your reasoning."""


def system_prompt(maintainers: "set[str] | None" = None) -> str:
    """The scanner prompt, told who this repository's maintainers are.

    Passed as data rather than hardcoded, so the rule travels to any repo and
    names nobody this checkout cannot already prove is a published author
    here. With no maintainers resolved the prompt says so, and every real name
    flags exactly as it did before.
    """
    names = sorted(n for n in (maintainers or set()) if n.strip())
    if not names:
        listed = (
            "None could be resolved for this repository, so treat EVERY real "
            "personal name as a potential leak."
        )
    else:
        listed = "\n".join(f"- {n}" for n in names) + (
            "\n\nThese names are already published across this repository and are "
            "NEVER a leak in it, in any context: prose, documentation, code "
            "comments, metadata, an attribution, a dated decision record, a "
            "task assignment, a quoted preference. A maintainer name next to a "
            "date is a changelog entry, not personal information. Do not report "
            "such a line at all — not as a leak, and not with a note explaining "
            "why it is safe.\n\n"
            "Only what is on the line BESIDES the name can make it a leak: an "
            "email address, a home address, a medical or financial detail, a "
            "credential. Judge that content on its own merits, exactly as you "
            "would if no name were present.\n\n"
            "Every OTHER real person's name is still a leak, including a "
            "co-author, a colleague, a reviewer, or anyone quoted or thanked."
        )
    return f"{SYSTEM_PROMPT}\n\n**This repository's maintainers:**\n{listed}"


# Overridable for the same reason as API_URL: the self-test points it at a
# service name that does not exist, so the "no key at all" case is reachable
# without touching — or reading — the real entry.
KEYCHAIN_SERVICE = os.environ.get("SCRUB_HAIKU_KEYCHAIN_SERVICE") or "scrub-haiku-api-key"

# ---------------------------------------------------------------------------
# What this gate does when it CANNOT RUN
# ---------------------------------------------------------------------------
#
# Three different things go wrong here, and they are not the same condition:
#
#   exhausted    the key is valid and over its usage cap. The API answers HTTP
#                400 naming the date access returns. Nobody here can shorten
#                that wait.
#   absent       no key resolves, or the one that does is rejected. Somebody's
#                install is broken, and it is fixable in a minute.
#   unreachable  network failure, timeout, or a reply this tool cannot read.
#                Transient — the next push may well work.
#
# All three used to collapse into one `return 2`.
#
# WHICH OF THEM BLOCKS A PUSH IS A PROJECT DECISION, and it is recorded here so
# that the answer is a line in the gate rather than something you learn by
# reading a hook. The three settings, exhaustively:
#
#   "warn-all"               never block; print the banner, let the push go.
#   "block-all"              block on any of the three.
#   "block-except-exhausted" block on absent and unreachable — each is
#                            somebody's to fix today — and warn on exhausted,
#                            which nobody can fix before the reset date.
#
# THE VALUE BELOW IS THE PRE-DECISION ONE, and it is deliberately the weakest:
# "warn-all" is what this gate already did, so the change shipped alongside it
# is what a person is TOLD, not whether their push succeeds. Choosing among the
# three is the repo owner's call and is filed as a decision on the ticket this
# came from; when it is answered, this one assignment is the whole edit.
UNAVAILABLE_POLICY = "warn-all"

EXHAUSTED = "exhausted"
ABSENT = "absent"
UNREACHABLE = "unreachable"

POLICIES = {
    "warn-all": {EXHAUSTED: "warn", ABSENT: "warn", UNREACHABLE: "warn"},
    "block-all": {EXHAUSTED: "block", ABSENT: "block", UNREACHABLE: "block"},
    "block-except-exhausted": {
        EXHAUSTED: "warn", ABSENT: "block", UNREACHABLE: "block",
    },
}

POLICY_ENV = "SCRUB_HAIKU_UNAVAILABLE"


class Policy(NamedTuple):
    """Which policy is being applied, and what was asked for."""

    name: str   # a key of POLICIES — the one actually applied
    asked: str  # what the env var or the constant said, verbatim
    known: bool  # False when `asked` names no policy, and `name` is the fallback


def resolve_policy() -> Policy:
    """The recorded policy, env override first.

    An unrecognised name falls back to `block-all` rather than to the recorded
    value: a leak gate whose setting is a typo is a leak gate nobody has read,
    and the safe reading of "I don't know what I was told to do" is to stop.
    """
    asked = os.environ.get(POLICY_ENV) or UNAVAILABLE_POLICY
    if asked in POLICIES:
        return Policy(asked, asked, True)
    return Policy("block-all", asked, False)


class Unavailable(NamedTuple):
    """This layer could not run, and why — in words, never carrying a key."""

    case: str    # EXHAUSTED | ABSENT | UNREACHABLE
    detail: str  # one line a person can act on
    hint: str = ""  # what would fix it, or "" when nothing here can


KEY_HINT = (
    "Store one with:  security add-generic-password -a \"$USER\" "
    f"-s {KEYCHAIN_SERVICE} -w   (omit the value after -w; it prompts, so the "
    "key stays out of shell history) — or set SCRUB_HAIKU_API_KEY."
)

# Substrings that mark an HTTP error as "this key is over its cap" rather than
# as a transient fault. Matched against the API's own error message, which is
# where the dated reset lives too, so the banner can quote it.
CAP_MARKERS = ("usage limit", "credit balance", "spend limit", "spending limit", "quota")


def api_error_message(body: str) -> str:
    """The API's `error.message`, else a trimmed body. Never a key — an error
    body from the API echoes the request's headers nowhere."""
    try:
        parsed = json.loads(body)
        message = parsed["error"]["message"]
    except (json.JSONDecodeError, KeyError, TypeError):
        message = None
    if isinstance(message, str) and message.strip():
        return message.strip()[:300]
    return body.strip()[:200] or "(no response body)"


def classify_http_error(status: int, body: str) -> Unavailable:
    """Sort an HTTP failure into one of the three cases.

    The cap case is recognised by the message, not the status: the observed
    answer for an over-cap key is a 400 `invalid_request_error`, the same
    status a malformed request would draw, so the status alone cannot tell
    "you have spent your budget" from "your JSON is wrong".
    """
    message = api_error_message(body)
    lowered = message.lower()
    if any(marker in lowered for marker in CAP_MARKERS):
        return Unavailable(EXHAUSTED, f"HTTP {status}: {message}")
    if status in (401, 403):
        return Unavailable(
            ABSENT,
            f"HTTP {status}: the API rejected the key it was given — {message}",
            KEY_HINT,
        )
    return Unavailable(UNREACHABLE, f"HTTP {status} from the API: {message}")


BANNER_RULE = "=" * 74


def print_banner(unavailable: Unavailable, policy: Policy, action: str) -> None:
    """Say, unmissably, that only half the gate ran.

    One line of stderr among a push's other output is what this had before,
    and it is what let a real name through: the line was printed, and nobody
    saw it. The frame is the point.
    """
    lines = [
        "",
        BANNER_RULE,
        "  LEAK GATE: ONLY HALF OF IT RAN",
        BANNER_RULE,
        f"  The name-aware scanner could not run — {unavailable.case}.",
        f"  {unavailable.detail}",
    ]
    if unavailable.hint:
        lines.append(f"  {unavailable.hint}")
    lines += [
        "",
        "  The regex scanner ran and passed. It matches names and patterns it",
        "  has been given. It does not recognise an unfamiliar real name, and",
        "  recognising those is the whole job of the layer that did not run.",
        "",
    ]
    if action == "block":
        lines.append(f"  PUSH BLOCKED.  [policy: {policy.name}]")
    else:
        lines += [
            f"  PUSH ALLOWED on the regex layer alone.  [policy: {policy.name}]",
            "  Read what this push publishes before it lands.",
        ]
    lines += [BANNER_RULE, ""]
    for line in lines:
        print(line, file=sys.stderr)


def read_keychain(service: str) -> str | None:
    """Read a generic-password entry from the macOS Keychain.

    Mirrors packages/server/src/share/keychain.ts, which does the same for the
    Cloudflare token. The Keychain is preferred over an exported env var
    because every Claude Code session on this machine runs as the same user
    and inherits the same environment — an exported key is readable by every
    agent in the fleet, and this one is billed.

    Returns None (never raises) on any failure: a missing entry, a locked
    Keychain, or a non-Darwin machine all mean "fall through to the env vars",
    and a scrub layer must never be the reason a push dies.
    """
    try:
        proc = subprocess.run(
            ["security", "find-generic-password", "-a", os.environ.get("USER", ""),
             "-s", service, "-w"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout.strip() or None


def call_haiku(diff_content: str) -> "int | Unavailable":
    """0 clean, 1 leaks found, or an `Unavailable` saying which way it failed."""
    # Keychain first, then the env vars. SCRUB_HAIKU_API_KEY is preferred over
    # ANTHROPIC_API_KEY so this layer can use a key separate from
    # general-purpose Anthropic usage (better audit + isolated billing); the
    # env forms stay supported for CI and one-off runs.
    api_key = (
        read_keychain(KEYCHAIN_SERVICE)
        or os.environ.get("SCRUB_HAIKU_API_KEY")
        or os.environ.get("ANTHROPIC_API_KEY")
    )
    if not api_key:
        return Unavailable(
            ABSENT,
            "No API key resolved — not from the Keychain, not from the environment.",
            KEY_HINT,
        )

    body = json.dumps({
        "model": MODEL,
        "max_tokens": 1024,
        "system": system_prompt(scrub_git.maintainer_names()),
        "messages": [{
            "role": "user",
            "content": f"Scan this diff for leaks:\n\n```diff\n{diff_content}\n```",
        }],
    }).encode("utf-8")

    req = urllib.request.Request(
        API_URL,
        data=body,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=API_TIMEOUT_SEC) as resp:
            data = json.loads(resp.read())
    # HTTPError first — it is a subclass of URLError, so the order is what
    # keeps a 400 from being read as a network fault.
    except urllib.error.HTTPError as e:
        return classify_http_error(e.code, e.read().decode("utf-8", errors="replace"))
    except (urllib.error.URLError, json.JSONDecodeError, OSError) as e:
        return Unavailable(
            UNREACHABLE,
            f"The API call failed: {e}",
            "Transient. Try the push again.",
        )

    if not isinstance(data, dict):
        return Unavailable(UNREACHABLE, "The API returned JSON that is not an object.")
    content = data.get("content") or []
    if not content:
        return Unavailable(UNREACHABLE, "The API returned a reply with no content.")

    text = str(content[0].get("text", "")).strip()

    if "VERDICT: CLEAN" in text:
        return 0
    if "VERDICT: LEAKS_FOUND" in text:
        print("[scrub-haiku] Haiku flagged leaks:", file=sys.stderr)
        for line in text.split("\n"):
            print(f"  {line}", file=sys.stderr)
        return 1

    return Unavailable(
        UNREACHABLE,
        f"The scanner's reply carried no verdict line: {text[:200]!r}",
    )


def get_diff(range_spec: str) -> str:
    try:
        r = subprocess.run(
            ["git", "diff", range_spec],
            capture_output=True, text=True, check=True,
        )
        return r.stdout
    except subprocess.CalledProcessError:
        return ""


def main() -> int:
    if os.environ.get("SCRUB_SKIP") == "1":
        return 0
    if os.environ.get("SCRUB_SKIP_HAIKU") == "1":
        print("[scrub-haiku] SCRUB_SKIP_HAIKU=1 — bypassing Haiku check.", file=sys.stderr)
        return 0

    args = sys.argv[1:]
    if "--help" in args or "-h" in args:
        print(__doc__)
        return 0

    try:
        rev_args = scrub_git.rev_args_from_cli(args)
    except ValueError as e:
        print(f"[scrub-haiku] {e}", file=sys.stderr)
        return 2

    if rev_args is not None:
        diff = scrub_git.push_patch(rev_args)
    elif "--diff-range" in args:
        idx = args.index("--diff-range")
        if idx + 1 >= len(args):
            print("[scrub-haiku] --diff-range needs a value", file=sys.stderr)
            return 2
        diff = get_diff(args[idx + 1])
    else:
        diff = sys.stdin.read()

    if not diff.strip():
        return 0

    if len(diff) > MAX_DIFF_CHARS:
        diff = diff[:MAX_DIFF_CHARS]
        print(
            f"[scrub-haiku] diff truncated to ~{MAX_DIFF_CHARS // 4} tokens for Haiku call.",
            file=sys.stderr,
        )

    result = call_haiku(diff)
    if not isinstance(result, Unavailable):
        return result

    policy = resolve_policy()
    if not policy.known:
        print(
            f"[scrub-haiku] {POLICY_ENV}/UNAVAILABLE_POLICY is set to "
            f"{policy.asked!r}, which names no policy. Applying "
            f"{policy.name!r} — a gate told something it cannot read stops. "
            f"Valid settings: {', '.join(sorted(POLICIES))}.",
            file=sys.stderr,
        )
    action = POLICIES[policy.name][result.case]
    print_banner(result, policy, action)
    return 1 if action == "block" else 0


if __name__ == "__main__":
    sys.exit(main())
