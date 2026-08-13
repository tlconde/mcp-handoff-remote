'use strict';
/**
 * REACHABILITY — one implementation. Peek, wake, and the wake agent are adapters.
 *
 * Vocabulary (CONTEXT.md): process | stale-binding | none | unknown.
 * unknown = nobody looked recently. It is never none (the owning host looked and found nothing).
 *
 * A pid is only meaningful on the machine whose process table it belongs to. This host may
 * inspect its own records. Another host's records are read from that host's heartbeat, or
 * they stay unknown.
 *
 * native_ref is inspectable-here, not "I exist" (rec 1). Owner host is remote.host first,
 * then native_ref.host.
 */
const os = require('os');

const HEARTBEAT_STALE_MS = 3 * 30 * 1000;
const VERDICTS = Object.freeze(['process', 'stale-binding', 'none', 'unknown']);

function hostname() {
  return os.hostname();
}

function declaredHost(session) {
  if (!session) return null;
  if (session.remote && session.remote.host) return String(session.remote.host);
  if (session.native_ref && session.native_ref.host) return String(session.native_ref.host);
  return null;
}

function foreignHost(host, here) {
  const me = here || hostname();
  return !!(host && host !== me);
}

/** This host owns the record. A declared host must match. Hostless is local only when a native_ref exists. */
function ownedHere(session, here) {
  if (!session || session.archived) return false;
  const h = declaredHost(session);
  if (h) return h === (here || hostname());
  return !!(session.native_ref && session.native_ref.session_id);
}

function agentVerdict(host, recordId, st, nowMs) {
  const beat = (st && st.agents && st.agents[host]) || null;
  if (!beat || !beat.last_seen) return 'unknown';
  const age = (nowMs != null ? nowMs : Date.now()) - Date.parse(beat.last_seen);
  if (!(age >= 0) || age > HEARTBEAT_STALE_MS) return 'unknown';
  const v = recordId && beat.sessions && beat.sessions[recordId];
  return v || 'unknown';
}

function inspectLocal(session, kill) {
  const nr = session && session.native_ref;
  if (!nr) return 'none';
  if (!nr.pid) return 'stale-binding';
  const probe = kill || ((pid, sig) => process.kill(pid, sig));
  try { probe(nr.pid, 0); return 'process'; }
  catch (e) { return e.code === 'EPERM' ? 'process' : 'stale-binding'; }
}

/**
 * This host's read of a record's reachability. Never probes another machine's pid.
 * Control flow matches the previous peek copy so existing tests stay honest.
 */
function of(session, st, opts) {
  opts = opts || {};
  const here = opts.hostname || hostname();
  const nr = session && session.native_ref;
  const remoteHost = session && session.remote && session.remote.host;
  if (!nr) return remoteHost ? agentVerdict(remoteHost, session.id, st, opts.now) : 'none';
  if (!nr.host || nr.host === here) return inspectLocal(session, opts.kill);
  return agentVerdict(nr.host, session.id, st, opts.now);
}

module.exports = {
  HEARTBEAT_STALE_MS,
  VERDICTS,
  hostname,
  declaredHost,
  foreignHost,
  ownedHere,
  agentVerdict,
  inspectLocal,
  of,
};
