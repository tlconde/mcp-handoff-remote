# Blob split — separating payload bytes from identity bytes

**Status: DESIGN ONLY. Nothing here is built, and this document changes no behaviour.**
**Written:** 2026-08-10 · Depends on: §01 store (BUILT 2026-08-07, `store/v1`) and
`OBJECT-RECORD-SPEC.md` (DESIGN, 2026-08-10).
**Companion to** `LINKED-THREADS-SPEC.md`, `STORE-HYGIENE-SPEC.md`, `DAEMON-SPEC.md`,
`OBJECT-RECORD-SPEC.md`.

Same convention as its companions: flows (§) describe what should happen, invariants (§I) are the
only thing a field trial can pass or fail. Every factual claim below is either labelled
**MEASURED** — with the command that produced it — or **proposed**. Nothing in between, and no
incident is described that this document's author did not read in the repo or in the store.

**Numbering.** Sections continue at **§19** and invariants at **§I27**, after
`OBJECT-RECORD-SPEC.md` (§13–§18, §I19–§I26). The §I11/§I12 collision that document's header
records between `LINKED-THREADS-SPEC.md` and `STORE-HYGIENE-SPEC.md` is not this document's to
fix; where this document needs one of them it says which file's numbering it means.

**What this document sits under, and does not restate.** `OBJECT-RECORD-SPEC.md` defines the
**object** (§13), the **per-object append-only history** and the projection/snapshot distinction
(§14), the three verbs **`resolve` / `append` / `read`** (§15), the four inherited identity rules
(§16), and the **evidence law** (§17). None of that is redefined here. This document answers one
question those leave open: **which bytes in a record are identity and which are payload**, and
how payload is separated so that it can have a lifecycle at all.

**The rule this document implements**, ruled before it was written:

> **APPEND-ONLY FOR IDENTITY, LIFECYCLE FOR PAYLOADS.**

Ids, links, adoption chains, tombstones: tiny, forever. Artifact bodies, message bodies,
closed-transaction content: a retention policy. **The split is the prerequisite for all of it —
you cannot prune payloads that are welded to the records that identify them.** Retention is
`STORE-HYGIENE-SPEC.md`'s subject (§08–§12) and stays there. This document specifies only the
separation, the reference, the tombstone, the classes retention would act on, and the
measurement that would set its thresholds.

**The problem, as the operator stated it:** the protocol must not append-only its way into
bloating a laptop's storage. That is unacceptable as an end state.

---

## §19 — MEASURED: what is actually in the live store, 2026-08-10

Read-only survey. Nothing under `$HANDOFF_HOME` was modified. Every number below is one that was
run; each block names the command. Paths are written `$HANDOFF_HOME`; **no record id, title, body
or device name is reproduced anywhere in this document**, and where a shape is needed it is
written synthetically as `sess_code_<ulid>`.

`$HANDOFF_HOME` is the store root (`store/v1` beneath it holds `sessions/`, `links/`, `agents/`,
`events.jsonl`, `meta.json`).

**Two precision notes, because the two kinds of number below are not the same unit.** `du`
reports **allocated blocks**; the `node` byte counts report **apparent bytes**. They differ — for
`events.jsonl`, 260 KiB allocated against 212,776 B apparent — and across 160 mostly-small files
block rounding is why `du` sees 2,352 KiB where the records' JSON is 1,710,523 B. Neither is
wrong; mixing them silently would be. Where this document reasons about payload it uses apparent
bytes throughout.

**And the surveyor is in the sample.** This session is itself a record in this store, and the
`report_progress` call this brief required wrote a message into it before the survey ran. So the
121 sessions and 250 `progress` messages counted below include this document's own work. The
survey is read-only; the *session* is not, and claiming otherwise would be the kind of
exit-status-is-not-effect reasoning `AGENTS.md` catalogues. Verified after the fact: `wc -l` on
`events.jsonl` and the session count were identical before and after every measurement command
(1,305 and 121), so no measured figure drifted mid-survey.

### §19.1 — Size, counts, change log

```sh
du -sk "$HANDOFF_HOME/store/v1" "$HANDOFF_HOME/store/v1/sessions" "$HANDOFF_HOME/store/v1/links"
ls "$HANDOFF_HOME/store/v1/sessions" | wc -l
ls "$HANDOFF_HOME/store/v1/links"    | wc -l
ls "$HANDOFF_HOME/store/v1/agents"   | wc -l
wc -l < "$HANDOFF_HOME/store/v1/events.jsonl"
```

| Thing | MEASURED |
|---|---|
| `store/v1` total | **2,352 KiB** |
| `store/v1/sessions` | 1,932 KiB · **121 records** |
| `store/v1/links` | 156 KiB · **39 records** |
| `store/v1/agents` | 0 B · **0 records** |
| `events.jsonl` | **1,305 lines** · 260 KiB allocated / **212,776 B apparent** |
| `meta.json` | `schema_version: 1`, created 2026-08-07, `migrated_counts: {sessions: 32, links: 16}` |
| Session `created_at` span | 2026-08-05 → 2026-08-10 = **4.72 days** |

Event kinds (`kind` counts over `events.jsonl`): **`update` 1,192 · `create` 112 · `migrate` 1**.
The `update : create` ratio is **10.6 : 1**, consistent with `OBJECT-RECORD-SPEC.md` §14's
10.8 : 1 measured on the same file three hours earlier.

**Against `STORE-HYGIENE-SPEC.md` §08, measured 2026-08-07 on this same store:**

| §08, 2026-08-07 | Now, 2026-08-10 | Change |
|---|---|---|
| 1.7 MB total, 32 sessions | 2.30 MiB total, **121 sessions** | records ×3.8 |
| Largest single session record **48 KB** | **373,715 B (365 KiB)** | **×7.6** |
| Largest by-value artifact 4,728 B | largest artifact body **11,078 B** | ×2.3 |

§08's *conclusion* survives — extrapolating 362,243 record bytes per day over the span gives
**≈126 MiB/year** of records and **≈178 MiB/year** of store directory, inside the "50–100 MB per
year" order §08 estimated and still not a disk problem. What did **not** survive is the shape:
§08's largest record was 48 KB and its largest payload was a 4.7 KB offer artifact. Three days
later one record is 365 KiB and it is 88.1% message text. **The growth is not in the number of
records; it is in the size of a few of them.**

### §19.2 — The payload : identity ratio

Classification used: **payload** = `messages[].text` + `artifacts[].content` + `decisions[].text`
+ `open_items[]` + `notes` + `project_state`. **Identity** = the whole record's JSON minus those.
This block only measures that line; §20 defends it, and **§20 moves one field**:
`decisions[].text` turns out to be capped at 200 chars by the only write path, so §20 classifies
it identity-side. Moving its 17,919 B shifts the table below from 81.8% / 18.2% to
**80.7% payload / 19.3% identity**. Both figures are stated rather than one silently chosen; the
totals in §23 are unaffected, because a decision is never prunable under either classification.

```sh
node -e '
const fs=require("fs"),V=process.env.HANDOFF_HOME+"/store/v1",b=s=>Buffer.byteLength(s||"","utf8");
let T=0,part={msg:0,art:0,dec:0,open:0,notes:0,pstate:0};
for(const c of ["sessions","links","agents"]) for(const f of fs.readdirSync(V+"/"+c)){
 if(!f.endsWith(".json"))continue;
 const raw=fs.readFileSync(V+"/"+c+"/"+f,"utf8");let r;try{r=JSON.parse(raw)}catch{continue}
 T+=b(raw);
 for(const m of r.messages||[])part.msg+=b(m.text);
 for(const a of r.artifacts||[])part.art+=b(a.content);
 for(const d of r.decisions||[])part.dec+=b(typeof d==="string"?d:d.text);
 for(const o of r.open_items||[])part.open+=b(typeof o==="string"?o:JSON.stringify(o));
 if(r.notes)part.notes+=b(JSON.stringify(r.notes));
 if(r.project_state)part.pstate+=b(JSON.stringify(r.project_state));}
const P=Object.values(part).reduce((a,c)=>a+c,0);
console.log("record bytes",T,"payload",P,"identity",T-P,"payload%",(100*P/T).toFixed(1));
console.log(part);'
```

| | Bytes | Share |
|---|---|---|
| All records (`sessions` + `links` + `agents`) | **1,710,523** | 100% |
| **Payload** | **1,398,498** | **81.8%** |
| **Identity** | **312,025** | **18.2%** |

Payload breakdown: `messages[].text` **1,242,204** · `artifacts[].content` **94,207** ·
`notes` 24,481 · `decisions[].text` 17,919 · `open_items` 10,114 · `project_state` 9,573.
Totals: **808 messages, 37 artifact entries** (30 carrying content) across 160 records.

**The `links` collection is 9,357 bytes across 39 records and contains ZERO payload bytes.** It
is the cleanest available demonstration of the thesis: the collection that carries the protocol's
entire transaction graph — every origin/dest pair, every status, every resolution timestamp — is
0.55% of the store. Identity is not what is growing.

### §19.3 — The largest records, and what makes them large

Top five by on-disk size, with each record's payload share. Ids and titles omitted; surface and
message-kind census are shown because they are what explains the size.

| # | Surface | Total B | Payload B | Identity | Msgs | Message-text B | Artifact B | Kinds |
|---|---|---|---|---|---|---|---|---|
| 1 | chat | **373,715** | 336,591 | 9.9% | 90 | 329,359 | 5,847 | `xmsg` 52, `progress` 37, `handoff_card` 1 |
| 2 | chat | 193,372 | 163,081 | 15.7% | 76 | 162,680 | 0 | `xmsg` 46, `progress` 29, `context` 1 |
| 3 | code | 137,717 | 107,154 | 22.2% | 94 | 107,154 | 0 | `xmsg` 49, `progress` 45 |
| 4 | code | 86,144 | 68,757 | 20.2% | 55 | 68,630 | 0 | `xmsg` 38, `progress` 17 |
| 5 | code | 71,850 | 55,020 | 23.4% | 49 | 55,020 | 0 | `xmsg` 26, `progress` 23 |

Distribution over all 160 records: `min 171 · p50 3,999 · p90 13,936 · p99 193,372 · max 373,715`.
**The top five records hold 50.4% of all record bytes.** 48 records hold zero payload bytes at all.

**What makes them large is one field: `messages[].text`, and overwhelmingly one kind, `xmsg`.**

Message text bytes by `kind`, all 121 session records:

| `kind` | Messages | Text bytes | Share of record bytes |
|---|---|---|---|
| `xmsg` | 247 | **851,966** | **49.8%** |
| `context` | 58 | 198,375 | 11.6% |
| `chat` | 120 | 69,979 | 4.1% |
| `progress` | 250 | 50,791 | 3.0% |
| `resume_summary` | 21 | 27,529 | 1.6% |
| `handoff_card` | 34 | 24,177 | 1.4% |
| `imported` | 74 | 18,634 | 1.1% |
| `gather_card` | 1 | 379 | — |
| `receipt` | 3 | 374 | — |

Two of those rows are worth stating out loud.

**`xmsg` is half the store.** Of the 247 `xmsg` messages, **208 (723,403 B) have `read_at` set
and 39 (128,563 B) do not.** MEASURED (`handoff-core.js`, `resolveLink`): a returned artifact is
written into `origin.artifacts`, into `dest.artifacts`, **and** as an `xmsg` whose text is
`[returned artifact from …] <name> BY VALUE\n\n<the entire body>`. The comment above it states why
the channel exists — *"a dest with no filesystem … could only NAME it in the summary; the bytes
had nowhere to go"* — and it is the right fix. It also means the same bytes are written three
times, and it is the largest single contributor to the store.

**`receipt` exists, and the write path refuses it.** MEASURED: three `receipt`-kind messages are
present, stamped 2026-08-07T21:37–22:40, while `addMessage` today throws 400 on
`kind: 'receipt'` — *"receipts are message state (read_at/read_in), never messages"*. They
predate the refusal. This is not a bug report; it is a constraint on §20: **a blob classifier
must classify by field shape, never by the set of kinds the current code is able to write**,
because the store legitimately contains shapes the write path now refuses.

### §19.4 — How much of the payload is a duplicate copy

```sh
node -e '
const fs=require("fs"),c=require("crypto"),V=process.env.HANDOFF_HOME+"/store/v1/sessions";
const b=s=>Buffer.byteLength(s||"","utf8"),h=s=>c.createHash("sha256").update(s||"").digest("hex");
const n=new Map(),sz=new Map();
for(const f of fs.readdirSync(V)){ if(!f.endsWith(".json"))continue; let r;
 try{r=JSON.parse(fs.readFileSync(V+"/"+f,"utf8"))}catch{continue}
 const add=t=>{const k=h(t);n.set(k,(n.get(k)||0)+1);sz.set(k,b(t))};
 for(const a of r.artifacts||[]) if(a&&a.content) add(a.content);
 for(const m of r.messages||[])  if(m&&m.text)    add(m.text); }
let inst=0,instB=0,dup=0,dupB=0;
for(const [k,c2] of n){ inst+=c2; instB+=sz.get(k)*c2; if(c2>1){dup++;dupB+=sz.get(k)*(c2-1)} }
console.log("instances",inst,instB,"distinct",n.size,"duplicated",dup,"redundant bytes",dupB,
            (100*dupB/instB).toFixed(1)+"%");'
```

| | MEASURED |
|---|---|
| Payload instances (message texts + artifact bodies) | 838 · 1,336,411 B |
| **Distinct** contents by SHA-256 | **534** · 1,264,411 B |
| Contents appearing more than once | 94 |
| **Bytes held in redundant copies** | **72,000 B — 5.4% of payload bytes** |

The 5.4% headline understates the structural part, so it is broken out:

- **Artifact bodies: 30 entries with content, 14 distinct, and every one of the 14 is held in
  exactly 2 records.** That is not coincidence — `resolveLink` writes the returned body to both
  origin and dest, and `deliverExisting` re-copies `origin.artifacts` onto the dest (its comment:
  *"deliver leaves stale dest.artifacts (t9b …) — anything that reads artifacts[] not the brief"*).
  Duplication here is **guaranteed by the code**, so content addressing removes it
  deterministically rather than opportunistically.
- **7 of those 14 bodies also appear verbatim *inside* a message text** — 8 message sites,
  **38,745 B of third copies** — the `resolveLink` triple-write above.
- **`imported` message text is 18,634 B and 100% of it is hash-identical to a non-imported message
  elsewhere in the store.** MEASURED: `continueIn` pushes `text: msg.text` unchanged when
  `context_mode === 'full'`. Content addressing collapses this class entirely.
- Message-text duplication outside those classes is incidental: the most-copied content is a
  21-byte `progress` text appearing 105 times across 16 records (2,184 redundant bytes).

### §19.5 — Write amplification, because it is the number the retention framing hides

Every `update` in `events.jsonl` is a whole-record rewrite (`save()` re-serializes the record and
`writeRecord` writes-then-renames). Multiplying each `update` by its record's size gives:

| | MEASURED |
|---|---|
| Updates with a resolvable record | 1,192 (0 unresolvable) |
| **Bytes rewritten, valuing each update at the record's size *today*** | **156,774,329 B = 149.5 MiB** |
| Live record bytes | 1,710,523 B |
| **Rewrite amplification** | **≈91.7× — upper bound** |
| Worst single record | 165 updates × 373,715 B = 61.7 MiB rewritten |
| Second worst | 299 updates × 137,717 B = 41.2 MiB rewritten |

**Labelled as an upper bound, and why it cannot be tightened from this store:** records grew over
time, so an update early in a record's life rewrote fewer bytes than its size today. Assuming
linear growth halves it to ≈75 MiB. The true figure needs the record's size *at write time*, and
`events.jsonl` lines carry `id`, `ts`, `pid`, `kind`, `collection`, `record` — **no size field**.
So the exact number is not recoverable from the store as it exists. Both bounds say the same
thing: **the store has already written two orders of magnitude more bytes than it holds**, and a
1.7 MB store is not a description of the I/O this design does. §24 carries this forward.

---

## §20 — What a blob is, exactly

### The test, and what it is a test of

A field is a **blob** if and only if both hold:

1. **It is unbounded by the protocol.** Its length is decided by the caller — a human's brief, a
   file's contents, an agent's report — and nothing in the write path caps it.
2. **Replacing it with `{sha256, bytes, media_type, pruned_at?}` leaves the record still
   *resolvable*, still *addressable*, and still *able to explain what it was*.**

Resolvable: `resolve` (`OBJECT-RECORD-SPEC.md` §15) still returns exactly this object, and every
`superseded_by` / `succeeds` chain still walks. Addressable: its id, its path, its nickname and
its title are byte-identical. Self-explaining: a reader can still say what kind of thing the
record held, how large it was, when it arrived, from whom, and whether it was read.

**What the test is *not*.** Passing it means a field *can be separated from identity*. It does
**not** mean the field may be pruned. Those are different questions and conflating them is the
mistake this section exists to prevent:

> **Blob-ness is structural. Prunability is policy.** §20 decides what can be lifted out of the
> record. §23 decides what may then be deleted, and its answer for several blobs is *never*.

That distinction is what makes the split safe to specify before the retention measurement exists
(§24). Separating a decision's text from a decision's identity costs nothing and forecloses
nothing; deleting it would destroy a locked constraint. The split is the prerequisite; it is not
the policy.

### The classification — go and look, not guess

MEASURED by reading `handoff-core.js` (`createSession`, `addMessage`, `buildEnvelope`,
`artifactBlock`, `resolveLink`, `continueIn`, `deliverExisting`, `applyNickname`, `markActive`,
`writeRecord`) and by dumping the field shape of live records, 2026-08-10.

**IDENTITY — never a blob.** Bounded, fixed-shape, and load-bearing for addressing:

| Field | Why it is identity |
|---|---|
| `id` | Minted once; `writeRecord` throws 409 on any write whose payload id differs from the path key. Immutable by mechanism, not convention. |
| `surface` | One of four enum values. The nickname uniqueness scope (`applyNickname`). |
| `title` | **Bounded at every write site, MEASURED**: `slice(0, 120)` on send, `slice(0, 60)` on worker dispatch from a task, `slice(0, 80)` in ops. Store-wide: `min 1 · p50 60 · max 103`, with 34 titles at exactly 60. A capped field is not unbounded, and titles are how humans address records (`title_contains`). Fails test 1 and test 2. |
| `created_at`, `activated_at`, `last_seen`, `resolved_at` | Timestamps. |
| `participation`, `archived`, `offer`, `status` | Enum state. `participation` is one-way (`markActive`) and is a claim about what a record has never done. |
| `origin_ref`, `native_ref` | Where the payload lives and which native session this is. Removing `origin_ref` would break `buildEnvelope`'s payload-follows-origin rule outright. |
| `superseded_by`, `succeeds`, `nickname`, `nickname_shadows` | The adoption chain and the human's recovery path. |
| `link.{id, origin, dest, status, live_sync, created_at, resolved_at}` | **The entire `links` collection: 39 records, 9,357 B, zero payload.** |
| `decisions[].text` | **Capped at 200 chars by the only write path, MEASURED**: every route that locks a decision — including `send_to`'s `decisions[]` array, which posts each entry as a message with `decision: true` — goes through `addMessage`, which pushes `text.slice(0, 200)`. Store-wide: `n=164 · min 13 · p50 102 · max 200 · 0 over 200`. Bounded, so it fails test 1: it is short payload, not a blob. Total 17,919 B. |
| Per-message envelope: `id`, `role`, `kind`, `reply_to`, `from_session`, `at`, `sender_class`, `read_at`, `read_in`, `decision` | Bounded. `reply_to` integrity is enforced at write time (`addMessage` refuses an unknown id, 400). `read_at`/`read_in` are the receipt — they are *state on the record*, deliberately not messages, and they are what §23 keys eligibility on. |
| Per-artifact envelope: `name`, `type` | The name is what a brief renders as a heading and what dedupe-by-name keys on (`resolveLink`, `deliverExisting`). |

**BLOB — payload, separable:**

| Field | Bytes MEASURED | Test 2 |
|---|---|---|
| `messages[].text` | 1,242,204 | Passes. The message keeps its id, kind, sender, time, reply chain, read state — the record still explains that an `xmsg` of 5,847 B arrived from a named session and was read. |
| `artifacts[].content` | 94,207 | Passes. `{name, type}` survives; the record still says which document crossed. |
| `open_items[]` | 10,114 | Passes. Uncapped (`args.open_items` is stored as given). **Never-list (§23).** |
| `notes.{constraints, entities, non_goals, expected_return, deadline}` | 24,481 | Passes. Uncapped. **Never-list.** |
| `project_state` (incl. `run_breakers`) | 9,573 | Passes. `normalizeProjectState` coerces with `String()` and does not truncate. **Never-list.** |

**The borderline cases, and why they fall where they do:**

- **`decisions[].text` looked like the sharpest case and is not one.** It is caller prose rendered
  verbatim into every brief under *"Locked constraints (verbatim — do not re-litigate)"*, which
  makes it look like the archetypal never-prunable blob. But it is **capped at 200 characters by
  the only write path**, on every route, so it fails test 1 and is not a blob at all — it is 164
  short strings totalling 17,919 B. It is listed under identity above, and it needs no retention
  policy because externalising 200-byte strings would cost more in references than it saves in
  bytes. *Worth recording while looking:* **13 of the 164 locked decisions in the live store are
  exactly 200 characters long** — i.e. truncated at the cap. A constraint rendered under a
  "verbatim" heading that was silently cut mid-sentence is a live tension between that cap and
  that heading. It is not this document's to fix and no fix is proposed here; it is noted because
  it was measured while drawing this line, and because it is the kind of thing that is invisible
  until someone counts.
- **`kind: 'context'` message text is what actually forces the structural / policy split.** It is
  unbounded, it is 198,375 B — 11.6% of record bytes, the second-largest class in the store — and
  it is on the never-list (§23.6). So here is a field that is unambiguously a blob by both tests
  and unambiguously never prunable. If blob-ness and prunability were one question, this field
  would have no consistent answer.
- **`notes.expected_return`** is the return contract. A blob; pruning it would leave a link owing
  a return that nothing can describe.
- **`project_state.run_breakers`** are, by their own definition in `normalizeProjectState`,
  *"facts the receiver must know so local work won't fail mysteriously"*. Prunable in shape,
  never in policy.
- **`kind: 'context'` messages** — `supplied_context` — are the caller's own words, carried
  verbatim *specifically* so that compaction cannot reach them. They are 198,375 B (11.6% of
  record bytes) and they are on the never-list; §23 argues it and prices it.
- **`summary` / `compact()` output** is not a field of any record; it is derived at envelope
  build time. It is not a blob because it is not stored. Under `OBJECT-RECORD-SPEC.md` §14 it
  would be part of a projection — derived, disposable, rebuildable — and that document already
  governs it.

### The line, stated once

> **Identity is every byte a reader needs in order to name this thing, place it in the graph, and
> say what it was. Payload is everything else. Payload is unbounded; identity is not.**

MEASURED consequence of that line on this store: **identity is 329,944 B — 19.3%, with
`decisions[].text` counted identity-side per this section — and 9,357 B of it is the entire
transaction graph.** Even including the never-prunable payload, the floor is
**572,487 B, 33.5%** (§23). The append-only-forever half of the rule is cheap. That is the whole
argument for the rule, and it is a measurement rather than a preference.

---

## §21 — The split itself: where blobs live, and what a reference guarantees

### Where blobs live

**Proposed:**

```
$HANDOFF_HOME/store/v1/blobs/<sha256[0:2]>/<sha256>        the bytes, content-addressed
$HANDOFF_HOME/store/v1/<collection>/<id>.json              the record: identity + references
```

One file per blob, named by the SHA-256 of its contents, fanned out one level on the first byte
so a directory does not accumulate every blob ever written.

**Why one file per blob, and not a sidecar.** The alternative — `<id>.blobs.jsonl` beside the
record, matching `OBJECT-RECORD-SPEC.md` §14's per-object history — loses on one decisive point:
**pruning must be an unlink, not a rewrite.** A sidecar is append-only (§I19 forbids rewriting a
history line), so removing one payload from it is either impossible or a rewrite of the file,
which is the same violation. One file per blob makes a prune a single `unlink` — atomic,
idempotent, safe to interrupt, and safe to resume. It also matches the discipline `load()`
already has (*"one unreadable record must never take down the store"*): one unreadable blob
cannot take down the store either. And a sidecar cannot dedupe across records, which
discards the 100%-of-`imported` and 100%-of-artifact-bodies collapse §19.4 measures.

**The minimalism gate, stated rather than smuggled.** `DAEMON-SPEC.md`'s review gate is *no
second process, no second socket, no new storage*, and `OBJECT-RECORD-SPEC.md` §13 satisfied it
verbatim. This document **does add a directory** under `store/v1`. It is the same store, the same
plain files, the same single writer (the daemon), and no new process, socket, database or format
— but it is one more folder, and calling that "no new storage" would be a word game. It is
declared here as a deviation with a reason: there is no representation of separable payload that
does not add a place to put it, and the sidecar alternative fails on prune-by-unlink above.

**No size threshold decides representation.** Every blob goes to `blobs/`, at any size, including
the 21-byte `progress` text §19.4 found 105 copies of. The tempting optimisation — inline small
bodies, externalise large ones — is **the t21-E defect's exact shape**: a threshold in the code
deciding how content is represented, which is how a payload that was present in both records got
rendered as *"(text/markdown, too large — by reference)"*. `STORE-HYGIENE-SPEC.md` §10 already
generalised the rule to lifecycle steps; this document declines to reintroduce a threshold at the
storage layer. Uniformity over cleverness. MEASURED cost of uniformity today: **534 blob files
for 838 payload instances.** The file-handle question is deferred to open question 4, and to
`OBJECT-RECORD-SPEC.md`'s open question 6, which raises the same concern about per-object
histories and records it as unmeasured.

### How a record references a blob

**Content hash, id, or both? — The hash is the address, and there is no separate blob id.**

```json
{ "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "bytes": 5847,
  "media_type": "text/markdown",
  "encoding": "utf-8",
  "role": "artifact_content",
  "first_seen_at": "2026-08-10T00:00:00.000Z" }
```

The argument, because this is the choice most likely to be second-guessed:

- **A random id proves nothing about the bytes it points at; a hash does.** The standing law is
  that anything load-bearing travels **verbatim or by hash, never only in summary form**. A hash
  reference is the *by hash* half of that law made storable: a reader can recompute
  `sha256(bytes) === ref.sha256` and detect a substituted, truncated or corrupted body **without
  trusting the store**. An opaque `blob_01H…` id is a promise; a hash is a check. This is the
  same reasoning `OBJECT-RECORD-SPEC.md` §17 applies to outcomes — the claim and the proof travel
  together — applied one layer down, and it makes the reference a legal evidence field under
  §17's `verified` class rather than an `asserted` one.
- **Dedup is a consequence, not a goal, and it is measured.** Writing the same content twice is
  the same path, so it is a no-op. §19.4: 100% of `imported` text and every one of the 14 distinct
  artifact bodies collapse; 72,000 B (5.4% of payload) recovered store-wide today, and the
  artifact share of that is *guaranteed by the code paths* rather than incidental.
- **The `resolveLink` triple-write stops multiplying bytes without changing any verb.** The three
  writes — `origin.artifacts`, `dest.artifacts`, and the `xmsg` body — become three references to
  one blob. That comment's fix stays exactly as it is; only the bytes stop being copied.
- **Ids are not abandoned; they were never the blob's.** The *message* keeps its `msg_<ulid>`, the
  *record* keeps its `sess_<surface>_<ulid>`, the *artifact* keeps its name. Identity is on the
  referrer, where §16.1 already protects it. Minting a second id for the body would create a
  second identity to keep immutable, for a thing whose whole purpose is to be disposable.
- **The one thing the hash cannot do** is order or date the body. Hence `first_seen_at` on the
  reference — and note it is a property of *this reference*, not of the content: the same bytes
  referenced later carry a later `first_seen_at` on their own reference. Nothing derives ordering
  from a hash; ordering is by ULID, as `OBJECT-RECORD-SPEC.md` §14 already rules.

### What the reference guarantees — and what it does not

**Guarantees:**

1. **Integrity, recheckable.** `recheck(ref) = sha256(read(ref)) === ref.sha256`, computable from
   the reference alone, and **able to return false** — the property `OBJECT-RECORD-SPEC.md` §17
   requires of every rechecker, and §I26 requires a recorded red run for. The red run here is
   trivial to record and must still be recorded: a reference whose `sha256` is altered by one
   character.
2. **Length without the body.** `bytes` is present whether or not the blob is. This is what lets
   a renderer obey `STORE-HYGIENE-SPEC.md` §I15 without reading the blob at all: it can always
   say *"held, 5,847 bytes"* or *"pruned 2026-08-10, was 5,847 bytes"* and never has to guess or
   round-trip to find out.
3. **Idempotent write.** Same content, same path, no-op.
4. **Immutability of the referent.** A hash reference cannot silently start pointing at different
   bytes. Under a mutable id it could.

**Explicitly not guaranteed: presence.** A reference is not a promise that the bytes are there.
Presence is a separate question with a separate answer (§22), and it is answered by the blob
store, never by the reference. A reference that implied presence would be t21-E rebuilt: a record
confidently describing content it does not have.

### The boundary that matters most: storage is not transport

> **The blob split is a STORAGE representation. It is never a TRANSPORT representation.**

`buildEnvelope`, `artifactBlock`, `buildBrief`, the return leg and `check_inbox` continue to carry
**bytes by value**, unchanged, at the same 16,000-char cap with the same honest truncation. A
brief never renders a hash where content is expected. The reason is measured and expensive:
`artifactCap`'s comment records t8 (Design), t17 (Chat) and t21 Bug E, where *"by reference only
works when the receiver can dereference"* — and app surfaces have no filesystem, so a reference
delivers nothing. `assertArtifactsForAppSurface` refuses name-only artifacts at send time for the
same reason. A blob hash is *less* dereferenceable than a path: it names a file in a store the
receiver may be on the far side of a relay from.

So the split happens strictly below the envelope: the record resolves its references to bytes
before an envelope is built, and if it cannot, the envelope says so explicitly under §22's rules.
Anything else is t17 and t21-E with a content hash attached, which is why this gets an invariant
(§I29) rather than a paragraph.

### How this fits the three verbs — no fourth verb

`OBJECT-RECORD-SPEC.md` §15 rules three verbs and no fourth: no `update`, no `delete`. The split
does not add one.

- **`append`** writes the blob (idempotent, by hash) and appends the event carrying the reference.
- **`read`** resolves references to bytes for `projection` and `snapshot`, and reports §22 state
  when it cannot.
- **A prune is an `append` plus an unlink of derived storage.** The append is a `blob_pruned`
  event — identity, tiny, forever — and the unlink removes bytes that are not a record. A blob
  file is not an object: it has no history, no participation, no nickname, and it is not in
  `COLLECTIONS`. Unlinking it is therefore not a `delete` verb on an object, and the
  three-verb rule survives intact.

---

## §22 — What a pruned blob leaves behind

### The three facts a reader must be able to tell apart

A reader a year later asks one question — *where are the bytes?* — and there are three true
answers plus one defect. Confusing any two of them is the failure this section exists to prevent.

| State | How it is represented | What a reader may conclude |
|---|---|---|
| **Present** | Reference exists, no `pruned_at`, blob file exists | The bytes are here. Render them. |
| **Pruned** | Reference exists **with a tombstone** | **This existed.** Here is its hash, its exact length, when it went, and under which policy. Nothing to resend. |
| **Never existed** | **No reference at all** | Nothing was ever carried here. |
| **Missing** *(a defect, not a state)* | Reference exists, no `pruned_at`, blob file absent | **Nothing.** This is an error: raise it, flag it, never render it as either of the two above. |

That fourth row is the load-bearing one. **"This was pruned" is only a fact if absence without a
tombstone is an error.** If a missing blob were rendered as pruned, then disk corruption, a failed
sync, a half-restored backup and a policy decision would all produce the same string, and the
distinction between *pruned* and *never existed* would be unavailable exactly when someone needs
it. `AGENTS.md`'s rule applies unchanged: **Fail closed. Absence of configuration is never
permission.** Absence of a blob is never permission to claim it was pruned.

### The tombstone

The tombstone lives **on the reference, inside the record** — not in `blobs/`. That is forced: the
record is identity and is kept forever; `blobs/` is the thing being unlinked. A tombstone in the
place being deleted is not a tombstone.

```json
{ "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "bytes": 5847,
  "media_type": "text/markdown",
  "encoding": "utf-8",
  "role": "artifact_content",
  "first_seen_at": "2026-08-10T00:00:00.000Z",

  "pruned_at": "2027-02-10T00:00:00.000Z",
  "pruned_by": "retention:read_relay",
  "pruned_event": "0000000000000000000000WXYZ",
  "refs_at_prune": 3 }
```

Field by field, each earning its place:

- **`sha256` is unchanged.** The tombstone is not an erasure of the address. If the same bytes are
  ever produced again — the artifact still exists in the repo it was written to — the reference
  re-verifies against them with no repair and no ambiguity. This is what makes a prune *lossy but
  not unrecoverable*, and it is the property that lets §23 offer `OBJECT-RECORD-SPEC.md`'s open
  question 3 a third answer.
- **`bytes` is unchanged**, so §I15 can be honoured after the body is gone: the renderer states an
  exact length rather than "some content".
- **`pruned_at`** — *when*, so a reader can place the removal relative to their own knowledge.
- **`pruned_by`** — *which policy*, naming the retention class (§23), not a process and not a pid.
  A prune with no nameable policy is not a prune; it is a deletion, and this document has no verb
  for that. (`OBJECT-RECORD-SPEC.md` §14: a `pid` is a hint, never provenance.)
- **`pruned_event`** — the ULID of the `blob_pruned` event on the object's history, so the removal
  is auditable from the log and not only from the projection. This is the append that makes a
  prune append-only: **the removal of the payload is itself a permanent identity fact.**
- **`refs_at_prune`** — how many references pointed at this blob when it went. Without it, a
  reader who later finds two tombstones for the same hash cannot tell a deduplicated single body
  from two separate carryings.

### Ordering: tombstone before unlink, and presence is answered by the store

A prune is two writes. The order is **append the `blob_pruned` event and write the tombstone
first; unlink the blob file second** — matching `STORE-HYGIENE-SPEC.md`'s existing discipline
that *"compaction writes the sidecar before truncating … delete ledgers before unlinking"* and
§I17's ledger-before-delete.

That ordering has one non-obvious consequence, and stating it is the point:

> **Presence is answered by the blob store, never by the tombstone.** A tombstoned reference whose
> bytes are still on disk is **PRESENT**. It renders its bytes, and the lifecycle pass unlinks it
> again on its next run.

Without that rule, an interrupted prune would leave a record announcing content as removed while
holding it — which is `STORE-HYGIENE-SPEC.md` §I15's forbidden direction (*"a present payload
announced as by-reference/too-large — the actual t21-E defect"*) wearing a different hat. With it,
every interruption resolves toward the honest state, the resume is idempotent, and no window
exists in which the record lies about what it is holding. The cost is that a tombstone means
*"pruning was authorized"* rather than *"the bytes are gone"*, and callers must not read it as the
latter. That is a smaller price than a lying record.

### What a pruned blob renders as

Never a by-reference string, at any size, for any reason:

```
### <artifact name>
PRUNED 2027-02-10 — was 5,847 bytes (sha256 0000…0000), removed by retention class
"read_relay" after this session read it. This is not a transport failure and not a
missing file: the bytes were removed by policy. There is nothing to resend and no
resend will reproduce them.
```

Compare the string that caused t21-E — *"(text/markdown, too large — by reference)"* — which sent
a receiving agent to ask for a resend that had already happened and that rendered identically.
The two failure directions §I15 names are both closed here: a present payload is never announced
as absent (previous subsection), and a dropped payload never reads as payload-free (this one).

### Identity survives a prune, byte for byte

- **No id moves.** A prune edits `messages[i].text_ref` / `artifacts[i].content_ref` and nothing
  else. Record ids, message ids, artifact names, file paths, `superseded_by` and `succeeds` are
  untouched — and because the write goes through `writeRecord`, an implementation that tried to
  move an id would be refused 409 at the choke point rather than caught in review. §16.1 and
  §I21 are inherited, not re-declared.
- **Chains still resolve.** `resolveSuccessor` walks identity fields only; no chain field is ever
  a blob. A fully pruned record is still a resolvable node in the adoption graph.
- **`participation` is unaffected.** A prune is a lifecycle act by the system, not a
  write-shaped act by a participant; it must not flip a `passive` object to `active`. §16.4 makes
  `append` the sole trigger, so the `blob_pruned` append needs an explicit carve-out: a
  system-actor lifecycle event does not activate. Stated here because inheriting §16.4 naively
  would let a retention pass silently activate every quiet object in the store.
- **Corrections are out of reach.** `STORE-HYGIENE-SPEC.md` §I18 already forbids losing a
  correction annotation. Restated as inheritance: an annotation is never a blob, so a prune cannot
  reach one.

---

## §23 — Retention as policy: classes, triggers, and the never-list

Mechanism is `STORE-HYGIENE-SPEC.md`'s (§08–§12: tiers, the lifecycle pass, the ledger, the
cursor floor). This section supplies only the thing that document could not have: **the classes,
now that there is a unit to classify.** Every class below is **proposed**; every number attached
to one is **MEASURED** from §19.

### The refcount rule, which falls out of content addressing

Content addressing means one blob can have many references, and §19.4 measures that this is the
normal case, not the exception (every artifact body: 2 references; 7 of them: 3).

> **A blob is prunable only when EVERY reference to it is eligible under its own class. One
> ineligible reference keeps the bytes.**

Eligibility is therefore a property of the *blob*, computed over all its referrers — never a
property of one record. Get this wrong and pruning a closed transaction silently empties a live
one, because they share the body. This is §I31.

**The cost this creates, and does not pay:** enumerating a blob's references means a full scan of
all records (MEASURED: `load()` already reads every file; 160 records today). No refcount index
exists. Open question 1.

### Classes

| Class | What is in it | Eligibility trigger | MEASURED size today |
|---|---|---|---|
| **`never`** | The never-list below | — | **572,487 B (33.5%)** incl. identity |
| **`read_relay`** | `xmsg` bodies whose `read_at` is set | `read_at` on **every** reference + age | **723,403 B (42.3% of record bytes)** |
| **`closed_transaction`** | Payload on the dest of a terminal link; bodies carried by withdrawn / declined / superseded offers | link status terminal **and** surfaced to origin (`resolveLink` writes a `resume_summary`) + age | dest-of-resolved-link payload **437,083 B**; links: 18 resolved, 2 withdrawn, 9 superseded, 2 failed, 3 gathered, 5 active; offers: 16 completed, 7 superseded, 6 withdrawn, 4 offered |
| **`aged`** | Anything else, by age alone | age only | remainder |

Two notes on the triggers, because "consumed?" is the question that decides whether this is safe:

- **`read_at` is a real receipt, not an inference.** It is set on the send record by the reader's
  own `check_inbox`, which `handoff-core.js` calls *the only verb that reads content*. That
  satisfies `STORE-HYGIENE-SPEC.md` §10's insistence on **surfaced, not merely appended** —
  the distinction §I4 and §I16 exist to protect. An unread `xmsg` is never eligible, whatever its
  age: MEASURED, 39 of them (128,563 B) are unread right now.
- **`aged` is specified and not recommended.** Age is the only trigger here that is not evidence
  of irrelevance. It is listed so that a future proposal to add it arrives as a change to a named
  class rather than as a default nobody chose, and this document declines to give it a number
  (see §24).

### One class this split retires before it is written

An early sketch of this spec had a `derived` class for content reproducible from another blob —
principally `imported` message text, which `continueIn` copies verbatim from origin into dest.
**MEASURED: `imported` text is 18,634 B and 100% of it is hash-identical to a non-imported
message elsewhere in the store.** Content addressing collapses it to zero at write time, with no
policy, no trigger, no age and no tombstone. The class is deleted from this document rather than
specified. Worth saying plainly: **the split's first effect is to make some retention
unnecessary**, and that is a better outcome than a policy that manages the copies.

### THE NEVER-LIST, argued

Nothing here may be pruned by any class, at any age, in any tier, for any reason.

1. **Everything in §20's identity set.** Not policy — it is not a blob. Stated first so the list
   reads as what it is: a short set of *payloads* promoted to permanence.

2. **`decisions[].text` — 17,919 B, 1.0% of record bytes.** Not a blob (§20: capped at 200 chars),
   and on the never-list anyway so that no future reclassification can quietly make it eligible.
   It is rendered verbatim into every brief under *"Locked constraints (verbatim — do not
   re-litigate)"*. A brief that renders a locked constraint as a hash has handed the receiver a
   decision it cannot honour and cannot argue with, which is worse than not carrying it: the
   heading still claims a constraint is stated. And the whole point of `verbatimDecisions` is that
   **a summariser may paraphrase a transcript and may not paraphrase the brief a human wrote**
   (`buildEnvelope`'s `supplied_context` comment). A retention window that can reach a decision is
   a summariser with a clock.

3. **`open_items[]` — 10,114 B, 0.6%.** The Definition of done. `buildBrief` renders it as
   checkboxes and falls back to *"Confirm completion with the user"* when empty — so a pruned
   `open_items` does not fail loudly, it **silently degrades a specified task into an unspecified
   one**. Failure directions matter, and this one is invisible.

4. **`notes.*` — 24,481 B, 1.4%.** Standing constraints, non-goals, key entities, deadline, and
   `expected_return`. `expected_return` is the return contract: pruning it leaves a link owing a
   return that nothing can describe. `constraints` are rendered as *"apply throughout"*.

5. **`project_state` incl. `run_breakers` — 9,573 B, 0.6%.** By `normalizeProjectState`'s own
   definition, the facts *"the receiver must know so local work won't fail mysteriously"*. A
   pruned run-breaker is a receiver that fails mysteriously — the exact outcome the field exists
   to prevent.

6. **`kind: 'context'` message text (`supplied_context`) — 198,375 B, 11.6%. The expensive one,
   and it stays.** MEASURED, from the comment on `buildEnvelope`: *every headless worker ever
   dispatched received an empty brief*, because the envelope was built from the dest while a
   4,431-char task and a 1,746-char context sat on the origin; the worker *"found no work described
   anywhere, and exited 0 having done nothing."* `supplied_context` exists so the caller's own
   words survive compaction. **A retention policy that can delete it re-creates that failure on a
   timer**, and the failure mode is the worst one this repo has recorded: silent, exit-0, and
   indistinguishable from success. 198 KB is the price. It is 11.6% of a 1.7 MB store, and it buys
   the one payload class whose loss has already been measured as catastrophic.

7. **Correction annotations.** Inherited from `STORE-HYGIENE-SPEC.md` §I18 — a correction is *"the
   only trace of why some other record reads wrong for a reason that is not its own"*. Not a new
   rule; listed so the never-list is complete in one place.

8. **Tombstones themselves.** Recursively never prunable, and never retention-deleted, for the
   same reason `STORE-HYGIENE-SPEC.md` §I17 exempts the retention ledger. A pruned tombstone
   converts a *pruned* blob into a *never existed* one, which is precisely the confusion §22 is
   built to prevent. **The one thing a bloat-control policy may never reclaim is the record of
   what it reclaimed.**

**MEASURED total of the never-list, including identity: 572,487 B = 33.5% of record bytes. The
ceiling on what any retention policy could ever recover from this store is 1,138,036 B = 66.5%.**
For scale, §19 measured the maximum achievable by tombstoning *every* message text and artifact
body — never-list included, i.e. illegally — at 1,232,434 B (leaving 27.6%). **So respecting the
entire never-list costs about 94 KB against the illegal maximum.** Permanence is cheap here, and
that is exactly why the never-list should be settled now, while it is cheap, rather than
negotiated later when it is not.

### One thing left open on purpose

`OBJECT-RECORD-SPEC.md` open question 3 asks whether compaction may drop **evidence bundles**, and
frames it as a choice between keeping them forever and losing recheckability. **This document does
not settle it**, but it does note that the tombstone gives that question a third option it did
not have: **keep the hash, prune the body.** A `verified` outcome whose evidence is tombstoned is
not downgraded to unrecheckable — it becomes *recheckable if the bytes are reproduced*, and the
tombstone says so explicitly rather than by absence. Offered to that question; not decided here,
because deciding another document's open question in passing is how a spec acquires rules nobody
argued.

---

## §24 — The measurement this enables, and why it is not performed here

**Parked, deliberately.** The retention measurement is a separate, ruled-parked slice. The reason
the split is specified first is stated in the ruling and worth repeating because it is the whole
sequencing argument: **specifying the split first means the measurement measures categories that
exist, rather than inventing them mid-count.** §19 is a survey of the current state — which was
asked for and is read-only — not that measurement.

> **NUMBERS COME BEFORE THRESHOLDS.** No threshold in this document has a value, and
> `STORE-HYGIENE-SPEC.md` §12's `HANDOFF_RETENTION_DAYS` default of 180 is a placeholder this
> document **does not ratify**. A threshold is a number with a measured justification attached to
> it; anything else is a guess with a config key.

### What would be measured

1. **Size on disk, as a time series rather than a point.** §19 is one snapshot; §08 is another
   three days earlier. Two points already falsified §08's *shape* while confirming its
   *conclusion*. The measurement needs `du` per collection plus `blobs/` at intervals, so that
   growth can be attributed rather than extrapolated.
2. **Per-record growth.** Bytes added per `update`, per record. `events.jsonl` carries no size
   field (§19.5), so this requires recording size at write time — the single cheapest addition
   that would make every later question answerable.
3. **Per-transaction growth.** Bytes per completed handoff round-trip, split into identity and
   payload: how much does one send → pick_up → progress × N → return actually cost? This is the
   unit an operator can reason about, and nothing in the store records it today.
4. **The biggest records and what makes them large.** §19.3 is the template. It must stay a
   per-*field* answer, not a per-record one; "record 1 is 365 KiB" is not actionable, "record 1 is
   88.1% message text, mostly `xmsg`" is.
5. **The prunable set per class** (§23), and how it changes as transactions close. Today: 42.3%
   in `read_relay`, 33.5% never.
6. **Only visible after the split:** blob count, distinct : instance ratio, the **refcount
   distribution** (how many references per blob — today's artifact answer is uniformly 2), and the
   number of blobs whose references span more than one transaction, which is the population the
   refcount rule (§I31) exists for.
7. **Write amplification, properly bounded.** §19.5's ≈91.7× is an upper bound and cannot be
   tightened from the store as it exists. This is on the list because it is the number most likely
   to change the conclusion, and the least likely to be looked for by someone measuring "bloat".

### What shape of answer justifies which threshold

Stated as decision rules *before* the numbers exist, so the numbers cannot be read to suit a
preference already held:

- **If the total stays small and the prunable set is a modest slice of it → set no thresholds.
  Publish the numbers and build nothing.** Given §08's conclusion and §19's ≈126 MiB/year of
  records, this is the most likely outcome, and it must be an available one. **A specification
  that cannot conclude "do nothing" is advocacy, not measurement.** The split would still be
  worth it for dedup and for the never-list, both of which cost no policy.
- **If one class dominates → that class gets a window and the others stay `never`.** Today
  `read_relay` is 42.3% and everything else is small. The lever is a per-class trigger, never a
  global age threshold; a global one would be a number chosen for the classes it does not fit.
- **If growth is linear in transactions rather than in time → dedup and the never-list are the
  whole fix**, because per-transaction identity is 18.2% and provably bounded. Retention windows
  buy little.
- **If write amplification dominates the real cost → retention is the wrong project entirely.**
  The fix is to stop rewriting whole records, which is `OBJECT-RECORD-SPEC.md` §14's per-object
  history — already specified, and reachable without any retention machinery. In that world this
  document's contribution is the blob reference and the never-list, and §23's classes are never
  built. That is a fine outcome and it should be reachable by measurement rather than by
  abandonment.
- **If a class's eligible set is large but its blobs are shared across live transactions**
  (§I31 keeps them) **→ the reported prunable figure is fiction and must be reported net of
  refcounts.** A retention policy that quotes gross eligibility over-promises.

The order is fixed: **measure → attribute → classify → threshold.** Skipping to a threshold is how
`HANDOFF_RETENTION_DAYS = 180` came to exist without a measurement behind it, which is a
placeholder honestly labelled in its own document and should not become a default by inertia.

---

## §25 — Honest limits and open questions

### Limits, stated as limits

- **Nothing here is built, and no `.js` file was modified to write it.** Same status as its four
  companions. `blobs/` does not exist; no reference, tombstone, class or rechecker has any code.
- **The survey is n = 1.** One machine, one operator, **4.72 days**, poc traffic, 121 sessions. A
  store shaped by different usage could invert the payload : identity ratio. Every percentage in
  §19 is a description of this store on 2026-08-10, not a property of the protocol.
- **The 91.7× write amplification is an upper bound and cannot be tightened from this store**
  (§19.5): it prices every historical update at the record's size today, and `events.jsonl` records
  no size at write time. A linear-growth assumption gives ≈75 MiB. Both are labelled; neither is
  the true figure.
- **The 5.4% dedup figure is a measurement, not a prediction**, and it is two different things
  averaged: artifact-body duplication is **structural** (guaranteed by `resolveLink` and
  `deliverExisting` writing both sides) and will recur; message-text duplication is **incidental**
  and may not. Quoting 5.4% as an expected saving would blend a certainty with a coincidence.
- **"Pruning is one unlink" is untested.** It is the argument that chose one-file-per-blob over a
  sidecar, and it rests on an implementation that does not exist.
- **Everything measured is UTF-8 text.** `media_type` and `encoding` are proposed fields for a
  case that has never occurred in this store: a binary blob — an image returned from a design
  surface — has never been carried. A field designed for an unobserved case is a guess.
- **This document adds a directory under `store/v1`**, which is a real deviation from
  `DAEMON-SPEC.md`'s *no new storage* gate that `OBJECT-RECORD-SPEC.md` §13 satisfied verbatim.
  Declared in §21 with its reason rather than absorbed.
- **The refcount rule creates a cost this document does not pay.** Computing a blob's references
  is a full scan; no index is specified, and the alternative — an index — is a second source of
  truth about which references exist, which is the class of defect `migrateIfNeeded`'s comment
  calls *"the A18 failure"*.
- **Interaction with `archive/` is unresolved.** `STORE-HYGIENE-SPEC.md` §11 archives a thread by
  moving its **directory**. A content-addressed `blobs/` is global, not per-thread, so archiving
  moves no bytes and the "moves whole … restorable by moving the directory back" property no
  longer holds for payload. Open question 2.
- **This document introduces a second place where a record can describe content it does not
  hold.** That is the t21-E shape, knowingly. §22's tombstone, the missing-is-a-defect rule
  (§I30), and presence-answered-by-the-store (§I32) are designed against it — but a mitigation
  specified is not a mitigation trialled, and t21-E was found in a trial, not in review.
- **`participation` needs an explicit carve-out** for the `blob_pruned` append (§22), because
  inheriting `OBJECT-RECORD-SPEC.md` §16.4 naively would let a retention pass activate every quiet
  object in the store. That carve-out is proposed here and is a change to how §16.4 reads; that
  document has not been amended.
- **No rechecker exists**, so §I28's requirement of a recorded red run is, today, a proposal about
  a check that nothing runs — the same limit `OBJECT-RECORD-SPEC.md` §18 states about the evidence
  law, and it would be this document's own disease to describe it otherwise.

### Open questions, left open on purpose

1. **Refcount index, or scan?** Scan is honest, has no second source of truth, and is O(all
   records) — 160 today, and the lifecycle pass is not in the read path. An index is fast and is a
   thing that can be wrong. Unmeasured, and the answer probably depends on §24's record count
   growth rather than on preference.
2. **Archive and a global blob store** (above). Options: per-archive blob copies (duplicates
   bytes, defeats dedup), leave blobs global (archive is no longer self-contained), or refcount
   across the archive boundary (correct and most complex). Not chosen.
3. **Is `supplied_context` really never-prunable at scale?** It is 11.6% now. If it becomes the
   dominant class in a year, "never" needs a better answer than repetition — and the honest
   candidates are all worse than paying for it. Flagged rather than resolved because the resolution
   should follow §24's numbers.
4. **Is uniform externalisation right for tiny blobs?** 534 files for 838 instances today. The
   threshold-free rule is chosen deliberately against t21-E, but the file-handle cost is
   unmeasured, and `OBJECT-RECORD-SPEC.md` open question 6 raises the same concern about per-object
   histories. If a measurement ever justifies inlining small bodies, it must arrive as a change to
   the *storage* rule with the *rendering* rule (§I29, §I30) untouched — that is the boundary
   whose crossing caused t21-E.
5. **Does the split sit under whole-record rewrite, or force the move to per-object histories?**
   §19.5 argues the latter and §24 makes it a measurable question. Deliberately not decided: it is
   `OBJECT-RECORD-SPEC.md` §14's territory, and this document should not annex it on the strength
   of one upper-bound number.
6. **Evidence bundles: hash-kept, body-pruned?** Offered to `OBJECT-RECORD-SPEC.md` open question
   3 (§23), not decided.
7. **What prunes, and when?** `STORE-HYGIENE-SPEC.md` open question 5 already asks where a
   lifecycle pass runs when every process is short-lived. The blob split inherits that question
   unchanged and adds nothing to it, which is worth saying so it is not assumed answered.

---

# Invariants

Each is stated so a trial can falsify it. Numbering continues at **§I27** after
`OBJECT-RECORD-SPEC.md` §I26.

| # | Invariant | Falsified by |
|---|---|---|
| **§I27** | **Blob-ness is structural, and the test is the record.** A field is a blob only if replacing it with `{sha256, bytes}` leaves the record resolvable by `resolve`, addressable by the same id / path / nickname / title, and able to state what it held and how large it was. Identity is never a blob. | Any record that, with every blob tombstoned, cannot be resolved, cannot be addressed by an unchanged id, or cannot report what it held; any id, path, chain field or message envelope field classified as a blob. |
| **§I28** | **The reference is self-verifying and length-bearing.** Every reference carries `sha256` and `bytes`; `recheck(ref)` recomputes the hash from the bytes alone and **can return false**, with a recorded red run stored beside it. | A reference with no length; a reference addressed by a mutable id instead of content; a rechecker with no red run, or one that cannot fail for any input. |
| **§I29** | **Storage representation is never transport representation.** No envelope, brief, return or inbox part ever carries a blob reference where content is expected. Bytes travel by value, at every size, exactly as they do today. | Any brief, envelope or return in which a hash, path or reference appears in place of an artifact body or message text — the t17 / t21-E defect with a hash attached. |
| **§I30** | **Three states, and missing is a defect.** *Present* (blob file exists), *pruned* (reference carries a tombstone), *never existed* (no reference). A reference whose blob is absent **with no tombstone** is an error that is raised, and is never rendered as pruned or as absent-by-default. | A missing blob rendered as pruned; a pruned blob indistinguishable from one that never existed; absence treated as permission to claim a prune. |
| **§I31** | **The refcount rule.** A blob is pruned only when **every** reference to it is eligible under its own class. Eligibility is computed over all referrers, never over one record. | Any pruned blob with a reference that was not eligible; any reported prunable figure quoted gross of refcounts. |
| **§I32** | **Tombstone before unlink, and presence is answered by the blob store.** A prune appends its `blob_pruned` event and writes the tombstone before unlinking. A tombstoned blob whose bytes are still present is PRESENT: it renders its bytes and is re-unlinked idempotently. | An unlink with no preceding tombstone and no preceding event; a present blob rendered as absent because its reference is tombstoned (§I15's forbidden direction). |
| **§I33** | **Identity survives pruning byte for byte.** No prune changes any record id, message id, artifact name, file path, `superseded_by`, `succeeds`, `read_at`, or `participation`. A fully pruned record is still a resolvable node in the adoption graph. | Any of those fields differing across a prune; a retention pass flipping a `passive` object to `active`. |
| **§I34** | **The never-list is absolute.** No class, age, tier, closure or read state prunes identity, `decisions[].text`, `open_items[]`, `notes.*`, `project_state`, `kind: 'context'` message text, a correction annotation, or a tombstone. | Any of those absent, tombstoned, or rendered as pruned after a lifecycle pass; a brief rendering a locked constraint or a definition-of-done item as a hash. |

---

## Boundaries and rules in force

- **Design only.** No `.js` file is modified by this document; nothing in §19–§24 is built. The
  only artefact produced is this file.
- **Read-only survey.** Every measurement is a read: `du`, `ls`, `wc`, and `node -e` scripts that
  only `readFileSync`. Nothing under `$HANDOFF_HOME` was created, modified or deleted **by the
  survey**. The protocol calls this brief required — `report_progress`, and the `return_to_origin`
  that closes it — are ordinary protocol writes and did touch the store; §19 says so and reports
  the before/after check.
- **Sits under `OBJECT-RECORD-SPEC.md`.** The object, the append-only history, the three verbs,
  the four identity rules and the evidence law are **referenced, never restated or redefined**.
  Where this document needs a carve-out from one of them (§16.4 and the `blob_pruned` append) it
  says so as a proposed amendment rather than reading it in silently.
- **Minimalism line, with one declared deviation.** No second process, no second socket, no new
  format, no database, one writer. `store/v1/blobs/` is one new directory, declared in §21 with
  its reason, not smuggled.
- **Every claim labelled.** MEASURED claims name the command that produced them and the date
  (2026-08-10). Everything else says **proposed**. No threshold is given a value.
- **Nothing personal.** No owner name, no device name, no real repo path, no real session id, no
  title and no record body appears anywhere above. Ids are written as shapes
  (`sess_code_<ulid>`, `msg_<ulid>`); hashes in examples are zeros; paths are `$HANDOFF_HOME` or
  `<repo>`.
