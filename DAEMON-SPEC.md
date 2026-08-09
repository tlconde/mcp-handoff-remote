# Daemon spec — one process owns the protocol; bridges become forwarders

**Status: DESIGN, not built.** Decided 2026-08-08 (the user). Supersedes the frozen-bridge +
hot-reload model. Governed by the NATIVE-FIRST and BROADLY-USED-ONLY rules and the
minimalism line in `LINKED-THREADS-SPEC.md`.

## The problem this ends

The bridge froze `mcp-handoff.js` at process start and hot-reloaded `handoff-core.js`.
Every app conversation and every terminal spawned its own bridge, so:
- a code edit left N processes running old bridge code (stale-bridge banner, refuse-to-mutate);
- bridges accumulated — t26 §(e) counted **6 live `mcp-handoff.js` processes on one store**;
- a crashing bridge left an existing conversation timing out for minutes (2026-08-08).

Hot-reload patched a symptom. The disease is N processes each holding logic and store access.

## Target shape — mirrors native

```
  Code session ─┐
  Chat bridge  ─┤   one Unix socket    ┌─────────────────────────────┐
  Cowork bridge├──────────────────────▶│   handoff-daemon (launchd)  │
  Design bridge┘   forwarder→daemon    │  • all logic (handoff-core) │
                                       │  • sole store/v1 writer     │
  native /tmp/cc-socks/<pid>.sock ◀────│  • watchers                 │
     (last-mile delivery into Code)    │  • last-mile socket poster  │
                                       └─────────────────────────────┘
```

**ONE process** (`handoff-daemon`, a LaunchAgent). It owns *all* logic (the current
`handoff-core.js`, unchanged), *all* store access (sole writer to `store/v1/`), the
watchers, and the **wake mechanism** (see below).

**ONE socket** we own: the daemon's control socket at `$HANDOFF_HOME/daemon.sock` (mode
`0600`). Every bridge connects to it.

**WAKE MECHANISM — NOT native socket posting (decided 2026-08-08).**
An idle Code session cannot be woken by us: native exposes no send path, and posting into
its `/tmp/cc-socks/<pid>.sock` means hand-rolling an undocumented, `peerProtocol`-versioned
private wire — a violation of BROADLY-USED-ONLY and the dependency rule (t26 §wire). So the
daemon does NOT post native frames. Instead it emits a "mail landed for [conversation]"
event; a relay spawn carries it where the target is open. There is NO notification rung:
it was removed 2026-08-09 (see bin/handoff-wake.js). Everything degrades to
the user. Her next turn in that conversation drains it: check THIS conversation's mail first,
surface one "while you were away" line, then answer. Live Code↔Code delivery stays with
native `SendMessage` in the refactor, where a real MCP session exists.

**NO new storage.** The store stays `store/v1/` plain files. The daemon adds no database,
no cache file, no second store. State that was implicit in "which bridge is current" stops
existing because there is only one writer.

**Bridges become pure forwarders.** A bridge holds no logic and no state: it reads a
JSON-RPC tool call from Claude Code over stdio, wraps it with a contract version and the
caller's identity, sends it to `daemon.sock`, and streams the reply back. That is all. A
forwarder that dies loses nothing; a new one connects and the daemon is unchanged.

### Why this satisfies the constraints
- **Update = restart one process.** Editing core restarts the daemon; forwarders reconnect
  on their next call. Zero session restarts, no per-conversation stale banner.
- **Orphans become impossible.** Forwarders hold nothing, so a leftover forwarder is inert —
  it either reconnects to the live daemon or exits. There is no "old logic still running".
- **The daemon had to exist anyway (t26).** It is the non-child local poster for last-mile
  delivery. Its posts deliver to prompting Code sessions and are held by bypass sessions —
  documented behavior (t26 §(d)), enforced with native's own peer-credential pair.

## Peer verification (BROADLY-USED-ONLY)

Last-mile delivery posts into a native session socket as a non-child process. Where the
daemon needs to verify a socket peer, it uses **native's exact per-platform pair**:
`getpeereid` on macOS, `SO_PEERCRED` on Linux. No portable-looking wrapper, no third choice.
Support matrix copied from native: **macOS + Linux (incl. WSL 2); native Windows excluded.**
`getpeereid` is macOS/BSD-only and must never be called on the Linux path.

## Acceptance tests (the frozen-bridge gaps, turned into checks)

- **(a) Contract version on every call.** Each forwarder→daemon call carries a contract
  version. On mismatch the daemon refuses **loud** and the forwarder **exits** (so Claude
  Code respawns a matching one). Test: a forwarder pinned to an old contract gets a clear
  refusal and exits non-zero; no silent version drift.
- **(b) Load-safety.** The daemon writes atomically (temp + rename) and loads every record
  in `try/catch` with a **last-good fallback**. A broken hand-edit to one record degrades to
  last-good for that record and logs it — it never crashes the daemon. Test: corrupt one
  `store/v1/sessions/*.json`, assert the daemon stays up and every other record is intact.
- **(c) Exit-on-stale — over the WHOLE code surface** (widened 2026-08-09). The watch covers
  `handoff-daemon.js`, `handoff-core.js`, `handoff-tools.js` and `handoff-contract.js`, not just
  the daemon file. After slice 3b the daemon is the sole executor and requires core + tools once
  at boot without reloading, so watching only its own file left edits to the actual protocol
  logic invisible — found live: a daemon 37 minutes stale on core, reporting itself healthy.
  Staleness is "differs from the mtime loaded at boot", NOT "mtime > start": a future-dated file
  satisfies the latter forever and would put launchd in a restart loop. The refusal names the
  changed file. Deliberately not a hot-reload — swapping modules under in-flight requests is the
  mixed-version corruption (d) forbids.
  When the on-disk daemon build is newer than the running daemon, it
  **refuses, reports, and exits** so clients respawn — replacing "freeze and refuse to
  mutate". Test: the daemon exits on staleness AND app conversations actually respawn a
  working forwarder (today they sometimes time out — this is the specific regression to
  close, verified live, not assumed).
- **(d) Rollout smoke.** Edit core while **10 fake sessions** drive the daemon under load;
  assert **zero lost writes** and **zero mixed-version corruption** across the restart. This
  is the frozen-bridge's worst case (concurrent writers + a live edit) turned into a gate.

## What does NOT change
- `handoff-core.js` logic and the `store/v1/` layout are carried over as-is; the daemon is
  the single host for the same code, not a rewrite of it.
- The two-tier receipt model, the recap hook, and the loop-safety limits (built 2026-08-08)
  live inside the daemon unchanged.
- `check_inbox` stays the mechanism for chat/cowork/design targets; only Code↔Code delivery
  moves to native in the *refactor* that follows this daemon.

## Refactor progress (2026-08-08)
- **Slice 1 DONE** — identity convergence: the bridge reads `~/.claude/sessions/<pid>.json`
  and `native_ref` adopts native name + `messaging_socket_path`; native name is the display
  handle, explicit title is the alias. `mcp-smoke` +4.
- **Slice 2 DONE** — Code↔Code sends go native: `send_message` from a code terminal to a
  natively-reachable code session redirects to `ListAgents`+`SendMessage` and queues nothing;
  cross-surface and non-native targets keep the store path. `mcp-smoke` +2.
- **Slice 3a DONE** — the daemon owns a ctx-threaded tool layer, isolation proven. `handoff-tools.js`
  reads only `ctx` ({pinned, cli_uuid, cwd}) and `core`, holds no per-session state; the daemon
  exposes a `tools/call` request kind that runs it with the forwarded ctx + verified door stamp.
  Migrated the PIN-DEPENDENT tools (`get_handoff`, `get_decisions`) — the only ones where a
  shared-process cross-read is possible. **`daemon-smoke` +6: two concurrent callers with different
  pins never cross-read; unpinned+unnamed fails loud (I2); name beats pin; unmigrated tool refused
  honestly.** The live bridge (`mcp-handoff.js`) is UNTOUCHED — no cutover yet, so the running
  protocol is unaffected.
- **Deploy gate DONE** — launchd (KeepAlive) + systemd-user (Restart=always) units + `install.sh`
  in `deploy/` (the user's lifecycle lock; not socket activation). This clears slice 3b's gate: the
  cutover no longer risks the live protocol once the daemon is installed.
- **Slice 3b-1 DONE** — the live bridge now DELEGATES the migrated tools (`get_handoff`,
  `get_decisions`) to `handoff-tools.js` instead of keeping its own copy (removing the 3a
  duplication). One implementation serves both the in-process bridge (ctx from its own
  CLI-uuid + pin + cwd) and the daemon's `tools/call` (ctx from the forwarded request). I11
  "fail loud when unpinned+unnamed" is preserved through the shared module. `mcp-smoke`
  158/158. This is the delegation pattern the rest of the migration repeats.
- **Slice 3b DONE (2026-08-08)** — the tool migration is COMPLETE. Every tool is served by
  `handoff-tools.js`; `mcp-handoff.js` went 2014 → 623 lines and its `callTool` is now a single
  block: build ctx from state only that process has, call the shared layer, apply the write-back.
  Landed in reviewed sub-steps — 3b-4 display-helper chain, 3b-5 pin WRITERS (`pick_up`,
  `continue_from`), 3b-6 the CLOSE / pin clearer, 3b-7 `send_message` + `resolve_conversation` +
  the identity substrate, 3b-8 `send_to`/`send_to_surface` (the latter demoted 2026-08-09 — unadvertised, still dispatched) + the send guards, 3b-9
  `status`/`buildStatusReport`, 3b-10 the remaining tools + `register_session`.
  **Contract 2 → 3**: `ctx_update` gained `identity` beside `pinned`, because `register_session`
  resolves the caller's OWN record and a pure forwarder must be able to learn it (otherwise its
  next `status` says "not yet registered" straight after registering). `daemon-smoke` 31 → 62,
  `mcp-smoke` 161 → 165.
  **Two things stay caller-side BY DESIGN, not by omission:** `stale` (whether the code serving
  *this* caller is out of date is a question about the calling process — a forwarder passes
  false, since a daemon reports staleness by refusing with the fatal `daemon_stale` envelope),
  and the small per-session cache of `PINNED` / `IDENTITY`, which the spec always allowed a
  forwarder to hold.
- **THE FLIP IS DONE (2026-08-09).** `mcp-handoff.js` runs as a pure forwarder for this project:
  `HANDOFF_FORWARDER=1` is set on the project-scoped MCP entry, the daemon is installed under
  launchd (KeepAlive, verified: `launchctl kickstart -k` replaces the process and the socket
  rebinds, and the runbook passes against the restarted one), and `forwarder-runbook.js` — the
  gate the spec demanded — passes 9/9 driving a REAL bridge against the INSTALLED daemon over
  real MCP stdio. Suites: mcp-smoke 165, daemon-smoke 62, forwarder-smoke 10, runbook 9.
  **Three defects were found by running it, not by review** — the reason the runbook was a gate
  and not a formality:
  1. `forwardToDaemon`'s 8s deadline was never cleared, so the timer kept the event loop alive
     and the forwarder lingered 8s after answering (response 31ms, exit 8034ms → exit 37ms).
  2. `status` contradicted itself post-flip — the forwarder omitted `stale` from ctx, so the
     body said "✓ current" while the banner said "⚠ STALE BRIDGE", in one response. `stale` is
     always about the CALLING process, so it travels in ctx in both modes.
  3. The stale REMEDY still prescribed quit-app + `pkill` every bridge — the exact dance the
     flip retires, and useless besides, since the daemon serves the tools and is untouched by
     editing the forwarder. Forwarder mode now says so; the in-process path keeps the old text.
  Also fixed: `daemon-smoke` leaked spawned daemons (four orphans found live, from both failing
  and passing runs) — it now reaps every child on exit, throw and signal.
  **Rollback** is one line: drop `HANDOFF_FORWARDER` from the MCP entry and reconnect; the
  in-process path is unchanged and still fully tested.
- **The former flip point — what it required (kept for the record).** The tool
  logic no longer blocks it; the cutover is now a swap of how ctx and the reply TRAVEL
  (in-process call → one socket round-trip). Still required, and NOT done here:
  (1) dial `daemon.sock` instead of calling `handoff-tools` in-process, handling
  `contract_mismatch`/`daemon_stale` by exiting for respawn;
  (2) the **runbook pass** the spec has always gated the flip on — acceptance test (c) verified
  LIVE (app conversations actually respawn a working forwarder rather than timing out), plus
  (d) under load;
  (3) install the daemon via `deploy/` so there is something to dial.
  Until (1)–(3), the bridge remains the working path and the daemon runs additively.
- **Slice 3b (superseded — kept for the record)** — migrate the remaining tools into `handoff-tools.js` the same
  way (each with its helper deps: `api`→`core.handleApi`, `formatSessionCandidates`,
  `localCodeSessions`, the `assert*` guards, `buildStatusReport`), then cut `mcp-handoff.js`
  over from in-process bridge to pure forwarder (dialing `daemon.sock`). The
  wake path folds in here as **four tiers** (t28 amendment): channel-inject if `--channels` →
  **`-p` relay (proven, cheapest model, ListAgents-confirm, one-line wake, no retries)** → notify
  the user if closed → store always durable. The relay is the **wake-tier parallel session's**
  `bin/handoff-wake.js` — slice 3b `require`s it at the send site; do NOT reimplement it, and do
  NOT edit `bin/handoff-wake.js`/`wake-smoke.js` (theirs), as they will not edit
  mcp-handoff/core/daemon/contract (mine). **Notifications are PERMANENT** — the wake tier only
  changes their meaning (informational, not to-do), never removes them.
- **Board / @-picker presence (record for later):** native maintains LIVE presence in
  `~/.claude/sessions/<pid>.json` — `"status"` (idle/busy) + `statusUpdatedAt`, continuously
  updated. The board and @ picker read busy/idle/age from native's own bookkeeping instead of
  probing. Free presence, NATIVE-FIRST.

### Slice 3 design — the forwarder swap, and its one hard problem
Target: `mcp-handoff.js` shrinks to a **pure forwarder** (MCP stdio in → one daemon socket
→ reply out); the daemon owns the tool logic (the `callTool` switch), not just `/api`.

**The crux: per-session state cannot move to a shared process.** Today the tool handlers
read module-level state that is *per terminal* — `NATIVE_ID` (from `CLAUDE_CODE_SESSION_ID`
in that terminal's env) and `PINNED` (set by `pick_up`/`continue_from` in that terminal).
The daemon is ONE process serving MANY sessions, so it cannot hold these as globals. They
**must travel in every forwarded request** as a per-session context the forwarder owns:
`{ cli_uuid, pinned, cwd }` — the `identity` field the door already carries is the start;
`pinned` must join it, and the forwarder must persist its own `PINNED` across calls (a small
per-forwarder in-memory value, the ONE piece of state a forwarder keeps — it holds no store
state, so the "forwarders hold nothing" rule stays true for durable data).

**Sequence:** (a) extract the `callTool` switch into a module the daemon requires, taking an
explicit `ctx = {cli_uuid, pinned, cwd}` instead of reading globals; (b) daemon exposes a
`tools/call` request kind that runs it with the forwarded ctx and the verified identity
stamp; (c) `mcp-handoff.js` becomes the forwarder: keep the MCP stdio + schema surface,
resolve its own ctx (env uuid + native registration + local PINNED), forward each call,
handle `contract_mismatch`/`daemon_stale` by exiting for respawn; (d) launchd/systemd unit
files; (e) `daemon-smoke` gains a tools/call round-trip and a two-forwarder isolation test
(two forwarders with different pins never cross-read — the shared-process regression guard).

**Risk:** this rewrites the live bridge; do it as its own reviewed pass, not a rushed tail.
Until it lands, the daemon runs additively and the current bridge stays the working path.

## Review gate (minimalism, held explicitly)
Reject the design if it comes back with **more than one process, more than one socket we
own, or any new storage.** The daemon is the last piece of infrastructure; everything after
it (chat identity, the thread board, modes) is product. Extra plumbing here is a regression.

## Build status (2026-08-08)
`handoff-daemon.js` + `handoff-contract.js` built; `daemon-smoke.js` green (13/13, a–d).
Lifecycle LOCKED by the user: launchd `KeepAlive` on macOS, systemd **user** service on
Linux — not socket activation ("boring wins"). Framing LOCKED: newline-delimited JSON-RPC.
Contract source of truth: `handoff-contract.js` `CONTRACT` (now **v3**), imported by daemon and
every forwarder. Still DESIGN-only: the forwarder swap (bridges → thin forwarders) and the
launchd/systemd unit files are the *refactor*, not built here — the daemon runs additively
alongside the current bridge until then.

## VERIFY-AT-THE-DOOR — RESOLVED (decision (i) + registry cross-check, 2026-08-08, the user)
Peer-cred calls (`getpeereid`/`SO_PEERCRED`) only prove "same OS user" and add a *pid*; the
`0600` socket already proves same OS user (kernel-enforced at open), and pid is not identity
in our model — the CLI uuid is. Native itself uses peer creds only to tell own-child from
other, a distinction the daemon does not need (it has no children posting to it). So we take
**(i): the 0600 socket is the boundary**, no non-stdlib primitive — satisfying BROADLY-USED-ONLY.

**Hardening (free, no new primitive):** a forwarder's *declared* `cli_uuid` is cross-checked
against native's own registry (`~/.claude/sessions/*.json`). Stamp reads **`verified`** only
when that uuid exists there **with a matching cwd**; a uuid native does not know, or a cwd
mismatch, is stamped **`asserted`**; no uuid is **`anonymous`**. A lying forwarder is caught
by a file read. Built as `verifyIdentity()` in `handoff-daemon.js`; the stamp rides the
response envelope (`res.identity`) so the refactor threads it into message provenance (I12).
Tests: `daemon-smoke.js` (door) 5/5. **Refactor unblocked.**
