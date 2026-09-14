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
  scrub-haiku.py --spend-report        # today's spend on the key, every repo; no scan

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
ways it can fail to run are told apart, said out loud in a banner, and each
has a recorded answer below.

`--spend-report` exits 0, or 2 when the spend ledger cannot be read.

The key is shared with other repositories on this machine, and so is its
daily spend cap: see "The key's daily spend cap" below.

Bypass entirely with SCRUB_SKIP=1. Skip just Haiku with SCRUB_SKIP_HAIKU=1.
"""

from __future__ import annotations

import functools
import json
import math
import os
import subprocess
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Dict, List, NamedTuple, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scrub_git  # noqa: E402

MODEL = "claude-haiku-4-5-20251001"
# Overridable so the self-test can drive every failure case against a stub on
# loopback without spending a key or reaching the network, and so a deployment
# behind a gateway can point this at the gateway. Unset, it is the real API.
API_URL = os.environ.get("SCRUB_HAIKU_API_URL") or "https://api.anthropic.com/v1/messages"
API_TIMEOUT_SEC = 30
# Approx chars-to-tokens (Anthropic English ~3.5 chars/token; be conservative at 4).
#
# This used to be "what fits in one call", and since the push is now read in
# pieces that is no longer what it is. It is a COST CEILING, and a known hole:
# a push past it has its tail truncated, and truncated content is not scanned
# by anything. The measured case is close enough to matter — a four-commit
# branch in scrub-recall-cases.json runs 325KB and loses its last 5KB — so
# whether this rises, or becomes a refusal to scan rather than a silent trim,
# is a decision for whoever owns the spend. It is stated on stderr when it
# fires; nothing turns it into a verdict.
MAX_DIFF_CHARS = 80_000 * 4
# The reply now enumerates the names it found before it gives a verdict, and
# the verdict is the last line. 1024 was enough for a bare verdict and is not
# enough for a sweep over a large diff: a reply cut off before its last line
# carries no verdict at all, which the caller reads as "could not run" and the
# shipped policy turns into a blocked push. The list is capped at 25 entries in
# the prompt; this is that cap with several times its worth of room.
MAX_OUTPUT_TOKENS = 4096
# How much diff goes into ONE call.
#
# Recall falls off with the size of the thing being read, and it falls off
# hard. Measured by scripts/scrub-recall.py over ten runs a case: one planted
# name blocked 10/10 inside an 11KB push and 0/10 inside the same push grown
# to 109KB, with the prompt identical and the name identical. The real commit
# that put a person's name on this repository's public main is a 200KB push
# carrying the name twice, and it read CLEAN ten times out of ten. Read in
# pieces, with the prompt below, it blocked 10/10 — and a sample of those
# runs was checked for WHAT it blocked on: the name, every time.
#
# So the push is read in pieces of this size and the verdicts are combined.
# A piece costs one extra copy of the system prompt (~2K tokens) and nothing
# else: the diff itself is read exactly once either way, and the pieces go out
# in parallel, so the wall clock is roughly one call's.
CHUNK_CHARS = 30_000
CHUNK_JOBS = 6

SYSTEM_PROMPT = """You are a sensitive-content scanner. You will be shown a git diff that's about to be pushed to a public GitHub repository. Your job is to spot anything that would leak private information once that push lands.

**A big diff does not lower the bar.** One name in ten thousand lines is the case this scan exists for — a push that carries a single person's name among a thousand ordinary ones is the likeliest shape a real leak takes, not an unlikely one. Read a long diff to the end. Do not sample it, do not decide from the commit messages what the rest probably contains, and do not let the volume of obviously-fine code persuade you that nothing in it is a name. The work below is the same work whether the diff is thirty lines or thirty thousand.

**What counts as a leak (flag it):**
- Real personal names, except any listed under "This repository's maintainers" below
- **A personal name used as sample data is still a personal name.** A test fixture, a mock payload, a doc example, a sample transcript, a seeded database row, a screenshot caption: a plausible first-and-last name in any of them is the single commonest way a real person reaches a public repository, because whoever wrote it was thinking about the code and not about the name. Judge the name, not the file it sits in. The conventional placeholders under "does NOT count" are the exception, and they are a short closed list, not a category you can reason your way into
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
- The conventional placeholder people, used as sample data: Alice, Bob, Carol, Dave, Eve, Mallory, Trent, John Doe, Jane Doe, Jane Roe, Foo, Bar, Baz, Qux — and long-dead figures used as stock examples, such as Ada Lovelace, Grace Hopper, Alan Turing. Every test suite in the world names these, and a scanner that flags them is a scanner the next person turns off. This is the whole list: a name that is not on it is not a placeholder merely because it appears in a test
- Function/variable/class names, programming jargon, code comments about the code itself — **but a quoted string is not an identifier.** Text between quotes is content: it is what the program shows somebody, or what a test says the program shows. A name inside a string literal is a name, and a file full of `expect(...).toContain("...")` is a file full of content. "This is test code" is a statement about the file, not about the strings in it, and it is not a reason to stop reading them
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

**How to answer — the name sweep comes first, always.**

Before you decide anything, sweep the ADDED lines for every run of words shaped
like a person's name — a capitalised given name, with or without a surname —
wherever it sits: prose, a string literal, a comment, a JSON value, a commit
message, a test assertion. List what you find. Then judge each one, and only
then give a verdict. Deciding first and looking afterwards is how a name in
line 4,000 of a large diff gets missed, and that is the failure this format
exists to prevent.

Three ways this sweep has actually been failed, all of them by stopping early:

- **Reading the code but not the strings in it.** A diff of test files gets
  summarised as "test code, mock implementations, variable names and technical
  comments" and waved through, while a person's name sits in the quoted text of
  a dozen assertions. Read the quoted text. It is the likeliest place in a
  source file for a name to be.
- **Stopping at the first name.** Finding one and resolving it — a maintainer,
  say — does not end the sweep. Keep going to the last added line.
- **Dismissing a short surname.** A two- or three-letter family name is one of
  the commonest surname forms there is. `Given Xx` is a full name, not a typo,
  not an abbreviation and not a variable; treat it exactly as you would a long
  one.

Cross a name off for one of exactly three reasons: it is on the maintainer
list below, it is on the closed placeholder list above, or it is not a person
at all (a library, a product, a city, a weekday, an identifier that happens to
be capitalised). Anything else stays.

Check the maintainer list FIRST, and let it be final. A name on it is crossed
off wherever it appears and whatever it appears in — a comment, a quoted
sentence, an example of copy the product should not write, a line that is
itself about naming people. Marking it `maintainer` in the sweep and then
listing it under LEAKS anyway blocks a push over the one name that cannot be
a leak here.

**"Is this a real person?" is not the question, and you cannot answer it.**
You have no way to know whether the name in a test fixture belongs to someone
or was invented on the spot, and reasoning about which it is more likely to be
is how every miss happens: the invented-sounding ones get waved through, and
about half of them turn out to be somebody. The question you can answer is
whether an unfamiliar personal name is about to be published, and for anything
not on those two lists the answer is yes. Keep it. A kept name costs one
person one look; a missed one is on a public branch forever.

List at most 25 distinct names. If you reach 25, stop listing and go straight
to the verdict — the verdict is what gets read, and it must not be crowded out.

**Respond in EXACTLY this shape:**

NAMES:
- <name> — <where> — <keep | maintainer | placeholder | not-a-person>
(or `NAMES: none` when the added lines carry no name-shaped words at all)

If nothing survived the sweep and nothing else below was found:
VERDICT: CLEAN

If anything survived, or any other leak was found:
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
# Two more came with the shared daily spend cap (below), and both are this
# tool declining to call rather than the API declining to answer:
#
#   budget             today's spend on the key, summed over every repo that
#                      writes the shared ledger, is at or over the cap. It
#                      lifts at 00:00 UTC — exhausted's twin, one level down.
#   ledger-unreadable  the ledger exists and cannot be read, so the budget
#                      check could not look. Somebody's to fix today.
#
# WHICH OF THEM BLOCKS A PUSH IS A PROJECT DECISION, and it is recorded here so
# that the answer is a line in the gate rather than something you learn by
# reading a hook. The three settings, exhaustively:
#
#   "warn-all"               never block; print the banner, let the push go.
#   "block-all"              block on any of them.
#   "block-except-exhausted" block on absent, unreachable and an unreadable
#                            ledger — each is somebody's to fix today — and
#                            warn on exhausted and budget, which nobody can
#                            fix before the reset.
#
# ANSWERED by the repo owner on 2026-09-10: "Always block". A push that the
# name-aware layer never saw is a push nobody checked for an unfamiliar real
# name, and the regex layer passing says nothing about that — so the gate
# refuses rather than waving it through with a banner. Exhausted is included
# deliberately: nobody can fix a spend cap before its reset date, and a window
# where the weaker check is the only one running is exactly the window this
# decision exists to close. SCRUB_HAIKU_UNAVAILABLE overrides it for a push
# that genuinely cannot wait, and says so in the banner when it does.
#
# The budget and unreadable-ledger cases were added under that same decision
# rather than beside it: a push stopped by the cap is a push the name-aware
# layer never saw, which is the window "Always block" was chosen to close.
UNAVAILABLE_POLICY = "block-all"

EXHAUSTED = "exhausted"
ABSENT = "absent"
UNREACHABLE = "unreachable"
BUDGET = "budget"
LEDGER = "ledger-unreadable"

POLICIES = {
    "warn-all": {
        EXHAUSTED: "warn", ABSENT: "warn", UNREACHABLE: "warn",
        BUDGET: "warn", LEDGER: "warn",
    },
    "block-all": {
        EXHAUSTED: "block", ABSENT: "block", UNREACHABLE: "block",
        BUDGET: "block", LEDGER: "block",
    },
    "block-except-exhausted": {
        EXHAUSTED: "warn", ABSENT: "block", UNREACHABLE: "block",
        BUDGET: "warn", LEDGER: "block",
    },
}

POLICY_ENV = "SCRUB_HAIKU_UNAVAILABLE"
# Another repo's copy of this scanner warns on a cap hit unless this is "1".
# Here the table above decides, so the variable is honoured in the one
# direction that maps onto it: "1" makes the budget case block under any
# policy. It never loosens one — SCRUB_HAIKU_UNAVAILABLE is the only knob that
# does — so a machine-wide "1" means the same thing in both repositories.
BUDGET_BLOCK_ENV = "SCRUB_HAIKU_BUDGET_BLOCK"


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

    case: str    # EXHAUSTED | ABSENT | UNREACHABLE | BUDGET | LEDGER
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


# ---------------------------------------------------------------------------
# The key's daily spend cap, shared with every repo that uses the key
# ---------------------------------------------------------------------------
#
# Another repository on this machine scans with the same key, and the key has
# hit its provider limit once already. The cap belongs to the key, not to a
# repository, so every copy of this scanner writes each call's cost to ONE
# ledger and sums every repo's entries before it calls. The file format is a
# contract between those copies — the path, the keys, the prices — and is not
# this file's to change alone.
#
# One JSON object per line. Each is written with a single `write` on an
# O_APPEND descriptor, which is what keeps up to CHUNK_JOBS concurrent pieces
# (and other repos' pushes) from interleaving inside a line: the kernel moves
# to end-of-file and writes the whole buffer as one step. No lock file.

SPEND_LOG_ENV = "SCRUB_HAIKU_SPEND_LOG"
DEFAULT_SPEND_LOG = os.path.join("~", ".local", "state", "scrub-haiku", "spend.jsonl")
DAILY_USD_ENV = "SCRUB_HAIKU_DAILY_USD"
DEFAULT_DAILY_USD = 1.00
# Haiku 4.5 list price, dollars per million tokens.
USD_PER_MTOK_INPUT = 1.00
USD_PER_MTOK_OUTPUT = 5.00

# Exactly these keys, in this order — both repositories read what either wrote.
LEDGER_KEYS = (
    "ts", "date", "repo", "range", "model", "diff_chars",
    "input_tokens", "output_tokens", "estimated_usd", "verdict",
)


class LedgerUnreadable(Exception):
    """The ledger exists and could not be read. Never the same as $0."""


class Spend(NamedTuple):
    """Today's entries, summed."""

    total: float
    by_repo: Dict[str, float]
    malformed: int  # lines skipped because they were not a readable entry


def spend_log_path() -> str:
    return os.path.expanduser(os.environ.get(SPEND_LOG_ENV) or DEFAULT_SPEND_LOG)


def utc_today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


@functools.lru_cache(maxsize=None)
def _warn_bad_cap(raw: str) -> None:
    print(
        f"[scrub-haiku] {DAILY_USD_ENV}={raw!r} is not a dollar amount; "
        f"applying the default cap of ${DEFAULT_DAILY_USD:.2f}.",
        file=sys.stderr,
    )


def daily_cap() -> float:
    """The cap in dollars. A value that is not a finite, non-negative number
    applies the default rather than no cap, and says so."""
    raw = os.environ.get(DAILY_USD_ENV)
    if raw is None or not raw.strip():
        return DEFAULT_DAILY_USD
    try:
        value = float(raw)
    except ValueError:
        value = math.nan
    if not math.isfinite(value) or value < 0:
        _warn_bad_cap(raw)
        return DEFAULT_DAILY_USD
    return value


def spent_today(path: Optional[str] = None, today: Optional[str] = None) -> Spend:
    """Today's (UTC) spend on the key, from every repository's entries.

    Three outcomes, and only one of them is zero: no ledger file is $0 — no
    scan has been recorded yet today or ever. A readable ledger is its sum,
    with lines that are not a readable entry skipped and counted. A ledger
    that exists but cannot be read raises `LedgerUnreadable`: reading it as $0
    is how a cap stops capping without anybody being told.
    """
    path = path or spend_log_path()
    today = today or utc_today()
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except FileNotFoundError:
        return Spend(0.0, {}, 0)
    except OSError as e:
        raise LedgerUnreadable(f"{path}: {e.strerror or e}") from e
    total = 0.0
    by_repo: Dict[str, float] = {}
    malformed = 0
    for line in lines:
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
            date = entry["date"]
            usd = entry["estimated_usd"]
        except (json.JSONDecodeError, KeyError, TypeError):
            malformed += 1
            continue
        # A negative amount would cancel real spend; a bool is an int to Python.
        if (isinstance(usd, bool) or not isinstance(usd, (int, float))
                or not math.isfinite(usd) or usd < 0):
            malformed += 1
            continue
        if date != today:
            continue
        repo = str(entry.get("repo") or "unknown")
        total += usd
        by_repo[repo] = by_repo.get(repo, 0.0) + usd
    return Spend(total, by_repo, malformed)


def estimate_usd(input_tokens: int, output_tokens: int) -> float:
    return (input_tokens * USD_PER_MTOK_INPUT + output_tokens * USD_PER_MTOK_OUTPUT) / 1_000_000


@functools.lru_cache(maxsize=None)
def repo_name() -> str:
    """This repository's top-level directory name.

    Read from the COMMON git dir, so a push from a linked worktree is booked
    to the repository and not to whatever the worktree's folder is called.
    """
    def git(*args: str) -> str:
        try:
            return subprocess.run(
                ["git", *args], capture_output=True, text=True, check=True,
            ).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            return ""

    common = git("rev-parse", "--path-format=absolute", "--git-common-dir").rstrip("/")
    if os.path.basename(common) == ".git":
        return os.path.basename(os.path.dirname(common))
    top = git("rev-parse", "--show-toplevel")
    return os.path.basename(top or os.getcwd()) or "unknown"


def _token_count(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def record_spend(scan_range: str, diff_chars: int, usage: dict, verdict: str,
                 path: Optional[str] = None) -> Optional[str]:
    """Append one call's cost. None on success, else what went wrong."""
    path = path or spend_log_path()
    input_tokens = _token_count(usage.get("input_tokens"))
    output_tokens = _token_count(usage.get("output_tokens"))
    now = datetime.now(timezone.utc)
    entry = dict(zip(LEDGER_KEYS, (
        now.isoformat(timespec="seconds").replace("+00:00", "Z"),
        now.strftime("%Y-%m-%d"),
        repo_name(),
        scan_range,
        MODEL,
        diff_chars,
        input_tokens,
        output_tokens,
        round(estimate_usd(input_tokens, output_tokens), 6),
        verdict,
    )))
    line = (json.dumps(entry) + "\n").encode("utf-8")
    try:
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            written = os.write(fd, line)
        finally:
            os.close(fd)
    except OSError as e:
        return f"{path}: {e.strerror or e}"
    if written != len(line):
        return f"{path}: short write ({written} of {len(line)} bytes)"
    return None


def check_budget() -> Optional[Unavailable]:
    """None when a call may go out; otherwise why it may not."""
    cap = daily_cap()
    try:
        spend = spent_today()
    except LedgerUnreadable as e:
        return Unavailable(
            LEDGER,
            f"The budget check could not look: the spend ledger exists but "
            f"cannot be read ({e}). Nothing was called, because an unread "
            "ledger is not a ledger reading $0.",
            f"Fix the file's permissions or move it aside, or point "
            f"{SPEND_LOG_ENV} at a readable path.",
        )
    if spend.total >= cap:
        skipped = f" ({spend.malformed} unreadable line(s) skipped)" if spend.malformed else ""
        return Unavailable(
            BUDGET,
            f"Today's spend on this key, across every repo: ${spend.total:.4f}. "
            f"Daily cap: ${cap:.2f}.{skipped}",
            f"The day rolls over at 00:00 UTC. `scrub-haiku.py --spend-report` "
            f"shows who spent it; {DAILY_USD_ENV} raises the cap for one push.",
        )
    return None


def spend_report() -> int:
    """Today's total, the cap, and each repo's share. Scans nothing."""
    cap = daily_cap()
    today = utc_today()
    path = spend_log_path()
    try:
        spend = spent_today(path, today)
    except LedgerUnreadable as e:
        print(f"[scrub-haiku] the budget check could not look: {e}", file=sys.stderr)
        return 2
    state = ("REACHED — the scanner will not call" if spend.total >= cap
             else f"${cap - spend.total:.4f} left")
    print(f"scrub-haiku spend on {today} (UTC), every repo on this key")
    print(f"  today:  ${spend.total:.4f}")
    print(f"  cap:    ${cap:.2f}  ({state})")
    print("  by repo:")
    if not spend.by_repo:
        print("    (nothing recorded today)")
    for repo, usd in sorted(spend.by_repo.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"    {repo:<36} ${usd:.4f}")
    if spend.malformed:
        print(f"  unreadable lines skipped: {spend.malformed}")
    print(f"  ledger: {path}")
    return 0


BANNER_RULE = "=" * 74

# What the banner's headline says the scan did not do. Every case gets one:
# a banner that names the cause without saying "this is not a clean verdict"
# can be read as a verdict with a footnote.
HEADLINES = {
    BUDGET: "SCAN DID NOT RUN — daily budget reached",
    LEDGER: "SCAN DID NOT RUN — the budget check could not look",
}
DEFAULT_HEADLINE = "SCAN DID NOT RUN — this is not a clean verdict"


def print_banner(unavailable: Unavailable, policy: Policy, action: str,
                 policy_label: str = "") -> None:
    """Say, unmissably, that only half the gate ran.

    One line of stderr among a push's other output is what this had before,
    and it is what let a real name through: the line was printed, and nobody
    saw it. The frame is the point.
    """
    label = policy_label or policy.name
    lines = [
        "",
        BANNER_RULE,
        "  LEAK GATE: ONLY HALF OF IT RAN",
        f"  {HEADLINES.get(unavailable.case, DEFAULT_HEADLINE)}",
        BANNER_RULE,
        f"  The name-aware scanner could not run — {unavailable.case}.",
        f"  {unavailable.detail}",
    ]
    if unavailable.hint:
        lines.append(f"  {unavailable.hint}")
    lines += [
        "",
        "  This is not a clean verdict. The regex scanner ran and passed. It",
        "  matches names and patterns it has been given. It does not recognise",
        "  an unfamiliar real name, and recognising those is the whole job of",
        "  the layer that did not run.",
        "",
    ]
    if action == "block":
        lines.append(f"  PUSH BLOCKED.  [policy: {label}]")
    else:
        lines += [
            f"  PUSH ALLOWED on the regex layer alone.  [policy: {label}]",
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


# A combined diff (`--cc`, which the push patch uses for merges) opens a file
# with `diff --cc`, not `diff --git`.
_FILE_STARTS = ("diff --git ", "diff --cc ", "diff --combined ")
# What ends a file's header block: its first hunk, or — for a binary change,
# which has no hunk — the line that stands in for one. `push_patch` does not
# pass `--binary` today, so only the one-line `Binary files` form arrives; a
# `GIT binary patch` payload would otherwise be header all the way down, and
# a header block is never split.
_HEADER_ENDS = ("@@", "GIT binary patch", "Binary files ")

# Characters two neighbouring slices of one long line share, so a name that
# straddles a cut is read whole by one of them.
_SLICE_OVERLAP = 200


def _slice_line(line: str, width: int, columns: int = 1) -> List[str]:
    """One diff line as lines of at most `width` characters.

    A single added line can be far longer than a piece — minified JSON, a data
    URL, a generated bundle — and without this it became one piece of whatever
    size it was, which is the large-input blind spot the pieces exist to
    close. Each slice keeps the line's diff sign, so the scanner still reads it
    as added text, and neighbours overlap by `_SLICE_OVERLAP`. A combined
    (`--cc`) diff signs a line with one column per parent — ` +` is added
    against the second parent — so the sign is `columns` characters wide;
    keeping only the first would hand every later slice to the scanner as
    context.
    """
    if len(line) <= width:
        return [line]
    head = line[:columns]
    if len(head) == columns and all(c in "+- " for c in head):
        sign, body = head, line[columns:]
    else:
        sign, body = "", line
    span = width - len(sign)
    step = span - _SLICE_OVERLAP
    out = []
    start = 0
    while True:
        out.append(sign + body[start : start + span])
        if start + span >= len(body):
            return out
        start += step


def split_patch(patch: str, limit: int | None = None) -> List[str]:
    """The patch in line-aligned pieces of at most `limit` characters.

    Each piece after the first is seeded with the `diff --git` header block its
    first line sits under, and with a hunk marker when it begins inside one.
    Without that, a piece beginning mid-file shows added lines belonging to no
    named path, and the scanner cannot say WHERE a finding is — which is the
    half of a finding that decides the remedy.

    **A hunk is split too, and that is the point.** The first version broke
    only at `diff --git` and `@@` boundaries, which reads as the careful
    choice and does not hold the limit: a commit that ADDS a file writes it
    as one hunk, so a new 34KB test file was one indivisible piece whatever
    the limit said, and the real leaked commit split into pieces of up to 38KB
    against a 30KB target. Line numbers in a finding from a continuation piece
    are numbered from that piece rather than the file; the path is right, and
    the path is what the reader needs.
    """
    limit = limit or CHUNK_CHARS
    if len(patch) <= limit:
        return [patch]
    width = limit // 2
    # (line, is_header). A line is a file header only between a file's
    # `diff` line and its first `@@`: an added line whose text starts `++ `
    # reads `+++ ` too, and taking it for a header let a 100KB line through
    # unsliced and unbreakable.
    lines: List[tuple] = []
    in_header = False
    columns = 1
    for line in patch.split("\n"):
        if line.startswith(_FILE_STARTS):
            in_header = True
        elif line.startswith(_HEADER_ENDS):
            in_header = False
        if line.startswith("@@"):
            # `@@` is one parent, `@@@` two: the sign is one column per parent.
            columns = max(1, len(line) - len(line.lstrip("@")) - 1)
        if in_header or line.startswith("@@"):
            lines.append((line, in_header))
        else:
            lines.extend((part, False) for part in _slice_line(line, width, columns))
    pieces: List[str] = []
    current: List[str] = []
    size = 0
    header: List[str] = []
    hunk = ""
    for line, is_header in lines:
        opens_file = is_header and line.startswith(_FILE_STARTS)
        if opens_file:
            header = [line]
            hunk = ""
        elif is_header:
            header.append(line)
        elif line.startswith("@@"):
            hunk = line
        if size + len(line) > limit and current:
            # Never break between a file's header lines and its first hunk:
            # a piece that opened there would name a path and show nothing.
            if not (is_header and not opens_file):
                pieces.append("\n".join(current))
                current = [] if opens_file else list(header)
                if hunk and not opens_file and not line.startswith("@@"):
                    current.append(hunk)
                size = sum(len(x) + 1 for x in current)
        current.append(line)
        size += len(line) + 1
    if current:
        pieces.append("\n".join(current))
    return pieces


def call_haiku(diff_content: str, scan_range: str = "stdin") -> "int | Unavailable":
    """Every piece of the push, one verdict.

    Any piece finding a leak blocks: a leak is a property of a line, not of
    the push as a whole, so the pieces are OR-ed and not voted on. Otherwise,
    any piece that could not run makes the whole scan unavailable, for the
    reason the policy block below records — a push half of which nobody read
    is a push nobody read.

    The order is the point. A found leak is checked FIRST, because
    "unavailable" is handed to a policy that may be set to warn, and a leak one
    piece actually found must not be softened into a banner by a different
    piece that timed out.

    `scan_range` only labels the spend ledger's entries.
    """
    pieces = split_patch(diff_content)
    if len(pieces) == 1:
        return _scan_piece(pieces[0], scan_range)
    with ThreadPoolExecutor(max_workers=CHUNK_JOBS) as pool:
        results = list(pool.map(lambda piece: _scan_piece(piece, scan_range), pieces))
    if any(r == 1 for r in results):
        return 1
    for r in results:
        if isinstance(r, Unavailable):
            return r
    return 0


def _read_reply(data: object) -> "tuple[str, str]":
    """(verdict word, reply text). Never raises, so the spend entry that must
    be written before anything acts on the reply cannot be skipped by it."""
    content = data.get("content") if isinstance(data, dict) else None
    if not isinstance(content, list) or not content or not isinstance(content[0], dict):
        return "wrong-shape", ""
    text = str(content[0].get("text", "")).strip()
    if "VERDICT: CLEAN" in text:
        return "clean", text
    if "VERDICT: LEAKS_FOUND" in text:
        return "findings", text
    return "no-verdict", text


def _scan_piece(diff_content: str, scan_range: str = "stdin") -> "int | Unavailable":
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

    # Per piece, not once per push: the cap is on API calls, and a long scan
    # can cross it — or another repo's push can — between one piece and the
    # next. Pieces already in flight together still overshoot by at most a
    # batch; that is the price of not serialising them.
    over = check_budget()
    if over is not None:
        return over

    body = json.dumps({
        "model": MODEL,
        "max_tokens": MAX_OUTPUT_TOKENS,
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

    # Every step of the shape is checked before it is indexed. Valid JSON in
    # the wrong shape — `{"content": "..."}` from a gateway, `{"content":
    # [null]}` — would otherwise raise out of here as a traceback, which is
    # neither of the two answers this tool is allowed to give and says nothing
    # a person can act on.
    verdict, text = _read_reply(data)

    # RECORDED BEFORE ANYTHING ACTS ON THE REPLY. The call cost money the
    # moment `usage` came back; a reply that then carries no verdict, or the
    # wrong shape, is still a call the cap has to count, and every return
    # below is a path that would otherwise skip it.
    usage = data.get("usage") if isinstance(data, dict) else None
    if isinstance(usage, dict):
        failed = record_spend(scan_range, len(diff_content), usage, verdict)
        if failed is not None:
            # The verdict stands — this scan did run — but the cap cannot see
            # what it cost, so say so where the push's output is read.
            print(
                f"[scrub-haiku] WARNING: this scan's cost could not be written to "
                f"the shared spend ledger ({failed}). The daily cap will not "
                "count it.",
                file=sys.stderr,
            )

    if verdict == "wrong-shape":
        return Unavailable(
            UNREACHABLE,
            "The API's reply was not in a shape this tool can read.",
        )
    if verdict == "clean":
        return 0
    if verdict == "findings":
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
    args = sys.argv[1:]
    # A report scans nothing and spends nothing, so no skip switch applies.
    if "--spend-report" in args:
        return spend_report()

    if os.environ.get("SCRUB_SKIP") == "1":
        return 0
    if os.environ.get("SCRUB_SKIP_HAIKU") == "1":
        print("[scrub-haiku] SCRUB_SKIP_HAIKU=1 — bypassing Haiku check.", file=sys.stderr)
        return 0

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
        scan_range = "push " + args[args.index("--push-tip") + 1][:12]
    elif "--diff-range" in args:
        idx = args.index("--diff-range")
        if idx + 1 >= len(args):
            print("[scrub-haiku] --diff-range needs a value", file=sys.stderr)
            return 2
        diff = get_diff(args[idx + 1])
        scan_range = args[idx + 1][:80]
    else:
        diff = sys.stdin.read()
        scan_range = "stdin"

    if not diff.strip():
        return 0

    if len(diff) > MAX_DIFF_CHARS:
        diff = diff[:MAX_DIFF_CHARS]
        print(
            f"[scrub-haiku] diff truncated to ~{MAX_DIFF_CHARS // 4} tokens for Haiku call.",
            file=sys.stderr,
        )

    result = call_haiku(diff, scan_range)
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
    label = policy.name
    if result.case == BUDGET and os.environ.get(BUDGET_BLOCK_ENV) == "1" and action != "block":
        action = "block"
        label = f"{policy.name}, {BUDGET_BLOCK_ENV}=1"
    print_banner(result, policy, action, label)
    return 1 if action == "block" else 0


if __name__ == "__main__":
    sys.exit(main())
