# Security

## Reporting a vulnerability

Open a **private** security advisory on this repository
(Security → Advisories → Report a vulnerability). Please do not open a public issue for
anything exploitable.

Include what you did, what happened, and what you expected. A proof of concept helps but is
not required — a clear description of the reasoning is enough to start.

## What this software holds

**Your conversation data.** The store keeps summaries, locked decisions, open items and
artifacts from your Claude conversations, in plain files under `~/.claude-handoff/` on your
own machine. It is not encrypted at rest beyond your filesystem's own protections. Treat that
directory as you would treat your notes.

Nothing is uploaded anywhere by this software. See `DATA-RESIDENCY.md` for the full map.

## The security model, in one paragraph

Tier 1 (local) has no network surface at all: the MCP server speaks stdio to Claude Code on
the same machine, and the daemon listens on a unix socket with filesystem permissions.

Tier 2 (remote) adds exactly one door, and it is closed by default:

- The relay binds `127.0.0.1` only. A tunnel is the sole route in — no inbound firewall hole.
- The relay **fails closed**: with no authorization server configured it refuses every
  request, with or without a token. Absence of configuration is never permission.
- Every request must carry a JWT that verifies against the configured JWKS, with matching
  issuer and audience. Asymmetric algorithms only — `alg:none` and HMAC algorithms are
  refused outright, before any key lookup.
- Tokens are audience-bound, so a token minted for another service cannot open this one.
- The tunnel's ingress is path-scoped: only the endpoints that exist are routed.

## Known limitations, stated plainly

- **Audience binding is keyed to the authorization server's application identifier**, not to
  an RFC 8707 resource indicator, because the reference deployment's authorization server does
  not consume `resource`. Confinement is preserved (a token for another application is
  rejected); what is given up is distinguishing two different resources behind the *same*
  authorization server. Each self-hosted install is a single tenant, so there is nothing to
  distinguish. If you place a second resource behind one authorization server, revisit this.
- **No read cache.** If the home machine is offline, remote reads fail with an explicit
  `home-offline` error rather than serving stale data.
- The relay is young. It is covered by tests that assert refusals rather than features, but it
  has not been through third-party review.
