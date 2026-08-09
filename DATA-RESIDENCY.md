# What lives where

Plain-language map of every place your data sits or passes through. This is both the privacy
argument for the design and the honest disclosure of its limits.

## The short version

**Your conversations never leave your machine.** The store is plain files in
`~/.claude-handoff/` on your own computer. There is no hosted database, no account with us,
and no copy anywhere else. Remote access does not move the data — it opens a door to it.

## The map

| Where | What is there | Who can read it |
|---|---|---|
| `~/.claude-handoff/store/v1/` on your machine | The store: summaries, locked decisions, open items, artifacts, message history | You, and processes running as you |
| `~/.claude-handoff/daemon.sock` | Unix socket the local tools talk to | You (filesystem permissions) |
| The relay process (tier 2 only) | Nothing. It holds no store and no session state — it forwards and forgets | — |
| The tunnel (tier 2 only) | Encrypted transport between your machine and the CDN edge | Nobody in between; see the caveat below |
| Your identity provider (tier 2 only) | That *you* signed in, and when | You and your identity provider |
| Claude | Whatever a tool call returns, exactly as any MCP connector would | You and Claude, per your Claude account's terms |

## Tier by tier

**Tier 1 — local only (the default).** Claude Code talks to the MCP server over stdio on your
machine. No network, no tunnel, no account, no third party. Nothing to configure and nothing
to trust: the data never touches a network interface.

**Tier 2 — remote (opt in).** You add a tunnel so your *other* devices can reach the same
store. The store still lives only on the home machine. A request from your phone travels:
phone → Claude → the CDN edge → the tunnel → the relay on your Mac → the store. The reply
comes back the same way. Nothing is cached at any hop.

**Tier 3 — hosted.** Not built, and not by us. A hosted model would mean someone else's
machine holding your conversations, which contradicts the reason this exists.

## The caveats, stated rather than buried

- **The tunnel provider terminates TLS at its edge.** That is how any CDN-fronted service
  works. Your traffic is encrypted from your device to the edge and from the edge to your
  machine, but the edge is a hop that could in principle observe it. If that is unacceptable
  for your data, stay on tier 1 — which is exactly why tier 1 is the default.
- **Your identity provider sees your logins**, not your data.
- **Claude sees tool results.** That is what a connector is. It sees what you ask it to fetch,
  the same as any other MCP server you connect.
- **The store is not encrypted at rest** beyond your filesystem's own protections. Anyone with
  read access to your user account can read it. Treat `~/.claude-handoff/` as you treat your
  notes.
- **Artifacts travel by value.** If you hand a file to another conversation, its *contents*
  move through the path above. That is deliberate — a reference the other side cannot read is
  worse than useless — but it means the file is in the payload, not just its name.

## What is never sent

- No telemetry, no analytics, no crash reporting, no phone-home of any kind.
- No secret *values* in envelopes. The protocol carries that a `.env` changed and which keys
  moved; it refuses to carry the values themselves.
