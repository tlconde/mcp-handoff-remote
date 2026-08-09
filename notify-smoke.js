#!/usr/bin/env node
'use strict';
/**
 * NOTIFY SMOKE — does a ping actually reach the person, on this machine?
 *
 * Split deliberately in two, because conflating them is how this layer shipped two false
 * claims in one day:
 *
 *   DEFAULT MODE (`node notify-smoke.js`) — pure, fires nothing, safe in CI. Asserts ROUTING:
 *   which rung this platform would use, that the log seam records instead of firing, and that
 *   a notification never throws. It cannot tell you a notification arrived, and it does not
 *   pretend to.
 *
 *   PROVE MODE (`node notify-smoke.js --prove`) — fires REAL notifications and then goes
 *   looking for EVIDENCE they were delivered. This is the mode that answers "will it work on
 *   my other laptop", and it is the only one whose result is worth quoting.
 *
 * Why the split is the whole point. Both wrong claims made about this layer on 2026-08-09 came
 * from treating a dispatch as a delivery:
 *   - "terminal-notifier is non-delivering": rested on `defaults read com.apple.ncprefs`, which
 *     returns "domain does not exist" for EVERY app in this context, and on a 6-second look that
 *     nobody was watching. Both void. terminal-notifier delivers here; the notification centre's
 *     own delivered-list proves it.
 *   - "auto-promotion is unbuildable because nothing can evidence delivery": false. On macOS
 *     `terminal-notifier -list <group>` reads the delivered records. That IS a receipt, and this
 *     file uses it.
 * The rule this encodes: exit 0 proves the binary ran. Only a delivered-record proves delivery,
 * and where no record exists, a human's eyes are the receipt and the test must say so.
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const PROVE = process.argv.includes('--prove');
let passed = 0, failed = 0;
const ok = (c, n) => { c ? (passed++, console.log('  ok  ', n)) : (failed++, console.log('  FAIL', n)); };

const NOTIFY = './bin/handoff-notify';
const fresh = () => { delete require.cache[require.resolve(NOTIFY)]; return require(NOTIFY); };
const withEnv = (env, fn) => {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] == null) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } }
};

console.log(`\nnotify-smoke — platform ${process.platform}${PROVE ? ', PROVE mode (real notifications will fire)' : ''}\n`);

/* ── ROUTING (pure) ───────────────────────────────────────────────────────────────────────── */
{
  const logPath = path.join(os.tmpdir(), 'notify-smoke-' + process.pid + '.log');
  try { fs.unlinkSync(logPath); } catch (_) {}

  withEnv({ HANDOFF_NOTIFY_LOG: logPath, HANDOFF_TERMINAL_NOTIFIER: null }, () => {
    const r = fresh().notify({ title: 'routing', body: 'b' });
    ok(r.fired && r.channel === 'log', 'the log seam records instead of firing — CI never spawns an OS notification');
  });
  const rec = JSON.parse(fs.readFileSync(logPath, 'utf8').trim().split('\n').pop());

  // The rung this platform routes to, stated per platform so a Windows run asserts something.
  if (process.platform === 'darwin') {
    ok(rec.would_fire === 'macos', 'macOS with no opt-in routes to the osascript rung');
    withEnv({ HANDOFF_NOTIFY_LOG: logPath, HANDOFF_TERMINAL_NOTIFIER: '/opt/homebrew/bin/terminal-notifier' }, () => {
      fresh().notify({ title: 'routing2', body: 'b' });
    });
    const rec2 = JSON.parse(fs.readFileSync(logPath, 'utf8').trim().split('\n').pop());
    ok(rec2.would_fire === 'terminal-notifier', 'an explicit HANDOFF_TERMINAL_NOTIFIER path opts into the clickable rung');
  } else if (process.platform === 'win32') {
    ok(rec.would_fire === 'windows-toast', 'Windows routes to the PowerShell toast rung — NOT "unavailable"');
  } else {
    ok(rec.would_fire === 'unavailable', 'an unsupported platform says so plainly rather than claiming a ping');
  }

  // A notification must never break a send. Garbage in, no throw.
  withEnv({ HANDOFF_NOTIFY_LOG: logPath }, () => {
    let threw = false;
    try { fresh().notify(null); fresh().notify({ title: { bad: 1 }, body: [1, 2] }); } catch (_) { threw = true; }
    ok(!threw, 'notify never throws — a failed ping must not break the durable write that already happened');
  });
  withEnv({ HANDOFF_NO_NOTIFY: '1', HANDOFF_NOTIFY_LOG: null }, () => {
    ok(fresh().notify({ title: 't' }).channel === 'disabled', 'HANDOFF_NO_NOTIFY disables the layer entirely');
  });
  try { fs.unlinkSync(logPath); } catch (_) {}
}

/* ── DELIVERY (only with --prove) ─────────────────────────────────────────────────────────── */
if (!PROVE) {
  console.log(`\n  (routing only — nothing was fired.`);
  console.log(`   Run \`node notify-smoke.js --prove\` on the machine you care about to test real delivery.)`);
} else if (process.platform === 'darwin') {
  const tn = process.env.HANDOFF_TERMINAL_NOTIFIER || '/opt/homebrew/bin/terminal-notifier';
  const group = 'notify-smoke-' + process.pid;
  let haveTn = false;
  try { haveTn = fs.existsSync(tn); } catch (_) {}

  if (haveTn) {
    // Fire through the REAL module on the opt-in rung, then ask the notification centre whether
    // it landed. `-list <group>` reads DELIVERED records, so this is a receipt, not an exit code.
    withEnv({ HANDOFF_NOTIFY_LOG: null, HANDOFF_TERMINAL_NOTIFIER: tn }, () => {
      fresh().notify({ title: 'notify-smoke delivery probe', body: 'group ' + group, meta: { group } });
    });
    // The module fires with its own group, so prove the mechanism directly too.
    execFileSync(tn, ['-title', 'notify-smoke delivery probe', '-message', 'group ' + group, '-group', group]);
    let listed = '';
    try { listed = execFileSync(tn, ['-list', group], { encoding: 'utf8' }); } catch (_) {}
    const delivered = listed.split('\n').some(l => l.startsWith(group + '\t'));
    ok(delivered, 'DELIVERED: the notification centre lists this notification as delivered (a receipt, not an exit code)');
    if (delivered) console.log('        ' + listed.trim().split('\n').pop());
    try { execFileSync(tn, ['-remove', group]); } catch (_) {}
  } else {
    console.log(`  skip   terminal-notifier absent at ${tn} — no delivered-record source on this machine`);
  }

  // The default rung has NO machine-readable receipt: macOS attributes it to Script Editor and
  // exposes no delivered list for it. Say that, rather than assert something we cannot check.
  withEnv({ HANDOFF_NOTIFY_LOG: null, HANDOFF_TERMINAL_NOTIFIER: null }, () => {
    const r = fresh().notify({ title: 'notify-smoke default rung', body: 'osascript — confirm by eye' });
    ok(r.fired && r.channel === 'macos', 'default rung dispatched (osascript)');
  });
  console.log('\n  EYES REQUIRED: a notification titled "notify-smoke default rung" should have appeared,');
  console.log('  branded Script Editor. That branding IS the osascript rung; its click is useless by design.');
} else if (process.platform === 'win32') {
  withEnv({ HANDOFF_NOTIFY_LOG: null }, () => {
    const r = fresh().notify({ title: 'notify-smoke', body: 'Windows toast — confirm by eye' });
    ok(r.fired && r.channel === 'windows-toast', 'Windows toast dispatched through the real module');
  });
  console.log('\n  EYES REQUIRED: a toast titled "notify-smoke" should have appeared, attributed to');
  console.log('  PowerShell. Windows exposes no delivered-list we can read, so YOUR CONFIRMATION IS');
  console.log('  THE RECEIPT. If nothing appeared, this rung does not work here and the code must say so.');
} else {
  console.log(`  skip   no notification channel implemented for ${process.platform}`);
}

console.log(`\nnotify-smoke: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
