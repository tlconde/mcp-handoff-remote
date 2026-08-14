#!/usr/bin/env node
'use strict';
/**
 * CHAT WHOAMI CHECK — register over the relay, then whoami must see the seat.
 *
 * WHY THIS EXISTS. Measured 2026-08-14 on grok.com: Chad called register_chat_session,
 * got sess_chat_…, then no-arg whoami said unidentified and told it to register_chat_session
 * again. The register had succeeded. The unidentified copy was the next-action, so the seat
 * re-enrolled. Same trap the cli_uuid path already named, now on the minted chat id.
 *
 * WHAT IT CHECKS, against a scratch store (never the operator's):
 *   1. register_chat_session returns a session_id and tells the caller to pass it to whoami.
 *   2. no-arg whoami over a grok-app relay is unidentified AND says do not register again.
 *   3. whoami with session_id (the field register prints) returns You are: <title>.
 *   4. whoami with session_uuid set to that same minted id returns You are: <title>.
 *
 *   node bin/chat-whoami-check.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-whoami-check-'));
process.env.HANDOFF_HOME = tmp;
process.env.HANDOFF_TEST = '1';
process.env.HANDOFF_NO_CLI = '1';
process.env.HANDOFF_NO_AUTORECEIPT = '1';
process.env.HANDOFF_NO_AUTOOPEN = '1';

const core = require('../handoff-core');
const { callTool } = require('../handoff-tools');

function fail(msg) {
  console.error('chat-whoami-check: FAIL — ' + msg);
  process.exit(1);
}

(async () => {
  const ctx = { remote: true, surface_class: 'grok-app', account_sub: 'sandbox-account' };
  const reg = String(await callTool('register_chat_session', {
    surface: 'chat', title: 'Chad', nickname: 'Chad',
    subscription: 'grok', model_slug: 'grok-4.5',
  }, ctx, core));
  const m = /session_id:\s*(sess_chat_\S+)/.exec(reg);
  if (!m) fail('register did not return a sess_chat_ session_id\n' + reg);
  const id = m[1];
  if (!/whoami/.test(reg)) fail('register receipt must tell the caller to whoami with that id\n' + reg);
  if (!/do not register again/i.test(reg)) fail('register receipt must say do not register again\n' + reg);

  const who0 = String(await callTool('whoami', {}, ctx, core));
  if (/^You are: Chad\b/.test(who0)) fail('no-arg whoami over the relay must not silently resolve — that would be a guess\n' + who0);
  if (!/unidentified/.test(who0)) fail('no-arg whoami must stay unidentified\n' + who0);
  if (!/do not register again/i.test(who0)) {
    fail('no-arg unidentified line must say do not register again (Chad\'s loop was this line telling them to enrol)\n' + who0);
  }
  if (/then register_chat_session/i.test(who0) && !/do not register again/i.test(who0)) {
    fail('unidentified line still sequences register as the next step without the already-registered caveat\n' + who0);
  }

  const whoSid = String(await callTool('whoami', { session_id: id }, ctx, core));
  if (!/^You are: Chad\b/.test(whoSid)) fail('whoami({session_id}) must resolve the minted record (the field register prints)\n' + whoSid);

  const whoUuid = String(await callTool('whoami', { session_uuid: id }, ctx, core));
  if (!/^You are: Chad\b/.test(whoUuid)) fail('whoami({session_uuid: minted id}) must resolve\n' + whoUuid);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* scratch */ }
  console.log('chat-whoami-check: OK — no-arg unidentified tells them to pass the id; session_id and session_uuid both resolve.');
})().catch(e => {
  console.error('chat-whoami-check: threw — ' + (e && e.stack || e));
  process.exit(2);
});
