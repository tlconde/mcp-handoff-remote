#!/usr/bin/env node
'use strict';
/**
 * TRANSPORT SMOKE — the seam's contract, and the anti-drift invariant.
 *
 * The load-bearing test here is the LAST one: the registry in bin/handoff-transport.js and the
 * rungs wake() actually implements must be the same set. Legs migrate into the seam one at a time,
 * and that test fails the moment the two descriptions of reality diverge.
 *
 * It exists because "remember to keep these in sync" is precisely the promise the mirroring rule
 * made between two repos, and on 2026-08-09 it had silently failed for 15 of 23 shared files while
 * both sides believed it was holding. The lesson was not "try harder"; it was that an invariant
 * worth having is an invariant a test enforces.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require('./bin/handoff-transport');

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('  ok  ', name); }
  catch (e) { failed++; console.log('  FAIL', name, '\n       ' + (e && e.message)); }
};

console.log('\ntransport-smoke\n');

test('outcome() fills every contract field, so a leg cannot omit one by forgetting it', () => {
  const o = T.outcome({ delivered: true });
  assert.deepStrictEqual(Object.keys(o).sort(), ['delivered', 'evidence', 'held', 'reason']);
  assert.strictEqual(o.held, false, 'held defaults to a VALUE, never undefined');
  assert.strictEqual(o.evidence, null, 'no receipt is null, which callers must not upgrade to a claim');
});

test('outcome() distinguishes held from delivered — the silent-success guard', () => {
  const held = T.outcome({ delivered: false, held: true, reason: 'receiver holds messages from a non-bypassing sender' });
  assert.strictEqual(held.delivered, false);
  assert.strictEqual(held.held, true);
  assert.ok(held.reason, 'a held message must carry a reason a human can act on');
});

test('isTransport refuses a malformed leg at the door', () => {
  assert.ok(T.isTransport({ name: 'x', available: () => true, deliver: () => T.outcome() }));
  assert.ok(!T.isTransport(null));
  assert.ok(!T.isTransport({ name: '', available: () => true, deliver: () => {} }), 'an unnamed leg cannot be logged or tested');
  assert.ok(!T.isTransport({ name: 'x', deliver: () => {} }), 'a leg with no availability check would be attempted blindly');
});

test('every rung carries its reasoning, not just its name', () => {
  for (const r of T.RUNGS) {
    assert.ok(r.why && r.why.length > 40, `${r.name} must say WHY it exists`);
    assert.ok(r.reaches, `${r.name} must say WHO or WHAT it reaches`);
    assert.ok(r.evidence, `${r.name} must state what proves delivery, including "none"`);
  }
});

test('notify is a rung, and is described as required rather than as a fallback', () => {
  const n = T.rung('notify');
  assert.ok(n, 'the notification leg is part of the contract');
  assert.match(n.why, /REQUIRED, not a fallback/,
    'for a cross-device target this is the whole wake path — describing it as a fallback is how it got removed');
});

test('store is last, and says reaching it means nobody was told', () => {
  assert.strictEqual(T.rungNames()[T.rungNames().length - 1], 'store', 'the durable truth is the final degrade');
  assert.match(T.rung('store').why, /nobody was told/,
    'the distinction between told and merely stored is the one that hid a whole platform going silent');
});

/* THE INVARIANT. Read wake()'s source and extract every tier it can return, then compare to the
 * registry. Source-reading rather than execution on purpose: exercising every rung would need four
 * different machine states, and a test that cannot run is a test that does not guard. */
test('ANTI-DRIFT: the registry and the rungs wake() implements are the same set', () => {
  const src = fs.readFileSync(path.join(__dirname, 'bin', 'handoff-wake.js'), 'utf8');
  const implemented = new Set();
  for (const m of src.matchAll(/tier:\s*'([a-z-]+)'/g)) implemented.add(m[1]);
  for (const m of src.matchAll(/\?\s*'([a-z-]+)'\s*:\s*'([a-z-]+)'/g)) { implemented.add(m[1]); implemented.add(m[2]); }
  /* Two vocabularies share the word `tier` and only one of them names a leg.
   *   INPUT  — delivery.tier is 'attention' | 'fyi', the caller's urgency. Never a rung.
   *   OUTPUT — result.tier names the leg that ran, or a lifecycle answer meaning none did.
   * The first run of this test flagged 'attention' as an undescribed rung, which is the scan
   * being honest about its own naivety rather than a defect in wake(). Both exclusions are
   * listed explicitly so a genuinely new leg can never be swallowed by a broad filter. */
  for (const deliveryTier of ['attention', 'fyi']) implemented.delete(deliveryTier);
  for (const lifecycle of ['disabled', 'skipped', 'error']) implemented.delete(lifecycle);

  const registered = new Set(T.rungNames());
  const missingFromRegistry = [...implemented].filter(x => !registered.has(x));
  const missingFromWake = [...registered].filter(x => !implemented.has(x));

  assert.deepStrictEqual(missingFromRegistry, [],
    `wake() can return tier(s) the seam does not describe: ${missingFromRegistry.join(', ')} — add them to RUNGS`);
  assert.deepStrictEqual(missingFromWake, [],
    `the seam describes leg(s) wake() cannot return: ${missingFromWake.join(', ')} — the registry is claiming a capability that does not exist`);
});

console.log(`\ntransport-smoke: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
