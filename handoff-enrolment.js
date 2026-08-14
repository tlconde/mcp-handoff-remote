'use strict';
/**
 * Completeness of an enrolment. Computed from the record, never stored — a flag
 * can lie; missing fields cannot.
 *
 * Chat / cowork / design must name title, nickname, subscription and model_slug
 * (ADR-0003: they can assert those; they cannot assert a host).
 * Code uses title as the address, so nickname is optional. Product is required
 * on the conversation and remote write doors; a local code auto-register may
 * omit it and whoami reports the gap rather than inventing one.
 */
function registrationMissing(s) {
  if (!s) return ['record'];
  const missing = [];
  if (!String(s.title || '').trim()) missing.push('title');
  if (!s.subscription) missing.push('subscription');
  if (!s.model_slug) missing.push('model_slug');
  if (s.surface && s.surface !== 'code' && !s.nickname) missing.push('nickname');
  return missing;
}

function registrationComplete(s) {
  return registrationMissing(s).length === 0;
}

function incompleteNote(s) {
  const gaps = registrationMissing(s);
  if (!gaps.length) return '';
  return ` — INCOMPLETE: missing ${gaps.join(', ')}. Re-register with those fields. Do not invent them.`;
}

/** Chat apps (grok.com, claude.ai) vs a machine. surface_class is a UA claim — used to
 *  name the advertised verb and to log a miss, never written on the session record. */
const CHAT_APP_CLASS = { 'grok-app': true, 'claude-app': true };

function canonicalEnrolmentTool(name, args) {
  if (name === 'register_chat_session') return 'register_chat_session';
  if (name === 'register_code_session' || name === 'register_remote_session') return 'register_code_session';
  if (name === 'register_session') {
    const surface = args && args.surface ? String(args.surface).trim() : '';
    if (surface && surface !== 'code') return 'register_chat_session';
    return 'register_code_session';
  }
  return null;
}

function expectedEnrolmentTool(ctx, args) {
  const surface = args && args.surface ? String(args.surface).trim() : '';
  if (surface && surface !== 'code') return 'register_chat_session';
  const cls = ctx && ctx.surface_class;
  if (cls && CHAT_APP_CLASS[cls]) return 'register_chat_session';
  return 'register_code_session';
}

/** Use before a register_* write. wrong means this caller should have used the other door. */
function enrolmentDoor(name, ctx, args) {
  const used = canonicalEnrolmentTool(name, args);
  if (!used) return { used: name, expected: null, wrong: false, reason: null };
  const expected = expectedEnrolmentTool(ctx, args);
  const cls = (ctx && ctx.surface_class) || null;
  if (used === expected) return { used, expected, wrong: false, reason: null, surface_class: cls };
  const reason = (cls && CHAT_APP_CLASS[cls]) ? 'chat_app_used_code_door' : 'code_seat_used_chat_door';
  return { used, expected, wrong: true, reason, surface_class: cls };
}

function wrongEnrolmentDoorRefusal(door) {
  return `REFUSED: wrong enrolment door. Use ${door.expected}, not ${door.used}. ` +
    `grok.com / claude.ai / Claude chat → register_chat_session. A machine (Grok Build, Claude Code) → register_code_session. ` +
    `Nothing was written.`;
}

/** Old verb names stay callable so a cached tools/list is not a 404. They do not enrol. */
function legacyEnrolmentRefusal(name) {
  return `REFUSED: ${name} is no longer an enrolment verb. ` +
    `Use register_chat_session (grok.com / claude.ai / Claude chat) or register_code_session (a machine). ` +
    `Then whoami. Nothing was written.`;
}

function reregisterNote(s) {
  if (!s) return '';
  if (s.enrolment_verb === 'register_chat_session' || s.enrolment_verb === 'register_code_session') return '';
  const tool = (s.surface && s.surface !== 'code') ? 'register_chat_session' : 'register_code_session';
  return ` RE-REGISTER with ${tool} — first contact. Legacy enrolment will be retired.`;
}

module.exports = {
  registrationMissing, registrationComplete, incompleteNote,
  canonicalEnrolmentTool, expectedEnrolmentTool, enrolmentDoor, wrongEnrolmentDoorRefusal,
  legacyEnrolmentRefusal, reregisterNote,
};
