# Object records — specification

**Status: DESIGN ONLY. Nothing here is built, and this document changes no behaviour.**
**Written:** 2026-08-10 · Depends on: §01 store (BUILT 2026-08-07, `store/v1`).
**Companion to** `LINKED-THREADS-SPEC.md`, `STORE-HYGIENE-SPEC.md`, `DAEMON-SPEC.md`.

Same convention as its companions: flows (§) describe what should happen, invariants (§I) are
the only thing a field trial can pass or fail. Every factual claim below is either labelled
**MEASURED** — with what was measured and when — or **proposed**. Nothing in between, and no
incident is described that this document's author did not read in the repo or in the store.

**Numbering.** Sections continue at **§13** and invariants at **§I19**.
`LINKED-THREADS-SPEC.md` and `STORE-HYGIENE-SPEC.md` both define a **§I11 and a §I12**, and
they mean different things (envelope addressing / provenance in the first; state-view
derivation / join equivalence in the second). MEASURED by reading both files, 2026-08-10.
That collision is not this document's to fix, but it is this document's job not to deepen it.

---

## §13 — What an object is, and whether a session becomes one

An **object** is a durably-identified thing this protocol can name, address, write to, and read
back: it holds an immutable id, an append-only history, a projection derived from that history,
and a participation state. Today exactly one kind of record fits that description — a session —
and it fits it *by accident of accretion* rather than by contract.

MEASURED (`handoff-core.js`, 2026-08-10): `createSession` mints
`{ id, surface, title, created_at, messages, decisions, artifacts, open_items, archived,
participation: 'passive' }`. `writeRecord` refuses any write whose payload id differs from the
record id, for **every** collection, with status 409. `COLLECTIONS` is
`['sessions', 'links', 'agents']`, and `load()` reads every `.json` file under each,
`JSON.parse`-ing each inside its own `try/catch` so one unreadable record cannot take down the
store. So the store is already generic over record kinds; only the *rules* are not.

### The two candidate shapes

**(A) Sessions become objects.** "Object" is a contract that existing records satisfy; a session
is an object of type `session`. No new collection, no new file layout, no migration of ids.

**(B) Objects sit beside sessions.** A new `objects/` collection with its own identity rules;
sessions are untouched.

### The case for (B), stated fairly, because it is the low-risk answer

Sessions are load-bearing in production. MEASURED (`DAEMON-SPEC.md`, "THE FLIP IS DONE
(2026-08-09)"): `mcp-handoff.js` runs as a pure forwarder against an installed daemon, and the
daemon is the sole writer to `store/v1/`. Adding a collection is purely additive — `load()`
iterates `COLLECTIONS`, so a new entry cannot regress how session records are read — whereas
imposing a contract on `sessions/` touches the only records the live protocol serves. (B) also
lets `STORE-HYGIENE-SPEC.md`'s tiering land on new records first, where nothing depends on it.

That argument is real and this document does not dismiss it. It loses on one point.

### Why (A) wins: a parallel type re-implements the identity rules, and this repo has already
### written down what that costs

The four identity rules of §16 are not free-floating doctrine; they are code, and the code is
session-shaped. `applyNickname` and `markActive` both read `db.sessions` directly. Under (B) an
object needs uniqueness-at-set-time and passive-until-first-write of its own — which means
either those functions grow a collection parameter (which *is* (A), arrived at sideways) or the
new collection grows a second implementation.

`applyNickname`'s own comment argues the case, about this exact rule, from a shipped failure —
MEASURED, `handoff-core.js`: *"SHARED BY BOTH CALLERS ON PURPOSE… Two call sites, one rule: if
the check lived in the route, the second route would have grown its own slightly-different copy,
which is how 'unique per surface' quietly stops being true."* A new collection is a third call
site with no caller yet to keep it honest. `AGENTS.md`'s standard says the same thing one level
up: *"Never guess. Ambiguity is surfaced and refused, never resolved silently"* — two identity
implementations produce two different refusals for one question.

**Proposed resolution — (A), as a type over existing records, with no new storage.**

- A record's `type` is a field, not a directory. Sessions stay in `sessions/`, keep their ids,
  keep their paths. **Nothing is migrated**, because migrating an id is the one thing
  `writeRecord` exists to refuse (§16.1).
- `type` is **absent-means-session** for every record written before this spec. An absent `type`
  is never an error and never rewritten in place; it is interpreted at read time.
- A non-session object type earns a collection only when one exists that a session record cannot
  express. None does today. Deferred to open question 1 rather than pre-built — the same
  discipline `LINKED-THREADS-SPEC.md` §I2b applied to the durable-id sidecar that was *designed
  and then not built* because a measurement retired the risk it insured.

This satisfies `DAEMON-SPEC.md`'s review gate verbatim: no second process, no second socket, and
**no new storage** — the store stays `store/v1/` plain files.

## §14 — The event log: what exists, what it is not, and the shape proposed

### MEASURED, live store, 2026-08-10

Two logs exist, and **neither is a domain event log.** Counts and key names below are from this
machine's store; no record id, title, or body is reproduced here.

| Log | Lines | Keys present | Kinds |
|---|---|---|---|
| `$HANDOFF_HOME/store/v1/events.jsonl` | 1,290 | `id`, `ts`, `pid`, `kind`, `collection`, `record` (+ `schema_version`, `counts` on one migrate line) | `update` 1,180 · `create` 109 · `migrate` 1 |
| `$HANDOFF_HOME/ops.jsonl` | 830 | `ts`, `event`, and **~70 further keys** appearing on some lines only | `session_registered` 301 · `progress` 218 · `route_resolved` 43 · `route_query` 41 · `deliver_existing` 32 · 40+ others |

Read against the source (`appendEvent`, `save`, `ops`), that table says three things:

1. **`events.jsonl` is a change log, not a history.** It records *that* a record changed, never
   *what* changed or *who* changed it. It has no `actor` and no `actor_kind` — the field
   `LINKED-THREADS-SPEC.md` §01 says §I4 depends on being able to read. It carries `pid`, which
   is a process-scoped value and therefore a hint, never identity (§I2b).
2. **`ops.jsonl` is where meaning went instead.** It has the actors and the verbs, and it has no
   `id`, no ULID, no schema, and no collection — it is diagnostics that grew a domain. Its key
   set is open by construction: every call site adds its own fields.
3. **The `update` : `create` ratio is 10.8 : 1.** Every one of those updates is a whole-record
   rewrite whose content is recoverable only from the record's current bytes. **The store is
   append-only about the fact of change and destructive about its content.**

### What §01 assumed, and the honest reconciliation

`LINKED-THREADS-SPEC.md` §01 states: *"A thread is an append-only event log in that store. A
linked session holds only a cursor into a thread. Sessions own no durable state of their own —
everything durable is a thread event."* MEASURED: that is not what was built. `threads/`,
`cursors/` and `packs/` do not exist in `store/v1`; `COLLECTIONS` is `sessions`, `links`,
`agents`; and a session record durably owns `messages`, `decisions`, `artifacts`, `open_items`
and `participation`. §01's own header says **Built**, and the part that is built is the
one-file-per-record store with a change log; the cursor-and-thread model above it never was.

**This document SUPERSEDES §01's "sessions are views with cursors" claim and preserves the
property that claim was buying.** §01 wanted §03 (cold start correct by construction) to fall
out of the storage model. §14 gets it from projection instead: a joining reader derives state
from history rather than replaying it — which is exactly the amendment
`STORE-HYGIENE-SPEC.md` §09 already made to §03's read path. The three documents are then
consistent: §01's *file layout* stands, §09's *derived state view* stands, and §01's
*sessions-own-nothing* sentence is retired as unbuilt.

### Proposed shape

One log per object, and it is the object's history, not the store's diff:

```
store/v1/<collection>/<id>.json          the record: identity + projection (rewritable)
store/v1/<collection>/<id>.events.jsonl  the object's history (append-only, never rewritten)
store/v1/events.jsonl                    UNCHANGED — the store's change log, kept as-is
```

Event shape, taking `LINKED-THREADS-SPEC.md` §01's minimum verbatim rather than inventing one
(NATIVE-FIRST's habit applied to our own prior art):

```
{ id, ts, actor, actor_kind, kind, body, evidence?, evidence_class?, pack_version? }
```

- `id` is a ULID, minted by `ulid()`, which the store already uses for every record id and every
  change-log line. **Ordering is by `id`, not by `ts`.** MEASURED: `now()` is
  `new Date().toISOString()` — millisecond resolution, and two events inside one millisecond are
  indistinguishable by it. ULID ordering is lexicographic and total.
- `actor_kind ∈ {human, agent, system}`, because §I4 cannot be checked without it, and because
  the evidence law (§17) grades an outcome differently by who claimed it.
- **A `pid` is never an actor.** It may ride an event as a hint and must be revalidated against
  the owning live registry at the moment of use (§I2b). This is stated here because the existing
  change log already stamps `pid` and someone will reasonably read it as provenance.

### Projection vs snapshot

- The **history is the source of truth.** The record file is a **projection**: derived,
  rewritable, disposable, rebuildable from `<id>.events.jsonl` alone.
- A **snapshot** is a projection that has been *frozen and addressed* — the by-value envelope
  `buildEnvelope` produces, or a `STORE-HYGIENE-SPEC.md` §06 pack version. A snapshot is
  immutable and carries the ULID of the last event it saw (`derived_from_event`).
- The distinction is operational, not academic: a projection may be deleted and rebuilt without
  loss; a snapshot may not, because someone downstream has already read it and acted. Rebuilding
  a projection that disagrees with the log means the log wins. Rebuilding a *snapshot* that
  disagrees means a receiver acted on something that no longer exists, and that is a §I8 flag,
  never a silent correction.

## §15 — The three verbs: `resolve`, `append`, `read`

Three verbs, and no fourth. There is no `update` and no `delete`: a correction is an append
(§16.2), and removal is a lifecycle step owned by `STORE-HYGIENE-SPEC.md`.

Refusals below are stated with the status codes the core already uses, so a refusal added later
reads like the ones already shipped.

### `resolve(name | id) → exactly one object, or a refusal`

Turns something a human or an agent typed into exactly one object. It delivers nothing, mutates
nothing, and is therefore the cheapest place to be wrong — which is why every addressing verb
goes through it first (`AGENTS.md`: *"resolve_conversation before sending — it delivers nothing,
so a wrong target costs nothing to correct"*).

| Input | Outcome |
|---|---|
| An exact id that exists | that object, after walking `superseded_by` (§16.2) |
| An exact id that does not exist | **404**, naming the id, never a near match |
| A nickname unique on its surface | that object |
| A name matching several live objects | **409**, listing every candidate; resolution never picks |
| A name matching none | **RESOLVED: nothing** — an honest empty, never a best guess |
| A name matching only superseded objects | the successor, with the chain reported |

**Refusals, exactly:**
- Ambiguity is **listed and refused**, never scored. MEASURED (`AGENTS.md`): a send addressed by
  a name that merely *contained* the right word landed three substantial messages in an unrelated
  record. A ranked guess is that defect with a confidence number attached.
- A **prefix is not a trust class.** MEASURED (`createSession`'s comment): *"THE PREFIX IS
  ASSERTED, NEVER VERIFICATION, and nothing may branch on it as if it were a trust class."*
  `resolve` may use `sess_code_…` to *filter a surface*; it may never treat it as evidence that
  the object is a code session.
- Successor walking is **capped and cycle-checked**: MEASURED, `SUCCESSOR_HOPS_MAX = 8`, and
  `resolveSuccessor` breaks on a repeat, emitting `successor_cycle`, rather than looping. A
  dangling successor stays where it is rather than vanishing.

### `append(object, event) → event id, or a refusal`

The only writer. Appends one event to `<id>.events.jsonl`, then re-derives the projection.

**Refusals, exactly:**
- **The id invariant.** An event that would change the object's id: **409**, verbatim from the
  shipped text — *"a record's id is written once at mint and never changes. Names move, ids do
  not."* MEASURED: `writeRecord` throws this today for every collection, so the object type
  inherits it at the write layer rather than re-declaring it.
- **A malformed outcome.** An event of an outcome kind whose `evidence` is missing, prose, or
  fails its rechecker: **400**, naming the field and the rechecker (§17). This is the load-bearing
  refusal of this document.
- **A structurally unwritable kind.** MEASURED: `addMessage` refuses `kind: 'receipt'` with
  status 400 — *"receipts are message state (read_at/read_in), never messages"* — which makes
  receipt-of-receipt unwritable rather than guarded. The object log inherits the pattern: a kind
  that would let a derived thing be appended as a fact is refused at the single write path, not
  filtered afterwards.
- **A dangling reference.** MEASURED: `addMessage` refuses an unknown `reply_to` with 400. An
  event referencing an event id absent from this object's log is refused the same way.
- **Absence is never permission.** An event of an unrecognised `kind` is refused, not stored
  hopefully. `AGENTS.md`: *"Fail closed. Absence of configuration is never permission."*

`append` is a **write-shaped act** and therefore flips participation (§16.4).

### `read(object, {as: 'projection' | 'history' | 'snapshot'}) → bytes`

- `projection` — the derived current state. The join path. Cheap, and it is what a cold start
  reads (`STORE-HYGIENE-SPEC.md` §09).
- `history` — raw events after a caller-supplied ULID. The diff path. Recaps need this; joining
  does not.
- `snapshot` — a frozen, addressed projection, delivered **by value**.

**Refusals, exactly:**
- **Addressing.** A caller may read only an object it named or is addressed on. An unpinned,
  unnamed read refuses loud rather than returning "the obvious one" — MEASURED as shipped
  behaviour: `get_handoff` takes an explicit target or a pin, and `LINKED-THREADS-SPEC.md` §I2
  records the single-open-link auto-resolve being removed *"even one candidate is listed, not
  closed"*. §I11 (LINKED-THREADS numbering) is recorded there as **currently falsified**; this
  verb is specified so as not to add a second way to falsify it.
- **Never by-reference for held content.** A `read` that is holding non-empty content never
  describes it as absent, too large, or fetchable elsewhere, at any size. MEASURED
  (`STORE-HYGIENE-SPEC.md` §10, t21-E): the payload was *present in both records* and the
  formatter rendered it as by-reference because it crossed a size threshold — transport
  succeeded and the formatter lied about content it was holding. Oversized content is
  **truncated with an explicit, counted marker**, or split, or refused; it is never announced as
  unreachable while held (§I6, §I15).
- **Payload follows the origin.** MEASURED, `buildEnvelope`: a record with `origin_ref` reads its
  payload from the origin, because *"a dest is a delivery address; the origin is where the work
  is described"* — the fix that ended empty worker briefs, placed at the single construction
  point so that *"a verb nobody has written yet inherits the fix"*. `read` is that verb. It
  inherits, and must not re-derive the rule locally.

## §16 — The four inherited identity rules, and how the object type honours each

These are not new rules. They are the rules the session record already lives under, restated as
obligations of the object type, each anchored to the mechanism that enforces it today.

### §16.1 — Ids are immutable · NAMES MOVE, IDS DON'T

**Enforced at the write layer, for every collection, today.** MEASURED: `writeRecord` compares
`rec.id` against the path key and throws 409 before touching the filesystem, with a message that
names the remedy (*"change the title or the nickname instead"*).

**What the object type adds: nothing.** That is the point. Because the check sits at the single
write path rather than in a route, an object type that writes through `writeRecord` is covered
on its first day, exactly as `handoff-core.js`'s own comment claims (*"the same way the id
invariant covers verbs nobody has written"*). The obligation is therefore negative and testable:
**no object verb may construct a record path from anything but the record's own id**, and no
object may be addressed by a path that encodes a mutable name. `<id>.events.jsonl` is named for
the id for this reason; naming a history file after a title would make renaming a rewrite.

*Proposed check:* a fixture appends to an object, renames its title and nickname, and asserts
the history path and every event's `object_id` are byte-identical before and after.

### §16.2 — Adoption supersedes and never rewrites

MEASURED: adoption writes `pred.superseded_by = s.id` and pushes an entry onto `s.succeeds`;
both records keep their ids forever and `resolveSuccessor` walks the chain at use time. It
refuses a cycle (**409**, *"already superseded by … — annul that first"*), skips a
self-adoption, and caps at 8 hops. The core's comment states the doctrine: *"An 'id fix' is
always a new record plus a link, never an edit."*

**The object type extends this from ids to history.** A correction to an object's past is an
appended `correction` event that names the ULID it corrects; the corrected event is never
edited and never removed. This is the same shape `STORE-HYGIENE-SPEC.md` §I18 already protects
for record annotations, where a misfiled summary was **annotated in place rather than deleted**
because the annotation *"is the only trace of why some other record reads wrong for a reason
that is not its own."*

Consequence, stated so it cannot be quietly dropped: **a projection rebuilt from a log
containing a correction must show the corrected value and must still be able to report that it
was corrected.** A projection that silently absorbs the correction has thrown away the trace.

*Open, deliberately:* `LINKED-THREADS-SPEC.md` records that a self-adoption is currently skipped
**silently**, so a caller asserting a fragmentation that did not happen is told nothing, and
notes that whether it should refuse or report is a protocol decision. The object type does not
settle it; it inherits whatever is settled there.

### §16.3 — Nicknames are unique per surface, and refused at set time

MEASURED: `applyNickname` returns `{code: 409, held_by, error}` when a live record on the same
surface already holds the name; a **superseded** record does not block, but the grant records
what it shadows in `nickname_shadows` and an ops event. The reason is written into the code:
*"A collision discovered at use time is discovered by someone who has already lost their
identity and is now being asked to disambiguate: the worst possible moment."* MEASURED also:
the nickname route refuses to name a superseded record at all (**409**, *"name the successor
instead, or the nickname would point at a record nothing resolves to"*).

**The object type's obligation is scope, and it is the one place a general type could quietly
break a shipped rule.** "Per surface" is a session concept. An object with no surface has no
uniqueness scope, and defaulting to "globally unique" or "unscoped" would both be silent
changes to a rule a human relies on under pressure.

**Proposed:** every object declares a `namespace` for nickname uniqueness. For a session the
namespace **is** its surface, so today's behaviour is unchanged by construction and no existing
nickname moves. An object type that cannot declare a namespace **may not hold a nickname** — it
is addressable by id only. Fail closed, and no third implementation of the check: the rule stays
in one function that takes a namespace instead of reading `s.surface`.

### §16.4 — Participation is passive until a first write-shaped act

MEASURED: `createSession` mints `participation: 'passive'`; `markActive` transitions once, in
one direction, stamping `activated_at` and emitting `participation_active`;
`WRITE_SHAPED` is exactly `send, handoff, register, claim, nickname, adopt, message, progress,
return`. The core states both halves of the reasoning: a reader is minted because *"a
conversation that only reads still needs an ADDRESS"*, and the state exists because a picker
*"where every passing reader appears is a list nobody can choose from"*. One direction, because
`passive` is a claim about what a record has **never** done.

**The object type honours this by making `append` the sole trigger.** `read` never activates.
The verb set of §15 makes that structural rather than disciplined: there is exactly one writing
verb, so "write-shaped" stops being a curated list and becomes a property of which verb was
called. The existing `WRITE_SHAPED` set stays as-is for the session path — this document
proposes no edit to it — and the object type's rule is stated as: **`append` activates; nothing
else does; the transition is irreversible.**

*Proposed check:* an object read a thousand times and never appended to still reports
`passive`, and has an id that `resolve` returns.

## §17 — The evidence law

> **An outcome event carries machine-checkable evidence, or the door refuses it. A prose claim
> in an evidence field is malformed input — not a weaker outcome, not a warning, not a
> confidence score. It is a 400.**

This is the section the rest of the document exists to support.

### Why it is stated as a law and not a guideline

`AGENTS.md` records the rule this formalises: *"a call reporting success is evidence the call
ran, never evidence it worked"*, and *"Exit status is not effect. Check the effect."* — the
lesson it calls **the single most expensive of 2026-08-09/10**, listing four instances it
recurred in across two days, *"and every instance looked like success."* MEASURED, by reading
that file: a notifier that exits 0 whether or not anything appears; a dispatch reporting
`fired: true` for a command that failed outright; two tests passing vacuously; and a
`git apply --reject` that reported success, wrote an empty `.rej`, produced a file containing
the expected markers, and had dropped the one hunk that mattered.

The instructive part is its own conclusion: **the unreliable reporter was a standard tool, not
this project's code.** So the defence cannot be "trust our own reports more carefully". The
defence has to be structural: the claim and the proof travel together, or the claim is not
accepted into the log at all. A protocol whose logs contain unverifiable success claims is a
protocol that manufactures the exact confident-wrong-answer this codebase keeps paying for.

### The two definitions the law rests on

**Machine-checkable** means: a **rechecker** exists — a pure function
`recheck(evidence) → {ok, actual, expected}` — that can recompute the claim from the evidence
fields alone, with no access to the process that produced them, and that can **return false**.

**A rechecker that cannot fail is not a rechecker.** MEASURED, `AGENTS.md`: *"A test that has
never failed for the right reason has not been shown to work"*, and the four green
`relay-smoke` assertions that were all true of the *source* while the guard they described had
been **inert since it shipped** — `fs` was never required, every mtime read returned `0`, and
`0 === 0` forever. So every rechecker registered under this law ships with a recorded **red
run**: the evidence bundle that makes it return false, stored beside it.

**Evidence class**, reusing the vocabulary the message layer already ships (MEASURED,
`addMessage`: `sender_class` is stamped `verified | asserted | pinned | anonymous`):

| Class | Meaning | May an `outcome` event carry it? |
|---|---|---|
| `verified` | a rechecker recomputed the claim and returned ok | **yes** |
| `attested` | a named human or process asserts it; no rechecker exists for this kind | **yes, and only with the attestor named** |
| `asserted` | a claim with fields but no rechecker and no attestor | **no** — appendable as `kind: 'claim'` only |
| `anonymous` | no evidence | **no** — 400 |

The `attested` row is not a loophole; it is `AGENTS.md`'s own instruction made writable: *"Where
no receipt exists — Windows toasts, `osascript` — say so and name the human as the receipt
rather than implying one."* An attested outcome is honest about being one, and it is never
rendered as `verified`.

### The refusal, exactly

```
400 outcome "<kind>" refused — evidence.<field> is prose, not a checkable value.
    An outcome carries what a rechecker can recompute: <the fields this kind requires>.
    To record it anyway, append kind:"claim" (evidence_class:"asserted"), which is
    never read as an outcome.
```

Three properties of that refusal are deliberate. It **names the field**, so the caller is not
asked to guess which of five looked wrong. It **names the remedy**, matching the id
invariant's refusal, which names the remedy in the same sentence as the refusal. And it
**offers a lossless downgrade**: the caller's claim is not destroyed, it is filed as what it is.
A law that makes honest reporting impossible gets routed around.

### Made concrete — four outcome kinds

Every field below is proposed. The failure each guards against is MEASURED and cited.

---

**1. `outcome: mirrored`** — a change landed in the other repo.

```json
{ "kind": "mirrored", "actor_kind": "agent", "evidence_class": "verified",
  "evidence": {
    "target_path": "<repo>/handoff-core.js",
    "sha256_before": "0000…", "sha256_after": "1111…",
    "size_before": 71042, "size_after": 71310,
    "mtime_after": "2026-08-10T00:00:00.000Z",
    "symbol_counts": [{ "symbol": "applyNickname", "expected_min": 1, "actual": 3 }],
    "hunks_expected": 176, "hunks_present": 176 } }
```

*Rechecker:* re-hash the target, re-grep each symbol, compare. `sha256_before === sha256_after`
**fails** — nothing landed. `hunks_present < hunks_expected` **fails**.

*What it guards, MEASURED (`AGENTS.md`):* *"`git apply` from inside the notebook SILENTLY
APPLIES NOTHING, and exits 0"*, and `--check` green-lights the same no-op; the file itself
prescribes `grep -c '<a symbol the patch adds>'` and *"size and mtime changed"* as the check,
because the exit code cannot distinguish success from a no-op. It also records the sharper case:
`--reject` reporting success with an empty `.rej`, caught only by diffing every added line
against the applied file — **161 of 176 present, and the missing 15 were the fix**. Hence
`hunks_expected` / `hunks_present` as fields rather than a boolean: a count can be wrong out
loud, a boolean cannot.

*Refused input:* `"evidence": {"note": "mirrored cleanly, applied without conflicts"}` — 400.
That sentence is true of the four failures above.

---

**2. `outcome: delivered` / `outcome: read`** — an envelope reached a receiver.

```json
{ "kind": "delivered", "actor_kind": "system", "evidence_class": "verified",
  "evidence": {
    "target_object": "sess_code_0000000000000000000000ABCD",
    "message_id": "msg_0000000000000000000000WXYZ",
    "read_back_from": "store",
    "present_in_target": true,
    "read_at": "2026-08-10T00:00:00.000Z", "read_in": "sess_code_0000000000000000000000ABCD" } }
```

*Rechecker:* load the **target** object and assert the message id is present in it; for `read`,
assert `read_at` is set on the send record. The evidence must be **read back from the target**,
never copied from the send call's return value.

*What it guards, MEASURED:* `AGENTS.md`'s standard — *"A dispatch is not a delivery"* — and
`LINKED-THREADS-SPEC.md` §I5, where the falsified interim design had receipts as messages and
**one session's drain ate another terminal's ✓✓**, the receipt sitting unread until a foreign
drain consumed it. A delivered-outcome that trusts the sender's return value cannot tell that
story apart from a success.

*Refused input:* `"evidence": {"result": "send_message returned ok"}` — 400. That is evidence
the call ran.

---

**3. `outcome: suite_passed`** — a test suite proves something.

```json
{ "kind": "suite_passed", "actor_kind": "agent", "evidence_class": "verified",
  "evidence": {
    "suite": "mcp-smoke", "exit_status": 0,
    "asserts_expected": 165, "asserts_run": 165,
    "asserts_that_can_fail": 165,
    "red_run_ref": "<ulid of the event recording this suite failing against pre-fix code>",
    "coverage_kind": "behaviour" } }
```

*Rechecker:* `asserts_run === asserts_expected` (a suite that short-circuits runs fewer),
`exit_status === 0`, and `red_run_ref` resolves to an event whose evidence shows this suite
failing. Absent `red_run_ref` → **`attested` at best, never `verified`**.

*What it guards, MEASURED:* `LINKED-THREADS-SPEC.md`'s *"Green suites proved nothing"* —
three fixtures guarding the wrong thing, all passing while the defect they existed to catch was
live: wake assertions that never set `HANDOFF_SESSIONS_DIR` and so *"were passing through the
very defect they guarded"*; a registry built on invented pids, *"describing a world where every
session is dead"*; and a suite asserting the cache-dependence of a bug **as a requirement**.
Hence `coverage_kind`: `AGENTS.md` is explicit that *"if a guard can only be checked by reading
the code, record it as UNTESTED, never as covered"* — so `coverage_kind: "source"` is a legal
value and it is **not** `verified` for a behavioural claim.

*Refused input:* `"evidence": {"tests": "all green"}` — 400.

---

**4. `outcome: live` / `outcome: deployed`** — a claim about the *running* system.

```json
{ "kind": "live", "actor_kind": "agent", "evidence_class": "verified",
  "evidence": {
    "process": "handoff-relay", "pid": 4242,
    "boot_time": "2026-08-10T00:00:00.000Z",
    "change_landed_at": "2026-08-09T23:00:00.000Z",
    "serving_file": "<path>/handoff-relay.js",
    "symbol": "verifyIdentity", "symbol_count_in_serving_file": 1 } }
```

*Rechecker:* `boot_time > change_landed_at` (a process that booted before the change cannot be
serving it), the pid is live **at recheck time**, and the symbol count in the serving file is
non-zero. Any of the three failing → not live.

*What it guards, MEASURED (`AGENTS.md`):* *"My repo is not the running system"* — **three wrong
'unblocked' reports in one day, all confident, all the same cause**; a relay *"serving
eleven-hour-old code with a healthy growing log"*; and the corrected log answering
`mcp-session=none` on every line, which *"looked like a finding about the client and was a fact
about us"* because the server assigns that id and ours never did. The file reduces the defence
to a question — *"which process is serving this, and when did it start?"* — and these fields are
that question in a form a rechecker can ask.

*Note the pid, and note §I2b.* The pid here is **evidence, not an address**: it is revalidated
at recheck time and never used to reach anything. Persisting it as a route would be instance
eight of the disease `LINKED-THREADS-SPEC.md` catalogues.

---

### One consequence worth stating plainly

Under this law, **most of what agents currently write down stops being an outcome.** A progress
note is a `claim`. "Done" is a `claim`. That is the intended effect, not a side effect: the
value of the log is that an `outcome` in it means something a rechecker confirmed, and that
value is destroyed by exactly one permissive kind.

## §18 — What this obsoletes, and its honest limits

### Obsoleted

1. **`LINKED-THREADS-SPEC.md` §01's "sessions are views with cursors"** — retired as unbuilt
   (§14). The file layout and the append-only-store property it also asserts are **kept**; only
   the sessions-own-nothing model goes. §03's guarantee survives as projection, via §09.
2. **`ops.jsonl` as a domain log** — proposed. MEASURED: ~70 keys across 830 lines with no id
   and no schema. It stays as diagnostics; domain facts move to per-object histories. Nothing is
   deleted, and this document proposes no migration of it.
3. **Ad-hoc success reporting in progress messages** — superseded by §17's `claim` / `outcome`
   split. Prose survives, under a kind that does not claim to be checked.

### Limits, stated as limits

- **Nothing here is built, and no `.js` file was touched to write it.** This is the same status
  as its three companions.
- **No rechecker exists.** §17 specifies a registry that has no entries and no code. Until one
  runs — with a recorded red run per kind — the evidence law is a proposal about refusals that
  nothing yet refuses. It would be exactly this document's own disease to describe it otherwise.
- **The evidence-law field sets are proposed, not derived from a trial.** They are reverse-
  engineered from failures recorded in the repo. A trial may well show a required field that
  cannot be produced at the moment of the claim, which would make the door refuse honest work.
  No trial has run.
- **`type` as a field is untested against the daemon.** MEASURED: the daemon is the sole store
  writer and `load()` is `try/catch`-per-record, so an unknown field should be inert. *Should be*
  is not measured. The migration cost of (A) is claimed to be zero and that claim is unverified.
- **Interaction with compaction is unresolved.** `STORE-HYGIENE-SPEC.md` §10 lets compaction drop
  dead payloads. An evidence bundle is a payload. Dropping it turns a `verified` outcome into an
  unrecheckable one — and §I15 forbids describing that as absent-by-default. Which of evidence
  and compaction yields is open question 3.
- **This document does not touch §I11/§I12's numbering collision** (header). It also does not fix
  §I11-as-envelope-addressing, recorded as **currently falsified**; §15's `read` is written not
  to widen it, which is not the same as closing it.
- **One deviation from the commissioning brief, stated rather than absorbed:** the brief named
  `docs/OBJECT-RECORD-SPEC.md`. This repo has no `docs/` directory, and the four sibling specs
  live at the root. Placed at the root beside them; the alternative was to create a directory
  convention that nothing else follows.

---

# Invariants

Each is stated so a trial can falsify it. Numbering continues at §I19 (see header).

| # | Invariant | Falsified by |
|---|---|---|
| **§I19** | An object's history is append-only and totally ordered by ULID. No event is ever edited or removed; a correction is an appended event naming the ULID it corrects. | Any event line whose bytes changed after being written; any ordering that depends on `ts`; a correction applied by rewriting. |
| **§I20** | The projection is derived only. Deleting every record file and rebuilding from the object histories yields byte-identical projections. | Any rebuild that differs; any writer to a projection other than the deriver. (§I11-hygiene, restated for objects.) |
| **§I21** | An object's id is fixed at mint and no verb can move it. Renaming a title or nickname changes no path, no history file name, and no `object_id` on any event. | Any write whose payload id differs from its record id succeeding; any history addressed by a mutable name. |
| **§I22** | Adoption supersedes and never rewrites: both objects keep their ids, the chain is walked at use time, capped and cycle-checked, and a corrected event remains readable in the history that contains its correction. | An "id fix" that edits a record; a projection that absorbs a correction leaving no trace it was corrected; an unbounded or looping chain walk. |
| **§I23** | A nickname resolves to exactly one live object within its declared namespace, and a collision is refused **at set time**. An object with no declarable namespace holds no nickname. | A nickname collision surfacing at use time; an object holding a nickname with no namespace; a second implementation of the uniqueness check anywhere. |
| **§I24** | An object is `passive` until its first `append`, the transition is one-way, and `read` never causes it. A passive object is still addressable and still resolvable. | A read that activates; an object returning to `passive`; a passive object that cannot be addressed. |
| **§I25** | **The evidence law.** No event of an outcome kind enters any history unless its evidence passes that kind's rechecker or is explicitly classed `attested` with a named attestor. Prose in an evidence field is a 400. `asserted` and `anonymous` are never outcomes. | Any `outcome` in a history whose evidence a rechecker cannot recompute; any prose accepted into an evidence field; an `attested` outcome rendered as `verified`. |
| **§I26** | Every registered rechecker has a recorded red run — an evidence bundle for which it returns false — and the red run is stored beside it. | A rechecker with no red run; a rechecker that cannot return false for any input. |

---

## Boundaries and rules in force

- **Design only.** No `.js` file is modified by this document; nothing in §13–§18 is built.
- **Minimalism line held** (`DAEMON-SPEC.md` review gate): no second process, no second socket,
  **no new storage** — per-object histories live inside `store/v1/`, and the existing
  `events.jsonl` is unchanged. A future proposal for an `objects/` collection is deferred, not
  smuggled in here.
- **NATIVE-FIRST and BROADLY-USED-ONLY apply unchanged.** Nothing here introduces a primitive;
  the event shape is taken verbatim from `LINKED-THREADS-SPEC.md` §01 rather than invented.
- **No bundle-derived claims.** Nothing here depends on `APP-INTERNALS.md`.
- **Every claim labelled.** Measured claims name what was measured — the repo files read on
  2026-08-10 and the live store's two logs (line counts, key names and kind counts only; no
  record id, title or body). Everything else says **proposed**.
- **Nothing personal.** All ids in this document are synthetic; paths are written as
  `$HANDOFF_HOME` or `<repo>`; example hosts would be `example.invalid`.

## Open questions

1. **Does a non-session object type exist yet?** §13 says a new collection is earned by an
   object a session record cannot express, and names none. If the answer stays "none" for long
   enough, the object contract is simply the session contract written down — which is a fine
   outcome and should be said out loud rather than discovered.
2. **What is a nickname's namespace for a non-session object?** §16.3 fails closed (no
   namespace, no nickname). Whether that is livable is untested, and the alternative — a
   namespace field a caller supplies — reopens the ambiguity the per-surface scope closed.
3. **Evidence vs compaction.** Does compaction drop evidence bundles (cheap, but downgrades
   settled outcomes to unrecheckable ones), keep them forever (they are the smallest payloads
   here, but unbounded), or keep a hash of the bundle and drop the body? Interacts directly with
   `STORE-HYGIENE-SPEC.md` §I15.
4. **Who runs recheckers, and when?** At append time only (cheap, but a claim verified once may
   stop being true), on read, or on a schedule. A `live` outcome is the sharp case: it is true
   at append and false the moment the process exits.
5. **Does the evidence law apply to `attested` human outcomes on human-relayed routes?** A
   person confirming a notification appeared is the only receipt that exists for that class
   (`AGENTS.md`). Whether the attestation itself needs structure beyond a name is undecided.
6. **Per-object history files versus one log.** One file per object matches the one-file-per-
   record store and keeps a read local, but it multiplies file handles on a lifecycle pass.
   Unmeasured; §08's measurements say disk is not the constraint, and say nothing about handles.
