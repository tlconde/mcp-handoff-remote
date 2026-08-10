# Runbook — history scrub before publication

**Status:** prepared, NOT performed. Performing it is the operator's decision and the operator's
command. This document exists so that decision costs one command rather than an afternoon of
research.

## Why this exists

`git rm --cached` and `.gitignore` stop FUTURE commits. They do not touch history, so a clone of
this repo still carries everything that was ever committed. A repo that is clean at HEAD and dirty
in history is not clean.

## The residue, measured

Measured 2026-08-10 on `main` at `e9027d5`. Re-measure before acting — these numbers age.

```bash
git rev-list --all -- mcp-roundtrip-evals/ | wc -l   # 5 commits
git rev-list --all -- docs-seed/ | wc -l             # 5 commits
git log --all -p | grep -cE "sess_[a-z]*_?[0-9A-HJKMNP-TV-Z]{20,}"   # 25 lines
```

**The 25 is a line count, and it is NOT 25 leaks.** Rehearsed on a throwaway `--mirror` clone and
broken down by distinct value:

| id | occurrences | where it lives | real? |
|---|---:|---|---|
| `REDACTED-SESSION-ID` | 9 | `mcp-roundtrip-evals/calibrations/*.jsonl` | **yes** |
| `REDACTED-SESSION-ID` | 9 | `mcp-roundtrip-evals/calibrations/*.jsonl` | **yes** |
| `REDACTED-SESSION-ID` | 6 | `mcp-roundtrip-evals/calibrations/*.jsonl` | **yes** |
| `REDACTED-SESSION-ID` | 5 | `mcp-roundtrip-evals/calibrations/run_log.jsonl` | **yes** |
| `sess_code_0000000000000000000000ABCD` | 4 | `OBJECT-RECORD-SPEC.md` | **no — synthetic fixture** |

**Four real ids, and every one of them is confined to `mcp-roundtrip-evals/calibrations/`**
(verified with `git log --all -S<id> --name-only`: no other path ever contained them). That is the
single most useful fact here — step 1 below removes that path, so step 1 alone removes all four.
Step 2 stays as belt-and-braces, not as the load-bearing step.

The fifth value is a deliberately all-zeros placeholder in a design spec. It is not a leak, it is
what a fixture is supposed to look like, and **it must not be scrubbed**.

## Preconditions

1. **Every collaborator and every machine has pushed.** A history rewrite orphans work that only
   exists on somebody else's clone. There is a second laptop in this project's world — check it.
2. **A backup clone exists** somewhere the rewrite will not reach: `git clone --mirror` to an
   external path, kept until the scrub is verified.
3. **`git-filter-repo` is installed** (`brew install git-filter-repo`). `filter-branch` is not the
   tool; it is slow, error-prone, and git's own docs steer away from it.
   **MEASURED 2026-08-10: it is NOT installed on the home machine** — `git filter-repo --version`
   returns "not a git command" and no binary is on PATH. This is the first thing the real run will
   hit, so it is the first thing to fix; the rehearsal below stopped here by necessity.
4. **The values to scrub live in `.scrub-values`** (gitignored), one extended-regex alternation per
   line — the same file the pre-commit check reads. The checker must not contain the strings it
   searches for, which is why they are not written here.

## Rehearsal status — what has and has not been proven

Rehearsed 2026-08-10 on a throwaway `git clone --mirror` of this repo:

- **Done:** the mirror clone; the baseline measurement reproduced on it (5 / 5 / 25); the residue
  broken down by distinct value; every real id traced to its owning path; the gate greps shown to
  FAIL against un-scrubbed history, which is what makes them worth running.
- **NOT done:** the `filter-repo` invocations themselves and the post-rewrite verification —
  blocked on precondition 3, the tool is not installed. **Nobody should read the numbers above as
  proof that the operation works on this repo.** They are proof of what the operation must remove.

## The operation

```bash
# from a FRESH MIRROR, never the working clone
git clone --mirror <origin-url> /tmp/handoff-scrub && cd /tmp/handoff-scrub

# 1. paths that should never have been committed
git filter-repo --invert-paths \
  --path mcp-roundtrip-evals/ \
  --path docs-seed/

# 2. id-shaped residue in remaining content and commit messages
#    (--replace-text takes a file of `regex==>replacement` lines; build it from .scrub-values)
git filter-repo --replace-text /path/to/scrub-replacements.txt
```

## Verification — on a FRESH CLONE, by effect

Do not trust the mirror you just rewrote, and do not trust this working tree. Clone the result and
run the gate's own greps against it:

```bash
git clone <rewritten-remote> /tmp/pubcheck && cd /tmp/pubcheck

# REAL ids only — the documented all-zeros fixture is excluded BY VALUE, not by loosening the
# pattern. See the note below: this exclusion is the difference between a check that can pass and
# a check that cannot.
git log --all -p \
  | grep -E "sess_[a-z]*_?[0-9A-HJKMNP-TV-Z]{20,}" \
  | grep -v "sess_code_0000000000000000000000ABCD" \
  | head                                                                    # must be EMPTY

git rev-list --all -- mcp-roundtrip-evals/ | wc -l                          # must be 0
git rev-list --all -- docs-seed/ | wc -l                                    # must be 0
```

**Why the exclusion exists, and why it is not a loophole.** The gate's purpose is *no real record
ids*, not *no id-shaped strings*. `OBJECT-RECORD-SPEC.md` carries a deliberately synthetic
`sess_code_0000…ABCD` in its history, and the spec files are not on the removal list because they
are design documents, not personal data. So the unqualified grep returns non-empty **after a
completely successful scrub** — a criterion that can never be met, which in practice means the
person running it concludes the tool failed, or worse, starts widening the removal until the check
goes quiet. Excluding one documented fixture by its exact value keeps the check honest and keeps it
able to fail: any *other* id-shaped string still trips it.

An empty result is the only acceptable outcome. A count that merely went down means the operation
half-worked, which is worse than not having run it, because the gate will read as passed.

## After

- Force-push the rewritten history, then have every clone re-clone. A `git pull` onto rewritten
  history produces a merge that restores exactly what was removed.
- Every commit sha changes. Anything that cites a sha — ADRs, `AGENTS.md`, board events, commit
  messages quoting other commits — now points at nothing. Budget for that: it is documentation
  work, not a side effect that resolves itself.
- Re-run the gate greps once more on a clone taken after the force-push.

## The alternative that avoids all of this

Generating a public repo from this one (ADR-0002, rejected alternative 3) produces a tree with no
history to scrub. If that model is chosen, this runbook is not executed — it is deleted, and the
gate closes by construction rather than by operation.
