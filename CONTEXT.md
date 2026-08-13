# Handoff

Carry a conversation between seats — Claude or Grok, chat or code — without losing what it knew: summary, decisions, open items, and artifacts, on a self-hosted store.

## Language

**Handoff**:
A handshake that offers work from one conversation to another. States: offered → picked up | declined | withdrawn. Once shaken, it is not re-offered.
_Avoid_: transfer, ticket, task handoff (when meaning the protocol transaction)

**Envelope**:
The context payload a handoff carries: summary, locked decisions, open items, and artifacts by value.
_Avoid_: package, payload, brief (except as the short form shown after pick_up)

**Store**:
The self-hosted file directory that holds session records and mail. Conversation data lives only here; the relay holds none of it.
_Avoid_: database, backend, cloud

**Seat**:
A running conversation that has, or will have, a session record. Several seats may share one client (one device, or one surface).
_Avoid_: agent (when meaning the conversation), client (when meaning this conversation), project, workspace, folder

**Project**:
The folder path a seat is working in. It is not a name in the store. Opening a path does not make a conversation that path's previous nickname.
_Avoid_: name, title, seat, workspace (when meaning the path)

**Session record**:
The stored seat. Its id **is** the session uuid.
_Avoid_: chat, thread, conversation (when meaning the store record); agent (when meaning the record)

**Session uuid**:
`sess_<surface>_<client-uuid>`. Prefix is kind + surface. Suffix is that product’s conversation id (Claude CLI uuid, Grok session id, Gemini’s id). Mint a suffix only when the surface has no natural id (chat).
_Avoid_: a second store-minted id beside the product id, install id

**Install id**:
The product install, not the conversation (Grok `~/.grok/agent_id`). Optional. Logs only. Never a session uuid, never a drain key.
_Avoid_: session uuid

**Client**:
A device or surface type that uses the server (the home store + daemon). Devices and surfaces are both clients. Each holds seats.
_Avoid_: seat, subscription, connector, peer (peer is coding agents only)

**Peer**:
A coding agent only — a code seat that uses the Claude Code channel (`ListAgents` / `SendMessage`). Not a chat, not Grok, not “any remote process.”
_Avoid_: client, host, seat (when the seat is not a coding agent)

**Name**:
The session’s one-word nickname. Collisions list every match; never guess. A chat is named by the user typing `Start onboarding for <name>` (or `/onboard <name>`); that word is title and nickname in one `register_session`. Code still uses `/name`.
_Avoid_: title (alone), project, folder, workspace

**Title**:
The protocol name on a session record, set at creation and used by resolvers (`resolve_conversation`, `send_to`, `send_message`). It does not automatically follow app or terminal renames.
_Avoid_: name (alone), label, nickname

**Native ref**:
A live binding from a session record to a Claude Code registry session (`name`, `session_id`, cwd, host). Process-scoped; null until the owning host's agent claims it. Resolvers match `native_ref.name` as well as title.
_Avoid_: resume id (alone), CLI uuid (as the protocol identity)

**From-label**:
Free-text sender string on a message. Observational only — nothing resolves against it.
_Avoid_: identity, title, name

**Subscription**:
The product account a seat is running as (`grok`, `cursor`, `claude`). Asserted at enrolment. Not the title, not the lane (`role`), not a drain key.
_Avoid_: vendor (alone), role, plan name

**Model slug**:
The model serving that seat right now (`grok-4.6`). Asserted, refreshable. Spaces refused. A model switch updates the same record.
_Avoid_: model name (marketing string with spaces), version (alone)

**Surface**:
Where a seat runs. Known today: chat, cowork, design, code. The set is open — add a surface when it is measured.
_Avoid_: app, channel (except message channels), closed enum

**Origin**:
The session that offered a handoff or opened a return link.
_Avoid_: source, sender (when meaning the session)

**Return link**:
An owed path for a destination to send a result back to the origin (`return_to_origin` / `expected_return`).
_Avoid_: callback, reply thread

**Dispatch**:
A measured attempt to route or queue work. Not a claim that anyone received it.
_Avoid_: delivery, send success

**Delivery**:
Content held until the destination checks inbox or is woken into a turn. Distinct from dispatch.
_Avoid_: push, instant message

**Reachability**:
Host-asserted verdict for a record: `process` | `stale-binding` | `none` | `unknown`. `unknown` means nobody looked recently; it is not `none`.
_Avoid_: online, available, alive

**Home machine**:
The machine that owns the store. Remote access opens a door to it; if it is unreachable, calls fail with `home-offline` rather than serving stale data.
**"home device" is an accepted synonym and is the preferred wording in USER-FACING copy** — it is what `95a7ae3` replaced "the Mac" with, since the store's host need not be a Mac. Use *home machine* in code, comments and internal docs; use *home device* in README, INSTALL, security and setup prose. Both name the same thing; neither is a second concept.
_Avoid_: server, backend host, the Mac

**Relay**:
Tier-2 process that forwards authorized requests to the home store and forgets them. Binds locally; a tunnel is the only ingress.
_Avoid_: API gateway, proxy (alone), server

**Daemon**:
The single process that owns the protocol on the home machine: sole store access, one control socket it owns at mode 0600, and every tool call served through it. Per-session bridges are pure forwarders over that socket. There is exactly one, and its single-writer position is what the store's invariants rest on.
_Avoid_: server, service, background process, wake agent

**Wake agent**:
Per-machine process that watches the store for mail addressed to this host, delivers it locally, and writes that host's reachability verdicts. **Distinct from the Daemon and not a second one**: the daemon owns the store and runs on the home machine only; a wake agent owns nothing, runs on every machine including ones with no store, and reaches the store through the relay when it is remote. Collapsing the two is the synonym error to watch for — they differ in what they own, where they run, and what fails when they stop.
_Avoid_: daemon (when meaning this monitor), watcher, notifier

**Hint**:
A process-scoped address (pid, socket path, transcript id) validated against the live registry at use time. Never persisted or cached as identity.
_Avoid_: id, pointer, cached address

**Artifact**:
File contents carried in an envelope or return by value so a surface without a shared filesystem can still receive them.
_Avoid_: attachment, reference, path-only link
