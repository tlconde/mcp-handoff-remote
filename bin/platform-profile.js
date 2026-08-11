#!/usr/bin/env node
'use strict';
/**
 * PLATFORM PROFILE — the ONE place the operating system is allowed to matter.
 *
 * THE RULE, stated by the operator and now the standard for this repo: general code is
 * PLATFORM-AGNOSTIC. What differs between machines is resolved ONCE into a local configuration,
 * by code, and every consumer reads that configuration instead of asking the OS. Nothing outside
 * this file may branch on `process.platform`.
 *
 * WHY, in this project's own evidence. `process.platform` was scattered across four modules, and
 * every scattered site was a place where behaviour was INHERITED from the host rather than
 * DECLARED. The whole of 2026-08-11 is that one defect wearing different clothes:
 *
 *   the mount        silence read as "this is the home machine"        → minted a phantom store
 *   the wake agent   os.hostname() over a config that never loaded     → owned nothing, silently
 *   the relay        a schema loaded at boot and never watched         → served a stale tool surface
 *   claudeBinPath    POSIX paths and a `which` that Windows lacks      → null on every Windows box
 *   check_inbox      the caller's surface instead of ownership         → ate a peer's mail
 *   wake-smoke       the host's capability default                     → 11 reds, on Windows only
 *
 * Scattered branches are also untestable by construction: to reach the win32 arm of a function you
 * must BE on win32, so the only oracle is a second machine, which is slow, expensive, and was in
 * fact how the fleet found out. A profile is a value — a test passes a different one and every
 * branch becomes reachable from anywhere.
 *
 * WHAT BELONGS HERE: facts that differ by machine and are knowable at startup. What does NOT: any
 * decision that depends on them. This file says "the notifier is windows-toast"; it never decides
 * whether to notify.
 *
 * ADDING A PLATFORM, or a fact for one that exists, is a change to THIS FILE and its profile shape
 * — never a new `if (process.platform === …)` somewhere convenient. `bin/platform-parity-check.js`
 * enforces the consequence for the shipped suites: a suite whose result changes when told it is on
 * another OS is inheriting rather than declaring, and fails.
 */
const os = require('os');
const path = require('path');

/** Build the profile for a named platform. `plat` is a value, so any profile is testable anywhere. */
function profileFor(plat, homeDir) {
  const platform = plat || process.platform;
  const home = homeDir || os.homedir();
  const isWin = platform === 'win32';
  const isMac = platform === 'darwin';

  return {
    platform,
    isWin,
    isMac,
    /* The name a HUMAN reads in a refusal or a log line. "native Windows" carries the distinction
     * that matters here — WSL 2 is supported and native Windows is not — which "win32" does not. */
    displayName: isWin ? 'native Windows' : isMac ? 'macOS' : platform,

    /* HOW THIS MACHINE IS NAMED. Not configurable, by the operator's ruling: a peer's id is not
     * ours to dictate, the device reports what it is called and the fleet accepts it. Recorded here
     * so the rule has one home rather than being re-derived at each call site. */
    hostId: os.hostname(),

    /* WHERE THE CLI LIVES, and how to look for it. The candidate list and the lookup command are
     * both platform facts; the SELECTION rule (prefer a directly-spawnable .exe over a shim) is a
     * decision and lives with the resolver. */
    cliCandidates: isWin
      ? [
        path.join(home, '.local', 'bin', 'claude.exe'),
        path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'claude', 'claude.exe'),
      ]
      : [
        path.join(home, '.local', 'bin', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
      ],
    cliLookupCommand: isWin ? 'where' : 'which',
    /* `where` prints EVERY match; `which` prints one. On Windows a .cmd/.bat cannot be spawned by
     * Node >=18.20 without shell:true, and shell:true would push the multi-line quoted relay prompt
     * through cmd.exe and mangle it — a garbled wake reads as a model problem. So the win32 profile
     * declares that only a directly-spawnable image will do. */
    cliRequiresDirectlySpawnable: isWin,
    cliSpawnableTest: isWin ? (p => /\.exe$/i.test(p)) : (() => true),

    /* WHICH NOTIFIER THIS MACHINE HAS. `unavailable` is a real answer and must stay distinguishable
     * from "we did not look" — a platform with no channel is not a failure to report one. */
    notifyChannel: isMac ? 'macos' : isWin ? 'windows-toast' : 'unavailable',
    hasNotifier: isMac || isWin,

    /* CROSS-SESSION MESSAGING. Documented as macOS/Linux (incl. WSL 2) and NOT offered on native
     * Windows, so absence there is a DENIAL while absence elsewhere is merely unmeasured. That
     * asymmetry is a platform fact and belongs here; the probe that acts on it does not. */
    peerVerbsPossible: !isWin,
    peerVerbsAbsenceIsConclusive: isWin,

    /* WHERE SESSION SOCKETS LIVE, and it is NOT the same place on every platform. macOS uses
     * /tmp/cc-socks; Linux uses $XDG_RUNTIME_DIR/cc-socks (measured on WSL 2 Ubuntu:
     * /run/user/1000/cc-socks holds live sockets while /tmp/cc-socks never exists).
     *
     * This default was hardcoded to the macOS path inside the capability probe — one platform's
     * path generalised into the default, in the code written to stop exactly that. It mattered
     * most where it was most wrong: the directory branch exists for a process that inherits NO
     * environment, which on Linux is a systemd unit, which is precisely where XDG_RUNTIME_DIR is
     * the only correct answer. The probe would have reported INCONCLUSIVE on a machine where the
     * feature is fully live, and gated rung 2 off. Found on WSL 2 by the peer.
     *
     * Read from the environment at call time rather than baked into the profile, because a daemon
     * and an interactive session on the same machine can legitimately differ. */
    socketDirs: () => {
      const dirs = [];
      if (process.env.CLAUDE_CODE_SOCKET_DIR) dirs.push(process.env.CLAUDE_CODE_SOCKET_DIR);
      if (!isWin && process.env.XDG_RUNTIME_DIR) dirs.push(path.join(process.env.XDG_RUNTIME_DIR, 'cc-socks'));
      if (!isWin) {
        dirs.push('/tmp/cc-socks');
        /* The binary's own fallback is uid-suffixed — /tmp/cc-socks-<uid>/<pid>.sock — read out of
         * the compiled 2.1.227 by the WSL seat rather than guessed. Checking only the unsuffixed
         * form would miss a live machine, which is the same defect this list was created to fix. */
        try { if (typeof process.getuid === 'function') dirs.push(`/tmp/cc-socks-${process.getuid()}`); } catch (_) {}
      }
      return dirs;
    },

    /* Opening a URL or a file, for the surfaces that offer a click. */
    opener: isMac ? 'open' : isWin ? 'start' : 'xdg-open',
  };
}

/** The profile for the machine this process is actually on, resolved once. */
const CURRENT = profileFor();

module.exports = { profileFor, CURRENT };
