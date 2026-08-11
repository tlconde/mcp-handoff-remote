#!/usr/bin/env node
'use strict';
/**
 * Wake tier — the daemon's mechanism for starting a turn in a TARGET conversation when
 * attention-tier mail lands for it, with zero human taps where the platform allows it.
 *
 * Standalone module (owned by the wake-tier workstream). It does NOT touch mcp-handoff.js,
 * handoff-core.js, or the daemon tools/call path — the forwarder swap (slice 3) requires
 * this at its send site: `require('./bin/handoff-wake').wake(delivery)`.
 *
 * APPROVED TIER (the user, 2026-08-08), tried in order, first hit wins:
 *   1. channel-inject  — IF the target was launched with `claude --channels handoff@…`
 *                        (research-preview; t28 probe 1). Injects the wake line straight
 *                        into the open session as a <channel> event. Seam only here
 *                        (HANDOFF_CHANNEL_HOOK); the daemon wires the real channel plugin.
 *   2. -p relay        — IF the target is OPEN (native registration + live socket). Spawns
 *                        ONE `claude -p` with the CHEAPEST model and --allowedTools
 *                        "ListAgents SendMessage"; the spawned session confirms the target
 *                        via ListAgents, then SendMessage's ONE wake line. Proven live in
 *                        t26 (woke a live terminal session). Fire-and-exit, no-reply-expected,
 *                        exactly ONE call, NO retries (relay contract, t26 §reply).
 *   3. notify          — the target cannot be reached by any process: no live socket, or it is
 *                        on ANOTHER DEVICE. Tell the human instead, naming the session, the
 *                        device and the window to open. REMOVED earlier on 2026-08-09 and
 *                        REINSTATED the same day as a REQUIREMENT, because the reason for
 *                        removal does not survive this case. It was removed for implying an
 *                        autonomous wake that never happened; here nothing is implied — the
 *                        session genuinely cannot be woken by any mechanism, so a signal to the
 *                        human is not a substitute for the real thing, it IS the real thing.
 *                        Without it the mail waits on the chance that someone looks.
 *   4. store           — ALWAYS the durable truth. Written by the CALLER before wake() runs;
 *                        this module never owns durability. Every rung degrades to it.
 *
 * THE LINE THE NOTIFY RUNG IS HELD TO: it may say "mail is waiting for <name> on <device> —
 * open that window", which is true and actionable. It may never say the session woke or that a
 * turn started. tier:'notify' in the result means THE HUMAN WAS TOLD, never that anything ran.
 *
 * RULES HONOURED:
 *   - `fyi` never wakes. Only the `attention` tier reaches a rung. An fyi delivery returns
 *     {woke:false, tier:'skipped'} and relies on the store the caller already wrote.
 *   - NATIVE-FIRST / BROADLY-USED-ONLY: the relay invokes the `claude` CLI as a product and
 *     lets native's own SendMessage/ListAgents carry the frame. We never hand-roll native's
 *     private, peerProtocol-versioned wire (t26 §wire — socket posting is retired).
 *   - One relay call per delivery, no retries. If the single dispatch cannot even spawn, we
 *     degrade to the store — we do NOT re-attempt the relay.
 *   - Fire-and-forget; wake() never throws and never blocks a send (a wake failure must not
 *     break the durable write that already happened).
 *
 * delivery = {
 *   tier:         'attention' | 'fyi'      // ONLY 'attention' wakes
 *   thread:       string                    // goes in the wake line: "mail from <from> on <thread>"
 *   conversation: string                    // display title (notify + relay addressing)
 *   session_id:   string                    // store session id (notify meta)
 *   native_ref:   { session_id, name, cwd, messaging_socket_path } | null
 *   channels:     boolean                   // was the target launched with --channels?
 *   from:         string                    // sender label — notify body AND the wake line's
 *                                         // letter provenance. Absent = stays unnamed, never invented.
 * }
 *
 * Test / CI seams:
 *   HANDOFF_NO_WAKE=1       → disable the layer entirely → {woke:false, tier:'disabled'}
 *   HANDOFF_WAKE_LOG=<file> → append one JSON line describing the chosen rung INSTEAD of
 *                             spawning a real relay (channel/notify still route through their
 *                             own log seams). Lets tests assert the tier with no CLI spawn.
 *   HANDOFF_CLAUDE_BIN=<p>  → path to the `claude` binary (default: 'claude' on PATH)
 *   HANDOFF_WAKE_MODEL=<m>  → cheapest model alias for the relay (default: 'haiku')
 *   HANDOFF_SESSIONS_DIR=<d>→ native registration dir (default: ~/.claude/sessions)
 *   HANDOFF_CHANNEL_HOOK=<c>→ channel-inject command (argv: title, body); tried only when
 *                             delivery.channels is true.
 * opts (programmatic, for tests): { spawn, notify, reach } inject the three side-effects.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
/* THE ONLY PLACE THE OS IS ALLOWED TO MATTER is bin/platform-profile.js. This module reads a
 * PROFILE — a value — and never asks process.platform itself. That is what makes every branch here
 * reachable from any machine: a test passes a different profile instead of needing a different
 * computer, which was the only oracle available when Windows-only defects shipped. */
const { profileFor, CURRENT } = require('./platform-profile');

/* THE KNOCK NAMES THE SENDER WITHOUT IMPERSONATING (spec amendment, owner-approved
 * 2026-08-09).
 * This line travels INSIDE a native cross-session message sent by the relay session, so
 * native's own attribution already says who knocked: the relay. Two provenances are in play
 * and they are not the same fact — RELAY ATTRIBUTION belongs to the relay, LETTER PROVENANCE
 * belongs to whoever wrote the mail. The old line named neither, so the receiving terminal
 * knew something was waiting but not from whom, and the only way to find out was to go and
 * look. Naming the sender in the text closes that without ever claiming to BE them: the
 * relay says "mail from your chat", never "I am your chat". An unnamed sender stays unnamed —
 * we do not invent an origin to make the sentence read better. */
const WAKE_LINE = (thread, from) => from
  ? `mail from ${from} on ${thread || 'a thread'} is waiting — checking the inbox will deliver it`
  : `mail waiting on ${thread || 'a thread'} — checking the inbox will deliver it`;

/* PEER-VERB CAPABILITY — refuse rung 2 where the verb does not exist, instead of reporting a
 * dispatch that can never be honoured.
 *
 * MEASURED 2026-08-10, both sides, same CLI version 2.1.226: macOS has ListAgents inside a spawned
 * one-shot; Windows does not. And `--allowedTools` granting a NONEXISTENT tool is a SILENT NO-OP —
 * so on Windows the spawn succeeds, the peer lookup never happens, the send falls into the subagent
 * address space, and rung 2 returns `dispatched` EVERY TIME having delivered nothing. That is this
 * repo's founding failure shipped as a certainty rather than a risk.
 *
 * WHY A CACHED FILE AND NOT A LIVE PROBE. wake() is called SYNCHRONOUSLY at the send site, and a
 * real capability probe costs a model spawn — several seconds of a caller's turn, per send. So the
 * capability is READ, never probed inline: a JSON file in the store dir is authoritative, and the
 * platform default applies only when nothing has been recorded. That keeps the check capability-
 * driven rather than an OS switch — the boundary is Anthropic's and may move, and when it moves the
 * fix is one file, not a release.
 *
 *   $HANDOFF_HOME/wake-capabilities.json   {"peer_verbs": true|false, "probed_at": "...", "note": "..."}
 *
 * To record what a machine actually has, run the probe the peer used and write the answer:
 *   claude -p "Is a tool named ListAgents available to you? Answer yes or no." --allowedTools ListAgents
 *
 * The DEFAULT when unrecorded is deliberately per-platform rather than optimistic: an optimistic
 * default reproduces the forever-lie on every un-probed Windows machine, which is the exact bug. */
/* THE PROBE, AND IT COSTS NOTHING — which is why it can be automatic.
 *
 * The comment above tells an operator to run `claude -p "…is ListAgents available…"` by hand and
 * write the answer. That instruction shipped and nobody ever ran it, which is why every machine in
 * this fleet has been running on the PLATFORM DEFAULT rather than on what it actually has. A manual
 * step in a comment is not a mechanism.
 *
 * Two better signals exist, both free and both deterministic:
 *   CLAUDE_CODE_MESSAGING_SOCKET — exported to hooks and Bash commands for every session that binds
 *                                 an inbox socket. Its PRESENCE is the feature, per the product docs.
 *   the socket directory        — the same fact on disk, visible to a process that did not inherit
 *                                 the session's environment (launchd, a scheduled task, a daemon).
 *
 * A model spawn was never needed. It also could not have answered honestly: a free-form "list your
 * tools" reply can OMIT rather than deny, and `--allowedTools` naming a verb that does not exist is
 * a SILENT no-op — so the documented probe could return a confident yes on a machine with no
 * messaging at all. The peer measured exactly that trap.
 *
 * THE ASYMMETRY IS RECORDED IN THE FILE, per the ruling, because whoever reads it later needs to
 * know which way to err: wrong toward REFUSING costs a notification the human still sees; wrong
 * toward RELAYING costs invisible silence. So an inconclusive probe writes nothing and leaves the
 * pessimistic platform default standing, rather than guessing optimistically. */
function probePeerVerbs(opts) {
  /* `platform` is injectable for the same reason claudeBinPath's is: the win32 branch answers
   * conclusively and short-circuits, so on Windows the socket-directory fallback and the
   * INCONCLUSIVE third state are unreachable — and those are exactly the branches a test needs to
   * cover. Five capability-probe tests failed on the peer for that reason alone, testing nothing
   * about the code. Production passes nothing. */
  const o = opts || {};
  const prof = o.profile || (o.platform ? profileFor(o.platform) : CURRENT);
  const sock = o.socketVar !== undefined ? o.socketVar : process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (sock && String(sock).trim()) {
    return { peer_verbs: true, evidence: 'CLAUDE_CODE_MESSAGING_SOCKET is set — this session binds an inbox socket' };
  }
  /* Windows is excluded by the product, not by a missing file, so absence there is CONCLUSIVE and
   * absence elsewhere is not: a launchd-spawned process legitimately lacks the variable while the
   * feature works fine for interactive sessions on the same machine. */
  /* Absence is a DENIAL where the profile says so, and merely unmeasured everywhere else. */
  if (prof.peerVerbsAbsenceIsConclusive) {
    return { peer_verbs: false, evidence: `${prof.displayName} — cross-session messaging is not offered on this platform` };
  }
  /* EVERY candidate directory, because the location is a platform fact and this branch exists for
   * a process that inherited no environment. Checking only one was the defect. */
  const dirs = o.socketDir ? [o.socketDir] : prof.socketDirs();
  for (const dir of dirs) {
    try {
      const entries = fs.readdirSync(dir).filter(f => f.endsWith('.sock'));
      if (entries.length) {
        return { peer_verbs: true, evidence: `${entries.length} session socket(s) present in ${dir}` };
      }
    } catch (_) { /* absent or unreadable — try the next, absence is not a denial */ }
  }
  return { peer_verbs: null, evidence: 'no socket variable and no socket directory — INCONCLUSIVE from this process' };
}

/** Record the probe, but never overwrite a conclusive answer with an inconclusive one. */
function recordPeerVerbs(homeDir, probeOpts) {
  const home = homeDir || process.env.HANDOFF_HOME || path.join(os.homedir(), '.claude-handoff');
  const p = path.join(home, 'wake-capabilities.json');
  const r = probePeerVerbs(probeOpts);
  if (r.peer_verbs === null) return { written: false, ...r };
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      peer_verbs: r.peer_verbs,
      probed_at: new Date().toISOString(),
      evidence: r.evidence,
      note: 'Wrong toward REFUSING costs a notification the human still sees. Wrong toward RELAYING ' +
        'costs invisible silence. When in doubt this file is not written and the pessimistic ' +
        'platform default stands.',
    }, null, 2));
    return { written: true, path: p, ...r };
  } catch (e) { return { written: false, error: (e && e.message) || String(e), ...r }; }
}

function peerVerbsAvailable() {
  const home = process.env.HANDOFF_HOME || path.join(os.homedir(), '.claude-handoff');
  try {
    const raw = fs.readFileSync(path.join(home, 'wake-capabilities.json'), 'utf8');
    const j = JSON.parse(raw);
    if (typeof j.peer_verbs === 'boolean') return { ok: j.peer_verbs, source: 'wake-capabilities.json' };
  } catch (_) { /* unrecorded — fall through to the platform default */ }
  return { ok: CURRENT.peerVerbsPossible, source: `platform default (${CURRENT.platform})` };
}

/* SEAM GATING — a test double must not be armable in production by one environment variable.
 *
 * THE DISTINCTION THAT MATTERS is not "is it a test hook" but "does it report success it did not
 * earn". HANDOFF_NO_WAKE returns {woke:false, tier:'disabled'} — honest, and a legitimate kill
 * switch a user is entitled to set in production, so it stays UNGATED. HANDOFF_WAKE_LOG and
 * HANDOFF_NOTIFY_LOG SUBSTITUTE for the real thing while reporting success, and those are gated:
 * they now require HANDOFF_TEST=1 alongside, so a long-lived daemon cannot be converted into a
 * simulator by a single variable somebody set while trying to observe it.
 *
 * A refused seam says so ONCE on stderr rather than failing quietly in either direction — the
 * whole defect was a silent state change, and curing it with a second silent state change would
 * be its own joke. */
const seamAnnounced = new Set();
function seamArmed(name) {
  const raw = process.env[name];
  if (!raw) return null;
  if (process.env.HANDOFF_TEST === '1') {
    if (!seamAnnounced.has(name)) {
      seamAnnounced.add(name);
      try { console.error(`[handoff] TEST SEAM ACTIVE: ${name} — real delivery is REPLACED by a log line; this must never be a production daemon`); } catch (_) {}
    }
    return raw;
  }
  if (!seamAnnounced.has(name)) {
    seamAnnounced.add(name);
    try { console.error(`[handoff] REFUSED test seam ${name}: it replaces real delivery with a log line and would report success for work never done. Set HANDOFF_TEST=1 as well if this is genuinely a test process. Proceeding with the REAL path.`); } catch (_) {}
  }
  return null;
}

function sessionsDir() {
  return process.env.HANDOFF_SESSIONS_DIR || path.join(os.homedir(), '.claude', 'sessions');
}

/* WHERE `claude` ACTUALLY IS — resolved, never inherited.
 * Found live 2026-08-09, and it had silently disabled the entire relay rung: the daemon runs
 * under launchd, whose PATH is the minimal /usr/bin:/bin:/usr/sbin:/sbin. `claude` lives in
 * ~/.local/bin, which is not on it, so spawn('claude') threw ENOENT on EVERY wake — the tier
 * dutifully degraded to a notification and the user never got a zero-tap turn. Nothing was
 * broken in the wake logic; it was reaching for a binary it could not see.
 * The suites could not catch this by construction: wake-smoke injects a fake spawn, so it
 * proves the ARGV and never the resolution. Same lesson as the invented pids — a test that
 * stubs the environment cannot test the environment.
 * So: resolve from known locations at use time, exactly like terminal-notifier, and treat
 * "not found" as a loud degrade rather than a mystery. */
/* WINDOWS RESOLUTION (added 2026-08-11). The list above was POSIX-only: three unix paths and a
 * `which` fallback, none of which can resolve on win32, where the lookup verb is `where` and the
 * launcher carries an extension. Measured on HP_laptop — `where claude` prints THREE hits:
 *   C:\Users\simoe\.local\bin\claude.exe          <- native, directly spawnable
 *   C:\Users\simoe\AppData\Roaming\npm\claude     <- sh script, not spawnable by CreateProcess
 *   C:\Users\simoe\AppData\Roaming\npm\claude.cmd <- shim
 * The old code checked `~/.local/bin/claude` WITHOUT `.exe`, so it missed the one good answer and
 * then called a `which` that does not exist there — null on every Windows machine.
 *
 * This was LATENT, not live: peerVerbsAvailable() refuses rung 2 on win32 before the binary is
 * ever needed. It becomes live the moment that gate opens — a probed wake-capabilities.json, or
 * the boundary moving — and it would present as every wake degrading to a notification with no
 * cause named. That is the launchd-PATH defect exactly, on a platform nobody would think to check.
 *
 * A `.cmd`/`.bat` shim is NOT usable here even though it exists. Node >=18.20 refuses to spawn one
 * without shell:true, and shell:true would push the relay prompt — multi-line, quoted — through
 * cmd.exe, which mangles it. So a shim is REFUSED WITH ITS REASON rather than spawned into a
 * corrupted prompt: a wake that degrades honestly beats one that delivers a garbled line. */
let CLAUDE_BIN_CACHE;
let CLAUDE_BIN_WHY = null;

/* INJECTABLE, so the Windows branch is testable from a Mac.
 *
 * The `.exe`-over-shim preference is the part most worth a regression test and the part hardest to
 * reach: it only runs on win32, and the fleet's only Windows machine had no suite to run (that is
 * what the ADR-0002 amendment is fixing). It was found by a peer reading the function by hand —
 * once. `opts` lets a test drive the win32 path anywhere: {isWin, whichOutput, exists}. Production
 * passes nothing and behaves exactly as before. */
function claudeBinPath(opts) {
  const o = opts || {};
  const prof = o.profile || (o.isWin !== undefined ? profileFor(o.isWin ? 'win32' : 'darwin') : CURRENT);
  const exists = o.exists || (p => { try { return fs.existsSync(p); } catch (_) { return false; } });
  if (!opts && process.env.HANDOFF_CLAUDE_BIN) return process.env.HANDOFF_CLAUDE_BIN;
  if (!opts && CLAUDE_BIN_CACHE !== undefined) return CLAUDE_BIN_CACHE;
  const candidates = prof.cliCandidates;
  for (const p of candidates) { if (exists(p)) return (CLAUDE_BIN_CACHE = opts ? p : (CLAUDE_BIN_CACHE = p)); }
  try {
    const out = o.whichOutput !== undefined ? o.whichOutput : require('child_process')
      .execFileSync(prof.cliLookupCommand, ['claude'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    /* `where` prints EVERY match, one per line, and the first is not necessarily usable — prefer a
     * directly-spawnable .exe over anything else. `which` prints a single line, so this is a no-op
     * on POSIX. */
    const hits = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const exe = prof.cliRequiresDirectlySpawnable ? hits.find(prof.cliSpawnableTest) : hits[0];
    if (exe) { if (!opts) CLAUDE_BIN_CACHE = exe; return exe; }
    if (prof.cliRequiresDirectlySpawnable && hits.length) {
      CLAUDE_BIN_WHY = `only a shell shim was found (${hits[0]}); a .cmd/.bat cannot carry the multi-line relay prompt`;
      if (!opts) CLAUDE_BIN_CACHE = null;
      return null;
    }
  } catch (_) { /* not on this PATH either */ }
  if (!opts) CLAUDE_BIN_CACHE = null;
  return null;
}
/** Why the resolver refused, when it refused for a reason rather than an absence. */
function claudeBinWhy() { return CLAUDE_BIN_WHY; }

/* Is the target an OPEN Code session we can relay into?
 *
 * THE STORED native_ref IS A HINT, NEVER AN ADDRESS (invariant, LINKED-THREADS-SPEC I2+):
 * process-scoped addresses are never persisted OR cached, and any stored copy must be
 * validated against a live registry row at the moment of use. This function used to trust
 * the hint two ways, and both were defects:
 *   - it matched reg.sessionId === native_ref.session_id and gave up when nothing matched.
 *     A resume FORKS a new session id under the same process (probed live: the uuid changes,
 *     parentUuid null, no lineage), so after any /clear + resume no row carries
 *     the stored id and an OPEN terminal reported CLOSED — every resumed session silently
 *     degraded to a notification, which is the zero-tap path quietly dying.
 *   - worse, it then fell back to native_ref.messaging_socket_path if that path still
 *     existed on disk: a persisted process-scoped address, used with no validation at all.
 *     A recycled pid would have made it point at a stranger. Deleted, not repaired.
 *
 * NO GUESSING, EVER. A dead binding does NOT get resolved by looking for something nearby
 * that seems close enough: five live rows share this repo's cwd, and native's `name` is
 * nameSource:"derived" and differs per process, so "nearest match" would silently pick one
 * of six. Dead binding → no wake → the notify rung, honestly. That refusal is load-bearing.
 *
 * THE FORK IS HONEST PHYSICS. Because native exposes no lineage, a freshly resumed and
 * never-contacted session is genuinely unknowable from outside. The FIRST send after a
 * resume therefore cannot wake it and falls to the notification BY DESIGN; draining that
 * notification heals the binding, and the SECOND send wakes with zero taps. `candidates`
 * is reported so the caller can say WHY, never to pick from.
 */
function liveRows() {
  const rows = [];
  let files = [];
  try { files = fs.readdirSync(sessionsDir()).filter(f => f.endsWith('.json')); } catch (_) { return rows; }
  for (const f of files) {
    try {
      const reg = JSON.parse(fs.readFileSync(path.join(sessionsDir(), f), 'utf8'));
      if (!reg || !reg.sessionId) continue;
      if (reg.pid) { try { process.kill(reg.pid, 0); } catch (e) { if (e.code !== 'EPERM') continue; } }
      rows.push(reg);
    } catch (_) { /* one unreadable row must not sink the scan */ }
  }
  return rows;
}
function nativeReach(native_ref) {
  const out = { open: false, name: null, socket: null, cwd: null, reason: 'no native_ref', candidates: 0, stale_binding: false, pid: null };
  try {
    if (!native_ref || !native_ref.session_id) return out;
    /* ANOTHER DEVICE OWNS IT — and this machine cannot answer for it.
     *
     * Everything below validates the binding against THIS host: liveRows() is a readdir of the
     * local session registry plus process.kill() into the local process table. For a record that
     * declares another device, neither can ever contain it, so `bound` was always falsy and every
     * remote seat was reported `stale_binding` — permanently, from the moment it enrolled.
     *
     * That produced a sentence that was false in all three of its clauses: nothing was stale, no
     * resume had occurred, and the remedy it offered ("opening it heals the binding") is a LOOP
     * for a seat this host will never see. A correct-sounding error that leaves the caller no
     * route, and does not say so, is absorbed as a convention rather than reported as a defect —
     * two seats read it for an evening and took it for a fact about themselves.
     *
     * `peek_inbox` (handoff-tools.js:1732) already guards precisely this, with the same test. This
     * is that guard, applied in the sibling consumer that skipped it. The honest verdict for a
     * foreign record is neither open nor stale: it is NOT DETERMINABLE FROM HERE, and only the
     * owning seat may say otherwise.
     *
     * NOTE the asymmetry with an ABSENT host, which is deliberate and must stay: no host means
     * LOCAL to this store host, which is correct for a terminal on this machine and is why the
     * check is `host && host !== me` rather than a positive match. */
    const me = require('os').hostname();
    if (native_ref.host && native_ref.host !== me) {
      out.name = native_ref.name || null;
      out.cwd = native_ref.cwd || null;
      out.foreign_host = native_ref.host;
      out.reason = `owned by ${native_ref.host} — not determinable from here; only that seat can say whether it is open`;
      return out; // stale_binding stays FALSE: absence of local evidence is not evidence of death
    }
    const rows = liveRows();
    /* 1. VALIDATE THE HINT against a live row. This is the only path that can wake.
     * A uuid is NOT unique across processes: measured 2026-08-09, `/exit` followed by
     * `claude --continue` left TWO live processes registered under one
     * session id, both named "build". find() would have picked whichever the filesystem
     * listed first and relayed into a window nobody was watching — starting a turn in the
     * wrong place is worse than not starting one. Several live claimants is ambiguity, and
     * ambiguity never gets a guess. */
    const claimants = rows.filter(r => r.sessionId === native_ref.session_id);
    let bound2 = null;
    if (claimants.length > 1) {
      /* SUCCESSION WITHIN ONE IDENTITY, not ambiguity between identities. Probed live:
       * `/exit` then `claude --continue` leaves BOTH processes registered under one session
       * id, and BOTH keep heartbeating (the older one flipped idle->busy minutes after the newer started),
       * so the leftover is NOT defunct by construction and must never be killed or assumed
       * dead. But one fact does discriminate without guessing: native_ref.pid records THE
       * PROCESS THAT LAST SPOKE TO US — every tool contact refreshes it from the caller's own
       * pid. The window they are driving is the window making tool calls. If that process is
       * among the live claimants, it succeeds the others and we deliver there, saying so.
       * If it is not (they has spoken to neither, or to a process since gone), we refuse —
       * and the refusal carries the exact remedy rather than a shrug. */
      const spoke = native_ref.pid ? claimants.find(r => r.pid === native_ref.pid) : null;
      if (spoke) {
        bound2 = spoke;
        out.succeeded = claimants.filter(r => r.pid !== spoke.pid).map(r => r.pid);
      } else {
        out.name = native_ref.name || null;
        out.cwd = native_ref.cwd || null;
        out.candidates = claimants.length;
        out.remedy = claimants.map(r => `pid ${r.pid}${r.name ? ` ("${r.name}")` : ''}`).join(' and ');
        out.reason = `${claimants.length} live processes claim this session id (${out.remedy}) and none has spoken to the protocol — say anything in the window you want, and it becomes the one I deliver to`;
        return out;
      }
    }
    const bound = bound2 || claimants[0];
    if (bound) {
      const sock = bound.messagingSocketPath || null;
      out.name = bound.name || native_ref.name || null;
      out.cwd = bound.cwd || native_ref.cwd || null;
      out.socket = sock;
      // Only a VALIDATED binding yields a pid — it is what licenses the process-tree click.
      out.pid = bound.pid || null;
      if (sock && fs.existsSync(sock)) { out.open = true; out.reason = out.succeeded ? `binding validated — this process last spoke to the protocol, superseding pid(s) ${out.succeeded.join(', ')}` : 'binding validated against a live row'; }
      else { out.reason = sock ? 'registered but socket gone' : 'registered without socket'; }
      return out;
    }
    // 2. The binding is dead. Report why; never resolve it by proximity.
    out.stale_binding = true;
    out.name = native_ref.name || null;
    out.cwd = native_ref.cwd || null;
    const sameCwd = out.cwd ? rows.filter(r => r.cwd === out.cwd) : [];
    out.candidates = sameCwd.length;
    out.reason = sameCwd.length
      ? `binding stale — ${sameCwd.length} live session(s) in this workspace, refusing to guess which`
      : 'no live session for this workspace';
    return out;
  } catch (_) { return out; }
}

/**
 * The relay prompt handed to `claude -p`. It is a product-level instruction — the spawned
 * session uses native ListAgents/SendMessage; we never serialize a native frame ourselves.
 * ListAgents is the authoritative "target open" confirm (constraint); the pre-check in wake()
 * only decides relay-vs-notify.
 */
function relayPrompt(targetName, wakeLine) {
  return [
    `You are a fire-and-exit relay. Do exactly this and then stop — do not do anything else.`,
    `1. Call ListAgents.`,
    `2. Find the agent whose name is "${targetName}". If several share that name, pick the one`,
    `   matching that name and use its [ref] to disambiguate (native refuses a bare ambiguous name).`,
    `3. If and only if it is present, call SendMessage to it with this EXACT text and nothing more:`,
    `   ${wakeLine}`,
    `4. Do NOT wait for or expect a reply. If the agent is not in the list, do nothing.`,
    `Then end your turn.`,
  ].join('\n');
}

/**
 * the user-facing wake-line copy (owner-approved 2026-08-08). A wake line reads
 * like a colleague's status line, not a system event:
 *   - the WORK is the headline, in its own words (task/update/done are meanings, never labels);
 *   - Title = window name + the work in its own words;
 *   - Body = what is happening now as a person would say it, plus an action phrase ONLY when a
 *     tap does something;
 *   - plain words, no protocol vocabulary (drain/mail/envelope/store/origin/carrier).
 * NOTE: this governs the NOTIFICATION only. The relay WAKE_LINE is agent-facing (it rides a
 * native cross-session-message into the target terminal) and stays the locked verbatim text.
 *
 * delivery.kind selects the shape: 'return' (work came back), 'progress' (status, no action),
 * or the default 'message' (something is waiting for you). delivery.status, when set, is the
 * work-in-its-own-words clause the caller supplies.
 */
function notifyCopy(d) {
  const window = (d.native_ref && d.native_ref.name) || d.conversation || d.thread || 'a conversation';
  const work = d.status || d.conversation || d.thread || null;
  const head = work && work !== window ? `${window} — ${work}` : window;
  if (d.kind === 'return') {
    return { title: d.status ? `${window} — ${d.status}` : `${window} — done`, body: 'Open your chat to review it.' };
  }
  if (d.kind === 'progress') {
    return { title: head, body: '' }; // what's happening now; no tap, so no action line
  }
  /* THE REMOTE CASE NAMES THE DEVICE, because "open it" is not actionable when "it" is on the
   * other laptop. A session reached only through the shared store has no pid and no socket here,
   * so this notification is its WHOLE wake path — the copy has to be enough to act on without it.
   * It still claims nothing false: mail is waiting and where to open it, never that a turn began. */
  const where = d.device ? ` on ${d.device}` : '';
  return {
    title: `${head}${where}`,
    body: d.from ? `From ${d.from} — open that window to pick it up.` : 'Open that window to pick it up.'
  };
}

function wake(delivery, opts) {
  opts = opts || {};
  const doSpawn = opts.spawn || spawn;
  /* Rung 3. Injected so tests can observe it, defaulting to the real layer. It NEVER throws and
   * never blocks: the store write the caller already made is the durable delivery, and this is
   * the signal to the human that it is there. */
  const doNotify = opts.notify || ((ev) => { try { return require('./handoff-notify').notify(ev); } catch (_) { return { fired: false, channel: 'error' }; } });
  const reach = opts.reach || nativeReach;
  const d = delivery || {};
  const thread = d.thread || d.conversation || 'a thread';
  const wakeLine = WAKE_LINE(thread, d.from);

  const logChoice = (rec) => {
    const lp = process.env.HANDOFF_WAKE_LOG;
    if (!lp) return;
    try { fs.appendFileSync(lp, JSON.stringify(Object.assign({ at: new Date().toISOString() }, rec)) + '\n'); } catch (_) {}
  };

  try {
    if (process.env.HANDOFF_NO_WAKE) { const r = { woke: false, tier: 'disabled' }; logChoice(r); return r; }

    // fyi never wakes — the store the caller wrote is the whole delivery.
    if (d.tier !== 'attention') {
      const r = { woke: false, tier: 'skipped', reason: `tier "${d.tier || 'unset'}" does not wake (attention only)` };
      logChoice(r); return r;
    }

    // Rung 1 — channel-inject (only if the target opted in with --channels). Research-preview,
    // degrade-to-store: a missing/failed hook simply falls through to the relay.
    if (d.channels && process.env.HANDOFF_CHANNEL_HOOK) {
      try {
        doSpawn(process.env.HANDOFF_CHANNEL_HOOK, [`handoff · ${d.conversation || thread}`, wakeLine],
          { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
        const r = { woke: true, tier: 'channel', delivery: 'dispatched', line: wakeLine };
        logChoice(r); return r;
      } catch (_) { /* fall through to relay */ }
    }

    // Rung 2 — the -p relay, for an OPEN target. ListAgents (inside the relay) is the
    // authoritative confirm; this pre-check only routes relay-vs-notify.
    const rc = reach(d.native_ref);
    if (rc.open && rc.name) {
      /* CAPABILITY GATE, BEFORE THE SPAWN. Checked here rather than after, because a spawn that
       * cannot possibly deliver still costs a process and still returns 'dispatched' — the report
       * is the harm, not the spawn. Degrade to notify with the reason named, so the ladder does
       * what it does for any unreachable target and the store records WHY rather than a bare tier. */
      const cap = peerVerbsAvailable();
      if (!cap.ok) {
        const nC = doNotify(Object.assign({ conversation: d.conversation || thread, meta: { session_id: d.session_id || null, from: d.from || null, surface: d.surface || 'code', window: (d.native_ref && d.native_ref.name) || null, device: d.device || null } }, notifyCopy(d)));
        const rC = { woke: false, tier: nC && nC.fired ? 'notify' : 'store',
          reason: `relay unavailable on this platform: no peer verbs (${cap.source})`,
          notified: nC || null };
        logChoice(rC); return rC;
      }
      const model = process.env.HANDOFF_WAKE_MODEL || 'haiku';
      const bin = claudeBinPath();
      if (!bin) {
        // No relay is possible without the binary. Degrade LOUDLY and name the cause, rather
        // than fail a spawn and report a generic "closed" — this exact silence is what hid
        // the launchd-PATH defect.
        const c0 = notifyCopy(d);
        const nr0 = doNotify(Object.assign({ conversation: d.conversation || thread, meta: { session_id: d.session_id || null, from: d.from || null, surface: d.surface || 'code', window: (d.native_ref && d.native_ref.name) || null, device: d.device || null } }, notifyCopy(d)));
        const r0 = { woke: false, tier: nr0 && nr0.fired ? 'notify' : 'store',
          reason: CLAUDE_BIN_WHY
            ? `claude found but not spawnable — relay impossible: ${CLAUDE_BIN_WHY} (set HANDOFF_CLAUDE_BIN to a .exe)`
            : 'claude binary not found — relay impossible (set HANDOFF_CLAUDE_BIN)',
          notified: nr0 || null };
        logChoice(r0); return r0;
      }
      const argv = ['-p', relayPrompt(rc.name, wakeLine),
        '--model', model, '--allowedTools', 'ListAgents', 'SendMessage', '--output-format', 'text'];
      const cwd = rc.cwd || (d.native_ref && d.native_ref.cwd) || process.cwd();

      /* CI seam: record the dispatch, do not spawn a real relay.
       *
       * IT USED TO RETURN {woke:true, tier:'relay', delivery:'dispatched'} — a sentence
       * indistinguishable from a real delivery, in the tool result, in the ops log and in the
       * store. On 2026-08-10 this variable was set in the production daemon's plist by someone
       * instrumenting the wake path, and for thirty-one minutes every wake was a logged no-op
       * that reported success: five terminals never moved, no notification fired (the notify rung
       * only runs when relay DECLINES, and relay was claiming it had worked), and nothing errored.
       * The same argv run by hand from a shell worked, because a shell has no such variable.
       *
       * Two things were wrong and both are fixed here. The seam ARMED SILENTLY in production, and
       * it LIED IN THE VOCABULARY OF SUCCESS. A test double that claims delivery it did not
       * perform is a correctness bug, not a matter of taste — so the result is now self-labelling
       * and no reader, human or machine, can mistake it for a wake. */
      if (seamArmed('HANDOFF_WAKE_LOG')) {
        const r = { woke: false, seam: true, tier: 'relay-simulated', delivery: 'simulated',
          target: rc.name, model, bin, argv, cwd, line: wakeLine,
          note: 'SEAM: no process was spawned and nothing was delivered — HANDOFF_WAKE_LOG is a test double' };
        logChoice(r); return r;
      }

      // ONE call, no retries. Fire-and-forget: detach so a slow/hung relay never blocks the
      // send; on spawn error degrade to notify (we do NOT re-attempt the relay).
      /* STDIO CAPTURE — because 'ignore' is how a whole class of failure hid for a day.
       *
       * The relay one-shot runs detached with its output discarded, so a job that started,
       * looked around, found nothing and obediently did nothing is INDISTINGUISHABLE from a job
       * that delivered. On 2026-08-10 five consecutive wakes logged woke:true / dispatched while
       * no terminal moved, and the same argv run by hand from a shell worked — the difference was
       * only ever visible in output nobody was keeping.
       *
       * HANDOFF_WAKE_STDIO=<file> appends the child's stdout+stderr to a sidecar. Off by default
       * (a wake path must not accumulate files nobody asked for); on, it is the first thing to
       * reach for when dispatched-but-silent appears again. Failing to open the sidecar must never
       * cost the wake — it degrades to 'ignore' and the wake proceeds. */
      let stdio = 'ignore';
      const stdioPath = process.env.HANDOFF_WAKE_STDIO;
      if (stdioPath) {
        try {
          const fd = fs.openSync(stdioPath, 'a');
          fs.writeSync(fd, `\n=== relay spawn ${new Date().toISOString()} target=${rc.name} cwd=${cwd} bin=${bin}\n` +
            `    PATH=${process.env.PATH || '(unset)'}\n    TMPDIR=${process.env.TMPDIR || '(unset)'}\n`);
          stdio = ['ignore', fd, fd];
        } catch (_) { stdio = 'ignore'; }
      }
      try {
        const child = doSpawn(bin, argv, { cwd, detached: true, stdio });
        /* A SPAWN THAT FAILED MUST NOT REPORT AS DISPATCHED (A12, in code).
         * spawn() does NOT throw on a missing binary: it returns a child whose pid is
         * undefined and emits ENOENT asynchronously. The old code attached an empty error
         * handler — swallowing that ENOENT — and returned {tier:'relay', delivery:'dispatched'}
         * before the failure could arrive, so the catch below was unreachable for the one
         * error it existed to catch. The caller then told the sender "Started a turn … no tap
         * needed" about a process that never existed. Combined with the launchd-PATH defect
         * (38d4cab), which made the binary unresolvable on every real wake, EVERY relay claim
         * since the forwarder flip was false by construction.
         * pid is populated synchronously when the spawn actually took, so its absence is a
         * deterministic, same-tick failure signal — no race, nothing to wait for. */
        // Attach BEFORE any return: the ENOENT arrives on a later tick, and an 'error' event
        // with no listener is an unhandled throw that would take the DAEMON down. (Caught by
        // the very probe written to prove the degrade — it crashed the process.)
        if (child && typeof child.on === 'function') child.on('error', () => {});
        if (child && child.pid === undefined) {
          const cF = notifyCopy(d);
          const nrF = doNotify(Object.assign({ conversation: d.conversation || thread, meta: { session_id: d.session_id || null, from: d.from || null, surface: d.surface || 'code', window: (d.native_ref && d.native_ref.name) || null, device: d.device || null } }, notifyCopy(d)));
          const rF = { woke: false, tier: nrF && nrF.fired ? 'notify' : 'store', reason: `relay spawn failed (${bin} did not start)`, notified: nrF || null };
          logChoice(rF); return rF;
        }
        child.unref();
        /* `dispatched` is the honest word and the ONLY one we have earned: the relay is
         * detached and fire-and-forget, so we know a process started and nothing more. We do
         * NOT know that ListAgents found the target or that SendMessage delivered — so the
         * caller must not say a turn started. Effects of the current operation are verified
         * after it, or phrased as intent (A12). */
        return { woke: true, tier: 'relay', delivery: 'dispatched', confirmed: false, target: rc.name, model, line: wakeLine, note: 'no-reply-expected; one call, no retries; dispatch is not confirmation of delivery' };
      } catch (e) {
        // Could not even spawn — degrade to notify, no relay retry.
        const c = notifyCopy(d);
        const nr = doNotify(Object.assign({ conversation: d.conversation || thread, meta: { session_id: d.session_id || null, from: d.from || null, surface: d.surface || 'code', window: (d.native_ref && d.native_ref.name) || null, device: d.device || null } }, notifyCopy(d)));
        const r = { woke: false, tier: nr && nr.fired ? 'notify' : 'store', reason: 'relay spawn failed', notified: nr || null };
        logChoice(r); return r;
      }
    }

    // Rung 3 — no validated live binding: notify the user. Store (rung 4) is already durable.
    // A stale binding and a genuinely closed session BOTH land here, and they must not be
    // reported as the same thing: "closed" is a claim about the world, and after a resume it
    // would be false. stale_binding rides out so the caller can say which happened, and so
    // the two-step (this send notifies and heals; the next one wakes) is legible.
    const c = notifyCopy(d);
    const nr = doNotify(Object.assign({ conversation: d.conversation || thread, meta: { session_id: d.session_id || null, from: d.from || null, surface: d.surface || 'code', window: (d.native_ref && d.native_ref.name) || null, device: d.device || null } }, notifyCopy(d)));
    // foreign_host rides out for the same reason stale_binding does: the caller must be able to
    // say WHICH happened. Without it the note cannot distinguish "we looked and found nothing"
    // from "we were never able to look".
    const r = { woke: false, tier: nr && nr.fired ? 'notify' : 'store', reason: rc.reason, stale_binding: !!rc.stale_binding, foreign_host: rc.foreign_host || null, candidates: rc.candidates || 0, notified: nr || null };
    logChoice(r); return r;
  } catch (_) {
    // A wake failure must never break the send — the store remains the durable truth.
    return { woke: false, tier: 'error' };
  }
}

module.exports = { wake, nativeReach, relayPrompt, notifyCopy, WAKE_LINE, claudeBinPath, claudeBinWhy, probePeerVerbs, recordPeerVerbs, peerVerbsAvailable };

// CLI: node handoff-wake.js '<json-delivery>'  (thin harness for the live proof / manual runs)
if (require.main === module) {
  let d = {};
  try { d = JSON.parse(process.argv[2] || '{}'); } catch (_) { d = {}; }
  const r = wake(d);
  process.stdout.write(JSON.stringify(r) + '\n');
}
