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

module.exports = { registrationMissing, registrationComplete, incompleteNote };
