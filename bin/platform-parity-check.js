#!/usr/bin/env node
'use strict';
/**
 * PLATFORM PARITY — run the shipped suites AS IF on another platform, and fail when the result
 * changes.
 *
 * WHY THIS EXISTS. The operator named the systemic defect of this project in one sentence: a thing
 * must DECLARE the capability it needs rather than INHERIT whatever the host happens to default to.
 * Every failure of 2026-08-11 is an instance:
 *
 *   the mount        inherited silence as "this is the home machine"      → minted a phantom store
 *   the wake agent   inherited os.hostname() over a config that never loaded → owned nothing, silently
 *   the relay        inherited a schema loaded at boot and never watched   → served a stale tool surface
 *   claudeBinPath    inherited POSIX assumptions                           → null on every Windows box
 *   check_inbox      inherited the caller's surface instead of ownership   → ate a peer's mail
 *   wake-smoke       inherited the host platform's capability default      → 11 reds on Windows only
 *
 * The last one is the reason for this file. Those eleven tests exercised rung 2 while assuming the
 * peer-verb gate was open — true by default on macOS, false on Windows. They passed here and failed
 * there, and NOBODY COULD HAVE KNOWN without a second machine, because the suite silently adapted to
 * whatever platform ran it. The fleet found out by shipping the suites to a Windows peer and asking
 * it to run them, which is a slow and expensive oracle.
 *
 * WHAT IT DOES. Runs each shipped suite twice in a child process with `process.platform` forced —
 * once as darwin, once as win32 — and compares pass/fail. A suite that DECLARES its preconditions
 * produces identical results. A suite that INHERITS them changes, and the difference is the defect.
 *
 * WHAT IT CANNOT DO, stated rather than implied. Faking process.platform does not fake path.sep,
 * os.homedir(), the filesystem, or the absence of `where`/`which`. So this proves DECLARATION, not
 * portability: it catches a suite whose ANSWER depends on the ambient platform, which is the class
 * that cost the day. A genuine cross-platform run is still the only proof of portability, and rider
 * 3 of the ADR-0002 amendment keeps that requirement alive.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..');
/* Exactly the suites ADR-0002's amendment ships, because those are the ones whose answer is
 * allowed to be platform-shaped in the first place. A lab-side suite that inherits is a smaller
 * problem: nobody ships it to another platform and concludes anything from it. */
const SUITES = ['wake-smoke.js', 'notify-smoke.js', 'capability-probe-smoke.js', 'role-smoke.js'];

/* The child stubs process.platform BEFORE the suite loads, because these modules read it at
 * require time (that is itself the inheritance pattern under test). */
const SHIM = (plat, suite) => `
/* os.tmpdir() reads TEMP/TMP on win32 and TMPDIR elsewhere, so faking the platform alone breaks
 * every fixture that makes a temp directory. We are faking the platform IDENTITY, not the OS, so
 * the harness supplies the minimum a faked platform expects. This is the documented limit of the
 * technique showing itself immediately, which is a good sign about the technique rather than a bad
 * one: it fails loudly at the boundary instead of quietly producing a wrong comparison. */
const realTmp = require('os').tmpdir();
process.env.TEMP = process.env.TEMP || realTmp;
process.env.TMP = process.env.TMP || realTmp;
process.env.TMPDIR = process.env.TMPDIR || realTmp;
Object.defineProperty(process, 'platform', { value: ${JSON.stringify(plat)}, configurable: true });
require(${JSON.stringify(path.join(REPO, suite))});
`;

function runAs(plat, suite) {
  const r = spawnSync(process.execPath, ['-e', SHIM(plat, suite)], {
    cwd: REPO, encoding: 'utf8', timeout: 180000,
    /* The harness passes NO extra environment. It did pass HANDOFF_NO_NOTIFY=1, which changed what
     * the suite under test does — a checker that alters its subject measures itself. The suites
     * already route rather than fire; that is their own guarantee to make, not this file's. */
    env: process.env,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const m = /(\d+)\s+passed,\s+(\d+)\s+failed/.exec(out);
  if (!m) return { ok: false, unparsed: true, tail: out.trim().split('\n').slice(-3).join(' | ') };
  return { ok: true, passed: Number(m[1]), failed: Number(m[2]) };
}

let problems = 0;
console.log('platform-parity-check — the same suite, told it is on a different OS\n');
for (const suite of SUITES) {
  if (!fs.existsSync(path.join(REPO, suite))) { console.log(`  ?  ${suite} — absent, skipped`); continue; }
  const d = runAs('darwin', suite);
  const w = runAs('win32', suite);

  if (!d.ok || !w.ok) {
    console.log(`  ✗  ${suite} — could not parse a result (${(d.tail || w.tail || '').slice(0, 120)})`);
    problems++;
    continue;
  }
  if (d.passed === w.passed && d.failed === w.failed) {
    console.log(`  ✓  ${suite} — identical under both (${d.passed} passed, ${d.failed} failed)`);
  } else {
    console.log(`  ✗  ${suite} — INHERITS THE PLATFORM: darwin ${d.passed}/${d.failed}, win32 ${w.passed}/${w.failed}`);
    console.log(`       This suite's answer depends on the OS running it, so a green run here says`);
    console.log(`       nothing about the other platform. Declare the precondition instead of`);
    console.log(`       inheriting it — write the capability/role the tests need, do not accept the`);
    console.log(`       host default. Where the CODE branches on platform, inject it.`);
    problems++;
  }
}

if (problems) {
  console.log(`\n${problems} suite(s) inherit ambient platform state.`);
  console.log('A test that adapts to the machine running it cannot report on any other machine.');
  process.exit(1);
}
console.log('\nplatform-parity-check: OK — every shipped suite declares what it needs.');
