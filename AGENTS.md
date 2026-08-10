# Working rules for agents in this repo

## This repo is one of TWO that must move together

| repo | role |
|---|---|
| this repo (**here**) | The **publishable** artifact. Private on GitHub today, intended to go public. |
| `$HANDOFF_NOTEBOOK` (see `.repo-paths`) | The **lab notebook**: trials, evaluation receipts, pitch material, the owner's personal runbook. |

**Any change to shared code lands in BOTH.** They diverge silently otherwise, and the first
symptom is a bug fixed in one place and still live in the other. Measured 2026-08-09: 15 of 23
shared files had drifted apart while both sides believed they were mirroring.

**This repo LEADS.** When the two disagree, the question is not "how do I carry the notebook's
version across" but "is the notebook's version a divergence to correct back". Changes flow here
first and the notebook follows. A change that exists only in the notebook is not yet real.

Before assuming the trees match, measure it:
`HANDOFF_MIRROR=$HANDOFF_NOTEBOOK node drift-eval.js` separates comment-only and
placeholder-value differences (both expected) from structural ones — the only kind that means
the two copies would behave differently.

**`git apply` from inside the notebook SILENTLY APPLIES NOTHING, and exits 0.** The notebook is a
subdirectory of a larger repo, and `git apply` resolves a patch's paths against the REPO ROOT — so
a patch generated here looks for `<repo-root>/handoff-core.js`, does not find it, prints
`Skipped patch`, changes nothing, and **returns success**. `git apply --check`
green-lights the same no-op. An exit-0 no-op inside the remedy for exit-0 no-ops is the most
on-brand defect this project has produced; it cost two hand-mirrors on 2026-08-10 and was caught
only by checking the file's size and mtime rather than the exit code.

```bash
source .repo-paths                                      # local paths, gitignored
cd "$HANDOFF_NOTEBOOK_REPO"                              # the REPO ROOT, not the project dir
git apply --directory="${HANDOFF_NOTEBOOK#$HANDOFF_NOTEBOOK_REPO/}" <patch>
grep -c '<a symbol the patch adds>' "$HANDOFF_NOTEBOOK"/<file>    # 0 means it did not land
```

Then verify by effect, always: size and mtime changed, the new symbol present, the suite run. If a
hunk rejects, hand-apply it and **say which hunks you hand-applied and why** — the two builds have
diverged in places nobody has measured, and a rejected hunk is usually telling you something true
about that divergence rather than being an obstacle. `--reject` is allowed, but check every hunk
landed individually; its summary line is not evidence.

Shared code means: `handoff-core.js`, `handoff-tools.js`, `handoff-daemon.js`,
`handoff-contract.js`, `handoff-relay.js`, `handoff-jwt.js`, `handoff-tool-schemas.js`,
`mcp-handoff.js`, `server.js`, everything in `bin/`, and every `*-smoke.js` / `protocol-test.js`.

Not shared, and must **never** travel from the notebook to here:

- `trials/` — contains snapshots of real conversations
- `mcp-roundtrip-evals/calibrations/`, `product-validation-evals/` — evaluation receipts
- `APP-INTERNALS.md` — reverse-engineering notes
- `EXPERIMENT-BRIEF.md`, `INTERVIEWS.md`, `VALIDATION.md`, `WORKER_PROOF.md` — pitch material
- `deploy/ACCESS-SETUP.md` — the owner's personal deployment runbook

**The rule was broken and the breach is still in history.** `mcp-roundtrip-evals/calibrations/`
was TRACKED here, carrying real record ids and real CLI transcript uuids, and the notebook's own
privacy-guard independently classes those files as personal content that must never be copied
anywhere public. Untracked and gitignored 2026-08-10.

**PUBLICATION GATE — untracking stops FUTURE commits only.** The ids are in the commit history and
`git rm --cached` does not touch it, so a clone of this repo still carries them. Before this repo is
ever made public, a history scrub (`git filter-repo` or equivalent) is REQUIRED, not advisable —
and it must be verified by effect afterwards, on a fresh clone, with the same greps the pre-commit
check runs:

```bash
git clone <repo> /tmp/pubcheck && cd /tmp/pubcheck
git log --all -p | grep -nE "sess_[a-z]*_?[0-9A-HJKMNP-TV-Z]{20,}" | head   # must be empty
```

Notebook path parameterized — the doc carries no private repo names; the values live in
`.repo-paths` (gitignored), sourced by the commands above, same pattern as `.scrub-values`.

A repo that is clean at HEAD and dirty in history is not clean. This paragraph exists because the
tracked-file breach was found by a commissioned sweep, not by the check — a `.gitignore` entry is a
promise about tomorrow and says nothing about what already shipped.

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
# 1. named identifiers. THE VALUES LIVE OUTSIDE THIS FILE, in .scrub-values (gitignored), one
#    extended-regex alternation per line. They used to be written out here — which made the
#    check itself the largest single leak in the repo: an owner name, a surname fragment, a real
#    id, a real machine name and a real home path, in the document that ships. A checker must
#    contain the strings it searches for, so this cannot be fixed by rewording; it is fixed by
#    moving the values somewhere that never ships.
#    The file MUST exist and be non-empty — a fresh clone that silently checks nothing is worse
#    than no check, because it reports success.
test -s .scrub-values || { echo "FAIL: .scrub-values missing or empty — this check is inert; see AGENTS.md"; exit 1; }
git diff --cached --name-only | while read f; do
  [ -f "$f" ] && grep -HinEf .scrub-values "$f"
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

The list only ever grows, one entry per escape that already happened. It caught a real session-id
fragment after that leak, and it did not catch the live session id committed in `forwarder-runbook.js`
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
- **A source-level assertion is not a behaviour assertion.** It is a different thing wearing the
  same green tick. `relay-smoke` held FOUR assertions about the relay's stale-code guard — that it
  checks its own freshness, that it compares against boot mtimes rather than a threshold, that it
  exits rather than hot-reloads, that it watches the contract file too. All four were green all day.
  All four were true of the *source*. The guard had been **inert since it shipped**: `fs` was never
  required in the file, so `fs.statSync` threw `ReferenceError`, a bare `catch (_) { return 0; }`
  swallowed it, and every mtime read returned `0` — boot snapshot included. `0 === 0` forever
  (`bee839b`).

  The file's own comment justified testing at source level because exercising the guard "would mean
  killing a server mid-test". That trade is reasonable and it is still how the coverage was lost, so
  the rule is not "never assert on source" — it is: **if a guard can only be checked by reading the
  code, record it as UNTESTED, never as covered.** Then either buy the behaviour test (spawn the
  real thing into a temp dir; it costs less than a day of a dead guard) or say plainly in the test
  file that this mechanism has no behavioural coverage. Both replacements here run the real thing,
  and both were verified RED against the pre-fix code before being trusted green.

  The catch-all is half the lesson: **a `catch` that returns a plausible value converts a
  programming error into a confident wrong answer** — the same disease as an empty callback
  reporting `fired: true`. Catch the condition you mean (`ENOENT`), let a bug propagate.
- **When a process decides its own lifecycle, its exit status is part of the contract — and the
  file that interprets it is not the file you are reading.** Fixing the inert guard above made the
  outcome *worse than the bug*: the first time it fired for real, the relay exited `0` — a clean
  exit — while printing `exiting for restart with current code`. `com.handoff.relay.plist` sets
  `KeepAlive = SuccessfulExit:false`, deliberately and with its own comment, so that `bootout` means
  stopped rather than "restarted in a second". launchd read exit `0` as *finished, leave it down*,
  and the remote door stayed shut until a human ran `kickstart` (`b091016`, now exit `75`).

  Two decisions, each correct alone, contradictory together, and neither file mentions the other.
  The daemon's identical guard was safe the whole time purely because *its* plist is
  `KeepAlive: true`. So: assert the exit status in the test, and when a mechanism spans a code file
  and a config file, name the other file in a comment at the point that depends on it.

  Three defects sat stacked in that one mechanism — inert guard, clean exit, log line contradicted
  by the status — and **each was invisible until the one before it was fixed.** Expect that shape
  when a mechanism has never once been observed working.
- **Anchors are chosen by STRUCTURE, never by offset — and an extraction is verified by LOADING the
  result, not by reading the diff.** Twice on 2026-08-10 a scripted edit anchored on two symbols
  destroyed working code between them. Once a replacement spanning `applyNickname → PARTICIPATION`
  silently deleted an entire feature and a builder that happened to live in the gap; once a
  route-mirror computed its start as `line − 6` and pasted a block beginning mid-comment, leaving
  the file that serves production with a syntax error.

  Both failures are SILENT at edit time and TOTAL at runtime, and neither diff looked wrong: the
  first showed a plausible replacement, the second a plausible paste. What caught them was running
  the result — a suite in seconds, a `require()` immediately.

  So: anchor on a symbol you can name (`function foo(`, a route's own `if`), take the block by
  walking its own boundaries rather than counting lines around it, and after any scripted edit run
  the file before believing it. Where a symbol count can be taken before and after, take it — a
  range edit assumes nothing lives between its ends, and twice in one day something did.
- **A commit that changes behaviour says so in its subject; a doctrine or docs commit carries no
  functional change.** Mirroring is by commit, and a mirror pass skips doctrine commits by design,
  so a functional change hiding in one is invisible to the only process meant to carry it across.
  Identity step 1 shipped as `ae6d1bf` — "surface-typed ids, **and** NAMES MOVE IDS DON'T enforced
  at the write layer" — whose diff contains *only* the write-layer invariant. The surface-typed mint
  itself rode in `7100038`, titled "Doctrine gloss: the habit is a question, not a virtue". The
  notebook got half of identity step 1 and chat-side identity was inert in production for a day.

  Corollary, because the near-miss is instructive: after mirroring `ae6d1bf` the invariant fired
  correctly (409, refusal naming the remedy) and it would have been natural to call it done. Only
  asserting the *mint* — the other half of that commit's own subject line — exposed the gap. **A
  subject line that names two things is a two-item mirror checklist**, and a subject accurate about
  intent but wrong about content is worse than a vague one.
