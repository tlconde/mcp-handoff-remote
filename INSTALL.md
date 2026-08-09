# Install

Three tiers. **Start at tier 1** — it is the default, it needs nothing but Node, and most
people never leave it. Tier 2 exists only if you want your *other* devices to reach the same
store.

Requirements: Node 18+, macOS or Linux. Zero npm dependencies — the whole thing is plain Node.

---

## Tier 1 — local only (start here)

No tunnel, no cloud account, no third party, no network surface at all. Claude Code talks to
the server over stdio on your own machine.

```bash
git clone https://github.com/<you>/handoff-remote.git
cd handoff-remote
claude mcp add --scope user handoff -- node "$PWD/mcp-handoff.js"
```

Check it:

```bash
claude
# then, in the session:
/mcp        # handoff should be listed and connected
```

That is the whole install. The store is created at `~/.claude-handoff/` on first use.

**Optional — the background daemon.** One process serving every terminal, so sessions can
reach each other and wake each other:

```bash
deploy/install.sh          # installs a launchd (macOS) or systemd (Linux) unit
```

Run the tests if you want to see it prove itself:

```bash
node mcp-smoke.js && node daemon-smoke.js && node wake-smoke.js
```

---

## Tier 2 — remote access from your other devices (opt in)

Adds one door so a phone or a second laptop can reach the same store. **The store still lives
only on the home machine** — this opens access, it does not move data. Read
`DATA-RESIDENCY.md` before deciding.

You need: a domain you control, a tunnel provider account, and an identity provider that can
issue OAuth tokens. The reference deployment uses Cloudflare for both, because it is the
combination the ecosystem has converged on — but nothing here is Cloudflare-specific except
the example commands.

### 1. Expose the relay through a tunnel

```bash
cp deploy/cloudflared.yml.template deploy/cloudflared.yml
# edit: <TUNNEL-ID> and <YOUR-HOSTNAME>
```

The template's ingress is **path-scoped on purpose** — only the endpoints that exist are
routed, so a route added by accident is not reachable from the internet. Validate before
running anything:

```bash
cloudflared --config deploy/cloudflared.yml tunnel ingress validate
```

### 2. Point your identity provider at it

Create an application that protects your MCP endpoint and issues OAuth tokens for it. You
need three values out of it:

| value | environment variable |
|---|---|
| Issuer URL | `HANDOFF_RELAY_AS` |
| JWKS URL | `HANDOFF_RELAY_JWKS` |
| Audience (application ID / AUD tag) | `HANDOFF_RELAY_AUDIENCE` |

And one you choose:

| value | environment variable |
|---|---|
| Your MCP URL, **exactly as you will type it into Claude** | `HANDOFF_RELAY_RESOURCE` |

> **`HANDOFF_RELAY_RESOURCE` must match character for character, path included.** If you type
> `https://mcp.example.com/mcp` into Claude, this must be `https://mcp.example.com/mcp` — not
> the bare origin. A mismatch does not fail where you made it; it surfaces later as "Couldn't
> reach the MCP server" with your identity provider seeing no traffic at all. The relay warns
> at startup if this looks wrong.

**Redirect URIs to allow:**

```
https://claude.ai/api/mcp/auth_callback     # Claude.ai web, Desktop, mobile
http://localhost/callback                    # Claude Code (port must be ignored)
http://127.0.0.1/callback                    # Claude Code (RFC 8252)
```

Claude Code binds a random port per session, so your provider must match those two loopback
URIs *ignoring the port*. If it cannot, Claude Code will not be able to connect and you are
limited to the hosted surfaces.

### 3. Start it, in this order

```bash
# 1. the relay first — it must REFUSE before anything is exposed
HANDOFF_RELAY_RESOURCE=https://mcp.example.com/mcp \
HANDOFF_RELAY_AS=https://<issuer> \
HANDOFF_RELAY_JWKS=https://<issuer>/certs \
HANDOFF_RELAY_AUDIENCE=<aud> \
node handoff-relay.js
```

It prints `auth configured`. Without those variables it prints `REFUSING ALL CALLS` and means
it — an unconfigured relay rejects every request, with or without a token.

```bash
# 2. then the tunnel, in the FOREGROUND so one Ctrl-C stops it
cloudflared --config deploy/cloudflared.yml tunnel run
```

Do **not** install the tunnel as a system service until you have finished testing. A tunnel
that survives reboots without anyone deciding it should is the kind of exposure this design
exists to avoid.

### 4. Verify from outside — this step is not optional

From a network that is not your own (a phone off wifi is ideal):

```
GET  https://mcp.example.com/healthz   → {"relay":"up", ...}
POST https://mcp.example.com/mcp       → 401 with a WWW-Authenticate header
```

**If `/mcp` ever answers `200` without a token, stop and take the tunnel down.** That is the
one result that means something is wrong.

### 5. Connect Claude

- **claude.ai / Desktop / mobile:** Settings → Connectors → Add custom connector → your MCP
  URL. Leave the OAuth fields blank if your provider supports dynamic client registration.
- **Claude Code, on another machine:**
  ```bash
  claude mcp add --transport http --scope user handoff-remote https://mcp.example.com/mcp
  ```
  Then `/mcp` in a session to authenticate.

> On the machine that *hosts* the store, keep using the tier-1 stdio server. It is a unix
> socket instead of a round trip through the internet — faster, and it works offline. And give
> the remote one a different name (`handoff-remote`, not `handoff`) or you will have two copies
> of the same tools in one session with no way to tell which one answered.

---

## Tier 3 — hosted

Not built. A hosted version would put your conversations on someone else's machine, which is
the opposite of the reason this exists. It is documented as a roadmap idea for a platform
owner who could offer it safely, not as something this project will ship.

---

## Uninstall

```bash
claude mcp remove handoff
deploy/install.sh --uninstall     # if you installed the daemon
rm -rf ~/.claude-handoff          # deletes your store — this is your data, so read it first
```
