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
let CLAUDE_BIN_CACHE;
function claudeBinPath() {
  if (process.env.HANDOFF_CLAUDE_BIN) return process.env.HANDOFF_CLAUDE_BIN;
  if (CLAUDE_BIN_CACHE !== undefined) return CLAUDE_BIN_CACHE;
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const p of candidates) { try { if (fs.existsSync(p)) return (CLAUDE_BIN_CACHE = p); } catch (_) {} }
  try {
    const found = require('child_process')
      .execFileSync('which', ['claude'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (found) return (CLAUDE_BIN_CACHE = found);
  } catch (_) { /* not on this PATH either */ }
  return (CLAUDE_BIN_CACHE = null);
}

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
    const rows = liveRows();
    /* 1. VALIDATE THE HINT against a live row. This is the only path that can wake.
     * A uuid is NOT unique across processes: measured 2026-08-09, `/exit` followed by
     * `claude --continue` left TWO live processes (38088 and 87920) registered under one
     * session id, both named "build". find() would have picked whichever the filesystem
     * listed first and relayed into a window nobody was watching — starting a turn in the
     * wrong place is worse than not starting one. Several live claimants is ambiguity, and
     * ambiguity never gets a guess. */
    const claimants = rows.filter(r => r.sessionId === native_ref.session_id);
    let bound2 = null;
    if (claimants.length > 1) {
      /* SUCCESSION WITHIN ONE IDENTITY, not ambiguity between identities. Probed live:
       * `/exit` then `claude --continue` leaves BOTH processes registered under one session
       * id, and BOTH keep heartbeating (38088 flipped idle->busy minutes after 87920 started),
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
      const model = process.env.HANDOFF_WAKE_MODEL || 'haiku';
      const bin = claudeBinPath();
      if (!bin) {
        // No relay is possible without the binary. Degrade LOUDLY and name the cause, rather
        // than fail a spawn and report a generic "closed" — this exact silence is what hid
        // the launchd-PATH defect.
        const c0 = notifyCopy(d);
        const nr0 = doNotify(Object.assign({ conversation: d.conversation || thread, meta: { session_id: d.session_id || null, from: d.from || null, surface: d.surface || 'code', window: (d.native_ref && d.native_ref.name) || null, device: d.device || null } }, notifyCopy(d)));
        const r0 = { woke: false, tier: nr0 && nr0.fired ? 'notify' : 'store', reason: 'claude binary not found — relay impossible (set HANDOFF_CLAUDE_BIN)', notified: nr0 || null };
        logChoice(r0); return r0;
      }
      const argv = ['-p', relayPrompt(rc.name, wakeLine),
        '--model', model, '--allowedTools', 'ListAgents', 'SendMessage', '--output-format', 'text'];
      const cwd = rc.cwd || (d.native_ref && d.native_ref.cwd) || process.cwd();

      // CI seam: record the dispatch, do not spawn a real relay.
      if (process.env.HANDOFF_WAKE_LOG) {
        const r = { woke: true, tier: 'relay', delivery: 'dispatched', target: rc.name, model, bin, argv, cwd, line: wakeLine, note: 'no-reply-expected; one call, no retries' };
        logChoice(r); return r;
      }

      // ONE call, no retries. Fire-and-forget: detach so a slow/hung relay never blocks the
      // send; on spawn error degrade to notify (we do NOT re-attempt the relay).
      try {
        const child = doSpawn(bin, argv, { cwd, detached: true, stdio: 'ignore' });
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
    const r = { woke: false, tier: nr && nr.fired ? 'notify' : 'store', reason: rc.reason, stale_binding: !!rc.stale_binding, candidates: rc.candidates || 0, notified: nr || null };
    logChoice(r); return r;
  } catch (_) {
    // A wake failure must never break the send — the store remains the durable truth.
    return { woke: false, tier: 'error' };
  }
}

module.exports = { wake, nativeReach, relayPrompt, notifyCopy, WAKE_LINE };

// CLI: node handoff-wake.js '<json-delivery>'  (thin harness for the live proof / manual runs)
if (require.main === module) {
  let d = {};
  try { d = JSON.parse(process.argv[2] || '{}'); } catch (_) { d = {}; }
  const r = wake(d);
  process.stdout.write(JSON.stringify(r) + '\n');
}
