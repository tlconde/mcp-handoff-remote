/**
 * handoff-core — the context protocol, serverless.
 *
 * The MCP bridge (mcp-handoff.js) requires this directly: no daemon, no HTTP.
 * State lives in a shared file store (~/.claude-handoff/, override HANDOFF_HOME),
 * following Claude Code's own pattern (~/.claude/projects/) — separate bridge
 * processes (the Claude app's, each Claude Code's) share sessions through the
 * filesystem: load before every operation, atomic write after.
 *
 * server.js is a thin optional HTTP wrapper over handleApi() used ONLY to serve
 * the pitch mockup UI — the product never needs it running.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const HOME = process.env.HANDOFF_HOME || path.join(os.homedir(), '.claude-handoff');
const DATA = path.join(HOME, 'data.json');
const PREFS = path.join(HOME, 'prefs.json');
const OPS = path.join(HOME, 'ops.jsonl');
const FULL_THRESHOLD = parseInt(process.env.HANDOFF_FULL_THRESHOLD || '2500', 10);
const SURFACES = ['chat', 'cowork', 'design', 'code'];
const NAMES = { chat: 'Chat', cowork: 'Cowork', design: 'Design', code: 'Claude Code' };

/* ---------------- store (shared across processes via filesystem) ----------------
 *
 * v1: ONE FILE PER RECORD, path-versioned at store/v1/<collection>/<id>.json.
 *
 * The previous store was a single data.json rewritten whole on every save. Writes were
 * atomic (temp+rename) so files were never torn — but every save clobbered the entire
 * blob, so any process that had loaded before another saved silently erased that other
 * process's work. Measured 2026-08-07 with 12 concurrent writers against one store:
 * 5 survived, 7 were lost. With 9+ bridge processes sharing ~/.claude-handoff in normal
 * use, links could already be lost. That is the failure this layout removes: a save now
 * touches only the records THIS process changed, so concurrent writes to different
 * records cannot interfere. Same-record concurrent edits remain last-writer-wins, which
 * is inherent without locking but is a far smaller surface than "any write beats all".
 *
 * events.jsonl is append-only and records every create/update/delete, so state is
 * reconstructable even if a record file is later written wrong.
 *
 * The server keeps NO durable state of its own: db below is a cache rebuilt by load()
 * at the start of every operation. A server bug can therefore lose at most the record
 * it was editing — never the store.
 */
const STORE = path.join(HOME, 'store', 'v1');
const SCHEMA_VERSION = 1;
const COLLECTIONS = ['sessions', 'links'];
let db = { sessions: {}, links: {}, seq: 0 };
let snapshot = { sessions: {}, links: {} }; // id -> serialization as loaded (dirty tracking)

/* ULID: 48-bit ms timestamp + 80 bits randomness, Crockford base32. Lexicographically
 * sortable and time-ordered, and — unlike the old (++db.seq) counter — mintable without
 * reading shared state, so two processes can never race to the same id. */
const ULID_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(t) {
  let ts = t === undefined ? Date.now() : t, time = '';
  for (let i = 0; i < 10; i++) { time = ULID_CHARS[ts % 32] + time; ts = Math.floor(ts / 32); }
  const rnd = crypto.randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += ULID_CHARS[rnd[i] % 32];
  return time + rand;
}
function storeDirs() {
  for (const c of COLLECTIONS) fs.mkdirSync(path.join(STORE, c), { recursive: true });
}
function recordPath(c, rid) { return path.join(STORE, c, encodeURIComponent(rid) + '.json'); }
function writeRecord(c, rid, rec) {
  const p = recordPath(c, rid), tmp = p + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, p);
}
function appendEvent(e) {
  try {
    fs.mkdirSync(STORE, { recursive: true });
    fs.appendFileSync(path.join(STORE, 'events.jsonl'),
      JSON.stringify({ id: ulid(), ts: now(), pid: process.pid, ...e }) + '\n');
  } catch (_) {}
}
/* One-way, idempotent, and it never destroys the legacy file — data.json is kept as
 * data.json.pre-store-v1. After migration data.json is NOT maintained: a live mirror
 * that can go stale is a second source of truth, which is the A18 failure. */
function migrateIfNeeded() {
  if (fs.existsSync(path.join(STORE, 'meta.json'))) return false;
  storeDirs();
  let legacy = null;
  try { legacy = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (_) {}
  const counts = {};
  if (legacy) {
    try { fs.copyFileSync(DATA, DATA + '.pre-store-v1'); } catch (_) {}
    for (const c of COLLECTIONS) {
      const recs = legacy[c] || {};
      counts[c] = Object.keys(recs).length;
      for (const [rid, rec] of Object.entries(recs)) writeRecord(c, rid, rec);
    }
  }
  fs.writeFileSync(path.join(STORE, 'meta.json'), JSON.stringify({
    schema_version: SCHEMA_VERSION, created_at: now(),
    migrated_from: legacy ? 'data.json' : null, migrated_counts: counts
  }, null, 2));
  appendEvent({ kind: 'migrate', schema_version: SCHEMA_VERSION, counts });
  return true;
}
function load() {
  migrateIfNeeded();
  db = { sessions: {}, links: {}, seq: 0 };
  snapshot = { sessions: {}, links: {} };
  for (const c of COLLECTIONS) {
    let files = [];
    try { files = fs.readdirSync(path.join(STORE, c)); } catch (_) {}
    for (const f of files) {
      if (!f.endsWith('.json') || f.includes('.tmp.')) continue;
      try {
        const raw = fs.readFileSync(path.join(STORE, c, f), 'utf8');
        const rec = JSON.parse(raw);
        const rid = decodeURIComponent(f.slice(0, -5));
        db[c][rid] = rec;
        snapshot[c][rid] = JSON.stringify(rec, null, 2);
      } catch (_) { /* one unreadable record must never take down the store */ }
    }
  }
}
function save() {
  storeDirs();
  for (const c of COLLECTIONS) {
    const cur = db[c] || {};
    for (const [rid, rec] of Object.entries(cur)) {
      const s = JSON.stringify(rec, null, 2);
      if (snapshot[c][rid] === s) continue;                 // untouched — do not rewrite
      writeRecord(c, rid, rec);
      appendEvent({ kind: snapshot[c][rid] === undefined ? 'create' : 'update', collection: c, record: rid });
      snapshot[c][rid] = s;
    }
    for (const rid of Object.keys(snapshot[c])) {
      if (cur[rid] !== undefined) continue;
      try { fs.unlinkSync(recordPath(c, rid)); } catch (_) {}
      appendEvent({ kind: 'delete', collection: c, record: rid });
      delete snapshot[c][rid];
    }
  }
}
function id(prefix) { return prefix + '_' + ulid(); }
function now() { return new Date().toISOString(); }
function ops(event, data) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.appendFileSync(OPS, JSON.stringify({ ts: now(), event, ...data }) + '\n');
  } catch (_) {}
}

/* Standing user preferences. Deliberately NOT in data.json: that file is the protocol
 * store (sessions/links) and gets seeded, demoed and force-reset — a preference the user
 * set once must survive all of that. Separate file, same HANDOFF_HOME, so a scratch store
 * still gets scratch prefs. */
function getPrefs() {
  try { const p = JSON.parse(fs.readFileSync(PREFS, 'utf8')); return (p && typeof p === 'object') ? p : {}; }
  catch (_) { return {}; }
}
function setPref(key, value) {
  const p = getPrefs();
  if (value === null || value === undefined) delete p[key]; else p[key] = value;
  try {
    fs.mkdirSync(HOME, { recursive: true });
    const tmp = PREFS + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
    fs.renameSync(tmp, PREFS);
  } catch (_) {}
  return p;
}

/* Precedence, most specific first: this call's explicit choice → the user's standing
 * preference → the env escape hatch → off. Explicit false must be able to say "not this
 * one" without clearing the standing yes. */
function resolveAutosend(callValue, pref, env) {
  if (callValue === true) return { on: true, via: 'call' };
  if (callValue === false) return { on: false, via: 'call' };
  if (pref === true) return { on: true, via: 'pref' };
  if (pref === false) return { on: false, via: 'pref' };
  if (env === '1') return { on: true, via: 'env' };
  return { on: false, via: 'default' };
}

/* Auto-tracing: every round-trip lifecycle event (dispatch / worker_done / resolve)
 * generates a graded receipt automatically — traces ON by default, disable with
 * HANDOFF_NO_AUTORECEIPT=1 once confidence is earned. Fire-and-forget; never blocks
 * or fails the protocol operation itself. */
function autoReceipt() {
  if (process.env.HANDOFF_NO_AUTORECEIPT) return;
  try {
    const pkg = path.join(__dirname, 'mcp-roundtrip-evals');
    const script = path.join(pkg, 'scripts', 'receipt_from_ops.py');
    if (!fs.existsSync(script)) return;
    const child = spawn('python3', [script, pkg], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    child.on('error', () => {});
  } catch (_) {}
}

/* ---------------- environment probes ---------------- */
let _cli = null;
function claudeCliAvailable() {
  if (_cli !== null) return _cli;
  if (process.env.HANDOFF_NO_CLI) return (_cli = false);
  try { _cli = spawnSync('claude', ['--version'], { timeout: 5000 }).status === 0; }
  catch (_) { _cli = false; }
  return _cli;
}
let _mcpReg = null;
function mcpRegistered() {
  if (_mcpReg !== null) return _mcpReg;
  if (!claudeCliAvailable()) return (_mcpReg = false);
  try {
    const r = spawnSync('claude', ['mcp', 'list'], { timeout: 10000, encoding: 'utf8' });
    _mcpReg = r.status === 0 && /\bhandoff\b/.test(r.stdout || '');
  } catch (_) { _mcpReg = false; }
  return _mcpReg;
}

/* ---------------- compaction ---------------- */
const COMPACT_PROMPT = 'Compact this session into 2-3 sentences a successor agent needs. Preserve locked decisions verbatim.\n\n';
async function llmSummarize(text) {
  if (claudeCliAvailable()) {
    try {
      const r = spawnSync('claude', ['-p', COMPACT_PROMPT + text, '--output-format', 'text'], { timeout: 90000, encoding: 'utf8' });
      if (r.status === 0 && r.stdout && r.stdout.trim()) return r.stdout.trim();
    } catch (_) {}
  }
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content: COMPACT_PROMPT + text }] })
      });
      const j = await res.json();
      if (j.content && j.content[0]) return j.content[0].text.trim();
    } catch (_) {}
  }
  return null;
}
async function compact(session) {
  const msgs = session.messages.filter(m => m.role !== 'system' || m.kind === 'progress');
  const llm = await llmSummarize(msgs.map(m => `${m.role}: ${m.text}`).join('\n'));
  if (llm) return llm;
  const intent = msgs.find(m => m.role === 'user' && m.kind === 'chat');
  const progress = session.messages.filter(m => m.kind === 'progress').map(m => m.text);
  const parts = [];
  if (intent) parts.push(`Goal: ${intent.text.slice(0, 140)}`);
  if (session.decisions.length) parts.push(`Locked: ${session.decisions.map(d => d.text).join('; ')}`);
  if (progress.length) parts.push(`Progress: ${progress.join('; ')}`);
  parts.push(`(${msgs.length} messages compacted from ${NAMES[session.surface]})`);
  return parts.join(' · ');
}

/* ---------------- envelope & briefs ---------------- */
/** Normalize optional project_state. Relevance judgment belongs here: run-breakers
 *  (env file changed, migrate needed, port flip) travel as facts the receiver must
 *  know so local work won't fail mysteriously. Never put secret VALUES in run_breakers
 *  — names/paths/what-changed only (T10 / .env). */
function normalizeProjectState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  if (raw.project_id) out.project_id = String(raw.project_id);
  if (raw.index_hint) out.index_hint = String(raw.index_hint);
  if (raw.context_change) out.context_change = String(raw.context_change);
  if (Array.isArray(raw.progress) && raw.progress.length) out.progress = raw.progress.map(String);
  if (Array.isArray(raw.run_breakers) && raw.run_breakers.length) out.run_breakers = raw.run_breakers.map(String);
  if (raw.last_updated) out.last_updated = String(raw.last_updated);
  if (raw.sender_instance) out.sender_instance = String(raw.sender_instance);
  return Object.keys(out).length ? out : null;
}
function projectStateBlock(env) {
  const ps = env.project_state;
  if (!ps) return '';
  const L = ['## Project state (receiver: local workspace may differ)'];
  if (ps.project_id) L.push(`- Project: ${ps.project_id}`);
  if (ps.sender_instance) L.push(`- From instance: ${ps.sender_instance}`);
  if (ps.last_updated) L.push(`- Last updated (sender): ${ps.last_updated}`);
  if (ps.index_hint) L.push(`- Index / tip: ${ps.index_hint}`);
  if (ps.context_change) L.push(`- Main context change: ${ps.context_change}`);
  if (Array.isArray(ps.progress) && ps.progress.length) {
    L.push('- Progress:');
    for (const p of ps.progress) L.push(`  - ${p}`);
  }
  if (Array.isArray(ps.run_breakers) && ps.run_breakers.length) {
    L.push('- Run-breakers (will fail locally until addressed — names/paths only, no secret values):');
    for (const r of ps.run_breakers) L.push(`  - ${r}`);
  }
  return L.join('\n');
}
async function buildEnvelope(session) {
  const size = session.messages.reduce((n, m) => n + m.text.length, 0);
  const full = size <= FULL_THRESHOLD;
  return {
    session_id: session.id,
    origin: { surface: session.surface, title: session.title, deep_link: `/api/sessions/${session.id}` },
    context_mode: full ? 'full' : 'compacted',
    transcript: full ? session.messages : undefined,
    summary: full
      ? `Full context attached — ${session.messages.length} messages travel whole (${size} chars, under compaction threshold).`
      : await compact(session),
    decisions: session.decisions,
    artifacts: session.artifacts,
    open_items: session.open_items,
    project_state: normalizeProjectState(session.project_state),
    notes: session.notes || null,
    message_index: session.messages.map(m => m.id),
    created_at: now()
  };
}
function verbatimDecisions(env) { return env.decisions.map(d => `- "${d.text}"`).join('\n') || '- (none locked yet)'; }
function contextBlock(env) {
  if (env.context_mode === 'full' && env.transcript) {
    const lines = env.transcript.filter(x => x.kind !== 'handoff_card').map(x => `> ${x.role}: ${x.text}`);
    if (lines.length) return lines.join('\n');
  }
  return env.summary; // sparse sessions (cards only) fall back — never an empty section
}
/** Fence artifact bodies so inner ``` / ~~~ (e.g. GETTING-STARTED.md bash blocks)
 *  cannot close the outer fence early — looks like truncation in Design paste (t9b). */
function fencedBlock(content, info) {
  const text = String(content);
  let longest = 0;
  for (const m of text.matchAll(/(`{3,}|~{3,})/g)) longest = Math.max(longest, m[1].length);
  const n = Math.max(3, longest + 1);
  // Prefer backticks unless content forces a longer run; use tildes when backticks
  // would need an awkward length or content is backtick-heavy.
  const mark = (text.match(/`{3,}/) && !text.match(/~{3,}/)) ? '~'.repeat(n) : '`'.repeat(n);
  const label = (info != null && String(info).length) ? mark + info : mark;
  return `${label}\n${text}\n${mark}`;
}
/** Per-surface by-value budget for artifact bodies inside a brief. */
function artifactCap(target) {
  // By-reference only works when the receiver can dereference: Code has a filesystem,
  // app surfaces (chat/cowork/design) do NOT — for them, value-or-nothing. Found live
  // in trial t8 (Design) and again t17 (Chat): a file listed without content, or over
  // a too-small cap, became "by reference" and blocked review. Budgets: Code 1500
  // (path ok), Design 16000 (paste), chat/cowork 16000 (t17 raised from 6000 — a
  // ~20k HTML still overflows into queued inbox parts, never silent by-ref).
  // t21 Bug E: code's cap was 1500 because "Code has a filesystem, a path is fine". But
  // an artifact is {name, type, content} — there IS no path. Anything over 1500 rendered
  // "too large — by reference" pointing at a file that exists nowhere, while the bytes
  // sat in the same record. Parity at 16000, and over-cap is now truncated honestly.
  return 16000;
}
function artifactBlock(env, target) {
  const cap = artifactCap(target);
  const noFs = target !== 'code';
  return env.artifacts.map(a => {
    const fenceInfo = a.type === 'file' ? 'markdown' : (a.type || null);
    if (!a.content) {
      // t17: name-only attachments to chat looked "delivered" (path + byte size in
      // status) but the receiver could open nothing. Never soft-sell that as by-ref.
      if (noFs) {
        return `### ${a.name}\n**UNREACHABLE** — ${target} has no filesystem and this artifact has no inline content. ` +
          `Origin must resend with content by value (or split via send_message).`;
      }
      // Not "by reference" — there is no reference. Say what is actually true: a name
      // arrived and nothing else, so it only resolves if that path already exists here.
      return `- ${a.name} (${a.type || 'file'}) — NAME ONLY, no content was carried. ` +
        `It resolves only if that path already exists in this working tree; otherwise ask the origin to resend by value.`;
    }
    if (a.content.length <= cap) {
      return `### ${a.name}\n${fencedBlock(a.content, fenceInfo)}`;
    }
    // t21 Bug E — the bytes are HERE. A truncated body is a truncated body; announcing
    // it as absent sends the receiver to ask for a resend that renders identically, the
    // unbreakable loop behind t9/t9b. Never emit "by reference" for content we hold.
    return `### ${a.name} (content held IN FULL: ${a.content.length} chars — first ${cap} inline below, ` +
      `remainder queued as inbox continuation parts: check_inbox. Nothing is missing; do not ask for a resend.)\n` +
      fencedBlock(a.content.slice(0, cap), fenceInfo);
  }).join('\n');
}
function notesBlock(env) {
  const n = env.notes;
  if (!n) return '';
  const L = [];
  if (n.deadline) L.push(`## Deadline / urgency\n${n.deadline}`);
  if (Array.isArray(n.constraints) && n.constraints.length) L.push(`## Standing constraints & style rules (apply throughout)\n` + n.constraints.map(c => `- ${c}`).join('\n'));
  if (Array.isArray(n.entities) && n.entities.length) L.push(`## Key people & terms\n` + n.entities.map(e => `- ${e}`).join('\n'));
  if (Array.isArray(n.non_goals) && n.non_goals.length) L.push(`## Do NOT\n` + n.non_goals.map(g => `- ${g}`).join('\n'));
  if (n.expected_return) L.push(`## Return contract (what the origin expects back)\n${n.expected_return}`);
  return L.join('\n\n');
}
function buildBrief(target, env, session) {
  const from = session.origin_ref ? NAMES[session.origin_ref.surface] : NAMES[session.surface];
  const head = `Continued from ${from} — "${session.title}" (${env.created_at})` +
    (env.notes && env.notes.deadline ? ` · ⏰ ${env.notes.deadline}` : '');
  const ctx = contextBlock(env);
  const arts = artifactBlock(env, target);
  const extra = notesBlock(env);
  const pstate = projectStateBlock(env);
  if (target === 'code') return [
    `# Task brief — ${session.title}`, head,
    `## Goal`, env.open_items.length ? 'Complete the definition-of-done below, honoring every locked constraint.' : 'Continue the work described in Context.',
    `## Locked constraints (verbatim — do not re-litigate)`, verbatimDecisions(env),
    pstate,
    extra,
    `## Definition of done`, env.open_items.map(o => `- [ ] ${o}`).join('\n') || '- [ ] Confirm completion with the user',
    `## Context`, ctx,
    arts ? `## Artifacts\n${arts}` : '',
    `## On completion`, `Report via the handoff MCP: report_progress for checkpoints, /return-to-origin (return_to_origin tool) when finished.`
  ].filter(Boolean).join('\n\n');
  if (target === 'design') return [
    `# Design brief — ${session.title}`, head,
    `## Intent`, env.summary,
    `## Locked copy & decisions (use verbatim)`, verbatimDecisions(env),
    pstate,
    extra,
    `## Structure & style`, arts || '(derive from context)',
    `## Produce`, env.open_items.map(o => `- ${o}`).join('\n') || '- A first frame for review',
    `## Full context`, ctx
  ].filter(Boolean).join('\n\n');
  if (target === 'cowork') return [
    `# Work brief — ${session.title}`, head,
    `## Objective`, env.summary,
    `## Task checklist`, env.open_items.map(o => `- [ ] ${o}`).join('\n') || '- [ ] Derive tasks from context',
    `## Constraints`, verbatimDecisions(env),
    pstate,
    extra,
    arts ? `## Files\n${arts}` : '',
    `## Full context`, ctx
  ].filter(Boolean).join('\n\n');
  return [
    `# Continuation — ${session.title}`, head,
    `## Where things stand`, env.summary,
    `## Decisions so far`, verbatimDecisions(env),
    pstate,
    extra,
    `## Open questions / next`, env.open_items.map(o => `- ${o}`).join('\n') || '- Pick up the discussion',
    arts ? `## Attachments\n${arts}` : '',
    `## Transcript`, ctx
  ].filter(Boolean).join('\n\n');
}
function renderHandoffMd(env, session, target) {
  return buildBrief(target || 'code', env, session) +
    '\n\n---\nThe origin session stays resumable; your progress is carried back automatically.';
}

/* ---------------- domain ---------------- */
function createSession({ surface, title }) {
  const s = { id: id('sess'), surface, title: title || 'Untitled', created_at: now(), messages: [], decisions: [], artifacts: [], open_items: [], archived: false };
  db.sessions[s.id] = s;
  return s;
}
function addMessage(session, { role, text, reply_to = null, kind = 'chat', decision = false, from_session = null, sender_class = null }) {
  if (kind === 'receipt') {
    // Two-tier model (2026-08-08): a receipt is not a message, it is STATE on the send
    // record (read_at/read_in, set via the /state route). Refusing the kind at the only
    // write path makes receipt-of-receipt structurally unwritable — the ping-pong guard
    // the bridge used to carry is deleted, not relocated.
    const err = new Error('kind "receipt" is not writable: receipts are message state (read_at/read_in), never messages');
    err.status = 400; throw err;
  }
  if (reply_to && !session.messages.some(m => m.id === reply_to)) {
    const err = new Error('reply_to references unknown message id: ' + reply_to);
    err.status = 400; throw err;
  }
  const msg = { id: id('msg'), role, text, reply_to, kind, from_session, at: now() };
  // Provenance class (I12): verified (CLI uuid) | asserted (caller-named) | pinned | anonymous.
  // Only stamped when supplied, so existing records and non-xmsg kinds stay untouched.
  if (sender_class) msg.sender_class = sender_class;
  session.messages.push(msg);
  // Auto-lock heuristic applies ONLY to first-hand conversation ('chat' kind). Imported
  // transcripts, handoff cards and compaction summaries QUOTE decisions — re-extracting
  // from them promoted summary text to fake locked decisions (found live, trial t6).
  // PASTE PATH (t11): Design has no MCP, so its brief travels by paste and re-enters the
  // receiving surface as a first-hand 'chat' message the kind-guard can't see. Carriers
  // stamp distinctive markers; detect them at ingestion and suppress the auto-lock.
  // Failure direction is safe — a false positive merely doesn't auto-lock, and explicit
  // decision:true still locks regardless.
  const CARRIER_MARKERS = /Context from the conversation: |# Task brief — |# Design brief|# Work brief|## Locked constraints \(verbatim/;
  const pastedCarrier = kind === 'chat' && CARRIER_MARKERS.test(text);
  if (pastedCarrier && /\block\b|\bdecision:/i.test(text)) {
    ops('carrier_detected', { session: session.id, msg: msg.id, suppressed_autolock: true });
  }
  if (decision || (kind === 'chat' && !pastedCarrier && /\block\b|\bdecision:/i.test(text))) {
    session.decisions.push({ text: text.slice(0, 200), source_message: msg.id });
  }
  return msg;
}
function dedupeDecisions(sessions) {
  const seen = new Map(); const conflicts = [];
  for (const s of sessions) {
    if (!s) continue;
    for (const d of s.decisions) {
      const key = d.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').slice(0, 4).join(' ');
      if (seen.has(key) && seen.get(key).text !== d.text) conflicts.push({ a: seen.get(key), b: d, from: s.surface });
      else seen.set(key, d);
    }
  }
  return { merged: [...seen.values()], conflicts };
}
/* HANDOFF LIFECYCLE (user decision, 2026-08-05): a handoff is a TRANSACTION — a
 * handshake. Offer states: offered → completed (pick_up — the shake closes it) |
 * withdrawn (origin retracts) | declined (receiver refuses, reason travels back) |
 * superseded (origin re-sends the same work; the old offer closes pointing at the new).
 * No TTL: unshaken hands wait honestly. The OFFER dies at any terminal state; the
 * SESSION persists as the audit record (listable, messageable by title).
 * Links are PROMISSORY NOTES, not channels (World A): one opens only when a return is
 * owed — expected_return set, a pull (continue_from commits to report back), or a
 * worker dispatch. Link states: active (awaiting return) → resolved (returned) |
 * failed (honest blocker, closes the debt) | withdrawn/declined/superseded (offer died
 * first). ORPHANED is observational — computed from silence, never stored. */
async function continueIn(origin, toSurface, { include = [], archive_origin = false, return_leg } = {}) {
  const envelope = await buildEnvelope(origin);
  const included = [];
  for (const sid of include) {
    const s = db.sessions[sid];
    if (s && s.id !== origin.id) included.push(await buildEnvelope(s));
  }
  // SUPERSEDE: re-offering the same work to the same surface closes the older offer.
  // "Same work" = same origin session, OR same title from the same source surface
  // (send_to_surface mints a fresh origin per call, so a re-run /handoff would never
  // match by id alone). Kills the pick:"latest" hack at the root — pick_up never sees
  // stale duplicates.
  for (const old of Object.values(db.sessions)) {
    if (!old.origin_ref || old.surface !== toSurface || offerState(old) !== 'offered') continue;
    const sameOrigin = old.origin_ref.session_id === origin.id;
    const sameWork = old.title === origin.title && old.origin_ref.surface === origin.surface;
    if (sameOrigin || sameWork) {
      old.offer = 'superseded';
      closeOfferLink(old.id, 'superseded');
      ops('offer_superseded', { old: old.id, origin: origin.id, surface: toSurface, by_title: !sameOrigin });
    }
  }
  const dest = createSession({ surface: toSurface, title: origin.title });
  dest.origin_ref = { session_id: origin.id, surface: origin.surface };
  dest.offer = 'offered';
  dest.artifacts = [...origin.artifacts];
  dest.open_items = [...origin.open_items];
  if (origin.notes) dest.notes = origin.notes; // constraints/entities/non-goals/return-contract travel too
  if (origin.project_state) dest.project_state = normalizeProjectState(origin.project_state);
  dest.decisions = dedupeDecisions([origin, ...include.map(i => db.sessions[i]).filter(Boolean)]).merged;
  addMessage(dest, {
    role: 'system', kind: 'handoff_card', from_session: origin.id,
    text: `Continued from ${[origin, ...included.map(e => ({ surface: e.origin.surface }))].map(s => NAMES[s.surface] || s.surface).join(' + ')} — ${envelope.summary}`
  });
  const carrySources = [origin, ...include.map(i => db.sessions[i]).filter(Boolean)];
  for (const src of carrySources) {
    const srcEnv = src === origin ? envelope : included.find(e => e.session_id === src.id);
    if (srcEnv && srcEnv.context_mode === 'full') {
      for (const msg of src.messages) {
        if (msg.kind === 'handoff_card') continue;
        dest.messages.push({ id: id('msg'), role: msg.role, text: msg.text, reply_to: null, kind: 'imported', from_session: src.id, at: msg.at });
      }
    }
  }
  origin.archived = !!archive_origin;
  // World A: the link exists only when a return is OWED. Callers state it explicitly;
  // default true preserves continue-in round-trip semantics (pulls, workers, bare API).
  // send_to_surface passes return_leg: !!expected_return — a no-strings handoff's
  // handshake IS the whole transaction.
  const owed = return_leg !== false;
  let link = null;
  if (owed) {
    link = { id: id('link'), origin: origin.id, dest: dest.id, status: 'active', live_sync: false, created_at: now() };
    db.links[link.id] = link;
  }
  save();
  return { envelope, included, dest, link };
}
/* Deliver a full envelope into an EXISTING session (send_to existing path).
 * This is not a new offer/pick_up handshake — the destination already exists.
 * Links are still World A: open only when return_leg is owed. Without a return
 * leg this is a standalone carrier (context moves; no parent edge). */
async function deliverExisting(origin, dest, { return_leg } = {}) {
  if (!origin || !dest) {
    const err = new Error('origin and dest required');
    err.status = 400;
    throw err;
  }
  if (origin.id === dest.id) {
    const err = new Error('cannot deliver a handoff into its own origin session');
    err.status = 400;
    throw err;
  }
  const envelope = await buildEnvelope(origin);
  const brief = buildBrief(dest.surface, envelope, origin);
  // Refresh session-level carrier fields on EXISTING dest. Otherwise a superseding
  // deliver leaves stale dest.artifacts (t9b: Design kept the 8KB snapshot while the
  // newest xmsg held the current file) — anything that reads artifacts[] not the brief
  // builds from yesterday's copy.
  if (Array.isArray(origin.artifacts) && origin.artifacts.length) {
    dest.artifacts = origin.artifacts.map(a => (a && typeof a === 'object' ? { ...a } : a));
  }
  if (Array.isArray(origin.open_items)) dest.open_items = [...origin.open_items];
  if (origin.notes) dest.notes = origin.notes;
  if (origin.project_state) dest.project_state = normalizeProjectState(origin.project_state);
  addMessage(dest, {
    role: 'user',
    kind: 'xmsg',
    from_session: origin.id,
    text: `[handoff envelope from ${NAMES[origin.surface] || origin.surface} · "${origin.title}"]\n${brief}`
  });
  let link = null;
  const owed = !!return_leg;
  if (owed) {
    // One active return edge per dest: prior unpaid edges from older delivers close
    // as superseded so return_to_origin has a single unambiguous parent.
    for (const l of Object.values(db.links)) {
      if (l.dest === dest.id && l.status === 'active') l.status = 'superseded';
    }
    link = {
      id: id('link'), origin: origin.id, dest: dest.id, status: 'active',
      live_sync: false, created_at: now(), kind: 'existing_deliver'
    };
    db.links[link.id] = link;
    addMessage(dest, {
      role: 'system', kind: 'progress',
      text: `return owed to ${origin.surface} ("${origin.title}") — call return_to_origin when done`
    });
  } else {
    // Ephemeral carrier source with no return path — keep the store tidy.
    origin.archived = true;
  }
  ops('deliver_existing', {
    origin: origin.id, dest: dest.id, surface: dest.surface, return_owed: owed,
    brief_chars: (brief || '').length
  });
  autoReceipt(); // t20: delivery into an existing conversation is a run too
  save();
  return { envelope, dest, link, brief, return_owed: owed };
}
/* Does any LIVE native session answer to this uuid right now? The registry is the sole
 * authority on that, and it is read fresh — a stored copy would be exactly the cached
 * address the invariant forbids. Used to decide whether a record's binding is dead before
 * healing it onto a new process. Never throws; an unreadable registry means "unknown", and
 * unknown must not license a heal, so it returns true (leave the binding alone). */
/* SUCCESSOR LINKS — append-only record lineage (the user's ruling, 2026-08-09).
 * A terminal's records fragment: each /clear before the pid-heal minted a new one, so the
 * THREAD (52 messages) and the LIVE BINDING can end up in different records, and sends to
 * the thread find a binding that died and cannot heal (pre-fix records carry no pid).
 * The fix is NOT to rewrite the old record's binding. "Never manufacture an identity"
 * extends to "never REWRITE one": the history stays exactly where it happened, and we
 * relink DELIVERY only. The live record appends an adoption event; the old record gains
 * superseded_by. Resolution walks that chain at send time and then validates the final
 * record's binding live, as normal. Reversible (one event to annul), auditable, and the
 * provenance is honestly ASSERTED — attested thread continuity is a claim, not CLI-verified
 * (I12). Capped and cycle-checked, because a lineage that loops would hang a send. */
const SUCCESSOR_HOPS_MAX = 8;
function resolveSuccessor(id) {
  const via = [];
  const seen = new Set();
  let cur = id;
  for (let i = 0; i < SUCCESSOR_HOPS_MAX; i++) {
    const s = db.sessions[cur];
    if (!s || !s.superseded_by) break;
    if (seen.has(cur)) { ops('successor_cycle', { from: id, at: cur }); break; }
    seen.add(cur);
    const next = db.sessions[s.superseded_by];
    if (!next) break; // dangling successor: stay where we are rather than vanish
    via.push(cur);
    cur = s.superseded_by;
  }
  return { id: cur, via, hops: via.length };
}
function nativeUuidIsLive(uuid) {
  if (!uuid) return false;
  try {
    const os = require('os');
    const dir = process.env.HANDOFF_NATIVE_SESSIONS_DIR || path.join(os.homedir(), '.claude', 'sessions');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!r || r.sessionId !== uuid) continue;
        if (!r.pid) return true;
        try { process.kill(r.pid, 0); return true; } catch (e) { if (e.code === 'EPERM') return true; }
      } catch (_) { /* skip unreadable row */ }
    }
    return false;
  } catch (_) { return true; }
}
/* Offer-state helpers. THE DISCRIMINATOR IS THE CLAIM, NOT THE LINK'S SETTLEMENT.
 * An offer closes because a hand was shaken. How the resulting engagement later settled
 * — returned, or honestly failed — says nothing about whether the hand was shaken at all.
 * Reading "any settled link ⇒ completed" (the t21 shortcut) conflated the two and made an
 * UNCLAIMED offer whose link failed look completed: it left the supersedable pool, so a
 * re-send of the same work minted a second live offer instead of replacing the first
 * (reproduced live — the contract_mismatch cycle behind the A12/t16 receipt).
 * Claim evidence, in order of directness:
 *   1. claimed_at        — written by /claim, the handshake itself;
 *   2. the picked-up marker — a pre-lifecycle bridge claims by writing it without /claim;
 *   3. a RESOLVED link   — t21's real case: the dest worked the brief straight from the
 *      deep link and returned work. Returning IS engagement; only the dest can resolve.
 * A link that failed/withdrew/declined/superseded is NOT claim evidence: failed-unclaimed
 * is an honest blocker on a hand nobody shook — still pending, still supersedable. */
function claimEvidence(s) {
  if (s.claimed_at) return 'claim';
  if (s.messages.some(x => x.kind === 'progress' && /^picked up in /.test(x.text))) return 'marker';
  if (Object.values(db.links).some(l => l.dest === s.id && l.status === 'resolved')) return 'return';
  return null;
}
function offerState(s) {
  if (!s.origin_ref) return null;
  // Terminal states are authoritative — including 'completed' written by an older store.
  if (s.offer && s.offer !== 'offered') return s.offer;
  if (claimEvidence(s)) return 'completed';
  return s.offer || 'offered';
}
function closeOfferLink(destId, status) {
  for (const l of Object.values(db.links)) {
    if (l.dest === destId && l.status === 'active') l.status = status;
  }
}
/* t21 Bug B — offer flag and link status are two facts about ONE transaction, and they
 * used to be written independently. A dest that worked the brief straight from the deep
 * link never calls /claim, so `offer` stays 'offered' forever; when its link RESOLVED,
 * status still rendered the transaction as a pending handoff and pick_up still offered it
 * (Bug D). The return is the proof — not the settlement. Bug B's original wording ("a
 * settled link is proof the hand WAS shaken") over-reached to failed links too; a failure
 * on an unclaimed offer proves only that nobody got to it. So: settle only where claim
 * evidence exists, and say so out loud when it does not. */
function settleOffer(destId) {
  const dest = db.sessions[destId];
  if (!dest || !dest.origin_ref) return;
  const why = claimEvidence(dest);
  if (!why) {
    // Loud, not silent: the offer deliberately stays pending and supersedable.
    ops('offer_left_pending', { session: dest.id, surface: dest.surface, reason: 'link settled but offer was never claimed' });
    return;
  }
  if (!dest.offer || dest.offer === 'offered') dest.offer = 'completed';
}
async function pendingForOrigin(originId) {
  const out = [];
  for (const link of Object.values(db.links)) {
    if (link.origin !== originId || link.status !== 'active') continue;
    const dest = db.sessions[link.dest];
    if (!dest) continue;
    const progressed = dest.messages.some(m => m.kind === 'progress' || (m.role === 'user' && m.kind === 'chat'));
    if (progressed) out.push({ link_id: link.id, dest: { id: dest.id, surface: dest.surface }, summary: await compact(dest) });
  }
  return out;
}
/* t21 Bug C — the return leg had no artifact channel at all. A dest with no filesystem
 * (cowork, chat, Design) authors a document in-conversation and could only NAME it in the
 * summary; the bytes had nowhere to go, so the origin got a summary referencing a file
 * that existed nowhere. Returned artifacts land BY VALUE in origin.artifacts and as xmsg
 * messages, so check_inbox (the only verb that reads content) can hand them over. */
/* What the work IS, for a one-line worker label. Prefers the carried task/context over
 * whatever the first user message happened to be — decisions and gather cards are not
 * tasks, and a session that has neither still deserves its title over a wrong label. */
function taskLabel(origin) {
  const skip = new Set(['gather_card', 'handoff_card', 'resume_summary', 'progress']);
  const m = (origin.messages || []).find(x =>
    x.role === 'user' && !x.decision && !skip.has(x.kind) &&
    !/^Decision:/i.test(x.text || '') && (x.text || '').trim().length > 12
  );
  return String((m && m.text) || origin.title || 'untitled').slice(0, 160);
}
async function resolveLink(link, opts) {
  const origin = db.sessions[link.origin];
  const dest = db.sessions[link.dest];
  const summary = await compact(dest);
  const artifacts = ((opts && opts.artifacts) || []).filter(a => a && a.name && a.content);
  const msg = addMessage(origin, {
    role: 'assistant', kind: 'resume_summary', from_session: dest.id,
    text: `While you were away, ${NAMES[dest.surface]}: ${summary}` +
      (artifacts.length ? `\n\nReturned artifact(s), by value: ${artifacts.map(a => a.name).join(', ')} — read them with check_inbox.` : '')
  });
  if (artifacts.length) {
    const byName = new Map((origin.artifacts || []).map(a => [a.name, a]));
    for (const a of artifacts) {
      const art = { name: a.name, type: a.type || 'file', content: String(a.content) };
      byName.set(art.name, art);
      // Also on the dest, so the transaction record shows what actually crossed.
      dest.artifacts = [...new Map([...(dest.artifacts || []).map(x => [x.name, x]), [art.name, art]]).values()];
      addMessage(origin, {
        role: 'user', kind: 'xmsg', from_session: dest.id,
        text: `[returned artifact from ${NAMES[dest.surface]}] ${art.name} BY VALUE\n\n${art.content}`
      });
    }
    origin.artifacts = [...byName.values()];
  }
  link.status = 'resolved'; link.resolved_at = now();
  settleOffer(dest.id); // Bug B: a returned transaction is never also a pending offer
  save();
  ops('resolve', {
    link: link.id, origin: origin.id, dest: dest.id,
    summary_excerpt: summary.slice(0, 200),
    artifacts_returned: artifacts.map(a => ({ name: a.name, bytes: String(a.content).length }))
  });
  autoReceipt();
  return { summary, message: msg, artifacts_returned: artifacts.map(a => a.name) };
}
async function gather(toSurface, fromIds) {
  const sources = fromIds.map(sid => db.sessions[sid]).filter(Boolean);
  if (!sources.length) { const e = new Error('no valid source sessions'); e.status = 400; throw e; }
  const envelopes = [];
  for (const s of sources) envelopes.push(await buildEnvelope(s));
  const { merged, conflicts } = dedupeDecisions(sources);
  const dest = createSession({ surface: toSurface, title: sources[0].title + ' (gathered)' });
  dest.decisions = merged;
  dest.artifacts = [...new Map(sources.flatMap(s => s.artifacts).map(a => [a.name, a])).values()];
  dest.open_items = sources.flatMap(s => s.open_items);
  addMessage(dest, {
    role: 'system', kind: 'gather_card',
    text: `Gathered context from ${sources.map(s => NAMES[s.surface]).join(' + ')}. ` +
      envelopes.map(e => `[${NAMES[e.origin.surface]}] ${e.summary}`).join(' | ') +
      (conflicts.length ? ` ⚠ ${conflicts.length} conflict(s) need your call.` : '')
  });
  for (const s of sources) {
    // status 'gathered', NOT 'active'. A gather link records PROVENANCE — which sessions
    // fed this one — and nothing owes anything back: no verb resolves a gather link, so
    // 'active' meant a debt that could never be paid. Three of the four orphaned workers
    // in the live store on 2026-08-07 were one archived demo gather, aging forever.
    const link = { id: id('link'), origin: s.id, dest: dest.id, status: 'gathered', live_sync: false, created_at: now() };
    db.links[link.id] = link;
  }
  save();
  return { dest, envelopes, conflicts };
}

/* ---------------- launch (headless / ide) ---------------- */
async function doLaunch(s, b) {
  const dir = b.dir || process.cwd();
  if (!fs.existsSync(dir)) return { code: 400, payload: { error: 'dir does not exist: ' + dir } };
  const mode = b.mode || process.env.HANDOFF_LAUNCH_MODE || 'headless';
  const nativeId = crypto.randomUUID();
  s.native_ref = { kind: 'claude-code', session_id: nativeId, cwd: dir, resume: `claude --resume ${nativeId}` };
  save();
  try {
    const cmdDir = path.join(dir, '.claude', 'commands');
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(path.join(cmdDir, 'return-to-origin.md'),
      '---\ndescription: Send this session back to its origin surface in the Claude app, with a summary\n---\n' +
      'Call the handoff MCP tool `return_to_origin` with a 2-3 sentence summary of what was accomplished, ' +
      'the current state, and any open questions. After the tool confirms, tell the user the session has been returned to its origin and stop working.\n');
    fs.writeFileSync(path.join(cmdDir, 'continue-from.md'),
      '---\ndescription: Pull a session from the Claude app (chat/cowork/design) into THIS Claude Code session\n---\n' +
      'Call the handoff MCP tool `continue_from` with the surface named in $ARGUMENTS (default: chat). ' +
      'It hands the latest session from that surface to this one and returns a task brief — read it and continue the work. Report back via report_progress / return_to_origin.\n');
  } catch (e) { /* command files are best-effort */ }
  const viaMcp = mcpRegistered();
  let fp = null;
  if (viaMcp) {
    try {
      const stale = path.join(dir, 'HANDOFF.md');
      if (fs.existsSync(stale) && fs.readFileSync(stale, 'utf8').startsWith('# ')) {
        const head = fs.readFileSync(stale, 'utf8').split('\n')[0];
        if (/^# (Handoff|Task brief|Design brief|Work brief|Continuation) —/.test(head)) fs.unlinkSync(stale);
      }
    } catch (_) {}
  } else {
    const env2 = await buildEnvelope(s);
    fp = path.join(dir, 'HANDOFF.md');
    fs.writeFileSync(fp, renderHandoffMd(env2, s, 'code'));
  }
  const PROMPT = viaMcp
    ? "Use the handoff MCP: call get_handoff to pull this session's context envelope, continue the work from where it left off, and call report_progress with a summary when done."
    : 'Read HANDOFF.md and continue this session from where it left off. If the handoff MCP is available, call report_progress when done. Finish with a 2-3 sentence summary of what you did.';
  const command = `cd ${JSON.stringify(dir)} && claude --session-id ${nativeId} ${JSON.stringify(PROMPT)}`;
  if (!claudeCliAvailable()) {
    const env2 = await buildEnvelope(s);
    fp = path.join(dir, 'HANDOFF.md');
    fs.writeFileSync(fp, renderHandoffMd(env2, s, 'code'));
    return { code: 200, payload: { launched: false, mode, transport: 'file', reason: 'claude CLI not found on this machine', path: fp, command, native_ref: s.native_ref } };
  }
  if (mode === 'ide') {
    const ideCmd = [b.ide || process.env.HANDOFF_IDE || 'cursor', 'code']
      .find(c => { try { return spawnSync('which', [c], { timeout: 3000 }).status === 0; } catch (_) { return false; } });
    if (!ideCmd) return { code: 200, payload: { launched: false, mode, reason: 'no IDE command found (tried cursor, code)', path: fp, command, native_ref: s.native_ref } };
    const tasksDir = path.join(dir, '.vscode');
    const tasksFile = path.join(tasksDir, 'tasks.json');
    const LABEL = 'Continue handoff (Claude Code)';
    let tasksObj = { version: '2.0.0', tasks: [] };
    let writable = true;
    if (fs.existsSync(tasksFile)) {
      try { tasksObj = JSON.parse(fs.readFileSync(tasksFile, 'utf8')); tasksObj.tasks = (tasksObj.tasks || []).filter(t => t.label !== LABEL); }
      catch (_) { writable = false; }
    }
    let taskNote;
    if (writable) {
      tasksObj.tasks.push({
        label: LABEL, type: 'shell',
        command: `claude --session-id ${nativeId} ${JSON.stringify(PROMPT)}`,
        options: { env: { HANDOFF_SESSION_ID: s.id } },
        runOptions: { runOn: 'folderOpen', instanceLimit: 2 },
        presentation: { reveal: 'always', focus: true, panel: 'dedicated' },
        group: { kind: 'build', isDefault: true }
      });
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(tasksFile, JSON.stringify(tasksObj, null, 2));
      taskNote = 'task refreshed — runs on folder open (allow automatic tasks once), or hit Shift+Cmd+B';
    } else taskNote = 'your .vscode/tasks.json is not plain JSON — run claude manually in the IDE terminal';
    const ideArgs = fp ? ['-n', dir, fp] : ['-n', dir];
    const child = spawn(ideCmd, ideArgs, { detached: true, stdio: 'ignore' });
    child.unref();
    child.on('error', () => {});
    ops('launch', { session: s.id, mode: 'ide', transport: viaMcp ? 'mcp' : 'file', ide: ideCmd, native: nativeId, launched: true });
    return { code: 202, payload: { launched: true, mode, transport: viaMcp ? 'mcp' : 'file', ide: ideCmd, path: fp, session: s.id, note: taskNote, native_ref: s.native_ref } };
  }
  const ALLOWED = process.env.HANDOFF_ALLOWED_TOOLS ||
    'Read,Write,Edit,Glob,Grep,Bash,mcp__handoff__get_handoff,mcp__handoff__get_decisions,mcp__handoff__report_progress,mcp__handoff__return_to_origin';
  const child = spawn('claude', ['-p', '--session-id', nativeId, PROMPT, '--output-format', 'text', '--allowedTools', ALLOWED],
    { cwd: dir, env: { ...process.env, HANDOFF_SESSION_ID: s.id } });
  let out = '';
  child.stdout.on('data', d => { out += d; if (out.length > 20000) out = out.slice(-20000); });
  const startedAt = Date.now();
  child.on('close', (code2) => {
    load(); // another process may have written meanwhile
    const s2 = db.sessions[s.id];
    const summary = (out.trim().split('\n').filter(Boolean).slice(-6).join(' ') || 'CLI session finished with no output').slice(0, 600);
    if (s2) { addMessage(s2, { role: 'system', kind: 'progress', text: `[auto CLI] ${summary}` }); save(); }
    ops('worker_done', { session: s.id, native: nativeId, exit: code2, secs: Math.round((Date.now() - startedAt) / 1000), summary_excerpt: summary.slice(0, 200) });
    autoReceipt();
  });
  child.on('error', () => {});
  ops('launch', { session: s.id, mode: 'headless', transport: viaMcp ? 'mcp' : 'file', native: nativeId, launched: true });
  return { code: 202, payload: { launched: true, mode: 'headless', transport: viaMcp ? 'mcp' : 'file', path: fp, session: s.id, native_ref: s.native_ref } };
}

/* ---------------- demo seed (pitch UI only) ---------------- */
async function seed(force) {
  // Force-seed is destructive. The live product store may only be force-seeded when the
  // caller EXPLICITLY chose a store via HANDOFF_HOME (tests/demos always do; trial t10:
  // a test run without it wiped real user sessions).
  if (force && !process.env.HANDOFF_HOME) {
    const e = new Error('refusing to force-seed the live product store — set HANDOFF_HOME to a scratch/demo dir first');
    e.status = 403; throw e;
  }
  if (!force && Object.keys(db.sessions).length) return demoState();
  db = { sessions: {}, links: {}, seq: 0 };
  const chat = createSession({ surface: 'chat', title: 'Landing page redesign' });
  addMessage(chat, { role: 'user', text: 'I want to redesign our landing page — warmer, more editorial. Hero, 3 feature cards, single CTA.' });
  addMessage(chat, { role: 'assistant', text: "Great direction. I'd go serif display headline, cream background, one coral CTA. I drafted the copy and structure:" });
  addMessage(chat, { role: 'user', text: 'Love it. Lock the copy — “Meet your thinking partner” as the H1.', decision: true });
  addMessage(chat, { role: 'assistant', text: "Locked. Hand it off whenever you're ready — the whole context comes with it." });
  chat.artifacts = [
    { name: 'hero-copy.md', type: 'file', content: '# Hero copy (locked)\n\nH1: Meet your thinking partner\n\nLede: Warmer, editorial. One idea per line. Claude helps you think, not just answer.\n\nCTA label: Get started' },
    { name: 'structure.md', type: 'file', content: '# Page structure\n\n1. Hero — serif display H1, short lede, single coral CTA\n2. Three feature cards — editorial, hairline rules, no boxes\n3. Closing — deeper cream band, restate CTA\n\nPalette: cream background, coral accent, serif display / sans body' }
  ];
  chat.open_items = ['Produce visual mockup', 'Build page & deploy preview'];
  const design = createSession({ surface: 'design', title: 'Landing page redesign' });
  addMessage(design, { role: 'system', kind: 'progress', text: 'Frame 1 generated: hero, CTA, 3 feature cards' });
  design.artifacts = [{ name: 'Frame 1 · Landing/Hero', type: 'frame' }];
  const cowork = createSession({ surface: 'cowork', title: 'Landing page redesign' });
  addMessage(cowork, { role: 'system', kind: 'progress', text: 'landing-brief.md generated; 2 of 4 tasks done' });
  cowork.artifacts = [{ name: 'landing-brief.md', type: 'file' }];
  cowork.open_items = ['Produce visual mockup', 'Build page & deploy preview'];
  const code = createSession({ surface: 'code', title: 'acme-web · landing scaffold' });
  addMessage(code, { role: 'system', kind: 'progress', text: 'scaffolded landing.tsx, 3 files changed, tests passing, preview on localhost:3000' });
  code.artifacts = [{ name: 'landing.tsx', type: 'diff' }];
  save();
  return demoState();
}
function demoState() {
  const bySurface = {};
  for (const s of Object.values(db.sessions)) if (!s.archived) bySurface[s.surface] = s;
  return { by_surface: Object.fromEntries(Object.entries(bySurface).map(([k, v]) => [k, v.id])), sessions: db.sessions, links: db.links };
}

/* ---------------- API (transport-agnostic: MCP calls this in-process;
 *                  server.js wraps it in HTTP for the pitch UI only) ---------------- */
async function handleApi(method, p, query, b) {
  load(); // fresh view of the shared store on every operation
  b = b || {};
  query = query || {};
  let m;
  try {
    if (method === 'GET' && p === '/api/health') return { code: 200, payload: { ok: true, sessions: Object.keys(db.sessions).length, store: HOME } };
    if (method === 'POST' && p === '/api/seed') return { code: 200, payload: await seed(!!b.force) };
    if (method === 'GET' && p === '/api/state') return { code: 200, payload: demoState() };
    /* THE REMOTE DOOR — a DIFFERENT door with a different key, not a hole punched in the local one.
     *
     * /api/register mints from a CLI transcript uuid, and refuses without one. That refusal is
     * correct: a local record keyed to nothing is an anonymous session wearing a name. But a
     * device reaching the store over the authenticated relay is not anonymous and not local. It
     * holds an ACCOUNT, verified by the tunnel; it simply has no process on THIS machine, and
     * never will. Measured 2026-08-09: a session named on a second laptop produced no record at
     * all, so it was invisible from here and unaddressable — the store could be read from that
     * device and not written to by it.
     *
     * What this mints, and what it deliberately does NOT claim:
     *   - status 'asserted' with attested_by 'access'. NOT a third door status: a status earns
     *     existence only if consumers authorize differently on it, and none do. The attestation
     *     is transport provenance ("arrived through the authenticated tunnel as this account"),
     *     which is a different axis from how much native vouches for a session.
     *   - native_ref STAYS NULL. A record does not know it has a live process; the owning host's
     *     agent binds that later. Faking it here would be this codebase's oldest bug — a stored
     *     address nobody validated.
     *   - NO liveness claim and NO transport claim. Reachability is the owning agent's runtime
     *     assertion (peek reads it from the heartbeat), and how a record gets woken is the
     *     transport registry's decision at delivery time. Baking either in would survive exactly
     *     until the first transport swap the seam exists to allow.
     *
     * Idempotent on (host, title): a device re-registering on reconnect UPDATES its record rather
     * than minting a second one. That reuses the store's existing same-title discrimination
     * instead of adding a second dedup mechanism with its own edge cases. */
    if (method === 'POST' && p === '/api/register-remote') {
      if (!b.host) return { code: 400, payload: { error: 'host required — a device record that cannot name its device is unaddressable and undedupable' } };
      if (!b.title) return { code: 400, payload: { error: 'title required — the whole point of the record is that a human can address it by name' } };
      const host = String(b.host);
      let s = Object.values(db.sessions).find(x =>
        !x.archived && x.remote && x.remote.host === host && x.title === b.title);
      const minted = !s;
      if (!s) { s = createSession({ surface: 'code', title: b.title }); }
      s.title = b.title;
      if (b.role !== undefined) s.role = b.role || null;
      s.native_ref = null; // never asserted here; the owning host's agent claims it
      s.remote = {
        host,
        attested_by: b.attested_by || 'access',
        account_sub: b.account_sub || null,
        /* PROVENANCE, because these are different facts and only one of them is the device
         * speaking for itself. A first record minted FROM another machine on the device's behalf
         * is legitimate — a record is data — but it must never be mistaken later for one the
         * device's own agent wrote. */
        minted_by: b.minted_by || 'unknown',
        last_registered: now(),
      };
      ops('remote_session_registered', { session: s.id, host, title: b.title, minted, minted_by: s.remote.minted_by });
      save(db);
      return { code: minted ? 201 : 200, payload: { session: s, minted } };
    }

    if (method === 'POST' && p === '/api/register') {
      // Identity minting (I2, t24 addendum): a terminal session joins the protocol under
      // its OWN record, keyed to the CLI transcript uuid, instead of borrowing whichever
      // record happened to sit at by_surface.code — the borrowed sess_6ic0ed9c that put
      // wrong from_session on real messages and would have misrouted their receipts.
      // Idempotent upsert: first contact mints; every contact refreshes the handle facts
      // (cwd, last_seen) that candidate lists discriminate by. Role/lane label ("build",
      // "flow tests", "ux") is how three sessions in one repo stay tellable apart.
      if (!b.native_id) return { code: 400, payload: { error: 'native_id required — an identity record without the CLI uuid is just another anonymous session' } };
      let s = Object.values(db.sessions).find(x =>
        x.native_ref && x.native_ref.kind === 'claude-code' && x.native_ref.session_id === b.native_id && !x.archived);
      /* SELF-HEALING BINDING. The uuid is the terminal's CURRENT address, not its identity:
       * a resume forks a new one under the same conversation and leaves no lineage, so a
       * lookup by uuid alone finds nothing and mints a SECOND record for a terminal that
       * already has one — which is how a live session ends up with a record no one reads.
       * The record therefore keeps the binding (uuid + pid + cwd) as a refreshable ATTRIBUTE
       * and heals it on contact — but ONLY where the match is unambiguous BY CONSTRUCTION:
       * the same CLI PROCESS reporting a new uuid, which is exactly what /clear does (the
       * process survives, the transcript forks). pid identifies the terminal precisely.
       *
       * There is deliberately NO "sole record in this cwd" heal. It looks safe and is not:
       * nothing distinguishes a RESUMED terminal from a BRAND-NEW one started in the same
       * folder, so a new session would silently adopt a dead one's record — inheriting its
       * pins, its history and any transaction still owed to it. Wrong identity is worse than
       * no identity. Across a real quit + `claude --resume` the pid is gone too, and native
       * exposes no lineage (parentUuid null), so from inside the process the terminal is
       * genuinely unknowable: it mints a fresh record and the durable id in the SessionStart
       * sidecar is what re-joins it. That is why the sidecar is load-bearing, not decorative. */
      let healed = null;
      if (!s && b.pid && b.cwd) {
        const byPid = Object.values(db.sessions).filter(x =>
          x.native_ref && x.native_ref.kind === 'claude-code' && !x.archived &&
          x.native_ref.cwd === b.cwd && x.native_ref.pid === b.pid);
        if (byPid.length === 1 && !nativeUuidIsLive(byPid[0].native_ref.session_id)) {
          s = byPid[0];
          healed = { from: s.native_ref.session_id, to: b.native_id, by: 'pid' };
          s.native_ref.session_id = b.native_id;
          s.native_ref.resume = `claude --resume ${b.native_id}`;
        }
      }
      // refresh_only: the per-contact binding touch. It REFRESHES a binding and never mints
      // one — implicit bookkeeping must not manufacture an identity, exactly as the registry
      // corrects an identity but never invents one. Minting stays with the explicit verbs
      // (register_session, or a send that needs a verified sender), so the first
      // register_session still honestly reports "Registered" rather than "Refreshed".
      if (!s && b.refresh_only) return { code: 200, payload: { id: null, minted: false, healed, refreshed: false } };
      const minted = !s;
      if (!s) {
        // Name unification: native name is the display handle. On mint, an explicit protocol
        // title wins (it becomes the alias), else the native name, else the old fallback.
        const title = b.title || b.native_name || ('terminal · ' + (b.cwd ? path.basename(b.cwd) : String(b.native_id).slice(0, 8)));
        s = createSession({ surface: 'code', title });
        s.native_ref = { kind: 'claude-code', session_id: b.native_id, cwd: b.cwd || null, resume: `claude --resume ${b.native_id}` };
      }
      if (b.cwd) s.native_ref.cwd = b.cwd;
      // pid is a refreshable ATTRIBUTE of the binding, never the identity — it is what lets a
      // /clear (same process, forked transcript) heal without guessing.
      if (b.pid) s.native_ref.pid = b.pid;
      // Adopt native's registration facts — read, never minted (identity convergence).
      if (b.native_name) s.native_ref.name = b.native_name;
      if (b.messaging_socket) s.native_ref.messaging_socket_path = b.messaging_socket;
      // An explicit protocol title is the alias and still overrides display; without one,
      // keep the display in sync with native's name so the two layers never diverge.
      /* NAME ROT — §I2b at the naming layer. Native `name` is nameSource:"derived" and
       * changes per PROCESS: across one resume, a single record (uuid unchanged) had its
       * title rewritten d1 → d9 because the title followed the derived name. An addressable
       * handle that changes with the process is a process-scoped address wearing a title's
       * clothes. So the native name is a DISPLAY HINT, refreshed on native_ref.name like the
       * rest of the binding — it may NAME a record at mint, and never rename one afterwards.
       * Addressing is record-id-first regardless; titles are for humans to read. */
      if (b.title) s.title = String(b.title).slice(0, 120);
      else if (b.native_name && minted && !s._title_explicit) s.title = String(b.native_name).slice(0, 120);
      if (b.title) s._title_explicit = true;
      if (b.role !== undefined) s.role = b.role ? String(b.role).slice(0, 40) : null;
      s.last_seen = now();
      /* ADOPTION (explicit only). The caller names a predecessor id it already holds — from
       * its own thread, which is the one continuity that survives a process boundary. This
       * is never inferred and the tooling never suggests candidates: suggesting one would be
       * the guess §I2b forbids, wearing a helpful face. Append-only on both sides. */
      if (b.succeeds && b.succeeds !== s.id) {
        const pred = db.sessions[b.succeeds];
        if (!pred) return { code: 404, payload: { error: `no record ${b.succeeds} to succeed — nothing was changed` } };
        // A cycle would hang every send through this chain: refuse rather than create one.
        if (resolveSuccessor(s.id).id === pred.id || pred.id === s.id) {
          return { code: 409, payload: { error: 'that adoption would create a successor cycle — nothing was changed' } };
        }
        if (pred.superseded_by && pred.superseded_by !== s.id) {
          return { code: 409, payload: { error: `${pred.id} is already superseded by ${pred.superseded_by} — annul that first` } };
        }
        pred.superseded_by = s.id;
        s.succeeds = Array.isArray(s.succeeds) ? s.succeeds : [];
        if (!s.succeeds.some(a => a.session_id === pred.id)) {
          s.succeeds.push({
            session_id: pred.id, title: pred.title, at: now(),
            evidence: String(b.adoption_evidence || 'attested thread continuity held in the adopting session\'s context').slice(0, 300),
            provenance: 'asserted' // I12: a claim by the claimant, not CLI-verified
          });
        }
        ops('record_adopted', { successor: s.id, predecessor: pred.id, predecessor_title: pred.title, provenance: 'asserted' });
      }
      ops('session_registered', { session: s.id, native: b.native_id, minted, cwd: b.cwd || null, role: s.role || null });
      // Loud, never swallowed: a moved identity pointer is reported to the ops log and back
      // to the caller, so a heal is something you can see happen rather than infer.
      if (healed) ops('identity_healed', { session: s.id, from: healed.from, to: healed.to, by: healed.by, pid: b.pid || null });
      save();
      return { code: minted ? 201 : 200, payload: { id: s.id, minted, healed, session: s } };
    }
    if (method === 'POST' && p === '/api/sessions') {
      if (!SURFACES.includes(b.surface)) return { code: 400, payload: { error: 'surface must be one of ' + SURFACES } };
      const s = createSession(b);
      if (Array.isArray(b.open_items)) s.open_items = b.open_items.map(String);
      if (Array.isArray(b.artifacts)) s.artifacts = b.artifacts;
      if (b.notes && typeof b.notes === 'object') s.notes = b.notes; // constraints, entities, non_goals, expected_return, deadline
      const ps = normalizeProjectState(b.project_state);
      if (ps) s.project_state = ps;
      save(); return { code: 201, payload: s };
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)$/)) && method === 'GET') {
      const s = db.sessions[m[1]]; return s ? { code: 200, payload: s } : { code: 404, payload: { error: 'not found' } };
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/messages$/)) && method === 'POST') {
      const s = db.sessions[m[1]]; if (!s) return { code: 404, payload: { error: 'not found' } };
      // Loop safety on the peer-message path, numbers aligned to native cross-session
      // messaging (native-first rule, 2026-08-08). Native publishes the 50-accepted cap;
      // its identical-drop window and per-sender rate are unpublished, so ours are chosen
      // and documented here: identical repeat within 60s → refused; >10 msgs from one
      // sender within 60s → refused. Refusal mirrors native "refused": dropped loud at
      // the API (our sender is synchronous, so loud beats native's silent drop).
      if (b && b.kind === 'xmsg') {
        const cutoff = Date.now() - 60 * 1000;
        const recent = s.messages.filter(x => x.kind === 'xmsg' && Date.parse(x.at) > cutoff);
        if (recent.some(x => x.text === b.text && (x.from_session || null) === (b.from_session || null)))
          return { code: 429, payload: { error: 'refused: identical repeat within 60s (loop safety, native-aligned)' } };
        if (b.from_session && recent.filter(x => x.from_session === b.from_session).length >= 10)
          return { code: 429, payload: { error: 'refused: sender rate limit, 10 messages / 60s (loop safety, native-aligned)' } };
        const lastCheck = s.messages.map((x, i) => (x.kind === 'progress' && /^inbox checked/.test(x.text)) ? i : -1)
          .reduce((a2, b2) => Math.max(a2, b2), -1);
        const waiting = s.messages.filter((x, i) => i > lastCheck && (x.kind === 'xmsg' || x.kind === 'resume_summary')).length;
        if (waiting >= 50)
          return { code: 429, payload: { error: 'refused: 50 accepted messages already waiting unread on this conversation (native cap)' } };
      }
      const msg = addMessage(s, b); save();
      if (msg.kind === 'progress') ops('progress', { session: s.id, excerpt: msg.text.slice(0, 200) });
      return { code: 201, payload: msg };
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/messages\/([^/]+)\/state$/)) && method === 'POST') {
      // Ambient tier: receipt state lives ON the send record. read_in stamps delivery
      // (drain calls it), settle stamps shown-once (status calls it after rendering).
      const s = db.sessions[m[1]]; if (!s) return { code: 404, payload: { error: 'not found' } };
      const msg = s.messages.find(x => x.id === m[2]); if (!msg) return { code: 404, payload: { error: 'message not found' } };
      if (b && b.read_in) { msg.read_at = msg.read_at || now(); msg.read_in = { surface: b.read_in.surface, title: b.read_in.title }; }
      if (b && b.settle) msg.settled_at = now();
      save();
      return { code: 200, payload: msg };
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/envelope$/)) && method === 'GET') {
      const s = db.sessions[m[1]]; if (!s) return { code: 404, payload: { error: 'not found' } };
      return { code: 200, payload: await buildEnvelope(s) };
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/brief$/)) && method === 'GET') {
      const s = db.sessions[m[1]]; if (!s) return { code: 404, payload: { error: 'not found' } };
      const target = query.for || 'code';
      if (!SURFACES.includes(target)) return { code: 400, payload: { error: 'for must be one of ' + SURFACES } };
      return { code: 200, payload: { for: target, brief: buildBrief(target, await buildEnvelope(s), s) } };
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/continue$/)) && method === 'POST') {
      const s = db.sessions[m[1]]; if (!s) return { code: 404, payload: { error: 'not found' } };
      if (!SURFACES.includes(b.to)) return { code: 400, payload: { error: 'to must be one of ' + SURFACES } };
      return { code: 201, payload: await continueIn(s, b.to, b) };
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/deliver$/)) && method === 'POST') {
      // send_to → EXISTING: full envelope into dest inbox; optional return link.
      const origin = db.sessions[m[1]]; if (!origin) return { code: 404, payload: { error: 'origin not found' } };
      const dest = db.sessions[b.dest]; if (!dest) return { code: 404, payload: { error: 'dest not found' } };
      if (dest.archived) return { code: 409, payload: { error: 'dest is archived — unarchive it or choose another title' } };
      return { code: 201, payload: await deliverExisting(origin, dest, b) };
    }
    /* ---- handoff transaction routes (handshake lifecycle) ---- */
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/claim$/)) && method === 'POST') {
      // The handshake: offered → completed, atomically. 409 if the hand is gone —
      // two receivers cannot both shake it.
      const s = db.sessions[m[1]]; if (!s) return { code: 404, payload: { error: 'not found' } };
      const st = offerState(s);
      if (st !== 'offered') return { code: 409, payload: { error: st ? 'offer already ' + st : 'not a handoff offer' } };
      s.offer = 'completed';
      // Durable claim evidence: the fact that the hand was SHAKEN, kept independent of how
      // the engagement later settles. offerState reads this, not link settlement.
      s.claimed_at = now();
      s.claimed_by = b.surface || s.surface;
      addMessage(s, { role: 'system', kind: 'progress', text: `picked up in ${b.surface || s.surface}` });
      const link = Object.values(db.links).find(l => l.dest === s.id && l.status === 'active') || null;
      ops('offer_completed', { session: s.id, surface: b.surface || s.surface, return_owed: !!link });
      save();
      return { code: 200, payload: { completed: true, return_owed: !!link, link_id: link && link.id } };
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/withdraw$/)) && method === 'POST') {
      // Origin retracts an unshaken hand. After the shake it is too late — the
      // transaction completed; talk to the conversation instead (send_message).
      const s = db.sessions[m[1]]; if (!s) return { code: 404, payload: { error: 'not found' } };
      const st = offerState(s);
      if (st !== 'offered') return { code: 409, payload: { error: st ? 'offer already ' + st + ' — too late to withdraw' : 'not a handoff offer' } };
      s.offer = 'withdrawn';
      closeOfferLink(s.id, 'withdrawn');
      addMessage(s, { role: 'system', kind: 'progress', text: 'offer withdrawn by origin' });
      ops('offer_withdrawn', { session: s.id, reason: (b.reason || '').slice(0, 200) });
      save();
      return { code: 200, payload: { withdrawn: true } };
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/decline$/)) && method === 'POST') {
      // Receiver refuses the handshake. The reason travels back to the origin as a
      // QUEUED message (never injected) — the honest-blocker pattern for receiving.
      const s = db.sessions[m[1]]; if (!s) return { code: 404, payload: { error: 'not found' } };
      if (!b.reason) return { code: 400, payload: { error: 'reason required — a refused handshake owes the origin one sentence of why' } };
      const st = offerState(s);
      if (st !== 'offered') return { code: 409, payload: { error: st ? 'offer already ' + st : 'not a handoff offer' } };
      s.offer = 'declined';
      closeOfferLink(s.id, 'declined');
      addMessage(s, { role: 'system', kind: 'progress', text: `offer declined: ${b.reason.slice(0, 300)}` });
      const origin = db.sessions[s.origin_ref.session_id];
      if (origin) addMessage(origin, { role: 'user', kind: 'xmsg', text: `[declined handoff "${s.title}" → ${s.surface}] ${b.reason.slice(0, 300)}` });
      ops('offer_declined', { session: s.id, reason: b.reason.slice(0, 200) });
      save();
      return { code: 200, payload: { declined: true, origin_notified: !!origin } };
    }
    if ((m = p.match(/^\/api\/links\/([^/]+)\/fail$/)) && method === 'POST') {
      // Honest failure closes the debt. The origin learns WHY — a failed transaction
      // with a reason outranks a silent one (the eval gold standard, as lifecycle).
      const link = db.links[m[1]]; if (!link) return { code: 404, payload: { error: 'not found' } };
      if (!b.reason) return { code: 400, payload: { error: 'reason required — a failed return owes the origin the blocker' } };
      if (link.status !== 'active') return { code: 409, payload: { error: 'already ' + link.status } };
      link.status = 'failed';
      const origin = db.sessions[link.origin], dest = db.sessions[link.dest];
      if (origin) addMessage(origin, { role: 'system', kind: 'resume_summary', from_session: link.dest, text: `While you were away: "${dest ? dest.title : link.dest}" FAILED — ${b.reason.slice(0, 400)}` });
      settleOffer(link.dest); // Bug B: a settled link never leaves a pending offer behind
      ops('link_failed', { link: link.id, dest: link.dest, reason: b.reason.slice(0, 200) });
      save();
      return { code: 200, payload: { failed: true, origin: origin ? { id: origin.id, surface: origin.surface } : null } };
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/archive$/)) && method === 'POST') {
      // Curation, not destruction: archived records vanish from every list but stay in
      // the store, reversible with {archived:false}. Cannot archive a live offer — the
      // lifecycle owns those (withdraw/decline it first).
      const s = db.sessions[m[1]]; if (!s) return { code: 404, payload: { error: 'not found' } };
      const st = offerState(s);
      if (st === 'offered' && b.archived !== false) return { code: 409, payload: { error: 'this is a PENDING offer — withdraw or decline it instead of archiving it away' } };
      s.archived = b.archived !== false;
      ops('session_archived', { session: s.id, archived: s.archived, title: s.title.slice(0, 80) });
      save();
      return { code: 200, payload: { id: s.id, archived: s.archived } };
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/pending$/)) && method === 'GET') {
      const s = db.sessions[m[1]]; if (!s) return { code: 404, payload: { error: 'not found' } };
      return { code: 200, payload: await pendingForOrigin(s.id) };
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/export$/)) && method === 'POST') {
      const s = db.sessions[m[1]]; if (!s) return { code: 404, payload: { error: 'not found' } };
      const dir = b.dir || process.cwd();
      if (!fs.existsSync(dir)) return { code: 400, payload: { error: 'dir does not exist: ' + dir } };
      const env2 = await buildEnvelope(s);
      const fp = path.join(dir, 'HANDOFF.md');
      fs.writeFileSync(fp, renderHandoffMd(env2, s, 'code'));
      return { code: 201, payload: { path: fp, command: `cd ${JSON.stringify(dir)} && claude "Read HANDOFF.md and continue this session from where it left off"`, context_mode: env2.context_mode } };
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/launch$/)) && method === 'POST') {
      const s = db.sessions[m[1]]; if (!s) return { code: 404, payload: { error: 'not found' } };
      return await doLaunch(s, b);
    }
    if (method === 'POST' && p === '/api/workers') {
      if (!b.task) return { code: 400, payload: { error: 'task required' } };
      const origin = createSession({ surface: b.origin_surface || 'chat', title: b.title || b.task.slice(0, 60) });
      addMessage(origin, { role: 'user', text: b.task });
      if (b.context) addMessage(origin, { role: 'user', text: 'Context from the conversation: ' + b.context, kind: 'context' }); // carriers quote decisions; never re-lock
      const cont = await continueIn(origin, 'code', {});
      const launch = (await doLaunch(cont.dest, b)).payload;
      save();
      ops('dispatch', { worker_id: cont.dest.id, origin_id: origin.id, link_id: cont.link.id, task: b.task.slice(0, 200), launched: !!launch.launched, mode: launch.mode, transport: launch.transport, native: launch.native_ref && launch.native_ref.session_id });
      autoReceipt(); // traces from the very first lifecycle event — failed launches included
      return { code: 201, payload: { worker_id: cont.dest.id, origin_id: origin.id, link_id: cont.link.id, launch } };
    }
    if (method === 'GET' && p === '/api/workers') {
      const out = [];
      // "Workers" = every outstanding dispatch, regardless of destination surface —
      // a /btw side-task sent to a chat is tracked exactly like a code worker.
      for (const link of Object.values(db.links)) {
        const dest = db.sessions[link.dest], origin = db.sessions[link.origin];
        if (!dest || !origin) continue;
        // An ARCHIVED dest is not a live worker. It was listed — and aged into ORPHANED —
        // long after the user had filed it away, so status told them to clean up debris
        // they had already cleaned up (2026-08-07 audit).
        if (dest.archived) continue;
        const progressed = dest.messages.some(x => x.kind === 'progress');
        let summary = null;
        if (link.status === 'resolved') {
          const rs = origin.messages.filter(x => x.kind === 'resume_summary' && x.from_session === dest.id);
          summary = rs.length ? rs[rs.length - 1].text : null;
        } else if (progressed) {
          // Fast excerpt only — never await compact()/claude -p here. status and
          // list_workers must stay sub-second; LLM compact hung install --check (15s)
          // whenever a progressed worker existed and the CLI was on PATH.
          const prog = dest.messages.filter(x => x.kind === 'progress');
          summary = prog.length ? prog[prog.length - 1].text.slice(0, 240) : null;
        }
        // ORPHANED is observational, never stored: silence past the threshold on an
        // active link with zero progress. Same rule Gate A grades by, now visible.
        const orphanMin = parseInt(process.env.HANDOFF_ORPHAN_MINUTES || '15', 10);
        const ageMin = (Date.now() - new Date(link.created_at).getTime()) / 60000;
        const orphaned = link.status === 'active' && !progressed && ageMin > orphanMin;
        out.push({
          worker_id: dest.id, link_id: link.id, status: link.status, dest_surface: dest.surface,
          // The task label is what the user reads to decide whether a worker matters.
          // Taking the first user message made two of them read "Decision: CTA color is
          // blue" — a locked decision is a constraint ON the task, never the task.
          task: taskLabel(origin),
          origin: { id: origin.id, surface: origin.surface, title: origin.title },
          working: link.status === 'active' && !progressed && !orphaned, orphaned, summary,
          native_ref: dest.native_ref || null
        });
      }
      return { code: 200, payload: out };
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/return$/)) && method === 'POST') {
      const s = db.sessions[m[1]]; if (!s) return { code: 404, payload: { error: 'not found' } };
      if (b.summary) addMessage(s, { role: 'system', kind: 'progress', text: b.summary });
      const link = Object.values(db.links).find(l => l.dest === s.id && l.status === 'active');
      if (!link) return { code: 409, payload: { error: 'no active link back to an origin for this session' } };
      const r = await resolveLink(link, { artifacts: b.artifacts });
      const origin = db.sessions[link.origin];
      return { code: 200, payload: { returned: true, origin: { id: origin.id, surface: origin.surface }, message: r.message, artifacts_returned: r.artifacts_returned } };
    }
    if ((m = p.match(/^\/api\/links\/([^/]+)\/resolve$/)) && method === 'POST') {
      const link = db.links[m[1]]; if (!link) return { code: 404, payload: { error: 'not found' } };
      if (link.status !== 'active') return { code: 409, payload: { error: 'already ' + link.status } };
      return { code: 200, payload: await resolveLink(link) };
    }
    if (method === 'POST' && p === '/api/gather') {
      if (!SURFACES.includes(b.to)) return { code: 400, payload: { error: 'to must be one of ' + SURFACES } };
      return { code: 201, payload: await gather(b.to, b.from || []) };
    }
    return { code: 404, payload: { error: 'no route: ' + method + ' ' + p } };
  } catch (e) {
    ops('error', { path: p, method, error: String(e.message).slice(0, 300) });
    return { code: e.status || 500, payload: { error: e.message } };
  }
}

module.exports = {
  handleApi, HOME, PREFS, OPS, FULL_THRESHOLD, SURFACES, NAMES,
  claudeCliAvailable, mcpRegistered, ops, autoReceipt, getPrefs, setPref, resolveAutosend,
  artifactCap, artifactBlock, buildBrief, fencedBlock
};
