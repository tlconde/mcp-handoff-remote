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

**The consequence for a Windows peer, plainly: `@peer` will never work there.** No amount of
configuration reaches a surface the platform does not expose. The store plus the relay is the
carrier, and the only way to *push* to a Windows peer is the wake agent running on that machine
delivering locally — which is why that slice, not a peer fix, is what ends manual `check_inbox`.

**One thing this does NOT settle:** whether a *human typing* `@peer` in the prompt is a different
affordance handled by the CLI before a model sees it. Every measurement above is of the model's tool
surface. `peerProtocol: 1` with no published address is consistent with a wire addressed by
something the registry does not expose. Testing that needs a human typing it on Windows.

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
