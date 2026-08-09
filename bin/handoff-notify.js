#!/usr/bin/env node
/**
 * Notification layer — the wake mechanism for idle surfaces (daemon feature; interim-wired
 * into the bridge until the daemon owns it). Socket posting is retired (t26 §wire): we do
 * NOT hand-roll native's private wire. We ping the user; their next turn drains the mail.
 *
 * Channels, in preference order (BROADLY-USED-ONLY — no exotic transports):
 *   1. Dispatch push — preferred (already reaches their phone). Seam only here: the daemon
 *      wires the real Dispatch reach; a HANDOFF_DISPATCH_HOOK command, if set, is invoked.
 *   2. macOS notification via `terminal-notifier` — the CLICKABLE rung, OPT-IN ONLY
 *      (HANDOFF_TERMINAL_NOTIFIER=<path>). Measured NON-DELIVERING on the machine this was
 *      developed on: zero entries in `defaults read com.apple.ncprefs`, an ad-hoc-signed
 *      bundle, and the only ping that actually appeared came from osascript. Presence on
 *      disk is not evidence of delivery. macOS attributes an `osascript` notification to
 *      Script Editor, so clicking one "opens the sender" and Script Editor's file dialog
 *      appears: the tap does nothing useful and looks broken. terminal-notifier owns its
 *      notification, so the click CAN carry a real action — `-activate` the Claude app for
 *      chat/cowork/design targets — on a machine where someone has proven it delivers.
 *   3. macOS notification via `osascript` — the DEFAULT, because it is the only rung proven
 *      to appear. Its click opens Script Editor (macOS attributes the notification to it),
 *      which is useless — so the body says clicking does nothing rather than implying
 *      otherwise. A visible notification with a dead click beats a click that never arrives.
 *
 * Test / CI mode: HANDOFF_NOTIFY_LOG=<file> appends one JSON line INSTEAD of firing any
 * real notification, so tests never spawn OS notifications. HANDOFF_NO_NOTIFY=1 disables
 * the layer entirely (same convention as HANDOFF_NO_*). Fire-and-forget; never throws.
 *
 * Usage (programmatic): require('./handoff-notify').notify({ title, body, conversation, meta })
 * Usage (CLI):          node handoff-notify.js "<title>" "<body>"
 */
'use strict';
const { execFile } = require('child_process');

/* Where terminal-notifier lives, resolved once per process. Absence is normal and is a
 * degrade, never an error — the osascript rung still shows the ping. HANDOFF_TERMINAL_NOTIFIER
 * overrides for tests and for non-Homebrew installs. */
let TN_CACHE;
/* OPT-IN ONLY. Presence on disk is not evidence of delivery — terminal-notifier was present
 * on the development machine and delivered nothing. Someone must prove it works here and set
 * the env var to an explicit path. */
function clickableRungEnabled() {
  const v = process.env.HANDOFF_TERMINAL_NOTIFIER;
  return !!v && v !== 'none' ? terminalNotifierPath() : null;
}
function terminalNotifierPath() {
  if (TN_CACHE !== undefined) return TN_CACHE;
  const override = process.env.HANDOFF_TERMINAL_NOTIFIER;
  if (override) return (TN_CACHE = override === 'none' ? null : override);
  const fs = require('fs');
  const candidates = ['/opt/homebrew/bin/terminal-notifier', '/usr/local/bin/terminal-notifier'];
  for (const p of candidates) { try { if (fs.existsSync(p)) return (TN_CACHE = p); } catch (_) {} }
  try {
    const { execFileSync } = require('child_process');
    const found = execFileSync('which', ['terminal-notifier'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (found) return (TN_CACHE = found);
  } catch (_) { /* not on PATH */ }
  return (TN_CACHE = null);
}
/* What the click should open. An app-surface target activates the Claude desktop app; a code
 * terminal names its window and promises nothing, because focusing one terminal among several
 * would be exactly the guess §I2b forbids. */
const CLAUDE_BUNDLE_ID = 'com.anthropic.claudefordesktop';
/* Which GUI app OWNS a terminal, resolved live by walking the process tree up from a
 * VALIDATED live pid — e.g. 38088 → claude → zsh → "Cursor Helper: terminal pty-host" →
 * /Applications/Cursor.app. This is evidence, not a guess: the pid was validated against a
 * live registry row, and every hop is read from the OS at the moment of use, never stored.
 * That is why it satisfies §I2b instead of bending it. It fires ONLY with a validated pid —
 * a stale binding has no pid and therefore no click, unchanged. We name the APP, never a
 * window: which of several windows holds the session stays honestly unknown. */
function owningAppBundleId(pid) {
  if (!pid) return null;
  try {
    const { execFileSync } = require('child_process');
    let cur = Number(pid);
    for (let hop = 0; hop < 6 && cur > 1; hop++) {
      const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(cur)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (!out) return null;
      const m = out.match(/^\s*(\d+)\s+(.*)$/);
      if (!m) return null;
      const comm = m[2];
      const app = comm.match(/\/([^/]+)\.app\//);
      if (app) {
        const plist = comm.slice(0, comm.indexOf('.app/') + 4) + '/Contents/Info.plist';
        try {
          return execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist],
            { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
        } catch (_) { return null; }
      }
      cur = Number(m[1]);
    }
  } catch (_) { /* ps/PlistBuddy unavailable — no click, never an error */ }
  return null;
}
function notifyTarget(ev) {
  const meta = (ev && ev.meta) || {};
  const surface = meta.surface || null;
  const name = meta.window || (ev && ev.conversation) || null;
  if (surface && surface !== 'code') return { activate: CLAUDE_BUNDLE_ID, name, surface };
  if (!surface) return { activate: null, name, surface: null };
  // A code terminal: activate whatever app actually owns it, when we hold a validated pid.
  return { activate: owningAppBundleId(meta.pid), name, surface };
}

function notify(ev) {
  try {
    if (process.env.HANDOFF_NO_NOTIFY) return { fired: false, channel: 'disabled' };
    const title = String((ev && ev.title) || 'handoff');
    const body = String((ev && ev.body) || '');

    // Test/CI: record, do not fire.
    const logPath = process.env.HANDOFF_NOTIFY_LOG;
    if (logPath) {
      require('fs').appendFileSync(logPath, JSON.stringify({
        at: new Date().toISOString(), title, body,
        conversation: (ev && ev.conversation) || null, meta: (ev && ev.meta) || null,
        // Which rung WOULD have fired, and what the click would carry. Without this the
        // smoke can only assert that something was notified, not that the tap works.
        would_fire: process.platform === 'darwin' ? (clickableRungEnabled() ? 'terminal-notifier' : 'macos') : 'unavailable',
        click: clickableRungEnabled() ? (notifyTarget(ev).activate || 'none') : 'none',
        click_target: notifyTarget(ev).name || null
      }) + '\n');
      return { fired: true, channel: 'log' };
    }

    // Channel 1: Dispatch push seam. A daemon sets HANDOFF_DISPATCH_HOOK to a command that
    // takes title + body as argv; if present we prefer it (reaches their phone).
    const hook = process.env.HANDOFF_DISPATCH_HOOK;
    if (hook) {
      execFile(hook, [title, body], () => {}); // fire-and-forget
      return { fired: true, channel: 'dispatch' };
    }

    if (process.platform === 'darwin') {
      const target = notifyTarget(ev);
      /* RUNG ORDER REVERTED, and the earlier order was a REGRESSION THAT SHIPPED.
       * terminal-notifier was made primary to fix the Script Editor click. It exits 0 and
       * appears to work — but exit 0 proves the BINARY RAN, not that a notification was
       * delivered. Measured afterwards: `defaults read com.apple.ncprefs` had ZERO entries
       * for terminal-notifier, the bundle was ad-hoc/linker-signed rather than notarized,
       * and the only ping the user actually saw came from osascript. So the "fix" traded an
       * ugly-but-VISIBLE notification for an INVISIBLE one — silence, which is the exact
       * failure class this project exists to kill, and worse than the bug it replaced.
       * So: osascript is primary because it is proven to appear. terminal-notifier is
       * opt-in only, via an explicit HANDOFF_TERMINAL_NOTIFIER path, so it cannot silently
       * take over on a machine where nobody has proven it delivers. */
      const tn = clickableRungEnabled();
      if (tn) {
        const argv = ['-title', title, '-message', body || ' ', '-group', 'handoff'];
        // The click's action, chosen by where the mail actually is. An app surface can be
        // opened for the user: activate Claude. A terminal cannot be focused from outside
        // without guessing which of several windows it is (§I2b — several can share one workspace), so it
        // gets no false promise: the ping names the window and the body says where to look.
        if (target.activate) argv.push('-activate', target.activate);
        execFile(tn, argv, () => {}); // fire-and-forget
        return { fired: true, channel: 'terminal-notifier', click: target.activate || 'none', target: target.name || null };
      }
      // Channel 3: osascript — DISPLAY ONLY. macOS attributes it to Script Editor, so a click
      // opens Script Editor's file dialog. Say that plainly rather than let the tap lie.
      const esc = s => String(s).replace(/["\\]/g, '\\$&');
      const suffix = ' (notification only — clicking does nothing: brew install terminal-notifier)';
      const script = `display notification "${esc(body + suffix)}" with title "${esc(title)}"`;
      execFile('osascript', ['-e', script], () => {}); // fire-and-forget
      return { fired: true, channel: 'macos', click: 'none', degraded: 'terminal-notifier not installed' };
    }

    return { fired: false, channel: 'unavailable' }; // no channel on this platform
  } catch (_) {
    return { fired: false, channel: 'error' }; // a notification must never break a send
  }
}

module.exports = { notify };

if (require.main === module) {
  notify({ title: process.argv[2] || 'handoff', body: process.argv[3] || '' });
}
