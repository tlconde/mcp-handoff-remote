# Install

Three tiers. **Start at tier 1** — it is the default, it needs nothing but Node, and most
people never leave it. Tier 2 exists only if you want your *other* devices to reach the same
store.

Requirements: Node 18+, macOS or Linux. Zero npm dependencies — the whole thing is plain Node.

---

## Tier 1 — local only (start here)

No tunnel, no cloud account, no third party, no network surface at all. The **MCP host**
(Grok Build, Cursor, Claude Code, a Cloud Agent) spawns `node mcp-handoff.js` over **stdio**
per connection. There is no `start` service.

**Two doors, never both on one client.** Repo-link install is **Door A**: clone this repo and
mount one stdio server that runs `node …/mcp-handoff.js` (Claude Code can wrap that as the
`handoff` plugin). Chat, a phone, or another device is **Door B**: add ONE remote MCP at the
home relay URL — on grok.com that is the existing connector named **Handoff Remote** (do not
rename it). Same store, same tools, different transport because the surface cannot do the
other one. A second mount of the same tool-name hash is a refuse, not a compatibility mode:
`node bin/handoff-mount-doctor.js` names which mount to disable. It does not delete a
connector.

**The contract** is `mcp.json`: `command` `node`, `args` `[mcp-handoff.js]`. Point your host
at that. One mount per client.

```bash
git clone https://github.com/<owner>/handoff-remote.git
cd handoff-remote
# then add a stdio MCP in your host, equivalent to:
#   node /absolute/path/to/mcp-handoff.js
```

Examples (same process, different host UI):

| Host | How you add the stdio server |
|---|---|
| Grok Build | `/mcps` → add, or `~/.grok/config.toml` `[mcp_servers.handoff]` `command` / `args` |
| Cursor (desktop) | `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project) — snippet below |
| Claude Code | `claude mcp add --scope user handoff -- node "$PWD/mcp-handoff.js"` |

**Cursor, the exact file** (Cursor also exposes this as Settings → MCP, which writes the same
JSON). Use an **absolute path to node** — a GUI app does not inherit your shell's PATH, and
`command: "node"` failing to resolve looks like a dead server, not a path problem:

```json
{
  "mcpServers": {
    "handoff": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/to/handoff-remote/mcp-handoff.js"]
    }
  }
}
```

Cloud Agents are **code** seats (`register_code_session`). They are clients, not a second
store: scratch `HANDOFF_HOME`, or `HANDOFF_ROLE=client` plus the home URL. `device` is
`os.hostname()` of that VM — do not invent a product name as a host.

**Cursor Cloud Agent** is the one Cursor case the stdio snippet above does NOT cover: the
agent runs on a VM that cannot see your home store's filesystem, so it takes **Door B** — add
the remote MCP URL (tier 2) in the dashboard's MCP settings and authenticate through your
identity provider. A sandboxed **Door A** on that VM (clone + stdio + scratch `HANDOFF_HOME`)
is also legitimate, but that is a second, empty store for experiments — it is a stand-in for
a new laptop, not a window onto your conversations.

**Claude Code plugin** (optional packaging for that host only — hook + wake agent as one
versioned unit):

```bash
claude plugin marketplace add <owner>/handoff-remote
claude plugin install handoff@handoff
```

`node bin/build-plugin-manifests.js` only regenerates `.claude-plugin/*`. Other hosts do not
need it to run the bridge.

**Cursor Agent CLI — identity on sessionStart (optional).** Copy
[`hooks/cursor-hooks.json.example`](hooks/cursor-hooks.json.example) into the project’s
`.cursor/hooks.json` (or merge the `sessionStart` entry into your user
`~/.cursor/hooks.json`). The script calls the same `/api/register` door as Claude’s
SessionStart, with `kind: "cursor-cli"` — `native_ref.kind`/`session_id` from the Cursor
conversation id (no Claude resume/pid heal), no inbox drain, no invented title. Name the
seat afterwards with `You will be <word>` / `/onboard`. Skipped on
`cursor agent --resume`; not available on cloud agents.

Check it: your host lists a connected `handoff` server; `tools/list` is 27 tools. The
installed plugin version should match the `version` field in [`plugin.json`](plugin.json). The store
is created at `~/.claude-handoff/` on first **host** use (a client with `HANDOFF_HOME` or
`HANDOFF_ROLE=client` does not create one here).

**Name any seat** by typing this in that conversation:

```
You will be Chad
```

or `Register this chat as Chad`. One word. grok.com / claude.ai / Claude chat call
`register_chat_session`. A machine (this laptop, a Cloud Agent) calls
`register_code_session`. `/name` and `/onboard` do the same. A seat that omits required
fields is refused, not half-enrolled.

Over the relay, `whoami` cannot see a chat seat unless you pass the `session_id`
register just returned (`session_uuid` or `session_id` — same value). A no-arg
`whoami` after a successful register says unidentified; that is not a failed enrol.
Do not register again.

**Start a laptop agent from this chat.** After enrolment, call `send_to_worker` and pass
`origin_session_id` (the minted `sess_…` id). This conversation is the origin — a second
carrier record is not minted. The home machine probes for installed agent CLIs (Claude Code,
Codex, others). If you named one ("start Codex", "start Claude Code"), that dest is used;
otherwise the one that is present is started. Several installed and no name is a refuse, not
a guess. `dir` or `project_state.project_id` can bind a repo folder; spawn working is enough
if neither is set. Cursor Cloud Agents are a different path (`register_code_session` on that
VM) and are unchanged.

**Optional — the background daemon.** One process serving every terminal, so sessions can
reach each other and wake each other:

```bash
deploy/install.sh          # installs a launchd (macOS) or systemd (Linux) unit
```

---

## Tier 2 — remote access from your other devices (opt in)

Adds one door so a phone or a second laptop can reach the same store. **The store still lives
only on the home machine** — this opens access, it does not move data. Read
`DATA-RESIDENCY.md` before deciding.

> **Setting up that second machine is its own runbook:
> [REMOTE-PEER-SETUP.md](REMOTE-PEER-SETUP.md)** — credential, host id, a watched first run, and the
> heartbeat that flips its record from `unknown` to a verdict it asserted itself. It applies to any
> peer, not one operating system; the three things that differ (login service, credential store,
> notification) are one table in that document.

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
| Your MCP URL, **exactly as you will type it into the MCP host** | `HANDOFF_RELAY_RESOURCE` |

> **`HANDOFF_RELAY_RESOURCE` must match character for character, path included.** If you type
> `https://mcp.example.com/mcp` into the host, this must be `https://mcp.example.com/mcp` — not
> the bare origin. A mismatch does not fail where you made it; it surfaces later as "Couldn't
> reach the MCP server" with your identity provider seeing no traffic at all. The relay warns
> at startup if this looks wrong.

**Redirect URIs to allow:**

```
https://claude.ai/api/mcp/auth_callback              # Claude.ai web, Desktop, mobile
http://localhost/callback                             # Claude Code (port must be ignored)
http://127.0.0.1/callback                             # Claude Code (RFC 8252)
https://grok.com/connectors-oauth-exchange-code/      # grok.com connector
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

### 5. Connect a remote host

- **grok.com:** add the connector at the same MCP URL, keeping the existing name
  **Handoff Remote**. Do not rename it. Keep the grok.com redirect URI above.
- **claude.ai / Desktop / mobile:** Settings → Connectors → Add custom connector → your MCP
  URL. Leave the OAuth fields blank if your provider supports dynamic client registration.
- **Claude Code, on another machine:**
  ```bash
  claude mcp add --transport http --scope user handoff-remote https://mcp.example.com/mcp
  ```
  Then `/mcp` in a session to authenticate.
- **Grok Build / Cursor on another machine:** add an HTTP MCP at the same URL (not a second
  stdio copy of the home store).

> On the machine that *hosts* the store, keep Door A (tier-1 stdio) and do **not** also add
> Door B on that same client. A different pretty name does not make a second mount safe — the
> three observed copies (`handoff`, `handoff-store`, `handoff_remote`) already had different
> names and identical tool-name hashes. Disable the extras; do not rename Handoff Remote on
> grok.com. Run `node bin/handoff-mount-doctor.js` to name which mount to turn off.

---

## Tier 3 — hosted

Not built. A hosted version would put your conversations on someone else's machine, which is
the opposite of the reason this exists. It is documented as a roadmap idea for a platform
owner who could offer it safely, not as something this project will ship.

---

## Uninstall

```bash
# remove this client's one Handoff mount (stdio Door A, or HTTP Door B — not both)
deploy/install.sh --uninstall     # if you installed the daemon
rm -rf ~/.claude-handoff          # deletes your store — this is your data, so read it first
```
