#!/usr/bin/env python3
"""Measures the name-aware leak scanner: does it catch a name, and does it
block ordinary work while doing it.

`scrub-haiku.py` is the half of the pre-push gate that recognises a real
personal name nobody has put on a denylist. Whether it does is not a property
you can read off the prompt — it is a rate, and it has to be measured before
and after any edit to that prompt. Measured once already: the real commit that
put a person's name on this repository's public main scanned CLEAN on its own
every time, and blocked only when it happened to be pushed beside its three
neighbours. Recall that depends on what else is in the push is not recall.

Two numbers, never one:

  recall  the share of POSITIVE runs that blocked. A positive carries a
          personal name that is not a maintainer's, so a clean verdict is a
          miss and a leak reaches a public branch.
  FP      the share of NEGATIVE runs that blocked. A negative is ordinary
          work. A gate that blocks it is a gate people learn to bypass, and
          the bypass is one environment variable — so a recall fix bought
          with false positives has bought nothing.

Neither is meaningful from a handful of runs: the verdict is sampled from a
model, so every case runs `--runs` times (10 by default) and the table reports
blocked-out-of-runs, not a tick.

  scrub-recall.py                       # every case, 10 runs each
  scrub-recall.py --runs 3 --only planted-test-fixture,ordinary-1
  scrub-recall.py --dry-run             # build every patch, call nothing,
                                        # print sizes and the cost of a run
  scrub-recall.py --json out.json       # per-run verdicts, for a diff of two
                                        # prompts rather than two summaries

Every run is a paid Haiku call. `--dry-run` prints what the full sweep would
cost before you spend it, and the summary prints what it did spend.

The cases are `scrub-recall-cases.json`. Its content is fetched from git by
sha at run time: the one real positive is named by sha and nothing else, so
the name that commit published is not written down here, in that file, or in
anything this script produces.
"""

from __future__ import annotations

import argparse
import contextlib
import importlib.util
import io
import json
import os
import random
import statistics
import subprocess
import sys
import threading
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Dict, List, NamedTuple, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
CASES = os.path.join(HERE, "scrub-recall-cases.json")

sys.path.insert(0, HERE)
import scrub_git  # noqa: E402

_SPEC = importlib.util.spec_from_file_location(
    "scrub_haiku", os.path.join(HERE, "scrub-haiku.py"),
)
haiku = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(haiku)

# Haiku 4.5 list price, dollars per million tokens, and the same conservative
# 4-chars-per-token the scanner itself budgets with.
#
# The first version of this estimate counted the patch and nothing else, and
# under-reported the sweep that tuned the scanner by roughly a third. Two
# things it left out: the system prompt, which goes out once PER PIECE now
# that a big push is read in pieces, and the reply, which lists every name it
# found before the verdict. Neither is visible in the patch size. The reply is
# not metered here — call_haiku does not return usage — so it is priced at an
# assumed length and labelled as an assumption.
USD_PER_MTOK_IN = 1.00
USD_PER_MTOK_OUT = 5.00
CHARS_PER_TOK = 4
ASSUMED_REPLY_TOKENS = 200


class Run(NamedTuple):
    """One scanner call."""

    case: str
    label: str      # "positive" | "negative"
    verdict: str    # "blocked" | "clean" | "unavailable"
    detail: str     # why, when the scanner could not run
    seconds: float


class Case(NamedTuple):
    id: str
    label: str
    patch: str
    why: str


def build_patch(spec: dict, fragments: dict) -> str:
    """The patch text the gate would hand the scanner for this push.

    `push_patch` is the real thing rather than a reimplementation — the same
    `--cc`, the same identity redaction, the same commit messages riding
    along. A case that differs from a push in any of those is measuring
    something a push never sees.

    `--no-walk` is what makes the sha list mean the commits named and nothing
    else. Handed the bare shas, `git log` walks their whole ancestry: the
    first build of this harness produced 67MB patches and priced the sweep at
    $2,024, which is the only reason the mistake was caught rather than paid.
    """
    patch = scrub_git.push_patch(["--no-walk", *spec["shas"]])
    if spec["kind"] == "planted":
        key = spec["fragment"]
        patch += "\n" + plant(fragments[key], fabricate_name(key))
    return patch


# The parts a planted name is built from. A fabricated name is not written
# down anywhere in the repository: a name-shaped string is exactly what the
# scanner under test blocks, so the cases file could not otherwise be pushed
# through the gate it measures. Seeded by fragment, so a fragment plants the
# same name on every run and in every case that uses it.
_GIVEN_ONSETS = ("M", "D", "T", "K", "L", "S", "R", "N", "V", "J")
_GIVEN_RIMES = ("arisol", "evin", "obias", "ara", "elin", "oran", "ika", "avin", "ena", "ilo")
_FAMILY_HEADS = ("Ash", "Mill", "Thorn", "Wren", "Hal", "Brad", "Fen", "Marl", "Cal", "Stan")
_FAMILY_TAILS = ("grove", "brook", "wick", "field", "loway", "ton", "ings", "more", "worth", "ridge")


def fabricate_name(seed: str) -> str:
    """An invented full name, the same one for the same seed."""
    rng = random.Random(zlib.crc32(seed.encode()))
    given = rng.choice(_GIVEN_ONSETS) + rng.choice(_GIVEN_RIMES)
    return f"{given} {rng.choice(_FAMILY_HEADS)}{rng.choice(_FAMILY_TAILS)}"


def plant(fragment: dict, name: str) -> str:
    """A fragment rendered as added lines of a unified diff, `{name}` filled.

    Appended rather than substituted into the host: a substitution has to find
    a line that exists, and silently plants nothing when a rename moves it —
    which would report the prompt as perfect on a case that carried no name.
    """
    path = fragment["path"]
    lines = [line.replace("{name}", name) for line in fragment["lines"]]
    body = "\n".join(f"+{line}" for line in lines)
    return (
        f"diff --git a/{path} b/{path}\n"
        f"--- a/{path}\n"
        f"+++ b/{path}\n"
        f"@@ -1,0 +1,{len(lines)} @@\n"
        f"{body}\n"
    )


def load_cases(only: Optional[List[str]]) -> List[Case]:
    spec = json.load(open(CASES))
    fragments = spec["fragments"]
    cases: List[Case] = []
    for label, key in (("positive", "positives"), ("negative", "negatives")):
        for c in spec[key]:
            if only and c["id"] not in only:
                continue
            if c["kind"] == "planted":
                # A positive that plants no name reads as a perfect scanner;
                # a negative that plants one reads as a false positive.
                slotted = any("{name}" in x for x in fragments[c["fragment"]]["lines"])
                if slotted != (label == "positive"):
                    raise SystemExit(f"[scrub-recall] {c['id']}: a {label} whose fragment "
                                     f"has {'a' if slotted else 'no'} {{name}} slot")
            cases.append(Case(c["id"], label, build_patch(c, fragments), c.get("why", "")))
    missing = set(only or []) - {c.id for c in cases}
    if missing:
        raise SystemExit(f"[scrub-recall] no such case: {', '.join(sorted(missing))}")
    return cases


def scan(case: Case) -> Run:
    """One call, classified into the three answers a run can have.

    `unavailable` is reported as itself rather than folded into `blocked`.
    The shipped policy does block on it, so folding would be defensible and
    would also be the single easiest way to fake a recall number: an expired
    key would read as a perfect scanner.
    """
    t0 = time.monotonic()
    # Truncated exactly as `scrub-haiku.py`'s main() truncates a push before
    # scanning it. Without this, a case past the ceiling measures content the
    # shipped gate never reads, and its recall is a number about a different
    # scanner.
    result = haiku.call_haiku(case.patch[: haiku.MAX_DIFF_CHARS])
    elapsed = time.monotonic() - t0
    if isinstance(result, haiku.Unavailable):
        return Run(case.id, case.label, "unavailable", f"{result.case}: {result.detail}", elapsed)
    return Run(case.id, case.label, "blocked" if result == 1 else "clean", "", elapsed)


def sweep(cases: List[Case], runs: int, jobs: int, on_run: Callable[[Run], None]) -> List[Run]:
    """Every scanner call, with the scanner's own stderr sunk.

    `call_haiku` prints the findings behind a block, which is right for a
    push and wrong here: a positive is a leak on purpose, so a sweep that let
    that through would print the very name this measurement exists to keep
    out of everything, ten times per case, into whatever captured the run.
    The verdict is the measurement; the prose is not.

    `jobs` bounds API REQUESTS, not runs. A case past one piece runs its own
    pool of `CHUNK_JOBS` inside each run, so bounding runs alone let six runs
    of a big case put thirty-six requests in flight — enough to be throttled,
    and a throttled run is `unavailable`, which every rate leaves out. So the
    one limit sits on the request itself.
    """
    work = [c for c in cases for _ in range(runs)]
    out: List[Run] = []
    requests = threading.BoundedSemaphore(jobs)
    real_scan = haiku._scan_piece

    def bounded(piece: str) -> "int | haiku.Unavailable":
        with requests:
            return real_scan(piece)

    haiku._scan_piece = bounded
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            with ThreadPoolExecutor(max_workers=jobs) as pool:
                for run in pool.map(scan, work):
                    out.append(run)
                    on_run(run)
    finally:
        haiku._scan_piece = real_scan
    return out


def estimate_usd(chars: int) -> float:
    return (chars / CHARS_PER_TOK) / 1_000_000 * USD_PER_MTOK_IN


def case_cost(case: Case) -> "tuple[int, float]":
    """(requests, dollars) for ONE run of this case, prompt and reply included."""
    pieces = haiku.split_patch(case.patch[: haiku.MAX_DIFF_CHARS])
    prompt = len(haiku.system_prompt(scrub_git.maintainer_names()))
    chars = sum(len(p) for p in pieces) + prompt * len(pieces)
    reply = len(pieces) * ASSUMED_REPLY_TOKENS / 1_000_000 * USD_PER_MTOK_OUT
    return len(pieces), estimate_usd(chars) + reply


def dry_run(cases: List[Case], runs: int) -> int:
    usd = 0.0
    requests = 0
    print(f"{'case':<26} {'label':<9} {'KB':>7} {'pieces':>6}  {'$/run':>7}  why")
    for c in sorted(cases, key=lambda c: (c.label, c.id)):
        n, cost = case_cost(c)
        usd += cost * runs
        requests += n * runs
        print(f"{c.id:<26} {c.label:<9} {len(c.patch)/1024:7.1f} {n:>6}  "
              f"{cost:7.4f}  {c.why[:60]}")
    print()
    print(f"{len(cases)} cases x {runs} runs = {requests} API requests, ~${usd:.2f} "
          f"(replies priced at an assumed {ASSUMED_REPLY_TOKENS} tokens each)")
    truncated = [c.id for c in cases if len(c.patch) > haiku.MAX_DIFF_CHARS]
    if truncated:
        print(f"TRUNCATED by the scanner's own cap, so part of the push is unscanned: "
              f"{', '.join(truncated)}")
    return 0


def report(cases: List[Case], results: List[Run], runs: int) -> int:
    by_case: Dict[str, List[Run]] = {}
    for r in results:
        by_case.setdefault(r.case, []).append(r)

    print()
    print(f"{'case':<26} {'label':<9} {'blocked':>9}  {'rate':>6}  {'s/call':>7}")
    print("-" * 64)
    for c in sorted(cases, key=lambda c: (c.label, c.id)):
        rs = by_case.get(c.id, [])
        blocked = sum(1 for r in rs if r.verdict == "blocked")
        bad = [r for r in rs if r.verdict == "unavailable"]
        answered = len(rs) - len(bad)
        rate = blocked / answered if answered else 0
        flag = "" if (c.label == "positive") == (rate >= 0.5) else "  <-"
        med = statistics.median(r.seconds for r in rs) if rs else 0
        print(f"{c.id:<26} {c.label:<9} {blocked:>4}/{answered:<4} {rate:6.0%}  {med:7.1f}{flag}")
        if bad:
            print(f"{'':<26} {len(bad)} run(s) could not reach the scanner: {bad[0].detail[:80]}")

    pos = [r for r in results if r.label == "positive"]
    neg = [r for r in results if r.label == "negative"]
    unavailable = [r for r in results if r.verdict == "unavailable"]

    # A run that never reached the scanner is not a run the scanner passed.
    # Counting it in the denominator would read an outage as a miss.
    def answered(rs: List[Run]) -> List[Run]:
        return [r for r in rs if r.verdict != "unavailable"]

    def share(rs: List[Run]) -> str:
        rs = answered(rs)
        if not rs:
            return "n/a"
        blocked = sum(1 for r in rs if r.verdict == "blocked")
        return f"{blocked}/{len(rs)} ({blocked / len(rs):.0%})"

    requests = sum(case_cost(c)[0] for c in cases) * runs
    usd = sum(case_cost(c)[1] for c in cases) * runs
    print()
    print(f"recall (positives blocked): {share(pos)}")
    print(f"false positives (negatives blocked): {share(neg)}")
    if unavailable:
        print(f"WARNING: {len(unavailable)} of {len(results)} runs never reached the "
              f"scanner. They are left out of every rate above, so each is over fewer "
              f"samples than --runs.")
    print(f"runs: {len(results)}   API requests: {requests}   ~${usd:.2f} at list price "
          f"(replies priced at an assumed {ASSUMED_REPLY_TOKENS} tokens each)")

    # A positive that never blocks is the bug this harness exists for; a
    # negative that always blocks is the bug a fix for it introduces. Either
    # is a failure, so neither can be reported as a pass.
    def rate(rs: List[Run]) -> float:
        rs = answered(rs)
        return sum(1 for r in rs if r.verdict == "blocked") / len(rs)

    worst_pos = min((rate(rs) for rs in by_case.values()
                     if answered(rs) and rs[0].label == "positive"), default=1.0)
    worst_neg = max((rate(rs) for rs in by_case.values()
                     if answered(rs) and rs[0].label == "negative"), default=0.0)
    return 0 if (worst_pos == 1.0 and worst_neg == 0.0) else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--runs", type=int, default=10)
    ap.add_argument("--only", default="")
    ap.add_argument("--jobs", type=int, default=6)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--json", default="")
    args = ap.parse_args()

    only = [s for s in args.only.split(",") if s] or None
    cases = load_cases(only)
    if args.dry_run:
        return dry_run(cases, args.runs)

    done = [0]
    total = len(cases) * args.runs

    def tick(run: Run) -> None:
        done[0] += 1
        # sys.__stderr__, not sys.stderr: the sweep has the latter redirected
        # into a sink so the scanner's findings never reach a terminal.
        print(f"\r  {done[0]}/{total} runs  ({run.case}: {run.verdict})    ",
              end="", file=sys.__stderr__, flush=True)

    started = time.monotonic()
    results = sweep(cases, args.runs, args.jobs, tick)
    print(f"\r  {total} runs in {time.monotonic() - started:.0f}s" + " " * 30,
          file=sys.__stderr__)

    if args.json:
        json.dump([r._asdict() for r in results], open(args.json, "w"), indent=2)
    return report(cases, results, args.runs)


if __name__ == "__main__":
    sys.exit(main())
