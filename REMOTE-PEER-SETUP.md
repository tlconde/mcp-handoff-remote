# Remote peer setup — a machine with no store, reaching yours

**This document was called `WINDOWS-AGENT-SETUP.md`, and the name was lying about the domain.**
Nothing here is Windows-specific except three cells in one table. What it actually describes is a
**role**: a machine that holds *no store* and reaches the home machine over the relay. A second
Linux laptop needs exactly this document and would previously have found nothing, because the
filename advertised an operating system where the content describes a position in the system.

## Three lanes, and this is only one of them

Confusing these is the most common way to end up following the wrong runbook:

| you want | you run | where |
|---|---|---|
| **the product** (MCP server, hook, wake agent) | `claude plugin marketplace add <owner>/handoff-remote` → `claude plugin install handoff@handoff` | any machine, same two lines |
| **the store daemon** — one process owning the protocol | `deploy/install.sh` (launchd on macOS, systemd on Linux) | the **home machine** only, the one that holds the store |
| **a remote peer** — a machine with no store | **this document** | any *second* machine |

The home machine never needs this document: it *is* the store, so nothing has to reach across for
it. A remote peer never needs `deploy/install.sh`: there is no store on it to serve.

> **This is also the by-hand path behind the plugin install.** Use it when you need to watch each
> step, or when something misbehaves and you want to see where. Its value is that every expected
> output below was captured from a real run rather than written from memory.
>
> **Plugin packaging has LANDED — version 0.1.1, and the one-liner is the shipped route:**
>
> ```powershell
> claude plugin marketplace add <owner>/handoff-remote
> claude plugin install handoff@handoff
> ```
>
> Both commands shell out to `git clone`, so **while this repo is private they need a git that can
> already authenticate to it** — do Step 2's `gh auth login` first and they will work. Proven on
> macOS 2026-08-10 end to end (`handoff@handoff 0.1.1, enabled`); **not yet run on Windows**, which
> is one of the two things this trip is for.
>
> **What changed since this document was last true:** the plugin registers **no monitors** (that
> registration was retired — wake is wired at the send site, not by a background monitor); the wake
> agent is **quiet by default** and narrates only on state changes, with `--verbose` for a watched
> first run; and test seams (`HANDOFF_WAKE_LOG`, `HANDOFF_NOTIFY_LOG`) now **refuse to arm** unless
> `HANDOFF_TEST=1` is also set, because one of them was armed in a production daemon and reported
> five deliveries that never happened.


**What this does:** puts a wake agent on the peer machine so it can (1) see mail waiting for its
sessions, (2) deliver it locally, and (3) **tell the store what it observed** — which is what flips
a record from `reachability: unknown` to a verdict that host asserted.

**That third one is the acceptance test, not a side effect.** `unknown` does not mean unreachable;
it means *nobody has ever looked*. Only the machine itself is entitled to say otherwise, and the
heartbeat is how it says it. A peer that delivered a toast but never flipped its record has done
the visible half of the job and skipped the half the rest of the system reads.

**Why it has to run there and cannot run here:** every wake path is local by construction. A
session's inbox socket is bound on its own machine; a notification appears on the machine that
raises it. The store is shared and reachable from anywhere; delivery never is. So no host is
special, and each machine speaks for itself.

### What actually differs by operating system

Three cells. Everything else in this document is the same prose on every platform.

| concern | macOS peer | Linux peer | Windows peer |
|---|---|---|---|
| **run at login** | launchd `LaunchAgent` | systemd **user** unit (`--user`, `Restart=always`) | `schtasks /SC ONLOGON` |
| **credential store** | Keychain (`security add-generic-password`) | libsecret (`secret-tool store`) | Credential Manager (`cmdkey /generic:`) |
| **local notification** | `osascript`, or `terminal-notifier` for a clickable one | `notify-send` | PowerShell WinRT toast |

> **VERIFICATION STATUS, per platform — shared prose is not a verified peer.**
> **Windows:** every expected output in this document was captured from a real run, except the
> scheduled-task block, which is marked UNVERIFIED where it appears.
> **Linux:** the three cells above are written from the code's actual rungs
> (`bin/handoff-notify.js` branches on `process.platform`, `deploy/install.sh` already emits a
> systemd user unit for the daemon) but **no Linux peer has ever been run**. Treat the Linux column
> as a starting point to correct, not as a tested path.
> **macOS as a peer:** unexercised too — the Mac here is the store host, so it has never needed
> this document.

**Time:** about ten minutes. **You need:** the peer machine, a browser for the Access login, and a
shell on it.

---

## Before you start — what "working" will look like

Two things are outstanding until this runs, and both are checks nobody can perform from the home device:

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

**Once `gh auth login` has succeeded, the plugin one-liner also works** — the plugin CLI shells out
to `git clone` and inherits exactly these credentials:

```powershell
claude plugin marketplace add <owner>/handoff-remote
claude plugin install handoff@handoff
claude plugin list                      # expect: handoff@handoff  0.1.1  enabled
```

Measured on macOS: with credentials present both commands succeed; from an environment with no
credential helper the clone fails with *"Could not read from remote repository"* **before the
marketplace file is ever read** — so an auth failure looks like a repo failure. If you see that
message, the problem is Step 2, not the plugin.

Either route gives you the same code. The clone below is what the rest of this document assumes,
because it is the one you can watch.

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

1. Visit the relay URL — the same host the home device's connector uses, path `/mcp`.
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
| `peek says: (nothing waiting)` | Nothing is addressed to this machine yet | Fine. The heartbeat still goes; ask the home side to send one, then re-run |

**A refusal here is the system working.** The heartbeat is refused *whole* rather than partly
applied, so nothing is half-written and nothing needs undoing.

## Step 5 — Confirm the flip, from the home device

This is the acceptance test. On the home device, after your first run:

```bash
node -e "const c=require('./handoff-core');c.handleApi('GET','/api/state',{},{}).then(r=>{
  const a=r.payload.agents||{}; console.log(JSON.stringify(a,null,1));})"
```

A record for `windows-laptop` with a recent `last_seen` and a `sessions` map is the flip. Before
today there was no way for that entry to exist.

## Step 6 — Deliver one toast, and look at the screen

Ask the home side to send a message to a session that names this laptop, then:

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
node bin/handoff-wake-agent.js          # polls until Ctrl-C, QUIET unless something changes
```

Leave it in a window for a while before making it a scheduled task. Making it a managed service
comes after it has been seen to work, not before.

**What quiet means here.** The agent prints two lines at startup and then **nothing** until
something changes — a verdict flips, mail arrives or clears, the store becomes unreachable — plus
every error and every recovery. A silent window is the agent working, not the agent stuck. Pass
`--verbose` if you want the old per-cycle narration back; `--once` implies it. Silence is not a
claim that anything happened: every state change and every failure still prints, so there is no
quiet in which a problem could hide.

### Run at login — one block per platform

Pick your row from the table at the top. All three do the same thing: start the agent when *you*
log in, not at boot, because the agent raises notifications and a machine-level service has no
session to show one in.

**Linux peer** — a systemd **user** unit (not a system unit, for the same reason):

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/handoff-wake-agent.service <<'UNIT'
[Unit]
Description=handoff wake agent (remote peer)
[Service]
ExecStart=/usr/bin/node %h/handoff/bin/handoff-wake-agent.js
Restart=always
[Install]
WantedBy=default.target
UNIT
systemctl --user enable --now handoff-wake-agent
systemctl --user status handoff-wake-agent      # verify by effect, not by the enable's exit code
```

**macOS peer** — the same shape as `deploy/install.sh` writes for the daemon, pointed at the agent
instead. Copy `deploy/com.handoff.daemon.plist.template`, change the label and the script path.

**UNVERIFIED on both.** Neither block has been run. The Windows one below has been written against
the real flags but also never executed.

### The scheduled task — the Windows service form

This is the counterpart of the Mac's launchd unit. Run it **only after** a foreground run has
worked, and register it as a **logon** task rather than a service, because the agent raises toasts
and a session-0 service cannot show one to you.

```powershell
# from the folder you cloned into, with the credential already in Credential Manager
$node = (Get-Command node).Source
$agent = "$PWD\bin\handoff-wake-agent.js"

schtasks /Create `
  /TN "handoff-wake-agent" `
  /TR "`"$node`" `"$agent`"" `
  /SC ONLOGON `
  /RL LIMITED `
  /F
```

Then verify **by effect**, not by the command's exit code:

```powershell
schtasks /Run /TN "handoff-wake-agent"
Start-Sleep -Seconds 5
Get-Process node -ErrorAction SilentlyContinue | Select-Object Id, StartTime   # a node process exists
schtasks /Query /TN "handoff-wake-agent" /V /FO LIST | Select-String "Last Result"
```

`Last Result: 0` means the task launched a process. **It does not mean the agent is delivering** —
for that, send yourself a message from the home device and watch the toast, exactly as in Step 6.
The layer that reports success is never the layer that proves it, and on this project that rule was
paid for twice in one evening.

**The environment a scheduled task does NOT inherit.** It gets a minimal environment, so anything
the agent needs must be set explicitly — the same defect that once made the Mac's relay spawn a
binary it could not see. `HANDOFF_REMOTE_URL` and `HANDOFF_HOST_ID` live in `.agent-env`; the token
is read from Credential Manager at start. If the task runs and the agent exits immediately, that
environment is the first thing to check, and `--verbose` in the task's command line is how you see
why.

**To remove it:** `schtasks /Delete /TN "handoff-wake-agent" /F`.

> **UNVERIFIED — this block has never been executed.** It is written from the agent's actual flags
> and the Mac unit's shape, and it is the one section of this document not captured from a real run.
> Correct it against what the laptop actually does, and say so, rather than trusting it because it
> is written down.

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
