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

/* stdin ignore = immediate EOF. Codex exec treats an open piped stdin as extra context
 * and never sees EOF if the parent keeps the pipe. stderr is piped so progress cannot
 * fill an unread buffer and block. Same stdio for every dest spawn — Claude -p does not
 * need stdin either; the prompt is argv.
 *
 * stdout and stderr are drained separately. doLaunch turns sink.out into `[auto CLI]`
 * progress; Codex writes progress on stderr, so mixing the two overwrites the real
 * summary. stderr is consumed into a capped discarded buffer and never used as the
 * auto summary. */
const WORKER_STDIO = ['ignore', 'pipe', 'pipe'];
const PIPE_CAP = 20000;
const HEAD_CAP = 8192;

function workerSpawnOpts(extra) {
  return Object.assign({ stdio: WORKER_STDIO.slice() }, extra || {});
}

function harvestCodexSessionId(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const ev = JSON.parse(t);
      if (!ev || typeof ev !== 'object') continue;
      if (ev.type === 'thread.started' && ev.thread_id) return String(ev.thread_id);
      if (ev.thread_id && typeof ev.thread_id === 'string') return ev.thread_id;
      if (ev.session_id && typeof ev.session_id === 'string' && ev.type && /session|thread/i.test(String(ev.type))) {
        return ev.session_id;
      }
    } catch (_) { /* not a JSON event line */ }
  }
  return null;
}

function harvestCodexSummary(text) {
  let last = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const ev = JSON.parse(t);
      if (ev && ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message' && ev.item.text) {
        last = String(ev.item.text);
      }
    } catch (_) { /* not a JSON event line */ }
  }
  return last;
}

function consumeWorkerPipes(child, sink) {
  if (!sink || typeof sink !== 'object') return sink;
  if (typeof sink.out !== 'string') sink.out = '';
  if (typeof sink.err !== 'string') sink.err = '';
  if (typeof sink.head !== 'string') sink.head = '';
  const take = key => d => {
    sink[key] += d;
    if (sink[key].length > PIPE_CAP) sink[key] = sink[key].slice(-PIPE_CAP);
  };
  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => {
      take('out')(d);
      if (sink.head.length < HEAD_CAP) {
        sink.head += d;
        if (sink.head.length > HEAD_CAP) sink.head = sink.head.slice(0, HEAD_CAP);
      }
      if (!sink.sessionId) {
        const id = harvestCodexSessionId(sink.head);
        if (id) sink.sessionId = id;
      }
    });
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', take('err'));
  }
  return sink;
}

function waitChildStarted(child) {
  return new Promise(resolve => {
    let done = false;
    const finish = result => { if (done) return; done = true; resolve(result); };
    child.once('spawn', () => finish({ started: true }));
    child.once('error', err => finish({ started: false, error: err }));
  });
}

/** Attach close now. If the child already exited, Node will not replay 'close' — run immediately. */
function attachWorkerClose(child, onClose) {
  let done = false;
  const run = code => {
    if (done) return;
    done = true;
    try { onClose(code); } catch (_) { /* close path must not throw into spawn */ }
  };
  child.on('close', run);
  if (child.exitCode !== null || child.signalCode) run(child.exitCode);
}

function workerChildEnv(runtime, { sessionId, nativeId, env } = {}) {
  const childEnv = Object.assign({}, env || process.env, { HANDOFF_SESSION_ID: sessionId });
  if (runtime && runtime.id === 'claude-code') childEnv.CLAUDE_CODE_SESSION_ID = nativeId;
  else delete childEnv.CLAUDE_CODE_SESSION_ID;
  return childEnv;
}

/** Wait for Codex `--json` to publish thread.started. Does not wait for the job to finish. */
function waitForCodexSession(child, sink, timeoutMs) {
  const ms = timeoutMs == null ? 3000 : timeoutMs;
  return new Promise(resolve => {
    let done = false;
    let timer = null;
    const finish = result => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const currentId = () => (sink && sink.sessionId)
      || harvestCodexSessionId(sink && sink.head)
      || harvestCodexSessionId(sink && sink.out);
    const check = () => {
      const id = currentId();
      if (id) finish({ sessionId: id });
    };
    if (child.exitCode !== null || child.signalCode) {
      check();
      if (!done) finish({ sessionId: currentId(), exited: true, code: child.exitCode });
      return;
    }
    const onClose = code => {
      check();
      if (!done) finish({ sessionId: currentId(), exited: true, code });
    };
    if (child.stdout) child.stdout.on('data', check);
    child.once('close', onClose);
    timer = setTimeout(() => {
      check();
      if (!done) finish({ sessionId: currentId(), timeout: true });
    }, ms);
    check();
  });
}

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
  if (!runtime) return { kind: 'code', session_id: nativeId || null, cwd: dir, resume: null };
  if (runtime.id === 'claude-code') {
    return { kind: 'claude-code', session_id: nativeId, cwd: dir, resume: nativeId ? `claude --resume ${nativeId}` : null };
  }
  if (runtime.id === 'codex') {
    /* Resume uses Codex's OWN thread id (harvested from --json thread.started). A uuid we
     * invented and never passed to Codex is not a session, and `resume --last` is whoever
     * finished most recently on the machine — neither addresses THIS worker. */
    return {
      kind: 'codex',
      session_id: nativeId || null,
      cwd: dir,
      resume: nativeId ? `codex exec resume ${nativeId}` : null,
    };
  }
  return { kind: runtime.id, session_id: nativeId || null, cwd: dir, resume: null };
}

function destRuntimeId(dest) {
  if (dest && dest.worker_runtime) return dest.worker_runtime;
  if (dest && dest.native_ref && dest.native_ref.kind && dest.native_ref.kind !== 'code') {
    return dest.native_ref.kind;
  }
  return null;
}

/** Display name for return attribution. Codex/Gemini must not render as "Claude Code".
 * Null when there is no runtime/kind — caller falls back to NAMES[surface]. */
function destDisplayLabel(dest) {
  const id = destRuntimeId(dest);
  if (!id) return null;
  const row = CATALOG.find(r => r.id === id);
  return (row && row.label) || String(id);
}

/**
 * Headless argv prompt. Claude keeps the MCP close chain (get_handoff / return_to_origin).
 * Codex, Gemini, and any other dest have no those tools — they read HANDOFF.md, do the
 * work, and print a short summary on stdout. Mentions of mcp__handoff or
 * CLAUDE_CODE_SESSION_ID on a non-Claude dest send the worker chasing missing tools.
 */
function workerHeadlessPrompt({ runtime, sessionId, viaMcp } = {}) {
  const sid = sessionId || '';
  if (runtime && runtime.id === 'claude-code') {
    const mountNote = 'Prefer the LOCAL handoff mount (tools named mcp__handoff__*): it reaches the daemon over a unix socket. The mcp__claude_ai_Handoff_Remote__* tools are the same server over the network with a 10-second reply budget, and get_handoff on a large brief will time out there. Use the remote mount only if the local one is unavailable.';
    const closeNote = 'When the work is finished, call report_progress with your summary and THEN call return_to_origin to close the transaction — closing is your last act, not an optional courtesy. A transaction left open reads as unfinished work to everyone after you.';
    if (viaMcp) {
      return `Use the handoff MCP: call get_handoff with session_id "${sid}" to pull this session's context envelope — pass the id explicitly, do NOT rely on a pinned transaction, you do not have one. ${mountNote} Then continue the work from where it left off. ${closeNote}`;
    }
    return `Read HANDOFF.md and continue this session from where it left off. If the handoff MCP is available, call get_handoff with session_id "${sid}" for the full envelope (pass the id explicitly — you have no pinned transaction). ${mountNote} ${closeNote} Finish with a 2-3 sentence summary of what you did.`;
  }
  return 'Read HANDOFF.md, do the work it describes, then print a short summary of what you did on stdout. Do not wait for user input.';
}

function spawnArgv(runtime, { nativeId, prompt, allowedTools } = {}) {
  if (!runtime || !runtime.spawnKind) return null;
  if (runtime.spawnKind === 'claude') {
    const args = ['-p', '--session-id', nativeId, prompt, '--output-format', 'text'];
    if (allowedTools) args.push('--allowedTools', allowedTools);
    return { bin: runtime.binPath || 'claude', args };
  }
  if (runtime.spawnKind === 'codex') {
    /* Codex has no --session-id (clap rejects it; maintainers declined the flag). --json
     * publishes thread.started with the real thread_id; we harvest that and resume by it. */
    return {
      bin: runtime.binPath || 'codex',
      args: ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', prompt],
    };
  }
  return null;
}

module.exports = {
  CATALOG, probeDestRuntimes, pickDestRuntime, matchCatalog, nativeRefFor, spawnArgv, normalizeWant,
  WORKER_STDIO, workerSpawnOpts, consumeWorkerPipes, waitChildStarted, attachWorkerClose,
  workerHeadlessPrompt, harvestCodexSessionId, harvestCodexSummary, waitForCodexSession,
  workerChildEnv, destRuntimeId, destDisplayLabel,
};
