#!/usr/bin/env node
'use strict';
/**
 * Forwarder-dial integration test (the flip, gated). Spawns a real managed daemon, then runs
 * mcp-handoff.js in FORWARDER mode against it, and proves: tool calls travel one socket
 * round-trip and return correct results; the pin and identity write-backs are applied inside
 * the forwarding bridge; and daemon_stale makes the forwarder EXIT for respawn. Throwaway
 * HANDOFF_HOME; no real CLI/notify/wake side effects.
 */
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const base = { ...process.env,
  HANDOFF_NO_CLI: '1', HANDOFF_NO_AUTORECEIPT: '1', HANDOFF_NO_AUTOOPEN: '1',
  HANDOFF_WAKE_LOG: path.join(os.tmpdir(), 'fwd-wake-' + process.pid + '.log'),
  CLAUDE_PROJECTS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'fwd-ccproj-')),
};
let passed = 0, failed = 0;
const ok = (c, n) => { c ? (passed++, console.log('  ✓', n)) : (failed++, console.log('  ✗ FAIL:', n)); };
const waitFor = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 40)); } return false; };
const init = { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} };
const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args || {} } });
const text = (r, id) => (((r[id] || {}).result || {}).content || [{}])[0].text || '';

// Drive the bridge in FORWARDER mode; returns { byId, exitCode }.
function fwd(calls, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'mcp-handoff.js')], { env: { ...base, ...env, HANDOFF_FORWARDER: '1' } });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.on('close', (code) => {
      const byId = {};
      out.trim().split('\n').filter(Boolean).forEach(l => { try { const j = JSON.parse(l); byId[j.id] = j; } catch (_) {} });
      resolve({ byId, exitCode: code });
    });
    child.stdin.write(calls.map(c => JSON.stringify(c)).join('\n') + '\n');
    child.stdin.end();
  });
}

(async () => {
  console.log('Forwarder-dial integration test');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fwd-home-'));
  const sock = path.join(home, 'daemon.sock');

  // managed daemon under test
  const daemon = spawn(process.execPath, [path.join(__dirname, 'handoff-daemon.js')],
    { env: { ...base, HANDOFF_HOME: home, HANDOFF_DAEMON_SOCK: sock } });
  const up = await waitFor(() => fs.existsSync(sock));
  ok(up, 'daemon under test binds its control socket');

  const uuid = '77777777-aaaa-4bbb-8ccc-ddddeeee0003';
  const env = { HANDOFF_HOME: home, HANDOFF_DAEMON_SOCK: sock, CLAUDE_CODE_SESSION_ID: uuid };

  // 1. register_session forwards, and the identity write-back is applied IN the forwarding
  //    bridge — a follow-up status in the SAME process reports it registered, not "not yet".
  const r1 = await fwd([init,
    call(1, 'register_session', { title: 'Forwarded terminal', role: 'build' }),
    call(2, 'status', {})
  ], env);
  ok(/Registered: code · /.test(text(r1.byId, 1)), 'forwarder: register_session runs through the daemon');
  ok(/Identity:\s*sess_/.test(text(r1.byId, 2)) && !/not yet registered/.test(text(r1.byId, 2)),
    'forwarder: the identity write-back (ctx_update.identity) is applied — next status shows it registered');

  // 2. a pin-writer forwards, and the pin write-back is applied: pick_up then a no-arg
  //    get_handoff resolves via the new pin, all in one forwarding process.
  const r2 = await fwd([init,
    call(1, 'send_to_surface', { to: 'code', from: 'chat', title: 'Forwarded work', context: 'do the thing', expected_return: 'a decision', open_in: 'none' }),
    call(2, 'pick_up', { surface: 'code', title_contains: 'Forwarded work' }),
    call(3, 'get_handoff', {})
  ], env);
  ok(/Picked up "Forwarded work"/.test(text(r2.byId, 2)), 'forwarder: pick_up (a pin WRITER) runs through the daemon');
  ok(/do the thing/.test(text(r2.byId, 3)) && !/not pinned/.test(text(r2.byId, 3)),
    'forwarder: the pin write-back (ctx_update.pinned) is applied — a no-arg get_handoff uses the new pin');

  // 3. daemon_stale → the forwarder EXITS for respawn (no hang).
  try { daemon.kill(); } catch (_) {}
  await waitFor(() => !fs.existsSync(sock), 1500);
  const staleDaemon = spawn(process.execPath, [path.join(__dirname, 'handoff-daemon.js')],
    { env: { ...base, HANDOFF_HOME: home, HANDOFF_DAEMON_SOCK: sock, HANDOFF_FORCE_STALE: '1' } });
  await waitFor(() => fs.existsSync(sock));
  const r3 = await fwd([init, call(1, 'status', {})], env);
  ok(r3.exitCode === 0, 'forwarder: on daemon_stale the forwarder process exits (0) for respawn, never hangs');
  try { staleDaemon.kill(); } catch (_) {}

  // ---- staleness must be reported CONSISTENTLY in forwarder mode ----
  // Found live after the flip, not in review: the forwarder built ctx WITHOUT `stale`, so
  // buildStatusReport rendered "Bridge: ✓ current" from an undefined value while handle()
  // prepended a locally-computed "⚠ STALE BRIDGE" banner — one response asserting both.
  // The banner also prescribed the quit-app + pkill dance, which after the flip is wrong
  // advice: the daemon serves every tool and is untouched by editing this file.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fwd-stale-'));
    const sock = path.join(home, 'daemon.sock');
    const dae = spawn(process.execPath, [path.join(__dirname, 'handoff-daemon.js')],
      { env: { ...base, HANDOFF_HOME: home, HANDOFF_DAEMON_SOCK: sock } });
    await waitFor(() => fs.existsSync(sock));
    const env = { HANDOFF_HOME: home, HANDOFF_DAEMON_SOCK: sock, HANDOFF_FORCE_STALE: '1' };
    const r = await fwd([init, call(1, 'status', {})], env);
    const t = (((r.byId[1] || {}).result || {}).content || [{}])[0].text || '';
    ok(!(/STALE/.test(t) && /Bridge: ✓ current/.test(t)),
      'forwarder: status never claims STALE and "✓ current" in the same response');
    ok(/STALE FORWARDER/.test(t) && /Bridge: ⚠ STALE/.test(t),
      'forwarder: a stale forwarder says so in BOTH the banner and the report body');
    // Match the PRESCRIPTION, not the word: the new remedy says "no app quit and no pkill",
    // so a bare /pkill/ matches the fix itself. Assert the retired runbook command is absent.
    ok(!/pkill -f mcp-handoff/.test(t) && !/quit the Claude app →/.test(t),
      'forwarder: the stale remedy no longer prescribes the retired quit-app + pkill runbook');
    ok(/daemon/.test(t) && /not stale|keeps running/.test(t),
      'forwarder: the remedy explains the daemon is unaffected and still serving');
    try { dae.kill(); } catch (_) {}
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('runner error:', e.message); process.exit(1); });
