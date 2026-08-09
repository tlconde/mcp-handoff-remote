# Store hygiene — thread lifecycle, state views, compaction, retention

**Status: SPEC ONLY. Nothing here is built.**
**Written:** 2026-08-07 · Depends on: §01 store (BUILT 2026-08-07, `store/v1`).
**Companion to** `LINKED-THREADS-SPEC.md` — continues its numbering (§08–§12, §I11–§I18)
and does not restate it. Same convention: flows describe what should happen, invariants
are the only thing a field trial can pass or fail.

**Amendment notice.** §09 changes the *read path* asserted in §03 ("a new session reads
the whole thread"). The property §03 buys — correct on first run by construction — is
preserved and restated as §I12; what changes is that a joining session reads a derived
**state view** rather than replaying raw events. §01's append-only log is unchanged and
remains the source of truth. This is the only place the two documents touch.

---

## §08 — Which bloat matters

Two failures get called "the store grows forever". They are not the same problem and they
do not get the same fix.

**Disk is not the problem, and measurements say it never will be.** From the live store
and the t21 snapshot on this machine, 2026-08-07:

| Thing | Measured |
|---|---|
| Live store, 32 sessions, months of poc use | **1.7 MB** total |
| Largest by-value artifact carried in an offer | **4,728 bytes** (`t21-E` snapshot) |
| Largest single session record | 48 KB |
| Typical event line (create/update/delete) | a few hundred bytes |

Extrapolating past anything this poc has seen — 10 active threads × 50 events, plus 3 pack
versions of 5 KB each per thread — is ≈2 MB live, and on the order of 50–100 MB per
*year*. No lifecycle policy is needed to defend a disk against that.

**Context is the problem.** A session joining a thread pays for every dead offer,
superseded pack and side remark in tokens, latency, and — worst — in confusion, because a
withdrawn offer read cold is indistinguishable from a live one. That cost is paid on every
join, by every session, forever.

So the fix is not eager deletion. It is a lifecycle in which relevance decays in stages,
and **the read path only ever touches the live tier**.

| Tier | Contains | In the read path? | Leaves by |
|---|---|---|---|
| **Hot** | open threads: full diary + state view | state view only | crossing the compaction threshold |
| **Compacted** | live thread, pre-K events rolled into a summary event, raw moved to sidecar | summary event only | thread closing |
| **Closed** | thread with a `closed` event, all cursors drained | no — invisible to listing and `pick_up` | retention window expiring |
| **Gone** | deleted | no | — |

## §09 — Hot: reads go through a state view, never raw replay

A thread keeps its full diary. Nothing about §01's append-only log changes. What changes
is that **no reader replays it**.

Every thread has a derived **state view**, rebuilt from the events on append:

```
threads/<thread_ulid>/state.json     derived, rewritable, never a source of truth
```

Minimum contents:

- `latest_pack` — pack version + hash (§06), by value if within the inline budget
- `open_items` — items appended and not since resolved
- `unclaimed_offers` — offers neither claimed nor expired nor withdrawn
- `last_summary` — the most recent summary event (§10), by value
- `cursor_floor` — the earliest cursor across linked sessions (§12 depends on it)
- `event_count`, `first_live_event_ulid`

Cold start (§03) reads `state.json` and sets its cursor to the thread head. Recap (§04)
still reads raw events past the cursor — a recap is a *diff*, and diffs need the diary.
The split is the whole point: **the diary is for audit and diffs; the state view is for
joining.** Irrelevance never enters the join path, so it costs nothing to accumulate.

The state view is derived and therefore disposable: if it is missing or its
`derived_from_event` is behind the head, it is rebuilt from the log. It is never repaired
by hand and never written by anything but the deriver (§I11).

## §10 — Compacted: summary event plus sidecar, at ~100 events

When a live thread crosses **100 events** (`HANDOFF_COMPACT_AT`, default 100):

1. Choose K = the compaction point. **K may never exceed `cursor_floor`** — no event any
   linked cursor has not yet passed may be compacted (§I14).
2. Append one **summary event** (`kind: "summary"`, `actor_kind: "system"`) rolling up
   events `[0, K)`: what was decided, what remains open, what was claimed by whom.
3. Move raw events `[0, K)` to `threads/<id>/events.<K>.jsonl` — a sidecar in the same
   store, not a delete. `events.jsonl` retains `[K, head]`.
4. Drop dead payloads (below).

The diary stays small by construction, and the summary event is an ordinary event: it
appears in recaps, it obeys §I4, and a session whose cursor predates K reads it instead of
the events it replaced.

**Dead offer payloads.** An offer that expired or was withdrawn carries a by-value
artifact that no longer has a claimant — the 4.7 KB kind measured in §08. Once the
`expired`/`withdrawn` event has been surfaced in a recap to the sender (**not merely
appended** — surfaced, per §I4), compaction may drop the artifact body. **The event line
recording that the offer existed, and that its payload was dropped, always stays**
(`payload_dropped_at`).

**No size threshold may ever produce a by-reference description.** This is t21-E one layer
down, and the real defect there is nastier than "a dropped payload looked like an absent
one". In t21-E the payload was *present* — stored by value in both session records — and
the brief rendered it as `(text/markdown, too large — by reference)` because it crossed a
size threshold in the formatter. Transport succeeded; the formatter lied about content it
was holding. A receiving agent that trusts that string refuses to proceed and asks for a
resend that already happened, and the resend renders identically
(`trials/t21-return-invisible-to-origin/FINDINGS.md` §Bug E).

Compaction introduces exactly the same shape of threshold, so it inherits the same rule:
**never emit a by-reference string for a record whose `content` is non-empty.** A dropped
payload says so explicitly and names when (`payload_dropped_at`); a present-but-large
payload is never described as absent, however inconvenient its size (§I15).

**Corrections survive everything.** A record annotated as corrected — the t23 unwind wrote
`[MISFILED — CORRECTED 2026-08-07]` into `sess_5f82c250` verbatim, with a `record_corrected`
event in `ops.jsonl` and a backup at `data.json.bak-t23-unwind`, rather than deleting the
misfiled summary — is the *only* trace of why some other record reads wrong for a reason
that is not its own. Compaction may summarize such a record but must carry its annotation
forward verbatim; retention may never delete it while the record it explains still exists
(§I18).

## §11 — Closed: archive, not delete

A thread is archivable when both hold: it has a `closed` event, and every linked cursor
has reached the head (**drained**). It then moves whole:

```
store/v1/archive/threads/<thread_ulid>/
```

Archived threads are absent from every listing, invisible to `pick_up` and
`list_conversations`, and not joinable. They remain plain files in the store — greppable
for forensics, and restorable by moving the directory back.

Closing is an event, so it is recapped like anything else. A thread with any undrained
cursor is not closed-and-drained and does not move, regardless of age (§I13).

## §12 — Gone: retention, and the honest break with "append-only forever"

Archives older than a **retention window** (`HANDOFF_RETENTION_DAYS`, default 180 ≈ 6
months, measured from the `closed` event) are deleted.

This is a deliberate narrowing of the append-only promise, stated plainly rather than
quietly: **append-only is a property of live threads.** It is what makes cursors,
recaps and diffs sound — an event a cursor has not passed can never move or vanish under
it. It was never a vow to hold dead data eternally, and treating it as one buys nothing
except the context cost §08 measures.

The invariant that makes this safe to automate:

> **Nothing is deleted while any linked session's cursor has not passed it, and nothing
> pending ever leaves the hot tier. Everything else decays on a clock.**

Deletion is the only irreversible step in this document, so it is the only one that gets a
pre-flight: a delete pass re-reads cursors at execution time (not from the state view),
appends a `retention_delete` event to a store-level ledger naming the thread, its close
date, and its event count, and only then unlinks. The ledger is never retention-deleted.

---

# Invariants

Each is stated so a trial can falsify it. Numbering continues `LINKED-THREADS-SPEC.md`.

| # | Invariant | Falsified by |
|---|---|---|
| **§I11** | The state view is derived only. Deleting it and rebuilding from `events.jsonl` + sidecars yields a byte-identical view. | Any rebuild that differs, or any writer other than the deriver. |
| **§I12** | A session joining via the state view reaches the same working state as one that followed live. (§I3 restated for the §09 read path.) | Cold-start session missing an open item, unclaimed offer, or the latest pack that a live session has. |
| **§I13** | Nothing pending leaves the hot tier: a thread with an unclaimed offer, an open item, or an undrained cursor is never compacted past it, never archived, never deleted. | Any pending thing found in `archive/` or absent after a lifecycle pass. |
| **§I14** | No event is compacted, archived or deleted before **every** linked cursor has passed it. K ≤ `cursor_floor`, checked against cursors read at execution time. | A session resuming to a recap that cannot see an event it had not yet read. |
| **§I15** | No lifecycle step ever describes held content as absent or by-reference. A record with non-empty `content` is never rendered by-reference at any size; a dropped payload says so explicitly and names when. | Either direction: a present payload announced as by-reference/too-large (**the actual t21-E defect**), or a dropped one whose history reads as payload-free. **The §I6 / t21-E check, applied to the lifecycle.** |
| **§I18** | A correction annotation survives compaction verbatim, and retention never deletes a corrected record while the record it explains still exists. | A `[MISFILED — CORRECTED]`-style annotation lost, rewritten, or outlived by the record whose wrongness it explains (t23). |
| **§I16** | Compaction preserves resurfacing: an agent-appended event rolled into a summary still reaches the next recap of every linked human-facing session, via the summary. (§I4 under compaction.) | An agent event that vanishes because it was compacted before it was recapped. |
| **§I17** | Every retention delete is preceded by a ledger entry naming what was deleted; the ledger itself is never deleted. | A missing archive with no ledger line. |

## Lifecycle pass (stated as procedure)

Runs opportunistically at write time, never in the read path:

1. `cursor_floor` ← min cursor across linked sessions, read live.
2. If `event_count > HANDOFF_COMPACT_AT` → compact at `K = min(head - keep_tail, cursor_floor)`.
3. If `closed` and drained → move to `archive/`.
4. If archived and `closed_at` older than `HANDOFF_RETENTION_DAYS` → ledger entry, then delete.
5. Rebuild the state view if `derived_from_event` ≠ head.

Every step is a no-op when its precondition fails, and every step is safe to interrupt:
compaction writes the sidecar before truncating, archiving moves before delisting, delete
ledgers before unlinking.

---

## Boundaries and rules in force

- **Spec only.** None of §08–§12 is built. §01 is built and is the dependency.
- **Amends one thing.** §09 changes §03's read path only; §01's log, §04's recap-as-diff,
  and §06's packs are untouched. §I3 is preserved as §I12.
- **No bundle-derived claims.** Nothing here depends on `APP-INTERNALS.md`; the validation
  ledger rule is satisfied trivially.
- **Numbers are measured, not estimated.** §08's table came from the live store and the
  t21 snapshot on this machine. The extrapolation is labelled as one.

## Open questions

1. Whether packs get their own retention (a pack no live thread references is dead weight,
   but pack versions are cited by completed work in §05 and may be wanted for audit).
2. `keep_tail` — how many recent events compaction always leaves raw, independent of
   `cursor_floor`.
3. Whether a thread with no linked sessions at all (`cursor_floor` undefined) is drained or
   frozen. Frozen is the safe default; drained is the useful one.
4. Whether the state view is one file or one per (thread, session-kind) — a human-facing
   view and a worker-facing view want different fields.
5. Where the lifecycle pass runs when every process is short-lived: opportunistically on
   write risks never running on a quiet thread.
