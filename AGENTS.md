# Working rules for agents in this repo

## This repo is one of TWO that must move together

| repo | role |
|---|---|
| `~/Dev/Github/handoff-remote` (**here**) | The **publishable** artifact. Private on GitHub today, intended to go public. |
| `~/Dev/Github/ai-product-sense/Projects/handoff-poc` | The **lab notebook**: trials, evaluation receipts, pitch material, the owner's personal runbook. |

**Any change to shared code lands in BOTH.** Fix it here, apply it there — or the reverse —
in the same working session. They diverge silently otherwise, and the first symptom is a bug
fixed in one place and still live in the other.

Shared code means: `handoff-core.js`, `handoff-tools.js`, `handoff-daemon.js`,
`handoff-contract.js`, `handoff-relay.js`, `handoff-jwt.js`, `handoff-tool-schemas.js`,
`mcp-handoff.js`, `server.js`, everything in `bin/`, and every `*-smoke.js` / `protocol-test.js`.

Not shared, and must **never** travel from the notebook to here:

- `trials/` — contains snapshots of real conversations
- `mcp-roundtrip-evals/calibrations/`, `product-validation-evals/` — evaluation receipts
- `APP-INTERNALS.md` — reverse-engineering notes
- `EXPERIMENT-BRIEF.md`, `INTERVIEWS.md`, `VALIDATION.md`, `WORKER_PROOF.md` — pitch material
- `deploy/ACCESS-SETUP.md` — the owner's personal deployment runbook

## Nothing personal, ever, including comments

No owner name, no real domain, no tunnel id, no audience tag, no `/Users/<name>` path —
**in code, comments, docs, fixtures or configs alike**. Fixtures use `example.invalid` or
`example.com`. Deployment values are placeholders in `.template` files.

Prove it before every commit, do not assume it:

```bash
git diff --cached --name-only | while read f; do
  [ -f "$f" ] && grep -HinE "taissa|lconde|94da97ad|old-feather|/Users/dev" "$f"
done
```

Empty output, or do not commit.

## Test side-effects that must not be committed

`protocol-test.js` exports `HANDOFF.md` into the working directory, and the bridge
self-installs slash commands under `.claude/`. Both are gitignored. If either shows up in
`git status`, it is an artifact, not work.

## The standard this codebase is held to

- **Never guess.** Ambiguity is surfaced and refused, never resolved silently.
- **Process-scoped addresses are never persisted or cached** — pids, sockets, transcript ids
  are hints, validated live at the moment of use.
- **Say only what was measured.** A dispatch is not a delivery. No doc claims a capability
  that is not asserted by a test.
- **Fail closed.** Absence of configuration is never permission.
- **A test that has never failed for the right reason has not been shown to work.** Fixtures
  must describe a world that can exist — real pids for liveness, real keys for signatures.
