#!/usr/bin/env node
'use strict';
/**
 * THE CAPABILITY PROBE — automatic, free, and pessimistic when unsure.
 *
 * It was ratified as the wake agent's first-cycle job and shipped as a MANUAL instruction inside a
 * comment: "run this `claude -p` by hand and write the answer." Nobody ran it. So every machine in
 * the fleet ran on the platform default, and the belief "peer messaging cannot work on any OS"
 * survived unchallenged — the exception was never contradicted, because no measurement was taken.
 *
 * The documented probe could not have answered honestly anyway: a free-form "list your tools" reply
 * can OMIT rather than deny, and `--allowedTools` naming a nonexistent verb is a SILENT no-op, so it
 * could return a confident yes on a machine with no messaging at all.
 */
const os = require('os'), path = require('path'), fs = require('fs');
const wake = require('./bin/handoff-wake');
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.log('  ✗ FAIL: ' + l); } };

const withEnv = (env, fn) => {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
};

(async () => {
  // ---- THE SOCKET VARIABLE IS THE CAPABILITY ----
  {
    const r = wake.probePeerVerbs({ platform: 'darwin', socketVar: '/tmp/cc-socks/1.sock' });
    ok(r.peer_verbs === true, 'socket var set → peer verbs AVAILABLE, no model spawn, no token');
    ok(/MESSAGING_SOCKET/.test(r.evidence), 'and the evidence names WHAT was observed, not a conclusion');
  }

  // ---- A DIRECTORY OF SOCKETS SAYS THE SAME THING TO A PROCESS THAT INHERITED NO ENV ----
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socks-'));
    fs.writeFileSync(path.join(dir, '123.sock'), '');
    /* platform injected: on win32 the probe answers conclusively and short-circuits, so this
     * branch would be unreachable on the very platform this suite was tracked to cover. */
    const r = wake.probePeerVerbs({ platform: 'darwin', socketVar: '', socketDir: dir });
    ok(r.peer_verbs === true,
      'socket DIRECTORY populated → available even with no env — a launchd/scheduled process inherits nothing');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- INCONCLUSIVE IS A THIRD STATE, NOT A DENIAL ----
  {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nosocks-'));
    const r = wake.probePeerVerbs({ platform: 'darwin', socketVar: '', socketDir: empty });
    ok(r.peer_verbs === null,
      'no var and no sockets → INCONCLUSIVE (null), which is neither true nor false');
    ok(/INCONCLUSIVE/.test(r.evidence), 'and says so, rather than reporting a denial it did not measure');

    // The whole point: an inconclusive probe must not overwrite anything.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'caphome-'));
    const w = wake.recordPeerVerbs(home, { platform: 'darwin', socketVar: '', socketDir: empty });
    ok(w.written === false, 'INCONCLUSIVE writes NOTHING — the pessimistic default is left standing');
    ok(!fs.existsSync(path.join(home, 'wake-capabilities.json')),
      'and no capability file is created, so a later conclusive probe is not pre-empted by a guess');
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }

  // ---- A CONCLUSIVE PROBE IS RECORDED, WITH ITS ASYMMETRY ----
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'caphome2-'));
    const w = wake.recordPeerVerbs(home, { platform: 'darwin', socketVar: '/tmp/cc-socks/9.sock' });
    ok(w.written === true, 'a conclusive probe IS recorded');
    const j = JSON.parse(fs.readFileSync(path.join(home, 'wake-capabilities.json'), 'utf8'));
    ok(j.peer_verbs === true && !!j.probed_at && !!j.evidence, 'the file carries the answer, when it was probed, and the evidence');
    ok(/REFUSING costs a notification/.test(j.note) && /RELAYING\s+costs invisible silence/.test(j.note.replace(/\s+/g, ' ')),
      'and the ASYMMETRY is written into the file, per the ruling — whoever reads it later must know which way to err');

    // And the gate actually consumes it.
    const g = withEnv({ HANDOFF_HOME: home }, () => wake.peerVerbsAvailable());
    ok(g.ok === true && /wake-capabilities/.test(g.source),
      'the gate reads the recorded answer rather than the platform default — the probe changes behaviour');
    fs.rmSync(home, { recursive: true, force: true });
  }

  // ---- WINDOWS IS A CONCLUSIVE NO, NOT AN INCONCLUSIVE ONE ----
  {
    const w32 = wake.probePeerVerbs({ platform: 'win32', socketVar: '', socketDir: '/nonexistent' });
    ok(w32.peer_verbs === false && /native Windows/.test(w32.evidence),
      'win32 is answered CONCLUSIVELY false (excluded by the product), not left to a missing-file guess');
    ok(w32.peer_verbs !== null,
      'win32 is never INCONCLUSIVE — absence there is a denial, unlike everywhere else');
  }

  console.log(`\ncapability-probe: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
