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
 *   node bin/handoff-wake-agent.js               poll forever (Ctrl-C to stop)
 *   node bin/handoff-wake-agent.js --dry-run     never deliver; peek and heartbeat only
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
const INTERVAL_S = Math.min(300, Math.max(5, Number(process.env.HANDOFF_AGENT_INTERVAL) || 20));

const core = require('../handoff-core');
const transport = require('./handoff-transport');

const log = (...a) => console.log(`[wake-agent ${HOST}]`, ...a);

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
  const st = (await core.handleApi('GET', '/api/state', {}, {})).payload;
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
  if (!DRY) await core.handleApi('POST', '/api/agents/heartbeat', {}, beat);
  log(`heartbeat — ${mine.length} record(s) owned, ${Object.keys(verdicts).length} with a verdict${DRY ? ' (dry-run, not written)' : ''}`);

  /* PEEK, never check_inbox. Counts and addresses only; the text belongs to its reader. */
  const waiting = mine.filter(s => (s.messages || []).some(m => !m.read_at && (m.kind === 'xmsg' || m.kind === 'resume_summary')));
  if (!waiting.length) { log('nothing waiting'); return state; }

  for (const s of waiting) {
    const unread = (s.messages || []).filter(m => !m.read_at && (m.kind === 'xmsg' || m.kind === 'resume_summary')).length;
    const reach = verdictFor(s);
    const leg = transport.rungNames().find(n => n !== 'store'); // registry order; store is the floor
    if (reach !== 'process') {
      /* No local process answers for it. Say which of the four it is rather than "unreachable":
       * 'stale-binding' and 'none' are different facts and the second is not a failure. */
      log(`"${s.title}" — ${unread} unread, reachable: ${reach} → no local leg; the store already holds it`);
      continue;
    }
    if (DRY) { log(`"${s.title}" — ${unread} unread, reachable: process → would deliver via ${leg} (dry-run)`); continue; }
    log(`"${s.title}" — ${unread} unread, reachable: process → deliverable via ${leg}`);
    /* Delivery itself is the next slice: it hands off to bin/handoff-wake, which owns the rung
     * order and already reports held-vs-delivered. Wiring it here without the claim step below
     * would deliver to records whose binding this agent has not verified, so it waits. */
  }
  return state;
}

async function main() {
  log(`starting — version ${AGENT_VERSION}, interval ${INTERVAL_S}s${ONCE ? ', single cycle' : ''}${DRY ? ', DRY RUN' : ''}`);
  log(`store: ${process.env.HANDOFF_HOME || path.join(os.homedir(), '.claude-handoff')}`);
  let state = {};
  for (;;) {
    try { state = await cycle(state); }
    catch (e) { log('cycle failed (continuing):', (e && e.message) || e); }
    if (ONCE) return;
    await new Promise(r => setTimeout(r, INTERVAL_S * 1000));
  }
}

if (require.main === module) main().catch(e => { log('fatal:', e && e.message); process.exit(1); });
module.exports = { verdictFor, ownedHere, AGENT_VERSION };
