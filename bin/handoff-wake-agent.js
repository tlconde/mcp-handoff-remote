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
 *   (this machine's id is os.hostname() and is NOT configurable — see the note by HOST)
 *   HANDOFF_AGENT_INTERVAL  seconds between cycles (default 20; clamped to 5..300)
 *   HANDOFF_HOME          store location, as everywhere else
 */
const os = require('os');
const path = require('path');

/* CONFIGURATION IS LOADED EXPLICITLY, ON PURPOSE, AS THE FIRST EXECUTABLE LINE.
 *
 * This used to happen implicitly, as a load-time side effect of requiring the store client — and
 * that require sat ten lines BELOW the constants, so every value this file documents as settable
 * in .agent-env was read before the file supplying it had been loaded, and lost silently to its
 * fallback. A documented setting that never once took effect, and a peer that went blind while
 * printing healthy cycles.
 *
 * Hoisting the require would have fixed it and left the trap: the next edit that moved a constant
 * upward, or a require downward, would rearm it, and nothing at the reading site would say so. A
 * load order that is load-bearing is enforced by whitespace and a comment, which is no enforcement
 * at all. So the loader is exported and CALLED, and require order stops mattering. */
const { loadLocalEnv, makeStoreClient } = require('./handoff-store-client');
loadLocalEnv();
const transport = require('./handoff-transport');

const AGENT_VERSION = '0.1.0';
/* THE MACHINE NAMES ITSELF. HANDOFF_HOST_ID is GONE, not fixed.
 *
 * It was an override read from .agent-env, and the operator's ruling is that a peer's id is not
 * ours to dictate: the device reports what it is called and the fleet accepts it. That makes
 * os.hostname() the single source, and it makes the knob's only possible correct value equal to
 * the value the process can already compute — a setting whose right answer is "whatever it would
 * have been anyway" is not configuration, it is a spelling test with no validation.
 *
 * And it had four known spellings in flight at once for ONE machine: PEER_LAPTOP (COMPUTERNAME),
 * Peer_laptop (os.hostname()), peer-laptop (typed by hand, hyphen, would have matched nothing), and
 * windows-laptop (what a doc told the operator to write). Each one is a delivery failure that
 * looks like a healthy cycle, because a host that owns no records and a host that is misnamed
 * report identically. Removing the knob removes all four at once. */
const HOST = os.hostname();
const ONCE = process.argv.includes('--once');
const DRY = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose') || ONCE;
const INTERVAL_S = Math.min(300, Math.max(5, Number(process.env.HANDOFF_AGENT_INTERVAL) || 20));

/* THE STORE IS AN INTERFACE, NOT A FILESYSTEM. It was `require('../handoff-core')` — correct on
 * the store's own host and impossible anywhere else, which meant this agent could not run on the
 * one machine the design needed it: a second device has no store to read. The client picks local
 * or remote from the environment and this file stops knowing which it has.
 * (Both requires are hoisted above the constants — see the note there; do not move them back.) */
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

/* PEEK IS TEXT, so parse it as text — narrowly, and tolerant of everything except the two fields
 * that matter. peek_inbox renders one block per waiting conversation: a title line carrying the
 * unread count, then an indented `session_id:`. We take only those. A parser that also depended on
 * the surrounding copy would break on the next edit to a sentence, and that copy is allowed to
 * change — it is written for humans. Rows that do not yield BOTH fields are skipped rather than
 * guessed at, because a half-parsed row here would mean delivering to the wrong record. */
function parsePeekRows(text) {
  const rows = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^- "(.+?)".*?·\s*(\d+)\s+unread/);
    if (!m) continue;
    const idLine = (lines[i + 1] || '').match(/session_id:\s*(\S+)/);
    if (!idLine) continue;
    rows.push({ title: m[1], unread: Number(m[2]), session_id: idLine[1] });
  }
  return rows;
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

const reach = require('../handoff-reachability');

/* This host's verdict for one of ITS OWN sessions. Same inspect peek uses on a local record.
 * 'unknown' is never written — an agent that is running has looked. */
function verdictFor(session) {
  return reach.inspectLocal(session);
}

/** Records this host owns. Same host rule peek and heartbeat use. */
function ownedHere(s) {
  return reach.ownedHere(s, HOST);
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
      const hb = await store.heartbeat({
        host: HOST, last_seen: new Date().toISOString(), agent_version: AGENT_VERSION,
        sessions: {}, default_verdict: 'process',
      });
      /* The heartbeat's CONTENT is constant here — same host, same default verdict — so this line
       * prints once and then goes quiet. The heartbeat itself keeps firing every cycle; the store's
       * last_seen is the record of that, and it is a better one than a line in a terminal. */
      sayIfChanged(state, 'heartbeat', `heartbeat — sent for "${HOST}" with default verdict 'process' for records declaring this host`);
      /* DELIVERY, at last — the slice this agent has been deferring in a comment.
       *
       * SCOPE IS THE SAFETY, not a later claim step: we deliver ONLY for records this host just
       * asserted a verdict over. The heartbeat's reply echoes those ids (OWNED:), and they are the
       * caller's own assertion coming back — so ownership is established by the write we just made,
       * not inferred from a peek that shows this surface's records regardless of whose machine they
       * live on. Delivering to what peek shows would reach other hosts' terminals, which is the
       * exact error the own-host rule exists to prevent.
       *
       * The rung ladder is bin/handoff-wake's job, not ours: we hand it the delivery and it picks.
       * On this platform that resolves to notify — rungs 1 and 2 are unavailable on Windows
       * (measured 2026-08-10: no --channels in the build, no ListAgents even inside a spawned
       * one-shot), so the honest local rung is a notification. Nothing here claims a turn started. */
      /* The store client returns {owned, asserted} from BOTH implementations now, so this no
       * longer parses a wire format it should never have seen. It used to run String() over the
       * reply OBJECT — "[object Object]" — find no OWNED: line, and conclude it owned nothing,
       * every cycle, while the heartbeat's own reply said a record had been claimed.
       *
       * AND THE CONTRADICTION IS CHECKED RATHER THAN AVERAGED. `asserted` is the store's own
       * count; `owned` is what we could parse. If the store says it recorded verdicts for N
       * records and we hold zero ids, the parse failed — that is not a world in which we own
       * nothing, it is a world we cannot read. Saying "this host owns 0 records" there would
       * narrate a parse failure as a fact about the fleet, and it sent an operator to repair
       * records that were already correct. A value that failed to parse and a value that is
       * genuinely empty must not produce the same sentence. */
      const owned = new Set(hb && Array.isArray(hb.owned) ? hb.owned : []);
      const asserted = hb && typeof hb.asserted === 'number' ? hb.asserted : owned.size;
      if (asserted > 0 && owned.size === 0) {
        log(`⚠ CANNOT READ THE HEARTBEAT'S ANSWER: the store reports ${asserted} record(s) carry a ` +
          `host-asserted verdict, and this agent parsed 0 owned id(s) from the same reply. That is a ` +
          `contradiction, not an empty fleet — the records are NOT the thing to fix. Delivery is ` +
          `skipped this cycle rather than proceeding on the smaller number.`);
        return state;
      }
      const waitingRows = parsePeekRows(String(st.peek || ''));
      const mine = waitingRows.filter(r => owned.has(r.session_id));
      forgetKeysExcept(state, 'rec:', new Set(mine.map(r => `rec:${r.session_id}`)));
      for (const r of mine) {
        const changed = sayIfChanged(state, `rec:${r.session_id}`,
          `"${r.title}" — ${r.unread} unread → delivering locally`);
        if (!changed) continue;   // already delivered for this state; do not re-notify every cycle
        let woke = null;
        try {
          woke = require('./handoff-wake').wake({
            tier: 'attention', thread: r.title, conversation: r.title, session_id: r.session_id,
            native_ref: null, channels: false, from: 'the store', device: HOST,
          });
        } catch (e) { woke = { woke: false, tier: 'threw', error: (e && e.message) || String(e) }; }
        /* Report the RUNG, never a delivery. A notification means a human was told; it does not
         * mean anything was read, and this agent has no way to observe that it was. */
        /* THE OUTCOME IS ALWAYS STATED, INCLUDING WHEN IT IS UNKNOWN.
         *
         * This read `woke.notify`. wake() returns the notification result under `notified`. So the
         * suffix never printed — not once — and the line said only "rung: notify" while a toast
         * was genuinely appearing on a real machine. The same seam-shape disagreement as the
         * heartbeat reply, silent in the same way, found the same way: by a human watching the
         * screen and the log disagreeing.
         *
         * It is the SAFE direction of the failure — a rung earning success it did not claim,
         * rather than claiming success it did not earn — and it is still wrong, for the reason
         * this line exists: on Windows there is no delivered-list, so this log is the ONLY artifact
         * that could distinguish "fired" from "silently did nothing", and it was empty exactly
         * there. An absent suffix must never be mistaken for an absent notification. */
        const n = woke && (woke.notified || woke.notify);
        const outcome = n
          ? `, notification ${n.fired ? 'FIRED' : 'did NOT fire'} (${n.channel || 'unknown channel'})` +
            (n.fired && n.confirmed === false ? ' — appearance UNCONFIRMED, this platform offers no delivered-list; only a human can confirm it' : '')
          : ', notification outcome NOT REPORTED by the wake layer — treat as unknown, not as failure';
        log(`"${r.title}" — rung: ${(woke && woke.tier) || 'none'}${outcome}`);
      }
      /* "I OWN NOTHING" AND "I AM MISNAMED" MUST NOT PRINT THE SAME LINE.
       *
       * This printed "nothing waiting for this host" for both, and that single sentence hid a live
       * defect inside a clean run: the peer called itself os.hostname() while its records declared
       * another name, so it peeked mail addressed to the machine, matched none of it, and reported
       * an idle cycle. Correct credential, live relay, zero delivery, nothing to see.
       *
       * The discriminator is already in hand and was simply never asked for: `owned` is the set of
       * records the store just confirmed belong to this host. Owning ZERO records while mail is
       * waiting is not idleness — it is the shape of a name that matches nothing, and the agent is
       * the only thing positioned to notice, because only it knows both numbers at once.
       *
       * Deliberately NOT an error and NOT a refusal: owning nothing is legitimate on a machine
       * whose records have not been created yet. It is reported as a suspicion with both numbers
       * and the name being matched, so a human can see in one line what took an evening to find. */
      if (!mine.length) {
        if (!owned.size && waitingRows.length) {
          sayIfChanged(state, 'waiting',
            `⚠ this host owns 0 records, yet ${waitingRows.length} conversation(s) hold unread mail. ` +
            `Nothing can be delivered here. This machine calls itself "${HOST}" — if the records for ` +
            `it declare a different name, that is the cause, and the RECORDS are what to fix: the host ` +
            `id is os.hostname() and is not settable. A host that owns nothing and a host that is ` +
            `misnamed are otherwise identical from here.`);
        } else if (!owned.size) {
          sayIfChanged(state, 'waiting', `no records declare this host ("${HOST}") — nothing to own, and no mail waiting anywhere`);
        } else {
          sayIfChanged(state, 'waiting', `nothing waiting for this host (${owned.size} record(s) owned)`);
        }
      }
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

  /* THE CAPABILITY PROBE, AS THE FIRST-CYCLE JOB — ratified, and until now a manual instruction
   * inside a comment that nobody ever ran. Every machine in this fleet has therefore been running
   * on the PLATFORM DEFAULT rather than on what it actually has, which is how "peer messaging
   * cannot work on any OS" survived: the exception was never contradicted by a measurement,
   * because no measurement was ever taken.
   *
   * It belongs HERE rather than at the send site for the reason the gate's own comment gives —
   * wake() is called synchronously and must not probe inline — and it belongs to the AGENT rather
   * than to some separate tool because the agent is the thing that runs on every machine anyway.
   *
   * It costs nothing: presence of the messaging socket IS the capability, per the product docs, so
   * there is no model spawn and no token. An INCONCLUSIVE result writes nothing and leaves the
   * pessimistic default standing — erring toward refusing costs a notification the human still
   * sees, while erring toward relaying costs invisible silence. */
  const probe = require('./handoff-wake').recordPeerVerbs();
  if (probe.written) {
    log(`capability probed: peer verbs ${probe.peer_verbs ? 'AVAILABLE' : 'unavailable'} — ${probe.evidence}`);
  } else if (probe.peer_verbs === null) {
    log(`capability INCONCLUSIVE from this process — ${probe.evidence}. Nothing recorded; the pessimistic default stands.`);
  } else {
    log(`capability probe could not be recorded: ${probe.error || 'unknown'} — the default stands.`);
  }
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
