#!/usr/bin/env node
'use strict';
/**
 * Cursor sessionStart — IDENTITY ONLY, same ruling as hooks/session-start.js for Claude Code.
 *
 * Binds this Cursor conversation on /api/register with kind:'cursor-cli'.
 * native_ref = { kind:'cursor-cli', session_id:<conversation id> } — the product id, not a
 * Claude resume string. No pid heal. No invented human title (Untitled until /onboard).
 * Never drains the inbox.
 *
 * Cursor stdout must be JSON ({ env, additional_context }) or empty. Plain text breaks the
 * hook merge. Failures are silent and exit 0 — a session that will not start because a
 * background nicety failed is worse than a session with no protocol identity.
 *
 * stdin (CLI): { conversation_id, session_id?, model, is_background_agent, composer_mode, … }
 * Wire via project or user hooks.json — see hooks/cursor-hooks.json.example.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG = process.env.HANDOFF_HOOK_LOG || null;

function note(msg) {
  if (!LOG) return;
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} cursor-session-start: ${msg}\n`); } catch (_) {}
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; }
}

function emit(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch (_) {}
}

async function main() {
  let payload = {};
  try { payload = JSON.parse(readStdin() || '{}'); } catch (_) { /* no payload is normal */ }

  const sessionId = payload.session_id || payload.conversation_id || null;
  const cwd = process.env.CURSOR_PROJECT_DIR || payload.cwd || process.cwd();
  const host = os.hostname();

  if (!sessionId) {
    note('no session_id/conversation_id — nothing registered, and nothing guessed');
    return;
  }

  let core;
  try {
    core = require(path.join(__dirname, '..', 'handoff-core'));
  } catch (e) {
    note(`core unavailable (${e.message}) — skipping`);
    return;
  }

  try {
    const r = await core.handleApi('POST', '/api/register', {}, {
      kind: 'cursor-cli',
      native_id: sessionId,
      cwd,
      host,
    });
    const rec = r && r.payload;
    if (rec && rec.id) {
      note(`registered ${rec.id} kind=cursor-cli native=${rec.session && rec.session.native_ref && rec.session.native_ref.session_id} (minted: ${!!rec.minted})`);
      /* env is the reliable sessionStart half on Cursor; additional_context is best-effort
       * and raced in the IDE. Identity for later hooks only — naming stays /onboard. */
      emit({ env: { HANDOFF_SESSION_ID: rec.id, HANDOFF_NATIVE_ID: String(sessionId) } });
    } else {
      note(`register returned ${r && r.code}: ${r && r.payload && r.payload.error}`);
    }
  } catch (e) {
    note(`register failed (${e.message}) — session continues without a protocol record`);
  }
}

main()
  .catch(e => note(`unexpected: ${e && e.message}`))
  .finally(() => process.exit(0));
