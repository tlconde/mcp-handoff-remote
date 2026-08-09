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
# 1. named identifiers
git diff --cached --name-only | while read f; do
  [ -f "$f" ] && grep -HinE "taissa|lconde|94da97ad|old-feather|/Users/dev" "$f"
done

# 2. session ids. A uuid that names a transcript on this disk is a REAL session, and a
#    session id is personal data — it points at someone's conversation. Checking against
#    ~/.claude/projects is exact where a uuid-shaped pattern is not: the suites are full of
#    legitimate fixture uuids (11111111-…, ffffffff-dead-…) and a shape match flags them all.
git diff --cached --name-only | while read f; do
  [ -f "$f" ] && grep -hoiE "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" "$f"
done | sort -u | while read u; do
  ls ~/.claude/projects/*/"$u".jsonl >/dev/null 2>&1 && echo "REAL SESSION ID: $u"
done
```

Empty output from both, or do not commit.

The first list only ever grows, one entry per escape that already happened. It caught `94da97ad`
after that leak, and it did not catch the live session id committed in `forwarder-runbook.js`
with the initial release — a uuid is not a name. Prefer a check that describes the class.

**This bit on the very first mirror.** Copying `handoff-tools.js` across re-introduced three
owner references that live in comments on the notebook side. Copying a shared file is not the
end of mirroring — **de-personalize after every copy, then run the grep above.** The rule
caught it; assume it will need to.

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
