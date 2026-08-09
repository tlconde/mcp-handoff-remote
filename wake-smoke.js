#!/usr/bin/env node
'use strict';
/**
 * wake-smoke — deterministic tests for the wake tier (bin/handoff-wake.js).
 *
 * No real CLI spawn, no OS notification: the relay's spawn and the notify layer are injected
 * (opts.spawn / opts.notify), and reachability reads a fixture sessions dir. Proves the
 * approved tier order, the exact wake line, one-call/no-retry, the fyi skip, and the
 * open/closed reachability decision.
 *
 * Run: node wake-smoke.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { wake, nativeReach, relayPrompt, notifyCopy, WAKE_LINE } = require('./bin/handoff-wake');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e && e.message}`); }
}

// A fake spawn that records every call and returns an inert child.
function recorder() {
  const calls = [];
  const spawn = (bin, argv, opts) => {
    calls.push({ bin, argv, opts });
    // A REAL successful spawn has a pid; its absence is how the tier detects a spawn that
    // never started. A stub without one describes a failure, not a success — the same
    // fixture-honesty rule as the live pids in the sessions fixture.
    return { pid: 4242, on() { return this; }, unref() {} };
  };
  return { spawn, calls };
}
function throwingSpawn() {
  return (bin) => { throw new Error(`ENOENT spawn ${bin}`); };
}
function notifyRecorder() {
  const calls = [];
  const notify = (ev) => { calls.push(ev); return { fired: true, channel: 'log' }; };
  return { notify, calls };
}

/* Fixture native-sessions dir: writes registration json + a stand-in socket file for OPEN.
 * The pids are REAL live processes, not invented numbers. "Closed" now means "no live
 * process right now" (the resume-invariant ruling), so the wake tier checks pid liveness —
 * and a fixture built on pids that never existed would describe a world where every session
 * is dead. Real sleepers also buy a much stronger test than deleting a socket file: we can
 * kill one and prove the tier calls it closed because the PROCESS went away. */
const LIVE_KIDS = [];
function livePid() {
  const c = require('child_process').spawn('sleep', ['120'], { stdio: 'ignore', detached: true });
  c.unref(); LIVE_KIDS.push(c);
  return c.pid;
}
function reapLiveKids() { for (const c of LIVE_KIDS) { try { process.kill(c.pid); } catch (_) {} } }
process.on('exit', reapLiveKids);
process.on('SIGINT', () => { reapLiveKids(); process.exit(130); });
function fixtureSessions() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-sess-'));
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-sock-'));
  const write = (pid, sessionId, name, opts = {}) => {
    const sock = opts.socket === null ? undefined
      : path.join(sockDir, `${pid}.sock`);
    if (sock && opts.socketExists !== false) fs.writeFileSync(sock, '');
    fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({
      pid, sessionId, name, cwd: opts.cwd || '/tmp/x', status: opts.status || 'idle',
      messagingSocketPath: sock,
    }));
  };
  return { dir, sockDir, write };
}

const OPEN_UUID = '11111111-1111-1111-1111-111111111111';
const CLOSED_UUID = '22222222-2222-2222-2222-222222222222';
const NOREG_UUID = '33333333-3333-3333-3333-333333333333';

function withEnv(over, fn) {
  const saved = {};
  for (const k of Object.keys(over)) { saved[k] = process.env[k]; if (over[k] == null) delete process.env[k]; else process.env[k] = over[k]; }
  try { return fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } }
}

console.log('wake-smoke:');

const fx = fixtureSessions();
const OPEN_PID = livePid(), CLOSED_PID = livePid();
fx.write(OPEN_PID, OPEN_UUID, 'ai-product-sense-72');                       // open: live pid + socket
fx.write(CLOSED_PID, CLOSED_UUID, 'ai-product-sense-77', { socketExists: false }); // live pid, socket gone

// ---- reachability ----
test('nativeReach: open when registration + live socket', () => withEnv({ HANDOFF_SESSIONS_DIR: fx.dir }, () => {
  const r = nativeReach({ session_id: OPEN_UUID });
  assert.strictEqual(r.open, true, 'should be open');
  assert.strictEqual(r.name, 'ai-product-sense-72');
}));

test('nativeReach: closed when socket is gone', () => withEnv({ HANDOFF_SESSIONS_DIR: fx.dir }, () => {
  const r = nativeReach({ session_id: CLOSED_UUID });
  assert.strictEqual(r.open, false);
  assert.match(r.reason, /socket gone/);
}));

test('nativeReach: closed when no registration row', () => withEnv({ HANDOFF_SESSIONS_DIR: fx.dir }, () => {
  const r = nativeReach({ session_id: NOREG_UUID });
  assert.strictEqual(r.open, false);
}));

test('nativeReach: closed on null native_ref', () => {
  assert.strictEqual(nativeReach(null).open, false);
});

/* ---- the resume invariant at the wake tier ----
 * A stored native_ref is a HINT, validated live at use time — never an address. These four
 * encode the ruling: a resumed session must not read as closed-by-accident, a dead binding
 * must never be resolved by proximity, a genuinely dead process must still read closed, and
 * the honest-physics two-step (notify+heal, then wake) must be visible to the caller. */
test('resume: a forked session id makes the binding stale — reported as stale, NOT as closed', () => withEnv({ HANDOFF_SESSIONS_DIR: fx.dir }, () => {
  // Same live process, new session id written over its row: exactly what `claude --resume` does.
  const RESUMED = '44444444-4444-4444-4444-444444444444';
  fx.write(OPEN_PID, RESUMED, 'ai-product-sense-72', { cwd: '/repo/one' });
  const r = nativeReach({ session_id: OPEN_UUID, cwd: '/repo/one' }); // caller still holds the OLD id
  assert.strictEqual(r.open, false, 'cannot wake: nothing validates the old id');
  assert.strictEqual(r.stale_binding, true, 'must be reported as a STALE BINDING, not a closed session');
  fx.write(OPEN_PID, OPEN_UUID, 'ai-product-sense-72'); // restore for later tests
}));

test('resume: several live sessions share a cwd → refuses to guess, and says how many', () => withEnv({ HANDOFF_SESSIONS_DIR: fx.dir }, () => {
  const a = livePid(), b = livePid();
  fx.write(a, '55555555-5555-5555-5555-555555555555', 'proj-a1', { cwd: '/repo/shared' });
  fx.write(b, '66666666-6666-6666-6666-666666666666', 'proj-b2', { cwd: '/repo/shared' });
  const r = nativeReach({ session_id: 'dead-binding-uuid', cwd: '/repo/shared' });
  assert.strictEqual(r.open, false, 'six-way silent resolution is the disease; refusing is the cure');
  assert.strictEqual(r.candidates, 2, 'candidates are counted to EXPLAIN, never to pick from');
  assert.match(r.reason, /refusing to guess/);
}));

test('resume: a dead PROCESS still reads closed — the fix must not manufacture false positives', () => withEnv({ HANDOFF_SESSIONS_DIR: fx.dir }, () => {
  const GHOST = '77777777-7777-7777-7777-777777777777';
  const alivePid = livePid();
  fx.write(alivePid, GHOST, 'proj-ghost', { cwd: '/repo/ghost' });
  assert.strictEqual(nativeReach({ session_id: GHOST }).open, true, 'alive while its process is alive');
  fs.unlinkSync(path.join(fx.dir, `${alivePid}.json`)); // the process exits; its row is replaced, not duplicated
  // A pid that has genuinely exited AND been reaped. Killing a detached child would not do:
  // until its parent reaps it, it lingers as a zombie and kill(pid, 0) still succeeds — the
  // process would read alive when it is not, which is the very confusion under test.
  const deadPid = require('child_process').spawnSync('true').pid;
  fx.write(deadPid, GHOST, 'proj-ghost', { cwd: '/repo/ghost' });
  const r = nativeReach({ session_id: GHOST, cwd: '/repo/ghost' });
  assert.strictEqual(r.open, false, 'row and socket both still on disk — only the PROCESS is gone');
  assert.match(r.reason, /no live session for this workspace/);
}));

test('resume: the stale-binding send degrades to the store and says so — the two-step, made visible', () => withEnv({ HANDOFF_SESSIONS_DIR: fx.dir }, () => {
  const n = notifyRecorder();
  const s = recorder();
  const r = wake({ tier: 'attention', thread: 'Wake tier', conversation: 'Wake tier', from: 'chat',
    native_ref: { session_id: 'dead-binding-uuid', cwd: '/repo/shared', name: 'proj-a1' } },
    { spawn: s.spawn, notify: n.notify });
  assert.strictEqual(r.tier, 'store', 'first send after a resume degrades to the store BY DESIGN — no rung claims to have shown anything');
  assert.strictEqual(r.stale_binding, true, 'the caller can tell "unverifiable" from "closed"');
  assert.strictEqual(s.calls.length, 0, 'no relay was attempted');
  assert.strictEqual(n.calls.length, 0, 'nothing is notified — the rung is gone; the store already holds the mail');
}));

// ---- wake line format (locked verbatim) ----
test('wake line is the one approved line', () => {
  // THE KNOCK NAMES THE SENDER WITHOUT IMPERSONATING. The line rides inside a native message
  // the RELAY sent, so native already attributes the knock to the relay; the text supplies the
  // LETTER's provenance, which is a different fact. It must never claim to BE the sender.
  assert.strictEqual(WAKE_LINE('T-42', 'your chat'), 'mail from your chat on T-42 is waiting — checking the inbox will deliver it');
  assert.strictEqual(WAKE_LINE('T-42'), 'mail waiting on T-42 — checking the inbox will deliver it');
  assert.ok(!/^I |^your chat:/.test(WAKE_LINE('T-42', 'your chat')), 'the relay speaks ABOUT the sender, never AS them');
});

// ---- fyi never wakes ----
test('fyi tier does not wake — no spawn, no notify', () => withEnv({ HANDOFF_SESSIONS_DIR: fx.dir }, () => {
  const s = recorder(); const n = notifyRecorder();
  const r = wake({ tier: 'fyi', thread: 'x', native_ref: { session_id: OPEN_UUID } }, { spawn: s.spawn, notify: n.notify });
  assert.strictEqual(r.woke, false);
  assert.strictEqual(r.tier, 'skipped');
  assert.strictEqual(s.calls.length, 0, 'must not spawn a relay');
  assert.strictEqual(n.calls.length, 0, 'must not notify');
}));

test('unset tier does not wake (attention only)', () => {
  const s = recorder(); const n = notifyRecorder();
  const r = wake({ thread: 'x', native_ref: { session_id: OPEN_UUID } }, { spawn: s.spawn, notify: n.notify });
  assert.strictEqual(r.tier, 'skipped');
});

// ---- open target → -p relay ----
test('attention + open → exactly ONE relay call, correct argv, no notify', () => withEnv({ HANDOFF_SESSIONS_DIR: fx.dir, HANDOFF_WAKE_MODEL: null, HANDOFF_CLAUDE_BIN: null }, () => {
  const s = recorder(); const n = notifyRecorder();
  const r = wake({ tier: 'attention', thread: 'Wake tier', conversation: 'Wake tier', from: 'chat', native_ref: { session_id: OPEN_UUID } }, { spawn: s.spawn, notify: n.notify });
  assert.strictEqual(r.woke, true);
  assert.strictEqual(r.tier, 'relay');
  assert.strictEqual(s.calls.length, 1, 'exactly one relay call (no retries)');
  assert.strictEqual(n.calls.length, 0, 'open target must NOT notify');
  const { bin, argv } = s.calls[0];
  // Resolved absolute path, not the bare name: under launchd's minimal PATH the bare name
  // is unspawnable, which silently disabled this whole rung in production.
  assert.ok(bin.endsWith('/claude') || bin === 'claude', `invokes the claude CLI as a product, got: ${bin}`);
  assert.ok(bin.startsWith('/'), 'and resolves it to an absolute path rather than trusting PATH');
  assert.strictEqual(argv[0], '-p');
  assert.ok(argv.includes('--model'), 'passes --model');
  assert.strictEqual(argv[argv.indexOf('--model') + 1], 'haiku', 'cheapest model default');
  const ai = argv.indexOf('--allowedTools');
  assert.ok(ai >= 0, 'passes --allowedTools');
  assert.strictEqual(argv[ai + 1], 'ListAgents');
  assert.strictEqual(argv[ai + 2], 'SendMessage');
  const prompt = argv[1];
  assert.ok(prompt.includes('ListAgents'), 'relay confirms target via ListAgents');
  assert.ok(prompt.includes('ai-product-sense-72'), 'relay addresses the target by name');
  assert.ok(prompt.includes('mail from chat on Wake tier is waiting — checking the inbox will deliver it'), 'relay carries the one wake line, sender named');
  assert.ok(/ref/i.test(prompt), 'relay is told to disambiguate with [ref]');
  assert.ok(/not .*expect.* reply|do not wait/i.test(prompt), 'no-reply-expected');
}));

test('HANDOFF_WAKE_MODEL overrides the relay model', () => withEnv({ HANDOFF_SESSIONS_DIR: fx.dir, HANDOFF_WAKE_MODEL: 'claude-haiku-4-5-20251001' }, () => {
  const s = recorder();
  wake({ tier: 'attention', thread: 't', native_ref: { session_id: OPEN_UUID } }, { spawn: s.spawn });
  const argv = s.calls[0].argv;
  assert.strictEqual(argv[argv.indexOf('--model') + 1], 'claude-haiku-4-5-20251001');
}));

// ---- closed target → the store ----
test('attention + closed → the store, no relay', () => withEnv({ HANDOFF_SESSIONS_DIR: fx.dir }, () => {
  const s = recorder(); const n = notifyRecorder();
  const r = wake({ tier: 'attention', thread: 'Wake tier', conversation: 'Wake tier', from: 'chat', session_id: 'sess_x', native_ref: { session_id: CLOSED_UUID } }, { spawn: s.spawn, notify: n.notify });
  assert.strictEqual(r.woke, false);
  assert.strictEqual(r.tier, 'store');
  assert.strictEqual(s.calls.length, 0, 'closed target must NOT relay');
  assert.strictEqual(n.calls.length, 0, 'a closed target is not pinged; it degrades to the store');
  // The ping-copy rule asserted here moved out with the rung. What survives is the only claim
  // the caller can still act on: the window is closed and the mail is in the store.
  assert.strictEqual(r.reason && typeof r.reason, 'string', 'the refusal carries a reason a human can read');
}));

// ---- wake-line copy rule ----
/* A UUID IS NOT UNIQUE ACROSS PROCESSES. Measured 2026-08-09: the user ran /exit then
 * `claude --continue`, and TWO live processes (38088, 87920) ended up registered under one
 * session id, both named "build". find() would have picked whichever the filesystem listed
 * first and relayed into a window nobody was watching. Starting a turn in the wrong place
 * is worse than not starting one. */
test('duplicate claimants: two live processes on one uuid refuse to wake, and name the pids', () => withEnv({ HANDOFF_SESSIONS_DIR: fx.dir }, () => {
  const DUP = 'dup0a1b2-c3d4-4e5f-9a0b-continue0001';
  const p1 = livePid(), p2 = livePid();
  fx.write(p1, DUP, 'build', { cwd: '/repo/dup' });
  fx.write(p2, DUP, 'build', { cwd: '/repo/dup' });
  const r = nativeReach({ session_id: DUP, cwd: '/repo/dup', name: 'build' });
  assert.strictEqual(r.open, false, 'never guess which window the user is in');
  assert.strictEqual(r.candidates, 2);
  assert.match(r.reason, /2 live processes claim this session id/);
  assert.match(r.reason, new RegExp(String(p1)), 'the pids are named so the state is diagnosable');
  fs.unlinkSync(path.join(fx.dir, `${p1}.json`));
  fs.unlinkSync(path.join(fx.dir, `${p2}.json`));
}));

/* EXIT + CONTINUE: succession within one identity, resolved by evidence.
 * Probed live — `/exit` then `claude --continue` leaves BOTH processes registered under one
 * session id and BOTH keep heartbeating, so the leftover is not defunct by construction.
 * The discriminator is native_ref.pid: the process that LAST SPOKE to the protocol, which
 * every tool contact refreshes from the caller's own pid. She drives the window that talks. */
test('exit+continue: the process that last spoke to us succeeds the others', () => withEnv({ HANDOFF_SESSIONS_DIR: fx.dir }, () => {
  const SID = 'succ0a1b-c2d3-4e5f-8a9b-continue0002';
  const oldPid = livePid(), newPid = livePid();
  fx.write(oldPid, SID, 'build', { cwd: '/repo/succ' });
  fx.write(newPid, SID, 'tunnel', { cwd: '/repo/succ' });
  const r = nativeReach({ session_id: SID, cwd: '/repo/succ', name: 'build', pid: newPid });
  assert.strictEqual(r.open, true, 'the window that talks to us is the window we deliver to');
  assert.strictEqual(r.name, 'tunnel', 'and we address it by ITS row, not the stale one');
  assert.deepStrictEqual(r.succeeded, [oldPid], 'the superseded pid is named, not hidden');
  assert.match(r.reason, /last spoke to the protocol/);
  fs.unlinkSync(path.join(fx.dir, `${oldPid}.json`));
  fs.unlinkSync(path.join(fx.dir, `${newPid}.json`));
}));

test('exit+continue: if NEITHER has spoken, refuse — and the refusal carries the remedy', () => withEnv({ HANDOFF_SESSIONS_DIR: fx.dir }, () => {
  const SID = 'succ0a1b-c2d3-4e5f-8a9b-continue0003';
  const p1 = livePid(), p2 = livePid();
  fx.write(p1, SID, 'build', { cwd: '/repo/succ2' });
  fx.write(p2, SID, 'tunnel', { cwd: '/repo/succ2' });
  const r = nativeReach({ session_id: SID, cwd: '/repo/succ2', name: 'build' }); // no pid: nobody has spoken
  assert.strictEqual(r.open, false, 'never pick between two genuinely-live claimants');
  assert.match(r.remedy, new RegExp(`pid ${p1}`), 'the remedy names the actual pids');
  assert.match(r.reason, /say anything in the window you want/, 'and tells their the one action that resolves it');
  fs.unlinkSync(path.join(fx.dir, `${p1}.json`));
  fs.unlinkSync(path.join(fx.dir, `${p2}.json`));
}));

/* THE RELAY BINARY MUST BE RESOLVED, NOT INHERITED. The daemon runs under launchd with
 * PATH=/usr/bin:/bin:/usr/sbin:/sbin, and `claude` lives in ~/.local/bin — so spawn('claude')
 * threw ENOENT on every real wake while the suite stayed green, because the suite injects a
 * fake spawn and therefore proves the ARGV and never the resolution. */
test('relay binary: an absolute path is used, not the bare name off PATH', () => withEnv({ HANDOFF_SESSIONS_DIR: fx.dir, HANDOFF_CLAUDE_BIN: null }, () => {
  const s = recorder();
  wake({ tier: 'attention', thread: 'x', conversation: 'x', from: 'chat', native_ref: { session_id: OPEN_UUID } }, { spawn: s.spawn });
  if (s.calls.length) {
    assert.ok(s.calls[0].bin.startsWith('/'), `relay must spawn an absolute path, got: ${s.calls[0].bin}`);
    assert.ok(fs.existsSync(s.calls[0].bin), 'and that path must actually exist on this machine');
  }
}));

test('relay binary: HANDOFF_CLAUDE_BIN still overrides', () => withEnv({ HANDOFF_SESSIONS_DIR: fx.dir, HANDOFF_CLAUDE_BIN: '/tmp/fake-claude' }, () => {
  const s = recorder();
  wake({ tier: 'attention', thread: 'x', conversation: 'x', from: 'chat', native_ref: { session_id: OPEN_UUID } }, { spawn: s.spawn });
  assert.strictEqual(s.calls[0].bin, '/tmp/fake-claude');
}));

/* A SPAWN THAT FAILED MUST NOT REPORT AS DISPATCHED (A12, in code).
 * spawn() does not throw on a missing binary — it returns a child with pid undefined and
 * emits ENOENT on a later tick. The old code swallowed that with an empty error handler and
 * had already returned {tier:'relay', delivery:'dispatched'}, so the caller announced
 * "Started a turn ... no tap needed" about a process that never existed. With the
 * launchd-PATH defect standing, that was EVERY relay claim since the flip. */
test('relay: a spawn that never started degrades to the store, and says which binary', () => withEnv({ HANDOFF_SESSIONS_DIR: fx.dir, HANDOFF_CLAUDE_BIN: '/nonexistent/claude' }, () => {
  const n = notifyRecorder();
  const r = wake({ tier: 'attention', thread: 'x', conversation: 'x', from: 'chat', native_ref: { session_id: OPEN_UUID } },
    { notify: n.notify }); // REAL spawn: the failure must be detected, not stubbed away
  assert.strictEqual(r.tier, 'store', 'a relay that did not start is not a relay');
  assert.strictEqual(r.woke, false);
  assert.match(r.reason, /did not start/);
  assert.strictEqual(n.calls.length, 0, 'and nobody is pinged — a failed relay degrades to the store, not to a promise');
}));

test('relay: a real dispatch is reported as UNCONFIRMED, never as a started turn', () => withEnv({ HANDOFF_SESSIONS_DIR: fx.dir }, () => {
  const s = recorder();
  const r = wake({ tier: 'attention', thread: 'x', conversation: 'x', from: 'chat', native_ref: { session_id: OPEN_UUID } }, { spawn: s.spawn });
  assert.strictEqual(r.tier, 'relay');
  // The relay is detached and fire-and-forget: a dispatch proves a process started and
  // nothing about whether ListAgents found the target or SendMessage delivered.
  assert.strictEqual(r.confirmed, false, 'dispatch is not confirmation');
  assert.match(r.note, /not confirmation of delivery/);
}));

test('notifyCopy: return shape — headline + review action', () => {
  const c = notifyCopy({ kind: 'return', native_ref: { name: 'ai-product-sense-2a' }, status: 'Live test passed.' });
  assert.strictEqual(c.title, 'ai-product-sense-2a — Live test passed.');
  assert.strictEqual(c.body, 'Open your chat to review it.');
});

test('notifyCopy: progress shape — status headline, no action line', () => {
  const c = notifyCopy({ kind: 'progress', native_ref: { name: 'Docs sweep' }, status: 'Building the coverage manifest: 310 pages.' });
  assert.strictEqual(c.title, 'Docs sweep — Building the coverage manifest: 310 pages.');
  assert.strictEqual(c.body, '', 'progress has no tap, so no action line');
});

test('notifyCopy: message shape — window+work headline, sender action', () => {
  const c = notifyCopy({ native_ref: { name: 'ai-product-sense-2a' }, conversation: 'Wake tier', from: 'chat' });
  assert.strictEqual(c.title, 'ai-product-sense-2a — Wake tier');
  assert.strictEqual(c.body, 'From chat — open it to pick up.');
});

/* ---- the notification rung is GONE (removed 2026-08-09, owner's ruling) ----
 * These asserted WHICH notification rung fired and that its click named the right target.
 * There is no rung to fire: macOS branded the ping as Script Editor with a click that opened
 * a file dialog, the clickable alternative needed an install and produced two false delivery
 * claims in a day, and Windows had no rung at all. wake() now degrades straight to the store,
 * which is what it did on the paths that mattered anyway. The coverage that survives is the
 * degrade path itself, asserted above: a CLOSED target yields tier 'store', never a promise
 * that something was shown to anyone. */

test('notifyCopy: no protocol vocabulary in any shape', () => {
  const shapes = [
    notifyCopy({ kind: 'return', conversation: 'X', status: 'done' }),
    notifyCopy({ kind: 'progress', conversation: 'X', status: 'working' }),
    notifyCopy({ conversation: 'X', from: 'chat' }),
  ];
  for (const c of shapes) {
    const blob = (c.title + ' ' + c.body).toLowerCase();
    for (const w of ['drain', 'mail', 'envelope', 'store', 'origin', 'carrier', 'handoff ·', 'inbox']) {
      assert.ok(!blob.includes(w), `"${w}" leaked into: ${c.title} / ${c.body}`);
    }
  }
});

// ---- relay spawn failure → degrade to notify, no retry ----
test('relay spawn failure degrades to the store (no relay retry)', () => withEnv({ HANDOFF_SESSIONS_DIR: fx.dir }, () => {
  const n = notifyRecorder();
  const r = wake({ tier: 'attention', thread: 'x', conversation: 'x', native_ref: { session_id: OPEN_UUID } }, { spawn: throwingSpawn(), notify: n.notify });
  assert.strictEqual(r.tier, 'store');
  assert.strictEqual(r.reason, 'relay spawn failed');
    assert.strictEqual(n.calls.length, 0, 'no ping — the durable write the caller already made is the delivery');
}));

// ---- channel rung (only when flagged + hook set) ----
test('channels flag + hook → channel inject, no relay', () => withEnv({ HANDOFF_SESSIONS_DIR: fx.dir, HANDOFF_CHANNEL_HOOK: '/bin/true' }, () => {
  const s = recorder(); const n = notifyRecorder();
  const r = wake({ tier: 'attention', thread: 'x', conversation: 'x', channels: true, native_ref: { session_id: OPEN_UUID } }, { spawn: s.spawn, notify: n.notify });
  assert.strictEqual(r.tier, 'channel');
  assert.strictEqual(r.woke, true);
  assert.strictEqual(s.calls.length, 1, 'one channel-hook spawn');
  assert.strictEqual(s.calls[0].bin, '/bin/true');
  assert.strictEqual(n.calls.length, 0);
}));

test('channels flag WITHOUT hook falls through to relay', () => withEnv({ HANDOFF_SESSIONS_DIR: fx.dir, HANDOFF_CHANNEL_HOOK: null }, () => {
  const s = recorder();
  const r = wake({ tier: 'attention', thread: 'x', channels: true, native_ref: { session_id: OPEN_UUID } }, { spawn: s.spawn });
  assert.strictEqual(r.tier, 'relay', 'no hook → channel rung is skipped, relay handles the open target');
}));

// ---- kill switch ----
test('HANDOFF_NO_WAKE disables the layer', () => withEnv({ HANDOFF_NO_WAKE: '1', HANDOFF_SESSIONS_DIR: fx.dir }, () => {
  const s = recorder(); const n = notifyRecorder();
  const r = wake({ tier: 'attention', thread: 'x', native_ref: { session_id: OPEN_UUID } }, { spawn: s.spawn, notify: n.notify });
  assert.strictEqual(r.tier, 'disabled');
  assert.strictEqual(s.calls.length, 0);
  assert.strictEqual(n.calls.length, 0);
}));

// ---- never throws ----
test('wake never throws on a garbage delivery', () => {
  const r = wake(undefined, { spawn: recorder().spawn, notify: notifyRecorder().notify });
  assert.ok(r && typeof r.tier === 'string');
});

// ---- CI log seam records the chosen rung without spawning ----
test('HANDOFF_WAKE_LOG records the relay dispatch instead of spawning', () => {
  const logf = path.join(fx.dir, 'wake.log');
  withEnv({ HANDOFF_SESSIONS_DIR: fx.dir, HANDOFF_WAKE_LOG: logf }, () => {
    wake({ tier: 'attention', thread: 'log-test', native_ref: { session_id: OPEN_UUID } });
  });
  const line = JSON.parse(fs.readFileSync(logf, 'utf8').trim().split('\n').pop());
  assert.strictEqual(line.tier, 'relay');
  assert.strictEqual(line.target, 'ai-product-sense-72');
  assert.ok(line.argv.includes('-p'));
});

console.log(`\nwake-smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
