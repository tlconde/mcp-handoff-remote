#!/usr/bin/env node
'use strict';
/**
 * SETTINGS DRIFT CHECK — the mechanical half of "doctrine is advisory, tests are binding".
 *
 * WHY THIS EXISTS. REMOTE-PEER-SETUP.md told operators to write HANDOFF_HOST_ID into .agent-env.
 * On the machine that followed the instruction it never once took effect: the value was read at
 * bin/handoff-wake-agent.js line 66 while the loader that populates process.env from that file ran
 * as a side effect of a require at line 76. Ten lines. The peer then went blind — peeking mail,
 * owning nothing, printing healthy cycles — for as long as the doc had existed.
 *
 * Nothing caught it, and the reason is the interesting part: there were 38 wake-agent tests, and
 * every one that set configuration set a REAL ENVIRONMENT VARIABLE, which works because it exists
 * before the process starts. Not one wrote an .agent-env file. The suite exercised a path no
 * operator uses, and the documented path had zero coverage. Both were internally consistent and
 * they described different systems.
 *
 * The class was already named in AGENTS.md — "shipping the mechanism and not the path to it" —
 * ratified, cited, and violated anyway. A rule enforced only by prose is a rule scheduled for
 * violation, so this is the enforcement: a script that exits non-zero and cannot be forgotten.
 *
 * WHAT IT CHECKS, for every KEY the docs tell an operator to write into .agent-env:
 *   1. SOMETHING READS IT.        A documented setting nothing consumes is a promise with no
 *                                 mechanism behind it.
 *   2. IT IS READ AFTER LOADING.  In any file that reads the key, an explicit loadLocalEnv() call
 *                                 (or the require whose side effect performs it) must appear before
 *                                 the read. This is the exact defect above, and it is detectable by
 *                                 line number, which is all it ever needed.
 *
 * WHAT IT CANNOT CHECK, stated rather than implied: whether the value does the right thing once
 * read. That is (b)'s job — one file-based test per documented setting, writing .agent-env the way
 * the doc says to write it. This script proves the value ARRIVES; only a test proves it MATTERS.
 */
const fs = require('fs');
const path = require('path');

/* Overridable so the check can be pointed at a FIXTURE that contains the defect. A checker that
 * has only ever passed is indistinguishable from one that cannot fail, and this repo has shipped
 * that shape before — a test seam that armed silently, a script that printed "patched" for an edit
 * matching nothing. The fixture run is how this one earns its exit code. */
const ROOT = process.env.HANDOFF_DRIFT_ROOT || path.join(__dirname, '..');
const DOCS = ['REMOTE-PEER-SETUP.md', 'INSTALL.md', 'README.md', 'TRANSPORT-MATRIX.md'];
const CODE = ['mcp-handoff.js', 'handoff-core.js', 'handoff-tools.js', 'handoff-daemon.js', 'handoff-relay.js',
  'bin/handoff-wake-agent.js', 'bin/handoff-wake.js', 'bin/handoff-notify.js', 'bin/handoff-store-client.js',
  'bin/handoff-transport.js', 'bin/install.js'];

const read = f => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return null; } };

/* Only keys an operator is instructed to WRITE INTO .agent-env are in scope. A key merely mentioned
 * in prose, or shown as a shell export, is not a claim about that file. The fenced blocks that
 * create .agent-env are the instruction, so those are what is parsed — and a line inside a
 * blockquote is excluded, because that is how a doc RETRACTS an instruction (see the host-id note)
 * and a retraction must not read as a promise. */
function documentedKeys() {
  const found = new Map();
  for (const doc of DOCS) {
    const src = read(doc);
    if (!src) continue;
    const lines = src.split('\n');
    let inFence = false, fenceTouchesAgentEnv = false, fenceStart = 0;
    lines.forEach((line, i) => {
      if (/^\s*```/.test(line)) {
        if (!inFence) { inFence = true; fenceStart = i; fenceTouchesAgentEnv = false; }
        else { inFence = false; }
        return;
      }
      if (inFence) {
        if (/\.agent-env/.test(line)) fenceTouchesAgentEnv = true;
        return;
      }
    });
    // Second pass with the fence bodies, now that we know which fences concern .agent-env.
    inFence = false;
    let body = [], touches = false;
    lines.forEach(line => {
      if (/^\s*```/.test(line)) {
        if (inFence) {
          if (touches) {
            for (const b of body) {
              const m = /^\s*(?:Add-Content[^"]*")?\s*([A-Z][A-Z0-9_]{3,})\s*=/.exec(b);
              if (m && !/^#/.test(b.trim())) found.set(m[1], doc);
            }
          }
          inFence = false; body = []; touches = false;
        } else { inFence = true; }
        return;
      }
      if (inFence) { body.push(line); if (/\.agent-env/.test(line)) touches = true; }
      else if (/\.agent-env/.test(line)) touches = false;
    });
    // A fence that only names the file in the surrounding prose still counts: look back one line.
    const fences = src.split(/^\s*```.*$/m);
    for (let i = 1; i < fences.length; i += 2) {
      const before = fences[i - 1] || '';
      if (!/\.agent-env/.test(before.slice(-400)) && !/\.agent-env/.test(fences[i])) continue;
      for (const b of fences[i].split('\n')) {
        if (/^\s*>/.test(b)) continue;                       // a retraction, not an instruction
        const m = /^\s*(?:Add-Content[^"]*")?\s*([A-Z][A-Z0-9_]{3,})\s*=/.exec(b);
        if (m) found.set(m[1], doc);
      }
    }
  }
  return found;
}

/** Where a key is read, and whether the loader demonstrably ran first in that file. */
function auditKey(key) {
  const readers = [];
  for (const f of CODE) {
    const src = read(f);
    if (!src) continue;
    const lines = src.split('\n');
    const readAt = lines.findIndex(l => l.includes(`process.env.${key}`) || l.includes(`process.env['${key}']`) || l.includes(`env['${key}']`) || l.includes(`'${key}'`) && /process\.env|pick\(/.test(l));
    if (readAt === -1) continue;
    // The loader is present if it is CALLED, or if this file IS the loader.
    const loadAt = lines.findIndex(l => /loadLocalEnv\s*\(/.test(l));
    const isLoaderItself = /function loadLocalEnv/.test(src);
    readers.push({ file: f, readLine: readAt + 1, loadLine: loadAt === -1 ? null : loadAt + 1, isLoaderItself });
  }
  return readers;
}

const problems = [];
const keys = documentedKeys();
if (!keys.size) problems.push('no documented .agent-env keys found at all — the parser is broken, which is worse than a drift');

for (const [key, doc] of keys) {
  const readers = auditKey(key);
  if (!readers.length) {
    problems.push(`${key}: ${doc} tells an operator to set it, and NOTHING READS IT. A documented setting with no consumer is a promise with no mechanism.`);
    continue;
  }
  for (const r of readers) {
    if (r.isLoaderItself) continue;
    if (r.loadLine === null) {
      problems.push(`${key}: read at ${r.file}:${r.readLine}, but that file never calls loadLocalEnv() — so an operator's .agent-env value cannot reach it.`);
    } else if (r.loadLine > r.readLine) {
      problems.push(`${key}: read at ${r.file}:${r.readLine} but loadLocalEnv() is only called at line ${r.loadLine} — the value is parsed AFTER the line that consumes it and loses silently to its fallback. This is the HANDOFF_HOST_ID defect exactly.`);
    }
  }
}

console.log(`settings-drift-check: ${keys.size} documented .agent-env key(s) — ${[...keys.keys()].join(', ') || 'none'}`);
if (problems.length) {
  console.log('\nDRIFT:');
  for (const p of problems) console.log('  ✗ ' + p);
  console.log(`\n${problems.length} problem(s). A documented setting that cannot take effect is worse than an undocumented one: it is followed.`);
  process.exit(1);
}
console.log('settings-drift-check: OK — every documented setting is read, and read after the loader runs.');
