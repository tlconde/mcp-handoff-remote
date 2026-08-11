// ROLE DECLARATION TESTS — absence of configuration is never a role.
// Driven over real stdio against mcp-handoff.js, because the defect being fixed was a
// top-level constant evaluated at process start; an in-process require would not reproduce it.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const REPO = __dirname;   // never a hardcoded home path — the scrub check caught that on this file's first staged run
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ FAIL: ' + label); } };

function drive(env, cwd) {
  return new Promise(res => {
    const p = spawn('node', [path.join(REPO, 'mcp-handoff.js')], {
      cwd, env: Object.assign({}, process.env, env), stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
    setTimeout(() => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } }) + '\n'), 700);
    setTimeout(() => { p.kill(); res(out); }, 2600);
  });
}
const clean = { HANDOFF_REMOTE_URL: '', HANDOFF_ROLE: '', HANDOFF_ACCESS_CLIENT_ID: '', HANDOFF_ACCESS_CLIENT_SECRET: '', HANDOFF_REMOTE_TOKEN: '' };

(async () => {
  // ---- 1. THE PHANTOM-MINT CASE: no config, and a cwd that is NOT the repo ----
  const home1 = path.join(os.tmpdir(), 'role-none-' + process.pid);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'notrepo-'));
  const out1 = await drive(Object.assign({}, clean, { HANDOFF_HOME: home1 }), elsewhere);
  ok(/REFUSED/.test(out1) && /has not declared what it is/.test(out1),
    'undeclared: the mount REFUSES instead of assuming it is the home machine');
  // The 05a9ed8 standard: assert the ABSENCE, not merely the message.
  ok(!fs.existsSync(home1),
    'undeclared: ZERO store directories created — the phantom is not minted, it is not even started');

  // ---- 2. HOST DECLARED explicitly ----
  const home2 = path.join(os.tmpdir(), 'role-host-' + process.pid);
  const out2 = await drive(Object.assign({}, clean, { HANDOFF_HOME: home2, HANDOFF_ROLE: 'host' }), elsewhere);
  ok(!/REFUSED/.test(out2) && /handoff/i.test(out2),
    'host declared: HANDOFF_ROLE=host serves normally from any directory');

  // ---- 3. GRANDFATHERED: a store already exists, so the machine is the host, no declaration ----
  const home3 = path.join(os.tmpdir(), 'role-grand-' + process.pid);
  fs.mkdirSync(path.join(home3, 'store', 'v1'), { recursive: true });
  const out3 = await drive(Object.assign({}, clean, { HANDOFF_HOME: home3 }), elsewhere);
  ok(!/REFUSED/.test(out3),
    'grandfathered: an EXISTING store is evidence of a deliberate host — migration needs no declaration');

  // ---- 4. PEER DECLARED, and cwd-independent ----
  const home4 = path.join(os.tmpdir(), 'role-peer-' + process.pid);
  const out4 = await drive(Object.assign({}, clean, { HANDOFF_HOME: home4, HANDOFF_REMOTE_URL: 'http://127.0.0.1:9/mcp' }), elsewhere);
  ok(/REFUSED/.test(out4) && /REMOTE PEER/.test(out4),
    'peer declared: refuses with the PEER refusal when the home store is unreachable');
  ok(!fs.existsSync(home4),
    'peer declared: still creates no local store when it cannot reach home (05a9ed8 holds)');

  // ---- 5. DECLARED PEER WITH NO ADDRESS: half-arrived config refuses rather than falling back ----
  const home5 = path.join(os.tmpdir(), 'role-halfpeer-' + process.pid);
  const out5 = await drive(Object.assign({}, clean, { HANDOFF_HOME: home5, HANDOFF_ROLE: 'peer' }), elsewhere);
  ok(/REFUSED/.test(out5) && /nowhere to reach the home store/.test(out5),
    'declared peer with no URL: refuses rather than silently becoming a local host');
  ok(!fs.existsSync(home5),
    'declared peer with no URL: creates nothing');

  for (const h of [home1, home2, home3, home4, home5]) { try { fs.rmSync(h, { recursive: true, force: true }); } catch (_) {} }
  try { fs.rmSync(elsewhere, { recursive: true, force: true }); } catch (_) {}
  console.log(`\nrole-tests: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
