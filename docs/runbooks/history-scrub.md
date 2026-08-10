# Runbook — history scrub before publication

**Status:** prepared, NOT performed. Performing it is the operator's decision and the operator's
command. This document exists so that decision costs one command rather than an afternoon of
research.

## Why this exists

`git rm --cached` and `.gitignore` stop FUTURE commits. They do not touch history, so a clone of
this repo still carries everything that was ever committed. A repo that is clean at HEAD and dirty
in history is not clean.

## The residue, measured

Measured 2026-08-10 on `main` at `9a73a84`. Re-measure before acting — these numbers age.

```bash
git rev-list --all -- mcp-roundtrip-evals/ | wc -l   # 5 commits
git rev-list --all -- docs-seed/ | wc -l             # 5 commits
git log --all -p | grep -cE "sess_[a-z]*_?[0-9A-HJKMNP-TV-Z]{20,}"   # 25 hits
```

What those are: evaluation receipts carrying real record ids and real CLI transcript uuids
(`mcp-roundtrip-evals/calibrations/`), competitor capability research (`docs-seed/`), and
session-id-shaped strings scattered through commit content and messages.

## Preconditions

1. **Every collaborator and every machine has pushed.** A history rewrite orphans work that only
   exists on somebody else's clone. There is a second laptop in this project's world — check it.
2. **A backup clone exists** somewhere the rewrite will not reach: `git clone --mirror` to an
   external path, kept until the scrub is verified.
3. **`git-filter-repo` is installed** (`brew install git-filter-repo`). `filter-branch` is not the
   tool; it is slow, error-prone, and git's own docs steer away from it.
4. **The values to scrub live in `.scrub-values`** (gitignored), one extended-regex alternation per
   line — the same file the pre-commit check reads. The checker must not contain the strings it
   searches for, which is why they are not written here.

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
git log --all -p | grep -nE "sess_[a-z]*_?[0-9A-HJKMNP-TV-Z]{20,}" | head   # must be EMPTY
git rev-list --all -- mcp-roundtrip-evals/ | wc -l                          # must be 0
git rev-list --all -- docs-seed/ | wc -l                                    # must be 0
```

An empty grep is the only acceptable result. A count that merely went down means the operation
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
