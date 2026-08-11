#!/usr/bin/env node
'use strict';
/**
 * SESSION WATCH — a seat that watches for its OWN mail, from inside itself.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT THE WAKE AGENT. bin/handoff-wake-agent.js watches the store for
 * a whole MACHINE and then has to DELIVER into a session — and delivery is the half that has no
 * implementation on Windows. Every leg in the transport registry needs a local injection point: the
 * relay leg needs a peer socket (refused on win32, correctly, because ListAgents does not exist in
 * a spawned one-shot there), and the channel leg needs a capability no mount declares yet. So on
 * Windows the ladder falls to `notify`, and a human taps.
 *
 * This file removes the delivery problem instead of solving it. It runs INSIDE the session it
 * serves, as a background command owned by that session, so there is nothing to inject into: the
 * seat is already the reader. That is the entire trick, and it is why this works identically on
 * Windows, macOS, Linux and WSL — it uses no socket, no spawn, no platform verb. Pure Node and one
 * authenticated read.
 *
 * WHAT IT IS NOT. It cannot start a turn in a session that is CLOSED, and it makes no claim to.
 * A shut terminal is still the notify rung's problem, and that rung already works on Windows.
 * This covers exactly one case, which happens to be the common one: a session that is open and
 * idle while mail lands for it.
 *
 * IT NEVER DRAINS. peek_inbox only, never check_inbox — the same ruling the wake agent is held to,
 * and for the same measured reason: one inbox check consumed an envelope addressed to another
 * session. Reading belongs to the reader. This file only ever says "there is mail", never what it
 * says, and never marks it read.
 *
 * THE OUTPUT CONTRACT IS THE COST MODEL, so it is stated first. Every line this prints becomes a
 * message in the watching session, and every message costs one model turn. The polling itself costs
 * nothing — it is a shell process, and the model is not running. So:
 *
 *     unchanged cycle   → prints NOTHING  → costs nothing
 *     new mail          → prints ONE line → costs one turn
 *
 * That is the whole reason to prefer this over a timed re-prompt, which pays a turn per tick
 * whether or not anything happened. A loose filter here would delete that advantage, so the change
 * test is on the CONTENT of the peek (which conversations, how many unread), not on the cursor:
 * a cursor advances for traffic that is not ours.
 *
 * SILENCE IS NOT SUCCESS, so failures are LOUD. A watcher that goes quiet because the store became
 * unreachable looks exactly like a watcher with nothing to report. Transitions into an error state
 * and back out of it both print, always, and the error text is carried. An unchanged FAILURE stays
 * quiet after the first line, so a store outage costs one turn rather than one per cycle.
 *
 * HOW IT IS ARMED IS PART OF WHETHER IT WORKS, and getting this wrong produces a silent failure
 * that looks exactly like a broken watcher. Measured on the lili seat, 2026-08-11: the watcher ran
 * correctly, found the mail and printed the line, and NOTHING WOKE — because it had been armed as a
 * background shell command, and a background command reports to its session ONLY WHEN IT EXITS.
 * This one never exits, so its output sat in a file nobody read.
 *
 *   ARMED AS A PER-LINE MONITOR   → every printed line starts a turn. Use the default mode.
 *   ARMED AS A BACKGROUND COMMAND → only the EXIT is reported. Use --exit-on-mail, which turns
 *                                   this into a one-shot: it waits, and exits the moment mail
 *                                   appears. One notification, exactly when it matters.
 *
 * Neither is wrong; they are different shapes. The failure is arming an unbounded poller in the
 * mode that only reports exits, and the fix is that the two modes now exist and say which is which.
 *
 * Usage:
 *   node bin/handoff-session-watch.js --once            one cycle, print the state, exit
 *   node bin/handoff-session-watch.js                   poll forever, print only on change
 *   node bin/handoff-session-watch.js --exit-on-mail    poll until mail appears, print it, EXIT
 *   node bin/handoff-session-watch.js --mine            only mail for THIS seat's record
 *   node bin/handoff-session-watch.js --title lulu      only conversations matching a title
 *   node bin/handoff-session-watch.js --interval 15     seconds between cycles (10..300)
 *   node bin/handoff-session-watch.js --verbose         print every cycle, changed or not
 *
 * Env:
 *   HANDOFF_WATCH_INTERVAL   seconds between cycles (default 30; clamped to 10..300)
 *   CLAUDE_CODE_SESSION_ID   used by --mine to ask the store which record this seat is
 *   HANDOFF_REMOTE_URL etc.  the ordinary store-client configuration, loaded from .agent-env
 */
const path = require('path');

const { loadLocalEnv, makeStoreClient, rpc, resolveCredential } = require('./handoff-store-client');
loadLocalEnv();

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const val = (f) => { const i = ARGS.indexOf(f); return i >= 0 ? ARGS[i + 1] : null; };

const ONCE = has('--once');
/* EXIT is the notification, in this mode. A background shell command tells its session one thing
 * only — that it finished — so a watcher armed that way must FINISH when it has news. */
const EXIT_ON_MAIL = has('--exit-on-mail');
const VERBOSE = has('--verbose') || ONCE;
const MINE = has('--mine');
const SURFACE = val('--surface') || 'code';
let TITLE = val('--title');

/* Clamped rather than trusted: a 1-second interval turns an authenticated remote read into a
 * hammer on someone else's machine, and a 2-hour one is a watcher that has stopped watching
 * without saying so.
 *
 * BOTH A FLAG AND AN ENV VAR, and the flag exists for a platform reason rather than for taste:
 * `VAR=value node ...` is bash syntax, and a seat whose shell is PowerShell or cmd cannot say it.
 * An option that only one platform can set is not an option on the machine this file was written
 * for. The flag wins where both are given. */
const INTERVAL = Math.min(300, Math.max(10,
  Number(val('--interval') || process.env.HANDOFF_WATCH_INTERVAL || 30))) * 1000;

/* EVERY LINE CARRIES THE TIME IT WAS PRINTED, and this is not decoration.
 *
 * Asked "how long did the wake take", the lili seat could not answer and refused to estimate:
 * the monitor event carries no timestamp and the watch line carried none either, so any duration
 * would have been reconstructed rather than observed. It said the gap plainly rather than handing
 * the operator a number dressed as a measurement — and it is right that "how long did the wake
 * take" is exactly the question this tier will be judged on. A wake path whose own log cannot
 * answer its headline question is a tier that will be argued about instead of measured.
 *
 * ISO 8601 in UTC, so two seats on two machines in two zones subtract cleanly. */
function say(line) { process.stdout.write(`${new Date().toISOString()} ${line}\n`); }

/* PARSED FROM THE SENTENCE, because peek_inbox returns prose for a human and there is no JSON
 * shape to ask for. Every field is optional on purpose: a parse that fails must degrade to "I
 * could not read this" and print it, never to "nothing is waiting", which is the silent-success
 * failure this repo keeps paying for. */
function parsePeek(text) {
  const s = String(text || '');
  const convos = [];
  for (const line of s.split('\n')) {
    const m = /^-\s+"(.+?)"\s+.*?·\s+(\d+)\s+unread(?:\s+·\s+reachable:\s*(\S+))?/.exec(line.trim());
    if (m) convos.push({ title: m[1], unread: Number(m[2]), reach: m[3] || 'unknown' });
  }
  const none = /NOTHING (IS )?WAITING|0 conversation|no unread/i.test(s);
  return {
    convos,
    parsed: convos.length > 0 || none,
    total: convos.reduce((a, c) => a + c.unread, 0),
    raw: s,
  };
}

/* THE CHANGE KEY IS THE CONTENT, NOT THE CURSOR. The cursor moves for every message on the
 * surface, including conversations this seat is not in; keying on it would fire a turn for other
 * people's mail. Title + count is what the reader would actually act on. */
function signature(p) {
  if (!p.parsed) return `unparsed:${p.raw.length}`;
  return p.convos.map(c => `${c.title}=${c.unread}`).sort().join(',') || 'empty';
}

function describe(p) {
  if (!p.convos.length) return 'inbox clear';
  return p.convos.map(c => `"${c.title}" ${c.unread} unread (reachable: ${c.reach})`).join('; ');
}

/* --mine asks the STORE which record this seat is, rather than guessing from a local name. The
 * uuid has to be passed explicitly: whoami runs on the store host and cannot see this machine's
 * CLAUDE_CODE_SESSION_ID, which is the defect that kept every remote seat anonymous. If the
 * lookup fails we do NOT fall back to watching everything — a filter that silently widens is
 * worse than one that refuses, because the operator asked for their own mail and would get a
 * turn for someone else's. */
async function resolveMine() {
  const uuid = process.env.CLAUDE_CODE_SESSION_ID;
  if (!uuid) throw new Error('--mine needs CLAUDE_CODE_SESSION_ID, and this environment has none');
  const cred = resolveCredential();
  const url = process.env.HANDOFF_REMOTE_URL;
  if (!url || !cred || cred.kind === 'incomplete') throw new Error('--mine needs a configured remote store');
  const text = await rpc(url, cred, 'whoami', { cli_uuid: uuid }, 15000);
  const m = /You are:\s*([^\s(@]+)/.exec(String(text || ''));
  if (!m || /unidentified/i.test(String(text))) {
    throw new Error(`the store does not know this seat yet (${String(text || '').trim()}) — register_session first`);
  }
  return m[1];
}

/* PEEK IS CALLED DIRECTLY RATHER THAN THROUGH makeStoreClient's peek(), for two reasons that are
 * both about not lying:
 *   - the client's peek(surface) builds its own args and drops title_contains, so a --title filter
 *     routed through it would be SILENTLY IGNORED and this watcher would report other people's
 *     mail while claiming to be filtered;
 *   - the LOCAL client has no peek at all. Rather than synthesise one, this file refuses on a local
 *     store and says why. A seat on the store's own host has working wake rungs and does not need
 *     a self-watcher; if that ever stops being true, the fix is a peek on the local client, not a
 *     guess here. */
async function peekDirect() {
  const cred = resolveCredential();
  const url = process.env.HANDOFF_REMOTE_URL;
  const args = { surface: SURFACE };
  if (TITLE) args.title_contains = TITLE;
  return rpc(url, cred, 'peek_inbox', args, 15000);
}

async function main() {
  const store = makeStoreClient({});
  if (store.mode !== 'remote') {
    throw new Error('this store is local to this host — a self-watcher is for a seat that reaches the store over the relay. On the store host the ordinary wake rungs apply.');
  }
  if (MINE && !TITLE) TITLE = await resolveMine();

  if (VERBOSE) {
    say(`[watch] ${store.describe()}`);
    say(`[watch] surface=${SURFACE}${TITLE ? ` title~"${TITLE}"` : ''} interval=${INTERVAL / 1000}s — peek only, nothing is marked read`);
  }

  let lastSig = null;
  let lastError = null;

  const cycle = async () => {
    let peek;
    try {
      peek = parsePeek(await peekDirect());
    } catch (e) {
      /* First failure speaks; repeats stay quiet. A store outage should cost one turn, not one
       * per cycle — but it must never cost zero, or an outage is indistinguishable from calm. */
      const msg = (e && e.message) || String(e);
      if (msg !== lastError) { lastError = msg; say(`[watch] STORE UNREACHABLE — ${msg}`); }
      return;
    }
    if (lastError) { lastError = null; say('[watch] store reachable again'); }

    const sig = signature(peek);
    if (!peek.parsed) {
      if (sig !== lastSig) { lastSig = sig; say(`[watch] could not read the peek reply — not claiming the inbox is empty: ${peek.raw.slice(0, 200)}`); }
      return;
    }
    if (sig === lastSig) { if (VERBOSE && !ONCE) say(`[watch] unchanged — ${describe(peek)}`); return; }

    const first = lastSig === null;
    lastSig = sig;
    if (peek.total === 0) { if (!first || VERBOSE) say('[watch] inbox clear'); return; }
    say(`[watch] MAIL WAITING — ${describe(peek)} · call check_inbox in that conversation to read it`);
    /* In exit-on-mail mode the FIRST cycle counts too: mail that was already waiting when the
     * watcher was armed is still news to a session that has not read it. Exiting here is the
     * whole notification, so it must not be conditional on the mail being newly arrived. */
    if (EXIT_ON_MAIL) process.exit(0);
  };

  await cycle();
  if (ONCE) return;

  /* setInterval, not a sleep loop, and cycles never overlap: a slow store must not stack calls. */
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try { await cycle(); } catch (e) { say(`[watch] cycle error — ${(e && e.message) || e}`); }
    running = false;
  }, INTERVAL);
}

main().catch((e) => {
  say(`[watch] refused to start — ${(e && e.message) || e}`);
  process.exit(1);
});
