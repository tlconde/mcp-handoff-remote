# Windows wake agent — the by-hand path

> **This is the manual path behind `/plugin install`.** Use it when the plugin cannot run, when you
> need to watch each step, or when something misbehaves and you want to see where. The intended
> install is one command; this document is the debugging companion to it, and its value is that
> every expected output below was captured from a real run rather than written from memory.
>
> Plugin packaging is in progress. Until it lands, this is also the only path — which is stated
> here rather than left for you to infer.


**What this does:** puts a wake agent on the Windows laptop so that machine can (1) see mail waiting
for its sessions, (2) deliver it as a toast, and (3) tell the store what it observed — which is what
flips a record from `reachability: unknown` to a verdict its own host asserted.

**Why it has to run there and cannot run here:** every wake path is local by construction. A
session's inbox socket is bound on its own machine; a toast appears on the machine that raises it.
The store is shared and reachable from anywhere; delivery never is. So no host is special, and each
machine speaks for itself.

**Time:** about ten minutes. **You need:** the laptop, a browser for the Access login, PowerShell.

---

## Before you start — what "working" will look like

Two things are outstanding until this runs, and both are checks nobody can perform from the Mac:

1. A record minted for the laptop currently reads `reachable: unknown`. Not *unreachable* — nobody
   has ever looked. After a successful first run it reads a verdict that machine observed.
2. The Windows toast has been verified once by eye on real hardware. Nothing automated can confirm
   a toast appeared; Windows exposes no delivered-list. **Your eyes are the only receipt that will
   ever exist for that**, which is why this package asks you to watch the first run rather than
   check a log afterwards.

If either does not happen, that is a result worth reporting, not a failure to work around.

---

## Step 1 — Node

```powershell
node --version
```

Anything 18 or newer. If it is missing: `winget install OpenJS.NodeJS.LTS`, then open a new
PowerShell window so `PATH` refreshes.

## Step 2 — Get the code onto the laptop

**The repo is private**, so a bare `git clone` will fail with an auth prompt you cannot satisfy.
Use the GitHub CLI, which does a browser login and needs no token to manage:

```powershell
winget install GitHub.cli
gh auth login          # choose GitHub.com -> HTTPS -> login with a web browser
gh repo clone <owner>/<repo> handoff
cd handoff
```

If you would rather not install `gh`: create a fine-grained personal access token with read access
to this one repo and clone with `git clone https://<token>@github.com/<owner>/<repo>.git handoff`.
The CLI route is easier to revoke later.

Nothing is installed globally and nothing runs at login yet. That comes after it has been seen to
work once.

### Carrying the two values without putting them in the repo

The relay host and the repo URL are personal identifiers, so they are placeholders in this file on
purpose — writing them in would put a domain and an account handle into a repo intended to go
public. Put them in a **gitignored** `.agent-env` beside the code instead:

```powershell
@"
HANDOFF_REMOTE_URL=https://<relay-host>/mcp
HANDOFF_HOST_ID=windows-laptop
"@ | Set-Content .agent-env
```

The agent reads it at startup, and a real environment variable always overrides it — so a one-off
test needs no edit. Keep the **token** out of this file: Credential Manager (step 3) is the right
place, because a file is only as private as the backup that copies it.

## Step 3 — The credential

The agent reaches the store through the authenticated relay. It needs a token that the relay's
Access application will accept.

**Get the token** (browser, on the laptop):

1. Visit the relay URL — the same host the Mac's connector uses, path `/mcp`.
2. Log in through the Access prompt.
3. After the redirect, copy the `CF_Authorization` cookie value. That is the token.

**Store it in Credential Manager**, so it is not sitting in a file or a shell history:

```powershell
cmdkey /generic:handoff-relay /user:agent /pass
# paste the token when prompted — it is not echoed
```

**Scope:** this credential is used for exactly three verbs — `peek_inbox` (read what is waiting,
without consuming it), `send_message` (deliver), and `agent_heartbeat` (write this host's verdict
for its own records). It cannot enumerate the store. That is deliberate: the remote surface widened
for the acceptance test above, not for convenience.

## Step 4 — First run, in the foreground, watched

Read the token out of Credential Manager into the process environment for this session only:

```powershell
cmdkey /list:handoff-relay      # confirms it exists; does not print the secret

# URL and host id come from .agent-env; only the token is pasted, and only into this window
$env:HANDOFF_REMOTE_TOKEN = Read-Host -Prompt "paste token"
node bin/handoff-wake-agent.js --once
```

`--once` runs a single cycle and exits. **Run this before anything long-lived**, so the first cycle
is watched rather than reconstructed from a log afterwards.

### What you should see

These lines are copied from a real run, not written from memory:

```
[wake-agent windows-laptop] starting — version 0.1.0, interval 20s, single cycle
[wake-agent windows-laptop] store: remote store via <relay-host> (credential present)
[wake-agent windows-laptop] remote store — cannot enumerate (state enumeration (no tool on the relay surface)); peeking and asserting one verdict for this host's records.
[wake-agent windows-laptop] peek says: <the first line of what is waiting>
[wake-agent windows-laptop] heartbeat — sent for "windows-laptop" with default verdict 'process' for records declaring this host
```

The "cannot enumerate" line is expected and is not an error: a remote agent cannot list the store,
by design. It peeks and it heartbeats; it does not enumerate. The one verdict it sends is expanded
by the store over records that declare this host — so you assert liveness without ever learning
which records exist.

On the store's own host the same command prints instead:

```
[wake-agent <host>] store: local store (filesystem, this host owns it)
[wake-agent <host>] heartbeat — 0 record(s) owned, 0 with a verdict
[wake-agent <host>] nothing waiting
```

### What each line means, and what to do if it is different

| You see | It means | Do |
|---|---|---|
| `cycle failed (continuing): cannot reach the relay: getaddrinfo ENOTFOUND…` | DNS, network, or the tunnel is down | Check the relay URL in a browser first. It keeps cycling rather than exiting |
| `relay refused the credential (HTTP 401/403)` | Token missing, expired, or minted for another app | Redo step 3; Access tokens expire |
| `cannot start: HANDOFF_REMOTE_URL is set but HANDOFF_REMOTE_TOKEN is not…` | The env var did not survive | Re-run the export line in the same window. It stops rather than polling blind |
| `Refused: this heartbeat names N record(s) that do not belong to…` | `HANDOFF_HOST_ID` does not match how records name this machine | Fix the host id — do not change the records |
| `peek says: (nothing waiting)` | Nothing is addressed to this machine yet | Fine. The heartbeat still goes; ask the Mac side to send one, then re-run |

**A refusal here is the system working.** The heartbeat is refused *whole* rather than partly
applied, so nothing is half-written and nothing needs undoing.

## Step 5 — Confirm the flip, from the Mac side

This is the acceptance test. On the Mac, after your first run:

```bash
node -e "const c=require('./handoff-core');c.handleApi('GET','/api/state',{},{}).then(r=>{
  const a=r.payload.agents||{}; console.log(JSON.stringify(a,null,1));})"
```

A record for `windows-laptop` with a recent `last_seen` and a `sessions` map is the flip. Before
today there was no way for that entry to exist.

## Step 6 — Deliver one toast, and look at the screen

Ask the Mac side to send a message to a session that names this laptop, then:

```powershell
node bin/handoff-wake-agent.js --once
```

**Watch the screen.** A toast should appear, attributed to Windows PowerShell — handoff is not a
registered app, and a toast must be shown by one, so the attribution is PowerShell's and that is
stated rather than hidden.

If the toast does **not** appear, the interesting output is on stderr: the notify layer reports a
failed dispatch rather than swallowing it, and returns `confirmed: false` because dispatch is not
appearance. Copy that line back — it is the finding.

## Step 7 — Only now, make it durable

Once you have seen a cycle work and a toast appear:

```powershell
node bin/handoff-wake-agent.js          # polls until Ctrl-C
```

Leave it in a window for a while before considering a scheduled task. Making it a managed service
comes after it has been seen to work, not before.

---

## What this agent will not do

- **It never marks anything read.** It uses `peek`, never `check_inbox` — draining belongs to the
  reader, and a poller that drains would eat conversations it is only watching.
- **It never writes a verdict for another host.** Refused at the verb, whole.
- **It never claims a delivery it cannot evidence.** The transport contract returns
  `{delivered, held, evidence, reason}` and all four are reported rather than collapsed into
  "success" — `held` exists because a receiver can withhold a message from its Claude, and a leg
  reporting held as delivered is reporting mail no one will read.
- **It cannot enumerate the store.** By design.

## If you want to stop it

Ctrl-C. Nothing persists; no service was installed. To remove the credential:
`cmdkey /delete:handoff-relay`.
