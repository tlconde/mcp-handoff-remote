# Runbook — history scrub before publication

**Status:** performed on origin 2026-08-14; pull-ref gate open pending Support purge or new repo.

## Why this exists

`git rm --cached` and `.gitignore` stop FUTURE commits. They do not touch history, so a clone of
this repo still carries everything that was ever committed. A repo that is clean at HEAD and dirty
in history is not clean.

## The residue, measured

Measured 2026-08-10 on `main` at `e9027d5` (pre-scrub).

```bash
git rev-list --all -- mcp-roundtrip-evals/ | wc -l   # 5 commits
git rev-list --all -- docs-seed/ | wc -l             # 5 commits
git rev-list --all -- DEBUG-LOG.md | wc -l           # 16 commits
git log --all -p | grep -cE "sess_[a-z]*_?[0-9A-HJKMNP-TV-Z]{20,}"   # 42 lines (6 real ids + 1 fixture)
```

**The 42 lines are NOT 42 distinct leaks.** Broken down by distinct value:

| id | occurrences | where it lives | real? |
|---|---:|---|---|
| real id **A** | 11 | `mcp-roundtrip-evals/calibrations/*.jsonl` | **yes** |
| real id **B** | 11 | `mcp-roundtrip-evals/calibrations/*.jsonl` | **yes** |
| real id **C** | 8 | `mcp-roundtrip-evals/calibrations/*.jsonl` | **yes** |
| real id **D** | 7 | `mcp-roundtrip-evals/calibrations/run_log.jsonl` | **yes** |
| real id **E** | 4 | `mcp-roundtrip-evals/calibrations/learning_proposals.jsonl` | **yes** |
| real id **F** | 4 | `mcp-roundtrip-evals/calibrations/confidence.json` | **yes** |
| the all-zeros fixture | 9 | `OBJECT-RECORD-SPEC.md` | **no — synthetic fixture** |

**The six real values are deliberately NOT written here.** Read them from `.scrub-values` (gitignored),
or regenerate the inventory:

```bash
git log --all -p | grep -oE "sess_[a-z]*_?[0-9A-HJKMNP-TV-Z]{20,}" | sort | uniq -c | sort -rn
```

## Preconditions

1. **Every collaborator and every machine has pushed.**
2. **A backup clone exists** somewhere the rewrite will not reach: full git bundle and working tree
   saved in the notebook workspace (`handoff-poc`).
3. **`git-filter-repo` is installed** (`brew install git-filter-repo`).
4. **The values to scrub live in `.scrub-values`** (gitignored), one extended-regex alternation per line.

## Execution status — PERFORMED ON ORIGIN, 2026-08-14

The scrub was executed on a mirror clone from `main` at `b94cda8` (post-PR #3) and force-pushed to
origin. Results measured on a fresh default clone of GitHub origin (`0254e33`):

| check | required | measured (default clone) | measured (via `refs/pull/*`) |
|---|---|---|---|
| real ids in history | 0 | **0** | **42 lines restored** |
| `mcp-roundtrip-evals/` commits | 0 | **0** | **5 restored** |
| `docs-seed/` commits | 0 | **0** | **5 restored** |
| `DEBUG-LOG.md` commits | 0 | **0** | **16 restored** |
| `REDACTED-SESSION-ID` markers | > 0 | **10** | **2** |
| all-zeros synthetic fixture | preserved | **9** | **9** |
| `git ls-remote origin 'refs/pull/*'` | empty | **NON-EMPTY** (PRs 1–4) | **FAILED GATE** |
| `node bin/build-plugin-manifests.js --check` | pass | **pass** | — |

**Why the gate remains open:** Default clones are clean. But GitHub maintains internal, immutable
`refs/pull/*/head` refs that point to pre-rewrite commits. Fetching those refs restores the leaks.
Closing the gate fully requires a GitHub Support purge or publishing from a fresh repository.

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
git rev-list --all -- DEBUG-LOG.md | wc -l                                  # must be 0

# 4. GITHUB REMOTE REFS CHECK — verify no hidden pull request heads retain old objects
git ls-remote origin 'refs/pull/*'                                          # must be EMPTY
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

## The GitHub pull-ref and cached-object trap

**Measured 2026-08-14:** Even after force-pushing rewritten branches and deleting leftover remote
branch heads, GitHub retains pre-rewrite commits under `refs/pull/*/head` and serves loose objects
by pre-rewrite commit SHA. `refs/pull/*` refs are read-only to git clients (`deny updating a hidden
ref`, HTTP 422), so a client-side force-push cannot clear them.

A default clone checks out only heads and tags, so local greps appear 100% clean while fetching
`refs/pull/*` from origin restores the pre-scrub commits and leaks.

**Closure requires one of two paths:**

1. **GitHub Support purge**: Request GitHub Support to purge unreachable cached objects and
   remove `refs/pull/{1,2,3}/head` on the repository.
2. **Fresh publishable repository**: Push only rewritten `main` and release tags to a brand new
   repository that never had those PRs, update URLs in `plugin.json`, and archive the original repo.

## After

- Force-push the rewritten history, then have every clone re-clone. A `git pull` onto rewritten
  history produces a merge that restores exactly what was removed.
- Every commit sha changes. Anything that cites a sha — ADRs, `AGENTS.md`, board events, commit
  messages quoting other commits — now points at nothing. Budget for that: it is documentation
  work, not a side effect that resolves itself.
- Re-run the gate greps once more on a clone taken after the force-push, including the
  `git ls-remote origin 'refs/pull/*'` check.

## The alternative that avoids all of this

Generating a public repo from this one (ADR-0002, rejected alternative 3) produces a tree with no
history to scrub. If that model is chosen, this runbook is not executed — it is deleted, and the
gate closes by construction rather than by operation. After a rewrite of a repo that already had
PRs, it is also the remaining operator-controlled close for `refs/pull/*` residue: a new
repository never advertises those heads.
