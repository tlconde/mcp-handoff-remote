#!/usr/bin/env node
'use strict';
/**
 * TRANSPORT SEAM — the contract every delivery leg implements, so the leg is replaceable.
 *
 * WHY THIS EXISTS, and it is a strategic bet rather than tidiness. An independent architecture
 * review (2026-08-09) made the strongest counter-argument against this whole project: the platform
 * is converging on the transport layer. Cross-machine messaging shipped reply-only with the
 * plumbing to initiate visibly present; channels are heading toward allowlisted GA. One flag flip
 * makes a homemade delivery leg redundant. The durable value is what Anthropic explicitly refuses
 * to carry — envelope semantics: locked decisions, return contracts, artifacts by value, the offer
 * lifecycle. Messaging's own docs say it: "A message is a piece of text one Claude writes to
 * another, never conversation history or files."
 *
 * So the leg must be swappable without touching the envelope. This file is that boundary.
 *
 * THE CONTRACT. A transport is:
 *   {
 *     name:      string                       // stable id, appears in wake logs and tests
 *     available: (delivery) => boolean        // can this leg even be attempted for this target?
 *     deliver:   (delivery) => Outcome        // attempt it; MUST NOT throw
 *   }
 *
 *   Outcome = {
 *     delivered: boolean   // did it reach the receiver? NOT "did the call succeed"
 *     held:      boolean   // reached the receiver's machine and was withheld from Claude
 *     evidence:  string|null  // what PROVES delivered — a receipt, a listed record, an ack.
 *                             // null means dispatched-but-unconfirmed, and callers must say so.
 *     reason:    string|null  // why not, in words a human can act on
 *   }
 *
 * WHY `held` IS IN THE CONTRACT AND NOT AN AFTERTHOUGHT. Docs (cross-session-messaging, Control
 * inbound messages) define three outcomes for an arriving message — delivered, held, refused — and
 * a receiver in bypassPermissions HOLDS messages from a sender that does not identify as bypassing.
 * A transport that collapses held into delivered reports success for mail no Claude will ever read.
 * That is the exact silent-success class this project spent 2026-08-09 removing: a stale daemon
 * reporting healthy, a notification rung that never fired on Windows, three messages sent to a
 * record with no reader. Making it a required field means a new transport cannot omit it quietly.
 *
 * WHY `evidence` IS SEPARATE FROM `delivered`. Exit 0 proves the binary ran. Only a receipt proves
 * delivery. Measured twice in one day: terminal-notifier exits 0 whether or not the notification
 * appears, and a `claude -p` relay spawn reports dispatch, never arrival. A transport that has no
 * receipt available sets evidence:null and the caller must not upgrade that to a claim.
 */

/* THE REGISTRY IS THE INVARIANT, not a convenience. It lists every leg wake() implements, and
 * transport-smoke asserts the two sets are IDENTICAL. Legs migrate into this file one at a time;
 * the test fails the moment the registry and the implementation drift apart.
 *
 * That mechanism is deliberate. A staged refactor guarded by "remember to keep these in sync" is
 * the same promise the mirroring rule made between two repos, and on 2026-08-09 that promise had
 * quietly failed for 15 of 23 shared files while both sides believed it was holding. An invariant
 * a test enforces is worth more than an invariant a comment requests. */
const RUNGS = [
  {
    name: 'channel',
    why: 'Injects into an open session launched with --channels. The only supported way to START a '
       + 'turn from outside the machine, per docs/en/channels. Research preview: allowlisted '
       + 'plugins, or --dangerously-load-development-channels for our own.',
    reaches: 'a session that opted in at launch',
    evidence: 'none today — the hook is fire-and-forget',
  },
  {
    name: 'relay',
    why: 'Spawns one `claude -p` on the TARGET machine and lets native SendMessage carry the frame. '
       + 'Native-first: we invoke the CLI as a product rather than speaking its private wire.',
    reaches: 'an OPEN local session with a live socket',
    evidence: 'none — dispatch is not arrival, and the spawned session confirms nothing back',
  },
  {
    name: 'notify',
    why: 'The target cannot be reached by any process — no live socket, or it is on another device. '
       + 'Tell the human, naming the session, the device and the window. REQUIRED, not a fallback: '
       + 'for a cross-device target this is the whole wake path.',
    reaches: 'a human',
    evidence: 'platform-dependent; macOS terminal-notifier -list reads delivered records, osascript '
            + 'and the Windows toast expose none',
  },
  {
    name: 'store',
    why: 'Always the durable truth, written by the CALLER before any leg runs. Every leg degrades '
       + 'to it. Reaching it means nobody was told and the mail waits on someone looking.',
    reaches: 'the next turn in that window',
    evidence: 'the record on disk',
  },
];

/** Every leg name, in preference order. wake() must implement exactly these. */
function rungNames() { return RUNGS.map(r => r.name); }
/** The reasoning for one leg, so a reader does not have to reconstruct it from the code. */
function rung(name) { return RUNGS.find(r => r.name === name) || null; }

/* An Outcome with every field present. Transports build results through this so a new leg cannot
 * omit `held` or `evidence` by forgetting them — the omission would otherwise read as false/null,
 * which are meaningful values, not absences. */
function outcome({ delivered = false, held = false, evidence = null, reason = null } = {}) {
  return { delivered: !!delivered, held: !!held, evidence: evidence || null, reason: reason || null };
}

/** True when a transport object satisfies the contract. Used by the suite, and by any future
 *  loader that accepts a third-party leg — a malformed transport must be refused at the door
 *  rather than discovered mid-delivery. */
function isTransport(t) {
  return !!t && typeof t.name === 'string' && t.name.length > 0
    && typeof t.available === 'function' && typeof t.deliver === 'function';
}

module.exports = { RUNGS, rungNames, rung, outcome, isTransport };
