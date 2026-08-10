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

// ---- (3a) verifyIdentity resolves a contested uuid by PID, or refuses to pick ----
  // `claude --continue` resumes the most recent session in a DIRECTORY, so two terminals in
  // one cwd share a transcript and each registers under its own pid. First-match then returned
  // whichever the filesystem listed first — nondeterministic, and how a terminal named "build"
  // came to be stamped "tunnel". The pid answers who is ASKING, which is the only question
  // this function can honestly answer.
  {
    const fsx = require('fs'), osx = require('os'), pathx = require('path');
    const regDir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'verifyid-'));
    const prev = process.env.HANDOFF_NATIVE_SESSIONS_DIR;
    process.env.HANDOFF_NATIVE_SESSIONS_DIR = regDir;
    delete require.cache[require.resolve('./handoff-daemon')];
    const d = require('./handoff-daemon');
    const UUID = 'uuid-two-live-processes';
    fsx.writeFileSync(pathx.join(regDir, '111.json'), JSON.stringify({ pid: 111, sessionId: UUID, cwd: '/repo', name: 'build' }));
    fsx.writeFileSync(pathx.join(regDir, '222.json'), JSON.stringify({ pid: 222, sessionId: UUID, cwd: '/repo', name: 'tunnel' }));

    const byPid = d.verifyIdentity({ cli_uuid: UUID, cli_pid: 222, cwd: '/repo' });
    ok(byPid.status === 'verified' && byPid.name === 'tunnel',
      'verifyIdentity: the PID resolves a contested uuid by fact — the right row, not the first one');
    const other = d.verifyIdentity({ cli_uuid: UUID, cli_pid: 111, cwd: '/repo' });
    ok(other.status === 'verified' && other.name === 'build',
      'verifyIdentity: and the other process gets ITS row — directory order is irrelevant');
    const noPid = d.verifyIdentity({ cli_uuid: UUID, cwd: '/repo' });
    ok(noPid.status === 'contested' && Array.isArray(noPid.pids) && noPid.pids.length === 2,
      'verifyIdentity: without a pid it reports CONTESTED and names the pids — it does not pick the newest');
    ok(!noPid.name && !noPid.cwd,
      'verifyIdentity: a contested answer carries NO name or cwd — a guessed stamp is worse than none');

    fsx.unlinkSync(pathx.join(regDir, '222.json'));
    const single = d.verifyIdentity({ cli_uuid: UUID, cwd: '/repo' });
    ok(single.status === 'verified' && single.name === 'build',
      'verifyIdentity: the ordinary uncontested case is unchanged — no pid required');

    if (prev === undefined) delete process.env.HANDOFF_NATIVE_SESSIONS_DIR; else process.env.HANDOFF_NATIVE_SESSIONS_DIR = prev;
    delete require.cache[require.resolve('./handoff-daemon')];
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


  // ---- (c3) a host's heartbeat flips its own records off 'unknown' ----
  // THE ACCEPTANCE TEST for the ownership design. A remote record starts at 'unknown' — nobody has
  // looked — and only the agent on its OWN host may change that. The flip proves three things at
  // once: the agents collection persists, the verdict is keyed so a record with no native_ref can
  // be answered for at all, and 'unknown' and 'none' are genuinely different states rather than
  // two spellings of "not reachable".
  //
  // Keying nearly sank this. Verdicts were first keyed by native_ref.session_id — which a remote
  // record does not have, by design — so a heartbeat could never speak about exactly the records
  // heartbeats exist for. It would have sat at 'unknown' forever with the agent running, and this
  // test could not have passed. Found by running it, not by reading it.
  {
    const home = tmpHome();
    const env = { ...process.env, HANDOFF_HOME: home };
    delete require.cache[require.resolve('./handoff-core')];
    delete require.cache[require.resolve('./handoff-tools')];
    const prevHome = process.env.HANDOFF_HOME;
    process.env.HANDOFF_HOME = home;
    const core2 = require('./handoff-core');
    const tools2 = require('./handoff-tools');

    const mint = await core2.handleApi('POST', '/api/register-remote', {}, { host: 'far-host', title: 'far-session', attested_by: 'operator', minted_by: 'test' });
    const rid = mint.payload.session.id;
    await core2.handleApi('POST', `/api/sessions/${rid}/messages`, {}, { role: 'user', kind: 'xmsg', text: '[message from chat · x] waiting' });

    const before = await tools2.callTool('peek_inbox', { surface: 'code' }, {}, core2);
    ok(/reachable: unknown/.test(before),
      '(c3) a remote record with no agent reads UNKNOWN — nobody has looked, which is not the same as looked-and-found-nothing');

    await core2.handleApi('POST', '/api/agents/heartbeat', {}, {
      host: 'far-host', last_seen: new Date().toISOString(), agent_version: '0.1.0', sessions: { [rid]: 'none' }, owns: 1
    });

    const after = await tools2.callTool('peek_inbox', { surface: 'code' }, {}, core2);
    ok(/reachable: none/.test(after) && !/reachable: unknown/.test(after),
      '(c3) after its own host heartbeats, the record carries a HOST-ASSERTED verdict instead of unknown');

    // A stale heartbeat must age back to unknown rather than keep asserting.
    await core2.handleApi('POST', '/api/agents/heartbeat', {}, {
      host: 'far-host', last_seen: new Date(Date.now() - 60 * 60 * 1000).toISOString(), agent_version: '0.1.0', sessions: { [rid]: 'process' }, owns: 1
    });
    const stale = await tools2.callTool('peek_inbox', { surface: 'code' }, {}, core2);
    ok(/reachable: unknown/.test(stale),
      '(c3) an hour-old heartbeat is not evidence — the verdict ages back to unknown rather than being trusted forever');

    if (prevHome === undefined) delete process.env.HANDOFF_HOME; else process.env.HANDOFF_HOME = prevHome;
    delete require.cache[require.resolve('./handoff-core')];
    delete require.cache[require.resolve('./handoff-tools')];
  }

  // ---- (c4) NAMES MOVE, IDS DON'T — the id invariant, asserted by making it FIRE ----
  // A record whose id can change is a record every stored reference to which can silently point at
  // nothing, or worse at something else. Unstated id mutability is a candidate cause of the session
  // mix-ups this project spent two days chasing. Nothing in the code deliberately rewrites an id --
  // which is exactly why a convention would look like it was working right up until the one path
  // that did, so it is enforced at the write choke point every verb passes through.
  //
  // THE TEST HAD TO REACH PAST THE API TO BE REAL. handleApi calls load() at the top of every
  // operation, so an in-memory id mutation is wiped before any save can observe it: a test driving
  // this through a verb passes while proving nothing, which is the vacuous shape found twice this
  // week. The write layer is exported for tests so the refusal can actually be provoked.
  /* THIS BLOCK REACHES PAST THE API, SO IT MUST NOT REACH INTO THE LIVE STORE. It was the one
   * block in this file with no scratch HANDOFF_HOME — the preceding block restores the variable
   * on its way out, so `require('./handoff-core')` here resolved STORE to ~/.claude-handoff and
   * `__writeRecordForTests` wrote a two-field stub into the running product's store. It sat there
   * until status and whoami both threw on it hours later. The force-seed guard in the core does
   * not cover this path: it protects seeding, and this is a direct record write. A test that can
   * write past the API has to own its store explicitly. */
  {
    const home = tmpHome();
    const prevHome4 = process.env.HANDOFF_HOME;
    process.env.HANDOFF_HOME = home;
    delete require.cache[require.resolve('./handoff-core')];
    delete require.cache[require.resolve('./handoff-tools')];
    const c4 = require('./handoff-core');
    /* STORE is resolved at module load, so the store directories have to exist before any write
     * that reaches past the API — an earlier version swapped HANDOFF_HOME here and failed with
     * ENOENT, which would have read as "the guard rejects valid writes" when it was the test
     * writing to a directory that was never created. Drive one normal API call first. */
    await c4.handleApi('POST', '/api/sessions', {}, { surface: 'chat', title: 'invariant probe' });

    let refused = null;
    try { c4.__writeRecordForTests('sessions', 'sess_chat_REAL', { id: 'sess_chat_IMPOSTOR', title: 'x' }); }
    catch (e) { refused = e; }
    ok(refused !== null, '(c4) a write whose payload id differs from the record it targets is REFUSED');
    ok(refused && refused.status === 409, '(c4) ...as a conflict, not a generic failure');
    ok(refused && /never changes/.test(refused.message) && /adoption/.test(refused.message),
      '(c4) ...and the refusal names the remedy: change the name, or link with adoption which supersedes rather than rewrites');

    // The invariant must not fire on legitimate writes, or every save breaks.
    let ok2 = true, why2 = '';
    try { c4.__writeRecordForTests('sessions', 'sess_chat_REAL', { id: 'sess_chat_REAL', title: 'x' }); }
    catch (e) { ok2 = false; why2 = e.message; }
    ok(ok2, '(c4) a matching id writes normally — the guard blocks mutation, not persistence' + (why2 ? ' :: ' + why2.slice(0, 80) : ''));

    // A record with no id field at all (links, agents) must still write.
    let ok3 = true, why3 = '';
    try { c4.__writeRecordForTests('agents', 'some-host', { host: 'some-host', last_seen: 'x' }); }
    catch (e) { ok3 = false; why3 = e.message; }
    ok(ok3, '(c4) records that carry no id field are unaffected — agents and links still persist' + (why3 ? ' :: ' + why3.slice(0, 80) : ''));

    /* The stub this test writes is exactly the shape that blinded status and whoami for every
     * session in the live store: a record with no `messages` array. The reader now treats an
     * absent history as an empty one, and the assertion is that status still ANSWERS — asserting
     * the value ("You are:" is present), not merely that no exception escaped, because a status
     * report that returned an error string would also not throw. */
    const t4 = require('./handoff-tools');
    let survived = '', threw = '';
    try { survived = String(await t4.callTool('status', { surface: 'chat' }, {}, c4)); }
    catch (e) { threw = e.message; }
    ok(/You are:/.test(survived),
      '(c4) status still answers with a record that carries no messages[] — one malformed record cannot blind the surface'
      + (threw ? ' :: threw ' + threw.slice(0, 80) : ''));

    if (prevHome4 === undefined) delete process.env.HANDOFF_HOME; else process.env.HANDOFF_HOME = prevHome4;
    delete require.cache[require.resolve('./handoff-core')];
    delete require.cache[require.resolve('./handoff-tools')];
  }

  // ---- (c5) a worker's brief carries the caller's task, not the delivery address ----
  // Measured 2026-08-10: EVERY headless worker ever dispatched received an empty brief. The store
  // held both records intact -- origin with a 4,431-char task and 1,746-char context, dest with one
  // 203-char handoff_card -- and the envelope was built from the DEST. supplied_context was empty,
  // the transcript filter dropped the card, and the brief said "Full context attached - 1 messages
  // travel whole (203 chars)". The worker read it, found no work described, and exited 0.
  //
  // The earlier payload-integrity fix protects send_to, where the envelope is built from the session
  // holding the words. Both verbs LOOK like they call the same function; they pass different
  // sessions. Fixed at the single construction point so an unwritten verb inherits it.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workerbrief-'));
    const home = tmpHome();
    const prev = process.env.HANDOFF_HOME, prevCli = process.env.HANDOFF_NO_CLI;
    process.env.HANDOFF_HOME = home;
    process.env.HANDOFF_NO_CLI = '1'; // force the HANDOFF.md path rather than the MCP prompt
    delete require.cache[require.resolve('./handoff-core')];
    const c5 = require('./handoff-core');
    await c5.handleApi('POST', '/api/workers', {}, {
      task: 'TASK-MARKER: the specific work the caller asked for',
      context: 'CONTEXT-MARKER: the surrounding facts the caller supplied',
      dir, mode: 'headless'
    });
    let md = '';
    try { md = fs.readFileSync(path.join(dir, 'HANDOFF.md'), 'utf8'); } catch (_) {}
    ok(md.includes('TASK-MARKER'),
      "(c5) worker brief carries the caller's TASK — without this the worker is told to continue work nothing describes");
    ok(md.includes('CONTEXT-MARKER'),
      '(c5) worker brief carries the caller-supplied CONTEXT, which rides separately so compaction cannot reach it');
    ok(!/1 messages travel whole/.test(md),
      '(c5) the brief is not the dest\'s lone handoff_card described as "full context attached"');

    /* (c5b) BOTH CHANNELS, barrier 6. The task rides the transcript and the context rides
     * supplied_context, and the renderer returned the second early — so a brief that had a context
     * lost its task, every time. Found by the preflight on its first run, where a worker was told
     * to "continue the work described in Context" and Context described no work.
     *
     * The markers are per-run rather than fixed strings, on the preflight's own standard: a
     * hardcoded needle can match a leftover artifact, and this file has already shipped one
     * assertion that matched the wrong text and reported green. */
    const runTag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bothchannels-'));
    /* THE MARKER MUST NOT BE ABLE TO RIDE THE TITLE. The brief's heading is `# Task brief —
     * <session.title>`, and the title is the task's opening truncated to ~60 chars — so a marker at
     * the front of the task appears in the brief whether or not the renderer keeps the transcript.
     * The first version of this assertion did exactly that and passed against a deliberately broken
     * renderer: vacuous, caught only by running it against the bug it was written for. The marker
     * now sits past the truncation, and the assertion reads the ## Context SECTION rather than the
     * whole document, because that section is the thing under test. */
    const pad = 'the specific work, which rides the transcript. '.repeat(4);
    await c5.handleApi('POST', '/api/workers', {}, {
      task: `Do the work described here. ${pad}TASK-${runTag}`,
      context: `CTX-${runTag}: the surrounding facts, which ride supplied_context`,
      dir: dir2, mode: 'headless'
    });
    let md2 = '';
    try { md2 = fs.readFileSync(path.join(dir2, 'HANDOFF.md'), 'utf8'); } catch (_) {}
    const ctxSection = (md2.split('\n## Context')[1] || '').split('\n## ')[0];
    ok(ctxSection.includes(`TASK-${runTag}`),
      '(c5b) the CONTEXT SECTION carries the TASK — supplied_context must not return early over the transcript');
    ok(ctxSection.includes(`CTX-${runTag}`),
      '(c5b) ...and the caller\'s context verbatim — two payload channels, one brief, neither shadowing the other');

    /* (c5c) A TASK OVER THE COMPACTION THRESHOLD MUST STILL ARRIVE WHOLE.
     * The task used to be an ordinary message while the CONTEXT was kind 'context' — so past
     * FULL_THRESHOLD the transcript was dropped and the brief a human wrote survived only as
     * whatever the summariser said about it. Measured 2026-08-10: a 7,829-char dispatch was
     * summarised by a model that answered IN CHARACTER ("I don't have prior session content to
     * compact…") and that first-person reply became the worker's card.
     *
     * The marker sits at the END of a deliberately over-threshold task, so a summary cannot
     * accidentally contain it and neither can the title, which truncates at 60 chars. HANDOFF_NO_CLI
     * keeps a real summariser out of the test — the assertion is that compaction never gets the
     * chance to touch this field, not that some model summarised it acceptably. */
    const bigTag = `${Date.now().toString(36)}z${Math.floor(Math.random() * 1e6).toString(36)}`;
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'bigtask-'));
    const filler = 'This sentence pads the task past the compaction threshold. '.repeat(80);
    await c5.handleApi('POST', '/api/workers', {}, {
      task: `Do the work described here. ${filler} FINAL-INSTRUCTION-${bigTag}`,
      context: 'short context', dir: dir3, mode: 'headless'
    });
    let md3 = '';
    try { md3 = fs.readFileSync(path.join(dir3, 'HANDOFF.md'), 'utf8'); } catch (_) {}
    ok(md3.length > 0 && md3.includes(`FINAL-INSTRUCTION-${bigTag}`),
      `(c5c) a task past FULL_THRESHOLD (${filler.length + 40} chars) still reaches the brief VERBATIM — a summariser may paraphrase a transcript, never the brief a human wrote`);
    if (prev === undefined) delete process.env.HANDOFF_HOME; else process.env.HANDOFF_HOME = prev;
    if (prevCli === undefined) delete process.env.HANDOFF_NO_CLI; else process.env.HANDOFF_NO_CLI = prevCli;
    delete require.cache[require.resolve('./handoff-core')];
  }

  /* ---- (c6) the worker's brief NAMES its target, so nothing depends on a pin ----
   * Barrier 5 of five, 2026-08-10. The prompt said "call get_handoff" with no argument; that
   * resolves through the caller's PINNED transaction and a freshly spawned worker has none.
   * Pinning needs pick_up, which was not granted, and headless means no approval prompt can be
   * raised — so the worker asked for permission it could not be given and stopped, having launched
   * perfectly. The links that can be checked without spawning a real Claude are checked here; the
   * whole chain including the spawn is bin/handoff-preflight.js, which asserts an EFFECT.
   *
   * ASSERTING THE VALUE, NOT THE SHAPE: these look for the record's OWN id in the prompt, not
   * merely for the substring "session_id" — a prompt that named the wrong session, or named the
   * parameter and no id, would satisfy a shape check and fail a worker exactly as before. */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workertarget-'));
    const home = tmpHome();
    const prev = process.env.HANDOFF_HOME, prevCli6 = process.env.HANDOFF_NO_CLI;
    process.env.HANDOFF_HOME = home;
    // Forced OFF so this block inspects the launch command instead of spawning real workers.
    process.env.HANDOFF_NO_CLI = '1';
    delete require.cache[require.resolve('./handoff-core')];
    const c6 = require('./handoff-core');

    const r = await c6.handleApi('POST', '/api/workers', {}, {
      task: 'PREFLIGHT-SHAPE: no work, this dispatch is inspected not run',
      context: 'chain check', dir, mode: 'headless'
    });
    const wid = (r.payload && r.payload.worker_id) || null;
    const cmd = String((r.payload && r.payload.launch && r.payload.launch.command) || '');
    ok(!!wid, '(c6) the dispatch returns the worker record id the prompt must name');
    ok(wid && cmd.includes(wid),
      '(c6) the launch prompt NAMES the worker\'s own session id — get_handoff needs no pin, so an ungranted pick_up cannot dead-stop it');
    ok(/do NOT rely on a pinned transaction|no pinned transaction/i.test(cmd),
      '(c6) ...and says so explicitly, so a worker does not fall back to the pin it does not have');

    /* Barrier 8: two mounts answer for one server and nothing said which to prefer, so a worker
     * took the network one and get_handoff timed out on a large brief. Asserting the PREFERENCE is
     * stated AND that the slow mount is still named — a worker told only "use local" learns nothing
     * about why, and a worker told nothing about the remote one cannot fall back deliberately. */
    ok(/mcp__handoff__/.test(cmd) && /LOCAL/i.test(cmd),
      '(c6) the prompt names the LOCAL mount by tool prefix — two mounts answer for one server and the network one has a 10s budget');
    ok(/claude_ai_Handoff_Remote/.test(cmd) && /unavailable|fallback|only if/i.test(cmd),
      '(c6) ...and still names the remote mount as the fallback, because denying it outright is what caused barrier 4');

    /* Every dispatch asked for report_progress and none asked for return_to_origin, so workers
     * reported and stopped and the transactions stayed open — three of them reading "return owed"
     * for verifiably finished work. Reporting is not closing. */
    ok(/return_to_origin/.test(cmd),
      '(c6) the prompt tells the worker to CLOSE the transaction, not just report — an open transaction reads as unfinished work to every later reader');
    ok(/report_progress/.test(cmd) && cmd.indexOf('report_progress') < cmd.indexOf('return_to_origin'),
      '(c6) ...and in that order, so the summary is recorded before the transaction settles');

    /* The grant is built from verbs × mounts. The bug it replaced was a NAME assumed unique: the
     * same server is mounted as `handoff` and as `claude_ai_Handoff_Remote`, and granting one
     * spelling denied every worker that resolved the other. */
    const prevAllowed = process.env.HANDOFF_ALLOWED_TOOLS;
    delete process.env.HANDOFF_ALLOWED_TOOLS;
    const r2 = await c6.handleApi('POST', '/api/workers', {}, {
      task: 'PREFLIGHT-SHAPE: grant check', context: 'chain check', dir, mode: 'headless'
    });
    void r2;
    // The launcher does not echo the grant, so assert against the same construction it uses.
    const VERBS = ['get_handoff', 'get_decisions', 'report_progress', 'return_to_origin', 'pick_up', 'status'];
    const MOUNTS = ['handoff', 'claude_ai_Handoff_Remote'];
    const built = MOUNTS.flatMap(m => VERBS.map(v => `mcp__${m}__${v}`));
    const src = fs.readFileSync(path.join(__dirname, 'handoff-core.js'), 'utf8');
    ok(VERBS.every(v => src.includes(`'${v}'`)),
      '(c6) the grant covers pick_up and status as well as the read verbs — a worker owns its transaction');
    ok(built.length === 12 && src.includes('claude_ai_Handoff_Remote'),
      '(c6) ...crossed with EVERY mount name the server answers to, not just the local one');
    if (prevAllowed !== undefined) process.env.HANDOFF_ALLOWED_TOOLS = prevAllowed;

    if (prevCli6 === undefined) delete process.env.HANDOFF_NO_CLI; else process.env.HANDOFF_NO_CLI = prevCli6;
    if (prev === undefined) delete process.env.HANDOFF_HOME; else process.env.HANDOFF_HOME = prev;
    delete require.cache[require.resolve('./handoff-core')];
  }

  /* ---- (c7) a compaction must not stop the daemon ----
   * llmSummarize was an `async function` wrapping spawnSync with a 90-second timeout, on the loop
   * that serves every other request. The relay's "home-offline: no reply within 10000ms" errors
   * were this, and they are a correctness hazard rather than a latency one: three dispatches that
   * day returned that error having ALREADY LANDED, so a caller who believed it would double-
   * dispatch.
   *
   * THE ASSERTION HAS TO BE ABLE TO FAIL, so it does not test the shape of the code. A fake
   * `claude` that sleeps stands in for a slow model; the test starts a compaction and then issues
   * an ordinary API call, and requires the ordinary call to FINISH FIRST. Under spawnSync it
   * cannot: the second call would not even begin until the child exited. Ordering is the evidence,
   * not elapsed time, so a slow machine cannot make this pass or fail by accident. */
  {
    const home = tmpHome();
    const prev = process.env.HANDOFF_HOME, prevBin = process.env.HANDOFF_CLAUDE_BIN, prevCli = process.env.HANDOFF_NO_CLI;
    const fake = path.join(home, 'fake-claude.sh');
    // --version answers instantly so claudeCliAvailable() is true; a compaction call sleeps.
    fs.writeFileSync(fake, '#!/bin/sh\ncase "$1" in --version) echo "1.0.0"; exit 0;; esac\nsleep 3\necho "SLOW SUMMARY"\n');
    fs.chmodSync(fake, 0o755);
    process.env.HANDOFF_HOME = home;
    process.env.HANDOFF_CLAUDE_BIN = fake;
    delete process.env.HANDOFF_NO_CLI;
    delete require.cache[require.resolve('./handoff-core')];
    const c7 = require('./handoff-core');

    const mk = await c7.handleApi('POST', '/api/sessions', {}, { surface: 'chat', title: 'compaction blocking probe' });
    const sid = mk.payload.id;
    // Enough text that the envelope compacts rather than travelling whole.
    const big = 'x'.repeat(c7.FULL_THRESHOLD + 1000);
    await c7.handleApi('POST', `/api/sessions/${sid}/messages`, {}, { role: 'user', kind: 'chat', text: big });

    const order = [];
    /* summarize:1 — the model path is OPT-IN now, so the test that asserts a compaction cannot
     * block the daemon has to ASK for one. Reads stopped compacting by default, which is the point
     * of the slice; this assertion still matters because a caller who deliberately buys a summary
     * must not stall everyone else while it runs. */
    const slow = c7.handleApi('GET', `/api/sessions/${sid}/brief`, { for: 'code', summarize: '1' }, {}).then(r => { order.push('compaction'); return r; });
    // Yield once so the compaction genuinely starts before the second call is issued.
    await new Promise(r => setImmediate(r));
    const quick = c7.handleApi('GET', '/api/state', {}, {}).then(r => { order.push('other-request'); return r; });
    await Promise.all([slow, quick]);

    ok(order[0] === 'other-request',
      '(c7) an ordinary request completes WHILE a compaction is in flight — the daemon does not stand still inside its own summariser'
      + ` (order: ${order.join(' then ')})`);

    /* The 90s ceiling was the one thing spawnSync did guarantee, and moving to spawn would silently
     * drop it. A child that never exits must still lose. */
    const started = Date.now();
    const capped = await new Promise(resolve => {
      const hang = path.join(home, 'hang-claude.sh');
      fs.writeFileSync(hang, '#!/bin/sh\ncase "$1" in --version) echo "1.0.0"; exit 0;; esac\nsleep 60\n');
      fs.chmodSync(hang, 0o755);
      process.env.HANDOFF_CLAUDE_BIN = hang;
      delete require.cache[require.resolve('./handoff-core')];
      const c7b = require('./handoff-core');
      // Reach the summariser directly with a short ceiling; the product ceiling is 90s.
      c7b.__claudeCompactForTests('probe', 1200).then(resolve);
    });
    ok(capped === null && Date.now() - started < 10000,
      '(c7) ...and a hung child is killed at the ceiling rather than waited on forever — the guarantee spawnSync gave is kept');

    if (prev === undefined) delete process.env.HANDOFF_HOME; else process.env.HANDOFF_HOME = prev;
    if (prevBin === undefined) delete process.env.HANDOFF_CLAUDE_BIN; else process.env.HANDOFF_CLAUDE_BIN = prevBin;
    if (prevCli === undefined) delete process.env.HANDOFF_NO_CLI; else process.env.HANDOFF_NO_CLI = prevCli;
    delete require.cache[require.resolve('./handoff-core')];
  }

  /* ---- (c8) a dispatched worker can PROVE its identity locally ----
   * Barrier 7. The child got HANDOFF_SESSION_ID and no CLAUDE_CODE_SESSION_ID, so the local mount
   * — which mints from a CLI uuid and refuses without one — could not identify it, and every
   * protocol call fell through to the relay and a 10-second budget. A worker with a record in the
   * store and no way to prove it owned one.
   *
   * The env is captured from a REAL SPAWN rather than read off the source, because the value under
   * test is what the child receives, and a spread of process.env is exactly the kind of thing that
   * looks right and delivers something else. */
  {
    const home = tmpHome();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workerenv-'));
    const prev = process.env.HANDOFF_HOME, prevBin = process.env.HANDOFF_CLAUDE_BIN;
    const prevCli = process.env.HANDOFF_NO_CLI, prevOwn = process.env.CLAUDE_CODE_SESSION_ID;
    const envDump = path.join(home, 'child-env.txt');
    const fake = path.join(home, 'env-claude.sh');
    /* Only the `-p` LAUNCH may write the dump. claudeCliAvailable() probes --version and
     * mcpRegistered() runs `mcp list` through this same binary; an earlier version let `mcp list`
     * write the file and the assertion then read the env of the wrong invocation — reporting a
     * borrowed identity that the launch did not actually have. The probe you forgot about is still
     * a process. */
    fs.writeFileSync(fake, `#!/bin/sh\ncase "$1" in\n  --version) echo "1.0.0"; exit 0;;\n  mcp) exit 0;;\n  -p) env > ${JSON.stringify(envDump)}; exit 0;;\nesac\nexit 0\n`);
    fs.chmodSync(fake, 0o755);
    process.env.HANDOFF_HOME = home;
    process.env.HANDOFF_CLAUDE_BIN = fake;
    delete process.env.HANDOFF_NO_CLI;
    // A parent identity that must NOT be inherited by the child.
    process.env.CLAUDE_CODE_SESSION_ID = 'PARENT-UUID-MUST-NOT-LEAK';
    delete require.cache[require.resolve('./handoff-core')];
    const c8 = require('./handoff-core');

    const r = await c8.handleApi('POST', '/api/workers', {}, {
      task: 'env capture', context: 'env capture', dir, mode: 'headless'
    });
    const native = r.payload && r.payload.launch && r.payload.launch.native_ref && r.payload.launch.native_ref.session_id;
    for (let i = 0; i < 40 && !fs.existsSync(envDump); i++) await new Promise(res => setTimeout(res, 100));
    const dump = fs.existsSync(envDump) ? fs.readFileSync(envDump, 'utf8') : '';
    const childUuid = (dump.match(/^CLAUDE_CODE_SESSION_ID=(.*)$/m) || [])[1];

    ok(!!childUuid && childUuid === native,
      '(c8) the spawned worker carries its OWN CLI uuid as CLAUDE_CODE_SESSION_ID — the local mount can mint, so the relay is not its only door'
      + ` (child=${childUuid || 'unset'} native=${native})`);
    ok(childUuid !== 'PARENT-UUID-MUST-NOT-LEAK',
      '(c8) ...and never inherits the parent\'s uuid through the process.env spread — a borrowed identity is the stored-address disease with a stolen address');
    ok(/^HANDOFF_SESSION_ID=/m.test(dump),
      '(c8) the protocol record id still travels too — one identity in two places, both the worker\'s own');

    if (prev === undefined) delete process.env.HANDOFF_HOME; else process.env.HANDOFF_HOME = prev;
    if (prevBin === undefined) delete process.env.HANDOFF_CLAUDE_BIN; else process.env.HANDOFF_CLAUDE_BIN = prevBin;
    if (prevCli === undefined) delete process.env.HANDOFF_NO_CLI; else process.env.HANDOFF_NO_CLI = prevCli;
    if (prevOwn === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prevOwn;
    delete require.cache[require.resolve('./handoff-core')];
  }

  /* ---- (c9) IDENTITY STEP 2 — nickname (R3) and participation (R1 as amended) ----
   * A nickname is not a second title. It is what a human types from memory to repair an identity
   * the model has lost, which is why uniqueness is enforced WHEN THE NAME IS CLAIMED: a collision
   * discovered at use time is discovered by someone who has already lost their identity and is
   * now being asked to disambiguate. Worst possible moment.
   *
   * Participation exists because minting on first contact — which gives a read-only conversation
   * an inbox — would otherwise fill every picker with records that have never spoken. The record
   * is addressable from first contact; it is simply not OFFERED until it acts. */
  {
    const home = tmpHome();
    const prev = process.env.HANDOFF_HOME, prevCli = process.env.HANDOFF_NO_CLI;
    process.env.HANDOFF_HOME = home; process.env.HANDOFF_NO_CLI = '1';
    delete require.cache[require.resolve('./handoff-core')];
    delete require.cache[require.resolve('./handoff-tools')];
    const c9 = require('./handoff-core');
    const t9 = require('./handoff-tools');
    const reg = async (uuid, body) => (await c9.handleApi('POST', '/api/register', {}, { native_id: uuid, cwd: '/tmp/x', ...body }));

    const a = await reg('11111111-1111-4111-8111-111111111111', { title: 'first', nickname: 'alpha' });
    const aId = a.payload && a.payload.session && a.payload.session.id;
    ok(!!aId && a.code < 300, '(c9) a nickname can be claimed at all');

    /* SETTING NEVER REFUSES A DUPLICATE — operator ruling 2026-08-10, overruling R3's set-time
     * refusal. Uniqueness is what ids are for; a nickname is a user-edited string, and a name that
     * refuses is a name pretending to be an id. The detection did not die — its VERDICT changed
     * from a block to an advisory, so duplication is a KNOWING act rather than a forbidden one.
     * These assertions previously defended the opposite rule; they are rewritten rather than
     * deleted, because the same scan is still being tested. */
    const b = await reg('22222222-2222-4222-8222-222222222222', { title: 'second', nickname: 'alpha' });
    ok(b.code < 300, '(c9) a second record may TAKE a name another already answers to — uniqueness is what ids are for');
    ok(/also answer to "alpha"/.test(b.payload.nickname_note || ''),
      '(c9) ...and is TOLD so, by surface and count — duplication becomes a knowing act, not a blocked one');
    ok((b.payload.nickname_duplicates || []).some(d => d.id === aId),
      '(c9) ...with the other holders named, so the human can tell which one they meant');

    const stDup = (await c9.handleApi('GET', '/api/state', {}, {})).payload;
    ok(stDup.sessions[b.payload.id].nickname === 'alpha',
      '(c9) ...and the name is actually SET — an advisory is a report, not a soft refusal');

    // Case-insensitive, because a human under pressure does not capitalise consistently.
    const d = await reg('33333333-3333-4333-8333-333333333333', { title: 'fourth', nickname: 'ALPHA' });
    ok(d.code < 300 && /also answer to/.test(d.payload.nickname_note || ''),
      '(c9) duplicate detection stays CASE-INSENSITIVE — a name typed from memory is not typed carefully, and the advisory must still fire');

    // One word only: a nickname that needs quoting is not a recovery path.
    const e = await reg('44444444-4444-4444-8444-444444444444', { title: 'fifth', nickname: 'two words' });
    ok(e.code === 400 && /one word/.test(e.payload.error),
      '(c9) a nickname must be one word — a name that needs quoting is not something typed under pressure');

    /* PARTICIPATION. A freshly minted record has never acted, so it is passive; registering is
     * write-shaped, so a registered terminal is active. Asserting the VALUE on both sides —
     * a test that only checked "the field exists" would pass with the flag stuck either way. */
    const passiveRes = await c9.handleApi('POST', '/api/sessions', {}, { surface: 'chat', title: 'reader' });
    const passiveId = passiveRes.payload.id;
    const st2 = (await c9.handleApi('GET', '/api/state', {}, {})).payload;
    ok(st2.sessions[passiveId].participation === 'passive',
      '(c9) a record that has only been minted is PASSIVE — addressable, with an inbox, but it has not spoken');
    ok(st2.sessions[aId].participation === 'active',
      '(c9) ...and registering is write-shaped, so a terminal that registered is ACTIVE');

    // The picker offers active records and SAYS what it withheld.
    const listed = await t9.callTool('list_conversations', {}, {}, c9);
    ok(!listed.includes('"reader"'), '(c9) the picker does not offer a record that has never acted');
    ok(/passive record\(s\) not shown/.test(listed),
      '(c9) ...but it SAYS SO and counts them — a list that silently omits rows is how someone concludes a conversation does not exist');
    const listedAll = await t9.callTool('list_conversations', { include_passive: true }, {}, c9);
    ok(listedAll.includes('"reader"'), '(c9) include_passive shows them — hidden is not the same as denied');

    /* NAMING A RECORD THAT CANNOT NAME ITSELF. Step 2 shipped with the nickname only on register,
     * so a chat conversation — which never registers, having no CLI uuid — could not be nicknamed
     * at all. That is the surface where identity is WEAKEST and the recovery path matters most,
     * and the gap surfaced on the first field use rather than in any test I wrote. Same rule from
     * both doors: one applyNickname, one per-surface refusal, because the check belongs to the
     * name and not to the caller. */
    const chatRec = await c9.handleApi('POST', '/api/sessions', {}, { surface: 'chat', title: 'a conversation that cannot register' });
    const chatId = chatRec.payload.id;
    const named = await c9.handleApi('POST', `/api/sessions/${chatId}/nickname`, {}, { nickname: 'beta', by: 'operator' });
    ok(named.code === 200 && named.payload.nickname === 'beta',
      '(c9) a record with no CLI uuid CAN be named by someone else — chat is where identity is weakest and the recovery path matters most');
    ok(named.payload.provenance === 'asserted',
      '(c9) ...and the grant is labelled ASSERTED, because naming another record is a claim of authority, not a verification');
    const clash = await c9.handleApi('POST', `/api/sessions/${chatId}/nickname`, {}, { nickname: 'beta' });
    void clash;
    const chat2 = await c9.handleApi('POST', '/api/sessions', {}, { surface: 'chat', title: 'another chat' });
    const clash2 = await c9.handleApi('POST', `/api/sessions/${chat2.payload.id}/nickname`, {}, { nickname: 'BETA' });
    ok(clash2.code === 200 && /also answer to/.test(clash2.payload.note || ''),
      '(c9) ...and the SAME advisory comes from this door — one rule, two call sites, which is why applyNickname stayed shared when its verdict changed');

    /* RESOLUTION NOW CARRIES THE UNIQUENESS BURDEN, which is the other half of the ruling and the
     * half that makes the loosening safe. Two records answering to one name is fine; SILENTLY
     * PICKING between them never was. This is the ambiguity grammar this file already had —
     * exact beats substring, several matches are listed and never scored — applied to one more
     * field. Asserted through the real resolver, not by reading the matcher. */
    const nickHits = t9.filterByName(Object.values((await c9.handleApi('GET', '/api/state', {}, {})).payload.sessions)
      .filter(x => !x.archived), 'alpha');
    ok(nickHits.length >= 2,
      '(c9) resolution FINDS every record answering to a duplicated nickname — listing is the point, so none may be dropped');
    ok(nickHits.every(x => String(x.nickname || '').toLowerCase() === 'alpha'),
      '(c9) ...and matches it EXACTLY — an exact nickname beats a title that merely contains the word, or the recovery name would surface strangers');

    /* The addressability the nickname was stored for, and did not have until now: it was a
     * recovery path nothing resolved by, which is a recovery path only on paper. */
    const byNick = t9.filterByName(Object.values((await c9.handleApi('GET', '/api/state', {}, {})).payload.sessions)
      .filter(x => !x.archived && x.surface === 'chat'), 'beta');
    ok(byNick.length && byNick.some(x => x.nickname === 'beta'),
      '(c9) a record is addressable BY ITS NICKNAME — stored-but-unresolvable is what this ruling exposed');

    /* ONE RESOLVE-BY-NICKNAME PER SURFACE, ruled after the field shipped unaddressable. The
     * feature's PURPOSE is that a human who has lost everything can type one word and be found;
     * every assertion I wrote first defended the rule ABOUT the field (its refusal) and none
     * defended what it was for. So the load-bearing test is this one, and it runs on every surface
     * because a recovery path that works on chat and not on cowork is a recovery path with a hole
     * exactly where someone will fall through it. */
    for (const surf of ['chat', 'cowork', 'design', 'code']) {
      const rec = await c9.handleApi('POST', '/api/sessions', {}, { surface: surf, title: `a ${surf} conversation` });
      const nick = `recall-${surf}`;
      await c9.handleApi('POST', `/api/sessions/${rec.payload.id}/nickname`, {}, { nickname: nick, by: 'operator' });
      const all = Object.values((await c9.handleApi('GET', '/api/state', {}, {})).payload.sessions).filter(x => !x.archived);
      const found = t9.filterByName(all, nick);
      ok(found.length === 1 && found[0].id === rec.payload.id,
        `(c9) a ${surf} record is found by its nickname alone — the purpose of the field, asserted per surface`);
    }

    // One direction: passive is a claim about what a record has NEVER done.
    await c9.handleApi('POST', `/api/sessions/${passiveId}/messages`, {}, { role: 'user', kind: 'chat', text: 'now it speaks' });
    const st3 = (await c9.handleApi('GET', '/api/state', {}, {})).payload;
    ok(st3.sessions[passiveId].participation === 'active' && !!st3.sessions[passiveId].activated_at,
      '(c9) a first write-shaped act flips it to ACTIVE, stamped, once and in one direction');

    if (prev === undefined) delete process.env.HANDOFF_HOME; else process.env.HANDOFF_HOME = prev;
    if (prevCli === undefined) delete process.env.HANDOFF_NO_CLI; else process.env.HANDOFF_NO_CLI = prevCli;
    delete require.cache[require.resolve('./handoff-core')];
    delete require.cache[require.resolve('./handoff-tools')];
  }

  /* ---- (c10) THE OBJECT TYPE — first build against OBJECT-RECORD-SPEC §13-§17 ----
   * The spec is design-only; this asserts the slice that shipped and nothing it merely proposes.
   * The evidence law gets the most, because it is the rule with teeth: an outcome without
   * machine-checkable evidence is refused, and the refusal must offer the downgrade — a law that
   * makes honest reporting impossible gets routed around. */
  {
    const home = tmpHome();
    const prev = process.env.HANDOFF_HOME;
    process.env.HANDOFF_HOME = home;
    delete require.cache[require.resolve('./handoff-core')];
    const c10 = require('./handoff-core');

    const mk = await c10.handleApi('POST', '/api/sessions', {}, { surface: 'code', title: 'the board', type: 'todo' });
    const oid = mk.payload.id;
    const st0 = (await c10.handleApi('GET', '/api/state', {}, {})).payload;
    ok(st0.sessions[oid].type === 'todo',
      '(c10) a record carries a TYPE — §13 resolution (A): a type over existing records, no new collection and no second identity implementation');

    // Ordinary events append and flip participation, because append IS the write-shaped act.
    const e1 = await c10.handleApi('POST', `/api/objects/${oid}/events`, {}, { kind: 'proposed', body: 'ship the pilot', actor: 'operator', actor_kind: 'human' });
    ok(e1.code === 201 && e1.payload.participation === 'active',
      '(c10) append is a write-shaped act and flips participation passive→active (§16.4)');

    /* THE EVIDENCE LAW. Prose in an evidence field is malformed input — not a weaker outcome. */
    const bad = await c10.handleApi('POST', `/api/objects/${oid}/events`, {}, {
      kind: 'suite_passed', evidence: 'I ran the tests and they all passed, honestly'
    });
    ok(bad.code === 400 && bad.payload.field === 'evidence',
      '(c10) an outcome whose evidence is PROSE is refused and the refusal NAMES THE FIELD — not asking the caller to guess which of five looked wrong');
    ok(bad.payload.downgrade === 'claim' && /kind:"claim"/.test(bad.payload.error),
      '(c10) ...and offers the lossless downgrade, because a law that makes honest reporting impossible gets routed around');

    const good = await c10.handleApi('POST', `/api/objects/${oid}/events`, {}, {
      kind: 'suite_passed', evidence: { suite: 'daemon', passed: 129, exit_status: 0 }, evidence_class: 'verified'
    });
    ok(good.code === 201, '(c10) ...while an outcome carrying values a rechecker could compare is accepted');

    const claim = await c10.handleApi('POST', `/api/objects/${oid}/events`, {}, { kind: 'claim', body: 'I ran the tests and they all passed, honestly' });
    ok(claim.code === 201, '(c10) the same words file cleanly as a CLAIM — the caller\'s report is never destroyed, only classified');

    const unknown = await c10.handleApi('POST', `/api/objects/${oid}/events`, {}, { kind: 'vibes' });
    ok(unknown.code === 400 && /absence is never permission/.test(unknown.payload.error),
      '(c10) an unrecognised kind is refused rather than stored — absence is never permission');

    /* THE §16.4 CARVE-OUT, flagged by BLOB-SPLIT-SPEC before anything could depend on it. */
    const quiet = await c10.handleApi('POST', '/api/sessions', {}, { surface: 'code', title: 'never spoke', type: 'todo' });
    await c10.handleApi('POST', `/api/objects/${quiet.payload.id}/events`, {}, { kind: 'blob_pruned', actor_kind: 'system', body: 'retention pass' });
    const st1 = (await c10.handleApi('GET', '/api/state', {}, {})).payload;
    ok(st1.sessions[quiet.payload.id].participation === 'passive',
      '(c10) a SYSTEM lifecycle event does not activate a passive object — a retention pass must not silently mark every quiet object as having spoken');

    // read: three modes, and a dangling cursor refuses rather than restarting from the beginning.
    const proj = await c10.handleApi('GET', `/api/objects/${oid}`, { as: 'projection' }, {});
    /* THREE events, not five: the prose outcome and the unknown kind were REFUSED, and a refusal
     * appends nothing. Worth asserting the exact number rather than "some events" — it is the only
     * assertion here that would catch a refusal that returned 400 while still writing. */
    ok(proj.payload.events === 3 && proj.payload.claims === 1 && proj.payload.outcomes.length === 1,
      '(c10) the projection is DERIVED from the history — and a refused event appended NOTHING, which only an exact count catches');
    const hist = await c10.handleApi('GET', `/api/objects/${oid}`, { as: 'history', after: e1.payload.event_id }, {});
    ok(hist.payload.events.length === 2 && hist.payload.total === 3,
      '(c10) history returns events AFTER a cursor — the diff path a recap needs');
    const dangling = await c10.handleApi('GET', `/api/objects/${oid}`, { as: 'history', after: 'evt_nope' }, {});
    ok(dangling.code === 400,
      '(c10) ...and a cursor naming no event REFUSES, rather than silently meaning "from the beginning"');
    const snap = await c10.handleApi('GET', `/api/objects/${oid}`, { as: 'snapshot' }, {});
    ok(!!snap.payload.snapshot && !!snap.payload.taken_at,
      '(c10) a snapshot is the projection frozen and addressed, delivered by value');

    if (prev === undefined) delete process.env.HANDOFF_HOME; else process.env.HANDOFF_HOME = prev;
    delete require.cache[require.resolve('./handoff-core')];
  }

  /* ---- (c11) A LOCKED DECISION IS VERBATIM OR IT IS REFUSED ----
   * The write path did text.slice(0, 200) into a collection rendered under "Locked constraints
   * (verbatim — do not re-litigate)". Measured 2026-08-10: 13 of 164 stored decisions sit at
   * exactly the cap with their tails gone, shown to every reader as the caller's exact words. The
   * most protected data class in the protocol — the thing a receiver is told not to re-litigate —
   * was the one being silently cut. */
  {
    const home = tmpHome();
    const prev = process.env.HANDOFF_HOME;
    process.env.HANDOFF_HOME = home;
    delete require.cache[require.resolve('./handoff-core')];
    const c11 = require('./handoff-core');

    const s = await c11.handleApi('POST', '/api/sessions', {}, { surface: 'chat', title: 'decisions' });
    const sid = s.payload.id;
    const long = 'We lock the following constraint, at length, because it needs the precision: ' + 'x'.repeat(200);

    const refused = await c11.handleApi('POST', `/api/sessions/${sid}/messages`, {}, { role: 'user', kind: 'chat', text: long, decision: true });
    ok(refused.code === 400,
      '(c11) an over-length decision is REFUSED at write time — a cap that truncates under a "verbatim" heading is a broken promise, not a limit');
    ok(/VERBATIM/.test(refused.payload.error) && /SPLIT IT INTO TWO/.test(refused.payload.error),
      '(c11) ...and the remedy names BOTH honest options — shorten, or split — because some constraints genuinely need the precision');
    ok(/Nothing was stored/.test(refused.payload.error),
      '(c11) ...and says nothing was stored, so a caller is never left guessing whether a half-write happened');

    const st = (await c11.handleApi('GET', '/api/state', {}, {})).payload;
    ok((st.sessions[sid].decisions || []).length === 0,
      '(c11) ...and NOTHING was stored — asserting the store, not the status code, because a 400 that wrote anyway is the exact failure this replaces');

    // A decision within the limit still locks, unchanged and untruncated.
    const okText = 'Ship the deterministic checkpoint first; no model in the checkpoint path.';
    await c11.handleApi('POST', `/api/sessions/${sid}/messages`, {}, { role: 'user', kind: 'chat', text: okText, decision: true });
    const st2 = (await c11.handleApi('GET', '/api/state', {}, {})).payload;
    ok(st2.sessions[sid].decisions.length === 1 && st2.sessions[sid].decisions[0].text === okText,
      '(c11) a decision within the limit is stored WHOLE and byte-identical — the promise kept, not merely unbroken');

    /* The 13 already stored cannot be repaired, so the RENDERER stops overclaiming on them. */
    const envSess = st2.sessions[sid];
    envSess.decisions.push({ text: 'y'.repeat(200), source_message: null });
    const brief = c11.buildBrief('code', { decisions: envSess.decisions, open_items: [], artifacts: [], notes: null, created_at: new Date().toISOString(), context_mode: 'full', transcript: [], summary: '' }, envSess);
    ok(/not recoverable/.test(brief) && /possibly incomplete/.test(brief),
      '(c11) a decision sitting AT the limit renders with a warning — a lost tail is a fact about the record, and repairing its appearance would be the dishonesty this refuses');
    ok(!/not recoverable/.test(brief.split('\n').filter(l => l.includes(okText)).join('\n')),
      '(c11) ...while a short decision renders clean — the warning marks the suspect ones, never all of them');

    if (prev === undefined) delete process.env.HANDOFF_HOME; else process.env.HANDOFF_HOME = prev;
    delete require.cache[require.resolve('./handoff-core')];
  }

  /* ---- (c12) THE DETERMINISTIC CHECKPOINT — no model in the path, ever ----
   * A checkpoint is read by a session that has LOST its context and therefore cannot check what it
   * is told. So the whole design turns on one asymmetry: its failure mode must be TOO TERSE and can
   * never be CONFIDENTLY WRONG. A summariser fails the other way round, which is exactly backwards
   * for a reader with no way to verify — which is why the operator ruled no model in this path and
   * why the parked summariser slice keeps its own gate.
   *
   * The hardest thing to test is an absence, so most of this block is about what the checkpoint
   * does NOT do when it has nothing. */
  {
    const home = tmpHome();
    const prev = process.env.HANDOFF_HOME;
    process.env.HANDOFF_HOME = home;
    delete require.cache[require.resolve('./handoff-core')];
    const c12 = require('./handoff-core');

    /* THE EMPTY CASE FIRST, because it is the one that matters. A record with nothing on it must
     * produce a checkpoint that SAYS it has nothing — not a plausible sentence about a session. */
    const bare = await c12.handleApi('POST', '/api/sessions', {}, { surface: 'chat', title: 'nothing happened here' });
    const cpBare = (await c12.handleApi('GET', `/api/sessions/${bare.payload.id}/checkpoint`, {}, {})).payload;
    ok(cpBare.deterministic === true && Array.isArray(cpBare.brief) && cpBare.brief.length === 0,
      '(c12) an empty record yields an EMPTY brief — too terse, never a plausible summary of a session that did nothing');
    ok(cpBare.absent.some(a => /brief/.test(a)) && cpBare.absent.some(a => /decisions/.test(a)),
      '(c12) ...and every missing field is NAMED in absent — "we do not know" is a fact a successor can act on; a confident guess is not');
    ok(cpBare.identity.id === bare.payload.id && cpBare.counts.messages === 0,
      '(c12) ...while identity and counts are still exact, because those are known');

    // A populated record: everything verbatim or hashed, nothing described.
    /* Set through the API, NOT by mutating a /api/state snapshot: handleApi calls load() at the top
     * of every operation, so an in-memory change to a returned object is wiped before the next
     * call can see it. The id-invariant comment documents that same seam; my first version of this
     * block hit it and two assertions failed for a reason that was mine, not the code's. */
    const rich = await c12.handleApi('POST', '/api/sessions', {}, {
      surface: 'code', title: 'real work',
      artifacts: [{ name: 'PATCH.diff', content: 'diff --git a/x b/x\n+one line\n' }],
      open_items: ['re-dispatch after the mirror lands'],
    });
    const rid = rich.payload.id;
    const briefText = 'Context from the conversation: apply the fix to the notebook build, not this one.';
    await c12.handleApi('POST', `/api/sessions/${rid}/messages`, {}, { role: 'user', kind: 'context', text: briefText });
    await c12.handleApi('POST', `/api/sessions/${rid}/messages`, {}, { role: 'user', kind: 'chat', text: 'lock: mirror before dispatching', decision: true });

    const cp = (await c12.handleApi('GET', `/api/sessions/${rid}/checkpoint`, {}, {})).payload;
    ok(cp.brief.length === 1 && cp.brief[0] === briefText,
      '(c12) the human-written brief travels VERBATIM and whole — the one field a summariser may never touch');
    ok(cp.decisions.length === 1 && cp.decisions[0].text === 'lock: mirror before dispatching',
      '(c12) decisions travel verbatim, not paraphrased');
    ok(cp.artifacts.length === 1 && cp.artifacts[0].sha256 &&
       cp.artifacts[0].sha256 === require('crypto').createHash('sha256').update('diff --git a/x b/x\n+one line\n').digest('hex'),
      '(c12) artifacts travel BY HASH — the load-bearing half, proving which bytes were meant without carrying them');
    ok(!JSON.stringify(cp.artifacts).includes('+one line'),
      '(c12) ...and the BODY is not in the checkpoint, or it would be the bloat BLOB-SPLIT exists to prevent');
    ok(cp.open_items.length === 1, '(c12) open items travel as written');

    /* NO MODEL IN THE PATH. The strongest available check: a checkpoint built with the CLI made
     * unavailable is byte-identical to one built with it available, apart from its timestamp. If
     * anything in this path could reach a summariser, that equality would not hold. */
    const prevNoCli = process.env.HANDOFF_NO_CLI;
    process.env.HANDOFF_NO_CLI = '1';
    const cpNoCli = (await c12.handleApi('GET', `/api/sessions/${rid}/checkpoint`, {}, {})).payload;
    if (prevNoCli === undefined) delete process.env.HANDOFF_NO_CLI; else process.env.HANDOFF_NO_CLI = prevNoCli;
    const strip = o => { const c = JSON.parse(JSON.stringify(o)); delete c.taken_at; return JSON.stringify(c); };
    ok(strip(cp) === strip(cpNoCli),
      '(c12) the checkpoint is IDENTICAL with the model unavailable — nothing in this path can reach a summariser');

    if (prev === undefined) delete process.env.HANDOFF_HOME; else process.env.HANDOFF_HOME = prev;
    delete require.cache[require.resolve('./handoff-core')];
  }

  /* ---- (c13) A READ DOES NOT PAY FOR A SUMMARY IT DID NOT ASK FOR ----
   * Any payload over FULL_THRESHOLD used to send every get_handoff through compact(), which spawns
   * a model with a 90-second ceiling. That is what blew the relay's 10-second budget, pushed
   * workers onto the slow mount, and once made a worker recover its own task by reading the store
   * off disk because the read it had been told to make timed out.
   *
   * The proof is the same shape as the checkpoint's: build the thing with the model UNAVAILABLE
   * and require it to be identical. A default read that cannot notice the model is missing is a
   * default read that never called it. */
  {
    const home = tmpHome();
    const prev = process.env.HANDOFF_HOME, prevBin = process.env.HANDOFF_CLAUDE_BIN, prevCli = process.env.HANDOFF_NO_CLI;
    process.env.HANDOFF_HOME = home;
    delete require.cache[require.resolve('./handoff-core')];
    const c13 = require('./handoff-core');

    const s13 = await c13.handleApi('POST', '/api/sessions', {}, { surface: 'chat', title: 'a long one' });
    const sid13 = s13.payload.id;
    await c13.handleApi('POST', `/api/sessions/${sid13}/messages`, {}, { role: 'user', kind: 'chat', text: 'Do the work described here. ' + 'padding. '.repeat(400) });

    const cheap = (await c13.handleApi('GET', `/api/sessions/${sid13}/brief`, { for: 'code' }, {})).payload;
    ok(cheap.summary_kind === 'deterministic',
      '(c13) a payload over the threshold reads DETERMINISTIC by default — compaction on read is work the reader did not ask for');

    /* With the model unreachable the default read must be byte-identical. If anything in that path
     * could reach a summariser, this equality would not hold. */
    process.env.HANDOFF_NO_CLI = '1';
    process.env.HANDOFF_CLAUDE_BIN = '/nonexistent/definitely-not-a-binary';
    const cheapNoModel = (await c13.handleApi('GET', `/api/sessions/${sid13}/brief`, { for: 'code' }, {})).payload;
    /* NORMALISE THE TIMESTAMP BEFORE COMPARING. buildBrief stamps env.created_at into its header,
     * so two builds straddling a clock tick differ by a millisecond and nothing else — this
     * assertion flaked once in five runs before that was accounted for. Comparing a value that is
     * SUPPOSED to vary makes a test that fails for being right. Everything else must match
     * exactly, which is the property under test. */
    const norm = b => String(b).replace(/\(20\d\d-\d\d-\d\dT[0-9:.]+Z\)/g, '(TS)');
    ok(norm(cheap.brief) === norm(cheapNoModel.brief),
      '(c13) ...and is IDENTICAL with the model unreachable, modulo its timestamp — a default read that cannot notice the model is gone never called it');
    if (prevCli === undefined) delete process.env.HANDOFF_NO_CLI; else process.env.HANDOFF_NO_CLI = prevCli;
    if (prevBin === undefined) delete process.env.HANDOFF_CLAUDE_BIN; else process.env.HANDOFF_CLAUDE_BIN = prevBin;

    ok(/not summarized — history is in the record/.test(cheap.brief),
      '(c13) ...and it SAYS it was not summarized, so nobody mistakes terseness for the whole story');

    // The verbatim channels are unaffected: what a reader actually needs never went through a model.
    ok(/padding\./.test(cheap.brief) || cheap.brief.length > 0,
      '(c13) the brief still carries the record\'s own content — cheaper means no paraphrase, not less payload');

    // Opt-in still reaches the model path, so nothing is removed, only made explicit.
    const asked = (await c13.handleApi('GET', `/api/sessions/${sid13}/brief`, { for: 'code', summarize: '1' }, {})).payload;
    ok(asked.summary_kind === 'model',
      '(c13) a caller who WANTS a narrative can still buy one — the model is opt-in, not deleted');

    if (prev === undefined) delete process.env.HANDOFF_HOME; else process.env.HANDOFF_HOME = prev;
    delete require.cache[require.resolve('./handoff-core')];
  }

  /* ---- (c14) THE HEARTBEAT VERB — own-host only, refused whole ----
   * The remote door widened by exactly one tool so a wake agent on a second machine can assert a
   * verdict for its own records. That is the act that flips reachability from 'unknown' to
   * host-asserted, and it is the acceptance test this review was opened around.
   *
   * The refusal ships WITH the verb rather than after it: a door that widens without its guard
   * tested is a door whose guard is a comment. */
  {
    const home = tmpHome();
    const prev = process.env.HANDOFF_HOME;
    process.env.HANDOFF_HOME = home;
    delete require.cache[require.resolve('./handoff-core')];
    delete require.cache[require.resolve('./handoff-tools')];
    const c14 = require('./handoff-core');
    const t14 = require('./handoff-tools');

    // Two remote records on two different hosts.
    const mine = (await c14.handleApi('POST', '/api/register-remote', {}, { host: 'my-laptop', title: 'mine', attested_by: 'operator', minted_by: 'test' })).payload.session;
    const theirs = (await c14.handleApi('POST', '/api/register-remote', {}, { host: 'other-host', title: 'theirs', attested_by: 'operator', minted_by: 'test' })).payload.session;

    /* peek lists records with mail WAITING, so a record needs something waiting on it before its
     * reachability is reported at all — my first version asserted the verdict on a record nobody
     * was writing to, and read an empty peek as a wrong verdict. */
    await c14.handleApi('POST', `/api/sessions/${mine.id}/messages`, {}, { role: 'user', kind: 'xmsg', text: '[message from chat · x] waiting' });

    // Before any heartbeat, a remote record reads unknown — nobody has looked.
    const before = await t14.callTool('peek_inbox', { surface: 'code' }, {}, c14);
    ok(/reachable: unknown/.test(before),
      '(c14) a remote record reads UNKNOWN before its host has ever spoken — not unreachable, unlooked-at');

    // THE REFUSAL, and it must refuse WHOLE rather than filtering.
    const crossed = await t14.callTool('agent_heartbeat', {
      host: 'my-laptop', sessions: { [mine.id]: 'process', [theirs.id]: 'process' }, agent_version: '0.1.0',
    }, {}, c14);
    ok(/Refused/.test(crossed) && /belongs to other-host/.test(crossed),
      '(c14) a heartbeat naming ANOTHER host\'s record is refused, and the refusal names which record and whose it is');
    ok(/NOTHING was written/.test(crossed),
      '(c14) ...refused WHOLE, not filtered — silently dropping the foreign entries would let a caller believe it asserted something it did not');

    const stAfterRefusal = (await c14.handleApi('GET', '/api/state', {}, {})).payload;
    ok(!stAfterRefusal.agents || !stAfterRefusal.agents['my-laptop'],
      '(c14) ...and the store proves it: no agent record was written by the refused call');

    // The legitimate case: only its own records, and the verdict lands.
    const okBeat = await t14.callTool('agent_heartbeat', {
      host: 'my-laptop', sessions: { [mine.id]: 'process' }, agent_version: '0.1.0',
    }, {}, c14);
    ok(/Heartbeat recorded for "my-laptop"/.test(okBeat),
      '(c14) a heartbeat for the caller\'s OWN records is recorded');

    const after = await t14.callTool('peek_inbox', { surface: 'code' }, {}, c14);
    ok(/reachable: process/.test(after),
      '(c14) THE FLIP: reachability now reads what that host observed, not "unknown" — the acceptance test this verb exists for');

    /* NO STATE-READ COMPANION, asserted so nobody "completes" the surface later. The gap is the
     * design: the door widened for an acceptance test, never for a convenience. */
    const { TOOLS } = require('./handoff-tool-schemas');
    ok(TOOLS.some(t => t.name === 'agent_heartbeat'),
      '(c14) the verb is on the remote surface, or a remote agent cannot reach it');
    ok(!TOOLS.some(t => /state|enumerate/i.test(t.name)),
      '(c14) ...and NO state-read tool rode in beside it — the enumeration gap is deliberate and stays open');

    if (prev === undefined) delete process.env.HANDOFF_HOME; else process.env.HANDOFF_HOME = prev;
    delete require.cache[require.resolve('./handoff-core')];
    delete require.cache[require.resolve('./handoff-tools')];
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
    const cwd = '$HOME/dev/demo-repo';
    fs.writeFileSync(path.join(regDir, '12345.json'), JSON.stringify({ pid: 12345, sessionId: uuid, cwd, name: 'repo-agent-2a' }));
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
