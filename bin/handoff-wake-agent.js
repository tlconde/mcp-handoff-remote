#!/usr/bin/env node
'use strict';
/**
 * WAKE AGENT — one per machine. Watches the shared store and delivers locally.
 *
 * WHY PER MACHINE, and this is the correction that shaped everything else. The first design routed
 * cross-device traffic through one daemon on the store's host. That was wrong for a sharper reason
 * than "single point of failure": THE STORE NEEDS NO RELAY AT ALL. It is already reachable from
 * every device — filesystem-direct on its own host, over the authenticated relay from anywhere
 * else. Only the WAKE LEG is local, because every supported injection point is local by
 * construction: a session's inbox socket is bound on its own machine, and a channel pushes into a
 * session running where the channel runs. So state is shared and delivery is local, and no host is
 * special.
 *
 * WHAT IT DOES, once per cycle:
 *   1. peek — read what is waiting WITHOUT consuming it. Never check_inbox: that marks messages
 *      read and is scoped to a whole surface, so polling it would drain conversations the agent is
 *      only watching. Measured 2026-08-09: one inbox check consumed an envelope AND its nudge on a
 *      conversation they were addressed to, which would have found an empty inbox and never known.
 *   2. deliver — for targets THIS host owns and can reach, hand the delivery to the transport
 *      registry. The registry decides the leg; this file does not re-derive it.
 *   3. heartbeat — write this host's own verdict for its own sessions into the agents collection.
 *      Liveness is asserted only by the agent on the record's own host; nothing else may infer it.
 *      A pid means nothing on another machine.
 *
 * WHY POLLING AND NOT PUSH: the store is a filesystem on one host and an HTTP MCP surface from
 * anywhere else. Neither pushes. The platform's own answer here is the same — Remote Control
 * "registers with the Anthropic API and polls for work". A since-cursor keeps repeat polls cheap
 * enough that the interval stops being load-bearing.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   - It never claims a delivery it cannot evidence. The transport contract returns
 *     { delivered, held, evidence, reason } and this agent reports all four rather than collapsing
 *     them into success. `held` exists because a receiver can withhold a message from its Claude,
 *     and a leg that reports held as delivered is reporting mail no one will read.
 *   - It never writes a verdict for a host other than its own.
 *   - It never marks anything read. Draining belongs to the reader.
 *
 * FIRST RUN IS A FOREGROUND COMMAND ON PURPOSE. It prints every cycle, every verdict and every
 * heartbeat write, so the first flip of a remote record from 'unknown' to a host-asserted verdict
 * is watched rather than inferred from the store afterwards. Making it a managed service comes
 * after it has been seen to work once.
 *
 * Usage:
 *   node bin/handoff-wake-agent.js --once        one cycle, print what it would do, exit
 *   node bin/handoff-wake-agent.js               poll forever (Ctrl-C to stop) — QUIET by default
 *   node bin/handoff-wake-agent.js --dry-run     never deliver; peek and heartbeat only
 *   node bin/handoff-wake-agent.js --verbose     narrate every cycle, unchanged or not
 *
 * OUTPUT CONTRACT: quiet by default. Startup prints two lines (version/interval, store). After
 * that a line appears only when something CHANGES — a verdict flips, mail arrives or clears, the
 * peek line differs, the store becomes unreachable — plus every error and every recovery. An
 * unchanged cycle prints NOTHING. Absence of output is not a claim that anything happened; the
 * store's last_seen is the record that the heartbeat fired, and it is a better one than a line
 * nobody reads. --once implies --verbose, because a single watched cycle is asking to see it all.
 *
 * Env:
 *   HANDOFF_HOST_ID       this machine's id in the store (default: os.hostname())
 *   HANDOFF_AGENT_INTERVAL  seconds between cycles (default 20; clamped to 5..300)
 *   HANDOFF_HOME          store location, as everywhere else
 */
const os = require('os');
const path = require('path');

const AGENT_VERSION = '0.1.0';
const HOST = process.env.HANDOFF_HOST_ID || os.hostname();
const ONCE = process.argv.includes('--once');
const DRY = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose') || ONCE;
const INTERVAL_S = Math.min(300, Math.max(5, Number(process.env.HANDOFF_AGENT_INTERVAL) || 20));

/* THE STORE IS AN INTERFACE, NOT A FILESYSTEM. It was `require('../handoff-core')` — correct on
 * the store's own host and impossible anywhere else, which meant this agent could not run on the
 * one machine the design needed it: a second device has no store to read. The client picks local
 * or remote from the environment and this file stops knowing which it has. */
const { makeStoreClient } = require('./handoff-store-client');
const transport = require('./handoff-transport');
let store; // built in main(), so a misconfiguration is one sentence rather than a stack trace

const log = (...a) => console.log(`[wake-agent ${HOST}]`, ...a);

/* QUIET BY DEFAULT — a monitor that narrates its no-ops is a monitor nobody reads.
 *
 * This agent printed two to four lines EVERY cycle ("heartbeat — N record(s) owned", "nothing
 * waiting") whether or not anything had changed, which at the default 20s interval is a terminal
 * filling with the word "nothing" all day. The operator's terminal is where those lines land.
 *
 * The honesty rule is untouched, and it is worth being precise about why: silence here is not a
 * claim that anything happened. Every STATE CHANGE prints, every error prints, and a recovery
 * after failure prints — so there is no quiet in which a lie could hide. What stops printing is
 * the restatement of an unchanged world. `vlog` is the per-cycle narration, kept for --verbose
 * and implied by --once, because a watched first run is exactly where seeing every step is the
 * point (the operator package's step 4).
 *
 * Errors go through `log`, never `vlog`. If that inverts, the quiet becomes a lying quiet. */
const vlog = (...a) => { if (VERBOSE) log(...a); };

/* ONE LINE PER CHANGED THING, keyed by what the line is ABOUT rather than by its text — so a
 * heartbeat line that changes only its record count re-prints, and one that is word-for-word what
 * the operator already read does not. Under --verbose every call prints, unconditionally.
 *
 * `said` lives on the cycle state, not in a module global, because --once builds a fresh state and
 * must narrate its single cycle in full rather than inherit somebody's memory of a quiet world. */
function sayIfChanged(state, key, line) {
  state.said = state.said || {};
  const changed = state.said[key] !== line;
  state.said[key] = line;
  if (changed) log(line); else vlog(line);
  return changed;
}

/* The verdict VALUES, stable-ordered so an unchanged world produces an unchanged string and a
 * single flip produces a different one. Counts alone would hide the event this agent exists to
 * report: one record going process → stale-binding while another goes the other way keeps every
 * count identical. */
function signatureOfVerdicts(verdicts) {
  const vals = Object.keys(verdicts).sort().map(k => `${k}=${verdicts[k]}`);
  return vals.length ? vals.join(' ') : '(no verdicts)';
}

/* A key that is no longer being spoken about must be FORGOTTEN, or a record that goes quiet and
 * later returns to the same state would stay silent on its return — the second appearance is a
 * state change and has to print. */
function forgetKeysExcept(state, prefix, keep) {
  if (!state.said) return;
  for (const k of Object.keys(state.said)) {
    if (k.startsWith(prefix) && !keep.has(k)) delete state.said[k];
  }
}

/** Is this pid alive HERE? Only ever asked about records this host owns. */
function aliveHere(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/* This host's verdict for one of ITS OWN sessions. The vocabulary is the same four values peek
 * reports, and the honesty rule is the same: 'none' means this host looked and found nothing,
 * which only this host is entitled to say. 'unknown' is never written — an agent that is running
 * has looked, so it always has a real answer for its own records. */
function verdictFor(session) {
  const nr = session.native_ref;
  if (!nr) return 'none';
  return aliveHere(nr.pid) ? 'process' : 'stale-binding';
}

/** Records this host owns: a native_ref bound here, or a remote record naming this host. */
function ownedHere(s) {
  if (s.archived) return false;
  const nr = s.native_ref;
  if (nr) return !nr.host || nr.host === HOST;
  return !!(s.remote && s.remote.host === HOST);
}

async function cycle(state) {
  const st = await store.getState();
  if (st.sessions === null) {
    /* A remote agent cannot enumerate, but it MUST still heartbeat — the verdict is the whole
     * point, and returning early here would have shipped an agent that peeks and never speaks.
     * It sends ONE verdict for its own records and the store expands it; this host is running and
     * has looked, so 'process' is what it honestly observed of itself. */
    sayIfChanged(state, 'mode', `remote store — cannot enumerate (${(st.unavailable || []).join('; ')}); peeking and asserting one verdict for this host's records.`);
    sayIfChanged(state, 'peek', `peek says: ${String(st.peek || '').split('\n')[0] || '(nothing waiting)'}`);
    if (!DRY) {
      await store.heartbeat({
        host: HOST, last_seen: new Date().toISOString(), agent_version: AGENT_VERSION,
        sessions: {}, default_verdict: 'process',
      });
      /* The heartbeat's CONTENT is constant here — same host, same default verdict — so this line
       * prints once and then goes quiet. The heartbeat itself keeps firing every cycle; the store's
       * last_seen is the record of that, and it is a better one than a line in a terminal. */
      sayIfChanged(state, 'heartbeat', `heartbeat — sent for "${HOST}" with default verdict 'process' for records declaring this host`);
    } else {
      sayIfChanged(state, 'heartbeat', 'heartbeat — skipped (dry-run)');
    }
    return state;
  }
  const sessions = Object.values(st.sessions || {});
  const mine = sessions.filter(ownedHere);

  /* HEARTBEAT FIRST, and deliberately so. If delivery throws or a leg hangs, the store should
   * still carry a fresh verdict for this host — otherwise a busy agent looks like a dead one and
   * every record it owns silently ages into 'unknown'. Liveness reporting must not depend on
   * delivery succeeding. */
  /* Keyed by PROTOCOL RECORD ID so a record with no native_ref — which is every remote record —
   * can still be answered for. Keying by native_ref.session_id meant heartbeats could never speak
   * about the records they exist for. */
  const verdicts = {};
  for (const s of mine) verdicts[s.id] = verdictFor(s);
  const beat = {
    id: HOST, host: HOST,
    last_seen: new Date().toISOString(),
    agent_version: AGENT_VERSION,
    sessions: verdicts,
    owns: mine.length,
  };
  if (!DRY) await store.heartbeat(beat);
  /* Keyed on the VERDICT VALUES, not on the fact a heartbeat fired: the beat goes out every cycle
   * regardless, and saying so every cycle is the noise. A verdict flipping is the event. */
  sayIfChanged(state, 'heartbeat',
    `heartbeat — ${mine.length} record(s) owned, ${Object.keys(verdicts).length} with a verdict${DRY ? ' (dry-run, not written)' : ''} · ${signatureOfVerdicts(verdicts)}`);

  /* PEEK, never check_inbox. Counts and addresses only; the text belongs to its reader. */
  const waiting = mine.filter(s => (s.messages || []).some(m => !m.read_at && (m.kind === 'xmsg' || m.kind === 'resume_summary')));
  if (!waiting.length) {
    forgetKeysExcept(state, 'rec:', new Set());
    sayIfChanged(state, 'waiting', 'nothing waiting');
    return state;
  }
  /* Records that have stopped waiting are forgotten, so the same record waiting again later
   * prints again — its return IS a change, even to a state it held before. */
  forgetKeysExcept(state, 'rec:', new Set(waiting.map(s => `rec:${s.id}`)));
  state.said && delete state.said.waiting;

  for (const s of waiting) {
    const unread = (s.messages || []).filter(m => !m.read_at && (m.kind === 'xmsg' || m.kind === 'resume_summary')).length;
    const reach = verdictFor(s);
    const leg = transport.rungNames().find(n => n !== 'store'); // registry order; store is the floor
    if (reach !== 'process') {
      /* No local process answers for it. Say which of the four it is rather than "unreachable":
       * 'stale-binding' and 'none' are different facts and the second is not a failure. */
      sayIfChanged(state, `rec:${s.id}`, `"${s.title}" — ${unread} unread, reachable: ${reach} → no local leg; the store already holds it`);
      continue;
    }
    if (DRY) { sayIfChanged(state, `rec:${s.id}`, `"${s.title}" — ${unread} unread, reachable: process → would deliver via ${leg} (dry-run)`); continue; }
    sayIfChanged(state, `rec:${s.id}`, `"${s.title}" — ${unread} unread, reachable: process → deliverable via ${leg}`);
    /* Delivery itself is the next slice: it hands off to bin/handoff-wake, which owns the rung
     * order and already reports held-vs-delivered. Wiring it here without the claim step below
     * would deliver to records whose binding this agent has not verified, so it waits. */
  }
  return state;
}

async function main() {
  log(`starting — version ${AGENT_VERSION}, interval ${INTERVAL_S}s${ONCE ? ', single cycle' : ''}${DRY ? ', DRY RUN' : ''}`);
  /* A misconfigured agent stops with ONE readable sentence. The client refuses to build without a
   * credential — correct, and an operator should not meet that as a stack trace at require time. */
  try { store = makeStoreClient(); }
  catch (e) { log('cannot start:', (e && e.message) || e); process.exit(1); }
  log(`store: ${store.describe()}`);
  /* A remote agent cannot enumerate, so it must say so rather than report a quiet cycle over an
   * empty list. sessions:null means "cannot enumerate"; {} would mean "none exist", and reading
   * one as the other is how an agent looks healthy while doing nothing. */
  let state = {};
  let failing = false;
  for (;;) {
    /* FAILURE IS ALWAYS LOUD, and so is RECOVERY. Quiet-by-default applies to an unchanged healthy
     * world only: an agent that fell over and got up again without saying so would be exactly the
     * silence the honesty rules exist to forbid. */
    try {
      state = await cycle(state);
      if (failing) { failing = false; log('recovered — cycle completed after failure'); }
    } catch (e) {
      failing = true;
      log('cycle failed (continuing):', (e && e.message) || e);
    }
    if (ONCE) return;
    await new Promise(r => setTimeout(r, INTERVAL_S * 1000));
  }
}

if (require.main === module) main().catch(e => { log('fatal:', e && e.message); process.exit(1); });
module.exports = { verdictFor, ownedHere, AGENT_VERSION };
