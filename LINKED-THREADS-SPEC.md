# Linked threads — specification

**Status: SPEC ONLY. Nothing here is built.** Supersedes the request/response item.
**Written:** 2026-08-07 · Depends on: §01 store (BUILT 2026-08-07, `store/v1`).

Invariants (§I) are separated from flows (§F) so each invariant maps to one future
field-trial check. A flow describes what should happen; an invariant is what must be
true afterwards, and is the only thing a trial can pass or fail.

---

## §01 — Store is the memory; sessions are views with cursors

**Built.** `store/v1/<collection>/<id>.json`, one file per record, path-versioned,
append-only `events.jsonl`, server stateless over it. Concurrent writers no longer erase
each other (measured 5/12 → 10/10).

A **thread** is an append-only event log in that store. A **linked session** holds only a
**cursor** into a thread. Sessions own no durable state of their own — everything
durable is a thread event. This is what makes §03 possible.

```
threads/<thread_ulid>/events.jsonl     append-only, ULID-keyed, never rewritten
threads/<thread_ulid>/meta.json        schema_version, created_at, linked sessions
cursors/<session_id>.json              { thread_id, cursor_event_ulid, updated_at }
packs/<thread_ulid>/<version>.json     context packs (§06), immutable once written
```

Event shape (minimum): `{id (ULID), ts, actor, actor_kind, kind, body, pack_version?}`.
`actor_kind ∈ {human, agent, system}` — §I4 depends on being able to tell them apart.

## §02 — Offers are claimed by surface; targeted sends are resolve-then-send

**Partly built.** Offers already have handshake semantics: addressed to a *surface*,
claimed exactly once by the first `pick_up`, whether that is a new or existing session.
Resolve-then-send is built (title → id, echoed, exact-or-fail-loud).

Unbuilt part: an offer must also append a thread event, so a claim is visible to every
linked session rather than only to the two parties.

## §03 — Cold start: a new session reads the whole thread

A session joining a thread reads it from the beginning and sets its cursor to the end.
No backfill protocol, no catch-up messages, no per-device replay state: correct on first
run **by construction**, because the thread is the memory and the cursor starts at zero.

This is the property that makes a new device — or a new session on an existing device —
cost nothing.

## §04 — Recap on resume

On resume, a linked session summarizes thread events past its cursor, then advances the
cursor. The recap is generated at resume time, not pushed at write time. Nothing needs to
know who is listening when an event is appended.

**Built for the hookable class (2026-08-08):** `bin/handoff-recap.js`, wired as a
repo-level `SessionStart` hook, prints one "while you were away" line at terminal-session
start — attention items counted, ambient ✓✓ summarized inline. Read-only by design
(hooks race live bridges; settlement stays with `status`, so a ✓✓ repeats in recaps until
a `status` settles it). Store-sourced items only: native Code↔Code messages deliver
themselves by starting a turn on the idle receiver.

## §05 — Await-response by spawning, not by messaging

Code needs a reply *now*. Messaging a session cannot deliver one: an idle session has no
running turn, so nothing can compute a reply until a human opens it.

Flow: pull the latest context pack → spawn a Task subagent (or API call) with the pack
**inline, by value** → wait synchronously → append the result to the thread, tagged with
the pack version it was computed against.

The long-running variant targets a *wakeable* session instead of a subagent.

**t24 partial result (2026-08-07) constrains this.** A `dispatch_child` IS a protocol
participant (C18) — but **every one of its tool steps required phone approval** under the
settings observed (C26). So it is *reachable*; whether it can be *autonomous* is **not yet
known**. Until tested, the long-running variant may not ASSUME an unattended
`dispatch_child` — but neither should the spec assert it cannot be one. The Code-permissions
"Accept" setting implies permission modes exist, and whether a scheduled spawn inherits the
gate is exactly the next sitting's probe. Stating "not wakeable" here would make that
probe's headline result an un-falsification of our own table, which is backwards.

Still untested, and the actual wakeable question: **spawn without human initiation** — a
scheduled task or timer starting a session that drains and reports with no person present.
Until that runs, no design may assume a wakeable session exists.

### Valid addressees for an unattended reply

| Session kind | Can compute a reply unattended? | Basis |
|---|---|---|
| Task subagent / API call | **Yes** | We spawn it; it runs to completion synchronously |
| Terminal Claude Code | Yes, if spawned headless | Already how `send_to_worker` works |
| `dispatch_child` | **Reachable; consent-gated as observed; autonomy UNTESTED** | t24: participates via MCP (C18); every tool step required phone approval under current settings (C26). Whether approval can be pre-granted, and whether a scheduled spawn inherits or bypasses the gate, are both untested — that probe is the next sitting. |
| Chat | **No — structurally** | Idle conversation, no running turn; nothing external can push into it |
| Cowork | No | Same, plus desktop-only |
| Design | No | No conversation-level MCP at all |

**Spawn when** a reply is needed within the turn, the work is bounded, and context fits
in a pack. **Message a wakeable session when** the work is long, needs a durable
transcript, or needs tools only that session has — and only once t24 says which sessions
those are.

## §06 — Context packs: versioned, by-value, auto-exported

A **context pack** is a versioned by-value snapshot of a chat's refined context.

- Export runs automatically **on every turn of a linked chat**.
- It is a **no-op when the content hash is unchanged** — so the cost of "every turn" is
  one hash, and the pack version only advances on real change.
- Packs are immutable once written and addressed by version.
- By value, always: a pack crossing to a subagent or another surface carries its bytes.
  A pack referenced by path is unreachable to any receiver that cannot dereference it
  (t17 / t21-C / t21-E, and the same rule Dispatch implements natively).

## §07 — Phone, and what is undecided

- **Case A — app chat on the phone:** ordinary chat flows. Nothing special. Already covered.
- **Case B — Dispatch:** **partly resolved by t24 (2026-08-07).** A `dispatch_child` is a
  protocol participant — it reached a terminal inbox through the handoff MCP (C18). It is
  **not** a filesystem participant: its sandbox (`$HOME=/sessions/<vmProcessName>`) cannot
  reach the store (C17/C19), so "the protocol is files" does not extend to it. And it is
  **consent-gated per tool step** (C26), so it is reachable but not autonomous.
  Still open: spawn without human initiation, and envelope integrity through its transport.

Delivery class is recorded **per route** in the route schema, as expected latency:

| Class | Meaning | Members |
|---|---|---|
| hookable | harness runs a check at turn start | terminal Claude Code (`SessionStart` / `UserPromptSubmit`, observed live on this machine) |
| wakeable | can be woken to drain without a human | scheduled tasks (untested); `dispatch_child` **unclassified** — consent-gated as observed (C26), but pre-granted approval and scheduled-spawn inheritance are untested |
| human-relayed | delivery waits for a person to open it | chat, cowork, design |

A route's class sets what silence means. Silence on a hookable route is a signal; on a
human-relayed route it is the expected state. Conflating them is what graded a six-hour
attended task against a 15-minute timer in t22.

---

# Invariants

Each is stated so a trial can falsify it.

| # | Invariant | Falsified by |
|---|---|---|
| **§I1** | A save writes only records the process changed; concurrent writers to different records all survive. | N concurrent writers, fewer than N records present. **Covered now** — `mcp-smoke`, 10/10. |
| **§I2** | No verb resolves a **target or an identity** the caller did not name. Every delivery names its target; every identity-dependent verb fails loud when the calling session holds no record. | Any send/close/read that lands somewhere the caller did not name. **Covered 2026-08-08** — identity fix: terminal sessions mint their OWN record from the CLI uuid (`CLAUDE_CODE_SESSION_ID`, `/api/register` upsert capturing cwd + last-activity + role); `codeSession()` no longer borrows `by_surface.code` (fails loud); `get_handoff`/`get_decisions`/`report_progress` take explicit targets or a pin, never a guess; `return_to_origin`'s single-open-link silent auto-resolve removed (even one candidate is listed, not closed). Smoke: 8 identity cases. |
| **§I2b** | **Process-scoped addresses are never persisted OR cached.** A pid, socket path, transcript uuid or any value whose meaning dies with a process may be *stored* only as a HINT, and every stored copy is validated against the owning live registry at the moment of use. The registry is the sole authority on aliveness. Corollary (the registry rule, one layer up): **implicit bookkeeping must not manufacture an identity** — a refresh may correct a binding, never invent one. Second corollary: **wrong identity is worse than no identity** — a heal is permitted only where the match is unambiguous BY CONSTRUCTION; ambiguity mints fresh or refuses, never guesses. | Any verb that acts on a stored address without revalidating it, or reports liveness from a cached value. **Covered 2026-08-09** — see the seven-instance evidence table below. |
| **§I3** | A session joining a thread with an empty cursor reaches the same state as one that followed live. | Cold-start session whose recap omits an event a live session saw. |
| **§I4** | **Resurface:** every event appended by a non-human actor appears in the next recap of every linked human-facing session. | An agent-appended event absent from a subsequent recap. **The core anti-t21 check.** |
| **§I5** | A queued message is distinguishable from a read one by the sender — and a receipt is **state, never a message**. | A sender unable to tell delivered from read; a receipt appearing as an inbox item. **Covered, rebuilt 2026-08-08 (two-tier)** — the drain stamps `read_at`/`read_in` on the send record itself; `status` renders `✓✓ read HH:MM` inline and settles on display. Receipts contribute nothing to unread and cannot be drained; `kind: 'receipt'` is refused at the core's only write path, so receipt-of-receipt is unwritable and the ping-pong guard is deleted, not maintained. The receipts-as-messages interim (same morning) is the falsified design: one session's drain ate another terminal's ✓✓ (terminal B, verified in-store — its receipt sat unread until a foreign drain consumed it). Smoke: acceptance (a)–(d). |
| **§I6** | Every artifact crossing a surface boundary travels by value, or the crossing fails loudly. Nothing is ever described as unreachable while being held. | Any by-reference announcement for held content. **Covered** — t21-E, 4 cases. |
| **§I7** | A worker re-checks pack version at each step boundary; on change it pauses and surfaces a diff. | A worker completing against a superseded pack without pausing. |
| **§I8** | Changes arriving after a final checkpoint are flagged in recap and never silently merged. | A post-checkpoint change appearing in output with no flag. |
| **§I9** | Every route declares a delivery class, and orphan/staleness judgements use it. | A human-relayed route judged by a hookable route's timer (t22). |
| **§I11** | An envelope is readable only by a session it was addressed to. | A session reading another conversation's brief. **Currently falsified** — t24 §6.8a: a `dispatch_child`'s no-arg `get_handoff` returned another conversation's locked constraints and artifacts. |
| **§I12** | Every delivered message carries verifiable **provenance and sender class**; a receiver can tell what kind of actor sent it. | A `dispatch_child` message indistinguishable from a code session's. **Currently falsified** — t24 §6.8c. |
| **§I13** | A receiver may refuse an envelope, and refusal is a valid protocol outcome rather than an error — **and the refusal is visible to the sender**, as an event in their next recap or receipt. | A refused envelope that simply vanishes from the sender's view. That is the silent-failure disease in new clothing: a decline nobody sees is indistinguishable from a drop. `decline_handoff` already exists as the verb; the invariant is that it must produce a sender-side event, same as expiry. **Behaviourally observed** — t24 §6.9: a child refused an injection-shaped brief and was right to. |
| **§I10** | A pack export is a no-op when the content hash is unchanged; version advances only on real change. | Version incrementing with an identical hash. |

## §I2b evidence — seven instances of one disease

Written 2026-08-09, after the seventh. Each is the same mistake wearing different clothes:
a value whose meaning dies with a process was kept and then *believed*. They are classified
by HOW the copy was kept, because the fix differs: **persisted** (written to disk / the
store) vs **cached** (frozen in memory for a process's lifetime). The cached variants are
the subtler ones — they never touch disk, so nothing looks like state at all.

| # | Instance | Class | What it cost |
|---|---|---|---|
| 1 | Reply socket path stored and reused (t26) | persisted | ENOENT on reply — the address outlived the listener. |
| 2 | Orphaned bridges serving pre-fix code | cached | Four live bridges answered with retired logic; t9's wrong-surface routing. |
| 3 | `native_ref` pinned at first registration | persisted | The wake tier asked about a dead uuid and reported an OPEN terminal CLOSED. |
| 4 | `const NATIVE_ID = process.env.CLAUDE_CODE_SESSION_ID` | **cached** | Frozen at bridge start; served a stale uuid`, an id with no transcript anywhere. Identity, receipts and wake all inherited the dead pointer. |
| 5 | `nativeReach` fallback to `native_ref.messaging_socket_path` when the file existed | **persisted + unvalidated** | The worst of both: a stored process address trusted with no liveness check at all. A recycled pid would have delivered to a stranger. Deleted, not repaired. |
| 6 | Recap hook reading `process.env.CLAUDE_CODE_SESSION_ID` | *(claim WITHDRAWN — latent risk, not demonstrated failure)* | Originally recorded here as a demonstrated sixth instance. Retracted by its author the same day: a hook is spawned fresh per event and inherits the CLI's *current* env, so it resolved correctly in practice. Reading the authoritative stdin payload is still the correct ordering, and shipped — but the failure never happened. **The correction stands beside the claim, not in place of it**: overstating an instance is the same fault class as understating one. |
| 7 | `status` rendering `ctx.identity` (the bridge's in-memory cache) | **cached** | The canonical case. After a resume, status announced "CLI <uuid>… not yet registered" about a terminal whose record was alive, correctly bound, and refreshing itself on every contact. A cached value reporting on live state, in the one surface whose entire job is truth about state. |

**Measured facts that closed the identity question** (2026-08-09, live, CLI 2.1.226 — none
of this is inferred):

- `SessionStart` delivers `{session_id, transcript_path, cwd, hook_event_name, source}` on
  stdin; `source` is `startup` / `resume`.
- **A real quit-and-reopen preserves the CLI uuid.** Measured on this terminal through the
  bare `claude --resume` picker: uuid unchanged, pid changed.
- **`/clear` is the fork**, inside the same living process: new session id, new transcript,
  `parentUuid` null, no lineage pointer anywhere.

The two cases are therefore complementary, and both are covered without a durable-id
sidecar: `/clear` changes the uuid and keeps the pid → heal by pid; resume changes the pid
and keeps the uuid → the binding matches directly. **A sidecar was designed and then NOT
built**, because the measurement retired the risk it insured. Trigger to revisit, recorded
so the decision is falsifiable rather than final: *if any future measurement shows a resume
path that also drops the uuid, a durable-id sidecar earns its place then* — measured, never
pre-built, and carrying the durable protocol id ONLY (never pid, uuid, or socket, or it
becomes instance eight).

**Acceptance, measured on the live terminal after the resume** (not a fixture):

| Case | Result |
|---|---|
| Healed binding (post-resume, after one tool contact) | `open: true` — *"binding validated against a live row"* → **WAKE, zero taps**. This is the exact terminal that used to report CLOSED. |
| Stale binding (the original defect, replayed) | `open: false` — *"binding stale — 5 live session(s) in this workspace, refusing to guess which"* → **notify**, `stale_binding: true`, `candidates: 5`. |

The second row is the invariant doing its job out loud: five live terminals share this
workspace, and the tier names that number rather than picking one. The two-step therefore
holds in the shape the measurement dictates — a send against a stale binding notifies and
the drain heals; a send against a healed binding wakes. With the uuid durable across
resume, a resumed terminal that has made any tool contact is already in the second state,
so the "second send" is usually just *the next send*.

**Green suites proved nothing.** Three fixtures in this arc were guarding the wrong thing,
and all three passed while the defect they existed to catch was live:

1. `mcp-smoke`'s three wake assertions never set `HANDOFF_SESSIONS_DIR`, so the tier read
   the real registry, found nothing, and reached its target **only** through instance 5's
   unvalidated fallback. They were passing *through* the very defect they guarded.
2. `wake-smoke` built its registry on invented pids (1001/1002) — describing a world where
   every session is dead, so no liveness check could ever have been tested. Standard
   adopted: **any liveness-dependent test spawns real processes** (sleepers), and a killed
   detached child is a zombie that `kill(pid, 0)` still reports alive, so a genuinely-dead
   pid must come from a reaped `spawnSync`.
3. `daemon-smoke` asserted that status must say "not yet registered" until the write-back
   was applied — encoding the cache-dependence of instance 7 as a requirement.

That is the standard this project runs on, stated as procedure: **live proof over green
suites; a test that has never failed for the right reason has not been shown to work.**

## Staleness handling (§F5, stated as procedure)

Workers re-check pack version **at step boundaries**, not mid-step. On change:
**pause → diff → decide** (rebase or restart). The decision is surfaced, never automatic.
Post-final-checkpoint changes are flagged in the recap and never silently merged (§I8).

---

## Boundaries and rules in force

- **Spec only.** Nothing in §02–§07 is built. §01 is built and is the dependency for
  everything else.
- **Validation ledger applies.** No bundle-derived claim from `APP-INTERNALS.md` enters
  this spec unless marked validated. `dispatch_child`'s capability is therefore absent,
  not assumed, throughout.
- **Dependency rule.** Anything that later depends on app internals must degrade to the
  handoff MCP store when the app updates.
- **Workstream separation.** This is workstream (B)-adjacent design. It must not leak
  into workstream (A), the envelope→Dispatch transport work, which is gated on t24.
- **NATIVE-FIRST RULE (adopted 2026-08-08, owner-approved).** Where Anthropic ships a
  primitive, we adopt its semantics, names, and limits verbatim; we build only what they
  don't have; we degrade to the store where native is absent. First application: native
  cross-session messaging (Claude Code ≥2.1.224; verified against
  code.claude.com/docs/en/cross-session-messaging on 2026-08-08, local CLI 2.1.226).
  Native facts adopted: `ListAgents`/`SendMessage`; per-session inbox socket registered
  in files on disk, exported as `CLAUDE_CODE_MESSAGING_SOCKET` (before `SessionStart`
  hooks run); idle sessions get a NEW TURN on delivery (push into idle Code exists —
  §05's premise is dead for Code targets); sender-side outcome notices
  (delivered/held/refused, with held→delivered/denied/expired follow-ups) = our ambient
  tier; `crossSessionInbound` accept/hold/refuse; approval-dialog expiry defaults 5 min;
  loop safety: 50 accepted messages cap per session, 100 held cap, per-sender rate limit
  and identical-repeat drop (windows unpublished — ours are 10/60s and 60s, documented
  in the core route); names via `/rename` / `--name`, auto-named from cwd; cross-machine
  and web sessions are reply-only via Remote Control. **Nuance the pitch must keep:** a
  message refused on arrival produces NO sender-side notice natively — our synchronous
  store refuses loudly at the API instead, which is a deliberate, documented divergence.
  Next: trial t26 (native probes), then the refactor — Code↔Code goes native, the store
  does last-mile socket delivery for cross-surface→Code, `check_inbox` remains for
  chat/cowork/design targets, Code identity reads native registration as `native_ref`.
  t26 RAN 2026-08-08 (`trials/t26-…`) — probes a/b/c/e live, d answered from mechanism.
- **BROADLY-USED-ONLY RULE (adopted 2026-08-08, owner-approved).** No custom or exotic
  primitives. Where a platform mechanism is needed, copy native's exact choice and native's
  exact support matrix — nothing hand-rolled. First application: peer-credential
  verification for the daemon's last-mile socket delivery uses `getpeereid` on macOS and
  `SO_PEERCRED` on Linux — the same per-platform pair the shipped bundle uses (t26 §(d)).
  `getpeereid` is macOS/BSD-only; it does NOT exist on Linux — do not build on it as if it
  were portable. Support matrix, copied from native: macOS + Linux (incl. WSL 2); native
  Windows is EXCLUDED, exactly as native cross-session messaging is (Windows users take the
  WSL 2 / Linux path). Our daemon matches this matrix — no more, no less.
- **ARCHITECTURE — daemon replaces the frozen-bridge (decided 2026-08-08, the user).** Hot-
  reload across N bridge processes patches a symptom (stale bridges, orphan accumulation —
  t26 §(e) counted 6 live bridges on one store). Target shape mirrors native's: ONE store
  daemon (launchd-managed) owns all logic, store access, watchers, and last-mile socket
  delivery into Code sessions; per-session bridges shrink to pure forwarders over one Unix
  socket to the daemon. Update = restart one process, zero session restarts; orphan
  accumulation becomes impossible because forwarders hold no state. t26 proved the daemon
  must exist regardless — it IS the non-child socket poster (delivers to prompting sessions,
  held by bypass sessions; document, do not fight). **Minimalism line, held in review:** the
  daemon design must be ONE process, ONE socket, and NO new storage (the store stays
  `store/v1/` files). More than one process, more than one socket, or any new store is a
  review-blocking regression. Spec: `DAEMON-SPEC.md`.
- **Order in force:** daemon (acceptance a–d) → refactor (native Code↔Code transport,
  `native_ref` read from `~/.claude/sessions/<pid>.json`, name unification) →
  chat-identity build → pitch rewrite.
- **Name unification (t26 display-name finding).** The native session name is the display
  handle everywhere; the protocol title becomes an alias; `register_session` with a role
  also sets the native name via the `/rename` mechanism. One name per session, both layers.
- **C30 CLOSED-AS-SPECIFIED (2026-08-08).** `register_session` from a chat bridge refuses
  loud — "no CLI uuid in this environment — identity records are minted only from a real
  Claude Code session, never guessed (I2)". The chat-identity build (caller-named at send
  time) is spec'd by that refusal text and comes after the refactor.

## Chat-side identity — BUILT 2026-08-08 (mechanism 1: caller-named at send time)

Terminal identity was already solved (`CLAUDE_CODE_SESSION_ID` → minted record, §I2). Chat/
cowork/design senders had no CLI uuid, so their sends carried `from_session: null` and no
read-state (✓✓) could route back — the exact gap the review seat hit live (its directives
arrived anonymous). The empirical constraint C30 stands: the app-spawned bridge's env is
bare and ONE process serves every app conversation, so chat identity cannot come from
process env. **Mechanism 1 (caller-named at send time) shipped:**

- `send_message` gains `from_title` / `from_session_id` (+ `from_surface` to disambiguate).
  A non-terminal sender NAMES its own protocol-known conversation; the send then carries
  `from_session` = that record and read-state routes back to it.
- **Provenance is ASSERTED, not verified — I12's other half, and it is labeled as such** in
  the send result and stamped `sender_class: 'asserted'` on the message. A terminal's
  identity is `verified` (CLI uuid + native-registry cross-check); a pin is `pinned`; no
  identity is `anonymous`. The `sender_class` field rides the message (core `addMessage`).
- **Guard:** a caller may NOT assert a record that has a `native_ref` — those are CLI-
  verified terminal identities and are not claimable by assertion. Ambiguous `from_title`
  refuses (name yourself with `from_session_id`), never guesses. An anonymous send is told
  honestly that no ✓✓ can route, and how to fix it (name `from_title`).
- Tests: `mcp-smoke` +4 (asserted route, message stamp, anonymous honesty, terminal guard).

Mechanisms 2 (pin-per-conversation) and 3 (bridge ULID) from the original plan are NOT
needed: 2 is a weaker superset of pinning we already have, and 3 was ruled non-viable.

**Scope widened + root cause (2026-08-08).** The identity gap is not chat-only. An app Code
tab (`kind: ccd`) had `register_session` REFUSED too — and crucially, `CLAUDE_CODE_SESSION_ID`
*was* set in that session's environment. The refusal happened because the **BRIDGE process
reads its OWN env, not the session's** — one app-spawned bridge serves every app conversation,
so the session's uuid never reaches the bridge. The real gap is **"identity does not travel
session → bridge"**, which is exactly slice 3's per-request `ctx` crux seen from the receiving
side: the fix (carry `cli_uuid`/`pinned`/`cwd` in each forwarded request) makes a real,
verifiable identity available even for ccd/app sessions, upgrading them from `asserted` toward
`verified` where a session uuid genuinely exists. So chat-identity's scope is **every
non-terminal surface (chat, cowork, design, ccd)**, and the caller-named mechanism above is the
interim that works today; the per-request ctx of slice 3b is the structural fix for both.

**Pending — t18 tightening (recorded 2026-08-08).** `send_to` with `to: 'code'` creating a NEW
destination must refuse `open_in: 'app'` unless the app-side Code-tab project verifiably matches
`project_state.project_id`; otherwise it creates with `open_in: 'none'`, stores the message,
and instructs `pick_up` from a terminal in the right repo. Cause: a wake-tier handoff opened
under an unrelated app tab's project bucket even though the session cwd was correct — tab state,
not cwd, decides the app Code target. The review seat already uses `open_in: 'none'` as its habit
for code targets.

## Identity cannot pin to a transport session — VERDICT, measured 2026-08-10

The obvious-looking fix for chat identity is to pin it to the MCP session: the transport
already has a session id, so let identity ride it. **It does not work, and the reason is
measured rather than argued.**

**MCP sessions are per-interaction.** Two consecutive interactions in one app conversation
produced two different transport ids across two consecutive interactions. A transport id therefore
identifies a *request episode*, not a conversation and not a participant. Pinning identity to
it would mint a new identity every turn, which is worse than the anonymity it was meant to
cure: §I2b's stored-address disease, with a fresh address each time.

The ~150ms `initialize` handshake observed on every interaction is **the client's design, not
our omission**. There is nothing to fix on our side and nothing to wait for; the caller-named
mechanism above stays the answer for non-terminal surfaces.

## "Refreshed" is not a failed adoption — the CLI uuid survives `/clear`

Recorded 2026-08-10, after a deliberate `/clear` run as a live test of the fragmentation case.
The reborn session called `register_session` with `succeeds:` pointing at its predecessor's
record and got back **"Refreshed"** — no adoption, no `superseded_by` written. That is correct
behaviour and it should not be read as a failed test:

**`/clear` does not fragment identity in Claude Code.** The CLI uuid is stable across it, so
`register_session` resolves the *existing* record by uuid and `handoff-core.js`'s adoption
branch (`b.succeeds && b.succeeds !== s.id`) skips a self-adoption. Same uuid → refresh, by
design.

The TRUE fragmentation case — the one adoption exists for — is **a NEW terminal adopting an old
record**, where the uuid genuinely differs. A test that wants to exercise the adoption path has
to break the uuid (a fresh process, a `--resume` under a new id), not the thread.

Open, deliberately: a self-adoption is currently skipped **silently**, so a caller asserting a
fragmentation that did not happen is told nothing. Whether that should refuse or report is a
protocol decision, not a bug fix — but "exit status is not effect" applies to the response text
as much as to the exit code.

## Open questions

1. Thread granularity — one thread per project, or per work stream within a project?
   §01's store supports either; the answer is a product decision, not a storage one.
2. Whether a cursor is per session or per (session, thread) pair when a session is linked
   to several threads.
3. Pack scope: whole conversation context, or only the "refined" subset — and who decides
   what refined means.
4. Whether §I4 holds across a *surface* boundary or only within a thread's linked set.
