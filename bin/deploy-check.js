#!/usr/bin/env node
'use strict';
/**
 * DEPLOY CHECK — is the code that is RUNNING the code that was COMMITTED?
 *
 * SEVEN TIMES on 2026-08-11 the answer was no, and every time it cost an investigation:
 *
 *   1. a daemon serving pre-change code from a directory nobody thought to check
 *   2. a relay serving a schema it had stopped watching
 *   3. a plugin cache outliving its own uninstall
 *   4. a client caching a tool schema through a reconnect
 *   5. a session retrying an in-memory mount whose files were deleted
 *   6. a retirement fix committed and never deployed, so ended records kept being offered
 *   7. a whoami/status schema fix on disk while the wire served the old one — which told the
 *      OPERATOR her registration had failed when it had succeeded, and she opened an
 *      investigation into a working subsystem
 *
 * Number 7 is why this file exists rather than another doctrine line. A stale HANDLER returns a
 * wrong answer somebody can read. A stale SCHEMA is worse: the client validates against it and
 * SILENTLY DELETES the undeclared arguments, so the caller, the handler and the logs all behave
 * exactly as if nothing was ever passed. Nothing anywhere reports a discarded field.
 *
 * "committed, on disk, and running are three different states, and all our verification tools read
 * the first two" — the peer that kept finding these. This reads the third.
 *
 * WHAT IT CHECKS
 *   1. every shared runtime file in the repo is byte-identical to the lane the daemon/relay run from
 *   2. the running daemon and relay booted AFTER the files they load were last modified
 *
 * WHAT IT DOES NOT CHECK, and this is the honest limit: what a CONNECTED CLIENT holds. Clients cache
 * tool schemas for the life of a session, so a green result here still means a peer may be talking
 * to a stale advertisement. Only a fetch from that peer settles that, which is why `Bridge: ✓
 * current` is a false comfort for a connector seat — it reads mcp-handoff.js, a file such a seat
 * never touches.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
/* Discovered from the running processes rather than hardcoded — the whole class exists because the
 * live lane was somewhere nobody expected. */
function runtimeLanes() {
  const lanes = new Set();
  try {
    const out = execFileSync('ps', ['-Ao', 'command'], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const m = /(\S+)\/(handoff-daemon|handoff-relay)\.js/.exec(line);
      if (m && m[1] !== REPO) lanes.add(m[1]);
    }
  } catch (_) { /* no ps: report what we can rather than pretending */ }
  return [...lanes];
}
function procs() {
  const out = [];
  try {
    const ps = execFileSync('ps', ['-Ao', 'pid,lstart,command'], { encoding: 'utf8' });
    for (const line of ps.split('\n')) {
      const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+.*?(\S+\/(handoff-daemon|handoff-relay)\.js)/.exec(line);
      if (m) out.push({ pid: Number(m[1]), started: Date.parse(m[2]), file: m[3], name: m[4] });
    }
  } catch (_) {}
  return out;
}

const SHARED = ['handoff-core.js', 'handoff-tools.js', 'handoff-tool-schemas.js', 'handoff-relay.js',
  'handoff-daemon.js', 'mcp-handoff.js', 'bin/platform-profile.js', 'bin/handoff-wake.js',
  'bin/handoff-notify.js', 'bin/handoff-store-client.js', 'bin/handoff-wake-agent.js'];

let problems = 0;
const lanes = runtimeLanes();
console.log(`deploy-check — repo: ${REPO}`);
if (!lanes.length) {
  console.log('  ? no runtime lane detected (no daemon/relay running outside this repo) — nothing to compare');
} else {
  for (const lane of lanes) {
    console.log(`\n  runtime lane: ${lane}`);
    const drifted = [];
    for (const f of SHARED) {
      const a = path.join(REPO, f), b = path.join(lane, f);
      if (!fs.existsSync(a)) continue;
      if (!fs.existsSync(b)) { drifted.push(`${f} (ABSENT from the lane)`); continue; }
      if (fs.readFileSync(a, 'utf8') !== fs.readFileSync(b, 'utf8')) drifted.push(f);
    }
    if (drifted.length) {
      problems += drifted.length;
      console.log(`    ✗ ${drifted.length} file(s) DIFFER from the repo — committed but not running:`);
      for (const f of drifted) console.log(`        ${f}`);
    } else {
      console.log('    ✓ every shared runtime file matches the repo');
    }
  }
}

/* EACH PROCESS IS JUDGED BY ITS OWN WATCH LIST, not by a convenient union of both.
 *
 * The first cut checked daemon and relay against the same set and flagged the daemon for a change
 * to handoff-tool-schemas.js — which the daemon does NOT watch, correctly, because it EXECUTES
 * tools and does not ADVERTISE them. The daemon was right and the checker was wrong, which is the
 * worst way round: a checker that reports a healthy process as broken teaches people to ignore it.
 *
 * These lists mirror RELAY_WATCHED and the daemon's WATCHED. If either changes, this changes —
 * and the mismatch that taught us so is the relay's own schema-staleness bug from earlier today. */
const WATCH = {
  'handoff-daemon': ['handoff-daemon.js', 'handoff-core.js', 'handoff-tools.js', 'handoff-contract.js'],
  'handoff-relay': ['handoff-relay.js', 'handoff-contract.js', 'handoff-tool-schemas.js'],
};
for (const p of procs()) {
  const dir = path.dirname(p.file);
  const watched = (WATCH[p.name] || [path.basename(p.file)])
    .map(f => path.join(dir, f)).filter(f => fs.existsSync(f));
  const newest = Math.max(...watched.map(f => fs.statSync(f).mtimeMs));
  /* `ps lstart` reports whole seconds while mtimeMs is millisecond-precise, so a process that
   * restarted in the SAME second as the deploy that triggered it reads as "booted first". That is
   * the normal, healthy case — exit-on-stale restarts within the second — and flagging it would
   * make this check cry wolf on every successful deploy. A checker that fires on correct behaviour
   * gets ignored, and an ignored checker is worse than none. Tolerance is one ps tick. */
  const PS_TICK_MS = 2000;
  if (newest > p.started + PS_TICK_MS) {
    problems++;
    console.log(`\n  ✗ ${p.name} (pid ${p.pid}) booted BEFORE its code was last modified — it is serving stale logic`);
    console.log(`      booted ${new Date(p.started).toISOString().slice(0, 19)}, newest file ${new Date(newest).toISOString().slice(0, 19)}`);
  } else {
    console.log(`  ✓ ${p.name} (pid ${p.pid}) booted after its newest file — running current code`);
  }
}

if (problems) {
  console.log(`\n${problems} problem(s). Deploy to the runtime lane and let the process restart, then re-run.`);
  console.log('Note: a green result here says nothing about a CONNECTED CLIENT — schemas are cached per session.');
  process.exit(1);
}
console.log('\ndeploy-check: OK — what is committed is what is running. (Connected clients may still hold cached schemas.)');
