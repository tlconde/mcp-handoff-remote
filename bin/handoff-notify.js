#!/usr/bin/env node
/**
 * NOTIFICATION — the wake path for a session no process can reach.
 *
 * REMOVED 2026-08-09 (0df8d58) and REINSTATED the same day, deliberately, because the reason for
 * removal does not survive the case it is now needed for. It was removed for implying an
 * AUTONOMOUS WAKE that could not happen: it said a ping had gone out as though the session had
 * been started, when nothing had started. That was a false claim and it deserved to go.
 *
 * The remote case is the opposite. A session on another device has no pid here, no socket here,
 * and on native Windows no cross-session messaging AT ALL (docs/en/cross-session-messaging,
 * Availability: macOS and Linux including WSL 2, not native Windows). It is not process-wakeable
 * by anything, so a notification is not a consolation prize standing in for a real wake — it IS
 * the only honest signal available, and withholding it means the mail waits on the chance that
 * someone happens to look. That is the failure the app-conversation model is criticised for.
 *
 * THE LINE, and every copy string in this file is held to it:
 *   ALLOWED  "mail is waiting for <name> on <device> — open that window"   (true, actionable)
 *   FORBIDDEN "the session was woken" / "a turn was started"               (false unless it was)
 * A rung that says what it truly did is not the over-promise that was removed.
 *
 * Channels, in preference order (BROADLY-USED-ONLY — no exotic transports):
 *   1. Dispatch push — preferred where wired (already reaches a phone). Seam only:
 *      HANDOFF_DISPATCH_HOOK, invoked with title + body.
 *   2. macOS terminal-notifier — the CLICKABLE rung, OPT-IN via HANDOFF_TERMINAL_NOTIFIER=<path>.
 *      It DOES deliver (measured: the notification centre's own delivered-list lists it). Opt-in
 *      because it needs installing, the Homebrew bottle is ad-hoc signed and spctl-rejected, and
 *      one machine's Notification Center policy does not settle another's.
 *   3. macOS osascript — the DEFAULT on macOS because it always appears. Attributed to Script
 *      Editor, so its click opens a file dialog and is useless; the body says so rather than
 *      implying otherwise.
 *   4. Windows toast via PowerShell WinRT — no install needed on Windows 10/11. Attributed to
 *      PowerShell for the same reason osascript is attributed to Script Editor: a toast must be
 *      shown by a registered app and handoff is not one. NOT VERIFIED on a real Windows machine;
 *      `node notify-smoke.js --prove` fires one so the person there can confirm by eye.
 *
 * Test / CI mode: HANDOFF_NOTIFY_LOG=<file> appends one JSON line INSTEAD of firing, so tests
 * never spawn OS notifications. HANDOFF_NO_NOTIFY=1 disables the layer. Never throws: a failed
 * ping must not break the durable write that already happened.
 */
'use strict';
const { execFile } = require('child_process');

/* Where terminal-notifier lives, resolved once per process. Absence is normal and is a
 * degrade, never an error — the osascript rung still shows the ping. HANDOFF_TERMINAL_NOTIFIER
 * overrides for tests and for non-Homebrew installs. */
let TN_CACHE;
/* OPT-IN ONLY, but not for the reason first recorded.
 *
 * RETRACTION (2026-08-09). This said terminal-notifier "delivered nothing" on the development
 * machine. It delivers. Both pieces of evidence behind the original claim were void:
 *   - `defaults read com.apple.ncprefs` returned zero entries for it — but that command returns
 *     "Domain does not exist" for EVERY app in this context, including ones that demonstrably
 *     deliver. It measured our own lack of access, not the notification's fate.
 *   - a six-second look with nobody watching. The owner later saw the notification.
 * `terminal-notifier -list <group>` reads the notification centre's DELIVERED records and shows
 * these arriving. That is also the delivery receipt an earlier note claimed did not exist, which
 * means auto-promotion on real evidence IS buildable if anyone wants it.
 *
 * Still opt-in, on the reasons that survived: it must be installed, the Homebrew bottle is
 * ad-hoc signed and spctl-rejected, and whether a particular machine's Notification Center
 * honours it depends on that machine's policy — n=1 here, and one machine does not settle it.
 * The general lesson, which cost two false claims in one day: exit 0 proves the binary ran.
 * Only a delivered-record proves delivery. Run `node notify-smoke.js --prove` per machine. */
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
        would_fire: process.platform === 'darwin' ? (clickableRungEnabled() ? 'terminal-notifier' : 'macos')
          : process.platform === 'win32' ? 'windows-toast' : 'unavailable',
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

    /* WINDOWS. Until now the only platform branch was darwin, so every notification on Windows
     * returned {fired:false, channel:'unavailable'} — meaning wake tier rung 3 (bin/handoff-wake,
     * "target CLOSED, ping the user so they open the window") did NOTHING on Windows, silently,
     * and the mail sat in the store until the user happened to look. Found 2026-08-09 when the
     * owner's second machine turned out to be Windows.
     *
     * Toast via PowerShell, chosen because it needs NO install: WinRT's ToastNotificationManager
     * is present on Windows 10 and 11, and we borrow PowerShell's own registered AppUserModelID
     * because a toast must be shown by a registered app and handoff is not one. Consequence,
     * stated rather than hidden: the toast is attributed to PowerShell, which is the same class
     * of compromise as osascript's Script Editor attribution on macOS — visible, honestly
     * labelled, and the click belongs to the host app rather than to us. So no click is promised.
     *
     * NOT VERIFIED ON A REAL WINDOWS MACHINE by the author. It is written, it is covered by
     * notify-smoke's routing assertions, and `node notify-smoke.js --prove` fires a real one so
     * the person on that machine can confirm with their own eyes. Until someone does that, this
     * comment must not claim it works — today produced two separate false "measured" claims
     * about notification delivery and both came from asserting an effect nobody had seen. */
    if (process.platform === 'win32') {
      const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const q = s => String(s).replace(/'/g, "''"); // PowerShell single-quote escape
      const doc =
        `<toast><visual><binding template="ToastGeneric">` +
        `<text>${xml(title)}</text><text>${xml(body)}</text>` +
        `</binding></visual></toast>`;
      const AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
      const ps = [
        `$ErrorActionPreference='Stop'`,
        `$null=[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]`,
        `$x=New-Object Windows.Data.Xml.Dom.XmlDocument`,
        `$x.LoadXml('${q(doc)}')`,
        `$t=New-Object Windows.UI.Notifications.ToastNotification $x`,
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${q(AUMID)}').Show($t)`
      ].join('; ');
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], () => {}); // fire-and-forget
      // click:'none' deliberately. The toast belongs to PowerShell's AUMID, so activating it
      // cannot route back here. Same honesty as the osascript rung: say the tap does nothing.
      return { fired: true, channel: 'windows-toast', click: 'none' };
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
