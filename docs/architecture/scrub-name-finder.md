# Scrub name finder: the free pass in front of Haiku

The push-time leak gate now runs a free local pass that picks the lines that
might hold a name, and Haiku judges only those. It cuts the gate's cost by
about three quarters, but **a name the pass misses is never judged**, and no
measured class reaches 99.9% recall. This doc records what the pass does,
what was measured, and why rules + Haiku was chosen over GLiNER, spaCy,
Presidio or Haiku alone.

The code is `scripts/scrub_names.py`; `scripts/scrub-haiku.py` calls it.

## Why it exists

The gate has two scanners. The regex scanner knows the denylist and the
registry's project names. The Haiku scanner looks for names nobody listed: a
person, an organisation or a project that should not appear in a public
repository.

Before this pass, Haiku read every added line of every push, with a
2,400-token prompt per 30KB piece. That cost about 4 cents for an average
push and about $3 a day at 80 pushes. The cost counts against the key's
daily cap, so a busy day could block pushes.

The owner asked for something cheaper that calls Haiku only when a line
might hold a name, catches names more than 99.9% of the time, and raises few
false alarms. Of the four approaches measured, the owner chose **rules +
Haiku**.

## What the pass does

**The idea.** A push cannot publish a name that is already public. Most added
lines are code and prose built from words the repository has published many
times, so the pass flags only lines carrying something the public repository
has not already said often.

**What counts as public.** In `--push-tip` mode (the pre-push hook's mode),
the pass finds the newest commit the push builds on that the remote already
has, using `git rev-list --boundary`. Every word in that commit's tree, its
paths, and the commit messages behind it is public.

The vocabulary is cached in `<git-common-dir>/scrub-haiku/vocabulary.json`.
When a later push's base descends from the cached one, only the commits in
between are read. The first push in a clone takes 3 to 13 seconds to build
the cache; after that a push costs about 13 ms to load it, plus about 0.7 s
per 30 new commits on main.

**What flags a line.** Any of these appearing fewer than 5 times
(`RARE_BELOW`) in the public vocabulary:

- a word, case-folded;
- a capitalised word, in exactly that case: "Carol" is flagged even where
  "carol" is common;
- a pair of capitalised words, such as "Harborlight Labs";
- a word in a name's place, counted separately from ordinary use: after
  "ask", "thanks", "with" or "by"; before "said" or "prefers"; as the value
  of an `author`, `name` or `speaker` field; or as an owner ("Saltmarsh's").
  So "with Carol" is flagged even if "carol" is everywhere;
- an email address or an `@handle`;
- a number, amount or key: a run of six or more digits (a phone or account
  number; an ISO date is left out), an amount with a currency sign or
  currency word, a reading with a medical unit such as mg/dL, or an opaque
  string of 20 or more characters that mixes letters and digits, or 16 or
  more hex digits. Haiku judges these as well as names, and `tokens()` drops
  digits, so without this rule a salary or a key written among ordinary words
  would never be sent.

Words split out of camelCase count as words. Hex runs and long encoded blobs
are skipped. A single non-Latin character counts as a word, because one Han
character can be a whole given name. An `Author:` or `Commit:` line whose
identity is not already public is always read.

**What travels.** Each flagged line goes to Haiku with two lines either side
(`CONTEXT_LINES`), never crossing into another file or hunk, and keeps its
`commit`, `diff --git` and `@@` headers. A line is left out once every
trigger on it has already been sent twice (`REPEATS_SENT`).

**No flagged line, no call.** The scanner makes no API call and books nothing
to the spend ledger. The 320KB cost ceiling now applies to the excerpt, not
the raw push, so the rules read a long push in full instead of cutting it off
at 320KB.

**Other modes.** Stdin and `--diff-range` do not know what is public, so they
send every line with a word on it, unless `--public-base REV` says what is
public. `SCRUB_HAIKU_RULES=off` sends the whole push as before;
`scrub-recall.py --rules off` measures that path.

**Standard library only**, because it runs inside a git hook on every push,
on whatever Python the machine has.

## Where it falls short of 99.9%

**A name the rules miss is never judged.** Haiku reads only what the pass
sends. A missed line is not a weak verdict; it is no verdict.

**No class shows 99.9%.** Stage-1 recall on the planted corpus (described
under [The labelled set](#the-labelled-set)):

| class | caught | recall | one-sided 95% lower bound |
|---|---|---|---|
| person | 3,171 / 3,184 | 99.59% | 99.35% |
| organisation | 1,400 / 1,400 | 100% | 99.79% |
| project | 1,342 / 1,400 | 95.86% | 94.87% |
| all | 5,913 / 5,984 | 98.81% | 98.56% |

Organisations missed nothing, but 1,400 cases cannot bound recall tighter
than 99.79%.

**What it misses** is a name made only of words the repository already uses
at least 5 times, in a place where those words are ordinary:

| class | pattern | misses |
|---|---|---|
| project | hyphenated slug of common words | 20 |
| project | a single lower-case common word | 18 |
| project | camelCase of common words | 10 |
| project | common word with a prefix | 6 |
| project | capitalised common word | 4 |
| person | inside a snake_case identifier | 3 |
| person | inside a camelCase identifier | 3 |
| person | lower-case given name | 2 |
| person | possessive; first word of a comment; JSON value; first word of markdown prose; first word of a string | 1 each |

Projects named in `registry.yaml` are also caught by the regex scanner, which
reads every line whatever this pass decides. The misses that matter are
unregistered projects with ordinary-word names, and people whose names are
common words, written where no cue points at them.

**The recall figure is optimistic.** The positives are synthetic names planted
by one generator into real lines of this repository, and the cue and
possessive rules were written after reading that generator's misses. Real
leaks will be caught less often than 98.8%.

**Haiku is not 99.9% either.** In the research run, Haiku read excerpts for
100 planted names the rules had flagged and blocked 76. For 12 of the 24 it
passed, Haiku was given the whole patch instead and blocked only 3. Most of
those names get past Haiku whether or not the pass is in front of it.

## What was measured

### The labelled set

- **Negatives:** the last 499 commits on main at the time, each treated as one
  push. All had already passed today's gates.
- **Positives:** 5,984 generated names (3,184 people, 1,400 organisations,
  1,400 projects) planted into those commits' added lines: comments, strings,
  JSON, markdown, test titles, identifiers and commit messages. They include
  non-Western names, single given names, names that are common words,
  handles, emails and possessives. A planted person that coincided with the
  maintainer's or a fixture name is not counted, since the gate exempts those
  on purpose.
- **Recall cases:** the 24 cases in `scripts/scrub-recall-cases.json` (10
  positives, 14 negatives), run end to end through Haiku.

A positive counts as caught in stage 1 only when a trigger on its lines
contains part of the planted name, not when the line was flagged for some
other word.

### Stage 1: which lines each finder flags

The shipped rules were measured on the whole corpus. The model runs used a
sample of the negatives (62,102 lines for spaCy, 17,035 for GLiNER and
Presidio), so their flag rates and cost multiples are noisier. "+ rules"
means flagged by the model or by the research rule mix, not the shipped
rules. Cost is a multiple of today's full scan.

| finder | recall | lines flagged | cost × today | install | cold start | speed |
|---|---|---|---|---|---|---|
| today: Haiku reads everything | — | 100% | 1.00 | none | none | — |
| **shipped rules** (stdlib) | **98.81%** | **5.2%** (3.4% sent) | **0.23** | none | 3–13 s first push, then ms | 25 ms per push |
| research rules, novelty only | 95.53% | 1.4% | 0.13 | none | — | — |
| research rules, best mix (name lists + word frequencies) | 98.71% | 7.3% | 0.21 | 107 MB of lists | — | — |
| spaCy sm, person/org/product/place/work | 55.30% | 12.2% | 0.28 | ~40 MB + deps | 7.8 s | 856 lines/s |
| spaCy sm + rules | 98.91% | 16.9% | 0.36 | | | |
| spaCy md, same labels | 59.89% | 11.0% | 0.27 | ~80 MB + deps | 2.8 s | 797 lines/s |
| spaCy md + rules | 98.95% | 15.7% | 0.35 | | | |
| Presidio, person/email/org | 54.29% | 8.0% | 0.19 | spaCy + 2 MB | 4.8 s | 285 lines/s |
| Presidio + rules | 98.93% | 13.4% | 0.29 | | | |
| GLiNER small, all labels at 0.5 | 87.35% | 15.8% | 0.26 | ~1.2 GB (torch, transformers, model) | 11.4 s | 100 lines/s |
| GLiNER at 0.2 | 95.62% | 35.5% | 0.48 | | | |
| GLiNER at 0.2 + rules | 99.58% | 38.1% | 0.52 | | | |

With the shipped rules, 99.2% of pushes still make a call, because nearly
every commit adds some identifier the repository has not used five times.
The saving comes from sending less, not from skipping calls.

### Stage 2: what Haiku decides on what it is sent

The 24 recall cases, through the real key. Each arm used its own throwaway
ledger, so the machine's shared cap was not touched. The rules-on sweep ran
before the number and key marks were added; with them, four negative cases
send up to 0.7KB more and nothing else changes.

| path | runs | positives blocked | negatives blocked | spend |
|---|---|---|---|---|
| today: whole push | 2 | 19 / 20 | 4 / 28 (14%) | $1.13 |
| rules pass on | 3 | 30 / 30 | 6 / 42 (14%) | $0.58 |

The false-block rate did not change, but which cases were blocked did. The
whole-push path missed the planted test-fixture name once and blocked
`ordinary-3` twice. The excerpt path blocked `ordinary-large` every time,
which the whole push never did. Both blocked `ordinary-4`. These samples are
small: 30 of 30 bounds recall at 90.5%.

On the corpus, with excerpts cut by the research rules, Haiku blocked 76 of
100 flagged positives (see [Where it falls short](#where-it-falls-short-of-999))
and 17 of 100 real commits. Given the whole patch, 7 of 12 of those blocked
commits were blocked again.

### Cost

On the corpus, with each commit treated as a push:

| | today | rules pass |
|---|---|---|
| pushes that call Haiku | 100% | 99.2% |
| tokens in per push | 33,373 | 7,085 |
| $ per push | 0.0381 | 0.0088 |
| $ per day at 80 pushes | 3.04 | 0.70 |

Three merged PRs from main, each sent with the real key:

| PR size | patch chars | chars sent | calls | $ today | $ with rules |
|---|---|---|---|---|---|
| small | 4,985 | 1,122 | 1 | 0.0051 | 0.0035 |
| medium | 35,543 | 2,010 | 1 | 0.0190 | 0.0040 |
| large | 229,670 | 19,176 | 1 (was 8) | 0.1060 | 0.0102 |

A call's floor is the 2,400-token prompt, about $0.003, which is now most of
what a small push costs.

## Why rules + Haiku

- **Haiku alone** is what the gate did before: the most expensive option, and
  not 99.9% on these names either.
- **GLiNER** had the highest recall combined with rules (99.58%), still short
  of 99.9%. It flags 38% of lines, which halves the saving. It needs about
  1.2 GB of torch and model weights on every machine that pushes, an
  11-second load, and runs at 100 lines a second, so a large push would wait
  about 35 seconds. Too heavy for a git hook.
- **spaCy and Presidio** catch about half the names alone. Most of the names
  they miss live in code and identifiers, which is where this repository's
  names appear. Combined with rules they reach 98.91–98.95%, 0.1 points above
  the shipped rules, while flagging 13.4–16.9% of lines against 5.2%. They
  also need a model install on every machine.
- **Name lists and word frequencies** raised the research rules to 98.7%, but
  they are 107 MB of third-party data that cannot be vendored into a public
  repository's hooks.
- **Stdlib rules** come within 0.14 points of every combination but GLiNER's,
  flag the fewest lines at that recall, cost nothing to install, and use the
  repository's own history, which already defines what is public, as the name
  list.

The code states the trade as well: a name built only from words this
repository already uses many times is not sent, and so is not judged.

## Measuring it again

- `python3 scripts/scrub-recall.py --dry-run` lists what each recall case
  sends, and whether each planted name is flagged, without calling the API.
- `python3 scripts/scrub-recall.py --runs N [--rules off]` runs the cases
  through Haiku. Point `SCRUB_HAIKU_SPEND_LOG` at a scratch ledger so a sweep
  does not spend the machine's shared cap.
- `python3 scripts/scrub-selftest.py` covers the pass without the network: a
  planted person, organisation and project are each sent; a diff of public
  words makes no call and books nothing; context travels with a flagged line;
  and every planted recall case still sends its name.

The planted corpus and the model runs were research scripts and were not
committed, because the planted names would trip the gate they test.
