#!/usr/bin/env node
/**
 * SessionStart recap — "while you were away", the hookable slice of §04 recap-on-resume.
 *
 * Prints ONE compact line at terminal-session start: attention items (messages, returns,
 * pending offers) counted with the store's own unread logic, ambient read state (✓✓) on
 * this identity's sends summarized inline. Prints nothing when there is nothing.
 *
 * READ-ONLY on purpose: hooks run before any bridge is up, and this store is shared by
 * live bridge processes — a hook that writes races them. Settlement of ambient state
 * stays with status (which renders then settles). Consequence, documented not hidden:
 * a ✓✓ repeats in recaps until a status call settles it.
 *
 * Scope: STORE-sourced items only. Native cross-session messages (Code↔Code) deliver
 * themselves — an idle session gets a new turn — so they need no recap here.
 *
 * Never breaks session start: any error exits 0 silently.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

try {
  const HOME = process.env.HANDOFF_HOME || path.join(os.homedir(), '.claude-handoff');
  const dir = path.join(HOME, 'store', 'v1', 'sessions');
  const sessions = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { return null; }
  }).filter(s => s && !s.archived);

  const UNREAD_KINDS = new Set(['xmsg', 'resume_summary']);
  const lastCheck = s => (s.messages || [])
    .map((m, i) => (m.kind === 'progress' && /^inbox checked/.test(m.text || '')) ? i : -1)
    .reduce((a, b) => Math.max(a, b), -1);
  const fresh = s => { const lc = lastCheck(s); return (s.messages || []).filter((m, i) => UNREAD_KINDS.has(m.kind) && i > lc); };

  // Attention tier, this surface (a terminal recap drains code):
  const code = sessions.filter(s => s.surface === 'code');
  let msgs = 0, returns = 0;
  for (const s of code) for (const m of fresh(s)) (m.kind === 'resume_summary' ? returns++ : msgs++);
  const offers = code.filter(s => s.origin_ref && (!s.offer || s.offer === 'offered') &&
    !(s.messages || []).some(m => m.kind === 'progress' && /^picked up in /.test(m.text || ''))).length;

  /* Ambient tier: read state on THIS identity's sends, unsettled only.
   * WHICH SESSION AM I? From the hook PAYLOAD on stdin, not from the environment.
   * A hook inherits its env from the CLI process, whose CLAUDE_CODE_SESSION_ID was fixed at
   * launch — and /clear forks a new session id inside that same living process, so the env
   * var goes stale while the process runs on. (Measured 2026-08-09: SessionStart delivers
   * {session_id, transcript_path, cwd, hook_event_name, source} on stdin, and it is the live
   * id.) Reading the env here silently matched nothing after a /clear, so every ambient ✓✓
   * vanished from the recap — the same cached-address disease as the frozen NATIVE_ID, in
   * the one place that reports on it. Env stays only as the fallback. */
  let payload = {};
  try { if (!process.stdin.isTTY) payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (_) { payload = {}; }
  const nativeId = payload.session_id || process.env.CLAUDE_CODE_SESSION_ID || null;
  const myIds = new Set(sessions.filter(s => nativeId && s.native_ref && s.native_ref.session_id === nativeId).map(s => s.id));
  const ambient = [];
  for (const s of sessions) for (const m of s.messages || []) {
    if (m.from_session && myIds.has(m.from_session) && m.read_at && !m.settled_at) ambient.push(m);
  }

  const bits = [];
  if (msgs) bits.push(`${msgs} message${msgs === 1 ? '' : 's'}`);
  if (returns) bits.push(`${returns} return${returns === 1 ? '' : 's'}`);
  if (offers) bits.push(`${offers} pending offer${offers === 1 ? '' : 's'}`);
  const hhmm = t => { const d = new Date(t); return isNaN(d) ? String(t) : d.toTimeString().slice(0, 5); };
  for (const m of ambient.slice(0, 3)) bits.push(`1 ✓✓ read ${hhmm(m.read_at)}`);
  if (ambient.length > 3) bits.push(`+${ambient.length - 3} more ✓✓`);

  if (bits.length) {
    console.log(`while you were away: ${bits.join(', ')}` +
      (msgs || returns ? ` — check_inbox surface:"code" to read` : ''));
  }
} catch (_) { /* silent — a recap must never break session start */ }
process.exit(0);
