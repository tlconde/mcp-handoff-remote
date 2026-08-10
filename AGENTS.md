# Working rules for agents in this repo

## This repo is one of TWO that must move together

| repo | role |
|---|---|
| `~/Dev/Github/handoff-remote` (**here**) | The **publishable** artifact. Private on GitHub today, intended to go public. |
| `~/Dev/Github/ai-product-sense/Projects/handoff-poc` | The **lab notebook**: trials, evaluation receipts, pitch material, the owner's personal runbook. |

**Any change to shared code lands in BOTH.** They diverge silently otherwise, and the first
symptom is a bug fixed in one place and still live in the other. Measured 2026-08-09: 15 of 23
shared files had drifted apart while both sides believed they were mirroring.

**This repo LEADS.** When the two disagree, the question is not "how do I carry the notebook's
version across" but "is the notebook's version a divergence to correct back". Changes flow here
first and the notebook follows. A change that exists only in the notebook is not yet real.

Before assuming the trees match, measure it:
`HANDOFF_MIRROR=<path-to-notebook> node drift-eval.js` separates comment-only and
placeholder-value differences (both expected) from structural ones — the only kind that means
the two copies would behave differently.

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

**This applies to BOTH repos, not only this one** (ruled 2026-08-09). It was briefly written
down as a one-way transform into the publishable repo, and that was worse than it sounds: the
notebook then carried a second voice for the same shared code, so every mirroring pass had to
reconcile prose by hand and structural drift hid behind it. One voice in both is less work and
less drift. The single exception is the notebook's `trials/` — dated evidence where attribution
IS the content, and which never ships anywhere.

### Who things are called

A session or an agent is **it**, never *she* or *he*. The person using this is **the user**, or
**you** when the sentence is addressed to them. Applies to comments and assertion messages as
much as to docs — an assertion string ships in test output and is read by strangers.

**Rewrite the sentence; never run a substitution.** A mechanical pronoun replace is what
produced `Ids are for machines; this line is for their.` and
`opened for their: activate Claude` — six sites of broken English that no reviewer caught
because each diff looked like a one-word change. A pronoun is grammatical, not lexical: swapping
it changes the verb, and sometimes the subject. So the check below **reports and rewrites
nothing**, exactly like the session-id check above it. Fix the hits by hand, one sentence at a
time.

```bash
git diff --cached --name-only | while read f; do
  [ -f "$f" ] && grep -HinE "\b(she|her|hers|herself|he|him|his)\b" "$f" | grep -viE "other|there"
  # residue of a past substitution — a pronoun stranded where a noun belongs
  [ -f "$f" ] && grep -HinE "for their[.:,]|is for their|they opens|they runs|they was" "$f"
done
```

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

## A name is not one thing, and the one you read may not resolve

Three names can point at the same conversation and only one of them is what resolution matches:

| name | owned by | matched by |
|---|---|---|
| protocol `title` | the store, set once at creation | `resolve_conversation`, `send_to`, `send_message` |
| `native_ref.name` | Claude Code's registry | `ListAgents`, native `SendMessage` — and now our resolvers too |
| the `from` label on a message | whoever sent it, free text, current | nothing |

They drift apart on their own. The Claude app renames a conversation from its content; an operator
renames a terminal; a sender starts calling itself something clearer. The title never follows.

Measured 2026-08-10: a chat created as "btw: automate the check inbox poke" was renamed by the app
to "Automating inbox check notifications". `resolve_conversation` on the name in the sidebar
returned **RESOLVED: nothing**, while replies landed silently under the old title. The day before,
the same shape sent three substantial messages to a dead record: the live terminal was `build`
natively and `tunnel` by title, so "send to build" matched an unrelated record that merely
contained the word.

**So never assume the name a human types is the name the store holds.** `resolve_conversation`
before sending — it delivers nothing, so a wrong target costs nothing to correct, and it is the
only point where the mistake is free.

`node drift-eval.js` has a NAMES check for this. It needs no app API: every inbound message stores
its sender's label verbatim, so the store already knows what each record has been calling itself.
Currently reports 5 records answering to names they never use.

**Known gap, not yet fixed:** those observed aliases are detected but not *addressable* — matching
them in the resolvers is a change to resolution semantics and is with the review seat.

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
- **Exit status is not effect. Check the effect.** This is the single most expensive lesson of
  2026-08-09/10, because it recurred four times in two days and every instance looked like success:
  - `terminal-notifier` exits 0 whether or not a notification appears.
  - a notify rung dispatched with `execFile(..., () => {})` returned `fired: true` for a command
    that failed outright — the Windows toast would have thrown on every machine, forever, and
    reported a successful ping.
  - two versions of one test passed *vacuously*: one short-circuited before the code path it
    tested, the other had an `|| stderr === ''` escape hatch that turned the exact failure it
    existed to catch into a pass.
  - `git apply --reject` reported success, wrote an **empty** `.rej`, produced a file that parsed
    and contained the expected markers — and had silently dropped the one hunk that mattered. Found
    by diffing every added line against the applied file: 161 of 176 present, and the missing 15
    were the fix.

  The fourth is the instructive one: the unreliable reporter was a standard tool, not our code. So
  the rule is not "our code lies", it is that **a call reporting success is evidence the call ran,
  never evidence it worked.** Verify the effect: read the record back, diff the applied file, look
  for the delivered receipt, ask a human whether the notification appeared. Where no receipt exists
  — Windows toasts, `osascript` — say so and name the human as the receipt rather than implying
  one.
- **My repo is not the running system.** Every deployment claim names which build it is about, and
  a claim about the *running* build is verified against the running process — pid, boot time,
  capability grep — never against source. Three wrong "unblocked" reports in one day, all confident,
  all the same cause: reasoning about this repo while production runs the notebook's build.
  ```bash
  pgrep -fl handoff-relay                 # which build, and is it the one you think?
  ps -o lstart= -p <pid>                  # booted BEFORE or AFTER the change you are claiming?
  grep -c '<new symbol>' <running file>   # can it even do the thing? 0 means no.
  ```
  The failures it catches are indistinguishable from success without it: a relay serving
  eleven-hour-old code with a healthy growing log; a measurement reading `none` because *we* never
  emitted the field; a "self-restarting" deploy whose self-restart lives only in the unmirrored
  copy. Run the three lines before saying anything is live.

  The operative form is a question rather than a virtue — the habit that catches this is not care,
  it is asking **"which process is serving this, and when did it start?"** before believing any
  measurement or deployment claim. Both lanes working on this codebase made the same mistake on the
  same day, in their own repos, and both were caught by that question rather than by being careful.
- **A healthy artifact is not a live pipeline. Verify the producer, not the product.** A relay
  served eleven-hour-old code while its access log grew with well-formed lines of real traffic,
  missing the one field a decision depended on — absent, not malformed, which reads as "no data
  yet" rather than "this producer cannot emit it". Then the corrected log answered
  `mcp-session=none` on every line, which looked like a finding about the client and was a fact
  about **us**: the server assigns that id and ours never did, so there was nothing for a client to
  echo. Twice in one hour, the artifact looked fine and the pipeline was not connected. Before
  reading a measurement, confirm the thing producing it is running the code you think it is and is
  capable of producing the value at all.
- **Assert the value, not the shape.** A test that accepts "some value came back" passes while the
  mechanism it guards is broken. Twice in one day the difference between asserting a *specific
  honest value* and asserting a shape was the only thing standing between a fix and its own
  regression — and one anti-drift test found a real defect on its first run only because it
  compared against an exact expected set. Also: **check that the assertion can fail.**
