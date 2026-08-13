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
 * Number 7 is why this file exists rather than another doctrine line. It was an ordinary stale
 * HANDLER on the runtime lane: the argument was declared, was sent, arrived, and met old code that
 * did not look for it. The visible kind of drift — it returned a wrong answer and a peer read it.
 *
 * A CORRECTION IS RECORDED HERE BECAUSE THIS FILE ONCE CARRIED THE WRONG STORY. It claimed the
 * cause was a stale SCHEMA, with the client silently deleting an undeclared argument under
 * additionalProperties:false. That reasoning may well be sound — an undeclared field really would
 * be dropped with nothing to read afterwards, which really would be worse — but IT IS NOT WHAT
 * HAPPENED, and no instance of it has ever been observed here. The peer that supplied the
 * measurement re-read its own tool output, found the schema had declared the field all along, and
 * retracted. An unobserved failure mode written up as a worked example is exactly the overclaim
 * this project exists to refuse, so it is a hypothesis until something measures it.
 *
 * WHAT SURVIVES UNCHANGED, because a clean before/after on the identical call proves it: same
 * arguments, same client, same route, same schema, and only the deploy differed —
 *   pre-deploy:  status {surface, cli_uuid, cli_pid} → "You are: unidentified"
 *   post-deploy: same call                           → "You are: lulu"
 * committed/on-disk/running drift was the real cause, and it is what this file checks.
 *
 * "committed, on disk, and running are three different states, and all our verification tools read
 * the first two" — the peer that kept finding these. This reads the third.
 *
 * WHAT IT CHECKS
 *   1. every shared runtime file in the repo is byte-identical to the lane the daemon/relay run from
 *   2. the running daemon and relay booted AFTER the files they load were last modified
 *   3. tools/list on a FRESH mcp-handoff process lists session_uuid on whoami and
 *      register_remote_session. plugin.json is not this door. A connected client's cached
 *      list is still not this door.
 *
 * WHAT IT DOES NOT CHECK, and this is the honest limit: what a CONNECTED CLIENT holds. Clients cache
 * tool schemas for the life of a session, so a green result here still means a peer may be talking
 * to a stale advertisement. Only a fetch from that peer settles that, which is why `Bridge: ✓
 * current` is a false comfort for a connector seat — it reads mcp-handoff.js, a file such a seat
 * never touches.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

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

/* THE LAUNCH DOOR. plugin.json can read 0.1.3 while a live process still advertises the old
 * whoami. Callers learn the schema from tools/list, so that list on a process that just started
 * is the claim. A connected session may still hold a cached copy — this does not settle that. */
function mcpDoors() {
  const doors = new Set();
  doors.add(path.join(REPO, 'mcp-handoff.js'));
  for (const lane of lanes) {
    const p = path.join(lane, 'mcp-handoff.js');
    if (fs.existsSync(p)) doors.add(fs.realpathSync(p));
  }
  try {
    const out = execFileSync('ps', ['-Ao', 'command'], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const m = /(\S+)\/mcp-handoff\.js/.exec(line);
      if (m) {
        const p = m[1] + '/mcp-handoff.js';
        if (fs.existsSync(p)) doors.add(fs.realpathSync(p));
      }
    }
  } catch (_) { /* no ps: still measure the repo door */ }
  return [...doors];
}

function toolsList(mcpJs) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-check-list-'));
  const payload = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'deploy-check', version: '0' } } },
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
  ].map(x => JSON.stringify(x)).join('\n') + '\n';
  const env = Object.assign({}, process.env, {
    HANDOFF_HOME: home,
    HANDOFF_ROLE: 'host',
    HANDOFF_NO_CLI: '1',
    HANDOFF_NO_AUTORECEIPT: '1',
    HANDOFF_NO_AUTOOPEN: '1',
    HANDOFF_TEST: '1'
  });
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_PID;
  delete env.HANDOFF_SESSION_ID;
  const r = spawnSync(process.execPath, [mcpJs], {
    input: payload, encoding: 'utf8', timeout: 20000, env
  });
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* scratch */ }
  if (r.error) return { error: r.error.message };
  if (r.status !== 0 && !r.stdout) return { error: `exit ${r.status}${r.stderr ? ': ' + r.stderr.trim() : ''}` };
  let listed = null;
  for (const line of String(r.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id === 1) listed = msg;
    } catch (_) { /* ignore non-JSON banners */ }
  }
  if (!listed) return { error: 'fresh process produced no tools/list reply' };
  if (listed.error) return { error: listed.error.message || JSON.stringify(listed.error) };
  return { tools: ((listed.result || {}).tools) || [] };
}

function sessionUuidDoor(tools, name) {
  const t = (tools || []).find(x => x.name === name);
  if (!t) return { ok: false, detail: `${name} not advertised` };
  const schema = t.inputSchema || t.input_schema || {};
  const props = schema.properties || {};
  if (!props.session_uuid) return { ok: false, detail: `${name} has no session_uuid property` };
  if (name === 'register_remote_session') {
    const req = schema.required || [];
    if (!req.includes('session_uuid')) return { ok: false, detail: `${name}.session_uuid is optional — required for the 0.1.3 door` };
  }
  return { ok: true, detail: `${name}.session_uuid listed` };
}

let pluginVer = null;
try { pluginVer = JSON.parse(fs.readFileSync(path.join(REPO, 'plugin.json'), 'utf8')).version; } catch (_) {}
console.log(`\n  plugin.json version: ${pluginVer || '(unreadable)'} — not a launch claim. tools/list on a fresh process is.`);

const doors = mcpDoors();
let listProblems = 0;
if (!doors.length) {
  problems++;
  listProblems++;
  console.log('  ✗ no mcp-handoff.js to tools/list — cannot claim the session_uuid door');
} else {
  for (const door of doors) {
    const listed = toolsList(door);
    console.log(`\n  tools/list (fresh process) ${door}`);
    if (listed.error) {
      problems++;
      listProblems++;
      console.log(`    ✗ ${listed.error}`);
      continue;
    }
    for (const name of ['whoami', 'register_remote_session']) {
      const gate = sessionUuidDoor(listed.tools, name);
      if (gate.ok) console.log(`    ✓ ${gate.detail}`);
      else {
        problems++;
        listProblems++;
        console.log(`    ✗ ${gate.detail}`);
      }
    }
  }
}

if (problems) {
  console.log(`\n${problems} problem(s). Deploy to the runtime lane and let the process restart, then re-run.`);
  if (listProblems) console.log('Do not claim 0.1.3 until a fresh tools/list lists session_uuid.');
  else console.log('Fresh tools/list listed session_uuid. Remaining problems are file/process freshness, not that door.');
  console.log('Note: a green result here says nothing about a CONNECTED CLIENT — schemas are cached per session.');
  process.exit(1);
}
console.log('\ndeploy-check: OK — files match, processes are current, and a fresh tools/list lists session_uuid.');
console.log('Claim the list, not plugin.json. (Connected clients may still hold cached schemas.)');
