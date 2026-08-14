# Runbook — history scrub before publication

**Status:** operator performed the rewrite and public flip on 2026-08-14. A default
`git clone` of origin (heads + tags only) now passes the path and `sess_` greps
below. That is not the whole gate. GitHub still advertises `refs/pull/*/head`
from PRs opened against the pre-rewrite DAG, those refs are client-undeletable,
and fetching them — or fetching a pre-rewrite commit by SHA — still serves
`mcp-roundtrip-evals/`, `docs-seed/`, `DEBUG-LOG.md`, and real record ids.
Closing that residue is GitHub Support (purge cached objects and pull refs) or
publishing from a new repository that never had those PRs. See **After**.

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
| real id **A** | 9 | `mcp-roundtrip-evals/calibrations/*.jsonl` | **yes** |
| real id **B** | 9 | `mcp-roundtrip-evals/calibrations/*.jsonl` | **yes** |
| real id **C** | 6 | `mcp-roundtrip-evals/calibrations/*.jsonl` | **yes** |
| real id **D** | 5 | `mcp-roundtrip-evals/calibrations/run_log.jsonl` | **yes** |
| the all-zeros fixture | 4 | `OBJECT-RECORD-SPEC.md` | **no — synthetic fixture** |

**The four values are deliberately NOT written here.** An earlier version of this table listed them
verbatim, which put four real record ids into a tracked file in the repo whose publication gate
exists to remove exactly those ids — a document about a leak, leaking. The rule it broke is already
written down one file over: *a checker must not contain the strings it searches for, which is why
they live in `.scrub-values` (gitignored)*. Read them from there, or regenerate the inventory:

```bash
git log --all -p | grep -oE "sess_[a-z]*_?[0-9A-HJKMNP-TV-Z]{20,}" | sort | uniq -c | sort -rn
```

**Four real ids. They WERE confined to `mcp-roundtrip-evals/calibrations/` — and are not any more.**

An earlier revision of this runbook listed the four values verbatim in the table above, and that
revision was committed (`f8cba9b`) and pushed. So the ids now also live in the history of
`docs/runbooks/history-scrub.md` — **a file that must survive the scrub.**

That inverts this document's own earlier conclusion, and the inversion is the important part:

- **Then:** every id sat under one removable path, so `--invert-paths` alone would have cleared
  them and `--replace-text` was belt-and-braces.
- **Now:** the ids sit in a path that cannot be deleted, so **`--replace-text` is load-bearing** and
  path removal alone leaves them behind.

A runbook that had been trusted at its earlier word would have been run, verified against a grep
that could not fail, and declared clean while the ids sat in the history of the very file
describing them.

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

## Rehearsal status — REHEARSED END TO END, 2026-08-10

`git-filter-repo` was installed (`/opt/homebrew/bin/git-filter-repo`, `a40bce548d2c`) and the whole
operation was run on a throwaway `git clone --mirror`. **The real repo and the real remote were
never touched.** Results, verified on a FRESH CLONE of the rewritten mirror:

| check | required | measured |
|---|---|---|
| real ids anywhere in history | 0 | **0** |
| `mcp-roundtrip-evals/` commits | 0 | **0** |
| `docs-seed/` commits | 0 | **0** |
| `REDACTED-SESSION-ID` markers (proves step 2 ran) | > 0 | **8** |
| the all-zeros fixture still present | preserved | **9** |
| tracked files vs the real repo | identical | **identical** |
| `handoff-core.js` parses in the clone | yes | **yes** |

**One commit was pruned, and it is worth knowing which:** *"De-personalize the one docs-seed line
that carried the owner's name"* — a commit whose only content was inside `docs-seed/`, so removing
that path left it empty and `filter-repo` dropped it. 94 commits became 93. Nothing else changed
shape.

**Step 2 is confirmed load-bearing.** Path removal alone would have left the four ids in the
history of this very runbook, which survives the scrub by design. The 8 `REDACTED` markers are
where they were.

**What the 2026-08-14 origin check proved, and what it did not.** Re-measured
independently on a fresh clone of GitHub origin after the force-push and the
visibility flip:

| check | required | default clone | after `git fetch origin refs/pull/*/head` |
|---|---|---|---|
| `mcp-roundtrip-evals/` commits | 0 | **0** | **5** |
| `docs-seed/` commits | 0 | **0** | **5** |
| `DEBUG-LOG.md` commits | 0 | **0** | **16** |
| real `sess_` lines (fixture excluded) | empty | **empty** | **non-empty** |
| `REDACTED-SESSION-ID` | > 0 | **10** | (not the question) |
| all-zeros fixture | preserved | **9** | (not the question) |

The default-clone column is what this runbook's verification block used to
measure, and it is why a PASS table can be true and still leave the leak
fetchable. `git ls-remote origin 'refs/pull/*'` still listed three pull heads;
`git push origin --delete refs/pull/N/head` is rejected (`deny updating a hidden
ref`); `DELETE /git/refs/pull/N/head` returns `422 refs/pull/* is read-only`.
GitHub's commit and contents APIs still resolve pre-rewrite SHAs, including a
tree that lists `mcp-roundtrip-evals/`. Do not paste those SHAs here.

## The operation

```bash
# from a FRESH MIRROR, never the working clone
git clone --mirror <origin-url> /tmp/handoff-scrub && cd /tmp/handoff-scrub

# 1. paths that should never have been committed
git filter-repo --invert-paths \
  --path mcp-roundtrip-evals/ \
  --path docs-seed/ \
  --path DEBUG-LOG.md

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
# The fixture exclusion is read from .scrub-values (gitignored) rather than written here, for the
# same reason the id inventory above is not written here.
git log --all -p \
  | grep -E "sess_[a-z]*_?[0-9A-HJKMNP-TV-Z]{20,}" \
  | grep -vF -f "$REPO/.scrub-fixtures" \
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
- **Also fetch what GitHub still advertises besides `main`.** A default clone
  does not take `refs/pull/*`, so `git log --all` on that clone is silent about
  pull-request heads. Measure them:

  ```bash
  git ls-remote origin 'refs/pull/*' 'refs/heads/*' 'refs/tags/*'
  # if any pull heads exist, fetch them into a throwaway clone and re-run the
  # path and sess_ greps against --all. Required: still 0 / 0 / empty.
  ```

  Deleting leftover *branch* heads (`refs/heads/cursor/…`) is necessary and not
  sufficient. GitHub keeps `refs/pull/N/head` after the branch is deleted, and
  the client cannot delete those refs. GitHub Support has to purge them — the
  same ticket that asks for a cache purge after a public history rewrite. Until
  that ticket lands, or until the public artifact is a new repository that never
  had those PRs, anyone who fetches a pull head or a pre-rewrite SHA still gets
  the old DAG.

## The alternative that avoids all of this

Generating a public repo from this one (ADR-0002, rejected alternative 3) produces a tree with no
history to scrub. If that model is chosen, this runbook is not executed — it is deleted, and the
gate closes by construction rather than by operation. After a rewrite of a repo that already had
PRs, it is also the remaining operator-controlled close for `refs/pull/*` residue: a new
repository never advertises those heads.
