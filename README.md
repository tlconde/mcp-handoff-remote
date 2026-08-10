# handoff-remote

Move a conversation between Claude surfaces without losing what it knew.

You are deep in a chat, and the work needs a terminal. Today you paste a summary and hope. The
next session starts cold, re-asks what you already decided, and quietly drops the constraint
that mattered. This carries the thread instead: the summary, the decisions *verbatim*, the open
items, the artifacts by value, and what would break on the other machine.

**Self-hosted.** The store is plain files on your own machine. No account with us, no hosted
database, no telemetry. Tier 1 touches no network at all; **tier 2 is opt-in and does send your
envelopes over a tunnel whose provider terminates TLS at its edge** — self-hosted storage, not
end-to-end encryption. See [DATA-RESIDENCY.md](DATA-RESIDENCY.md) for exactly what lives where and
which hops are trusted.

## Install

Start at tier 1 — no network surface at all:

```bash
git clone https://github.com/<you>/handoff-remote.git && cd handoff-remote
claude mcp add --scope user handoff -- node "$PWD/mcp-handoff.js"
```

Full guide, including remote access from your phone or a second laptop: [INSTALL.md](INSTALL.md).

## What it does

- **`send_to`** — one send verb. Route work to Chat, Cowork, Design or a Code terminal, as a
  new conversation or into an existing one, carrying the full envelope.
- **`check_inbox` / `pick_up`** — the receiving side. A handoff is a handshake: offered until
  claimed, and never re-offered once shaken.
- **Waking** — mail for an *open* terminal starts a turn there with no taps. If it cannot be
  reached, the message waits in the store and the reply says so — say anything in that
  window and it arrives on the next turn.
- **`whoami` / `/name`** — name a terminal in one word and address it by that name.
- **Returns** — a session can owe a result back, and the origin sees it arrive.

## Design, in three rules

**Never guess a target.** Ambiguity is surfaced, never resolved silently. Two sessions match a
name? You get both and pick. The whole class of "it went somewhere else" bugs is closed by
refusing rather than by heuristics.

**Process-scoped addresses are never persisted or cached.** A pid, a socket path, a transcript
id — anything whose meaning dies with a process — is a *hint*, validated against the live
registry at the moment of use. Seven bugs in this codebase were one instance of that mistake.

**Say only what was measured.** A dispatch is reported as a dispatch, not as a delivery. If the
home machine is offline, remote calls fail with `home-offline` rather than hanging or serving
stale data.

**About the tests.** This was developed against a test lab written as refusals rather than
features — the interesting behaviour of a door is what it turns away. That lab is not part of what
ships: it lives with the maintainer and in this repo's history, so **a clone of this repo cannot
run it**, and nothing here should be read as "these tests prove it" over tests you do not have.
What the doctrine above describes is how the code was built and what it was measured against, not
a proof surface handed to you with the package.

## Security

The relay **fails closed**: unconfigured, it refuses every request, with or without a token.
Tokens must verify against the configured JWKS with matching issuer and audience; asymmetric
algorithms only. The tunnel's ingress is path-scoped. Details and known limitations:
[SECURITY.md](SECURITY.md).

## Status

Working software, young. Tier 1 has been in daily use; tier 2 is new. It is MIT licensed and
self-hosted, so you can read every line that touches your data.
