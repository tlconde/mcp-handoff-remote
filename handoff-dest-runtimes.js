'use strict';
/**
 * LAPTOP DEST RUNTIMES — capability probe, not a hardcoded Claude Code dest.
 *
 * send_to_worker starts a terminal agent on the home machine. The dest is whichever
 * agent CLI is installed (Claude Code, Codex, others), honoring an explicit name
 * ("start Codex") and otherwise starting the one that is present. Several present
 * and no name is ambiguity: refused, never guessed.
 *
 * Probe-only entries (spawnKind null) may be named and listed; they are not auto-spawned
 * with invented argv. Slack and ChatGPT are not in this catalog. Cowork-window spawn
 * APIs are not wrapped here.
 */
const fs = require('fs');
const { spawnSync } = require('child_process');
const { CURRENT } = require('./bin/platform-profile');

const CATALOG = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    names: ['claude code', 'claude-code', 'claude', 'anthropic'],
    bin: 'claude',
    spawnKind: 'claude',
  },
  {
    id: 'codex',
    label: 'Codex',
    names: ['codex', 'openai codex', 'openai-codex'],
    bin: 'codex',
    spawnKind: 'codex',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    names: ['gemini', 'gemini cli', 'gemini-cli'],
    bin: 'gemini',
    spawnKind: null,
  },
];

function normalizeWant(want) {
  return String(want || '').trim().toLowerCase()
    .replace(/^start\s+/, '')
    .replace(/^use\s+/, '')
    .replace(/_/g, '-')
    .replace(/\s+/g, ' ');
}

function namesOf(entry) {
  return [entry.id, entry.bin, entry.label].concat(entry.names || [])
    .map(n => String(n).trim().toLowerCase().replace(/_/g, '-').replace(/\s+/g, ' '));
}

function matchCatalog(want) {
  const n = normalizeWant(want);
  if (!n) return null;
  const folded = n.replace(/-/g, ' ');
  for (const r of CATALOG) {
    const names = namesOf(r);
    if (names.includes(n) || names.map(x => x.replace(/-/g, ' ')).includes(folded)) return r;
  }
  return null;
}

function seamPresentIds() {
  if (process.env.HANDOFF_DEST_PRESENT === undefined) return null;
  if (process.env.HANDOFF_TEST === '1') {
    return String(process.env.HANDOFF_DEST_PRESENT).split(',').map(s => s.trim()).filter(Boolean);
  }
  try {
    console.error('[handoff] REFUSED test seam HANDOFF_DEST_PRESENT: it replaces a real CLI probe. Set HANDOFF_TEST=1 as well if this is genuinely a test process. Proceeding with the REAL probe.');
  } catch (_) { /* ignore */ }
  return null;
}

function publicRuntime(row) {
  return {
    id: row.id,
    label: row.label,
    names: row.names,
    bin: row.bin,
    spawnKind: row.spawnKind,
    present: !!row.present,
    binPath: row.binPath || null,
    evidence: row.evidence || null,
  };
}

function probeDestRuntimes(opts) {
  const o = opts || {};
  const prof = o.profile || CURRENT;
  const exists = o.exists || (p => { try { return fs.existsSync(p); } catch (_) { return false; } });

  let presentIds = o.presentIds || null;
  if (!opts) {
    if (process.env.HANDOFF_NO_CLI && process.env.HANDOFF_DEST_PRESENT === undefined) {
      return CATALOG.map(r => publicRuntime({
        ...r, present: false, binPath: null, evidence: 'HANDOFF_NO_CLI',
      }));
    }
    presentIds = seamPresentIds();
  }

  return CATALOG.map(r => {
    if (presentIds) {
      const on = presentIds.includes(r.id) || presentIds.includes(r.bin);
      return publicRuntime({
        ...r, present: on, binPath: on ? r.bin : null, evidence: 'HANDOFF_DEST_PRESENT',
      });
    }
    const candidates = (typeof prof.binCandidates === 'function') ? prof.binCandidates(r.bin) : [];
    let binPath = null;
    for (const p of candidates) { if (exists(p)) { binPath = p; break; } }
    if (!binPath) {
      try {
        const cmd = prof.cliLookupCommand || 'which';
        let out;
        if (typeof o.whichFor === 'function') out = o.whichFor(r.bin);
        else if (o.whichOutput && Object.prototype.hasOwnProperty.call(o.whichOutput, r.bin)) out = o.whichOutput[r.bin];
        else {
          const r2 = spawnSync(cmd, [r.bin], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
          out = r2 && r2.stdout;
        }
        const hits = String(out || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        const hit = prof.cliRequiresDirectlySpawnable
          ? hits.find(prof.cliSpawnableTest || (p => /\.exe$/i.test(p)))
          : hits[0];
        if (hit) binPath = hit;
      } catch (_) { /* lookup verb missing is absence, not a throw */ }
    }
    return publicRuntime({
      ...r,
      present: !!binPath,
      binPath: binPath || null,
      evidence: binPath ? `found ${binPath}` : `not found (${r.bin})`,
    });
  });
}

function pickDestRuntime(want, probed) {
  const list = probed || probeDestRuntimes();
  const present = list.filter(r => r.present);
  if (want && String(want).trim()) {
    const spec = matchCatalog(want);
    if (!spec) {
      return {
        ok: false, error: 'unknown_dest',
        detail: `"${String(want).trim()}" is not a known laptop agent CLI. Known: ${CATALOG.map(c => c.label).join(', ')}.`,
      };
    }
    const hit = list.find(r => r.id === spec.id);
    if (!hit || !hit.present) {
      return {
        ok: false, error: 'dest_not_installed', dest: spec.id, label: spec.label,
        present: present.map(p => ({ id: p.id, label: p.label })),
        detail: `"${spec.label}" is not installed on the home machine.` +
          (present.length ? ` Present: ${present.map(p => p.label).join(', ')}.` : ' None of the known agent CLIs are present.'),
      };
    }
    return { ok: true, runtime: hit, explicit: true };
  }
  if (present.length === 1) return { ok: true, runtime: present[0], explicit: false, defaulted: true };
  if (present.length === 0) {
    return {
      ok: false, error: 'none_present',
      detail: 'no agent CLI is installed on the home machine (looked for ' + CATALOG.map(c => c.label).join(', ') + ').',
    };
  }
  return {
    ok: false, error: 'ambiguous',
    present: present.map(p => ({ id: p.id, label: p.label, bin: p.bin })),
    detail: `several agent CLIs are installed on the home machine (${present.map(p => p.label).join(', ')}). Name one ("start Codex", "start Claude Code").`,
  };
}

function nativeRefFor(runtime, nativeId, dir) {
  if (!runtime) return { kind: 'code', session_id: nativeId, cwd: dir, resume: null };
  if (runtime.id === 'claude-code') {
    return { kind: 'claude-code', session_id: nativeId, cwd: dir, resume: `claude --resume ${nativeId}` };
  }
  if (runtime.id === 'codex') {
    return { kind: 'codex', session_id: nativeId, cwd: dir, resume: 'codex exec resume --last' };
  }
  return { kind: runtime.id, session_id: nativeId, cwd: dir, resume: null };
}

function spawnArgv(runtime, { nativeId, prompt, allowedTools } = {}) {
  if (!runtime || !runtime.spawnKind) return null;
  if (runtime.spawnKind === 'claude') {
    const args = ['-p', '--session-id', nativeId, prompt, '--output-format', 'text'];
    if (allowedTools) args.push('--allowedTools', allowedTools);
    return { bin: runtime.binPath || 'claude', args };
  }
  if (runtime.spawnKind === 'codex') {
    return {
      bin: runtime.binPath || 'codex',
      args: ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', prompt],
    };
  }
  return null;
}

module.exports = {
  CATALOG, probeDestRuntimes, pickDestRuntime, matchCatalog, nativeRefFor, spawnArgv, normalizeWant,
};
