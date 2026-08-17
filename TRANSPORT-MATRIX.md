# Transport matrix — how anything reaches anything

**What this is:** for every ordered pair of surfaces, how a message travels, **how the receiver
learns of it**, what the latency actually looks like, and what is not possible on that pair. Written
from measurements and code, not from design intent. Where a pair has no evidence it says
**UNVERIFIED** rather than describing something plausible.

**Measured 2026-08-10** against the live store. Every count below is a real message that really
travelled; every median is `read_at − queued_at` over the messages that were read.

| pair | messages | read | median read latency | receiver learns by |
|---|---:|---:|---:|---|
| **chat → code** | 148 | 148 | **25s** | wake tier — a turn starts by itself |
| **code → chat** | 148 | 148 | **370s** | the human, next time they speak there |
| **code → code** | 14 | 8 | 820s | wake tier when the target is open; otherwise the human |
| **cowork → code** | 4 | 3 | 374s | wake tier / pick-up |
| **chat → chat** | 3 | 3 | 53s | the human, next time they speak there |
| **code → design** | 2 | **0** | — | nothing has ever read one |
| **code → cowork** | 1 | **0** | — | nothing has ever read one |
| *(no sender record)* → any | 31 | 0 | — | anonymous sends; no read-state routes back |

**The single most important row is the difference between the first two.** Same store, same verbs,
same evening, **25s versus 370s** — a factor of about fifteen. Nothing about the transport differs.
What differs is that **one surface can be woken and the other cannot.**

---

## chat → code — the only pair with a wake

**How it travels:** `send_message` writes an `xmsg` into the destination record. The write is
durable before anything else is attempted.

**How the receiver learns:** at the *send site*, `handoff-tools.js` calls
`require('./bin/handoff-wake').wake(...)` whenever the destination is a **code** record holding a
`native_ref`. The rung ladder is tried in order, first hit wins:

1. **channel-inject** — only if the target was launched with `--channels`. Research preview.
2. **`-p` relay** — a one-shot `claude -p` with `--allowedTools ListAgents SendMessage`, which finds
   the target by name and sends it one line. **This is the rung that carries essentially everything.**
   It is fire-and-forget and detached: a dispatch proves a process started, and nothing more.
3. **notify** — no process can be reached, so a human is told instead. Never claims a turn started.
4. **store** — the floor. The durable write is already done; the mail waits for someone to look.

**Latency character:** median **25s**, min 14s. That is not transport time — the write is
instantaneous. It is *turn-start* time: the spawned relay has to boot, find the peer and send.

**The failure mode that cost a day:** the relay reports `dispatched`, which is honest, and it is
*not* evidence of delivery. On 2026-08-10 a CI seam armed in the production daemon returned
`woke:true, tier:'relay', delivery:'dispatched'` **without spawning anything** — five wakes, no
terminals moved, no notifications (the notify rung only runs when relay *declines*, and relay was
claiming success). Every wake now writes an op carrying its tier, and a seam labels itself
`relay-simulated` with `seam:true`.

**Injection during a busy turn:** a message that arrives while the target is mid-turn is *injected,
not woken* — it lands in the queue and is read at the end of the current turn. Measured: seven
deliveries waited 120s–1267s, and in **every** case the wait ended exactly when the *next* message
arrived. Those are not failures; they are a receiver that was busy.

## code → chat — durable, and unwakeable by design

**How it travels:** identical write, same verb, same store.

**How the receiver learns:** **it does not, until a human speaks in that window.** There is no wake
mechanism for chat, and this is a **platform boundary, not a defect**: a chat conversation has no
process, no socket and no pid to reach. Nothing in any build can start a turn there.

**Latency character:** median **370s** over 148 messages, all eventually read. That number measures
**the reader's habits, not the transport.** (A previous estimate of 234s was quoted during the
evening; the figure here is what the store says at the time of writing.)

**What is NOT possible:** starting a turn in a chat conversation. Do not promise it, and do not
describe a notification as a wake — a notification is an announcement to a human.

## code → code — same machine

**How it travels:** the same store write. Both records are code, so the wake gate applies.

**How the receiver learns:** the relay rung, exactly as chat → code, provided the target has a live
`native_ref` — a registered terminal with a socket and a live pid. If the binding is stale (the
target was resumed, so its uuid forked) the tier reports `stale-binding` and **refuses to guess**
among live sessions in that workspace rather than delivering to the wrong one.

**Latency character:** median **820s** over 8 read messages — and that number is about *which*
records these were, not about the pair. Most are carrier records and one-shot seats that nobody was
sitting in front of.

**Note on native messaging:** Claude Code has its *own* session-to-session messaging over
`/tmp/cc-socks/*.sock`. It works, it starts turns, and it is **not** this system: it writes nothing
to the store, produces no `xmsg`, and leaves no record. A ping through it proves the sockets work
and proves nothing about handoff.

### Native peer messaging is a PLATFORM capability — measured on both sides, 2026-08-10

Two hypotheses died to get this, and both were wrong in instructive ways.

| | macOS (this machine) | Windows (the peer) |
|---|---|---|
| `ListAgents` on the model's tool surface | **exists** — listed 8 terminal peers | **does not exist** — not "returns zero"; the verb is absent |
| `SendMessage` to a terminal never spawned by the sender | **`success: true`** → *"another Claude session on this machine"* | `success: false` — *"No agent named 'X' is reachable"* |
| same-machine control | — | **fails identically to the cross-machine attempt, byte for byte** |
| published address in the session registry | `messaging_socket_path` | **none** — no socket, no port, no pipe. `peerProtocol: 1` is declared with no address, and neither Claude process listens on any TCP port |

**The wrong hypothesis (mine):** *"native @peer is host-local, so it cannot cross machines."* Refuted
by the peer's same-machine control — a local peer failed exactly as a remote one did, so the host
boundary was not what was stopping it.

**The wrong inference (the peer's):** *"the model-facing SendMessage only addresses subagents it
spawned, on every OS including the Mac."* Refuted by the control above — on macOS it reached a
terminal that was never spawned by this session, and `ListAgents` describes exactly that scope.

**What is actually true:** native cross-session messaging is available on **macOS and Linux** and is
**not exposed by Claude Code on Windows**. The repo already said so in one line nobody was reading —
`deploy/install.sh`: *"Native cross-session messaging (and this daemon) run on macOS + Linux/WSL2
only."*

### SETTLED ON THE SURFACE THE SYSTEM ACTUALLY USES — same CLI version, opposite result

The question was re-asked correctly and answered. This project never calls peer messaging from a
model's tools; the wake tier spawns `claude -p … --allowedTools ListAgents SendMessage`. So both
machines ran **that** invocation and asked the spawned one-shot what it has.

| | macOS | Windows |
|---|---|---|
| `claude --version` | **2.1.226** | **2.1.226** |
| `ListAgents` inside the spawned one-shot | **"ListAgents is available."** | **"ListAgents: not available."** |
| rung-2 relay outcome | reaches the target | `{"success":false,"message":"No agent named 'lulu' is reachable…"}` |

**Identical version, different platform, different tool set. That is a measured platform boundary,
not an inference.** The Windows failure is byte-identical whether the call is made from a session or
from the spawned one-shot, and it fails for a *local* target — so it is not about hosts, names, or
case. There is no peer lookup to mis-key: **the verb is absent, so nothing is ever matched.**

**Consequences, and the second one is a live defect:**

1. **On Windows only rungs 3 (notify) and 4 (store) exist.** Rung 1 is unavailable too — `--channels`
   does not appear in `claude --help` on that build. This is exactly what the operator experiences:
   nothing ever starts a turn there, and mail waits for a hand-typed `check_inbox`.
2. **`--allowedTools` granting a nonexistent tool is a SILENT NO-OP.** The relay spawn therefore
   *succeeds*, the peer lookup never happens, and the send fails into the subagent address space —
   so rung 2 on Windows returns `dispatched` **every time, forever, having delivered nothing.** That
   is the dispatched-is-not-delivered failure mode this repo documented on 2026-08-10, except here
   it is not a risk but a certainty. **FIXED 2026-08-11** — `peerVerbsAvailable()` in
   `bin/handoff-wake.js` gates rung 2 *before* the spawn and degrades to notify naming the reason,
   because a spawn that cannot deliver still costs a process and still reports `dispatched`: the
   report was the harm, not the spawn. The capability is READ from
   `$HANDOFF_HOME/wake-capabilities.json`, never probed inline (a probe costs a model spawn per
   send), and the default when unrecorded is per-platform rather than optimistic — an optimistic
   default would reproduce the forever-lie on every un-probed Windows machine.

**The 25s median in the table above therefore stands as relay-attributed** — the rung is real, on
this platform, at this version.

**HOW THIS WAS GOT WRONG TWICE, kept because the route matters.** First conclusion: "`@peer` will
never work on Windows" — right substance, wrong evidence, drawn from the model's session surface,
which is not the surface used. Retracted. Second: the retraction implied the spawn path might
differ; it does differ, and measuring it produced the same verdict on ground that supports it.
**The correction was still correct as method** — the first version was true by luck, and a
conclusion that is true by luck fails the next time it is reused.

**This project never calls peer messaging from a model's tools.** The wake tier spawns the CLI:

```
claude -p "<wake line>" --allowedTools ListAgents SendMessage --output-format text
```

`bin/handoff-wake.js` states the rule outright — *"the relay invokes the `claude` CLI as a product
and lets native's own SendMessage/ListAgents carry the frame. We never hand-roll native's private,
peerProtocol-versioned wire."* A **spawned one-shot is a different process with an explicitly
granted tool set**, and nothing measured so far says anything about what it can see on Windows.

**CLOSED 2026-08-11 — this section used to end by calling Windows peer delivery UNKNOWN and
proposing the very probe the section above had already run.** Two paragraphs of this file
contradicted each other for a day. The question is settled three ways and none of them is an
inference:

- **Re-measured on the peer, 2026-08-11**, in a spawned one-shot at CLI 2.1.226:
  `ListAgents: ABSENT`, `SendMessage: PRESENT`. Forced to a binary answer, so it is a denial and
  not an omission.
- **Documented by the product.** <https://code.claude.com/docs/en/cross-session-messaging>:
  *"available on macOS and Linux, including Linux inside WSL 2. Claude Code doesn't offer
  cross-session messaging on native Windows."* Requires v2.1.224+; the peer is past that floor, so
  it was never a version question.
- **`CLAUDE_CODE_MESSAGING_SOCKET` is unset on the peer and set on the Mac** (`/tmp/cc-socks/…`).
  Claude Code exports it to hooks and Bash commands for every session that binds an inbox socket,
  so its absence is direct evidence the session binds none. This is a cheaper check than either
  probe above and should be the first one anybody runs.

**`SendMessage: PRESENT` on Windows is a trap, and it cost a retraction.** The same tool also
serves subagents and agent-team teammates, so it is present on every platform regardless of
cross-session messaging. **`ListAgents` is the only honest signal.**

**The two loose ends from the old text, both dead.** `peerProtocol: 1` with no published address is
consistent with the verb being absent, not with a hidden wire. And the `\\.\pipe\` sweep that was
supposed to find a Windows equivalent of `/tmp/cc-socks/` was the wrong shape: the inbox is a **unix
domain socket** (`/status` shows it as `uds:…` in a `Peer address` row), so no named pipe was ever
going to appear. 231 pipes, zero matches — and the one apparent hit was `97CC-4F39` inside a GUID
matching a `cc-` filter.

**The naming hazard is real but does not apply here.** That machine reports three identities —
`COMPUTERNAME=PEER_LAPTOP`, `os.hostname()=Peer_laptop`, and the doc's `windows-laptop` — and anything
matching by string equality can split it in half silently. It cannot explain a negative peer result,
though: **the verb is absent, so no lookup runs and there is no name to mis-key.** Keep the hazard
in mind for host matching (see `DEBUG-LOG` M2), not for peer discovery.

**AND THE EXPENSIVE CORRECTION, which is why this section was rewritten rather than trimmed.** From
this evidence the fleet concluded *"peer messaging cannot work on any OS"* and designed around it
for a day. **That is false** — `DEBUG-LOG` D15. Measured on the Mac 2026-08-11:
`CLAUDE_CODE_MESSAGING_SOCKET` set and `ListAgents` returning **seven reachable peer sessions**,
with no store in the path. Native delivery is available on the macOS/Linux lane today. **Windows is
the exception; we generalised it into a law.** Use native where `ListAgents` lists the target, the
store where it does not, and the store as the only route to the laptop.

## code → code — cross-machine · **UNVERIFIED**

**How it travels:** the store is the carrier. A remote machine reaches it through the relay (tier 2)
with an Access credential, scoped to `peek_inbox`, `send_message` and `agent_heartbeat`.

**How the receiver would learn:** a wake agent running **on that machine** — the only thing that can
deliver locally. `bin/handoff-wake-agent.js` exists and runs; its **delivery half is deferred in a
comment** and the service form has never been executed. See `REMOTE-PEER-SETUP.md`.

**What is NOT possible today:** initiating a turn on another device from here. Cross-machine
messaging is **reply-only** by platform design. The store carries the envelope; the far machine's own
agent is what turns it into a delivery.

**Status:** one remote record exists (`host: windows-laptop`) and reads `reachable: unknown` —
*nobody has ever looked*, which is the honest verdict and not a failure. The flip to a host-asserted
verdict is the acceptance test the laptop trip exists for.

## chat → chat

**How it travels:** store write; the receiving conversation drains with `check_inbox`.

**Latency:** median **53s** over 3 messages — a small sample, and it reflects an attentive human
rather than a mechanism.

**Drain scoping caveat, measured:** `check_inbox` currently drains by **surface, not by record** — a
message addressed to one seat surfaced in another's inbox on this surface. Ruled a defect; the fix
is default-to-own-record with surface-wide drain as an explicit opt-in.

## chat ↔ cowork · code ↔ cowork — pull only

**Measured:** `cowork → code` 4 messages, 3 read, median **374s**. `code → cowork` **1 message,
never read.**

**How it works:** cowork participates through the handshake — `send_to` offers, `pick_up` claims.
There is **no wake for cowork**; arrival is by pull.

**What the t20 trial established, including its retraction:** a run was reported as an unattended
automatic pick-up and then **retracted** — the user had typed "pick up handoff" by hand. So the
autosend consent gate is **not** confirmed fixed, and pickup provenance on this pair should be
treated as human-initiated until something measures otherwise.

## → design · **UNVERIFIED**

**Measured:** 2 messages sent, **0 ever read.**

Delivery to design follows a proxy-close pattern rather than a direct one. Nothing here has been
exercised end to end, so this section deliberately stops rather than describing a mechanism from
its design notes.

---

## TWO AXES, NOT A LIST OF ROUTES — corrected 2026-08-11

This file's own first sentence already separates them — *"how a message travels, **how the receiver
learns of it**"* — and the fleet spent an evening collapsing them anyway. Written down so the next
reader does not.

```
CARRIER   how it TRAVELS          store | native peer        ← the SENDER chooses
WAKE      how the receiver        channel | relay | notify | watcher-exit | none
          LEARNS of it                                        ← the RECEIVER's machine determines;
                                                                the sender only ATTEMPTS
```

**The store write is unconditional and happens FIRST, on every route, to every target class.**
`bin/handoff-transport.js:81` — *"Always the durable truth, written by the CALLER before any leg
runs"* — and `bin/handoff-wake.js:631`, *"A wake failure must never break the send."* Nothing below
is permitted to make that write conditional.

**Native peer messaging is a WAKE choice, never a CARRIER choice.** A route that "prefers native" by
*skipping the store* is data loss wearing an optimisation's clothes, for three measured reasons:

1. **The watcher watches the STORE and nothing else.** Peer/`bridge:` traffic produced **zero**
   store unread and never once fired a watcher; only a `send_message` that wrote the store did.
   Skipping the write makes mail invisible to every watching seat.
2. **A socket is not a carrier of record.** A reply to a peer's `uds:…/cc-socks/1378.sock` failed
   `connect ENOENT … socket path is stale` **seconds** after that peer sent from it, and a named
   peer vanished from `ListAgents` within a minute.
3. **Read state and provenance live in the store.** Native sends carry no `✓✓` and no attribution
   back.

### Three corrections this matrix used to get wrong

1. **Windows cannot SEND by peer either.** The one observed Windows→peer send worked only because
   that seat spawned a **WSL one-shot to carry it** — borrowing a neighbouring environment, and
   available only on a Windows machine that *has* WSL. Do not record it as a Windows capability.
   Relay attribution belongs to the relay; letter provenance belongs to whoever wrote the mail.
2. **The watcher is not a carrier.** See (1) above — a sender who thinks it is "using the watcher"
   by sending peer-style delivers nothing any watcher can find. **This is the one that silently
   sends mail nowhere.**
3. **The OS is the WRONG AXIS.** Two seats on one machine can use a socket; two seats on different
   machines cannot, whatever they run — this Mac reached a WSL seat across machines by `bridge`,
   not by socket. The real divide is **(same machine or not) × (what the receiver can do)**. The
   OS-shaped rule survives in exactly one clause, and it is the finding: **native Windows is the
   only seat with no push at all, so the watcher is its whole wake.**

### Wake by what the RECEIVER can do

| receiving seat | can be woken by | evidence |
|---|---|---|
| same machine, socket present (Linux / macOS / WSL 2) | **peer (uds)** | 10 sockets in `/tmp/cc-socks/`, `ListAgents` returned 7 reachable sessions |
| another machine, reachable by Remote Control | **bridge** | Mac ↔ WSL 2 laptop, bidirectional, no store/relay/tunnel in that path |
| native Windows | **watcher**, or notify | watcher proved live: a turn started with no human touching the terminal |
| any seat with a watcher armed | **watcher** | same, and it is platform-independent by construction |

**A sender can never CHOOSE watcher-exit and must never REPORT it.** The watcher is armed by the
receiving seat, on its own machine, on its own initiative; a ladder returning `tier:'watcher'` would
claim a delivery it did not perform. What a sender may say is unchanged: it wrote the store durably,
it attempted the legs available to it, and it makes **no** claim that a turn started.

**Still UNVERIFIED, and this file's rule is to say so rather than describe something plausible:**
native Windows → Mac direct; the native-Windows seat → this Mac pair; and the `era` gate that
refuses unsolicited notifications on a modern protocol revision regardless of capability. Mark them;
do not fill them.

---

## The honest summary

- **One surface can be woken: code.** Everything else is pull, and that is a property of the
  platform rather than a gap in this system.
- **The store always works.** Every pair above is durable at the moment of the write; the rungs only
  decide *how soon someone finds out*.
- **A dispatch is not a delivery, and an op is not evidence.** The layer that reports success is
  never the layer that proves it — corroborate with spawn-side evidence, or with the arrival.
- **Where this document says UNVERIFIED, believe it.** Three pairs have never had a message read on
  them, and no amount of coherent prose changes that.

**Test coverage pointers:** the rung ladder, the seam refusal and the spawn-side evidence channel
are covered in the wake suite; the eight delivery sentences are snapshotted byte-identical in the
MCP suite. The cross-machine and design pairs have **no tests**, because they have no verified
behaviour to test yet.
