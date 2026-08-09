#!/usr/bin/env node
'use strict';
/* THE FLIP RUNBOOK (DAEMON-SPEC "flip point", item 3).
 *
 * Drives a REAL bridge in FORWARDER mode against the INSTALLED launchd/systemd daemon, over
 * real MCP stdio. This is the last mile the smoke suites cannot cover: they spawn their own
 * daemons on throwaway sockets, so they prove the wire but never that the SHIPPED, managed
 * daemon serves a real forwarder on the real socket.
 *
 * READ-ONLY BY CONSTRUCTION. It runs against the live store, so it may only call tools that
 * do not mutate: status, list_conversations, tools/list, and register_session — which for an
 * already-registered terminal is an idempotent refresh, not a new record. Do NOT add a
 * sending or pinning tool here; use daemon-smoke (throwaway store) for those.
 *
 * Prerequisites: daemon installed (deploy/install.sh) and running.
 * Usage:          node forwarder-runbook.js
 *
 * Note on (c): assert time-to-RESPONSE and time-to-EXIT separately. An earlier version timed
 * only process close, reported 8047ms, and called it "fails fast" — conflating the two hid a
 * leaked 8s deadline in forwardToDaemon. They are different questions and both matter. */
const { spawn } = require('child_process');
const path = require('path');
const BRIDGE = '/path/to/handoff-remote/mcp-handoff.js';
const UUID = '115dfb99-df03-49d9-9f8a-9a2f1cc40644';

function run(env, calls, onFirstResponse) {
  return new Promise(resolve => {
    const c = spawn('node', [BRIDGE], { cwd: path.dirname(BRIDGE), env });
    let out = '', err = '';
    c.stdout.on('data', d => {
      out += d;
      if (onFirstResponse && String(d).includes('"id":1')) { onFirstResponse(); onFirstResponse = null; }
    });
    c.stderr.on('data', d => err += d);
    c.on('close', code => {
      const byId = {};
      out.trim().split('\n').filter(Boolean).forEach(l => { try { const j = JSON.parse(l); byId[j.id] = j; } catch (_) {} });
      resolve({ byId, code, err });
    });
    c.stdin.write(calls.map(x => JSON.stringify(x)).join('\n') + '\n');
    c.stdin.end();
  });
}
const init = { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} };
const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args || {} } });
const txt = (r, id) => (((r.byId[id] || {}).result || {}).content || [{}])[0].text || '';

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };

(async () => {
  console.log('RUNBOOK — forwarder mode against the INSTALLED daemon (read-only)');
  const base = { ...process.env, CLAUDE_CODE_SESSION_ID: UUID, HANDOFF_FORWARDER: '1' };

  // 1. tools/list must work without the daemon (schema is local to the forwarder).
  const l = await run(base, [init, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }]);
  ok((l.byId[1].result.tools || []).length >= 20, 'forwarder serves the full tool schema locally');

  // 2. a read-only tool round-trips through the live daemon.
  const s = await run(base, [init, call(1, 'status', {})]);
  ok(/Store:\s+\/Users\/dev\/\.claude-handoff/.test(txt(s, 1)), 'status forwards to the daemon and reads the LIVE store');
  ok(/Workers:/.test(txt(s, 1)) && !/Error:/.test(txt(s, 1)), 'the forwarded status report is complete, not an error');

  // 3. identity write-back survives the socket: register (idempotent refresh) then status.
  //    register_session on an EXISTING record is a refresh, not a new write.
  const i = await run(base, [init, call(1, 'register_session', { role: 'migration' }), call(2, 'status', {})]);
  ok(/Refreshed|Registered/.test(txt(i, 1)), 'register_session forwards and resolves this terminal\'s record');
  ok(/Identity: sess_/.test(txt(i, 2)),
     'ctx_update.identity applied INSIDE the forwarder — next status names the record (contract v3 over the wire)');

  // 4. list_conversations forwards (the heaviest read: renders candidate cards).
  const lc = await run(base, [init, call(1, 'list_conversations', {})]);
  ok(/protocol-known conversations/.test(txt(lc, 1)), 'list_conversations forwards and renders cards from the daemon');

  // 5. acceptance (c): a forwarder pointed at a DEAD socket must not hang.
  // Measure BOTH: time-to-response (does the conversation stall?) and time-to-exit (does
  // the process linger?). The first version of this check timed only process close and
  // reported 8047ms as "fails fast" — it was conflating the two, and hiding a real leaked
  // timer. They are different questions and both matter, so assert on both.
  const dead = { ...base, HANDOFF_DAEMON_SOCK: '/tmp/definitely-not-a-socket-' + Date.now() };
  const t0 = Date.now();
  let respondedAt = null;
  const d = await run(dead, [init, call(1, 'status', {})], () => { respondedAt = Date.now() - t0; });
  const exitMs = Date.now() - t0;
  ok(respondedAt !== null && respondedAt < 2000,
     `(c) a forwarder with no daemon ANSWERS fast (${respondedAt}ms) — the conversation never stalls`);
  ok(exitMs < 2000,
     `(c) and the process EXITS promptly (${exitMs}ms) — no leaked deadline holding the event loop`);
  ok(/Error|daemon/i.test(txt(d, 1)) || d.code !== 0, '(c) and it reports/exits rather than answering wrongly');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
