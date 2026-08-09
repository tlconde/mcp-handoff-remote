#!/usr/bin/env node
'use strict';
/**
 * Daemon acceptance tests (a)–(d) from DAEMON-SPEC.md. Serverless where possible (call the
 * daemon's exported handlers directly); one real socket round-trip proves the forwarder
 * wire. Uses a throwaway HANDOFF_HOME so it never touches the live store.
 */
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Side-effect isolation (3b-6). The migrated CLOSE is the first daemon-smoke path that
// settles a real link, and settling can auto-launch a CLI / fire a notification / drive the
// wake relay. Unset, those fire for real and the close never answers — which is exactly how
// this suite first hung. mcp-smoke has always set these; the daemon suite needs them now
// that it drives the same write paths. Applies to in-process handlers AND spawned daemons,
// which inherit process.env.
process.env.HANDOFF_NO_CLI = '1';
process.env.HANDOFF_NO_AUTORECEIPT = '1';
process.env.HANDOFF_NO_AUTOOPEN = '1';
process.env.HANDOFF_WAKE_LOG = path.join(os.tmpdir(), 'hdaemon-wake-' + process.pid + '.log');
// Fixture isolation, same t7 leak class mcp-smoke guards: localCodeSessions (migrated in
// 3b-5, and continue_from's ambiguity check) scans ~/.claude/projects. Left unset, the
// DEVELOPER'S real transcripts decide test outcomes — this suite genuinely failed because a
// session transcript happened to contain a title word the test also used. Point it at an
// empty dir so ambiguity means what the STORE says, not what is on someone's laptop.
fs.mkdirSync(process.env.CLAUDE_PROJECTS_DIR = path.join(os.tmpdir(), 'hdaemon-ccproj-' + process.pid), { recursive: true });

let passed = 0, failed = 0;
const ok = (c, n) => { c ? (passed++, console.log('  ✓', n)) : (failed++, console.log('  ✗ FAIL:', n)); };
const tmpHome = () => { const h = path.join(os.tmpdir(), 'hdaemon-' + Date.now() + '-' + Math.floor(process.hrtime()[1] % 1e6)); fs.mkdirSync(h, { recursive: true }); return h; };

/* Spawned-daemon registry + guaranteed reaping.
 *
 * This suite spawns real daemons. Per-block `dae.kill()` is not enough: a block that throws
 * (or a runner-level timeout) skips its own cleanup, and SIGTERM alone lost the race on
 * fast-exiting runs. Real leak, found live — three orphaned daemons on this machine, two
 * from FAILED runs and two more from a PASSING one. They were on throwaway temp sockets, so
 * nothing touched the live store, but a test suite for "one process owns the protocol" must
 * not itself accumulate daemons. spawnDaemon registers every child and reapAll runs on
 * normal exit, on throw, and on signals — SIGTERM first, then SIGKILL for anything left. */
const SPAWNED = [];
function spawnDaemon(env) {
  const p = spawn(process.execPath, [path.join(__dirname, 'handoff-daemon.js')], { env });
  SPAWNED.push(p);
  return p;
}
function reapAll() {
  for (const p of SPAWNED) {
    if (p.exitCode !== null || p.signalCode !== null) continue;
    try { p.kill('SIGTERM'); } catch (_) {}
  }
  const deadline = Date.now() + 500;                 // brief grace for clean shutdown
  while (Date.now() < deadline && SPAWNED.some(p => p.exitCode === null && p.signalCode === null)) {
    try { require('child_process').execFileSync('sleep', ['0.05']); } catch (_) { break; }
  }
  for (const p of SPAWNED) {
    if (p.exitCode !== null || p.signalCode !== null) continue;
    try { p.kill('SIGKILL'); } catch (_) {}
  }
}
process.on('exit', reapAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { reapAll(); process.exit(1); });

// A forwarder: connect, send one request line, resolve the one response line.
function forward(sock, req) {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock, () => c.write(JSON.stringify(req) + '\n'));
    let buf = '';
    c.on('data', d => { buf += d; const nl = buf.indexOf('\n'); if (nl >= 0) { c.end(); try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); } } });
    c.on('error', reject);
    setTimeout(() => { c.destroy(); reject(new Error('timeout')); }, 4000);
  });
}
const waitFor = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };

(async () => {
  console.log('Daemon acceptance tests (a)-(d)');
  const { CONTRACT } = require('./handoff-contract');

  // ---- (a) contract version ----
  {
    process.env.HANDOFF_HOME = tmpHome();
    delete require.cache[require.resolve('./handoff-daemon')];
    const d = require('./handoff-daemon');
    const good = await d.handleRequest({ contract: CONTRACT, id: 1, method: 'GET', path: '/api/health' });
    ok(good && good.result && good.result.ok, '(a) a matching-contract call is served');
    const bad = await d.handleRequest({ contract: CONTRACT + 9, id: 2, method: 'GET', path: '/api/health' });
    ok(bad && bad.error === 'contract_mismatch' && bad.fatal === true && bad.expected === CONTRACT,
      '(a) a mismatched contract is refused loud with fatal:true (forwarder must exit)');
  }

  // ---- (b) load-safety: last-good fallback, no crash ----
  {
    const home = tmpHome();
    process.env.HANDOFF_HOME = home;
    delete require.cache[require.resolve('./handoff-daemon')];
    delete require.cache[require.resolve('./handoff-core')];
    const d = require('./handoff-daemon');
    // seed two good records
    await d.handleRequest({ contract: CONTRACT, id: 1, method: 'POST', path: '/api/sessions', body: { surface: 'code', title: 'keep-A' } });
    await d.handleRequest({ contract: CONTRACT, id: 2, method: 'POST', path: '/api/sessions', body: { surface: 'code', title: 'keep-B' } });
    const r1 = d.reloadSafe();
    ok(r1.ok >= 2 && r1.recovered === 0 && r1.unrecoverable === 0, '(b) a clean store loads with no recovery needed');
    // corrupt ONE record file on disk
    const sdir = path.join(home, 'store', 'v1', 'sessions');
    const files = fs.readdirSync(sdir).filter(f => f.endsWith('.json'));
    fs.writeFileSync(path.join(sdir, files[0]), '{ this is not json');
    let threw = false, r2;
    try { r2 = d.reloadSafe(); } catch (_) { threw = true; }
    ok(!threw, '(b) a corrupt record does not crash the reload');
    ok(r2 && r2.recovered === 1 && r2.ok >= 1, '(b) the corrupt record is kept from last-good; the rest still load');
    const still = await d.handleRequest({ contract: CONTRACT, id: 3, method: 'GET', path: '/api/health' });
    ok(still && still.result && still.result.ok, '(b) the daemon keeps serving after a corrupt record');
  }

  // ---- (c) exit-on-stale (decision + live exit/respawn over the socket) ----
  {
    process.env.HANDOFF_HOME = tmpHome();
    delete require.cache[require.resolve('./handoff-daemon')];
    const d = require('./handoff-daemon');
    process.env.HANDOFF_FORCE_STALE = '1';
    const stale = await d.handleRequest({ contract: CONTRACT, id: 1, method: 'GET', path: '/api/health' });
    ok(stale && stale.error === 'daemon_stale' && stale.fatal === true, '(c) a stale daemon refuses with daemon_stale + fatal:true');
    delete process.env.HANDOFF_FORCE_STALE;

    // live: spawn a daemon, force it stale, confirm it exits on the next call, then a fresh one serves.
    const home = tmpHome();
    const sock = path.join(home, 'daemon.sock');
    const env1 = { ...process.env, HANDOFF_HOME: home, HANDOFF_DAEMON_SOCK: sock, HANDOFF_FORCE_STALE: '1' };
    const p1 = spawnDaemon(env1);
    const up1 = await waitFor(() => fs.existsSync(sock));
    ok(up1, '(c) daemon binds its control socket');
    const resp = await forward(sock, { contract: CONTRACT, id: 1, method: 'GET', path: '/api/health' }).catch(e => ({ error: e.message }));
    ok(resp && resp.error === 'daemon_stale', '(c) forced-stale daemon returns daemon_stale over the socket');
    const gone = await waitFor(() => p1.exitCode !== null || !fs.existsSync(sock));
    ok(gone, '(c) the stale daemon exits so a client can respawn one');
    try { p1.kill(); } catch (_) {}
    // A daemon that exits on staleness leaves its socket file behind (process.exit skips
    // the SIGTERM unlink). Clear it so the respawn's readiness check waits for the NEW bind,
    // not the dead file. (The real forwarder connects, gets ECONNREFUSED, and respawns —
    // same recovery; the test just makes the readiness signal honest.)
    try { fs.unlinkSync(sock); } catch (_) {}
    const env2 = { ...process.env, HANDOFF_HOME: home, HANDOFF_DAEMON_SOCK: sock };
    delete env2.HANDOFF_FORCE_STALE;
    const p2 = spawnDaemon(env2);
    await waitFor(() => fs.existsSync(sock));
    const resp2 = await forward(sock, { contract: CONTRACT, id: 2, method: 'GET', path: '/api/health' }).catch(e => ({ error: e.message }));
    ok(resp2 && resp2.result && resp2.result.ok, '(c) a freshly respawned daemon serves again');
    try { p2.kill(); } catch (_) {}
  }

  // ---- (c2) exit-on-stale must cover the daemon's WHOLE code surface ----
  // The original isStale() watched only handoff-daemon.js. After slice 3b the daemon is the
  // sole executor — handoff-core.js and handoff-tools.js ARE the protocol, required once at
  // boot and never reloaded — so editing either left it serving stale logic silently. Found
  // live: a daemon booted 19:13 while core was modified 19:50, reporting itself healthy for
  // 37 minutes. Touch each watched file in a COPY of the tree so the real repo is untouched.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdaemon-stalesurface-'));
    for (const f of ['handoff-daemon.js', 'handoff-core.js', 'handoff-tools.js', 'handoff-contract.js']) {
      fs.copyFileSync(path.join(__dirname, f), path.join(dir, f));
    }
    for (const target of ['handoff-core.js', 'handoff-tools.js', 'handoff-contract.js']) {
      const home = tmpHome();
      const sock = path.join(home, 'daemon.sock');
      const env = { ...process.env, HANDOFF_HOME: home, HANDOFF_DAEMON_SOCK: sock };
      delete env.HANDOFF_FORCE_STALE;
      const p = spawn(process.execPath, [path.join(dir, 'handoff-daemon.js')], { env });
      SPAWNED.push(p);
      await waitFor(() => fs.existsSync(sock));
      const before = await forward(sock, { contract: CONTRACT, id: 1, method: 'GET', path: '/api/health' });
      // Bump the watched file's mtime — the daemon must notice on the NEXT call.
      const now = new Date();
      fs.utimesSync(path.join(dir, target), now, new Date(now.getTime() + 5000));
      const after = await forward(sock, { contract: CONTRACT, id: 2, method: 'GET', path: '/api/health' })
        .catch(e => ({ error: 'threw: ' + e.message }));
      ok(before.result && before.result.ok && after.error === 'daemon_stale' && after.stale_file === target,
        `(c2) editing ${target} makes the daemon refuse daemon_stale and name the file`);
      const gone = await waitFor(() => p.exitCode !== null || !fs.existsSync(sock));
      ok(gone, `(c2) ...and it EXITS so the service manager restarts it with the new ${target}`);
      try { p.kill(); } catch (_) {}
    }
    // Guard the restart-loop hazard the mtime-vs-BOOT comparison exists to prevent: a file
    // dated in the FUTURE must not read as perpetually stale (mtime > start would).
    {
      const home = tmpHome();
      const sock = path.join(home, 'daemon.sock');
      const future = new Date(Date.now() + 3600_000);
      fs.utimesSync(path.join(dir, 'handoff-core.js'), future, future);
      const env = { ...process.env, HANDOFF_HOME: home, HANDOFF_DAEMON_SOCK: sock };
      delete env.HANDOFF_FORCE_STALE;
      const p = spawn(process.execPath, [path.join(dir, 'handoff-daemon.js')], { env });
      SPAWNED.push(p);
      await waitFor(() => fs.existsSync(sock));
      const r = await forward(sock, { contract: CONTRACT, id: 1, method: 'GET', path: '/api/health' })
        .catch(e => ({ error: 'threw: ' + e.message }));
      ok(r.result && r.result.ok,
        '(c2) a future-dated file is NOT stale — boot-mtime comparison avoids a restart loop');
      try { p.kill(); } catch (_) {}
    }
  }


  // ---- (d) rollout smoke: 10 forwarders under load across a restart, zero lost writes ----
  {
    const home = tmpHome();
    const sock = path.join(home, 'daemon.sock');
    const env = { ...process.env, HANDOFF_HOME: home, HANDOFF_DAEMON_SOCK: sock };
    delete env.HANDOFF_FORCE_STALE;
    let dae = spawnDaemon(env);
    await waitFor(() => fs.existsSync(sock));
    // 10 clients each create a distinct record; restart the daemon halfway (simulated core edit).
    const N = 10;
    const first = [];
    for (let i = 0; i < N; i++) first.push(forward(sock, { contract: CONTRACT, id: i, method: 'POST', path: '/api/sessions', body: { surface: 'code', title: 'load-' + i } }).catch(() => null));
    await Promise.all(first);
    try { dae.kill('SIGTERM'); } catch (_) {}
    await waitFor(() => !fs.existsSync(sock) || dae.exitCode !== null);
    dae = spawnDaemon(env);
    await waitFor(() => fs.existsSync(sock));
    const second = [];
    for (let i = N; i < 2 * N; i++) second.push(forward(sock, { contract: CONTRACT, id: i, method: 'POST', path: '/api/sessions', body: { surface: 'code', title: 'load-' + i } }).catch(() => null));
    await Promise.all(second);
    const sdir = path.join(home, 'store', 'v1', 'sessions');
    const titles = fs.readdirSync(sdir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(sdir, f), 'utf8')).title);
    const want = Array.from({ length: 2 * N }, (_, i) => 'load-' + i);
    const lost = want.filter(t => !titles.includes(t));
    ok(lost.length === 0, `(d) zero lost writes across a daemon restart under load (missing: ${lost.length ? lost.join(',') : 'none'})`);
    // mixed-version corruption: every record must be valid JSON with a stable schema
    const corrupt = fs.readdirSync(sdir).filter(f => f.endsWith('.json')).filter(f => { try { const r = JSON.parse(fs.readFileSync(path.join(sdir, f), 'utf8')); return !r.id || !r.surface; } catch (_) { return true; } });
    ok(corrupt.length === 0, '(d) zero mixed-version / corrupt records after the restart');
    try { dae.kill(); } catch (_) {}
  }

  // ---- VERIFY-AT-THE-DOOR: registry cross-check (decision (i) + hardening) ----
  {
    process.env.HANDOFF_HOME = tmpHome();
    // fixture native registry: one real-looking session record
    const regDir = path.join(os.tmpdir(), 'hdaemon-reg-' + Date.now());
    fs.mkdirSync(regDir, { recursive: true });
    const uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0000';
    const cwd = '$HOME/Dev/Github/ai-product-sense';
    fs.writeFileSync(path.join(regDir, '12345.json'), JSON.stringify({ pid: 12345, sessionId: uuid, cwd, name: 'ai-product-sense-2a' }));
    process.env.HANDOFF_NATIVE_SESSIONS_DIR = regDir;
    delete require.cache[require.resolve('./handoff-daemon')];
    const d = require('./handoff-daemon');

    ok(d.verifyIdentity({ cli_uuid: uuid, cwd }).status === 'verified',
      '(door) a declared uuid present in native registry with matching cwd is VERIFIED');
    const cwdMiss = d.verifyIdentity({ cli_uuid: uuid, cwd: '/somewhere/else' });
    ok(cwdMiss.status === 'asserted' && cwdMiss.reason === 'cwd-mismatch',
      '(door) same uuid but wrong cwd is ASSERTED (cwd-mismatch), never verified');
    const unknown = d.verifyIdentity({ cli_uuid: '00000000-0000-4000-8000-000000000000', cwd });
    ok(unknown.status === 'asserted' && unknown.reason === 'not-in-native-registry',
      '(door) a uuid native does not know is ASSERTED — the lying-forwarder case is closed by a file read');
    ok(d.verifyIdentity({}).status === 'anonymous' && d.verifyIdentity(null).status === 'anonymous',
      '(door) no declared uuid is ANONYMOUS');
    // the stamp rides the response envelope so the refactor can attach it to provenance
    const resp = await d.handleRequest({ contract: CONTRACT, id: 1, method: 'GET', path: '/api/health', identity: { cli_uuid: uuid, cwd } });
    ok(resp.identity && resp.identity.status === 'verified',
      '(door) handleRequest stamps the verified identity onto the response for the caller');
    delete process.env.HANDOFF_NATIVE_SESSIONS_DIR;
  }

  // ---- slice 3 (forwarder swap): ctx isolation — two pins never cross-read ----
  // The forwarder-swap crux: the daemon is ONE process serving MANY sessions, so per-session
  // `pinned` must arrive in ctx per request. This is the regression guard — two concurrent
  // callers with different pins, at the same shared daemon, must each see only their own.
  {
    const home = tmpHome();
    const sock = path.join(home, 'daemon.sock');
    const env = { ...process.env, HANDOFF_HOME: home, HANDOFF_DAEMON_SOCK: sock };
    delete env.HANDOFF_FORCE_STALE;
    const dae = spawnDaemon(env);
    await waitFor(() => fs.existsSync(sock));
    const post = req => forward(sock, Object.assign({ contract: CONTRACT }, req));
    // seed two transactions, each with its own locked decision
    const mk = async (title, decision) => {
      const s = (await post({ id: 't', method: 'POST', path: '/api/sessions', body: { surface: 'code', title } })).result;
      await post({ id: 'd', method: 'POST', path: `/api/sessions/${s.id}/messages`, body: { role: 'user', text: decision, decision: true } });
      return s.id;
    };
    const A = await mk('txn A', 'decision: ALPHA locked');
    const B = await mk('txn B', 'decision: BRAVO locked');
    // CONCURRENT: two callers, different pins, at the same shared daemon, at the same time.
    const [rA, rB] = await Promise.all([
      post({ id: 1, tool: 'get_decisions', ctx: { pinned: A } }),
      post({ id: 2, tool: 'get_decisions', ctx: { pinned: B } })
    ]);
    ok(/ALPHA/.test(rA.result) && !/BRAVO/.test(rA.result),
      'slice3 isolation: caller pinned to A sees only A\'s decision');
    ok(/BRAVO/.test(rB.result) && !/ALPHA/.test(rB.result),
      'slice3 isolation: caller pinned to B sees only B\'s decision — no cross-read on the shared daemon');
    // I2: no pin + no name → fail loud, never guess a target.
    const rI2 = await post({ id: 3, tool: 'get_decisions', ctx: { pinned: null } });
    ok(rI2.error && /not pinned|I2/.test(rI2.error),
      'slice3: an unpinned, unnamed tool call fails loud (I2) — never resolves a guess');
    // explicit name beats pin: pinned to B but naming A returns A's decision.
    const rN = await post({ id: 4, tool: 'get_decisions', args: { title_contains: 'txn A' }, ctx: { pinned: B } });
    ok(/ALPHA/.test(rN.result),
      'slice3: an explicitly named target overrides the pin (name beats pin)');
    // door stamp rides tool responses (provenance for I12).
    ok(rA.identity && typeof rA.identity.status === 'string',
      'slice3: tool responses carry the door identity stamp');
    // report_progress (migrated 3b): posts a progress message to the pinned transaction.
    const rP = await post({ id: 6, tool: 'report_progress', args: { summary: 'halfway through the sweep' }, ctx: { pinned: A } });
    ok(/Progress recorded/.test(rP.result || ''),
      'slice3b: report_progress is served by the daemon tool layer, pin from ctx');
    const rPd = await post({ id: 7, method: 'GET', path: `/api/sessions/${A}` });
    ok((rPd.result.messages || []).some(m => m.kind === 'progress' && /halfway through the sweep/.test(m.text || '')),
      'slice3b: the progress message landed on A (ctx pin), not elsewhere');
    // report_progress with no pin + no name still fails loud (I2), through the shared resolver.
    const rPI2 = await post({ id: 8, tool: 'report_progress', args: { summary: 'no pin' }, ctx: { pinned: null } });
    ok(rPI2.error && /not pinned|I2/.test(rPI2.error),
      'slice3b: report_progress unpinned+unnamed fails loud (I2)');
    // get_worker_result (migrated 3b): pure store read, no pin needed.
    const rW0 = await post({ id: 9, tool: 'get_worker_result', args: {} });
    ok(/No workers exist yet/.test(rW0.result || ''),
      'slice3b: get_worker_result is served by the daemon tool layer (no workers case)');
    // A name the layer does not serve is refused honestly rather than silently ignored.
    // This assertion has walked down the migration: send_to_surface -> check_inbox -> a name
    // that is not a tool at all. That last step is the END STATE, not a weakening of the
    // test: every real tool is now served, so the only thing left to refuse is the unknown.
    const rU = await post({ id: 5, tool: 'no_such_tool', args: {} });
    ok(rU.error && /not served by the shared tool layer/.test(rU.error) && /no_such_tool/.test(rU.error),
      'slice3: an unknown tool is refused honestly, naming what was asked for');
    try { dae.kill(); } catch (_) {}
  }

  // ---- pin write-back (contract v2): ctx_update:{pinned} in the response envelope ----
  // The daemon is the sole pin writer: it echoes whatever a pin-writing tool returns; the
  // forwarder applies it. Proven at the envelope level by patching callTool (the pin-WRITER
  // tools, pick_up/continue_from, migrate in the next sub-step and will exercise this live).
  {
    process.env.HANDOFF_HOME = tmpHome();
    delete require.cache[require.resolve('./handoff-daemon')];
    const d = require('./handoff-daemon');
    const toolsMod = require('./handoff-tools');
    const orig = toolsMod.callTool;
    try {
      toolsMod.callTool = async () => ({ text: 'pinned it', ctx_update: { pinned: 'sess_ABC' } });
      const r1 = await d.handleRequest({ contract: CONTRACT, id: 1, tool: 'pick_up', args: {}, ctx: { pinned: null } });
      ok(r1.result === 'pinned it' && r1.ctx_update && r1.ctx_update.pinned === 'sess_ABC',
        'pin write-back: the daemon echoes ctx_update.pinned from a pin-writing tool (set)');
      toolsMod.callTool = async () => ({ text: 'closed and unpinned', ctx_update: { pinned: null } });
      const r2 = await d.handleRequest({ contract: CONTRACT, id: 2, tool: 'return_to_origin', args: {}, ctx: { pinned: 'sess_ABC' } });
      ok(r2.ctx_update && r2.ctx_update.pinned === null,
        'pin write-back: symmetric clear (pinned:null) is carried, not dropped');
      toolsMod.callTool = async () => 'just text, no pin change';
      const r3 = await d.handleRequest({ contract: CONTRACT, id: 3, tool: 'get_decisions', args: {}, ctx: {} });
      ok(r3.result === 'just text, no pin change' && !r3.ctx_update,
        'pin write-back: a plain-string tool carries NO ctx_update (no spurious pin churn)');
    } finally { toolsMod.callTool = orig; }
  }

  // ---- pin WRITERS over a real socket (slice 3b-5): the envelope, end to end ----
  // The ctx_update tests above patch callTool, so they prove the daemon PLUMBS the field.
  // This proves the real pick_up/continue_from EMIT it, and — the property that matters —
  // that a caller which applies the returned pin can then make an unnamed pin-dependent
  // call succeed, while a caller that does NOT apply it still fails loud (I2). Two callers
  // on ONE daemon, so a pin leaking into a module global would show up as the wrong session.
  {
    const home = tmpHome();
    const sock = path.join(home, 'daemon.sock');
    const env = { ...process.env, HANDOFF_HOME: home, HANDOFF_DAEMON_SOCK: sock };
    delete env.HANDOFF_FORCE_STALE;
    const dae = spawnDaemon(env);
    await waitFor(() => fs.existsSync(sock));
    const post = req => forward(sock, Object.assign({ contract: CONTRACT }, req));

    // Seed two independent offers so a cross-pin would be visible, not masked by luck.
    const offer = async (title, decision) => {
      const o = (await post({ id: 'o', method: 'POST', path: '/api/sessions', body: { surface: 'code', title } })).result;
      await post({ id: 'm', method: 'POST', path: `/api/sessions/${o.id}/messages`, body: { role: 'user', text: decision, decision: true } });
      await post({ id: 'c', method: 'POST', path: `/api/sessions/${o.id}/continue`, body: { to: 'chat' } });
      return o.id;
    };
    await offer('txn CHARLIE', 'decision: CHARLIE locked');
    await offer('txn DELTA', 'decision: DELTA locked');

    const pC = await post({ id: 1, tool: 'pick_up', args: { surface: 'chat', title_contains: 'CHARLIE' }, ctx: { pinned: null } });
    const pD = await post({ id: 2, tool: 'pick_up', args: { surface: 'chat', title_contains: 'DELTA' }, ctx: { pinned: null } });
    ok(pC.ctx_update && pC.ctx_update.pinned && pD.ctx_update && pD.ctx_update.pinned &&
       pC.ctx_update.pinned !== pD.ctx_update.pinned,
      '3b-5: real pick_up emits ctx_update.pinned, and two callers get DIFFERENT pins');

    // A caller that APPLIES the returned pin can now make an unnamed pin-dependent call.
    const gC = await post({ id: 3, tool: 'get_decisions', ctx: { pinned: pC.ctx_update.pinned } });
    const gD = await post({ id: 4, tool: 'get_decisions', ctx: { pinned: pD.ctx_update.pinned } });
    ok(/CHARLIE/.test(gC.result) && !/DELTA/.test(gC.result) &&
       /DELTA/.test(gD.result) && !/CHARLIE/.test(gD.result),
      '3b-5: each caller\'s applied pin resolves to ITS OWN transaction — no shared-global leak');

    // A caller that does NOT apply it is unchanged: the daemon wrote no global on its behalf.
    const gN = await post({ id: 5, tool: 'get_decisions', ctx: { pinned: null } });
    ok(gN.error && /not pinned|I2/.test(gN.error),
      '3b-5: a THIRD caller stays unpinned after two pick_ups — the pin never became daemon state');

    // Ambiguity is not a pin change: several pending offers, no filter → card, no ctx_update.
    // CHARLIE and DELTA are claimed by now, so seed TWO fresh offers to make it ambiguous.
    await offer('txn ECHO', 'decision: ECHO locked');
    await offer('txn FOXTROT', 'decision: FOXTROT locked');
    const amb = await post({ id: 6, tool: 'pick_up', args: { surface: 'chat' }, ctx: { pinned: null } });
    ok(/pending handoffs are addressed to chat/.test(amb.result) && !amb.ctx_update,
      '3b-5: an ambiguity card carries NO ctx_update — a refusal to guess never repins the caller');

    // continue_from is the other writer: it pins the DEST it just created.
    const cf = await post({ id: 7, tool: 'continue_from', args: { surface: 'chat', title_contains: 'CHARLIE' }, ctx: { pinned: null } });
    ok(cf.ctx_update && cf.ctx_update.pinned && /Pulled "txn CHARLIE"/.test(cf.result),
      '3b-5: real continue_from emits ctx_update.pinned for the dest it created');
    const gCF = await post({ id: 8, tool: 'get_handoff', ctx: { pinned: cf.ctx_update.pinned } });
    ok(typeof gCF.result === 'string' && /CHARLIE/.test(gCF.result),
      '3b-5: the continue_from pin resolves the brief it was meant to open');

    // ---- the CLOSE (3b-6): the symmetric half — settling clears the caller's pin ----
    const myPin = cf.ctx_update.pinned;      // continue_from's dest (surface: code)
    const otherPin = pD.ctx_update.pinned;   // the DELTA pick_up dest (surface: chat)
    // A refusal must NOT unpin: the link is still open and retryable, so the caller is
    // still working that transaction. (t21 Bug C: summary names a file it does not carry.)
    // Aimed at a CHAT dest (the pick_up leg): the by-value rule applies only where the dest
    // has no filesystem. myPin is continue_from's CODE dest, where a path does dereference.
    const refused = await post({ id: 9, tool: 'return_to_origin', args: { session_id: otherPin, summary: 'see RESULTS.md for the write-up' }, ctx: { pinned: otherPin } });
    ok(/REFUSED/.test(refused.result) && !refused.ctx_update,
      '3b-6: a REFUSED return carries no ctx_update — a retryable refusal never unpins the caller');
    // A proxy close (naming someone else's transaction) must not clear MY unrelated pin.
    const proxy = await post({ id: 10, tool: 'return_to_origin', args: { session_id: myPin, summary: 'done, results inline' }, ctx: { pinned: otherPin } });
    ok(/closed as DONE/.test(proxy.result) && !(proxy.ctx_update && proxy.ctx_update.pinned === null),
      '3b-6: a PROXY close settles the named transaction without unpinning a caller pinned elsewhere');
    // And the caller that WAS pinned to what just closed does get unpinned.
    const own = await post({ id: 11, tool: 'return_to_origin', args: { summary: 'delta work finished' }, ctx: { pinned: otherPin } });
    ok(own.ctx_update && own.ctx_update.pinned === null,
      '3b-6: closing your OWN pinned transaction returns ctx_update.pinned:null — the symmetric clear');
    // Applying that clear leaves the caller genuinely unpinned, not pointing at a dead id.
    const after = await post({ id: 12, tool: 'get_decisions', ctx: { pinned: null } });
    ok(after.error && /not pinned|I2/.test(after.error),
      '3b-6: after applying the clear, an unnamed call fails loud instead of resolving a settled transaction');
    try { dae.kill(); } catch (_) {}
  }

  // ---- send_message on the shared layer (3b-7): sender identity comes from CTX ----
  // The sharpest shared-process risk in this tool: it asks "am I a code terminal, and is
  // the target ME?" to decide between the retired store leg and the native redirect. In the
  // daemon that question must be answered with the CALLING forwarder's uuid — the daemon's
  // own process identity is meaningless. Two forwarders, same target, opposite answers.
  {
    const home = tmpHome();
    const sock = path.join(home, 'daemon.sock');
    const env = { ...process.env, HANDOFF_HOME: home, HANDOFF_DAEMON_SOCK: sock };
    delete env.HANDOFF_FORCE_STALE;
    const dae = spawnDaemon(env);
    await waitFor(() => fs.existsSync(sock));
    const post = req => forward(sock, Object.assign({ contract: CONTRACT }, req));

    // A natively-reachable code target, registered the way a real terminal registers.
    const uuidT = '11111111-1111-4111-8111-111111111111';
    const reg = (await post({ id: 'r', method: 'POST', path: '/api/register',
      body: { native_id: uuidT, cwd: '/tmp/proj', native_name: 'target-window' } })).result;
    const targetId = reg.id;

    // Caller A is a DIFFERENT terminal → native redirect, and NOTHING is queued.
    const other = await post({ id: 1, tool: 'send_message', args: { session_id: targetId, message: 'hello' },
      ctx: { cli_uuid: '22222222-2222-4222-8222-222222222222', cwd: '/tmp/other' } });
    ok(/use NATIVE messaging/.test(other.result) && /target-window/.test(other.result),
      '3b-7: a caller that is NOT the target gets the native redirect, keyed to ITS OWN ctx uuid');

    // Caller B IS the target terminal → the redirect must NOT fire (you are not another
    // session); it takes the store path. Same daemon, same target, opposite answer.
    const self = await post({ id: 2, tool: 'send_message', args: { session_id: targetId, message: 'note to self' },
      ctx: { cli_uuid: uuidT, cwd: '/tmp/proj' } });
    ok(/Message queued/.test(self.result) && !/use NATIVE messaging/.test(self.result),
      '3b-7: the SAME target from the target\'s own ctx takes the store path — the check reads ctx, not daemon state');

    // A pinned caller speaks AS the pinned transaction (C28/C29), not as its terminal.
    const pinnedSess = (await post({ id: 'p', method: 'POST', path: '/api/sessions', body: { surface: 'chat', title: 'speaking-as' } })).result;
    const chatDest = (await post({ id: 'c2', method: 'POST', path: '/api/sessions', body: { surface: 'chat', title: 'mailbox' } })).result;
    await post({ id: 3, tool: 'send_message', args: { session_id: chatDest.id, message: 'from the transaction' },
      ctx: { cli_uuid: uuidT, cwd: '/tmp/proj', pinned: pinnedSess.id } });
    const stM = (await post({ id: 4, method: 'GET', path: '/api/state' })).result;
    const landed = (stM.sessions[chatDest.id].messages || []).filter(m => m.kind === 'xmsg');
    ok(landed.length === 1 && landed[0].from_session === pinnedSess.id && landed[0].sender_class === 'pinned',
      '3b-7: a pinned caller sends AS the pinned transaction (from ctx), so read-state routes there');

    // resolve-then-send: a title never delivers, even now that both live in one module.
    const byTitle = await post({ id: 5, tool: 'send_message', args: { to_title: 'mailbox', message: 'should not arrive' }, ctx: { cli_uuid: uuidT } });
    const stAfter = (await post({ id: 6, method: 'GET', path: '/api/state' })).result;
    ok(/NOT SENT/.test(byTitle.result) &&
       (stAfter.sessions[chatDest.id].messages || []).filter(m => m.kind === 'xmsg').length === 1,
      '3b-7: to_title still resolves-and-stops — the delegated internal call delivered nothing');
    try { dae.kill(); } catch (_) {}
  }

  // ---- send_to_surface over the daemon (3b-8): the guards, then a real handoff ----
  // These tools hold no per-session state, so the risk is not isolation but that the lift
  // silently dropped a refuse-before-mutating guard. Each guard exists because a real send
  // lost something, so assert they still fire — and that a clean send still completes.
  {
    const home = tmpHome();
    const sock = path.join(home, 'daemon.sock');
    const env = { ...process.env, HANDOFF_HOME: home, HANDOFF_DAEMON_SOCK: sock };
    delete env.HANDOFF_FORCE_STALE;
    const dae = spawnDaemon(env);
    await waitFor(() => fs.existsSync(sock));
    const post = req => forward(sock, Object.assign({ contract: CONTRACT }, req));
    const base = { to: 'chat', from: 'code', title: 'daemon send guards', context: 'some context' };

    // t17: a name-only artifact to a filesystem-less surface.
    const g1 = await post({ id: 1, tool: 'send_to_surface', args: { ...base, artifacts: [{ name: 'REPORT.md' }] }, ctx: {} });
    ok(/REFUSED/.test(g1.result) && /no filesystem/.test(g1.result),
      '3b-8: t17 by-value guard still fires through the daemon (name-only artifact refused)');
    // Lesson 2: a return contract asking for a deliverable without demanding it BY VALUE.
    const g2 = await post({ id: 2, tool: 'send_to_surface', args: { ...base, expected_return: 'send back the completion report' }, ctx: {} });
    ok(/REFUSED/.test(g2.result) && /by[\s-]?value/i.test(g2.result),
      '3b-8: Lesson 2 return-contract guard still fires (deliverable not demanded by value)');
    // t18: send_to code without naming the project.
    const g3 = await post({ id: 3, tool: 'send_to', args: { ...base, to: 'code' }, ctx: {} });
    ok(/REFUSED/.test(g3.result) && /Code tab/.test(g3.result),
      '3b-8: t18 code-project guard still fires (deep link would open an unconfirmed project)');
    // And a clean send actually completes and creates the destination record.
    const good = await post({ id: 4, tool: 'send_to_surface',
      args: { ...base, title: 'clean daemon handoff', expected_return: 'a decision on the naming' }, ctx: {} });
    const stS = (await post({ id: 5, method: 'GET', path: '/api/state' })).result;
    const made = Object.values(stS.sessions).filter(s => s.title === 'clean daemon handoff' && s.surface === 'chat');
    ok(!/REFUSED/.test(good.result) && made.length === 1,
      '3b-8: a clean send_to_surface completes through the daemon and creates the dest record');
    try { dae.kill(); } catch (_) {}
  }

  // ---- status on the shared layer (3b-9): the report is per-CALLER, not per-daemon ----
  // status renders four things that are not store state — pinned, identity, cli_uuid and
  // staleness. All four arrive in ctx, so one daemon must render different reports for
  // different callers. Staleness is the sharp one: "is the code serving me out of date?"
  // is a question about the CALLING process and could never be daemon state.
  {
    const home = tmpHome();
    const sock = path.join(home, 'daemon.sock');
    const env = { ...process.env, HANDOFF_HOME: home, HANDOFF_DAEMON_SOCK: sock };
    delete env.HANDOFF_FORCE_STALE;
    const dae = spawnDaemon(env);
    await waitFor(() => fs.existsSync(sock));
    const post = req => forward(sock, Object.assign({ contract: CONTRACT }, req));

    const a = (await post({ id: 'a', method: 'POST', path: '/api/sessions', body: { surface: 'code', title: 'status txn A' } })).result;
    const fresh = await post({ id: 1, tool: 'status', args: {}, ctx: { pinned: a.id, stale: false } });
    const stale = await post({ id: 2, tool: 'status', args: {}, ctx: { pinned: null, stale: true } });
    ok(/Bridge: ✓ current/.test(fresh.result) && new RegExp(a.id).test(fresh.result),
      '3b-9: status renders the CALLER\'s pin and a fresh-bridge line from its ctx');
    ok(/STALE/.test(stale.result) && !/Bridge: ✓ current/.test(stale.result),
      '3b-9: a second caller on the SAME daemon gets the STALE line — staleness is per-caller ctx');
    ok(!new RegExp(a.id).test(stale.result),
      '3b-9: the stale caller\'s report does not leak the other caller\'s pinned transaction');
    try { dae.kill(); } catch (_) {}
  }

  // ---- identity write-back (3b-10, contract v3): the last tool, and the last envelope key ----
  // register_session resolves the CALLER'S OWN record, which the caller must then remember.
  // Without ctx_update.identity a pure forwarder could register and never learn its own id,
  // so its very next status would say "not yet registered" right after registering. Proven
  // end to end: register, apply the returned identity, and see status change its mind.
  {
    const home = tmpHome();
    const sock = path.join(home, 'daemon.sock');
    const regDir = path.join(home, 'native-sessions');
    fs.mkdirSync(regDir, { recursive: true });
    const uuid = '33333333-3333-4333-8333-333333333333';
    fs.writeFileSync(path.join(regDir, 'p1.json'), JSON.stringify({ sessionId: uuid, cwd: '/tmp/reg', name: 'reg-window', pid: 1 }));
    const env = { ...process.env, HANDOFF_HOME: home, HANDOFF_DAEMON_SOCK: sock, HANDOFF_NATIVE_SESSIONS_DIR: regDir };
    delete env.HANDOFF_FORCE_STALE;
    const dae = spawnDaemon(env);
    await waitFor(() => fs.existsSync(sock));
    const post = req => forward(sock, Object.assign({ contract: CONTRACT }, req));

    const noId = await post({ id: 1, tool: 'register_session', args: { role: 'migration' }, ctx: { cli_uuid: null } });
    ok(/REFUSED/.test(noId.result) && /never guessed/.test(noId.result),
      '3b-10: register_session without a CLI uuid refuses — identity is never guessed (I2)');

    const reg = await post({ id: 2, tool: 'register_session', args: { role: 'migration' }, ctx: { cli_uuid: uuid, cwd: '/tmp/reg' } });
    ok(reg.ctx_update && reg.ctx_update.identity && !('pinned' in reg.ctx_update),
      '3b-10: register_session returns ctx_update.identity ONLY — it writes identity, not the pin');
    ok(/migration/.test(reg.result) && /reg-window/.test(reg.result),
      '3b-10: the record adopts the role and native display name');

    /* Status RESOLVES identity from the store by the caller's live uuid, so it names the
     * record with or without the ctx_update write-back applied. This assertion used to
     * require "not yet registered" before the write-back; that encoded a dependence on the
     * caller's in-memory cache, and after a resume (new process, same uuid, record alive)
     * it made status deny a terminal that was registered and healthy. Reporting must read
     * live state. What still matters — and is what this now guards — is ISOLATION: the
     * record must be resolved from the CALLING ctx's uuid, never a process global, because
     * one daemon serves every terminal. */
    const before = await post({ id: 3, tool: 'status', args: {}, ctx: { cli_uuid: uuid, identity: null } });
    const after = await post({ id: 4, tool: 'status', args: {}, ctx: { cli_uuid: uuid, identity: reg.ctx_update.identity } });
    ok(new RegExp(reg.ctx_update.identity).test(before.result) && !/not yet registered/.test(before.result),
      '3b-10: status resolves the caller\'s record from its LIVE uuid — no cached identity required');
    ok(new RegExp(reg.ctx_update.identity).test(after.result) && !/not yet registered/.test(after.result),
      '3b-10: once the caller APPLIES ctx_update.identity, status names its own record — the write-back closes the loop');
    const stranger = await post({ id: 5, tool: 'status', args: {}, ctx: { cli_uuid: '00000000-9999-4999-8999-999999999999', identity: null } });
    ok(/not yet registered/.test(stranger.result) && !new RegExp(reg.ctx_update.identity).test(stranger.result),
      '3b-10: a DIFFERENT terminal never inherits that record — identity comes from the calling ctx, never a process global');
    try { dae.kill(); } catch (_) {}
  }

  // ---- display-helper chain (slice 3b-4): shared, pure, and NOT the bridge's copy ----
  // The heavy tools (send_to_surface / send_message / status) render candidate cards; their
  // migration is a pure lift only if the renderer is already shared and stateless. Guard both
  // properties: the bridge must expose no private copy, and the shared renderer must give
  // byte-identical output for the same (session, state) regardless of call order or caller.
  {
    const t = require('./handoff-tools');
    const bridgeSrc = fs.readFileSync(path.join(__dirname, 'mcp-handoff.js'), 'utf8');
    ok(!/^function (age|clipText|sessionRecap|sessionCarrierNote|sessionLinkNote|settledDestIds|offerIsPending|formatSessionCandidates)\(/m.test(bridgeSrc),
      'helper chain: mcp-handoff.js keeps NO private copy — one implementation, shared');
    ok(typeof t.formatSessionCandidates === 'function' && typeof t.sessionLinkNote === 'function' &&
       typeof t.settledDestIds === 'function' && typeof t.age === 'function',
      'helper chain: the shared tool layer exports the full chain');

    const mk = (id, title, surface) => ({
      id, title, surface, created_at: '2026-08-08T10:00:00.000Z',
      messages: [{ role: 'user', kind: 'context', text: 'A task context line long enough to be chosen as the recap for this candidate card.' }],
      artifacts: [{ name: 'NOTES.md', content: 'x'.repeat(1200) }],
    });
    const a = mk('sess_AAA', 'alpha', 'code'), b = mk('sess_BBB', 'beta', 'chat');
    const st = { sessions: { sess_AAA: a, sess_BBB: b }, links: { l1: { origin: 'sess_AAA', dest: 'sess_BBB', status: 'resolved' } } };

    const first = t.formatSessionCandidates([a, b], st);
    // Interleave a DIFFERENT caller's render between two identical ones: if any helper kept
    // module-level state (the shared-process regression), run 3 would drift from run 1.
    t.formatSessionCandidates([b], { sessions: { sess_BBB: b }, links: {} });
    const third = t.formatSessionCandidates([a, b], st);
    ok(first === third, 'helper chain: renderer is stateless — an interleaved foreign render never perturbs it');
    ok(first.includes('session_id: sess_AAA') && first.includes('NOTES.md 1200b'),
      'helper chain: cards still carry recap + carrier + machine id after the move');
    ok(t.settledDestIds(st).has('sess_BBB') && !t.offerIsPending(Object.assign({ origin_ref: {} }, b), t.settledDestIds(st)),
      'helper chain: RETURNED work outranks a live offer flag survives the move (t21 Bug B)');
    // CLAIM, not settlement. The same shape with a FAILED link is an honest blocker on an
    // unshaken hand: still pending, still supersedable. The tools layer must read it the
    // same way handoff-core's offerState does — one discriminator, both layers.
    const stFailed = { sessions: { sess_AAA: a, sess_BBB: b }, links: { l1: { origin: 'sess_AAA', dest: 'sess_BBB', status: 'failed' } } };
    const bOffer = Object.assign({ origin_ref: {} }, b);
    ok(!t.settledDestIds(stFailed).has('sess_BBB') && t.offerIsPending(bOffer, t.settledDestIds(stFailed)),
      'helper chain: an UNCLAIMED offer whose link failed stays pending — failure is not a handshake');
    ok(t.offerStateOf(bOffer, t.settledDestIds(stFailed)) === 'offered',
      'helper chain: offerStateOf agrees — unclaimed + failed reads as offered, so a re-send supersedes it');
    ok(t.offerStateOf(Object.assign({ claimed_at: '2026-08-09T00:00:00Z' }, bOffer), t.settledDestIds(stFailed)) === 'completed',
      'helper chain: claimed_at outranks a failed link — picked-up-then-failed never re-enters the pool');
  }

  /* ---- the resume invariant: process-scoped addresses are never persisted OR CACHED ----
   * Encoded as the real sequence: a session registers, its process is replaced, and the new
   * process re-registers under the SAME pid with a NEW session id (what `claude --resume`
   * actually does — it forks a new id and leaves no lineage pointer). A caller holding the
   * old id must resolve to the NEW registration, not report "closed". */
  {
    const fs = require('fs'), os = require('os'), path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-nativereg-'));
    const prev = process.env.HANDOFF_NATIVE_SESSIONS_DIR;
    process.env.HANDOFF_NATIVE_SESSIONS_DIR = dir;
    const t = require('./handoff-tools');
    const mePid = process.pid; // a genuinely live pid, so liveness is real, not mocked
    const row = (pid, sessionId) => fs.writeFileSync(path.join(dir, `${pid}.json`),
      JSON.stringify({ pid, sessionId, cwd: '/repo', messagingSocketPath: `/tmp/cc-socks/${pid}.sock`, name: 'proj-x1' }));

    row(mePid, 'OLD-UUID');
    const before = t.resolveLiveNativeId({ env_id: 'OLD-UUID', pid: mePid });
    ok(before.id === 'OLD-UUID' && before.healed === false,
      'resume invariant: before the resume, the resolved id matches the frozen one — no spurious heal');

    // The resume: same CLI process/pid, brand-new session id written over its row.
    row(mePid, 'NEW-UUID');
    const after = t.resolveLiveNativeId({ env_id: 'OLD-UUID', pid: mePid });
    ok(after.id === 'NEW-UUID' && after.source === 'registry_pid',
      'resume invariant: a caller still holding the OLD id resolves to the NEW registration');
    ok(after.healed === true && after.stale_id === 'OLD-UUID',
      'resume invariant: the heal is REPORTED (healed + stale_id), never silently swapped');

    // A genuinely dead identity must still read as dead — the fix must not turn every
    // closed session into a false positive.
    const deadPid = 999999;
    const dead = t.resolveLiveNativeId({ env_id: 'GHOST-UUID', pid: deadPid });
    ok(dead.source === 'env_unresolvable' && dead.stale_id === 'GHOST-UUID',
      'resume invariant: an id no live process answers to is reported unresolvable, not healed into something else');
    ok(t.resolveLiveNativeId({ env_id: null, pid: null }).id === null,
      'resume invariant: no env id and no pid resolves to nothing, without throwing');
    // The registry CORRECTS an identity, never MANUFACTURES one. CLAUDE_PID is inherited by
    // every child process, so an anonymous caller must NOT adopt the live row sitting at that
    // pid — that leak made anonymous sends non-anonymous (caught live by mcp-smoke).
    ok(t.resolveLiveNativeId({ env_id: null, pid: mePid }).id === null,
      'resume invariant: an anonymous caller stays anonymous even with a live row at its inherited pid');

    if (prev === undefined) delete process.env.HANDOFF_NATIVE_SESSIONS_DIR;
    else process.env.HANDOFF_NATIVE_SESSIONS_DIR = prev;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('runner error:', e.message); process.exit(1); });
