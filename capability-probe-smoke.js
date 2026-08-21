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


  // ---- THE SOCKET DIRECTORY IS A PLATFORM FACT, NOT A CONSTANT ----
  {
    /* Linux keeps session sockets in $XDG_RUNTIME_DIR/cc-socks; macOS uses /tmp/cc-socks. This was
     * hardcoded to the macOS path INSIDE the probe — one platform's path generalised into the
     * default, in the code written to stop exactly that. It mattered most where it was most wrong:
     * the directory branch exists for a process that inherits NO environment, which on Linux is a
     * systemd unit, which is precisely where XDG_RUNTIME_DIR is the only correct answer. Measured
     * on WSL 2 by the peer: /tmp/cc-socks never exists there while /run/user/1000/cc-socks holds
     * live sockets, so the probe would have said INCONCLUSIVE on a machine where the feature works
     * and gated rung 2 off. */
    const { profileFor } = require('./bin/platform-profile');
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'xdg-'));
    fs.mkdirSync(path.join(xdg, 'cc-socks'));
    fs.writeFileSync(path.join(xdg, 'cc-socks', '645.sock'), '');

    const saved = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = xdg;
    const dirs = profileFor('linux').socketDirs();
    ok(dirs[0] === path.join(xdg, 'cc-socks'),
      'linux: $XDG_RUNTIME_DIR/cc-socks is checked FIRST — where a systemd unit would actually find them');
    ok(dirs.includes('/tmp/cc-socks'),
      'linux: and /tmp/cc-socks remains a fallback rather than being replaced');

    const r = wake.probePeerVerbs({ platform: 'linux', socketVar: '' });
    ok(r.peer_verbs === true && r.evidence.includes('cc-socks'),
      'linux: the probe FINDS sockets under XDG_RUNTIME_DIR — the case that reported INCONCLUSIVE on a live machine');

    if (saved === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = saved;
    ok(!profileFor('win32').socketDirs().length,
      'win32: no socket directories at all — the platform has no such thing, and says so');
    fs.rmSync(xdg, { recursive: true, force: true });
  }

  // ---- LAPTOP DEST RUNTIMES: probe + pick, injected, never inherited ----
  {
    const dests = require('./handoff-dest-runtimes');
    const { profileFor } = require('./bin/platform-profile');
    const none = () => false;
    const whichNone = { claude: '', codex: '', gemini: '' };

    const probedNone = dests.probeDestRuntimes({
      profile: profileFor('darwin', '/tmp/home-dest'),
      exists: none, whichOutput: whichNone,
    });
    ok(probedNone.every(r => r.present === false),
      'dest probe: empty PATH and no candidate files → nothing present (not a Claude default)');
    const nonePick = dests.pickDestRuntime(null, probedNone);
    ok(nonePick.ok === false && nonePick.error === 'none_present',
      'dest pick: nothing present and no name → refuse, do not guess Claude Code');

    const darwinHome = '/tmp/home-dest-d';
    const probedClaude = dests.probeDestRuntimes({
      profile: profileFor('darwin', darwinHome),
      exists: p => p === darwinHome + '/.local/bin/claude',
      whichOutput: whichNone,
    });
    ok(probedClaude.find(r => r.id === 'claude-code').present === true, 'darwin candidate finds claude');
    ok(probedClaude.find(r => r.id === 'codex').present === false, 'darwin candidate does not invent Codex');
    const one = dests.pickDestRuntime(null, probedClaude);
    ok(one.ok && one.defaulted && one.runtime.id === 'claude-code',
      'dest pick: one present, no name → start that one');

    const probedBoth = dests.probeDestRuntimes({
      profile: profileFor('darwin', darwinHome),
      exists: p => p === darwinHome + '/.local/bin/claude' || p === darwinHome + '/.local/bin/codex',
      whichOutput: whichNone,
    });
    const ambi = dests.pickDestRuntime(null, probedBoth);
    ok(ambi.ok === false && ambi.error === 'ambiguous' && ambi.present.length === 2,
      'dest pick: Claude Code AND Codex present, no name → refuse, never guess');
    const named = dests.pickDestRuntime('start Codex', probedBoth);
    ok(named.ok && named.explicit && named.runtime.id === 'codex',
      'dest pick: "start Codex" honors the name when both are present');
    const namedClaude = dests.pickDestRuntime('Claude Code', probedBoth);
    ok(namedClaude.ok && namedClaude.runtime.id === 'claude-code',
      'dest pick: "Claude Code" honors the name');
    const missing = dests.pickDestRuntime('codex', probedClaude);
    ok(missing.ok === false && missing.error === 'dest_not_installed',
      'dest pick: named Codex when only Claude Code is present → refuse, do not fall back');
    const unknown = dests.pickDestRuntime('slack', probedBoth);
    ok(unknown.ok === false && unknown.error === 'unknown_dest',
      'dest pick: Slack is not a dest in this cut');
    ok(!dests.matchCatalog('chatgpt'),
      'dest catalog does not include ChatGPT');

    const winProf = profileFor('win32', 'C:\\Users\\x');
    const winClaude = dests.probeDestRuntimes({
      profile: winProf,
      exists: p => /claude\.exe$/i.test(p),
      whichOutput: whichNone,
    });
    ok(winClaude.find(r => r.id === 'claude-code').present === true,
      'win32: .exe candidate is found without calling `which`');
    ok(winProf.binCandidates('codex').some(p => /\.exe$/i.test(p)),
      'win32 binCandidates for a dest other than claude are still .exe paths — not a Claude-only list');

    const argv = dests.spawnArgv({ spawnKind: 'codex', binPath: '/opt/codex' }, { prompt: 'do the thing' });
    ok(argv && argv.bin === '/opt/codex' && argv.args[0] === 'exec',
      'codex spawn is `codex exec`, not a Claude argv');
    ok(dests.spawnArgv({ spawnKind: null, id: 'gemini' }, { prompt: 'x' }) === null,
      'probe-only dests have no invented spawn argv');
  }

  console.log(`\ncapability-probe: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
