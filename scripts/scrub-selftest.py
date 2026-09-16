#!/usr/bin/env python3
"""Non-vacuity test for the pre-push leak gate.

The gate's failure mode is not "it flags the wrong thing" — it is "it sees
nothing and exits 0." That happened here for weeks: the fleet registry path
went stale in a rename, `find_registry()` returned None, zero project names
compiled, and every push passed the project-name check by not running it. The
hand-curated denylist kept the pattern list non-empty, so the one guard that
existed never fired.

A scanner whose only assertion is an absence proves nothing until you have
shown it can see a presence. So every case below plants something the scanner
MUST find, or asserts a specific refusal — and it runs against fixtures via
the SCRUB_REGISTRY / SCRUB_DENYLIST overrides, so it works identically on a
laptop with the real fleet config and on a CI runner with none of it.

Run: python3 scripts/scrub-selftest.py    (exit 0 = gate is alive)
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SCRUB = os.path.join(HERE, "scrub-check.py")
HAIKU = os.path.join(HERE, "scrub-haiku.py")

sys.path.insert(0, HERE)
import scrub_git  # noqa: E402
import scrub_names  # noqa: E402

# `scrub-haiku.py` is not an importable module name, and the prompt it builds
# is the surface this suite asserts on — the Haiku call itself is never made
# here, so nothing below spends an API key.
_HAIKU_SPEC = importlib.util.spec_from_file_location(
    "scrub_haiku", os.path.join(HERE, "scrub-haiku.py"),
)
haiku = importlib.util.module_from_spec(_HAIKU_SPEC)
_HAIKU_SPEC.loader.exec_module(haiku)

# Invented names. `zephyr-*` is not a real project and never will be; the
# hyphen matters because the scanner drops short unhyphenated names as too
# generic to match safely.
PRIVATE_PROJECT = "zephyr-private-proj"
PUBLIC_PROJECT = "zephyr-public-proj"
MENTIONABLE_PROJECT = "zephyr-cleared-proj"
# Lives only in a repo-local registry.yaml, never in the fixture registry — so
# a hit on it proves the repo-local file was read, and a miss proves it wasn't.
DECOY_PROJECT = "zephyr-decoy-proj"
DENY_TOKEN = "quokkaburra"
# Two more invented tokens, for the push-range cases below. PUBLIC_TOKEN
# stands for content that is already on main (and therefore already public);
# NEW_TOKEN for content a push would actually publish. Keeping them distinct
# is what lets a case say WHICH of the two the gate reacted to.
PUBLIC_TOKEN = "wibblethorpe"
NEW_TOKEN = "grimsbyfoyle"
# An email in FILE CONTENT, as opposed to git's own Author / Co-authored-by
# metadata. The gate must keep seeing the former after it learns to ignore
# the latter — a redaction that also swallowed content emails would be a miss.
LEAK_EMAIL = "finchwhistle@example.invalid"
# A two-word phrase, and the two halves it wraps into. A formatter breaking a
# line between them is the whole subject of `check_multiline` below: searched
# one line at a time, neither half is a match and the phrase disappears.
WRAPPED_LEFT = "borogove"
WRAPPED_RIGHT = "slithy"
WRAPPED_LITERAL = f"{WRAPPED_LEFT} {WRAPPED_RIGHT}"
# A regex whose own `\s+` already spells "any whitespace here" — broken only
# because a line-at-a-time search never showed it a newline.
SPACED_RX_LEFT = "jubjub"
SPACED_RX_RIGHT = "bird"
# A regex with a `.` between the halves. `.` must keep refusing to cross a
# line break: widening it would let narrow patterns swallow half a file.
DOT_RX_LEFT = "frumious"
DOT_RX_RIGHT = "bandersnatch"

REGISTRY = f"""\
projects:
  {PRIVATE_PROJECT}:
    path: ~/dev/{PRIVATE_PROJECT}
  {PUBLIC_PROJECT}:
    path: ~/dev/{PUBLIC_PROJECT}
    public: true
  {MENTIONABLE_PROJECT}:
    path: ~/dev/{MENTIONABLE_PROJECT}
    mentionable: true
"""

DENYLIST = (
    f"# fixture denylist\n{DENY_TOKEN}\n{PUBLIC_TOKEN}\n{NEW_TOKEN}\n"
    # Both regex spellings people actually write. The delimited form shipped
    # broken for weeks: only the LEADING slash was stripped, so every
    # /pattern/ compiled with a literal trailing `/` and matched nothing —
    # the gate reported clean while its regex entries were blind.
    "/zonkey-[0-9]{3}/\n"
    "/quagga-[0-9]+\n"
    # A multi-word literal, and two regexes that straddle a gap: one spelling
    # the gap `\s+`, one spelling it `.`. See `check_multiline`.
    f"{WRAPPED_LITERAL}\n"
    f"/{SPACED_RX_LEFT}\\s+{SPACED_RX_RIGHT}/\n"
    f"/{DOT_RX_LEFT}.{DOT_RX_RIGHT}/\n"
)

failures: list[str] = []


def run(paths: list[str], registry: str | None, denylist: str | None, cwd: str | None = None, **env_extra):
    # clean_git_env(), not os.environ: run from the hook, git has exported
    # GIT_DIR pointing at the repo being pushed, and the cases below pass
    # cwd=<fixture repo>. Inheriting it, the scanner's own `git log` would
    # resolve against the real repo while cwd claimed the fixture — the exact
    # "positive control scanning the wrong data" shape, one layer down.
    env = clean_git_env()
    env.pop("SCRUB_SKIP", None)
    env.pop("SCRUB_REQUIRE_SOURCES", None)
    # Always set both, so the real machine config can never leak into a case.
    env["SCRUB_REGISTRY"] = registry if registry else os.path.join(tempfile.gettempdir(), "scrub-selftest-absent-registry.yaml")
    env["SCRUB_DENYLIST"] = denylist if denylist else os.path.join(tempfile.gettempdir(), "scrub-selftest-absent-denylist.txt")
    env.update(env_extra)
    return subprocess.run(
        [sys.executable, SCRUB, *paths], capture_output=True, text=True, env=env, cwd=cwd
    )


def clean_git_env() -> dict[str, str]:
    """The environment minus every variable that redirects git at a repo.

    This suite runs from `.githooks/pre-push`, where git has exported GIT_DIR
    (and friends) pointing at the repo being pushed. Inheriting that, a
    `git init` in a temp directory does not initialize the temp directory —
    it re-initializes the repo GIT_DIR names, and when GIT_DIR is a linked
    worktree's gitdir it writes `core.bare = true` into the SHARED config,
    i.e. the primary checkout's. That checkout then refuses `git status`,
    `git pull`, and every worktree command with "this operation must be run
    in a work tree".

    It cost weeks of intermittent breakage that looked like a Claude Code
    worktree bug, because it only ever happened on a push and the config
    change carried no author. Strip the variables instead of guessing which
    ones matter: the list git exports to hooks is not a contract.
    """
    env = dict(os.environ)
    for key in list(env):
        if key.startswith("GIT_"):
            del env[key]
    return env


def make_repo_with_registry(path: str, project: str) -> None:
    """A git repo carrying its own registry.yaml at the root.

    This shape is the whole reason two resolver bugs shipped invisibly: the
    repo they were written in has no root registry.yaml, so `find_registry`'s
    local-file branch never fired, and every case below passed. In a repo that
    HAS one, the branch fires first and the override loses. A fixture that
    only ever exercises one of the two shapes cannot see the difference.
    """
    os.makedirs(path, exist_ok=True)
    subprocess.run(["git", "init", "-q"], cwd=path, check=True,
                   capture_output=True, env=clean_git_env())
    with open(os.path.join(path, "registry.yaml"), "w") as f:
        f.write(f"projects:\n  {project}:\n    path: ~/dev/{project}\n")


def check_git_env_isolation() -> None:
    """`git init` in a fixture must not reach the repo being pushed.

    This suite runs from `.githooks/pre-push`, and git exports GIT_DIR (plus
    friends) into every hook subprocess. A `git init` that inherits that
    environment does NOT initialize the directory you passed as cwd — it
    re-initializes the repo GIT_DIR names, and because the cwd isn't that
    repo's worktree it records `core.bare = true`. The real checkout then
    refuses `git status`, `git pull`, and every worktree command with "this
    operation must be run in a work tree", which is how a self-test blew up
    the repo it was defending, once per push, for weeks.

    The shape matters, and getting it wrong makes this test vacuous: GIT_DIR
    naming a plain repo's `.git` is harmless — `git init` just reinitializes
    it and leaves core.bare alone. It is GIT_DIR naming a LINKED WORKTREE's
    gitdir that writes `core.bare = true`, into the shared config, i.e. the
    primary checkout's. Every agent in this repo pushes from a worktree, so
    that is the shape that actually happens.

    The victim is a throwaway repo, not the real one — but it stands in the
    same relation, so this catches the bug without breaking anything.
    """
    with tempfile.TemporaryDirectory() as tmp:
        victim = os.path.join(tmp, "victim")
        os.makedirs(victim)
        # This suite's OWN setup has to be isolated too — run from the hook,
        # an inherited GIT_DIR would build the fixture inside the real repo.
        clean = clean_git_env()
        # Identity via -c, not env: clean_git_env strips GIT_AUTHOR_* and
        # GIT_COMMITTER_* along with everything else, and a CI runner has no
        # global user.email — so a bare `git commit` here exits 128 on every
        # machine that isn't a developer laptop. (This suite has now shipped
        # twice with a case that only ran on mine.)
        ident = ["-c", "user.email=selftest@example.invalid", "-c", "user.name=Scrub Selftest"]
        subprocess.run(["git", "init", "-q"], cwd=victim, check=True,
                       capture_output=True, env=clean)
        subprocess.run(["git", *ident, "commit", "-q", "--allow-empty", "-m", "seed"],
                       cwd=victim, check=True, capture_output=True, env=clean)
        worktree = os.path.join(tmp, "victim-wt")
        subprocess.run(["git", "worktree", "add", "-q", worktree, "-b", "probe"],
                       cwd=victim, check=True, capture_output=True, env=clean)
        # What git exports to a hook run from that worktree. Ask git rather
        # than building the path: the gitdir is named after the worktree
        # DIRECTORY, not the branch, and a hand-built path that doesn't exist
        # makes this whole case pass vacuously.
        hook_git_dir = subprocess.run(
            ["git", "rev-parse", "--absolute-git-dir"],
            cwd=worktree, capture_output=True, text=True, check=True, env=clean,
        ).stdout.strip()
        expect("git-env isolation: the worktree gitdir resolves",
               0 if os.path.isdir(hook_git_dir) else 1, 0, hook_git_dir)

        def bare_flag() -> str:
            r = subprocess.run(
                ["git", "config", "--file", os.path.join(victim, ".git", "config"), "core.bare"],
                capture_output=True, text=True,
            )
            return r.stdout.strip()

        # Positive control: the victim is a normal, non-bare repo right now, so
        # "still false" below is a claim about the fixture call rather than
        # about a flag that was never set.
        expect("git-env isolation: victim starts non-bare", 0 if bare_flag() == "false" else 1, 0,
               f"core.bare={bare_flag()!r}")

        prior = dict(os.environ)
        os.environ["GIT_DIR"] = hook_git_dir
        try:
            make_repo_with_registry(os.path.join(tmp, "fixture"), "some-project")
        finally:
            os.environ.clear()
            os.environ.update(prior)

        expect("git-env isolation: fixture init leaves the outer repo alone",
               0 if bare_flag() == "false" else 1, 0,
               f"core.bare={bare_flag()!r} — GIT_DIR leaked into the fixture's git init")


def expect(label: str, got: int, want: int, out: str = "") -> None:
    if got == want:
        print(f"  ok    {label}")
    else:
        print(f"  FAIL  {label}: exit {got}, expected {want}")
        if out.strip():
            print("        " + out.strip().replace("\n", "\n        "))
        failures.append(label)


def check_decision_table() -> None:
    """Every (registry, fleet, denylist, require) combination, at the seam.

    The env-level cases below cannot reach all of these: an authoritative
    override suppresses the repo-local registry lookup, so "no machine config,
    but this repo carries its own registry.yaml" is unreachable from outside —
    and that is precisely the row where the stranger-clone escape hatch was
    dead code. A branch only reachable in the field is untested by
    construction, so it gets tested here instead.
    """
    spec = importlib.util.spec_from_file_location("scrub_check", SCRUB)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    R, F, D = "/reg.yaml", "/fleet.yaml", "/deny.txt"
    cases = [
        # (registry, fleet_registry, denylist, require) -> verdict
        ((R, F, D, False), "scan",   "fully configured machine"),
        ((None, None, D, False), "refuse", "denylist present, no registry at all"),
        ((R, F, None, False), "refuse", "registry present, denylist missing"),
        ((None, None, None, False), "skip", "nothing anywhere: a stranger's clone"),
        ((None, None, None, True), "refuse", "...unless SCRUB_REQUIRE_SOURCES"),
        # The row env overrides can't produce, and the one that was broken:
        ((R, None, None, False), "scan", "repo-local registry only, no fleet config"),
        ((R, None, None, True), "refuse", "...still refused under REQUIRE_SOURCES"),
        ((R, None, D, False), "scan", "repo-local registry + machine denylist"),
    ]
    for (registry, fleet, denylist, require), want, label in cases:
        got = mod.decide_sources(
            registry=registry, fleet_registry=fleet,
            denylist=denylist, require_sources=require,
        ).verdict
        expect(f"decide_sources: {label}", 0 if got == want else 1, 0,
               f"got {got!r}, wanted {want!r}")


IDENT = ["-c", "user.email=selftest@example.invalid", "-c", "user.name=Scrub Selftest"]


def build_merge_fixture(root: str, branch_token: str = "", conflict_token: str = "") -> dict:
    """A repo in the exact shape this project's conventions produce.

    Branch off an OLDER main, make one commit of your own, then merge current
    main before the final push — which the conventions require, and which is
    what turned the gate into a blocker on the normal path. `main` carries
    PUBLIC_TOKEN, so a case can say which content the scanner reacted to.

    Returns the shas the pre-push hook would be handed: `pushed` is the ref's
    state on the remote (`remote_sha`), `tip` is what is being pushed
    (`local_sha`).
    """
    clean = clean_git_env()

    def g(*args: str) -> str:
        return subprocess.run(
            ["git", *IDENT, *args], cwd=root, check=True,
            capture_output=True, text=True, env=clean,
        ).stdout.strip()

    def write(rel: str, body: str) -> None:
        full = os.path.join(root, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True) if os.path.dirname(rel) else None
        with open(full, "w") as f:
            f.write(body)

    os.makedirs(root, exist_ok=True)
    g("init", "-q")
    write("README.md", "seed\n")
    write("docs/notes.md", "a shared line\n")
    g("add", "-A")
    g("commit", "-qm", "seed")
    base = g("rev-parse", "HEAD")

    # main gains content. Public for days by the time the branch merges it.
    write("docs/notes.md", f"a shared line, edited on main, mentioning {PUBLIC_TOKEN}\n")
    g("add", "-A")
    g("commit", "-qm", "main: notes")
    main = g("rev-parse", "HEAD")

    # the branch: one commit of its own, off the older main, then pushed
    g("checkout", "-q", "-b", "feature", base)
    write("README.md", "seed\na branch tweak\n")
    if conflict_token:
        write("docs/notes.md", "a shared line, edited on the branch\n")
    g("add", "-A")
    g("commit", "-qm", "feature: tweak")
    pushed = g("rev-parse", "HEAD")

    # `branch_token` goes in a commit made AFTER that push, because that is
    # what "content this push would publish" means. The first draft of this
    # fixture put it in the pushed commit and the case failed — correctly: a
    # commit the remote already has is already public, and re-flagging it is
    # the bug, not the guard.
    if branch_token:
        write("README.md", f"seed\na branch tweak\nand a later one: {branch_token}\n")
        g("add", "-A")
        g("commit", "-qm", "feature: more")

    # the conventions-mandated merge
    subprocess.run(["git", *IDENT, "merge", "--no-edit", main], cwd=root,
                   capture_output=True, text=True, env=clean)
    if conflict_token:
        # Content in NEITHER parent — the only place a merge commit can hide a
        # leak, and the reason `--cc` is not optional.
        write("docs/notes.md", f"a shared line, resolved by hand: {conflict_token}\n")
        g("add", "-A")
        g("commit", "-qm", "Merge main (resolved)")
    tip = g("rev-parse", "HEAD")

    # what the remote already has
    g("update-ref", "refs/remotes/origin/main", main)
    g("update-ref", "refs/remotes/origin/feature", pushed)
    return {"base": base, "main": main, "pushed": pushed, "tip": tip}


def push_patch_in(root: str, tip: str, pushed: str) -> str:
    """`scrub_git.push_patch` as the Haiku layer would get it, inside `root`.

    A subprocess because push_patch shells out to git and reads the process
    cwd; clean_git_env for the same reason run() does.
    """
    code = (
        "import sys; sys.path.insert(0, %r); import scrub_git; "
        "sys.stdout.write(scrub_git.push_patch("
        "scrub_git.push_rev_args(%r, 'origin', [%r])))" % (HERE, tip, pushed)
    )
    return subprocess.run(
        [sys.executable, "-c", code], cwd=root, capture_output=True, text=True,
        env=clean_git_env(),
    ).stdout


def check_push_rev_args() -> None:
    """The pure half: which revs get excluded, and which arguments say so."""
    zero = "0" * 40
    cases = [
        (("tip", "origin", []), ["tip", "--not", "--remotes=origin"],
         "no remote_sha to add"),
        (("tip", "origin", [zero]), ["tip", "--not", "--remotes=origin"],
         "an all-zero remote_sha (new branch) is dropped, not passed to git"),
        (("tip", "origin", ["abc"]), ["tip", "--not", "--remotes=origin", "abc"],
         "the remote's actual sha is excluded alongside the tracking refs"),
        (("tip", "origin", ["abc", "abc", ""]), ["tip", "--not", "--remotes=origin", "abc"],
         "duplicates and blanks collapse"),
        (("tip", None, ["abc"]), ["tip", "--not", "--remotes", "abc"],
         "an unrecognized remote widens to every remote-tracking ref"),
    ]
    for (tip, glob, public), want, label in cases:
        got = scrub_git.push_rev_args(tip, glob, public)
        expect(f"push_rev_args: {label}", 0 if got == want else 1, 0,
               f"got {got!r}, wanted {want!r}")


def check_identity_redaction() -> None:
    """Metadata identity redaction stays narrow: git's own lines, known identities.

    Measured on PR #198: the Haiku layer flagged the commit author trailer —
    the identity on every commit already public on origin/main — across 11
    file/line pairs and blocked the push, forcing SCRUB_SKIP_HAIKU=1. A gate
    that fires on the normal path trains everyone to bypass it. The fix must
    redact ONLY git's own commit metadata for identities the remote already
    has; an email introduced in file content is exactly what the layer exists
    to catch, so anything wider turns the fix into a miss.
    """
    known = {"Scrub Selftest <selftest@example.invalid>"}
    ph = scrub_git.IDENTITY_PLACEHOLDER
    cases = [
        ("Author: Scrub Selftest <selftest@example.invalid>",
         f"Author: {ph}", "an Author header for a known identity is redacted"),
        ("    Co-Authored-By: Scrub Selftest <selftest@example.invalid>",
         f"    Co-Authored-By: {ph}", "a commit-message co-author trailer is redacted"),
        ("Author: Someone Else <else@example.invalid>",
         None, "an identity the remote has never seen is left alone"),
        ("+Author: Scrub Selftest <selftest@example.invalid>",
         None, "an ADDED file-content line is never redacted, whatever it claims to be"),
        (f"+contact: {LEAK_EMAIL}",
         None, "an added email in file content is untouched"),
    ]
    for line, want, label in cases:
        got = scrub_git.redact_public_identities(line, known)
        expected = want if want is not None else line
        expect(f"identity redaction: {label}", 0 if got == expected else 1, 0,
               f"got {got!r}, wanted {expected!r}")


def check_remote_owner() -> None:
    """Origin's owner is an account, never a directory a local remote sits in."""
    cases = [
        ("git@example.invalid:harborlight/riverbend.git", "harborlight", "scp-like ssh"),
        ("example.invalid:harborlight/riverbend", "harborlight", "scp-like, no user"),
        ("https://example.invalid/harborlight/riverbend.git", "harborlight", "https"),
        ("ssh://git@example.invalid:22/harborlight/riverbend.git/", "harborlight",
         "ssh URL with a port and a trailing slash"),
        ("/srv/harborlight/riverbend.git", "", "a local path names a folder, not an account"),
        ("file:///srv/harborlight/riverbend.git", "", "so does a file:// URL"),
        ("C:/srv/harborlight/riverbend.git", "", "so does a Windows drive path"),
        ("https://example.invalid/riverbend.git", "", "a URL with no owner segment"),
        ("", "", "no origin at all"),
    ]
    for url, want, label in cases:
        got = scrub_git.remote_owner(url)
        expect(f"remote_owner: {label}", 0 if got == want else 1, 0,
               f"got {got!r}, wanted {want!r}")
    accounts = [
        ("Scrub Selftest <harborlight@example.invalid>", "harborlight", "a plain address"),
        ("Scrub Selftest <12345+Harborlight@users.noreply.github.com>", "harborlight",
         "GitHub's noreply form, casefolded"),
        ("Scrub Selftest", "", "no email at all"),
    ]
    for identity, want, label in accounts:
        got = scrub_git.email_account(identity)
        expect(f"email_account: {label}", 0 if got == want else 1, 0,
               f"got {got!r}, wanted {want!r}")


def check_maintainer_names(tmp: str) -> None:
    """The maintainer exemption stays narrow: this committer, already published here.

    The Haiku layer refused a documentation branch because two ported lines
    quoted the repo's own maintainer by name — their own words, in their own
    public repository, where the name is already in hundreds of tracked files.
    The prompt called that safe only in standard metadata, so every future
    documentation change quoting them failed the same way and the only exits
    were to redact their own words or switch the gate off.

    Widening it must not become a miss. Two conditions have to hold together,
    and the cases below are the control for each: a published author who is
    not this committer earns nothing, and a `user.name` this repository has
    never published earns nothing either. Set `user.name` to a colleague and
    the exemption still does not appear.

    The first name and origin's owner widen it once more, and only behind the
    same gate: they are added when the full name qualifies and never on their
    own, so every case that earned nothing before still earns nothing. The
    owner needs one thing more — an email published under that same name that
    names the same account — because an organisation's remote says nothing
    about who is pushing to it.
    """
    root = os.path.join(tmp, "maintainer-repo")
    bare = os.path.join(tmp, "maintainer-remote.git")
    os.makedirs(root, exist_ok=True)
    clean = clean_git_env()

    def g(*args: str, cwd: str = root) -> str:
        return subprocess.run(
            ["git", *args], cwd=cwd, check=True,
            capture_output=True, text=True, env=clean,
        ).stdout.strip()

    def commit_as(name: str, email: str, body: str) -> None:
        with open(os.path.join(root, "README.md"), "w") as f:
            f.write(body)
        g("add", "-A")
        g("-c", f"user.name={name}", "-c", f"user.email={email}",
          "commit", "-qm", f"from {name}")

    g("init", "-q", "--bare", bare, cwd=tmp)
    g("init", "-q")
    commit_as("Scrub Selftest", "selftest@example.invalid", "seed\n")
    commit_as("Wren Halloway", "wren@example.invalid", "seed\nand more\n")
    # The same person under their account's address: what ties the invented
    # `harborlight` account to "Scrub Selftest" and to nobody else.
    commit_as("Scrub Selftest", "harborlight@example.invalid", "seed\nand more\nand again\n")
    g("remote", "add", "origin", bare)
    g("push", "-q", "origin", "HEAD:refs/heads/main")
    g("fetch", "-q", "origin")

    # `scrub_git._git` runs in the process cwd and inherits the process env,
    # so the fixture has to own both for the duration — the same GIT_DIR leak
    # `clean_git_env` exists for, one layer further in.
    saved_cwd = os.getcwd()
    saved_env = dict(os.environ)
    try:
        os.environ.clear()
        os.environ.update(clean)
        os.chdir(root)

        published = scrub_git.published_author_names()
        expect("maintainer: both authors are published on the remote",
               0 if published == {"Scrub Selftest", "Wren Halloway"} else 1, 0,
               f"got {sorted(published)!r}")

        g("config", "user.name", "Scrub Selftest")
        names = scrub_git.maintainer_names()
        expect("maintainer: this committer, already published, is exempt",
               0 if names == {"Scrub Selftest", "Scrub"} else 1, 0, f"got {sorted(names)!r}")
        expect("maintainer: a published author who is NOT this committer is not exempt",
               0 if not names & {"Wren Halloway", "Wren"} else 1, 0, f"got {sorted(names)!r}")

        # The remote-tracking refs outlive a URL change, so the same published
        # authors stand behind a hosted-looking origin. Both accounts are
        # invented: `harborlight` is this committer's, `tidewater` an
        # organisation nobody here has committed as.
        g("remote", "set-url", "origin", "git@example.invalid:harborlight/riverbend.git")
        hosted = scrub_git.maintainer_names()
        expect("maintainer: the first name and origin's owner ride on a qualifying full name",
               0 if hosted == {"Scrub Selftest", "Scrub", "harborlight"} else 1, 0,
               f"got {sorted(hosted)!r}")

        g("remote", "set-url", "origin", "git@example.invalid:tidewater/riverbend.git")
        org = scrub_git.maintainer_names()
        expect("maintainer: an origin owner no published email of theirs names is not exempt",
               0 if org == {"Scrub Selftest", "Scrub"} else 1, 0, f"got {sorted(org)!r}")
        g("remote", "set-url", "origin", "git@example.invalid:harborlight/riverbend.git")

        g("config", "user.name", "Wren Halloway")
        borrowed = scrub_git.maintainer_names()
        expect("maintainer: naming yourself after another published author exempts only them-as-you",
               0 if borrowed == {"Wren Halloway", "Wren"} else 1, 0,
               f"got {sorted(borrowed)!r}")

        g("config", "user.name", "Never Committed Here")
        stranger = scrub_git.maintainer_names()
        expect("maintainer: a user.name this repo never published earns no name, first name or handle",
               0 if stranger == set() else 1, 0, f"got {sorted(stranger)!r}")

        # Unsetting it locally does not mean git has no answer — it falls
        # through to the machine's global config, which on a developer's box
        # is a real name. So this asserts the interesting half: whatever git
        # falls back to, a name this repository never published is not exempt.
        g("config", "--unset", "user.name")
        fallback = scrub_git.maintainer_names()
        expect("maintainer: a global user.name this repo never published is not exempt",
               0 if fallback == set() else 1, 0, f"got {sorted(fallback)!r}")

        # And no user.name anywhere — what CI and a fresh clone have: the
        # global and system files swapped for nothing, so git has no answer to
        # fall back to. The first expect is the control that it really has none.
        os.environ["GIT_CONFIG_GLOBAL"] = os.devnull
        os.environ["GIT_CONFIG_NOSYSTEM"] = "1"
        expect("maintainer: the fixture really has no user.name to fall back to",
               0 if scrub_git._git(["git", "config", "user.name"]).strip() == "" else 1, 0)
        nobody = scrub_git.maintainer_names()
        expect("maintainer: no user.name at all earns no name, first name or handle",
               0 if nobody == set() else 1, 0, f"got {sorted(nobody)!r}")
    finally:
        os.chdir(saved_cwd)
        os.environ.clear()
        os.environ.update(saved_env)

    prompt = haiku.system_prompt({"Scrub Selftest"})
    expect("maintainer prompt: the resolved name is listed",
           0 if "- Scrub Selftest" in prompt else 1, 0)
    expect("maintainer prompt: every other real name is still a leak",
           0 if "Every OTHER real person's name is still a leak" in prompt else 1, 0)
    expect("maintainer prompt: only non-name content on the line can make it a leak",
           0 if "BESIDES the name" in prompt else 1, 0)
    empty = haiku.system_prompt(set())
    expect("maintainer prompt: with nobody resolved, every real name flags as before",
           0 if "treat EVERY real personal name as a potential leak" in empty else 1, 0)
    expect("maintainer prompt: nobody is named when nobody resolved",
           0 if "Scrub Selftest" not in empty else 1, 0)

    check_house_fixture_names()


def check_house_fixture_names() -> None:
    """The names builders are told to write are the names the scanner permits.

    The convention has two halves and they used to disagree: a push carrying
    one of these words in a fixture was blocked as a surname used as sample
    data, and a push-range block is not clearable by a forward commit. These
    cases hold the halves together, and hold the exemption to three words.
    """
    house = scrub_names.HOUSE_FIXTURE_NAMES
    expect("house names: the list is the three the convention names",
           0 if set(house) == {"Harborlight", "Riverbend", "Saltmarsh"} else 1, 0,
           f"got {house!r}")

    for maintainers in ({"Scrub Selftest"}, set()):
        who = "with a maintainer" if maintainers else "with nobody resolved"
        prompt = haiku.system_prompt(maintainers)
        for name in house:
            expect(f"house names: {name} is named to the scanner {who}",
                   0 if f"- {name}" in prompt else 1, 0)
        expect(f"house names: ...as a placeholder, not a leak ({who})",
               0 if "house fixture names" in prompt
               and "cross it off the sweep as a placeholder" in prompt else 1, 0)
        expect(f"house names: ...and nothing else is widened ({who})",
               0 if "closed list of three words" in prompt
               and "still a leak in a test fixture" in prompt else 1, 0)

    # The prompt renders the constant rather than carrying its own copy, which
    # is what makes scrub_names.HOUSE_FIXTURE_NAMES the one place the two
    # halves of the convention meet. Swap the constant; the prompt must follow.
    saved = scrub_names.HOUSE_FIXTURE_NAMES
    try:
        scrub_names.HOUSE_FIXTURE_NAMES = ("Tidewater",)
        swapped = haiku.system_prompt({"Scrub Selftest"})
    finally:
        scrub_names.HOUSE_FIXTURE_NAMES = saved
    expect("house names: the prompt reads the constant, not a copy of it",
           0 if "- Tidewater" in swapped and "- Saltmarsh" not in swapped else 1, 0)


# --- The Haiku layer's three ways of not running ---------------------------
#
# Everything below drives `scrub-haiku.py` against a stub on loopback or
# against nothing at all. No case reaches the network and no case reads the
# real key: every run points KEYCHAIN_SERVICE at a name nothing has stored
# under, so the only key in play is the placeholder below, and the only place
# it is ever sent is 127.0.0.1.

# Non-empty, because an empty diff short-circuits before the API is consulted,
# and carrying nothing a scanner should object to. The town is invented.
HAIKU_FAKE_DIFF = (
    "diff --git a/example.md b/example.md\n"
    "--- a/example.md\n"
    "+++ b/example.md\n"
    "@@ -0,0 +1 @@\n"
    "+Notes on the Harborlight ferry timetable.\n"
)

# Not a key. It exists only to get a case PAST the "no key at all" branch so
# the branch under test is the one after it.
HAIKU_PLACEHOLDER_KEY = "scrub-selftest-placeholder-value"

# The API's real answer for a key over its cap, with a fictional reset date.
# The status is 400 — the same status a malformed request draws — which is why
# the classifier has to read the message.
HAIKU_EXHAUSTED_BODY = json.dumps({
    "type": "error",
    "error": {
        "type": "invalid_request_error",
        "message": (
            "You have reached your specified API usage limits. "
            "You will regain access on 2099-01-01 at 00:00 UTC."
        ),
    },
})
HAIKU_REJECTED_BODY = json.dumps({
    "type": "error",
    "error": {"type": "authentication_error", "message": "invalid x-api-key"},
})
HAIKU_SERVER_ERROR_BODY = json.dumps({
    "type": "error",
    "error": {"type": "api_error", "message": "Internal server error"},
})
# A 400 that is NOT a cap. Same status as the exhausted body, so the pair is
# the control for "the status alone decided it" — if it had, both would sort
# the same way.
HAIKU_BAD_REQUEST_BODY = json.dumps({
    "type": "error",
    "error": {
        "type": "invalid_request_error",
        "message": "messages: at least one message is required",
    },
})

HAIKU_STUB_REPLIES = {
    "/clean": (200, json.dumps({"content": [{"text": "VERDICT: CLEAN"}]})),
    "/leaks": (200, json.dumps({"content": [{
        "text": "VERDICT: LEAKS_FOUND\nLEAKS:\n- example.md:1 — a real name",
    }]})),
    "/exhausted": (400, HAIKU_EXHAUSTED_BODY),
    "/rejected": (401, HAIKU_REJECTED_BODY),
    "/server-error": (500, HAIKU_SERVER_ERROR_BODY),
    # A 200 that is not JSON at all — a captive portal or a proxy page. The
    # old code called this a setup error and let the push through.
    "/garbage": (200, "<html>a proxy answered instead</html>"),
    # And valid JSON in the wrong shape, which is the harder half: it parses,
    # so it reaches the code that indexes it.
    "/wrong-shape": (200, json.dumps({"content": "a gateway wrote a string"})),
}

# Replies that carry `usage`, which is what makes a call cost money and so
# what the spend ledger books. 12,000 in and 300 out is $0.012 + $0.0015.
HAIKU_USAGE = {"input_tokens": 12_000, "output_tokens": 300}
HAIKU_USAGE_USD = 0.0135
HAIKU_STUB_REPLIES.update({
    "/clean-usage": (200, json.dumps({
        "content": [{"text": "NAMES: none\nVERDICT: CLEAN"}], "usage": HAIKU_USAGE,
    })),
    "/leaks-usage": (200, json.dumps({
        "content": [{"text": "VERDICT: LEAKS_FOUND\nLEAKS:\n- example.md:1 — a real name"}],
        "usage": HAIKU_USAGE,
    })),
    # Paid for, and then unusable: the two replies the ledger must still book.
    "/no-verdict-usage": (200, json.dumps({
        "content": [{"text": "NAMES: none"}], "usage": HAIKU_USAGE,
    })),
    "/wrong-shape-usage": (200, json.dumps({
        "content": "a gateway wrote a string", "usage": HAIKU_USAGE,
    })),
})


class HaikuStub(BaseHTTPRequestHandler):
    """Answers whatever the path asks for, and reads nothing it is sent.

    It counts the requests it answers, because "the cap made no API call" is
    only provable at the place a call would land.
    """

    calls = 0
    calls_lock = threading.Lock()
    # A file made read-only while a call is in flight: the ledger the scanner
    # checked before calling, which it then cannot append to.
    seal_during_call: str | None = None

    def do_POST(self) -> None:  # noqa: N802  (BaseHTTPRequestHandler's spelling)
        with HaikuStub.calls_lock:
            HaikuStub.calls += 1
        if HaikuStub.seal_during_call:
            os.chmod(HaikuStub.seal_during_call, 0o444)
        # Drained, never parsed, never logged: the request carries the
        # placeholder key in a header and there is no reason to look at it.
        self.rfile.read(int(self.headers.get("content-length") or 0))
        status, body = HAIKU_STUB_REPLIES.get(self.path, (404, "{}"))
        payload = body.encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args) -> None:
        pass


def start_haiku_stub() -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), HaikuStub)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def spawn_haiku(url: str, policy: str | None, *, ledger: str, with_key: bool = True,
              argv: tuple[str, ...] = (), stdin: str = HAIKU_FAKE_DIFF,
              cwd: str = HERE, **env_extra: str):
    """`scrub-haiku.py` as a push runs it, pointed at a stub and a ledger.

    `ledger` has no default on purpose. Every case names its own spend ledger,
    so no case reads the real one — whose total would decide whether a case
    even reaches the stub — and no case writes to it.
    """
    env = clean_git_env()
    for key in ("SCRUB_SKIP", "SCRUB_SKIP_HAIKU",
                "SCRUB_HAIKU_API_KEY", "ANTHROPIC_API_KEY",
                "SCRUB_HAIKU_UNAVAILABLE", "SCRUB_HAIKU_DAILY_USD",
                "SCRUB_HAIKU_BUDGET_BLOCK", "SCRUB_HAIKU_RULES"):
        env.pop(key, None)
    # Nothing has ever stored a password under this service name, so the
    # real entry is neither read nor reachable from any case here.
    env["SCRUB_HAIKU_KEYCHAIN_SERVICE"] = "scrub-selftest-no-such-service"
    env["SCRUB_HAIKU_API_URL"] = url
    env["SCRUB_HAIKU_SPEND_LOG"] = ledger
    if with_key:
        env["SCRUB_HAIKU_API_KEY"] = HAIKU_PLACEHOLDER_KEY
    if policy is not None:
        env["SCRUB_HAIKU_UNAVAILABLE"] = policy
    env.update(env_extra)
    return subprocess.run(
        [sys.executable, HAIKU, *argv], input=stdin,
        capture_output=True, text=True, env=env, cwd=cwd,
    )


def check_haiku_unavailable() -> None:
    """A gate that could not look must not answer like one that looked.

    This is the failure that put a real person's name on this public repo's
    main branch. `call_haiku` returned 2 for every setup or API problem and
    `main` turned every 2 into exit 0 behind one line of stderr, so a key over
    its usage cap — which is what the key had been for some time — produced
    the same verdict as a clean scan. `.githooks/pre-push` believed it.

    So the cases below assert two separate things. That the three ways of not
    running are told APART: a cap nobody can lift before its reset date, a key
    that is missing or refused, and a transient fault. And that what each one
    then does is whatever `UNAVAILABLE_POLICY` says, under every setting it
    can take — including the one the repo actually ships, which is read from
    the module rather than restated here, so this stays true when that line
    changes.

    The two positive controls come first and are not decoration: without a run
    that reaches a verdict through this same stub, every `0` below could be a
    `0` for some reason that has nothing to do with policy.
    """
    server, stub = start_haiku_stub()
    ledgers = tempfile.TemporaryDirectory()

    # A loopback port with nothing behind it, for the network-failure case:
    # bind one, take its number, close it.
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    dead = f"http://127.0.0.1:{probe.getsockname()[1]}/clean"
    probe.close()

    # No stub reply in this function carries `usage`, so nothing is ever
    # booked here and this path is never created: every case reads $0.
    empty_ledger = os.path.join(ledgers.name, "spend.jsonl")
    # Today's spend already past the default cap, and a ledger path that
    # exists and cannot be read as a file — the two cases the cap added.
    over_ledger = os.path.join(ledgers.name, "over.jsonl")
    with open(over_ledger, "w") as f:
        f.write(ledger_line(haiku.utc_today(), "harborlight-app", 5.0))
    dir_ledger = os.path.join(ledgers.name, "a-directory")
    os.mkdir(dir_ledger)

    def run_haiku(url: str, policy: str | None, with_key: bool = True, ledger: str = empty_ledger):
        return spawn_haiku(url, policy, with_key=with_key, ledger=ledger)

    try:
        r = run_haiku(f"{stub}/clean", "warn-all")
        expect("haiku: a CLEAN verdict passes and prints no banner",
               0 if r.returncode == 0 and "ONLY HALF OF IT RAN" not in r.stderr else 1,
               0, f"exit {r.returncode}\n{r.stderr}")

        r = run_haiku(f"{stub}/leaks", "warn-all")
        expect("haiku: a LEAKS verdict still blocks under the weakest policy",
               r.returncode, 1, r.stderr)

        # The whole matrix. `absent` never makes a request at all, so its url
        # is irrelevant; the other two fail at the HTTP layer.
        case_run = {
            "exhausted": lambda policy: run_haiku(f"{stub}/exhausted", policy),
            "absent": lambda policy: run_haiku(f"{stub}/clean", policy, with_key=False),
            "unreachable": lambda policy: run_haiku(dead, policy),
            # The two the spend cap added. Neither reaches the stub.
            "budget": lambda policy: run_haiku(f"{stub}/clean", policy, ledger=over_ledger),
            "ledger-unreadable": lambda policy: run_haiku(f"{stub}/clean", policy, ledger=dir_ledger),
        }
        wanted = {
            "warn-all": {"exhausted": 0, "absent": 0, "unreachable": 0,
                         "budget": 0, "ledger-unreadable": 0},
            "block-all": {"exhausted": 1, "absent": 1, "unreachable": 1,
                          "budget": 1, "ledger-unreadable": 1},
            "block-except-exhausted": {"exhausted": 0, "absent": 1, "unreachable": 1,
                                       "budget": 0, "ledger-unreadable": 1},
        }
        expect("haiku: the policy table has a row for every setting the matrix covers",
               0 if set(wanted) == set(haiku.POLICIES) else 1, 0,
               f"module {sorted(haiku.POLICIES)!r} vs test {sorted(wanted)!r}")
        for policy, per_case in wanted.items():
            got_cases = set(haiku.POLICIES.get(policy, {}))
            expect(f"haiku: the {policy} row answers every case the matrix drives",
                   0 if got_cases == set(per_case) else 1, 0,
                   f"module {sorted(got_cases)!r} vs test {sorted(per_case)!r}")

        for policy, per_case in wanted.items():
            for case, want in per_case.items():
                r = case_run[case](policy)
                expect(f"haiku {policy}: {case} {'blocks' if want else 'warns'}",
                       r.returncode, want, f"exit {r.returncode}\n{r.stderr}")
                expect(f"haiku {policy}: the banner names {case}",
                       0 if f"could not run — {case}" in r.stderr else 1, 0, r.stderr)
                expect(f"haiku {policy}: the banner is unmissable ({case})",
                       0 if "LEAK GATE: ONLY HALF OF IT RAN" in r.stderr
                       and haiku.BANNER_RULE in r.stderr else 1, 0, r.stderr)

        # The value this repo actually ships, applied with no override in the
        # environment. Read from the module, so the day it changes this case
        # follows it instead of going stale or going red.
        shipped = haiku.UNAVAILABLE_POLICY
        expect("haiku: the recorded UNAVAILABLE_POLICY names a real policy",
               0 if shipped in haiku.POLICIES else 1, 0, f"got {shipped!r}")
        if shipped in wanted:
            r = case_run["exhausted"](None)
            expect(f"haiku: with no override, the recorded policy ({shipped}) is what applies",
                   r.returncode, wanted[shipped]["exhausted"], r.stderr)

        # A setting nobody defined is a gate nobody has read. It must not fall
        # back to the recorded value and it must not fall back to warning.
        r = run_haiku(f"{stub}/exhausted", "warn-al")
        expect("haiku: a misspelled policy blocks rather than softens",
               r.returncode, 1, f"exit {r.returncode}\n{r.stderr}")
        expect("haiku: ...and says which value it could not read",
               0 if "'warn-al'" in r.stderr and "names no policy" in r.stderr else 1,
               0, r.stderr)

        # A 200 carrying something this tool cannot parse used to be a setup
        # error, which meant exit 0.
        r = run_haiku(f"{stub}/garbage", "block-all")
        expect("haiku: a reply that will not parse is unreachable, not clean",
               0 if r.returncode == 1 and "could not run — unreachable" in r.stderr else 1,
               0, f"exit {r.returncode}\n{r.stderr}")

        # Valid JSON in a shape this tool cannot read has to reach the same
        # answer as unparseable bytes, not raise out as a traceback.
        r = run_haiku(f"{stub}/wrong-shape", "block-all")
        expect("haiku: a reply that parses but has the wrong shape is unreachable",
               0 if r.returncode == 1 and "could not run — unreachable" in r.stderr else 1,
               0, f"exit {r.returncode}\n{r.stderr}")
        expect("haiku: ...and says so rather than raising",
               0 if "Traceback" not in r.stderr else 1, 0, r.stderr)

        # End to end for the OTHER way a key can be absent: present, sent, and
        # refused. It has to reach the same case as having no key at all.
        r = run_haiku(f"{stub}/rejected", "block-except-exhausted")
        expect("haiku: a key the API refuses is absent, and blocks under block-except-exhausted",
               0 if r.returncode == 1 and "could not run — absent" in r.stderr else 1,
               0, f"exit {r.returncode}\n{r.stderr}")
    finally:
        server.shutdown()
        server.server_close()
        ledgers.cleanup()

    # The sorting itself, driven directly. The last pair is the control for
    # the rule the classifier is built on: two 400s, one a cap and one not.
    sorting = [
        (401, HAIKU_REJECTED_BODY, "absent", "a refused key is a broken install"),
        (500, HAIKU_SERVER_ERROR_BODY, "unreachable", "a server error is transient"),
        (400, HAIKU_EXHAUSTED_BODY, "exhausted", "a 400 naming a usage limit is the cap"),
        (400, HAIKU_BAD_REQUEST_BODY, "unreachable",
         "...and a 400 that names no limit is not"),
    ]
    for status, body, want, label in sorting:
        got = haiku.classify_http_error(status, body).case
        expect(f"haiku classify: {label}", 0 if got == want else 1, 0,
               f"HTTP {status} sorted as {got!r}, wanted {want!r}")

    # One added line longer than a piece — minified JSON, a data URL — is cut
    # into slices rather than sent whole, and a token straddling a cut is
    # still read whole by one slice.
    head = "diff --git a/x.json b/x.json\n--- a/x.json\n+++ b/x.json\n@@ -0,0 +1 @@\n"
    cases = ((100_000, "late in the line", ""), (14_995, "across a cut", ""),
             # An added line whose text begins `++ ` reads `+++ `, a file
             # header's spelling, and was once passed through unsliced.
             (100_000, "a line that reads like a header", "++ "))
    for at, label, lead in cases:
        body = lead + "a" * at + "NEEDLE_7Q" + "b" * (120_000 - at)
        pieces = haiku.split_patch(head + "+" + body, 30_000)
        worst = max(len(p) for p in pieces)
        expect(f"haiku pieces: a line longer than a piece stays under the cap ({label})",
               0 if worst <= 30_000 and len(pieces) > 1 else 1, 0,
               f"{len(pieces)} piece(s), largest {worst}")
        expect(f"haiku pieces: ...and the token is whole in one of them ({label})",
               0 if any("NEEDLE_7Q" in p for p in pieces) else 1, 0)

    # A binary change has no `@@`, so its payload must not count as the file's
    # header — a header block is never split.
    binary = ("diff --git a/x.bin b/x.bin\nindex 1..2 100644\nGIT binary patch\nliteral 90000\n"
              + "\n".join("z" + "A" * 65 for _ in range(1_500)))
    worst = max(len(p) for p in haiku.split_patch(binary, 30_000))
    expect("haiku pieces: a binary payload is split like any other content",
           0 if worst <= 30_000 else 1, 0, f"largest piece {worst}")

    # A merge's combined diff signs a line with one column per parent. ` +`
    # is added against the second parent, and every slice of a long one must
    # still say so.
    merge = ("diff --cc x.json\nindex 1,2..3\n--- a/x.json\n+++ b/x.json\n@@@ -1,1 -1,1 +1,2 @@@\n"
             + " +" + "a" * 100_000)
    lost = [p for p in haiku.split_patch(merge, 30_000)
            if not p.split("\n")[-1].startswith(" +")]
    expect("haiku pieces: every slice of a merge's added line still reads as added",
           0 if not lost else 1, 0, f"{len(lost)} piece(s) lost the second column")

    # Pieces are combined leak-first. "Unavailable" goes to a policy that may
    # be set to warn, so a leak one piece FOUND must not be turned into a
    # banner because a different piece of the same push timed out.
    real_split, real_scan = haiku.split_patch, haiku._scan_piece
    down = haiku.Unavailable("unreachable", "stub: this piece timed out")
    try:
        haiku.split_patch = lambda patch, limit=None: ["found", "down"]
        haiku._scan_piece = lambda piece, *_: 1 if piece == "found" else down
        expect("haiku pieces: a leak one piece found outranks a piece that could not run",
               haiku.call_haiku("x"), 1)
        haiku.split_patch = lambda patch, limit=None: ["down", "found"]
        expect("haiku pieces: ...in either order",
               haiku.call_haiku("x"), 1)
        haiku.split_patch = lambda patch, limit=None: ["clean", "down"]
        haiku._scan_piece = lambda piece, *_: 0 if piece == "clean" else down
        got = haiku.call_haiku("x")
        expect("haiku pieces: a clean piece beside one that could not run is unavailable, not clean",
               0 if isinstance(got, haiku.Unavailable) else 1, 0, f"got {got!r}")
    finally:
        haiku.split_patch, haiku._scan_piece = real_split, real_scan

    # The dated reset is the one thing a person can act on in the cap case, so
    # it has to survive into what they are shown.
    detail = haiku.classify_http_error(400, HAIKU_EXHAUSTED_BODY).detail
    expect("haiku classify: the cap case keeps the date access returns",
           0 if "2099-01-01" in detail else 1, 0, f"got {detail!r}")


def ledger_line(date: str, repo: str, usd: object) -> str:
    """One spend-ledger entry in the shared format, as another repo writes it."""
    return json.dumps({
        "ts": f"{date}T12:00:00Z", "date": date, "repo": repo,
        "range": "push 0123456789ab", "model": haiku.MODEL, "diff_chars": 1000,
        "input_tokens": 1000, "output_tokens": 100, "estimated_usd": usd,
        "verdict": "clean",
    }) + "\n"


def read_ledger(path: str) -> list:
    """Every line as parsed JSON, or the raw line where it does not parse."""
    if not os.path.exists(path):
        return []
    out = []
    with open(path) as f:
        for line in f.read().splitlines():
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                out.append(line)
    return out


def check_haiku_spend() -> None:
    """The key's daily spend cap, shared with every repo that scans with it.

    The key has hit its provider limit once. Another repository's copy of this
    scanner books every call to one ledger and stops calling at a daily cap;
    this one did neither, so its pushes spent the key where that cap could not
    see them. The format is a contract between the two copies, so the entry's
    keys are asserted exactly, not approximately.

    Each case counts the stub's requests before and after. "The cap made no
    call" is a claim about the network, and the stub is the network here.
    """
    server, stub = start_haiku_stub()
    tmp = tempfile.TemporaryDirectory()
    today = haiku.utc_today()
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")

    def ledger(name: str, body: str | None = None) -> str:
        path = os.path.join(tmp.name, name)
        if body is not None:
            with open(path, "w") as f:
                f.write(body)
        return path

    def calls_during(fn):
        before = HaikuStub.calls
        result = fn()
        return result, HaikuStub.calls - before

    try:
        # --- 2. One entry per call, in exactly the shared shape ---------------
        # Run from a LINKED worktree of a fixture repo: `repo` is the
        # repository's name, not the name of whichever folder a push ran in.
        repo = os.path.join(tmp.name, "riverbend-ledger-repo")
        side = os.path.join(tmp.name, "riverbend-side-tree")
        clean = clean_git_env()

        def g(*args: str, cwd: str = repo) -> None:
            subprocess.run(["git", *IDENT, *args], cwd=cwd, check=True,
                           capture_output=True, text=True, env=clean)

        os.makedirs(repo)
        g("init", "-q")
        with open(os.path.join(repo, "notes.md"), "w") as f:
            f.write("ferry timetable\n")
        g("add", "-A")
        g("commit", "-qm", "seed")
        with open(os.path.join(repo, "notes.md"), "a") as f:
            f.write("the late sailing moved\n")
        g("commit", "-qam", "notes")
        g("worktree", "add", "-q", side)

        shape = ledger("shape.jsonl")
        r = spawn_haiku(f"{stub}/clean-usage", "block-all", ledger=shape, cwd=side)
        r2 = spawn_haiku(f"{stub}/leaks-usage", "block-all", ledger=shape, cwd=side,
                         argv=("--diff-range", "HEAD~1..HEAD"), stdin="")
        entries = read_ledger(shape)
        expect("haiku spend: each paid call appends exactly one entry",
               0 if r.returncode == 0 and r2.returncode == 1 and len(entries) == 2
               and all(isinstance(e, dict) for e in entries) else 1, 0,
               f"exits {r.returncode}/{r2.returncode}, entries {entries!r}\n{r.stderr}\n{r2.stderr}")
        if len(entries) == 2 and all(isinstance(e, dict) for e in entries):
            first, second = entries
            expect("haiku spend: an entry carries exactly the shared keys, in order",
                   0 if list(first) == list(haiku.LEDGER_KEYS)
                   and haiku.LEDGER_KEYS == ("ts", "date", "repo", "range", "model",
                                             "diff_chars", "input_tokens", "output_tokens",
                                             "estimated_usd", "verdict") else 1, 0,
                   f"got {list(first)!r}")
            try:
                stamp = datetime.fromisoformat(first["ts"].replace("Z", "+00:00"))
                stamp_ok = stamp.utcoffset() == timedelta(0) and stamp.strftime("%Y-%m-%d") == first["date"]
            except (ValueError, AttributeError):
                stamp_ok = False
            expect("haiku spend: ts is ISO-8601 UTC and date is its UTC day, today",
                   0 if stamp_ok and first["date"] == today else 1, 0,
                   f"ts {first['ts']!r}, date {first['date']!r}, today {today!r}")
            expect("haiku spend: repo is the repository's name, even from a linked worktree",
                   0 if first["repo"] == "riverbend-ledger-repo" else 1, 0, f"got {first['repo']!r}")
            expect("haiku spend: range names what was scanned",
                   0 if first["range"] == "stdin" and second["range"] == "HEAD~1..HEAD" else 1, 0,
                   f"got {first['range']!r}, {second['range']!r}")
            expect("haiku spend: model, size and tokens come from the call and its usage",
                   0 if first["model"] == haiku.MODEL
                   and first["diff_chars"] == len(HAIKU_FAKE_DIFF)
                   and first["input_tokens"] == HAIKU_USAGE["input_tokens"]
                   and first["output_tokens"] == HAIKU_USAGE["output_tokens"] else 1, 0,
                   f"got {first!r}")
            expect("haiku spend: priced at $1/M input and $5/M output",
                   0 if abs(first["estimated_usd"] - HAIKU_USAGE_USD) < 1e-9 else 1, 0,
                   f"got {first['estimated_usd']!r}, wanted {HAIKU_USAGE_USD}")
            expect("haiku spend: verdict is a short word for what the call found",
                   0 if first["verdict"] == "clean" and second["verdict"] == "findings" else 1, 0,
                   f"got {first['verdict']!r}, {second['verdict']!r}")

        # --- 4. Booked before anything acts on the reply --------------------
        for path, word, label in (("/no-verdict-usage", "no-verdict", "a reply with no verdict"),
                                  ("/wrong-shape-usage", "wrong-shape", "a reply in the wrong shape")):
            booked = ledger(f"{word}.jsonl")
            r = spawn_haiku(f"{stub}{path}", "block-all", ledger=booked)
            entries = read_ledger(booked)
            expect(f"haiku spend: {label} still books its cost",
                   0 if len(entries) == 1 and isinstance(entries[0], dict)
                   and entries[0].get("verdict") == word else 1, 0,
                   f"entries {entries!r}\n{r.stderr}")
            expect(f"haiku spend: ...and is still not a clean verdict ({word})",
                   0 if r.returncode == 1 and "could not run — unreachable" in r.stderr
                   and "SCAN DID NOT RUN" in r.stderr else 1, 0,
                   f"exit {r.returncode}\n{r.stderr}")

        # A push read in pieces is one call per piece, CHUNK_JOBS at a time,
        # and so one entry per piece — whole lines, none interleaved. The
        # rules pass is off for it: its rows repeat the same words, which the
        # pass would send twice and then leave behind, and pieces are the
        # subject here.
        big = "".join(
            f"diff --git a/table{n}.md b/table{n}.md\n--- a/table{n}.md\n+++ b/table{n}.md\n"
            f"@@ -0,0 +1,700 @@\n"
            + "".join(f"+ferry timetable row {n}.{i}, platform {i % 7}\n" for i in range(700))
            for n in range(8)
        )
        pieces = len(haiku.split_patch(big))
        many = ledger("pieces.jsonl")
        r, calls = calls_during(lambda: spawn_haiku(f"{stub}/clean-usage", "block-all",
                                                    ledger=many, stdin=big,
                                                    SCRUB_HAIKU_RULES="off"))
        entries = read_ledger(many)
        expect("haiku spend: a push in pieces books one whole entry per piece",
               0 if pieces >= CHUNK_FLOOR and r.returncode == 0 and calls == pieces
               and len(entries) == pieces and all(isinstance(e, dict) for e in entries) else 1, 0,
               f"{pieces} pieces, {calls} calls, {len(entries)} entries, exit {r.returncode}\n{r.stderr}")

        # The hook's own mode: `range` is the pushed tip, shortened.
        tip = subprocess.run(["git", "rev-parse", "HEAD"], cwd=side, check=True,
                             capture_output=True, text=True, env=clean).stdout.strip()
        pushed = ledger("pushed.jsonl")
        r = spawn_haiku(f"{stub}/clean-usage", "block-all", ledger=pushed, cwd=side, stdin="",
                        argv=("--push-tip", tip, "--remote", "origin"))
        entries = read_ledger(pushed)
        expect("haiku spend: a push is booked as `push <tip[:12]>`",
               0 if r.returncode == 0 and len(entries) == 1 and isinstance(entries[0], dict)
               and entries[0].get("range") == f"push {tip[:12]}" else 1, 0,
               f"exit {r.returncode}, entries {entries!r}\n{r.stderr}")

        # A reply with no `usage` names no cost, so nothing is booked for it.
        unmetered = ledger("unmetered.jsonl")
        r = spawn_haiku(f"{stub}/clean", "block-all", ledger=unmetered)
        expect("haiku spend: a reply without usage books nothing and still passes",
               0 if r.returncode == 0 and read_ledger(unmetered) == [] else 1, 0, r.stderr)

        if os.geteuid() != 0:  # root writes into a mode-555 folder and a mode-444 file
            # A ledger that cannot be created: the call it could not book is a
            # call the cap could not count, so no call is made at all.
            sealed = ledger("sealed-folder")
            os.mkdir(sealed)
            os.chmod(sealed, 0o555)
            try:
                r, calls = calls_during(lambda: spawn_haiku(
                    f"{stub}/clean-usage", "block-all", ledger=os.path.join(sealed, "spend.jsonl")))
            finally:
                os.chmod(sealed, 0o755)
            expect("haiku spend: a ledger whose folder cannot be written — no call, push blocked",
                   0 if calls == 0 and r.returncode == 1 else 1, 0,
                   f"{calls} call(s), exit {r.returncode}\n{r.stderr}")
            expect("haiku spend: ...and the banner says the budget check could not look",
                   0 if "SCAN DID NOT RUN — the budget check could not look" in r.stderr
                   and "cannot be written" in r.stderr else 1, 0, r.stderr)

            # A ledger that becomes unwritable while the call is out: the money
            # is spent and the verdict stands, the lost entry is said loudly,
            # and the next scan's check refuses to call.
            lost = ledger("lost.jsonl")
            HaikuStub.seal_during_call = lost
            try:
                open(lost, "w").close()
                r = spawn_haiku(f"{stub}/clean-usage", "block-all", ledger=lost)
            finally:
                HaikuStub.seal_during_call = None
            expect("haiku spend: an append that fails after the call keeps the clean verdict and says the spend was not booked",
                   0 if r.returncode == 0 and "SPEND NOT BOOKED" in r.stderr else 1, 0,
                   f"exit {r.returncode}\n{r.stderr}")
            try:
                r, calls = calls_during(lambda: spawn_haiku(f"{stub}/clean-usage", "block-all", ledger=lost))
            finally:
                os.chmod(lost, 0o644)
            expect("haiku spend: ...and the next scan makes no call and blocks",
                   0 if calls == 0 and r.returncode == 1
                   and "the budget check could not look" in r.stderr else 1, 0,
                   f"{calls} call(s), exit {r.returncode}\n{r.stderr}")

        # --- 5. The cap: today's total, every repo, checked before a call -----
        banner = "SCAN DID NOT RUN — daily budget reached"
        at_cap = ledger("at-cap.jsonl",
                        ledger_line(today, "harborlight-app", 0.60)
                        + ledger_line(today, "saltmarsh-tools", 0.40)
                        + ledger_line(yesterday, "harborlight-app", 5.0))
        r, calls = calls_during(lambda: spawn_haiku(f"{stub}/clean-usage", "block-all", ledger=at_cap))
        expect("haiku spend: at the cap, summed across repos, no API call is made",
               0 if calls == 0 else 1, 0, f"{calls} call(s)\n{r.stderr}")
        expect("haiku spend: ...the push blocks under block-all",
               r.returncode, 1, r.stderr)
        expect("haiku spend: ...and the banner says so, with today's total and the cap",
               0 if banner in r.stderr and "$1.0000" in r.stderr and "$1.00." in r.stderr
               and haiku.BANNER_RULE in r.stderr else 1, 0, r.stderr)
        expect("haiku spend: ...and books nothing, since nothing was spent",
               0 if len(read_ledger(at_cap)) == 3 else 1, 0)

        # The positive control for every zero above: one cent under, the call goes out.
        under = ledger("under.jsonl",
                       ledger_line(today, "harborlight-app", 0.60)
                       + ledger_line(today, "saltmarsh-tools", 0.39)
                       + ledger_line(yesterday, "harborlight-app", 5.0))
        r, calls = calls_during(lambda: spawn_haiku(f"{stub}/clean-usage", "block-all", ledger=under))
        expect("haiku spend: under the cap the call goes out and the push passes",
               0 if calls == 1 and r.returncode == 0 and banner not in r.stderr else 1, 0,
               f"{calls} call(s), exit {r.returncode}\n{r.stderr}")

        stale = ledger("stale.jsonl", ledger_line(yesterday, "harborlight-app", 50.0))
        r, calls = calls_during(lambda: spawn_haiku(f"{stub}/clean", "block-all", ledger=stale))
        expect("haiku spend: only today's (UTC) entries count toward the cap",
               0 if calls == 1 and r.returncode == 0 else 1, 0, f"{calls} call(s)\n{r.stderr}")

        r, calls = calls_during(lambda: spawn_haiku(f"{stub}/clean", "block-all", ledger=at_cap,
                                                    SCRUB_HAIKU_DAILY_USD="2.50"))
        expect("haiku spend: SCRUB_HAIKU_DAILY_USD moves the cap",
               0 if calls == 1 and r.returncode == 0 else 1, 0, f"{calls} call(s)\n{r.stderr}")

        r, calls = calls_during(lambda: spawn_haiku(f"{stub}/clean", "warn-all", ledger=at_cap,
                                                    SCRUB_HAIKU_BUDGET_BLOCK="1"))
        expect("haiku spend: SCRUB_HAIKU_BUDGET_BLOCK=1 blocks a cap hit even under warn-all",
               0 if calls == 0 and r.returncode == 1 and "SCRUB_HAIKU_BUDGET_BLOCK=1" in r.stderr else 1,
               0, f"{calls} call(s), exit {r.returncode}\n{r.stderr}")
        r = spawn_haiku(f"{stub}/clean", "block-except-exhausted", ledger=at_cap,
                        SCRUB_HAIKU_BUDGET_BLOCK="1")
        expect("haiku spend: ...and under block-except-exhausted, which would otherwise warn",
               r.returncode, 1, r.stderr)
        r = spawn_haiku(f"{stub}/clean", "block-all", ledger=at_cap, SCRUB_HAIKU_BUDGET_BLOCK="0")
        expect("haiku spend: SCRUB_HAIKU_BUDGET_BLOCK=0 never loosens the recorded policy",
               r.returncode, 1, r.stderr)

        r, calls = calls_during(lambda: spawn_haiku(f"{stub}/clean-usage", "block-all",
                                                    ledger=at_cap, stdin=big,
                                                    SCRUB_HAIKU_RULES="off"))
        expect("haiku spend: a push in pieces makes no call for any piece once capped",
               0 if calls == 0 and r.returncode == 1 else 1, 0, f"{calls} call(s)\n{r.stderr}")

        # --- 6. Three outcomes, and only a missing file is $0 -----------------
        got = haiku.spent_today(ledger("never-written.jsonl"), today)
        expect("haiku spend: no ledger file is $0",
               0 if got == haiku.Spend(0.0, {}, 0) else 1, 0, f"got {got!r}")

        mixed = ledger("mixed.jsonl",
                       ledger_line(today, "harborlight-app", 0.25)
                       + "not json at all\n"
                       + ledger_line(today, "saltmarsh-tools", 0.125)
                       + json.dumps({"date": today}) + "\n"            # no amount
                       + "[1, 2, 3]\n"                                  # not an object
                       + ledger_line(today, "harborlight-app", -5.0)   # would cancel spend
                       + ledger_line(today, "harborlight-app", True)   # a bool, not a number
                       + "\n"
                       + ledger_line(yesterday, "harborlight-app", 9.0)
                       + ledger_line(today, "harborlight-app", 0.25))
        got = haiku.spent_today(mixed, today)
        expect("haiku spend: a readable ledger sums today, per repo, and counts what it skipped",
               0 if abs(got.total - 0.625) < 1e-9 and got.malformed == 5
               and got.by_repo == {"harborlight-app": 0.5, "saltmarsh-tools": 0.125} else 1, 0,
               f"got {got!r}")

        unreadable = []
        a_dir = ledger("is-a-directory")
        os.mkdir(a_dir)
        unreadable.append(("a directory at the ledger path", a_dir))
        if os.geteuid() != 0:  # root reads a mode-000 file, so the case would prove nothing
            locked = ledger("locked.jsonl", ledger_line(today, "harborlight-app", 0.01))
            os.chmod(locked, 0)
            unreadable.append(("a mode-000 ledger", locked))
        for label, path in unreadable:
            try:
                got = haiku.spent_today(path, today)
                raised = False
            except haiku.LedgerUnreadable:
                raised = True
            expect(f"haiku spend: {label} is an error, never $0",
                   0 if raised else 1, 0, f"read as {got!r}" if not raised else "")
            r, calls = calls_during(lambda: spawn_haiku(f"{stub}/clean-usage", "block-all", ledger=path))
            expect(f"haiku spend: {label} — no call, push blocked",
                   0 if calls == 0 and r.returncode == 1 else 1, 0,
                   f"{calls} call(s), exit {r.returncode}\n{r.stderr}")
            expect(f"haiku spend: {label} — the banner says the budget check could not look",
                   0 if "SCAN DID NOT RUN — the budget check could not look" in r.stderr
                   and "could not run — ledger-unreadable" in r.stderr else 1, 0, r.stderr)

        prior = os.environ.get("SCRUB_HAIKU_DAILY_USD")
        try:
            caps = {}
            with contextlib.redirect_stderr(io.StringIO()):
                for raw in ("0.5", "abc", "-1", "nan", "inf"):
                    os.environ["SCRUB_HAIKU_DAILY_USD"] = raw
                    caps[raw] = haiku.daily_cap()
        finally:
            if prior is None:
                os.environ.pop("SCRUB_HAIKU_DAILY_USD", None)
            else:
                os.environ["SCRUB_HAIKU_DAILY_USD"] = prior
        expect("haiku spend: a cap that is not a finite dollar amount applies the default, not no cap",
               0 if caps == {"0.5": 0.5, "abc": 1.0, "-1": 1.0, "nan": 1.0, "inf": 1.0} else 1, 0,
               f"got {caps!r}")

        # --- 8. --spend-report ------------------------------------------------
        report = ledger("report.jsonl",
                        ledger_line(today, "harborlight-app", 0.25)
                        + ledger_line(today, "saltmarsh-tools", 0.5)
                        + ledger_line(yesterday, "riverbend-archive", 9.0))
        r, calls = calls_during(lambda: spawn_haiku(f"{stub}/clean-usage", "block-all", ledger=report,
                                                    argv=("--spend-report",)))
        expect("haiku spend: --spend-report exits 0 and makes no call",
               0 if r.returncode == 0 and calls == 0 else 1, 0,
               f"exit {r.returncode}, {calls} call(s)\n{r.stdout}\n{r.stderr}")
        expect("haiku spend: ...printing today's total, the cap, and each repo's share of today",
               0 if "$0.7500" in r.stdout and "$1.00" in r.stdout
               and "harborlight-app" in r.stdout and "$0.2500" in r.stdout
               and "saltmarsh-tools" in r.stdout and "$0.5000" in r.stdout
               and "riverbend-archive" not in r.stdout else 1, 0, r.stdout)
        expect("haiku spend: ...and books nothing",
               0 if len(read_ledger(report)) == 3 else 1, 0)

        r = spawn_haiku(f"{stub}/clean", "block-all", ledger=a_dir, argv=("--spend-report",))
        expect("haiku spend: --spend-report on an unreadable ledger fails and says it could not look",
               0 if r.returncode == 2 and "could not look" in r.stderr else 1, 0,
               f"exit {r.returncode}\n{r.stdout}\n{r.stderr}")
    finally:
        server.shutdown()
        server.server_close()
        tmp.cleanup()


# A push big enough to be read in pieces, or the pieces case proves nothing.
CHUNK_FLOOR = 2


# --- The rules pass in front of Haiku ----------------------------------------
#
# `scrub_names.py` decides which lines of a push Haiku reads. A line it passes
# over is never judged, so every case here is a presence the pass must keep:
# a name it must flag, a neighbour it must carry along, a planted recall case
# it must still send. The one absence asserted — a push with nothing new makes
# no call — is asserted at the stub, where a call would land.

# Ordinary prose for a public tree to be made of, written RARE_BELOW times so
# that its words count as published rather than rare. Every word a case below
# adds is either from here, or is the name the case is about.
RULES_PUBLIC_TEXT = (
    "The ferry timetable moved. Every sailing now leaves from the north pier,\n"
    "and the late sailing waits for the last train. Update the board when the\n"
    "timetable changes, and note the pier on each row of notes.md.\n"
    "Row one of the ferry timetable. Row two of the ferry timetable.\n"
    "Row three of the ferry timetable. Every sailing waits. The north pier.\n"
) * scrub_names.RARE_BELOW


def rules_patch(path: str, added: list[str]) -> str:
    return (
        f"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n"
        f"@@ -0,0 +1,{len(added)} @@\n" + "".join(f"+{line}\n" for line in added)
    )


def check_rules_pass() -> None:
    """Only lines that may hold a name go to Haiku, and a push with none makes no call."""
    public = scrub_names.Vocabulary()
    public.learn(RULES_PUBLIC_TEXT)
    ordinary = "Update the board when the timetable changes."

    for kind, line, word in (
        ("person", "Thanks to Jane Roe for checking the pier.", "roe"),
        ("organisation", "The timetable now comes from Harborlight Labs.", "harborlight"),
        ("project", "Moved the sailing rows over to riverbend-sync.", "riverbend"),
    ):
        chosen = scrub_names.select(rules_patch("notes.md", [ordinary, line, ordinary]), public)
        expect(f"rules pass: a line naming a fictional {kind} is flagged",
               0 if word in chosen.triggers else 1, 0, f"triggers {sorted(chosen.triggers)!r}")
        expect(f"rules pass: ...and sent to Haiku ({kind})",
               0 if f"+{line}" in chosen.text else 1, 0, chosen.text)

    # Haiku judges more than names. A number, an amount, a reading or a key on
    # a line of published words is still new, and is sent for the same reason.
    for kind, line, mark in (
        ("phone number", "Every sailing waits 000 000 0000.", "# "),
        ("account number", "Every sailing waits 00000000.", "# "),
        ("amount", "Every sailing waits $0.00.", "$ "),
        ("reading", "Every sailing waits 0 mg/dL.", "reading "),
        ("key", "Every sailing waits EXAMPLE_KEY_00000000000000.", "key "),
        ("letters-only key", "Every sailing waits " + "EXAMPLEKEY" * 5 + ".", "key "),
    ):
        chosen = scrub_names.select(rules_patch("notes.md", [ordinary, line, ordinary]), public)
        expect(f"rules pass: a line of published words with a {kind} on it is sent",
               0 if f"+{line}" in chosen.text and any(t.startswith(mark) for t in chosen.triggers) else 1,
               0, f"triggers {sorted(chosen.triggers)!r}")

    chosen = scrub_names.select(rules_patch("notes.md", [ordinary] * 3), public)
    expect("rules pass: a diff of already-published words sends nothing",
           0 if chosen.text == "" and chosen.read >= 3 and chosen.flagged == 0 else 1, 0,
           f"read {chosen.read}, flagged {chosen.flagged}, text {chosen.text!r}")

    # Context: two lines either side travel, the third does not, and no
    # neighbour is borrowed from the next file.
    around = [f"Row {n} of the ferry timetable." for n in ("one", "two", "three")]
    far = ["Every sailing waits.", "The north pier."]
    body = far[:1] + around + ["Jane Roe moved the late sailing."] + around[::-1] + far[1:]
    patch = rules_patch("notes.md", body) + rules_patch("timetable.md", ["The north pier."])
    chosen = scrub_names.select(patch, public)
    expect("rules pass: the two lines before and after a flagged line travel with it",
           0 if all(f"+{x}" in chosen.text for x in around[1:] + around[::-1][:2]) else 1, 0,
           chosen.text)
    expect("rules pass: ...the third does not, nor does the next file",
           0 if "+Row one" not in chosen.text and "Every sailing" not in chosen.text
           and "timetable.md" not in chosen.text else 1, 0, chosen.text)
    expect("rules pass: ...and the excerpt still says which file and hunk it is from",
           0 if chosen.text.startswith("diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@")
           else 1, 0, chosen.text)

    # The name a push publishes as a commit identity is new unless push_patch
    # already swapped it for the placeholder.
    header = ("commit 0123456789abcdef0123456789abcdef01234567\n"
              "Author: {who}\nDate:   Mon Jan 1 00:00:00 2099 +0000\n\n    Update the board.\n")
    unknown = scrub_names.select(header.format(who="Jane Roe <roe@example.invalid>"),
                                 public, scrub_git.IDENTITY_PLACEHOLDER)
    known = scrub_names.select(header.format(who=scrub_git.IDENTITY_PLACEHOLDER),
                               public, scrub_git.IDENTITY_PLACEHOLDER)
    expect("rules pass: an author identity the remote has not published is sent",
           0 if "Author: Jane Roe" in unknown.text else 1, 0, unknown.text)
    expect("rules pass: ...and one it has (the placeholder) is not",
           0 if known.text == "" else 1, 0, known.text)

    # Every planted recall case still reaches Haiku. The vocabulary is what
    # the case's own neighbourhood publishes: the fragment's words and the
    # file it sits in, read from this checkout.
    recall_spec = importlib.util.spec_from_file_location("scrub_recall", os.path.join(HERE, "scrub-recall.py"))
    recall = importlib.util.module_from_spec(recall_spec)
    recall_spec.loader.exec_module(recall)
    spec = json.load(open(recall.CASES))
    planted = [c for c in spec["positives"] if c["kind"] == "planted"]
    for case in planted:
        fragment = spec["fragments"][case["fragment"]]
        vocab = scrub_names.Vocabulary()
        vocab.learn("\n".join(x.replace("{name}", "") for x in fragment["lines"]))
        target = os.path.join(os.path.dirname(HERE), fragment["path"])
        if os.path.exists(target):
            with open(target, encoding="utf-8", errors="replace") as f:
                vocab.learn(f.read())
        name = recall.fabricate_name(case["fragment"])
        chosen = scrub_names.select(recall.plant(fragment, name), vocab)
        sent = [x for x in chosen.text.split("\n") if name in x]
        expect(f"rules pass: recall case {case['id']} still sends its planted name",
               0 if sent and len(sent) == sum(name in x for x in fragment_lines(fragment, name)) else 1, 0,
               f"{len(sent)} line(s) sent")
    expect("rules pass: the recall cases above include planted positives",
           0 if len(planted) >= 5 else 1, 0, f"{len(planted)} planted")

    # End to end, at the stub: nothing new means no call and nothing booked;
    # one name means one call. `--public-base` names the fixture's commit.
    server, stub = start_haiku_stub()
    tmp = tempfile.TemporaryDirectory()
    try:
        repo = os.path.join(tmp.name, "saltmarsh-rules-repo")
        os.makedirs(repo)
        clean = clean_git_env()

        def g(*args: str) -> str:
            return subprocess.run(["git", *IDENT, *args], cwd=repo, check=True,
                                  capture_output=True, text=True, env=clean).stdout.strip()

        g("init", "-q")
        with open(os.path.join(repo, "notes.md"), "w") as f:
            f.write(RULES_PUBLIC_TEXT)
        g("add", "-A")
        g("commit", "-qm", "timetable")
        ledger = os.path.join(tmp.name, "spend.jsonl")

        def pushed(lines: list[str]):
            before = HaikuStub.calls
            r = spawn_haiku(f"{stub}/clean-usage", "block-all", ledger=ledger, cwd=repo,
                            stdin=rules_patch("notes.md", lines), argv=("--public-base", "HEAD"))
            return r, HaikuStub.calls - before

        r, calls = pushed(["Update the board when the timetable changes."] * 2)
        expect("rules pass: a push with no flagged line makes no API call",
               0 if r.returncode == 0 and calls == 0 else 1, 0, f"exit {r.returncode}, {calls} call(s)\n{r.stderr}")
        expect("rules pass: ...and books nothing",
               0 if not os.path.exists(ledger) else 1, 0, str(read_ledger(ledger)))
        r, calls = pushed(["Update the board when the timetable changes.",
                           "Jane Roe moved the late sailing."])
        expect("rules pass: a push with a flagged line makes the call",
               0 if r.returncode == 0 and calls == 1 and len(read_ledger(ledger)) == 1 else 1, 0,
               f"exit {r.returncode}, {calls} call(s)\n{r.stderr}")

        # The hook's mode finds the public base itself: the newest commit
        # just outside the push that a remote-tracking ref already holds.
        first = g("rev-parse", "HEAD")
        g("update-ref", "refs/remotes/origin/main", first)
        with open(os.path.join(repo, "notes.md"), "a") as f:
            f.write("The pier reopened.\n")
        g("commit", "-qam", "pier")
        probe = subprocess.run(
            [sys.executable, "-c", "import sys, scrub_names; print(scrub_names.public_base(sys.argv[1:]))",
             "HEAD", "--not", "--remotes=origin"],
            cwd=repo, capture_output=True, text=True, env={**clean, "PYTHONPATH": HERE},
        )
        expect("rules pass: --push-tip reads its vocabulary at the commit the remote already has",
               0 if probe.stdout.strip() == first else 1, 0, f"{probe.stdout}{probe.stderr}")
    finally:
        server.shutdown()
        server.server_close()
        tmp.cleanup()


def fragment_lines(fragment: dict, name: str) -> list[str]:
    return [x.replace("{name}", name) for x in fragment["lines"]]


def check_push_range(registry: str, denylist: str) -> None:
    """The merge false positive, and the three ways it must not become a miss.

    Reported three times in one day by two agents: a push blocked over content
    that was already on origin/main and appeared zero times in the branch's own
    diff. Measured cause: the hook asked `git diff remote_sha..local_sha`, a
    comparison of two TREES, so merging main re-presented everything main had
    gained as an addition — 7,516 insertions across 64 files for a branch whose
    own change was two lines.

    Every case here is two-sided on purpose. "The gate passes now" is worth
    nothing without a companion showing the fixture really does contain
    something a scanner can see, and without companions showing the same range
    still catches a leak the push would genuinely publish.
    """
    with tempfile.TemporaryDirectory() as tmp:
        # --- 1. the false positive itself ---------------------------------
        repo = os.path.join(tmp, "clean-merge")
        shas = build_merge_fixture(repo)

        # Positive control: under the OLD question the fixture blocks. Without
        # this, "the new question passes" could just mean the fixture is empty.
        r = run(["--diff-range", f"{shas['pushed']}..{shas['tip']}"],
                registry, denylist, cwd=repo)
        expect("merge FP: the old tree-diff range flags main's public content",
               r.returncode, 1, r.stderr)

        r = run(["--push-tip", shas["tip"], "--already-public", shas["pushed"]],
                registry, denylist, cwd=repo)
        expect("merge FP: the push range does not", r.returncode, 0, r.stderr)

        # And the Haiku layer's actual input, which is a diff rather than a
        # file list — the layer that was reported broken. No API call needed:
        # what changed is what the model is shown.
        patch = push_patch_in(repo, shas["tip"], shas["pushed"])
        expect("merge FP: main's public content is absent from the Haiku input",
               0 if PUBLIC_TOKEN not in patch else 1, 0,
               f"{PUBLIC_TOKEN!r} still present in {len(patch)} chars of patch")

        # --- 2. a genuine addition in an ordinary commit ------------------
        repo2 = os.path.join(tmp, "leak-in-commit")
        shas2 = build_merge_fixture(repo2, branch_token=NEW_TOKEN)
        r = run(["--push-tip", shas2["tip"], "--already-public", shas2["pushed"]],
                registry, denylist, cwd=repo2)
        expect("a leak in the branch's own commit is still caught",
               r.returncode, 1, r.stderr)

        # --- 3. a genuine addition made INSIDE the merge commit -----------
        # `git log -p` prints no diff for a merge by default, so without --cc
        # this is the shape the fix would have started hiding. Probed both
        # ways before it was written.
        repo3 = os.path.join(tmp, "leak-in-merge")
        shas3 = build_merge_fixture(repo3, conflict_token=NEW_TOKEN)
        r = run(["--push-tip", shas3["tip"], "--already-public", shas3["pushed"]],
                registry, denylist, cwd=repo3)
        expect("a leak written during conflict resolution is still caught",
               r.returncode, 1, r.stderr)

        patch3 = push_patch_in(repo3, shas3["tip"], shas3["pushed"])
        expect("...and reaches the Haiku input too",
               0 if NEW_TOKEN in patch3 else 1, 0,
               "the merge commit's combined diff is missing from the patch (--cc dropped?)")

        # --- 4. a brand-new branch (remote_sha is all zeroes) --------------
        # The hook passes the zero sha straight through; if it ever reached git
        # as a rev, every push of a new branch would die with "bad revision".
        repo4 = os.path.join(tmp, "new-branch")
        shas4 = build_merge_fixture(repo4, branch_token=NEW_TOKEN)
        subprocess.run(["git", *IDENT, "update-ref", "-d", "refs/remotes/origin/feature"],
                       cwd=repo4, check=True, capture_output=True, env=clean_git_env())
        r = run(["--push-tip", shas4["tip"], "--already-public", "0" * 40],
                registry, denylist, cwd=repo4)
        expect("a first push of a new branch still scans its own commits",
               r.returncode, 1, r.stderr)

        # --- 5. the author trailer (PR #198) -------------------------------
        # Every commit in this fixture is authored by an identity origin/main
        # already carries, so its Author lines publish nothing new. They must
        # not reach Haiku as scannable identities — that is the finding that
        # blocked PR #198 eleven times over and forced SCRUB_SKIP_HAIKU=1.
        repo5 = os.path.join(tmp, "author-trailer")
        shas5 = build_merge_fixture(repo5, branch_token=NEW_TOKEN)
        patch5 = push_patch_in(repo5, shas5["tip"], shas5["pushed"])
        expect("an already-public author identity is absent from the Haiku input",
               0 if "selftest@example.invalid" not in patch5 else 1, 0,
               "the commit-metadata identity still reaches Haiku")
        # Positive control: the redaction visibly fired. Without this, an
        # empty patch — or a git that stopped printing Author lines — would
        # pass the absence check while proving nothing.
        expect("...and the placeholder marks where it fired",
               0 if scrub_git.IDENTITY_PLACEHOLDER in patch5 else 1, 0,
               "no placeholder in the patch: nothing was actually redacted")

        # --- 6. an email genuinely ADDED in file content -------------------
        # The other half of the same fix, and the reason it must stay narrow:
        # a content email is exactly what the Haiku layer exists to catch.
        repo6 = os.path.join(tmp, "content-email")
        shas6 = build_merge_fixture(repo6, branch_token=f"write to {LEAK_EMAIL} about this")
        patch6 = push_patch_in(repo6, shas6["tip"], shas6["pushed"])
        expect("an email added in file content still reaches the Haiku input",
               0 if LEAK_EMAIL in patch6 else 1, 0,
               "the content email was stripped — the redaction is too wide")
        expect("...while the same push's author metadata stays redacted",
               0 if "selftest@example.invalid" not in patch6 else 1, 0,
               "the metadata identity leaked back in alongside the content email")


def check_blob_source(registry: str, denylist: str) -> None:
    """The scanner reads what the push PUBLISHES, not what is on disk.

    Until the Urgent-fixes ticket (2026-09-02) the file LIST came from git and
    the BYTES came from the working tree. Two ways that lies, each pinned
    here with its mirror image: a leak committed and then removed from the
    working tree (uncommitted) — the push carries it, the old scanner read a
    clean file and passed; and a leak typed into the working tree but never
    committed — the push does not carry it, the old scanner blocked a clean
    push. `--diff-range` and `--push-tip` must both read the tip blob.
    """
    clean = clean_git_env()

    def repo_with(committed: str, on_disk: str) -> tuple[str, str, str]:
        root = tempfile.mkdtemp(prefix="scrub-blob-")

        def g(*args: str) -> str:
            return subprocess.run(
                ["git", *IDENT, *args], cwd=root, check=True,
                capture_output=True, text=True, env=clean,
            ).stdout.strip()

        g("init", "-q")
        with open(os.path.join(root, "notes.md"), "w") as f:
            f.write("seed\n")
        g("add", "-A")
        g("commit", "-qm", "seed")
        base = g("rev-parse", "HEAD")
        with open(os.path.join(root, "notes.md"), "w") as f:
            f.write(committed)
        g("add", "-A")
        g("commit", "-qm", "the pushed commit")
        tip = g("rev-parse", "HEAD")
        # The working tree diverges from the tip WITHOUT a commit.
        with open(os.path.join(root, "notes.md"), "w") as f:
            f.write(on_disk)
        g("update-ref", "refs/remotes/origin/main", base)
        return root, base, tip

    # 1. committed leak, disk cleaned: the push carries it.
    root, base, tip = repo_with(f"a line naming {NEW_TOKEN}\n", "a clean line\n")
    r = run(["--diff-range", f"{base}..{tip}"], registry, denylist, cwd=root)
    expect("blob source: --diff-range sees a committed leak the working tree no longer has",
           r.returncode, 1, r.stderr)
    r = run(["--push-tip", tip, "--already-public", base], registry, denylist, cwd=root)
    expect("blob source: --push-tip sees it too", r.returncode, 1, r.stderr)

    # 2. committed clean, disk leaks: the push does NOT carry it.
    root, base, tip = repo_with("a clean line\n", f"typed but not committed: {NEW_TOKEN}\n")
    r = run(["--diff-range", f"{base}..{tip}"], registry, denylist, cwd=root)
    expect("blob source: --diff-range ignores an uncommitted leak on disk",
           r.returncode, 0, r.stderr)
    r = run(["--push-tip", tip, "--already-public", base], registry, denylist, cwd=root)
    expect("blob source: --push-tip ignores it too", r.returncode, 0, r.stderr)

    # 3. --staged reads the index, not the file: stage a leak, then edit the
    # file clean on disk. A working-tree read passes; an index read blocks.
    root, base, tip = repo_with("a clean line\n", "a clean line\n")
    with open(os.path.join(root, "notes.md"), "w") as f:
        f.write(f"staged leak {NEW_TOKEN}\n")
    subprocess.run(["git", *IDENT, "add", "-A"], cwd=root, check=True,
                   capture_output=True, env=clean)
    with open(os.path.join(root, "notes.md"), "w") as f:
        f.write("cleaned on disk after staging\n")
    r = run(["--staged"], registry, denylist, cwd=root)
    expect("blob source: --staged reads the index, not the file", r.returncode, 1, r.stderr)

    # 4. a bare A..B with no right-hand side is a setup error, not a scan of
    # nothing — the third costume of "exit 0 having looked at nothing".
    r = run(["--diff-range", base], registry, denylist, cwd=root)
    expect("blob source: a bare rev is refused as a range", r.returncode, 2, r.stderr)


def check_never_allow(registry: str, denylist: str, fixture) -> None:
    """Types that are always scanned and can never be allowlisted.

    Each was SKIPPED before — the extension filter read them as binaries —
    so the positive half of every pair below is new coverage, and the
    `scrub-allow` half proves the exemption is refused in these types even in
    the trailing-comment spelling that works everywhere else.
    """
    cases = [
        ("data.csv", f"id,note\n1,{DENY_TOKEN}\n", "a .csv is scanned"),
        ("events.jsonl", f'{{"note": "{DENY_TOKEN}"}}\n', "a .jsonl is scanned"),
        ("corpus.ydoc", f"binary-ish header\x00{DENY_TOKEN}\n", "a .ydoc is scanned"),
        ("logo.svg", f"<svg><title>{DENY_TOKEN}</title></svg>\n", "an .svg is scanned"),
        ("config.xml", f"<c><note>{DENY_TOKEN}</note></c>\n", "an .xml is scanned"),
        ("NOTES", f"an extension-less file mentioning {DENY_TOKEN}\n",
         "an extension-less file is scanned outside scripts/ and .githooks/"),
        ("pixel.png", f"\x89PNG\r\n\x1a\n{DENY_TOKEN}".encode("latin-1").decode("latin-1"),
         "an image is scanned"),
    ]
    for name, body, label in cases:
        r = run([fixture(name, body)], registry, denylist)
        expect(f"never-allow: {label}", r.returncode, 1, r.stderr)
        # The same content with a trailing allow comment — the spelling that
        # exempts a .md line — must NOT exempt it here.
        allowed = fixture(f"allowed-{name}", body.rstrip("\n") + " <!-- scrub-allow --> # scrub-allow\n")
        r = run([allowed], registry, denylist)
        expect(f"never-allow: ...and scrub-allow cannot exempt it", r.returncode, 1, r.stderr)


def check_never_push(registry: str, denylist: str, fixture) -> None:
    """A meeting's raw record is refused by NAME, whatever it contains.

    The positive half is a file with nothing a pattern would catch — a clean
    transcript is still a transcript — and the control is the same clean
    body under a name the rule does not cover, which must pass. The last
    case runs with NO pattern sources: the refusal must not depend on them.
    """
    clean = "- [10:00:00Z] Speaker 1: nothing here trips a pattern\n"
    cases = [
        ("q3-plan-raw-transcript.md", clean, 1, "a raw transcript is refused by name"),
        ("q3-plan-raw-transcript-replay-20260902T101500Z.md", clean, 1,
         "a replay transcript is refused by name"),
        ("segment-1-mic.pcm", "\x00\x01\x02\x03", 1, "raw audio is refused by type"),
        ("room.wav", "RIFF....WAVE", 1, "a .wav is refused by type"),
        ("q3-plan-transcript-notes.md", clean, 0,
         "control: the same clean body under an uncovered name passes"),
    ]
    for name, body, want, label in cases:
        r = run([fixture(name, body)], registry, denylist)
        expect(f"never-push: {label}", r.returncode, want, r.stderr)
    r = run([fixture("allowed-raw-transcript.md", clean.rstrip("\n") + " <!-- scrub-allow -->\n")],
            registry, denylist)
    expect("never-push: ...and scrub-allow cannot exempt it", r.returncode, 1, r.stderr)
    r = run([fixture("sourceless-raw-transcript.md", clean)], None, None)
    expect("never-push: refused even with no pattern sources on the machine", r.returncode, 1, r.stderr)


def check_allow_token_position(registry: str, denylist: str, fixture) -> None:
    """`scrub-allow` exempts a line only as a trailing comment token."""
    cases = [
        (f"{PRIVATE_PROJECT} <!-- scrub-allow: documenting the gate -->\n", 0,
         "a trailing HTML comment exempts"),
        (f"ref = '{PRIVATE_PROJECT}'  # scrub-allow\n", 0, "a trailing # comment exempts"),
        (f"ref = '{PRIVATE_PROJECT}'; // scrub-allow — fixture\n", 0, "a trailing // comment exempts"),
        (f"/* scrub-allow */ {PRIVATE_PROJECT}\n", 1,
         "a LEADING comment does not — the token must trail the content"),
        (f"{PRIVATE_PROJECT} scrub-allow is just a word here\n", 1,
         "the bare word mid-line does not"),
        (f"url = 'https://x.example/{PRIVATE_PROJECT}?scrub-allow=1'\n", 1,
         "the word inside a string or URL does not"),
        (f"url = 'https://x.example/{PRIVATE_PROJECT}#scrub-allow'\n", 1,
         "a #-fragment glued to a URL is not a comment opener"),
        (f"ref = '{PRIVATE_PROJECT}' /* scrub-allow */\n", 0,
         "a trailing block comment that closes at end of line exempts"),
    ]
    for body, want, label in cases:
        r = run([fixture(f"allow-{abs(hash(label))}.md", body)], registry, denylist)
        expect(f"allow token: {label}", r.returncode, want, r.stderr)


def check_multiline(registry: str, denylist: str, fixture) -> None:
    """A phrase a line wrap broke in half is still one phrase.

    The scanner searched one line at a time, so a private phrase that a
    formatter or an editor wrapped was handed to the patterns as two
    unrelated halves and matched nothing. Every case here ships with the same
    needle on ONE line, because a clean exit reads identically as "the fix
    works" and "the needle was never in this fixture" — and the fixture
    denylist gained three entries for these cases, so the one-line controls
    are also what proves those entries compile at all.

    The `.` cases run the other way: widening `.` to cross a newline would let
    a narrow pattern swallow half a file, so it must still refuse. That case's
    control is the same pattern matching a character on its own line, which is
    what separates "`.` correctly refused" from "the pattern is dead".
    """
    L, R = WRAPPED_LEFT, WRAPPED_RIGHT
    cases = [
        (f"We reused {L} {R} again.\n", 1,
         "control — a two-word literal on one line is caught"),
        (f"We reused {L}\n{R} again.\n", 1,
         "a two-word literal broken across a line wrap is caught"),
        (f"We reused {L}\n    {R} again.\n", 1,
         "...and when the wrapped continuation is indented"),
        (f"We reused {L}  \n\t{R} again.\n", 1,
         "...and across trailing space, the break, and a tab"),
        # `scrub-allow` is a TRAILING comment token, so on the first line of a
        # span the phrase necessarily begins inside the comment — which is the
        # real shape: a line documenting the gate, wrapped by a formatter.
        (f"notes # scrub-allow {L}\n{R} tail\n", 0,
         "the marker on the FIRST line of the span suppresses"),
        (f"lead {L}\n{R} tail # scrub-allow\n", 0,
         "the marker on the LAST line of the span suppresses"),
        (f"lead {L}\n{R} tail\n", 1,
         "control — the same two shapes without the marker are caught"),
        (f"a {SPACED_RX_LEFT} {SPACED_RX_RIGHT} b\n", 1,
         rf"control — a denylist regex spelling its gap \s+ matches on one line"),
        (f"a {SPACED_RX_LEFT}\n{SPACED_RX_RIGHT} b\n", 1,
         r"...and now matches the newline it was always written to match"),
        (f"a {DOT_RX_LEFT}-{DOT_RX_RIGHT} b\n", 1,
         "control — a `.` in a denylist regex matches a character on its line"),
        (f"a {DOT_RX_LEFT}\n{DOT_RX_RIGHT} b\n", 0,
         "...and still refuses to cross the line break"),
    ]
    for i, (body, want, label) in enumerate(cases):
        r = run([fixture(f"multiline-{i}.md", body)], registry, denylist)
        expect(f"multiline: {label}", r.returncode, want, r.stderr)

    # The finding has to point somewhere useful. It names the line the phrase
    # STARTS on, and says where it ends when it crosses one — a report that
    # named only a line number would send the writer to a line whose text does
    # not contain the phrase.
    r = run([fixture("multiline-span.md", f"pad\npad\nWe reused {L}\n{R} again.\n")],
            registry, denylist)
    expect("multiline: a wrapped finding is reported", r.returncode, 1, r.stderr)
    expect("multiline: ...at the line the phrase starts on",
           0 if "multiline-span.md:3" in r.stderr else 1, 0, r.stderr)
    expect("multiline: ...and says it spans through the next line",
           0 if "lines 3-4" in r.stderr else 1, 0, r.stderr)


def check_attribution(registry: str, denylist: str) -> None:
    """The push gate keeps the whole-blob read, and says who wrote each hit.

    Whole blobs are right for a push and produce a finding the branch may not
    have written — a file it merely touched, whose offending line has been on
    the remote for weeks (PR 723). The remedy for the two cases is completely
    different, and the expensive one, a history rewrite, is the step an agent
    is not allowed to take. So each case below asserts the VERDICT TEXT, not
    just the exit code: both push scans block, and being told which kind of
    block it is, is the entire value.
    """
    clean = clean_git_env()

    def build(branch_line: str) -> tuple[str, str, str]:
        root = tempfile.mkdtemp(prefix="scrub-attr-")

        def g(*args: str) -> str:
            return subprocess.run(
                ["git", *IDENT, *args], cwd=root, check=True,
                capture_output=True, text=True, env=clean,
            ).stdout.strip()

        g("init", "-q")
        with open(os.path.join(root, "plan.md"), "w") as f:
            f.write(f"a dated plan\nan old line naming {PUBLIC_TOKEN}\n")
        g("add", "-A")
        g("commit", "-qm", "the plan, with the name already in it")
        base = g("rev-parse", "HEAD")
        # `origin/main` already carries the line above.
        g("update-ref", "refs/remotes/origin/main", base)
        with open(os.path.join(root, "plan.md"), "a") as f:
            f.write(branch_line)
        g("add", "-A")
        g("commit", "-qm", "the branch's own commit")
        return root, base, g("rev-parse", "HEAD")

    # 1. The branch touched the file and added nothing sensitive. The blob
    #    still carries the name, so the push gate still blocks — and must say
    #    the line is already public, which is what makes a forward fix the
    #    right answer.
    root, base, tip = build("a line the branch actually wrote\n")
    r = run(["--push-tip", tip, "--already-public", base], registry, denylist, cwd=root)
    expect("attribution: the push gate still reads whole blobs", r.returncode, 1, r.stderr)
    expect("attribution: ...and names the already-public commit (forward fix)",
           0 if ("already on the remote in " + base[:9]) in r.stderr else 1, 0, r.stderr)
    expect("attribution: ...and does not call it introduced",
           0 if "introduced by" not in r.stderr else 1, 0, r.stderr)

    # 2. The branch wrote the line itself: the push publishes it, so the
    #    remedy is the history, and the message has to say so.
    root, base, tip = build(f"the branch adds {PUBLIC_TOKEN} itself\n")
    r = run(["--push-tip", tip, "--already-public", base], registry, denylist, cwd=root)
    expect("attribution: a line the branch wrote blocks too", r.returncode, 1, r.stderr)
    expect("attribution: ...and is named as introduced by the branch commit",
           0 if ("introduced by " + tip[:9]) in r.stderr else 1, 0, r.stderr)


REPO_ROOT = os.path.dirname(HERE)
PRE_COMMIT_HOOK = os.path.join(REPO_ROOT, ".githooks", "pre-commit")


def check_commit_path(registry: str, denylist: str) -> None:
    """The COMMIT gate: can it see, and does it judge only what is added?

    Both halves are load-bearing and neither is worth anything alone. A gate
    that cannot see reports every commit clean — the failure this whole file
    exists for. A gate that reads whole blobs refuses every edit to a file
    whose untouched lines already carry a match, which is a tax on working
    near old content and the reliable way to train people into SCRUB_SKIP=1.
    So the pre-existing-match case below ships with its own control: the same
    index, read whole-blob by `--staged`, MUST fire. Without that control,
    "it committed cleanly" would also be the reading if the fixture never
    carried the needle at all.
    """
    clean = clean_git_env()

    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "repo")
        os.makedirs(root)

        def g(*args: str, check: bool = True):
            return subprocess.run(
                ["git", *IDENT, *args], cwd=root, check=check,
                capture_output=True, text=True, env=clean,
            )

        def write(rel: str, body: str) -> None:
            path = os.path.join(root, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                f.write(body)

        def commits() -> int:
            out = g("rev-list", "--count", "HEAD", check=False).stdout.strip()
            return int(out) if out.isdigit() else 0

        g("init", "-q")
        # The pre-existing match: committed, public, untouched by anything below.
        write("notes.md", f"seed line one\nan older line naming {DENY_TOKEN}\nseed line three\n")
        g("add", "-A")
        g("commit", "-qm", "seed")

        # 1. THE POSITIVE CONTROL. A staged addition carrying a needle must be
        #    caught, or every other result here is worthless.
        write("fresh.md", f"We are reusing {NEW_TOKEN} for this.\n")
        g("add", "-A")
        r = run(["--staged-added"], registry, denylist, cwd=root)
        expect("commit path: catches a needle in a staged ADDED line", r.returncode, 1, r.stderr)
        g("reset", "-q")
        os.remove(os.path.join(root, "fresh.md"))

        # 2. THE POINT OF THE COMMIT GATE. One unrelated line changed in a file
        #    whose OTHER lines already carry a match: nothing new is added, so
        #    nothing is refused.
        write("notes.md", f"seed line one EDITED\nan older line naming {DENY_TOKEN}\nseed line three\n")
        g("add", "-A")
        r = run(["--staged-added"], registry, denylist, cwd=root)
        expect("commit path: an edit near a pre-existing match commits cleanly",
               r.returncode, 0, r.stderr)

        # 2b. ...and the control that makes 2 mean something: the same index,
        #     read whole-blob, still fires. So the file really does carry it.
        r = run(["--staged"], registry, denylist, cwd=root)
        expect("commit path: control — whole-blob --staged still sees that match",
               r.returncode, 1, r.stderr)

        # 2c. Added lines that are NOT neighbours must not be glued together.
        #     The scanner searches whole text now, and the commit gate feeds it
        #     only the added lines; concatenating two distant hunks would
        #     manufacture a phrase the file does not contain. So the two halves
        #     of a needle, added eight lines apart, must NOT fire...
        write("spread.md", "\n".join(f"body line {n}" for n in range(1, 10)) + "\n")
        g("add", "-A")
        g("commit", "-qm", "spread seed")
        lines = [f"body line {n}" for n in range(1, 10)]
        lines[0] = f"body line 1 {WRAPPED_LEFT}"
        lines[8] = f"{WRAPPED_RIGHT} body line 9"
        write("spread.md", "\n".join(lines) + "\n")
        g("add", "-A")
        r = run(["--staged-added"], registry, denylist, cwd=root)
        expect("commit path: two distant added hunks are not glued into a phrase",
               r.returncode, 0, r.stderr)

        # 2d. ...and the control: the same two halves on ADJACENT added lines
        #     are one phrase and must fire. Without it, 2c passes just as well
        #     when the needle is absent or the entry never compiled.
        lines = [f"body line {n}" for n in range(1, 10)]
        lines[0] = f"body line 1 {WRAPPED_LEFT}"
        lines[1] = f"{WRAPPED_RIGHT} body line 2"
        write("spread.md", "\n".join(lines) + "\n")
        g("add", "-A")
        r = run(["--staged-added"], registry, denylist, cwd=root)
        expect("commit path: control — the same halves on adjacent added lines do",
               r.returncode, 1, r.stderr)
        g("checkout", "-q", "--", "spread.md")
        g("reset", "-q")

        # 3. A line the commit adds that STARTS WITH `++` must not be read as a
        #    diff file header. Misparsed, it retargets every finding after it to
        #    a file that was never touched — a finding pointing at the wrong
        #    file is how a writer edits the wrong thing and re-commits the leak.
        write("notes.md",
              f"seed line one EDITED\nan older line naming {DENY_TOKEN}\nseed line three\n"
              f"++ b/decoy.md\nand then {NEW_TOKEN} on the next line\n")
        g("add", "-A")
        r = run(["--staged-added"], registry, denylist, cwd=root)
        expect("commit path: a `++`-prefixed added line is content, not a header",
               r.returncode, 1, r.stderr)
        expect("commit path: ...and the finding names the real file",
               0 if "notes.md:" in r.stderr and "decoy.md" not in r.stderr else 1, 0, r.stderr)
        g("reset", "-q")
        g("checkout", "-q", "--", "notes.md")

        # 4. A never-push name is refused at commit time too — the cheapest
        #    place to catch a meeting transcript is before it is written down.
        write("q3-raw-transcript.md", "- [10:00:00Z] Speaker 1: nothing trips a pattern\n")
        g("add", "-A")
        r = run(["--staged-added"], registry, denylist, cwd=root)
        expect("commit path: a raw transcript is refused by name", r.returncode, 1, r.stderr)
        g("commit", "-qm", "land the transcript so it can be removed", check=False)
        # ...and REMOVING one is the fix, not the leak: a deletion must pass.
        os.remove(os.path.join(root, "q3-raw-transcript.md"))
        g("add", "-A")
        r = run(["--staged-added"], registry, denylist, cwd=root)
        expect("commit path: deleting a never-push file commits cleanly",
               r.returncode, 0, r.stderr)
        g("commit", "-qm", "remove it")

        # 5. END TO END, through the real hook. Everything above tests the
        #    scanner; this tests that `git commit` actually stops — and that it
        #    leaves NO COMMIT behind, which is the difference between a warning
        #    and a gate.
        os.makedirs(os.path.join(root, "scripts"), exist_ok=True)
        os.makedirs(os.path.join(root, ".githooks"), exist_ok=True)
        for name in ("scrub-check.py", "scrub_git.py"):
            with open(os.path.join(HERE, name)) as fsrc:
                write(os.path.join("scripts", name), fsrc.read())
        with open(PRE_COMMIT_HOOK) as fsrc:
            write(os.path.join(".githooks", "pre-commit"), fsrc.read())
        os.chmod(os.path.join(root, ".githooks", "pre-commit"), 0o755)
        g("add", "-A")
        g("commit", "-qm", "install the gate")
        g("config", "core.hooksPath", ".githooks")

        hook_env = dict(clean)
        hook_env["SCRUB_REGISTRY"] = registry
        hook_env["SCRUB_DENYLIST"] = denylist
        # The suite is already running; the hook must not start it again.
        hook_env["SCRUB_IN_SELFTEST"] = "1"
        hook_env.pop("SCRUB_SKIP", None)

        def hook_commit(message: str):
            return subprocess.run(
                ["git", *IDENT, "commit", "-q", "-m", message],
                cwd=root, capture_output=True, text=True, env=hook_env,
            )

        before = commits()
        write("leak.md", f"An aside mentioning {DENY_TOKEN} in passing.\n")
        g("add", "-A")
        r = hook_commit("this must not land")
        expect("commit hook: `git commit` of a needle exits non-zero",
               0 if r.returncode != 0 else 1, 0, r.stdout + r.stderr)
        expect("commit hook: ...and no commit was created",
               0 if commits() == before else 1, 0,
               f"HEAD moved from {before} to {commits()} commits")
        expect("commit hook: ...and the message names the file, line and category",
               0 if ("leak.md:1" in r.stderr and DENY_TOKEN in r.stderr
                     and "denylist:" in r.stderr) else 1, 0, r.stdout + r.stderr)

        # The control: with the leak taken out, the same commit lands. A hook
        # that refused everything would pass every assertion above.
        write("leak.md", "An aside mentioning nothing in particular.\n")
        g("add", "-A")
        r = hook_commit("this one lands")
        expect("commit hook: control — a clean commit still lands",
               r.returncode, 0, r.stdout + r.stderr)
        expect("commit hook: ...and HEAD moved", 0 if commits() == before + 1 else 1, 0,
               f"{before} -> {commits()}")

        # Criterion 2 through the hook, not just the scanner: notes.md has
        # carried a match since the seed commit. Editing a DIFFERENT line of it
        # must land. This is the case that decides whether people leave the
        # hook installed.
        at = commits()
        write("notes.md",
              f"seed line one EDITED AGAIN\nan older line naming {DENY_TOKEN}\nseed line three\n")
        g("add", "-A")
        r = hook_commit("edit a line next to an old match")
        expect("commit hook: an edit beside a pre-existing match lands",
               r.returncode, 0, r.stdout + r.stderr)
        expect("commit hook: ...and HEAD moved for it too",
               0 if commits() == at + 1 else 1, 0, f"{at} -> {commits()}")


def _report() -> int:
    if failures:
        print(f"\n{len(failures)} self-test failure(s): {', '.join(failures)}")
        print("The leak gate is not doing what it claims. Do not trust a clean push.")
        return 1
    print("\nall good — the gate can see.")
    return 0


def _write_sources(tmp: str) -> tuple[str, str]:
    registry = os.path.join(tmp, "registry.yaml")
    denylist = os.path.join(tmp, "denylist.txt")
    with open(registry, "w") as f:
        f.write(REGISTRY)
    with open(denylist, "w") as f:
        f.write(DENYLIST)
    return registry, denylist


def main() -> int:
    # `--only commit` runs just the commit-path group. `.githooks/pre-commit`
    # uses it: the full suite is ~3s, which is a real tax per commit, and the
    # commit gate's own blindness is what that hook needs proved before it
    # trusts a clean result.
    argv = sys.argv[1:]
    if "--only" in argv:
        i = argv.index("--only")
        group = argv[i + 1] if i + 1 < len(argv) else ""
        if group not in ("commit", "all"):
            print(f"usage: scrub-selftest.py [--only commit|all]  (got {group!r})")
            return 2
        if group == "commit":
            with tempfile.TemporaryDirectory() as tmp:
                registry, denylist = _write_sources(tmp)
                print("scrub gate self-test — commit path")
                check_commit_path(registry, denylist)
            return _report()

    check_git_env_isolation()
    check_decision_table()
    check_push_rev_args()
    check_identity_redaction()
    check_remote_owner()
    with tempfile.TemporaryDirectory() as tmp:
        check_maintainer_names(tmp)
    check_haiku_unavailable()
    check_haiku_spend()
    check_rules_pass()
    with tempfile.TemporaryDirectory() as tmp:
        registry = os.path.join(tmp, "registry.yaml")
        denylist = os.path.join(tmp, "denylist.txt")
        absent = os.path.join(tmp, "does-not-exist")
        with open(registry, "w") as f:
            f.write(REGISTRY)
        with open(denylist, "w") as f:
            f.write(DENYLIST)

        def fixture(name: str, body: str) -> str:
            p = os.path.join(tmp, name)
            with open(p, "w") as f:
                f.write(body)
            return p

        leaky = fixture("leaky.md", f"We reuse the approach from {PRIVATE_PROJECT} here.\n")
        public_ref = fixture("public.md", f"Built on {PUBLIC_PROJECT}, which is public.\n")
        mentionable_ref = fixture("cleared.md", f"A post about {MENTIONABLE_PROJECT}, cleared to name.\n")
        denied = fixture("denied.md", f"An aside mentioning {DENY_TOKEN} in passing.\n")
        clean = fixture("clean.md", "Nothing sensitive here at all.\n")
        allowed = fixture("allowed.md", f"{PRIVATE_PROJECT} <!-- scrub-allow: documenting the gate -->\n")

        print("scrub gate self-test")

        # The positive control. If this ever passes-as-clean, the gate is blind
        # and every other result in this file is worthless.
        r = run([leaky], registry, denylist)
        expect("catches a private registry project name", r.returncode, 1, r.stderr)

        r = run([denied], registry, denylist)
        expect("catches a denylist pattern", r.returncode, 1, r.stderr)

        # Regex entries, both spellings. The delimited one is the regression
        # pin for the trailing-slash bug; the open one proves the regex branch
        # itself works, so a delimited failure indicts the delimiter handling
        # and nothing else.
        regex_delim = fixture("regex-delim.md", "an id like zonkey-742 appears here\n")
        r = run([regex_delim], registry, denylist)
        expect("catches a /…/-delimited denylist regex", r.returncode, 1, r.stderr)

        regex_open = fixture("regex-open.md", "an id like quagga-99 appears here\n")
        r = run([regex_open], registry, denylist)
        expect("catches a leading-slash-only denylist regex", r.returncode, 1, r.stderr)

        # public: true must suppress. Without this the gate fires on nearly
        # every push and trains people into SCRUB_SKIP=1.
        r = run([public_ref], registry, denylist)
        expect("ignores a project marked public: true", r.returncode, 0, r.stderr)

        # mentionable: true means "cleared to say out loud, repo still private".
        # It must suppress exactly like public does — the gate only ever asks
        # whether a name is safe to say — without anyone having to assert a
        # private repo is public to get that answer.
        r = run([mentionable_ref], registry, denylist)
        expect("ignores a project marked mentionable: true", r.returncode, 0, r.stderr)

        r = run([clean], registry, denylist)
        expect("passes a clean file", r.returncode, 0, r.stderr)

        r = run([allowed], registry, denylist)
        expect("honors an inline scrub-allow", r.returncode, 0, r.stderr)

        # The exact shape of the production bug: one source resolves, the
        # other silently doesn't. Must refuse rather than scan with half its
        # patterns and report success.
        r = run([clean], registry, absent)
        expect("refuses when the denylist is missing", r.returncode, 2, r.stderr)

        r = run([clean], absent, denylist)
        expect("refuses when the registry is missing", r.returncode, 2, r.stderr)

        # A stranger cloning the public repo has no fleet config to be
        # missing — get out of their way, unless asked not to.
        r = run([clean], absent, absent)
        expect("skips cleanly when no source exists at all", r.returncode, 0, r.stderr)

        r = run([clean], absent, absent, SCRUB_REQUIRE_SOURCES="1")
        expect("SCRUB_REQUIRE_SOURCES makes that case hard", r.returncode, 2, r.stderr)

        # The third costume of the same bug: this tool does not read stdin, so
        # piping a diff at it scanned nothing and exited 0. A clean result that
        # established nothing is worse than an error.
        r = run([], registry, denylist)
        expect("refuses when given no files (does not read stdin)", r.returncode, 2, r.stderr)

        # --- Cases below run from INSIDE a repo that carries its own
        # registry.yaml. Everything above passes in both shapes; these two only
        # fail in this one, which is why they exist.
        local_repo = os.path.join(tmp, "repo-with-registry")
        make_repo_with_registry(local_repo, DECOY_PROJECT)
        decoy_ref = fixture("decoy.md", f"Mentions {DECOY_PROJECT}, which only the repo-local registry protects.\n")

        # Two-sided, and it has to be: an override that loses to the repo-local
        # file makes every case above scan the wrong registry while still
        # reporting exactly what the test expects to see.
        r = run([leaky], registry, denylist, cwd=local_repo)
        expect("SCRUB_REGISTRY beats a repo-local registry.yaml", r.returncode, 1, r.stderr)

        r = run([decoy_ref], registry, denylist, cwd=local_repo)
        expect("...and the repo-local registry is then not consulted", r.returncode, 0, r.stderr)

        # The stranger-clone escape hatch, in the shape where it was dead code:
        # with a repo-local registry present, `resolved` could never reach 0, so
        # a clone with no fleet config had every push blocked by a message about
        # paths that were never theirs.
        r = run([clean], absent, absent, cwd=local_repo)
        expect("a clone with no fleet config still pushes (local registry present)", r.returncode, 0, r.stderr)

        check_push_range(registry, denylist)
        check_blob_source(registry, denylist)
        check_commit_path(registry, denylist)
        check_attribution(registry, denylist)
        check_never_allow(registry, denylist, fixture)
        check_never_push(registry, denylist, fixture)
        check_allow_token_position(registry, denylist, fixture)
        check_multiline(registry, denylist, fixture)

    return _report()


if __name__ == "__main__":
    sys.exit(main())
