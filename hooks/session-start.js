#!/usr/bin/env node
'use strict';
/**
 * SessionStart hook — IDENTITY ONLY. Registers or refreshes this session's protocol record so a
 * session can be addressed without anyone typing anything.
 *
 * "Install one command, enrolment zero commands" — this file is the zero. Without it every terminal
 * has to call register_session by hand, which is exactly the manual step the plugin exists to
 * delete.
 *
 * WHAT IT DELIBERATELY DOES NOT DO, and this boundary is a ruling rather than a simplification:
 * it does not read, write or consume a context package, and it restores nothing. The
 * clear-cadence rehydration design — what a checkpoint contains, when it is written, when it is
 * consumed — is PARKED and lands as its own slice. Only the half that was never contentious ships
 * here: a session knowing which record it is.
 *
 * It also never drains an inbox. A hook that consumed mail would eat conversations the user has not
 * looked at yet, and draining belongs to the reader.
 *
 * KIND is asserted as claude-code. Cursor CLI uses hooks/cursor-session-start.js with
 * kind:cursor-cli on the same /api/register door — never this file with a Cursor uuid.
 *
 * FAILURE IS SILENT AND EXIT 0, ALWAYS. A hook runs before the user has typed anything; a session
 * that will not start because a background nicety failed is worse than a session with no protocol
 * identity. Every path below ends in exit 0 — including the paths that fail — and the reason is
 * written where it can be read rather than announced into a session someone is trying to use.
 *
 * stdin carries {session_id, cwd, transcript_path, hook_event_name, ...}; stdout is parsed by
 * Claude Code as JSON when we exit 0, so anything we print must be either valid JSON or nothing.
 */
const fs = require('fs');
const path = require('path');

const LOG = process.env.HANDOFF_HOOK_LOG || null;

function note(msg) {
  if (!LOG) return;
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} session-start: ${msg}\n`); } catch (_) {}
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; }
}

async function main() {
  let payload = {};
  try { payload = JSON.parse(readStdin() || '{}'); } catch (_) { /* no payload is normal */ }

  /* The hook's own payload is the authority on which session this is. An env var may be stale
   * across a resume — the frozen-uuid defect this project has already paid for — so the payload
   * wins and the env is only a fallback. */
  const sessionId = payload.session_id || process.env.CLAUDE_CODE_SESSION_ID || null;
  const cwd = payload.cwd || process.cwd();

  if (!sessionId) {
    note('no session_id in payload or env — nothing registered, and nothing guessed');
    return;
  }

  let core;
  try {
    core = require(path.join(__dirname, '..', 'handoff-core'));
  } catch (e) {
    note(`core unavailable (${e.message}) — plugin installed without its store; skipping`);
    return;
  }

  /* SIDECAR RE-JOIN (the durable id that survives quit+relaunch — handoff-core documents the
   * sidecar as load-bearing; this is the half that presents it). The store wrote a sidecar
   * naming the last record that held a live binding in this cwd. If that record's uuid no
   * longer answers to any live process, THIS session presents it through the explicit
   * `succeeds` door — adoption by the caller, never inference by the store. Every gate errs
   * toward NOT adopting: wrong identity is worse than no identity, and a skipped re-join
   * costs one manual naming, not a corrupted record.
   *   - sidecar unreadable / malformed id            → skip
   *   - sidecar names THIS session's own uuid        → skip (normal resume, nothing to join)
   *   - old uuid still answers to a live process     → skip (that seat is alive — a second
   *     terminal in the same folder must not steal it)
   *   - predecessor record missing/archived/retired/
   *     already superseded                           → skip (never force the 409 path; a
   *     failed adoption must not cost the registration)
   * Operator ruling 2026-08-17: "solve the issue so that next time, the agent in the
   * terminal will pick up the task immediately." */
  let succeeds, adoptionEvidence;
  try {
    const home = process.env.HANDOFF_HOME || path.join(require('os').homedir(), '.claude-handoff');
    const scKey = require('crypto').createHash('sha1').update(String(cwd)).digest('hex');
    const sc = JSON.parse(fs.readFileSync(path.join(home, 'sidecars', scKey + '.json'), 'utf8'));
    if (sc && /^sess_[a-z]+_[A-Za-z0-9._-]+$/.test(sc.record_id || '') && sc.uuid && sc.uuid !== sessionId) {
      let oldAlive = false;
      const nd = process.env.HANDOFF_NATIVE_SESSIONS_DIR || path.join(require('os').homedir(), '.claude', 'sessions');
      for (const f of fs.readdirSync(nd).filter(f => f.endsWith('.json'))) {
        try {
          const row = JSON.parse(fs.readFileSync(path.join(nd, f), 'utf8'));
          if (!row || row.sessionId !== sc.uuid) continue;
          if (!row.pid) { oldAlive = true; break; }
          try { process.kill(row.pid, 0); oldAlive = true; } catch (e) { if (e.code === 'EPERM') oldAlive = true; }
          break;
        } catch (_) { /* unreadable row is not evidence of life */ }
      }
      if (!oldAlive) {
        const pred = JSON.parse(fs.readFileSync(path.join(home, 'store', 'v1', 'sessions', sc.record_id + '.json'), 'utf8'));
        if (pred && !pred.archived && !pred.retired && !pred.superseded_by) {
          succeeds = sc.record_id;
          adoptionEvidence = `sidecar re-join: last claude-code session in ${cwd}; predecessor binding (${String(sc.uuid).slice(0, 8)}…) dead at adoption`;
          note(`sidecar re-join: presenting succeeds=${sc.record_id}`);
        }
      }
    }
  } catch (_) { /* no sidecar, or any doubt at any gate: register plainly, adopt nothing */ }

  try {
    const r = await core.handleApi('POST', '/api/register', {}, {
      kind: 'claude-code',
      native_id: sessionId,
      cwd,
      succeeds,
      adoption_evidence: adoptionEvidence,
      // No title and no role: naming is the human's, and a hook that invented one would be
      // asserting an identity nobody chose. Refreshing a binding is not the same as naming a thing.
    });
    const rec = r && r.payload;
    note(rec && rec.id ? `registered ${rec.id} kind=${rec.kind || 'claude-code'} (minted: ${!!rec.minted})` : `register returned ${r && r.code}`);
  } catch (e) {
    note(`register failed (${e.message}) — session continues without a protocol record`);
  }
}

main()
  .catch(e => note(`unexpected: ${e && e.message}`))
  .finally(() => process.exit(0));   // never block a session start, for any reason
