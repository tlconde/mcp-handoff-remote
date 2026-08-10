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

  try {
    const r = await core.handleApi('POST', '/api/register', {}, {
      native_id: sessionId,
      cwd,
      // No title and no role: naming is the human's, and a hook that invented one would be
      // asserting an identity nobody chose. Refreshing a binding is not the same as naming a thing.
    });
    const rec = r && r.payload;
    note(rec && rec.id ? `registered ${rec.id} (minted: ${!!rec.minted})` : `register returned ${r && r.code}`);
  } catch (e) {
    note(`register failed (${e.message}) — session continues without a protocol record`);
  }
}

main()
  .catch(e => note(`unexpected: ${e && e.message}`))
  .finally(() => process.exit(0));   // never block a session start, for any reason
