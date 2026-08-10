#!/usr/bin/env node
'use strict';
/**
 * handoff-daemon — ONE process owns the protocol (DAEMON-SPEC.md — a design spec that lives in
 * the development lab, not in the shipped tree; see repo history).
 *
 * Owns: all logic (handoff-core, unchanged), sole store access, and — when the notification
 * layer is wired — the wake pings. Binds ONE socket we own ($HANDOFF_HOME/daemon.sock,
 * mode 0600). Per-session bridges become pure forwarders over that socket. NO new storage:
 * the store stays store/v1/ files.
 *
 * Acceptance tests (see daemon-smoke.js — lab tooling, not shipped), each a former
 * frozen-bridge gap:
 *   (a) contract version on every call — mismatch → refuse loud + forwarder exits.
 *   (b) load-safety — atomic writes (core), load in try/catch (core), and here a long-lived
 *       LAST-GOOD fallback: a reload that finds a record corrupt keeps the in-memory good
 *       copy and logs, rather than dropping it. A broken edit degrades, never crashes.
 *   (c) exit-on-stale — on-disk daemon newer than this process → refuse, report, exit so
 *       clients respawn (replaces "freeze and refuse to mutate").
 *   (d) rollout smoke — many forwarders under load across a restart, zero lost writes.
 *
 * VERIFY-AT-THE-DOOR (item 1) boundary: the control socket is mode 0600, so the OS already
 * restricts writers to this uid — that IS the security boundary. Full pid-level peer-cred
 * stamping (getpeereid / SO_PEERCRED) needs a native addon (macOS) or /proc (Linux only),
 * neither broadly-used from stdlib Node; it is an OPEN decision (DAEMON-SPEC §open). Until
 * then the daemon stamps the forwarder's DECLARED identity, labeled socket-uid-verified.
 */
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { CONTRACT } = require('./handoff-contract');

const HOME = process.env.HANDOFF_HOME || path.join(os.homedir(), '.claude-handoff');
const SOCK = process.env.HANDOFF_DAEMON_SOCK || path.join(HOME, 'daemon.sock');
const START_MS = Date.now();

let core = require('./handoff-core');
const tools = require('./handoff-tools');
// In-memory last-good cache of raw record JSON, keyed "collection/id". Feeds test (b): a
// reload that cannot parse a record restores it from here instead of losing it.
const lastGood = new Map();

/* EXIT-ON-STALE covers the daemon's WHOLE code surface, not just this file.
 *
 * It used to watch only __filename. That was defensible when the bridge held the logic and
 * hot-reloaded core on every call — but after the slice-3b migration the daemon is the sole
 * executor: handoff-core.js and handoff-tools.js ARE the protocol, and it requires both once
 * at boot and never reloads them. So editing either left the daemon serving stale logic
 * silently: no banner, no exit, no respawn, and the forwarders had no way to know.
 *
 * Found live on this machine: daemon booted 19:13:01 with handoff-core.js modified 19:50:28
 * — 37 minutes of a running daemon executing superseded core, reporting itself healthy.
 *
 * The remedy is the spec's own doctrine ("Update = restart one process"): refuse, report,
 * exit, and let launchd/systemd restart us with the new code. Deliberately NOT a hot-reload —
 * swapping modules under in-flight requests is exactly the mixed-version corruption
 * acceptance test (d) exists to forbid.
 *
 * Compare each file's mtime against the value captured at BOOT rather than against START_MS.
 * A checkout or touch that leaves a file dated in the future would satisfy `mtime > start`
 * forever and put launchd in a restart loop; "differs from what I loaded" cannot. */
const WATCHED = ['handoff-daemon.js', 'handoff-core.js', 'handoff-tools.js', 'handoff-contract.js']
  .map(f => path.join(__dirname, f));
const mtimeOf = f => { try { return fs.statSync(f).mtimeMs; } catch (_) { return 0; } };
const BOOT_MTIMES = new Map(WATCHED.map(f => [f, mtimeOf(f)]));
/** Which watched file changed since boot, if any — named so the log says what went stale. */
function staleFile() {
  for (const f of WATCHED) if (mtimeOf(f) !== BOOT_MTIMES.get(f)) return path.basename(f);
  return null;
}
function isStale() {
  if (process.env.HANDOFF_FORCE_STALE === '1') return true;
  return staleFile() !== null;
}

function nativeSessionsDir() {
  return process.env.HANDOFF_NATIVE_SESSIONS_DIR || path.join(os.homedir(), '.claude', 'sessions');
}
/**
 * VERIFY-AT-THE-DOOR (decision (i) + registry cross-check, 2026-08-08).
 * The 0600 socket already proves same-OS-user (kernel-enforced at open) — that IS the
 * security boundary; we do not read peer creds (no non-stdlib primitive; pid is not
 * identity in our model, the CLI uuid is). The one free hardening: a forwarder's DECLARED
 * cli_uuid is cross-checked against native's own registry (~/.claude/sessions/*.json). Only
 * a uuid that native knows, with a matching cwd, is stamped "verified"; anything else is
 * "asserted" (closes the lying-forwarder case with a file read), and no uuid is "anonymous".
 */
/* A SESSION ID IS A TRANSCRIPT ADDRESS. THE IDENTITY IS THE PROCESS.
 *
 * This returned the FIRST registry row matching the declared uuid, which assumed one row per
 * session. That assumption is false: `claude --continue` resumes the most recent session in a
 * DIRECTORY, so two terminals in one cwd land on the same transcript and each registers under
 * its own pid. Measured live — two distinct pids in different lanes, both alive, one
 * sessionId. Which row won depended on readdir order, so the stamp's name and cwd were
 * nondeterministic and the cwd check could compare against a process that was not calling.
 * That is how a terminal named build came to be renamed tunnel.
 *
 * The pid is the caller's own fact. It does not resolve who SHOULD own the session; it
 * resolves who is ASKING, and those are different questions. An mtime tiebreak was proposed
 * and rejected: both rows are legitimate and live, so "newest" picks a winner rather than
 * finding the truth.
 *
 * A contested answer deliberately carries NO name and NO cwd. A guessed stamp is worse than
 * no stamp — the whole finding in one line. */
function verifyIdentity(identity) {
  if (!identity || !identity.cli_uuid) return { status: 'anonymous' };
  const dir = nativeSessionsDir();
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch (_) { files = []; }
  const matches = [];
  for (const f of files) {
    let r; try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
    if (r && r.sessionId === identity.cli_uuid) matches.push(r);
  }
  if (!matches.length) return { status: 'asserted', cli_uuid: identity.cli_uuid, reason: 'not-in-native-registry' };

  // The pid resolves a contest by fact rather than by preference.
  const byPid = identity.cli_pid ? matches.find(r => r.pid === identity.cli_pid) : null;
  const row = byPid || (matches.length === 1 ? matches[0] : null);
  if (!row) {
    return {
      status: 'contested', cli_uuid: identity.cli_uuid,
      reason: 'several live processes share this session id',
      pids: matches.map(r => r.pid).filter(Boolean)
    };
  }
  // cwd is checked against the RESOLVED row, not against whichever matched first. It used to
  // ask "does any matching row disagree about cwd" when the question is "does the row that is
  // actually calling disagree". The check survives; comparing it to the wrong row does not.
  if (identity.cwd && row.cwd && row.cwd !== identity.cwd) {
    return { status: 'asserted', cli_uuid: identity.cli_uuid, reason: 'cwd-mismatch' };
  }
  return { status: 'verified', cli_uuid: identity.cli_uuid, cwd: row.cwd || null, name: row.name || null };
}

/** Load-safety reload: scan store records; a record that fails to parse is restored from
 *  last-good (if we have it) and reported — never dropped, never fatal. Returns a report. */
function reloadSafe() {
  const store = path.join(HOME, 'store', 'v1');
  const report = { ok: 0, recovered: 0, unrecoverable: 0, details: [] };
  for (const c of ['sessions', 'links']) {
    let files = [];
    try { files = fs.readdirSync(path.join(store, c)); } catch (_) { continue; }
    for (const f of files) {
      if (!f.endsWith('.json') || f.includes('.tmp.')) continue;
      const key = c + '/' + f;
      const fp = path.join(store, c, f);
      try {
        const raw = fs.readFileSync(fp, 'utf8');
        JSON.parse(raw);            // parseable → good; record last-good
        lastGood.set(key, raw);
        report.ok++;
      } catch (_) {
        if (lastGood.has(key)) {    // corrupt but we have last-good → degrade, do not drop
          report.recovered++; report.details.push({ key, action: 'kept-last-good' });
        } else {                    // corrupt and never seen good → count, but stay up
          report.unrecoverable++; report.details.push({ key, action: 'skipped-no-last-good' });
        }
      }
    }
  }
  return report;
}

/** Handle one decoded request envelope. Pure w.r.t. the socket, so tests can call directly. */
async function handleRequest(req) {
  const id = req && req.id;
  if (!req || typeof req !== 'object') return { id, error: 'malformed request', fatal: false };
  if (req.contract !== CONTRACT) {
    return { id, error: 'contract_mismatch', expected: CONTRACT, got: req.contract, fatal: true,
      note: 'forwarder must exit; Claude Code respawns a build matching the daemon' };
  }
  if (isStale()) {
    const which = staleFile();
    return { id, error: 'daemon_stale', fatal: true, stale_file: which,
      note: `${which || 'daemon code'} changed since this daemon booted; it is exiting so the ` +
            'service manager restarts it with current code, and the forwarder must exit and respawn' };
  }
  const identity = verifyIdentity(req.identity);
  // Slice 3a: tool calls carry per-session ctx (pinned, cli_uuid, cwd). The daemon is shared,
  // so ctx comes from the FORWARDER's request, never from daemon globals — that is the
  // isolation boundary the two-forwarder test guards. The verified identity stamp overrides
  // any declared cli_uuid so a forwarder cannot assert an identity native does not know.
  if (req.tool) {
    const ctx = Object.assign({ pinned: null, cwd: null }, req.ctx || {}, { cli_uuid: identity.cli_uuid || (req.ctx && req.ctx.cli_uuid) || null });
    try {
      const out = await tools.callTool(req.tool, req.args || {}, ctx, core);
      // Pin write-back (contract v2): a tool that changes the pin returns { text, ctx_update }.
      // The daemon is the sole pin writer — it echoes ctx_update; the forwarder applies it.
      if (out && typeof out === 'object' && 'text' in out) {
        return { id, ok: true, result: out.text, ctx_update: out.ctx_update || null, identity };
      }
      return { id, ok: true, result: out, identity };
    } catch (e) {
      return { id, error: e.message, fatal: false, identity };
    }
  }
  try {
    const r = await core.handleApi(req.method, req.path, req.query || {}, req.body || {});
    return { id, code: r.code, result: r.payload, identity };
  } catch (e) {
    return { id, code: e.status || 500, error: e.message, fatal: false, identity };
  }
}

function createServer() {
  try { fs.mkdirSync(HOME, { recursive: true }); } catch (_) {}
  try { fs.unlinkSync(SOCK); } catch (_) {}          // clear a stale socket file
  reloadSafe();                                       // prime last-good on boot
  const srv = net.createServer(conn => {
    let buf = '';
    conn.on('data', async d => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let req; try { req = JSON.parse(line); } catch (_) { conn.write(JSON.stringify({ error: 'bad json', fatal: false }) + '\n'); continue; }
        const res = await handleRequest(req);
        try { conn.write(JSON.stringify(res) + '\n'); } catch (_) {}
        if (res.fatal && res.error === 'daemon_stale') {
          // Say WHY on the way out — this lands in daemon.err.log, so an unexplained restart
          // in the launchd/systemd log can be traced to the exact file that changed.
          // eslint-disable-next-line no-console
          console.error(`handoff-daemon: ${res.stale_file || 'code'} changed since boot — exiting for restart with current code (pid ${process.pid})`);
          conn.end();
          setImmediate(() => { try { srv.close(); } catch (_) {} try { fs.unlinkSync(SOCK); } catch (_) {} process.exit(0); });
        }
      }
    });
    conn.on('error', () => {});
  });
  srv.listen(SOCK, () => { try { fs.chmodSync(SOCK, 0o600); } catch (_) {} });
  return srv;
}

module.exports = { CONTRACT, SOCK, isStale, reloadSafe, handleRequest, createServer, verifyIdentity };

if (require.main === module) {
  const srv = createServer();
  const shutdown = () => { try { srv.close(); } catch (_) {} try { fs.unlinkSync(SOCK); } catch (_) {} process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // eslint-disable-next-line no-console
  console.error(`handoff-daemon listening at ${SOCK} (contract ${CONTRACT}, pid ${process.pid})`);
}
