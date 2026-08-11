'use strict';
/**
 * Daemon-side tool layer — slice 3a (the forwarder-swap core).
 *
 * The crux the whole slice exists to solve: the daemon is ONE process serving MANY sessions,
 * so per-session state — `pinned` (the terminal's claimed transaction), `cli_uuid`, `cwd` —
 * MUST arrive in `ctx` per request and NEVER live as a module global. This module reads only
 * `ctx` and the passed-in `core`; it keeps no per-session state of its own. That property is
 * exactly what makes two concurrent callers with different pins provably non-crossing
 * (daemon-smoke isolation test).
 *
 * 3a migrates the PIN-DEPENDENT tools (get_handoff, get_decisions) — the ones whose resolution
 * reads the pin, i.e. the only ones where a shared-process cross-read is even possible. The
 * remaining tools are stateless w.r.t. the pin and migrate in 3b, when mcp-handoff.js is cut
 * over from an in-process bridge to a pure forwarder. Until then the live bridge is untouched.
 */

/* ADDRESSABLE NAMES — a record answers to the title on it AND to the name the user gave the
 * terminal (native_ref.name, the handle on the tab). Every resolver used to read `title`
 * alone, which is not the name a user types: measured 2026-08-09, a send addressed to "build"
 * matched an app record merely CONTAINING that word, while the live terminal actually named
 * build (title "tunnel", native_ref.name "build") was never even a candidate. Three messages
 * went to a record with no native_ref, so the wake gate (dest.native_ref, send_message) was
 * false and nothing could ever start a turn there. One predicate, so a target reachable by
 * one resolver is reachable by all of them. */
function targetNames(s) {
  const out = [];
  /* THE NICKNAME IS FIRST, because it is the name a human types from memory when they have lost
   * everything else. It was stored before it was addressable — a recovery path nothing resolved
   * by, which is a recovery path only on paper.
   *
   * Uniqueness is NOT enforced when it is set (operator ruling, 2026-08-10, overruling R3's
   * set-time refusal): uniqueness is what ids are for, and a name that refuses is a name
   * pretending to be an id. Two sessions may both answer to "maple". The burden moves here, to
   * resolution, where this file already has the grammar for it — exact beats substring, several
   * matches are LISTED and never scored. Applying that to one more field is the whole change. */
  if (s && typeof s.nickname === 'string' && s.nickname) out.push(s.nickname);
  if (s && typeof s.title === 'string') out.push(s.title);
  if (s && s.native_ref && typeof s.native_ref.name === 'string') out.push(s.native_ref.name);
  return out;
}
/* THE DELIVERY SENTENCE, EXTRACTED SO IT CAN BE TESTED WITHOUT SPAWNING ANYTHING.
 *
 * Every branch below is doctrine written as user-facing copy, and each one was paid for:
 *
 *   relay        — A12. It used to read "Started a turn in X — no tap needed": an effect of the
 *                  operation just performed, asserted as history, in the tool result the sender
 *                  repeats to the user. Never measured — the relay is detached and fire-and-forget,
 *                  so a dispatch proves a process started and NOTHING about whether ListAgents
 *                  found the target or SendMessage delivered. While the launchd-PATH defect stood,
 *                  no process started at all, so the sentence was not merely unverified but false
 *                  every time. Say what was measured; phrase the effect as intent.
 *   notify+stale — NEVER say "closed" here; it may well be open. Native exposes no session lineage
 *                  (parentUuid is null across a resume), so a resumed terminal we have not heard
 *                  from is unknowable from outside. Say that, and say the two-step out loud.
 *   notify/store — DIFFERENT FACTS, so different sentences. 'notify' means a human was told.
 *                  'store' means nobody was told and the mail waits on someone happening to look.
 *                  Reporting them identically is what let a silent degrade hide for a whole
 *                  platform (Windows had no notify rung at all and said nothing). Neither claims a
 *                  turn started, because neither did.
 *   remote       — UNREACHABLE is its own outcome, not a flavour of the generic line, and the
 *                  difference is a promise. A record owned by another device has native_ref NULL by
 *                  design, so no rung is ever attempted. The old fallback said "It arrives when
 *                  that conversation next checks", which nothing in any build could cause; two
 *                  messages went to a remote record on that promise. Not `held` — held implies a
 *                  holder that might release, and there is none. Not a refusal either: the durable
 *                  write is correct and BECOMES deliverable the instant an agent claims the record,
 *                  so refusing would fix a sentence by breaking the feature.
 *
 * WHY IT IS A FUNCTION NOW. This chain lived inline in the send handler, so the only way to reach
 * a branch was to drive the whole send path with a real wake result — which is exactly why the CI
 * seam returned woke:true, and therefore why the seam LIED. The lying seam existed to make
 * untestable copy testable. Extracting it is the seam fix's completion: leaving the pressure that
 * created the lie would leave the lie's cause. Pure, no state, no I/O — every sentence assertable
 * byte-for-byte without a subprocess. Coverage went 1-of-8 to 8-of-8 in the same change.
 */
function deliveryNoteFor(woke, dest, windowName) {
  if (woke && woke.tier === 'relay') return `Asked "${windowName}" to start a turn (relay dispatched — not yet confirmed; if it does not pick up, the message is waiting in its inbox). `;
  if (woke && woke.tier === 'channel') return `Delivered straight into "${windowName}" — no tap needed. `;
  if (woke && woke.tier === 'notify' && woke.stale_binding) {
    return `"${windowName}" could not be verified as open — its identity pointer is stale, which is what a resume looks like from outside${woke.candidates ? ` (${woke.candidates} live session(s) in that workspace; I will not guess which)` : ''}. Notified instead; opening it heals the binding and the next send wakes it with no tap. `;
  }
  if (woke && woke.tier === 'notify') return `"${windowName}" is closed — a notification went out naming that window. Nothing has started there; opening it delivers the message. `;
  if (woke && woke.tier === 'store') return `"${windowName}" is closed and no notification could be sent — the message is stored; say anything in that window and it arrives on the next turn. `;
  if (dest && dest.remote && !dest.native_ref) {
    /* CORRECTED IN THE FIELD, 2026-08-10, by the peer this sentence is about. It used to end
     * "...so nothing will cause it to be read", and a session on that device disproved it in the
     * most direct way available: it ran check_inbox and the message came back. The record is
     * READABLE ON DEMAND, not undeliverable — what is missing is the PUSH, not the read. The old
     * wording was true of one direction and stated as if it were true of both, which is the same
     * overclaim this branch was written to replace ("It arrives when that conversation next
     * checks", promising an arrival nothing could cause). Understating a capability is a smaller
     * sin than overstating one and still worth fixing: a reader who believes a message is
     * unreachable will not go and look. */
    return `Stored for "${dest.title}" on ${dest.remote.host}. NOT IN FLIGHT: no transport leg can PUSH it, so nothing will start a turn there. Someone on that device can still read it by asking (check_inbox), and it drains automatically once an agent on ${dest.remote.host} claims that record. `;
  }
  return `It arrives when that conversation next checks. `;
}

/* THE JOIN — a host-asserted verdict, read where the question is asked.
 *
 * A heartbeat writes into agents[host].sessions[recordId]. A record's own row carries no
 * `reachable` field, so anything that answers "can this be reached" by inspecting the RECORD sees
 * nothing and says so. That is how `resolve_conversation` came to tell an operator a machine "has
 * no agent claiming it" while that machine's agent was heartbeating and had asserted a verdict for
 * exactly that record — the copy keyed on `!native_ref`, which is true of EVERY remote record by
 * design, rather than on whether anyone had actually spoken for it.
 *
 * Module-level on purpose: the same computation existed already, nested inside the peek block and
 * therefore unreachable from the resolver, which is why the resolver invented a weaker test instead
 * of using it. One join, used by every asker — that is the whole of the ruling.
 *
 * Returns 'process' | 'none' | 'stale-binding' when a live agent has spoken, and 'unknown' when
 * nobody has. 'unknown' means NOBODY HAS LOOKED — never "unreachable". */
const HEARTBEAT_STALE_MS = 3 * 30 * 1000; // ~3 poll intervals at the 30s upper bound
function agentVerdictFor(host, recordId, st) {
  const beat = (st && st.agents && st.agents[host]) || null;
  if (!beat || !beat.last_seen) return 'unknown';
  const age = Date.now() - Date.parse(beat.last_seen);
  if (!(age >= 0) || age > HEARTBEAT_STALE_MS) return 'unknown';   // a stale agent speaks for nobody
  return (recordId && beat.sessions && beat.sessions[recordId]) || 'unknown';
}

/** Substring match on any addressable name. */
function matchesName(s, q) {
  const t = String(q == null ? '' : q).trim().toLowerCase();
  if (!t) return false;
  return targetNames(s).some(n => n.toLowerCase().includes(t));
}
/** Whole-name match on any addressable name. Ranked ABOVE substring everywhere, so an exact
 * terminal name always beats an incidental word inside someone else's title. */
function matchesNameExact(s, q) {
  const t = String(q == null ? '' : q).trim().toLowerCase();
  if (!t) return false;
  return targetNames(s).some(n => n.trim().toLowerCase() === t);
}
/** The two-tier filter every by-name resolver applies: exact wins outright; substring only
 * when nothing matched whole. Returns the surviving candidates, never picks among them. */
function filterByName(list, q) {
  const exact = list.filter(s => matchesNameExact(s, q));
  return exact.length ? exact : list.filter(s => matchesName(s, q));
}

/* Explicit target beats pin; pin beats nothing — and nothing FAILS LOUD, never guesses (I2).
 * Mirrors mcp-handoff.js namedOrPinned, but resolves the pin from ctx, not a global. */
async function namedOrPinned(args, ctx, core) {
  const state = async () => (await core.handleApi('GET', '/api/state', {}, {})).payload;
  if (args && (args.session_id || args.title_contains)) {
    const st = await state();
    let hits = Object.values(st.sessions).filter(s => !s.archived);
    if (args.session_id) hits = hits.filter(s => s.id === args.session_id);
    if (args.title_contains) hits = filterByName(hits, args.title_contains);
    if (!hits.length) throw new Error(`no live session matches${args.session_id ? ' ' + args.session_id : ''}${args.title_contains ? ` "${args.title_contains}"` : ''}`);
    if (hits.length > 1) throw new Error(`${hits.length} sessions match — name one:\n` +
      hits.map(s => `- [${s.surface}] "${s.title}" · session_id: ${s.id}`).join('\n'));
    return { id: hits[0].id, session: hits[0] };
  }
  // Pinned path — from CTX, never a shared global. This is the isolation boundary.
  const st = await state();
  if (ctx && ctx.pinned && !st.sessions[ctx.pinned]) {
    throw new Error(`pinned session ${ctx.pinned} no longer exists on the backend (was it reseeded with force?)`);
  }
  if (!ctx || !ctx.pinned) {
    throw new Error('this session is not pinned to any transaction — refusing to guess one (I2). ' +
      'Pin one with pick_up or continue_from, or name the target explicitly (session_id / title_contains).');
  }
  return { id: ctx.pinned, session: st.sessions[ctx.pinned] };
}

/* t21 Bug A — the inbox filtered on kind==='xmsg' and nothing else, so a return
 * (written by resolveLink as kind 'resume_summary') could never be counted unread nor
 * listed by check_inbox. The payload was delivered and then structurally hidden. Both
 * kinds are unread-able now; only their labels differ. */
/* Two-tier model (2026-08-08): 'receipt' is gone from this set ON PURPOSE, and the core
 * refuses to write the kind at all. Attention tier (xmsg, resume_summary) is drainable
 * and owed; receipts are ambient STATE on the send record (read_at/read_in), rendered
 * inline by status and never counted unread. Earlier the same day receipts were briefly
 * an unread-able kind — that made a state change drainable, which is how one session's
 * drain ate another terminal's ✓✓. */
const UNREAD_KINDS = new Set(['xmsg', 'resume_summary']);
/* ONE MALFORMED RECORD MUST NOT BLIND THE WHOLE SURFACE. These read `messages` off every
 * session status enumerates, and a record without the array threw — taking down status AND
 * whoami for every session in the store, not just the broken one. Measured 2026-08-10: a
 * two-field stub (`{id, title}`) left in the live store by daemon-smoke's id-invariant test
 * made "which session is this" unanswerable, at the exact moment a cleared session needed to
 * ask it. The store is shared and append-only, so it will always be possible for something to
 * write a record this layer did not expect; the reader treats an absent history as an empty
 * one rather than as a reason to refuse an answer about 65 healthy records. */
function messagesOf(s) {
  return (s && Array.isArray(s.messages)) ? s.messages : [];
}
function lastCheckIndex(s) {
  return messagesOf(s)
    .map((m2, i) => (m2.kind === 'progress' && /^inbox checked/.test(m2.text)) ? i : -1)
    .reduce((a, b) => Math.max(a, b), -1);
}
function freshMessages(s) {
  const lastCheck = lastCheckIndex(s);
  return messagesOf(s).filter((m2, i) => UNREAD_KINDS.has(m2.kind) && i > lastCheck);
}
function unreadCount(s) {
  return freshMessages(s).length;
}
function unreadReturnCount(s) {
  return freshMessages(s).filter(m => m.kind === 'resume_summary').length;
}

/* Cowork sessions ALSO have a local store (macOS: ~/Library/Application Support/Claude/
 * local-agent-mode-sessions). Enumerate best-effort so "every conversation that is
 * locally knowable is listable" — titles live in the app's private metadata, so entries
 * may be untitled; recency and existence are still real. App CHAT conversations remain
 * server-side and undiscoverable — that boundary needs a platform API. */
function localCoworkSessions(limit) {
  const fs = require('fs'), os = require('os'), path = require('path');
  const root = process.env.COWORK_SESSIONS_DIR ||
    path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions');
  const out = [];
  try {
    const walk = (dir, depth) => {
      if (depth > 3 || out.length > 100) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const p = path.join(dir, e.name);
        if (/^local_|^[0-9a-f-]{30,}/.test(e.name) && depth >= 1) {
          let title = null;
          try {
            for (const f of fs.readdirSync(p).slice(0, 10)) {
              if (f.endsWith('.json') && fs.statSync(path.join(p, f)).size < 65536) {
                const m = fs.readFileSync(path.join(p, f), 'utf8').match(/"(?:title|name|summary)"\s*:\s*"((?:[^"\\]|\\.){4,80})"/);
                if (m) { try { title = JSON.parse('"' + m[1] + '"'); } catch (_) {} break; }
              }
            }
          } catch (_) {}
          out.push({ id: e.name, title, mtime: fs.statSync(p).mtimeMs });
        } else walk(p, depth + 1);
      }
    };
    walk(root, 0);
  } catch (_) { /* store absent or non-mac */ }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit || 5);
}

/* ---- status report (slice 3b-9) ----
 * buildStatusReport + attentionBanner move whole. The four values they read that are NOT
 * store state — pinned, identity, cli_uuid, and staleness — are threaded through ctx. That
 * last one is the interesting one: "is the code serving me out of date?" is a question about
 * the CALLING process, so it can never be daemon state. The bridge answers it with
 * isBridgeStale(); a forwarder answers false, because a daemon reports its own staleness
 * through the fatal daemon_stale envelope instead of a line in a status report.
 */
async function attentionBanner(ctx, core) {
  const call = async (m, p, q, b) => (await core.handleApi(m, p, q || {}, b || {})).payload;
  try {
    const st = await call('GET', '/api/state');
    const sessions = Object.values(st.sessions || {}).filter(s => !s.archived);
    const settled = settledDestIds(st);
    const pending = sessions.filter(s => offerIsPending(s, settled)).length;
    const returns = sessions.reduce((n, s) => n + unreadReturnCount(s), 0);
    const unread = sessions.reduce((n, s) => n + unreadCount(s), 0) - returns;
    if (!pending && !unread && !returns) return '';
    const bits = [];
    if (returns) bits.push(`${returns} completed return${returns === 1 ? '' : 's'} unread`);
    if (pending) bits.push(`${pending} pending handoff${pending === 1 ? '' : 's'}`);
    if (unread) bits.push(`${unread} unread`);
    return `Heads-up: ${bits.join(', ')} — call status or /status for the next action.\n\n`;
  } catch (_) {
    return '';
  }
}
async function buildStatusReport(args, ctx, core) {
  const call = async (m, p, q, b) => (await core.handleApi(m, p, q || {}, b || {})).payload;
  // Forwarder-local state, threaded in rather than read from globals. `stale` is the
  // CALLER'S staleness: for the in-process bridge that is isBridgeStale(); a forwarder
  // talking to a daemon is never stale in this sense (the daemon reports its own via the
  // fatal daemon_stale envelope instead), so it simply passes false.
  const pinnedId = (ctx && ctx.pinned) || null;
  const identityId = (ctx && ctx.identity) || null;
  const nativeId = (ctx && ctx.cli_uuid) || null;
  const path = require('path');
  const home = process.env.HANDOFF_HOME || path.join(require('os').homedir(), '.claude-handoff');
  const stale = !!(ctx && ctx.stale);
  const lines = [];
  lines.push(stale
    ? 'Bridge: ⚠ STALE — restart this Claude session / the Claude app before any handoff'
    : 'Bridge: ✓ current (this process matches on-disk mcp-handoff.js)');
  lines.push(`Store:  ${home}`);
  lines.push(`Pinned: ${pinnedId || '(no transaction pinned — pick_up / continue_from sets it)'}`);
  /* Identity is RESOLVED from the store below, not read from ctx.identity. ctx.identity is
   * the calling bridge's in-memory cache, set only when register_session ran in THIS process
   * — so after a resume (new process, same uuid, record alive and refreshing itself on every
   * contact) status announced "not yet registered" about a terminal that was registered and
   * healthy. A cached value reporting on live state is the same disease this whole arc is
   * about, in the surface whose only job is to tell the truth about state. Placeholder now,
   * filled once the store is loaded. */
  const identityLine = lines.length;
  lines.push('');
  // WHO AM I, first line, before any machinery. You may be running two terminals, and the
  // question you actually arrive with is "which one is this and what do I call it" — so status
  // answers that before it reports on itself. Ids are for machines; this line is for you.
  const whoLine = lines.length;
  lines.push('');

  let st;
  try {
    st = await call('GET', '/api/state');
  } catch (e) {
    lines[identityLine] = `Identity: ${identityId || 'unresolved (store unreadable)'}`;
    lines.push(`Store read failed: ${e.message}`);
    lines.push('Next: fix HANDOFF_HOME permissions, then call status again.');
    return lines.join('\n');
  }

  const sessions = Object.values(st.sessions || {}).filter(s => !s.archived);
  // The record this terminal's LIVE uuid actually binds to — the authority, over any cache.
  const boundRecord = nativeId
    ? sessions.find(s => s.native_ref && s.native_ref.session_id === nativeId) || null
    : null;
  const workspace = (() => {
    const c = (boundRecord && boundRecord.native_ref && boundRecord.native_ref.cwd) || (ctx && ctx.cwd) || null;
    return c ? require('path').basename(c) : null;
  })();
  /* TWO NAMESPACES, ONE OF THEM READ-ONLY TO US. `title` is the protocol name — what /name
   * sets, what send_message resolves. `native_ref.name` is Claude Code's own registry name —
   * what ListAgents and native SendMessage resolve. register_session only ever READS native's
   * registration and adopts the name; nothing here can write native's registry back. So a
   * /name'd session is addressable by handoff and INVISIBLE to ListAgents under that name.
   * Measured 2026-08-09: a peer could not find a /name’d session by its title and addressed it by its native name,
   * and the only way to see the split was to grep two stores. Print both whenever they differ
   * — a divergence the user cannot see is one they cannot work around. */
  const nativeDisplay = boundRecord && boundRecord.native_ref && boundRecord.native_ref.name;
  const nameSplit = nativeDisplay && nativeDisplay !== (boundRecord && boundRecord.title)
    ? ` (native: ${nativeDisplay})` : '';
  /* The contest goes IN the who-am-I line, not in a footnote, because whoami renders only
   * that line — and this is precisely the fact someone asking "which session is this" needs.
   * It was found twice by noticing a corrupted name; a warning someone has to go looking
   * for would not have helped either time. */
  const rivals = otherLiveClaimants(nativeId, (ctx && ctx.cli_pid) || null);
  const contestNote = rivals.length
    ? ` ⚠ SHARED SESSION: ${rivals.map(r => `pid ${r.pid}${r.name ? ` ("${r.name}")` : ''}`).join(', ')} also live on this session id — renames are refused while that is true. Give one of them its own session: exit and start plain \`claude\` (not --continue, which resumes the most recent session in this DIRECTORY, and not --resume of the same id).`
    : '';
  lines[whoLine] = boundRecord
    ? `You are: ${boundRecord.title}${nameSplit}${boundRecord.role ? ` (@${boundRecord.role}` : ' ('}${boundRecord.role ? ' · ' : ''}${boundRecord.surface}${workspace ? ` · ${workspace}` : ''})${contestNote}`
    : (nativeId
      ? `You are: this terminal has no name yet${workspace ? ` (${workspace})` : ''} — name it with /name <one word>, e.g. /name build${contestNote}`
      : 'You are: unidentified (no CLI uuid in this environment)');
  lines[identityLine] = `Identity: ${boundRecord
    ? `${boundRecord.id} — "${boundRecord.title}"${nameSplit} (CLI ${nativeId.slice(0, 8)}…)`
    : (identityId || (nativeId
      ? `CLI ${nativeId.slice(0, 8)}… not yet registered (auto on first send; register_session names a title/role)`
      : 'unavailable — CLAUDE_CODE_SESSION_ID unset, sends will carry no sender and receipts cannot route back'))}`;
  // "Mine" = records THIS session may legitimately drain: its pin, its registered identity,
  // and any record keyed to this terminal's CLI uuid. check_inbox drains a whole surface, so
  // Next-action must never point at a conversation that is not mine — that would eat another
  // session's mail before that session ever reads it.
  const mineIds = new Set([pinnedId, identityId].filter(Boolean));
  if (nativeId) for (const s of sessions) if (s.native_ref && s.native_ref.session_id === nativeId) mineIds.add(s.id);
  const settled = settledDestIds(st);
  const pending = sessions.filter(s => offerIsPending(s, settled));
  const withUnread = sessions.map(s => ({ s, n: unreadCount(s), returns: unreadReturnCount(s) })).filter(x => x.n > 0);
  // t21 Bug A/#4 — returns get their own section. A completed return and an unclaimed
  // offer are opposite states and must never render in the same list again.
  const withReturns = withUnread.filter(x => x.returns > 0);
  const withMsgs = withUnread.filter(x => x.n - x.returns > 0);
  // Only my own records are drainable-by-me for the Next action; the rest belong to other
  // conversations and are delivered by their own sessions.
  const myReturns = withReturns.filter(x => mineIds.has(x.s.id));
  const myMsgs = withMsgs.filter(x => mineIds.has(x.s.id));
  const othersWaiting = (withReturns.length - myReturns.length) + (withMsgs.length - myMsgs.length);
  let workers = [];
  try { workers = await call('GET', '/api/workers'); } catch (_) { workers = []; }
  const working = workers.filter(w => w.working);
  const orphaned = workers.filter(w => w.orphaned);

  if (pending.length) {
    // The old suffix came from notes.expected_return — i.e. from whether a return was
    // ever ASKED for, so a returned and an unreturned transaction rendered identically
    // (t21 Bug B). It now reads the link, the only field that knows what arrived.
    const linkFor = s => Object.values(st.links || {}).find(l => l.dest === s.id);
    // Newest first, and say what was cut. Insertion order buried the offer the user just
    // made under months of stale ones — the same drowning that made "pending handoffs"
    // an unreliable worklist in t21, and that pointed Next: at the wrong transaction.
    const ordered = [...pending].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    lines.push(`\nPending handoffs (unshaken — pick_up to claim, newest first):\n` +
      ordered.slice(0, 8).map(s => {
        const l = linkFor(s);
        const owed = l && l.status === 'active' ? ' · return owed (nothing back yet)' : '';
        return `- [${s.surface}] "${s.title}" ← ${s.origin_ref.surface}${owed}`;
      }).join('\n') +
      (ordered.length > 8 ? `\n  (+${ordered.length - 8} older pending offer(s) not shown — list_conversations for all)` : ''));
  } else {
    lines.push('\nPending handoffs: none');
  }

  if (withReturns.length) {
    lines.push(`Returns waiting (work came BACK — check_inbox on that surface to read it):\n` +
      withReturns.slice(0, 8).map(({ s, returns }) =>
        `- [${s.surface}] "${s.title}" · ${returns} return${returns === 1 ? '' : 's'} delivered, unread`).join('\n'));
  } else {
    lines.push('Returns waiting: none');
  }

  if (withMsgs.length) {
    lines.push(`Unread inbox (check_inbox on that surface):\n` +
      withMsgs.slice(0, 8).map(({ s, n, returns }) => `- [${s.surface}] "${s.title}" · ${n - returns} unread`).join('\n'));
  } else {
    lines.push('Unread inbox: none');
  }

  // Ambient tier: read state (✓✓) on THIS identity's own sends, rendered inline and
  // settled on display — shown once, never unread, never an inbox item. A send that was
  // refused at write time errored loudly at the sender already, so absence of a line
  // here means "not read yet", nothing else (native parity: refused makes no notice).
  const ambient = [];
  for (const s of Object.values(st.sessions || {})) {
    for (const m2 of s.messages || []) {
      if (m2.from_session && mineIds.has(m2.from_session) && m2.read_at && !m2.settled_at) {
        ambient.push({ sid: s.id, mid: m2.id, read_at: m2.read_at, in: m2.read_in || { surface: s.surface, title: s.title } });
      }
    }
  }
  if (ambient.length) {
    const hhmm = t => { const d = new Date(t); return isNaN(d) ? String(t) : d.toTimeString().slice(0, 5); };
    lines.push(`Your sends (ambient — settled on display, not counted above):\n` +
      ambient.slice(0, 8).map(a => `- your send to [${a.in.surface} · ${a.in.title}]: ✓✓ read ${hhmm(a.read_at)}`).join('\n') +
      (ambient.length > 8 ? `\n  (+${ambient.length - 8} more, settled unshown)` : ''));
    for (const a of ambient) {
      try { await call('POST', `/api/sessions/${a.sid}/messages/${a.mid}/state`, {}, { settle: true }); } catch (_) {}
    }
  }

  if (workers.length) {
    lines.push(`Workers: ${workers.length} total` +
      (working.length ? `, ${working.length} still working` : '') +
      (orphaned.length ? `, ⚠ ${orphaned.length} orphaned` : ''));
  } else {
    lines.push('Workers: none');
  }

  const surfaceHint = (args && args.surface) ? ` on ${args.surface}` : '';
  // Priority: live handoffs/inbox first. Orphans are debris — mention them, but do not
  // steal Next: from a pending offer the user is actively trying to claim (field failure
  // 2026-08-06: 4 landing-page orphans drowned a Design docs pick_up).
  let next;
  if (stale) {
    next = 'Restart this Claude session (and the Claude app if needed), then call status again.';
  } else if (myReturns.length) {
    // Ranked above pending offers: an unread return is work the user already finished
    // sitting undelivered, and t21 is the record of what it costs to miss one. Only MINE —
    // a title_contains scopes the drain to this record so no sibling conversation is eaten.
    const r = myReturns[0];
    next = `check_inbox surface:${r.s.surface} title_contains:"${r.s.title.slice(0, 40)}" — ${r.returns} completed return(s) delivered to THIS session, unread.`;
  } else if (pending.length) {
    const p = [...pending].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    next = `In a ${p.surface} conversation: pick_up title_contains:"${p.title.slice(0, 60)}" — claim the waiting handshake${surfaceHint}.`;
  } else if (myMsgs.length) {
    const u = myMsgs[0];
    next = `check_inbox surface:${u.s.surface} title_contains:"${u.s.title.slice(0, 40)}" — deliver ${u.n - u.returns} message(s) queued to THIS session.`;
  } else if (othersWaiting) {
    // Unread exists, but on conversations that are not mine. Draining them here would consume
    // another session's mail before it reads it — so Next never suggests it (item, 2026-08-08).
    next = `Nothing for this session to drain. ${othersWaiting} unread item(s) belong to OTHER conversations — each is delivered by its own session when it next checks; do not drain them from here.`;
  } else if (working.length) {
    next = `list_workers / get_worker_result — ${working.length} worker(s) still running.`;
  } else if (orphaned.length) {
    next = `Close or reopen orphaned worker ${orphaned[0].worker_id} (return_to_origin outcome:"failed", or reopen via its native resume).`;
  } else if (!sessions.length) {
    next = 'Fresh install ✓ — from any chat: /handoff code (or "hand this off to Claude Code").';
  } else {
    next = 'Nothing waiting. /handoff <surface>, /btw <side task>, or /pull <surface> when you need to move work.';
  }
  if (orphaned.length && pending.length) {
    lines.push(`Note: ${orphaned.length} orphaned worker(s) still in the store — clean up after the pending handoff, not before.`);
  }
  lines.push(`\nNext: ${next}`);
  return lines.join('\n');
}

/** Tools migrated to the shared daemon tool layer (served identically by the in-process
 * bridge and the daemon's tools/call). 3a: get_handoff, get_decisions. 3b: report_progress,
 * get_worker_result, then the pin WRITERS pick_up + continue_from (3b-5) — the first tools
 * that actually exercise the contract-v2 ctx_update envelope. */
const MIGRATED = new Set([
  'get_handoff', 'get_decisions', 'report_progress', 'get_worker_result',
  'pick_up', 'continue_from', 'return_to_origin',
  'resolve_conversation', 'send_message', 'send_to', 'send_to_surface', 'status', 'whoami',
  'send_to_worker', 'list_conversations', 'resume_code_session', 'open_conversation',
  'check_inbox', 'peek_inbox', 'register_remote_session', 'agent_heartbeat', 'withdraw_handoff', 'decline_handoff', 'list_workers',
]);

/** Run a migrated tool against `core` with the caller's per-request `ctx`. */
async function callTool(name, args, ctx, core) {
  const call = async (m, p, q, b) => (await core.handleApi(m, p, q || {}, b || {})).payload;
  // Every contact from a terminal refreshes its binding, so a resumed session repairs its
  // own pointer as a side effect of doing anything at all — including draining the very
  // notification a stale binding caused. That is what makes the two-step close: send #1
  // notifies, the drain heals, send #2 wakes with zero taps.
  await touchBinding(ctx, core);
  if (name === 'status') return buildStatusReport(args || {}, ctx, core);
  /* whoami — status's first line, alone. The same answer, without making you read a health
   * report to get it. One source: it IS the status line, sliced, so the two can never drift. */
  if (name === 'whoami') {
    const full = await buildStatusReport({}, ctx, core);
    const line = String(full).split('\n').find(l => l.startsWith('You are:'));
    return line || 'You are: unidentified (no CLI uuid in this environment)';
  }
  /* AGENT HEARTBEAT — the one verb the remote door was widened for.
   *
   * A wake agent on a second machine can peek (peek_inbox) and deliver (send_message) but had no
   * way to write its own verdict, which is the single act that flips a record from reachability
   * 'unknown' to host-asserted. So the acceptance test that this whole review was opened around
   * could not be closed from any machine — not for want of an agent, for want of a verb.
   *
   * THE DOOR WIDENS FOR THE ACCEPTANCE TEST, NEVER FOR A CONVENIENCE, and that is why there is no
   * state-read tool beside this one. A remote agent cannot enumerate the store and does not need
   * to: it asserts verdicts for records that name its host. Enumeration would be a convenience,
   * and the relay is fail-closed by design — it exposes the minimum or it stops being able to
   * claim it does. DO NOT "COMPLETE" THIS by adding a state read; the gap is deliberate.
   *
   * OWN-HOST ONLY, ENFORCED HERE. Liveness may be asserted only by the agent on the record's own
   * host — a pid means nothing on another machine, and a verdict from elsewhere is a guess wearing
   * a fact's clothes. The core route accepts any host because it is the store's write path and
   * trusts its caller; the verb is where a remote caller is checked. A heartbeat naming records
   * that belong to another host is refused whole, not filtered: silently dropping the offending
   * entries would let a caller believe it had asserted something it had not. */
  if (name === 'agent_heartbeat') {
    const host = String((args && args.host) || '').trim();
    if (!host) return 'Refused: host required — a heartbeat that cannot name its host asserts liveness on nobody\'s behalf.';
    const sessions = (args && args.sessions && typeof args.sessions === 'object') ? args.sessions : {};
    const st = await call('GET', '/api/state');
    const foreign = [];
    for (const sid of Object.keys(sessions)) {
      const rec = (st.sessions || {})[sid];
      if (!rec) { foreign.push(`${sid} (no such record)`); continue; }
      const declared = (rec.remote && rec.remote.host) || (rec.native_ref && rec.native_ref.host) || null;
      if (declared && declared !== host) foreign.push(`${sid} (belongs to ${declared})`);
    }
    if (foreign.length) {
      return `Refused: this heartbeat names ${foreign.length} record(s) that do not belong to "${host}" — ${foreign.join(', ')}. ` +
        'A host may assert liveness only for its own records; a verdict from another machine is a guess wearing a fact\'s clothes. ' +
        'NOTHING was written — the heartbeat is refused whole rather than filtered, so you never believe you asserted something you did not.';
    }
    /* DEFAULT VERDICT — how a host speaks for records it cannot enumerate.
     *
     * Reachability is keyed per record: remoteVerdict reads beat.sessions[recordId], so a host with
     * no per-record map flips nothing. And a remote agent CANNOT build that map, because there is
     * deliberately no state-read tool. Widening the door for a heartbeat alone would therefore have
     * shipped a verb that could not do the thing it was approved for — found by wiring the agent to
     * it rather than by reading either.
     *
     * So the caller may send ONE verdict for all of its own records, and the expansion happens HERE,
     * server-side, where the store already lives. The remote surface gains no read: the caller
     * names a verdict, never learns which records exist, and the response carries a count rather
     * than a list. Own-host-only still holds — expansion is restricted to records declaring this
     * host, so a default verdict cannot reach anyone else's. */
    const merged = Object.assign({}, sessions);
    const dv = args && args.default_verdict;
    if (dv) {
      if (!['process', 'none', 'stale-binding'].includes(dv)) {
        return `Refused: default_verdict "${dv}" is not one of process | none | stale-binding. "unknown" is never written — an agent that is running has looked, so it always has a real answer for its own records.`;
      }
      for (const [sid, rec] of Object.entries(st.sessions || {})) {
        if (rec && rec.archived) continue;
        const declared = (rec.remote && rec.remote.host) || (rec.native_ref && rec.native_ref.host) || null;
        if (declared === host && merged[sid] === undefined) merged[sid] = dv;
      }
    }
    const r = await call('POST', '/api/agents/heartbeat', {}, {
      host, sessions: merged, agent_version: (args && args.agent_version) || null, owns: (args && args.owns) || Object.keys(merged).length,
    });
    /* CHECK THE EFFECT, NOT THE CALL — and this verb failed its own repo's rule on its first real
     * use. It reported "Heartbeat recorded" against a store whose route returned 404: the notebook
     * build has no /api/agents/heartbeat at all, never mirrored from the S2 work, so the write went
     * nowhere and the caller was congratulated. An agent polling that build would have reported a
     * healthy cycle forever while every record it owned stayed 'unknown'.
     *
     * So the response is verified rather than assumed: an agent record must come back carrying the
     * verdicts we sent. Anything else is reported as the failure it is, naming what came back. */
    const a = (r && r.agent) || null;
    const wrote = a && a.sessions && Object.keys(a.sessions).length;
    if (!a) {
      return `Heartbeat FAILED for "${host}": the store did not return an agent record — ${r && r.error ? r.error : 'no route or no reply'}. NOTHING was recorded, and reachability for this host's records still reads "unknown". This is a store-side gap, not a caller error.`;
    }
    if (Object.keys(merged).length && !wrote) {
      return `Heartbeat FAILED for "${host}": ${Object.keys(merged).length} verdict(s) were sent and the store recorded none. Nothing flipped; do not treat this as a delivered heartbeat.`;
    }
    /* THE ECHO — the ids this caller just asserted over, returned to it.
     *
     * The remote surface deliberately offers no state read: a peer names a verdict and never learns
     * which records exist. That rule stands, and this does not breach it — these are the records the
     * CALLER ITSELF just wrote to, echoed back. It learns nothing about the store it did not assert
     * a moment earlier.
     *
     * It is needed because "deliver only for records your own host owns" is unimplementable without
     * it: a remote agent cannot enumerate, so without the echo it must either deliver blind to
     * whatever peek shows it — including other machines' records — or not deliver at all. The
     * ownership rule and the delivery slice cannot both hold otherwise. Written on one line so the
     * agent can parse it without a schema, and omitted entirely when nothing was written. */
    const echo = Object.keys(merged).filter(id => merged[id] !== undefined);
    return `Heartbeat recorded for "${host}": ${wrote || 0} record(s) carry a host-asserted verdict, agent ${a.agent_version || 'unversioned'}. ` +
      'Reachability for those records now reads what THIS host observed, not "unknown".' +
      (echo.length ? `\nOWNED: ${echo.join(' ')}` : '');
  }
  if (name === 'get_handoff') {
    const { id } = await namedOrPinned(args, ctx, core);
    return (await call('GET', `/api/sessions/${id}/brief`, { for: 'code' })).brief;
  }
  if (name === 'get_decisions') {
    const { session } = await namedOrPinned(args, ctx, core);
    return session.decisions.length
      ? session.decisions.map(d => `- ${d.text} (source: ${d.source_message})`).join('\n')
      : 'No locked decisions.';
  }
  if (name === 'report_progress') {
    if (!args || !args.summary) throw new Error('summary required');
    const { id } = await namedOrPinned(args, ctx, core);
    await call('POST', `/api/sessions/${id}/messages`, {}, { role: 'system', kind: 'progress', text: args.summary });
    return 'Progress recorded. Linked origin sessions will surface this as a "While you were away" summary on resume.';
  }
  if (name === 'get_worker_result') {
    const ws = await call('GET', '/api/workers');
    if (!ws.length) return 'No workers exist yet.';
    const w = (args && args.worker_id) ? ws.find(x => x.worker_id === args.worker_id) : ws[ws.length - 1];
    if (!w) throw new Error('no such worker: ' + (args && args.worker_id));
    if (w.status === 'resolved') return `Worker ${w.worker_id} (already retrieved):\n${w.summary || 'no summary recorded'}`;
    if (w.status === 'failed') return `Worker ${w.worker_id} FAILED (transaction closed honestly — the blocker was delivered to the origin). Task: ${w.task}`;
    const nat = w.native_ref ? `\nReopen the actual worker session anytime: ${w.native_ref.resume}` : '';
    if (w.orphaned) return `⚠ Worker ${w.worker_id} looks ORPHANED — no progress and silent past the threshold. Task: ${w.task}${nat}\nEither reopen it, or close the transaction honestly: return_to_origin outcome:"failed" from its session, or resolve here once you know the real outcome.`;
    if (w.working) return `Worker ${w.worker_id} is still working — no progress reported yet. Task: ${w.task}${nat}`;
    const r = await call('POST', `/api/links/${w.link_id}/resolve`);
    return `Worker result (round-trip complete, link resolved):\n${r.message.text}${nat}`;
  }
  // ---- Pin WRITERS (slice 3b-5). These are the tools the contract-v2 envelope exists for.
  // They must NOT assign a module global: the daemon serves many sessions, so the new pin
  // travels back as `ctx_update: {pinned}` and the CALLER (bridge or forwarder) applies it to
  // its own per-session state. Returning { text, ctx_update } is the whole mechanism.
  if (name === 'pick_up') {
    const surface = (args && args.surface) || 'chat';
    const st = await call('GET', '/api/state');
    // Offer lifecycle: only state 'offered' is pending. Legacy records (pre-lifecycle)
    // infer completion from the picked-up marker; returned work overrides both (t21
    // Bug D — a resolved-but-still-'offered' transaction was handed out to pick_up,
    // which then claimed an unrelated brief in its place).
    const claimed = settledDestIds(st);
    const state = s => offerStateOf(s, claimed);
    let candidates = Object.values(st.sessions)
      .filter(s => s.surface === surface && s.origin_ref && !s.archived && state(s) === 'offered');
    if (args && args.session_id) candidates = candidates.filter(s => s.id === args.session_id);
    if (args && args.title_contains) {
      const t = args.title_contains.toLowerCase();
      candidates = candidates.filter(s => s.title.toLowerCase().includes(t));
    }
    if (!candidates.length) return `No pending handoff addressed to ${surface}${args && (args.session_id || args.title_contains) ? ' matching that filter' : ''}. Use send_to_surface from the other conversation first (a completed handshake is never re-offered; withdrawn/declined/superseded offers are gone).`;
    if (candidates.length > 1) {
      // Never guess between several pending handoffs — list and let the user choose.
      // NOTE: an ambiguity card is NOT a pin change — it returns a plain string, so no
      // ctx_update rides back and the caller's existing pin is left exactly as it was.
      return `${candidates.length} pending handoffs are addressed to ${surface} — which one?\n` +
        formatSessionCandidates(candidates, st) +
        `\nAsk by letter / recap / latest — then call pick_up again with session_id (you fill it) or title_contains.`;
    }
    const dest = candidates[0];
    // The handshake: atomic claim (409 if another surface shook it first), THEN brief.
    const c = await call('POST', `/api/sessions/${dest.id}/claim`, {}, { surface });
    const br = await call('GET', `/api/sessions/${dest.id}/brief`, { for: surface });
    let returnLine;
    if (!c.return_owed) {
      returnLine = `Handshake complete — the transaction is CLOSED, nothing is owed back. (To share results anyway, send_message reaches the origin by title.)`;
    } else if (surface === 'design') {
      returnLine = `A return is OWED, but Design conversations typically have NO handoff MCP tools (return_to_origin will not appear here). Do the design work, then from Claude Code run: return_to_origin title_contains:"${dest.title}" surface:design summary:<what you made>. That proxy-closes the link.`;
    } else {
      returnLine = `A return is OWED: when the work is done, return_to_origin with a summary (or outcome:"failed" with the blocker) — that closes the transaction.`;
    }
    // t23: claiming a handoff makes this CALLER that worker — pin it, exactly as
    // continue_from does. Without this, return_to_origin had nothing to resolve against
    // and fell through to "newest active link", which is how a close meant for the docs
    // brief landed on an unrelated transaction. The shake identifies the transaction;
    // the close should never have to re-derive it. Pre-3b-5 this was `PINNED = dest.id`
    // in the bridge; it is now the ctx_update the caller applies to ITS OWN pin.
    return {
      text: `Picked up "${dest.title}" into THIS conversation (handed off from ${dest.origin_ref.surface}). ` +
        returnLine + `\n\nContinue from this context:\n\n${br.brief}`,
      ctx_update: { pinned: dest.id },
    };
  }
  if (name === 'continue_from') {
    const surface = (args && args.surface) || 'chat';
    const st = await call('GET', '/api/state');
    let originId = (args && args.session_id) || null;
    if (!originId && args && args.title_contains) {
      const t = args.title_contains.toLowerCase();
      const hits = Object.values(st.sessions).filter(s => s.surface === surface && !s.archived && s.title.toLowerCase().includes(t));
      // AMBIGUITY ENFORCEMENT (t5/t11, same rule as resume_code_session): several
      // titled matches — or a same-titled local terminal session, which "resume X"
      // could equally mean — used to be self-resolved to the newest. Now: list, refuse.
      const term = localCodeSessions(30).filter(c2 => c2.title.toLowerCase().includes(t));
      if (hits.length + term.length > 1) {
        core.ops('route_ambiguous', { verb: 'continue_from', query: args.title_contains, app_candidates: hits.length, local_candidates: term.length });
        return `${hits.length + term.length} plausible referents match "${args.title_contains}" — NOT pulling until one is chosen. Ask the user which they meant (letter / recap / latest — not a raw sess_* id):\n` +
          (hits.length ? `Protocol-known ${surface} sessions (this tool pulls their work HERE):\n` + formatSessionCandidates(hits, st) + '\n' : '') +
          (term.length ? 'Local terminal sessions with the same title (NOT app conversations — resume_code_session reopens these in a Terminal):\n' + term.slice(0, 8).map(c2 => `- "${c2.title}" · ${age(c2.mtime)} · ${c2.folder}`).join('\n') + '\n' : '') +
          'Then: call again with session_id from the chosen card, or route to resume_code_session if they meant the terminal one.';
      }
      if (hits.length === 1) originId = hits[0].id;
      if (!hits.length && term.length) {
        core.ops('route_resolved', { verb: 'continue_from', outcome: 'redirect_terminal', query: args.title_contains });
        return `No protocol-known ${surface} session matches "${args.title_contains}", but ${term.length} local TERMINAL session(s) do:\n` +
          term.slice(0, 8).map(c2 => `- "${c2.title}" · ${age(c2.mtime)} · ${c2.folder}`).join('\n') +
          '\nThose are resumed with resume_code_session (opens a Terminal window), not pulled. Confirm with the user first.';
      }
    }
    if (!originId) originId = st.by_surface[surface];
    if (!originId || !st.sessions[originId]) throw new Error(`no protocol-known session on surface "${surface}"${args && args.title_contains ? ` matching "${args.title_contains}"` : ''}. App conversations join the protocol only by handing off from their own side — in that conversation say "hand this off to code" (/handoff code). The app exposes no transcript API; the protocol cannot reach in.`);
    core.ops('route_resolved', { verb: 'continue_from', explicit: !!(args && args.session_id), origin: originId, surface });
    const r = await call('POST', `/api/sessions/${originId}/continue`, {}, { to: 'code' });
    const br = await call('GET', `/api/sessions/${r.dest.id}/brief`, { for: 'code' });
    // The caller's session IS the worker now — pin travels back, never set as a global.
    return {
      text: `Pulled "${st.sessions[originId].title}" from ${surface} into this session. The origin stays resumable; report back with report_progress / return_to_origin.\n\n${br.brief}`,
      ctx_update: { pinned: r.dest.id },
    };
  }
  // ---- The CLOSE (slice 3b-6) — the pin CLEARER, the other half of the symmetric envelope.
  // Every path that actually settles a transaction returns ctx_update:{pinned:null}, so the
  // caller stops being pinned to a transaction that no longer exists. Every path that does
  // NOT settle (refusal, ambiguity, nothing-owed) returns a plain string and leaves the pin
  // alone — closing is the only thing that may unpin you.
  if (name === 'return_to_origin') {
    if (!args || !args.summary) throw new Error('summary required');
    // Resolution order: (1) explicit proxy dest (Design close from Code), (2) pinned worker.
    let id = null;
    if (args.session_id || args.title_contains) {
      const st = await call('GET', '/api/state');
      let hits = Object.values(st.sessions).filter(s => !s.archived);
      if (args.session_id) hits = hits.filter(s => s.id === args.session_id);
      if (args.surface) hits = hits.filter(s => s.surface === args.surface);
      if (args.title_contains) {
        const t = args.title_contains.toLowerCase();
        hits = hits.filter(s => s.title.toLowerCase().includes(t));
      }
      // Prefer sessions that actually owe a return.
      const owing = hits.filter(s =>
        Object.values(st.links || {}).some(l => l.dest === s.id && l.status === 'active')
      );
      const pool = owing.length ? owing : hits;
      if (!pool.length) {
        return `No session matches for proxy return${args.title_contains ? ` ("${args.title_contains}")` : ''}. Call status — pending/linked dests are listed there.`;
      }
      if (pool.length > 1) {
        return `${pool.length} sessions match — which dest owes the return?\n` +
          pool.map(s => `- [${s.surface}] "${s.title}" · session_id: ${s.id}`).join('\n') +
          '\nCall again with session_id (or a tighter title_contains + surface).';
      }
      id = pool[0].id;
      core.ops('route_resolved', { verb: 'return_to_origin', proxy: true, dest: id, surface: pool[0].surface });
    }
    // The pin comes from CTX, never a global — same isolation boundary as namedOrPinned.
    if (!id) id = (ctx && ctx.pinned) || null;
    if (!id) {
      // t23: this fallback used to silently take the NEWEST active link. Live failure
      // 2026-08-06: a close meant for the chat→code docs brief (link_4p93a170, 16:11)
      // landed on the unrelated t20 live check (link_5u395335, 21:12) purely because it
      // was newer. Both records were then wrong — one carried the other's failure text,
      // the other stayed open — and the response named no target, so nothing surfaced
      // the swap. Same rule as pick_up / continue_from (A6): among candidates, list and
      // refuse. Never guess which transaction the user meant to close.
      const st = await call('GET', '/api/state');
      const activeLinks = Object.values(st.links || {})
        .filter(l => l.status === 'active')
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      if (activeLinks.length) {
        // I2, final hole closed 2026-08-08: even exactly ONE open link is not license to
        // close it unnamed. "There was only one" is a fact about the store at read time,
        // not about what the caller meant — the t23 mis-close began life as exactly this
        // assumption one record earlier. List, refuse, make the re-call one paste.
        return `${activeLinks.length} transaction(s) are open and this call named none — NOT closing by guessing, even with a single candidate.\n` +
          activeLinks.map(l => {
            const dst = (st.sessions || {})[l.dest] || {};
            const org = (st.sessions || {})[l.origin] || {};
            return `- [${dst.surface}] "${dst.title}" ← ${org.surface || '?'} · opened ${l.created_at} · session_id: ${l.dest}`;
          }).join('\n') +
          `\nCall again with session_id (you fill it) or title_contains naming the one you mean. ` +
          `Closing the wrong transaction writes this summary onto someone else's record and leaves the real one open.`;
      }
    }
    if (!id) {
      return `Nothing closed: no transaction is pinned to this session, none was named, and no return link is open. ` +
        `If this work arrived as a World A handoff (no return contract), its transaction already closed at pick_up — share results with send_message to the origin instead.`;
    }
    {
      // Gate BEFORE any mutation: a refused return leaves the link open and retryable.
      const stA = await call('GET', '/api/state');
      const destSession = (stA.sessions || {})[id];
      const refusal = assertReturnArtifacts(destSession ? destSession.surface : 'code', args.summary, args.artifacts);
      if (refusal) return refusal; // plain string: nothing settled, so the pin stays
    }
    // Unpin ONLY the caller that was actually pinned to what just closed. A proxy close
    // (Design settled from Code by name) must not clear a pin pointing somewhere else.
    const unpin = (ctx && ctx.pinned === id) ? { pinned: null } : undefined;
    if (args.outcome === 'failed') {
      // Honest failure closes the debt (link → failed); the origin sees the blocker.
      const st2 = await call('GET', '/api/state');
      const link = Object.values(st2.links).find(l => l.dest === id && l.status === 'active');
      if (!link) return `Nothing was owed: no open return leg exists for this session (World A — a no-strings handoff's handshake already closed the transaction). To tell the origin about the failure anyway, use send_message.`;
      const r = await call('POST', `/api/links/${link.id}/fail`, {}, { reason: args.summary });
      // Always name what was closed. The one-line echo is what makes a mis-resolved
      // target visible in the same turn instead of months later in the link table.
      const dst = st2.sessions[id] || {};
      return {
        text: `Transaction closed as FAILED: [${dst.surface}] "${dst.title}" (${link.id})` +
          `${r.origin ? ` → origin ${r.origin.surface}` : ''}. The origin sees the blocker as a "While you were away" summary. ` +
          `If that is not the transaction you meant, say so now — re-close the right one with session_id and the origin record here needs correcting. ` +
          `Honest failure beats silent orphaning; you can stop working now.`,
        ctx_update: unpin,
      };
    }
    try {
      const r = await call('POST', `/api/sessions/${id}/return`, {}, { summary: args.summary, artifacts: args.artifacts });
      const sent = (r.artifacts_returned || []);
      const stEcho = await call('GET', '/api/state');
      const dstEcho = (stEcho.sessions || {})[id] || {};
      return {
        text: `Transaction closed as DONE: [${dstEcho.surface}] "${dstEcho.title}". ` +
          `Session returned to ${r.origin.surface} — the origin has resumed with your summary. ` +
          (sent.length
            ? `${sent.length} artifact(s) delivered BY VALUE: ${sent.join(', ')} — the origin reads them with check_inbox. `
            : '') +
          `Transaction closed; you can stop working now.`,
        ctx_update: unpin,
      };
    } catch (e) {
      if (/no active link/.test(String(e.message))) {
        return `Nothing was owed: this handoff carried no return contract, so its handshake already CLOSED the transaction at pick_up (World A). Your summary was not lost — deliver it with send_message to the origin's title if the user wants it there.`;
      }
      throw e;
    }
  }
  if (name === 'resolve_conversation') {
    // Step 1 of resolve-then-send. Turns a human title into ONE stable id and echoes
    // what it resolved. Never delivers anything, so a wrong resolution costs nothing.
    if (!args || (!args.title_contains && !args.session_id)) throw new Error('title_contains or session_id required');
    const st = await call('GET', '/api/state');
    let matches = Object.values(st.sessions).filter(isTargetable);
    if (args.session_id) matches = matches.filter(s => s.id === args.session_id);
    if (args.surface) matches = matches.filter(s => s.surface === args.surface);
    if (args.title_contains) matches = filterByName(matches, args.title_contains);
    if (!matches.length) {
      return `RESOLVED: nothing. No protocol-known conversation matches ${args.session_id ? `id "${args.session_id}"` : `"${args.title_contains}"`}${args.surface ? ` on ${args.surface}` : ''}. ` +
        `Call list_conversations to see what is addressable. (Local Claude Code terminal sessions cannot receive queued messages — reopen those with claude --resume.)`;
    }
    if (matches.length > 1) {
      return `AMBIGUOUS: ${matches.length} conversations match — resolving nothing.\n` +
        formatSessionCandidates(matches, st) +
        `\nCall resolve_conversation again with session_id (you fill it from this list), or a tighter title_contains + surface. ` +
        `There is deliberately no "pick the newest" — recency is not intent.`;
    }
    const d = matches[0];
    // Name the terminal when the record answers to one: a query of "build" can now resolve a
    // record TITLED "tunnel", and showing the title alone would read as a mis-resolve.
    const term = d.native_ref && d.native_ref.name ? ` · terminal "${d.native_ref.name}"` : '';
    /* Say it HERE too, because this verb hands the caller a session_id and tells them to send.
     * Necessary but not sufficient on its own: a caller who already holds the id skips the
     * resolver entirely, which is why the send-side truth is the load-bearing one. */
    /* THE JOIN, at the point the question is asked. This used to key on `!native_ref` — true of
     * every remote record by design — so it announced "no agent claiming it" about hosts whose
     * agent was live and had asserted a verdict for this very record. Now it asks the agents map,
     * and the pessimistic sentence is reserved for the case where the map genuinely holds nothing. */
    let undeliverable = '';
    if (d.remote && !d.native_ref) {
      const verdict = agentVerdictFor(d.remote.host, d.id, st);
      undeliverable = verdict === 'unknown'
        ? `\nADDRESSABLE BUT NOT YET DELIVERABLE: owned by ${d.remote.host}, and no agent there has claimed it — reachability reads "unknown", which means nobody has looked rather than that it is unreachable. A send is stored durably and nothing will cause it to be read until an agent claims the record.`
        : `\nOWNED BY ${d.remote.host}, whose agent is live and reports this record as "${verdict}". A send is stored durably; whether it is PUSHED depends on the rungs available on that machine — the store is the carrier, and the agent there decides what can be delivered locally.`;
    }
    return `RESOLVED → [${d.surface}] "${d.title}"${term}${undeliverable}\nsession_id: ${d.id}\n\n` +
      `Now call send_message with session_id:"${d.id}". Check the title above is the conversation you meant — this is the only point at which a wrong target is free to correct.`;
  }
  if (name === 'retire_session') {
    /* The verb is deliberately NOT addressable by title. Retirement is irreversible, so it takes
     * an id the caller already holds — the same reasoning that keeps `succeeds` unsearchable. A
     * by-name retirement is one ambiguous substring away from ending the wrong record forever. */
    if (!args || !args.session_id) throw new Error('session_id required — retirement is irreversible and is never resolved from a name');
    const authority = String((args && args.authority) || '').trim();
    const body = {
      authority,
      reason: args.reason,
      attestation: args.attestation,
      successor_id: args.successor_id,
      by_session_id: ctx && ctx.session_id ? ctx.session_id : null,
      by_display: (args && args.by_display) || (ctx && ctx.title) || null,
    };
    const r = await call('POST', `/api/sessions/${args.session_id}/retire`, {}, body);
    if (r && r.error) {
      return `REFUSED (${r.error}): ${r.detail || ''}${r.links ? `\nActive links: ${r.links.join(', ')}` : ''}`;
    }
    const succ = r.successor_id ? `\nSuccessor recorded: ${r.successor_id} — sends addressed to the retired id will resolve forward to it.` : `\nNo successor recorded, so sends to this id will be REFUSED rather than redirected.`;
    return `Retired ${r.id}.\nAuthority: ${r.retired.authority} (evidence: ${r.retired.evidence_class})${r.retired.by_display ? `, carried by ${r.retired.by_display}` : ''}.\nReason: ${r.retired.reason}${succ}` +
      (r.unread_left_in_place ? `\n\n⚠ ${r.unread_left_in_place} unread message(s) REMAIN ON THE RETIRED RECORD and were not moved. Moving someone's mail is a write nobody asked for — re-send them deliberately if they still matter.` : '') +
      `\n\nThe record keeps its id and its whole history. It is gone from resolution and pickers; include_retired shows it again.`;
  }
  if (name === 'send_message') {
    if (!args || !args.message) throw new Error('message required');
    const st = await call('GET', '/api/state');
    // Resolve-then-send: a title NEVER delivers. It resolves, echoes, and stops. Before
    // this, a single substring match sent silently and pick:"latest" collapsed ambiguity
    // by recency — the same class of silent target resolution that put a failure summary
    // on the wrong transaction in t23.
    if (!args.session_id) {
      if (!args.to_title) throw new Error('session_id required (or to_title to resolve first)');
      const echo = await callTool('resolve_conversation', { title_contains: args.to_title, surface: args.surface }, ctx, core);
      return `NOT SENT — resolve first, then send.\n\n${echo}\n\nNothing was delivered by this call.`;
    }
    let dest = (st.sessions || {})[args.session_id];
    /* SUCCESSOR RESOLUTION. A thread whose terminal fragmented (a record per pre-fix /clear)
     * keeps its history in the old record while the LIVE binding sits in the new one. An
     * adoption relinks delivery without moving history, so a send addressed to the thread
     * lands where the terminal actually is. Never silent — the result says it happened. */
    let succVia = null;
    if (dest && dest.superseded_by) {
      const chain = resolveSuccessorIn(st, dest.id);
      const target = (st.sessions || {})[chain.id];
      if (target && !target.archived) { succVia = { from: dest, hops: chain.hops }; dest = target; }
    }
    if (!dest || dest.archived) {
      return `REFUSED: no live conversation with session_id "${args.session_id}"${dest ? ' (it is archived)' : ''}. ` +
        `Nothing was sent. Re-resolve with resolve_conversation — ids are stable, so a missing one means the conversation is gone, not renamed.`;
    }
    /* A RETIRED RECORD REFUSES, AND THE REFUSAL CARRIES ITS ENDING.
     *
     * Only reached when there is NO successor — a retirement WITH one is redirected by the walk
     * above, which is the whole reason retirement reuses `superseded_by` instead of inventing a
     * second field. So this is the genuine dead end, and the copy has to do the work a successor
     * would otherwise do: say WHEN it ended, WHO ended it, and ON WHOSE AUTHORITY, so the sender
     * can tell "this seat moved" from "this seat is over" without asking anyone. */
    if (dest.retired) {
      const r = dest.retired;
      return `REFUSED: "${dest.title}" was RETIRED on ${String(r.at).slice(0, 19)} by ${r.by_display || 'an unnamed seat'} (authority: ${r.authority}) — reason: ${r.reason}. ` +
        `Nothing was sent, and no successor was recorded, so there is nowhere to redirect this. ` +
        `The record and its history remain readable; retirement is an ending, not an erasure. ` +
        `If this thread continued somewhere, resolve that conversation by name and send there.`;
    }
    if (args.surface && dest.surface !== args.surface) {
      return `REFUSED: session_id "${args.session_id}" is on ${dest.surface}, not ${args.surface}. Nothing was sent — the id and the surface disagree, and the id wins only when you meant it.`;
    }
    // Refactor slice 2 — Code↔Code goes NATIVE (this store leg is retired). When THIS is a
    // code terminal (ctx.cli_uuid) and the target is a different, natively-reachable code
    // session, native SendMessage is strictly better: it delivers live and starts a new turn
    // on an idle session, which the store cannot. The tool layer cannot call the SendMessage
    // tool itself (it lives in the agent's session), so it redirects and queues nothing.
    // Cross-surface sends and code targets with no native_ref keep the store path below.
    // NOTE: "is this a code terminal, and is it ME?" is read from CTX — in the daemon this
    // must be the CALLING forwarder's uuid, never the daemon's own process identity.
    const nativeId = (ctx && ctx.cli_uuid) || null;
    if (nativeId && dest.surface === 'code' && dest.native_ref && dest.native_ref.name &&
        dest.native_ref.session_id !== nativeId) {
      return `Code→Code: use NATIVE messaging, not the store (this leg is retired — t26 §wire / refactor). ` +
        `Call ListAgents, then SendMessage to "${dest.native_ref.name}" — native delivers live and starts a new turn on an idle session, which the store cannot. ` +
        `Nothing was queued here. If native reports the socket is gone (ENOENT), that session has exited — only then come back and I will queue durably + notify (relay contract, t26 §reply).`;
    }
    // True sender identity (C28/C29): a pinned transaction speaks as that transaction;
    // otherwise this terminal speaks as its OWN registered record, minted on first send.
    // Never a borrowed by_surface.code id — that is where receipts went to die in t24.
    let fromId = (ctx && ctx.pinned) || null;
    let senderClass = fromId ? 'pinned' : null; // pinned | verified | asserted | anonymous
    let assertedTitle = null;
    // Chat-side identity — caller-named at send time (LINKED-THREADS-SPEC "Next build"; C30).
    // A non-terminal surface has no CLI uuid, so it cannot MINT a verified identity — but a
    // conversation that already joined the protocol has a record. Let the sender NAME its own
    // conversation so its sends carry a real from_session and read-state (✓✓) routes back.
    // Provenance is ASSERTED, not verified (I12's other half): the sender claims this record,
    // nothing binds it. Guard: a caller may NOT assert a record that has a native_ref — those
    // are CLI-verified terminal identities and are not claimable by assertion.
    if (!fromId && (args.from_session_id || args.from_title)) {
      let mine = Object.values(st.sessions || {}).filter(s => !s.archived && !s.native_ref);
      if (args.from_session_id) mine = mine.filter(s => s.id === args.from_session_id);
      if (args.from_title) { const t = args.from_title.toLowerCase(); mine = mine.filter(s => s.title.toLowerCase().includes(t)); }
      if (args.from_surface) mine = mine.filter(s => s.surface === args.from_surface);
      if (mine.length > 1) {
        return `AMBIGUOUS sender: ${mine.length} conversations match ${args.from_session_id ? `id "${args.from_session_id}"` : `from_title "${args.from_title}"`}${args.from_surface ? ` on ${args.from_surface}` : ''} — name yourself with from_session_id (or add from_surface). ` +
          `Nothing was sent; a mis-named sender would route read-state to the wrong record.`;
      }
      if (mine.length === 1) { fromId = mine[0].id; senderClass = 'asserted'; assertedTitle = mine[0].title; }
      else if (args.from_session_id) {
        return `REFUSED sender: no assertable conversation with id "${args.from_session_id}" (it may be archived, or it is a CLI-verified terminal record, which cannot be asserted). Nothing was sent.`;
      }
    }
    if (!fromId) { try { const reg = await identitySession(ctx, core); fromId = reg && reg.id; if (fromId) senderClass = 'verified'; } catch (_) { fromId = null; } }
    if (!fromId) senderClass = 'anonymous';
    await call('POST', `/api/sessions/${dest.id}/messages`, {}, {
      role: 'user', kind: 'xmsg', from_session: fromId || null, sender_class: senderClass,
      text: `[message from ${args.from || 'another surface'}] ${args.message}`
    });
    // Wake tier (t28): an attention send to an open Code terminal SELF-STARTS its turn — zero
    // taps. wake() runs the owned tier (channel-inject → -p relay → notify the user → the store
    // is already durable), attention-only; fyi never wakes. Owned module (bin/handoff-wake.js):
    // we hand it the delivery, it chooses the rung and never blocks or breaks the send. Store
    // targets that are not registered Code terminals are woken by the user speaking there.
    let woke = null;
    if (dest.surface === 'code' && dest.native_ref) {
      try {
        woke = require('./bin/handoff-wake').wake({
          tier: args.mode === 'fyi' ? 'fyi' : 'attention',
          thread: dest.title, conversation: dest.title, session_id: dest.id,
          native_ref: dest.native_ref, channels: false, from: args.from || 'your chat'
        });
      } catch (e) { woke = { woke: false, tier: 'threw', error: (e && e.message) || String(e) }; }
      /* WHICH RUNG CARRIED IT, WRITTEN DOWN AT THE MOMENT IT HAPPENS.
       *
       * The ops vocabulary had no wake event at all — 384 session_registered, zero wake — so the
       * one question the wake tier exists to answer ("did this delivery start a turn, and by which
       * leg?") could only be answered afterwards by inference. It cost a full forensic pass on
       * 2026-08-10: the delta series could prove a turn STARTED within 20s but never which
       * mechanism started it, and two causal stories survived purely because nothing contradicted
       * them. A tier that chooses among four rungs and records none of them is asking to be
       * theorised about.
       *
       * Deliberately at the CALL SITE rather than inside wake(): the module is owned by the
       * wake-tier workstream and returns its verdict; recording what we did with that verdict is
       * this layer's business, and it keeps the log honest if wake() ever throws — 'threw' is a
       * rung outcome too, and it used to be swallowed into null.
       *
       * NEVER let logging break the send. Same rule as the wake call it follows. */
      try {
        /* THE NOTIFY RUNG'S OWN OUTCOME RIDES ALONG, because a sighting the operator remembers
         * and a firing the system recorded were previously two different worlds. bin/handoff-notify
         * has exactly one production caller — the notify rung inside wake() — so recording its
         * result here covers every firing without a second logging site, and the rung already
         * returns {fired, channel}. Before this, the only timeline for a notification was somebody
         * remembering seeing one. */
        core.ops('wake', {
          dest: dest.id, surface: dest.surface,
          tier: (woke && woke.tier) || 'none',
          woke: !!(woke && woke.woke),
          requested: args.mode === 'fyi' ? 'fyi' : 'attention',
          /* seam:true travels INTO THE STORE, because the store is what a later investigator
           * queries. Without it, a simulated dispatch and a real one are the same row, which is
           * precisely how five non-deliveries read as successes for thirty-one minutes. */
          seam: (woke && woke.seam) || undefined,
          reason: (woke && woke.reason) || undefined,
          notify_fired: woke && woke.notify ? !!woke.notify.fired : undefined,
          notify_channel: woke && woke.notify ? woke.notify.channel : undefined,
          error: (woke && woke.error) || undefined
        });
      } catch (_) {}
    }
    // Read-state attribution line, keyed to sender class (chat-side identity).
    let attribution;
    if (senderClass === 'asserted') {
      attribution = `When it is read, read-state (✓✓) routes to your named record "${assertedTitle}" — ASSERTED provenance (you named this conversation; it is not CLI-verified like a terminal, I12's other half). Check it with status on your surface.`;
    } else if (fromId) {
      attribution = `When it is actually read, your next status shows ✓✓ with the read time — ambient state on this send, never an inbox item.`;
    } else {
      attribution = `This bridge has no identity (no CLI uuid, nothing pinned, and you named no from_title/from_session_id), so no read state can be attributed back. To get ✓✓ back, name your own conversation with from_title (asserted provenance).`;
    }
    // The user's name for it, not the process's. Native `name` is nameSource:"derived" and
    // drifts per process (d1 -> d9); the title is what they typed and would type again.
    const windowName = dest.title || (dest.native_ref && dest.native_ref.name);
    const deliveryNote = deliveryNoteFor(woke, dest, windowName);
    const successorNote = succVia
      ? `Delivered via successor of "${succVia.from.title}" (${succVia.from.id}) — that record was superseded${succVia.hops > 1 ? ` through ${succVia.hops} links` : ''}; its history stays there, delivery follows the live one. `
      : '';
    return `Message queued for [${dest.surface}] "${dest.title}" (session_id: ${dest.id}). ` +
      successorNote + deliveryNote + attribution;
  }

  // ---- send_to / send_to_surface (slice 3b-8) ----
  // Lifted verbatim, only api()->call() and the explicit-core signature changed. Neither
  // tool reads per-session state (no cli_uuid, no pin), so unlike send_message there is no
  // isolation surface here at all — the whole span is store operations behind the four
  // refuse-before-mutating guards, which moved with them.
  if (name === 'send_to') {
    if (!args || !args.to || !args.title || !args.context) throw new Error('to, title and context required');
    const contractBlock = assertReturnContract(args.expected_return);
    if (contractBlock) return contractBlock;
    const artBlock = assertArtifactsForAppSurface(args.to, args.artifacts);
    if (artBlock) return artBlock;
    const codeBlock = assertCodeProjectTarget(args);
    if (codeBlock) return codeBlock;
    const mode = args.mode || 'auto';
    const wantsExisting = mode === 'existing' || !!(args.target_title || args.session_id);
    if (mode === 'new' || !wantsExisting) {
      // Delegation, not a deprecated call — flag it so the note fires only for cached callers.
      return callTool('send_to_surface', args, Object.assign({}, ctx, { via_send_to: true }), core);
    }
    if (mode === 'existing' && !args.target_title && !args.session_id) {
      throw new Error('target_title or session_id required when mode is existing');
    }

    const st = await call('GET', '/api/state');
    let matches = Object.values(st.sessions).filter(s => isTargetable(s) && s.surface === args.to);
    if (args.session_id) {
      matches = matches.filter(s => s.id === args.session_id);
      if (!matches.length) {
        return `No EXISTING ${args.to} session has id ${args.session_id}. Call list_conversations / send_to again to re-list. Nothing was sent.`;
      }
    } else if (args.target_title) {
      matches = filterByName(matches, args.target_title);
    }

    // Local Claude Code terminals are NOT protocol destinations for send_to.
    // Resuming a terminal is a different verb — never conflate (resume ≠ deliver envelope).
    if (!matches.length && args.to === 'code' && args.target_title) {
      const local = localCodeSessions(30).filter(s =>
        s.title.toLowerCase().includes(args.target_title.trim().toLowerCase())
      );
      if (local.length) {
        core.ops('route_resolved', { verb: 'send_to', outcome: 'refuse_resume_overload', query: args.target_title, local_candidates: local.length });
        return `Found ${local.length} local Claude Code TERMINAL session(s) matching "${args.target_title}", but send_to does not resume terminals (that would reopen a window without delivering this envelope).\n` +
          local.slice(0, 8).map(c => `- "${c.title}" · ${age(c.mtime)} · ${c.folder}`).join('\n') +
          `\nUse /resume-session (resume_code_session) to reopen one, or call send_to again WITHOUT target_title to create a NEW Code handoff with this carrier. Nothing was sent.`;
      }
    }
    if (!matches.length) {
      return `No EXISTING ${args.to} conversation matches "${args.target_title || args.session_id}". Nothing was sent and no NEW conversation was created. Call list_conversations, choose a title, or call send_to again without target_title for a new destination.`;
    }
    if (matches.length > 1 && args.pick === 'latest') {
      matches = [matches.reduce((a, b) => (a.created_at > b.created_at ? a : b))];
    }
    if (matches.length > 1) {
      core.ops('route_ambiguous', { verb: 'send_to', query: args.target_title || null, surface: args.to, candidates: matches.length });
      return `${matches.length} EXISTING ${args.to} conversations match — which one? ` +
        `Reply with the letter (A/B/C…), "latest", or a distinctive recap phrase — do not ask the user for a session id.\n` +
        formatSessionCandidates(matches, st) +
        '\nThen re-call send_to with session_id from the chosen card (you fill it) or pick:"latest".';
    }

    const notes = {};
    if (args.constraints && args.constraints.length) notes.constraints = args.constraints;
    if (args.entities && args.entities.length) notes.entities = args.entities;
    if (args.non_goals && args.non_goals.length) notes.non_goals = args.non_goals;
    if (args.expected_return) notes.expected_return = args.expected_return;
    if (args.deadline) notes.deadline = args.deadline;
    const origin = await call('POST', '/api/sessions', {}, {
      surface: args.from || 'cowork', title: args.title, open_items: args.open_items || [],
      artifacts: (args.artifacts || []).map(a => ({ name: a.name, type: a.type || 'file', content: a.content })),
      notes: Object.keys(notes).length ? notes : undefined,
      project_state: args.project_state
    });
    await call('POST', `/api/sessions/${origin.id}/messages`, {}, { role: 'user', text: args.context, kind: 'context' });
    for (const d of args.decisions || []) await call('POST', `/api/sessions/${origin.id}/messages`, {}, { role: 'user', text: d, decision: true });

    const target = matches[0];
    const returnLeg = !!args.expected_return;
    await call('POST', `/api/sessions/${origin.id}/deliver`, {}, {
      dest: target.id, return_leg: returnLeg
    });
    const overflowNote = await queueArtifactOverflow(core, target.id, args.artifacts, args.to, origin.id);
    core.ops('route_resolved', {
      verb: 'send_to', explicit: true, target: target.id, surface: args.to,
      existing: true, return_owed: returnLeg
    });

    if (args.open_in !== 'none' && args.to !== 'code' && !process.env.HANDOFF_NO_AUTOOPEN) {
      try {
        const { spawn } = require('child_process');
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        const c = spawn(opener, ['claude://claude.ai/chat/recents'], { detached: true, stdio: 'ignore' });
        c.unref();
      } catch (_) {}
    }

    const returnLine = returnLeg
      ? `Return link OPEN — from that conversation call return_to_origin when done (outcome:"failed" if blocked). The origin keeps the "While you were away" card.`
      : `Standalone send — no return path. The carrier was delivered; this transaction does not expect return_to_origin.`;
    return `Sent FULL envelope to EXISTING ${args.to} conversation "${target.title}". ` +
      `Queued for inbox (check_inbox / next turn there). No new conversation was created. ` +
      (args.open_in === 'none' ? '' : `App opened at Recents — click that exact title. `) +
      returnLine + overflowNote;
  }
  /* DEMOTED, NOT DELETED (the user's ruling, 2026-08-09 — option B). This is no longer an
   * advertised tool: send_to is the one public send verb and this is its mode:"new" branch.
   * The handler stays because MCP clients cache the tool list for the life of a connection —
   * removing it would break every conversation open right now until it reconnects. Direct
   * callers are therefore served normally and told once, in the result, what to call next
   * (see DEPRECATION_NOTE below); they are never failed. `viaSendTo` is set when send_to
   * delegates here, so the note fires only for genuinely cached callers. */
  if (name === 'send_to_surface') {
    const viaSendTo = !!(ctx && ctx.via_send_to);
    if (!viaSendTo) {
      const { CONTRACT } = require('./handoff-contract');
      if (CONTRACT > SUNSET_AT_CONTRACT) {
        return `send_to_surface no longer exists. It was send_to's mode:"new" branch, and the grace window for cached tool lists closed at contract ${SUNSET_AT_CONTRACT}. Call send_to with mode:"new". Nothing was sent.`;
      }
      // Every old-name call is recorded, so retiring the dispatch is a decision backed by
      // evidence ("nobody has called it since X") rather than a hope that nobody still does.
      core.ops('deprecated_verb_called', { verb: 'send_to_surface', to: args && args.to, contract: CONTRACT, cli_uuid: (ctx && ctx.cli_uuid) || null });
    }
    if (!args || !args.to || !args.title || !args.context) throw new Error('to, title and context required');
    const contractBlock = assertReturnContract(args.expected_return);
    if (contractBlock) return contractBlock;
    const artBlock = assertArtifactsForAppSurface(args.to, args.artifacts);
    if (artBlock) return artBlock;
    const codeBlock = assertCodeProjectTarget(args);
    if (codeBlock) return codeBlock;
    const notes = {};
    if (args.constraints && args.constraints.length) notes.constraints = args.constraints;
    if (args.entities && args.entities.length) notes.entities = args.entities;
    if (args.non_goals && args.non_goals.length) notes.non_goals = args.non_goals;
    if (args.expected_return) notes.expected_return = args.expected_return;
    if (args.deadline) notes.deadline = args.deadline;
    const origin = await call('POST', '/api/sessions', {}, {
      surface: args.from || 'cowork', title: args.title, open_items: args.open_items || [],
      artifacts: (args.artifacts || []).map(a => ({ name: a.name, type: a.type || 'file', content: a.content })),
      notes: Object.keys(notes).length ? notes : undefined,
      project_state: args.project_state
    });
    // kind 'context': carrier summaries QUOTE past decisions — they must never re-lock them.
    await call('POST', `/api/sessions/${origin.id}/messages`, {}, { role: 'user', text: args.context, kind: 'context' });
    for (const d of args.decisions || []) {
      await call('POST', `/api/sessions/${origin.id}/messages`, {}, { role: 'user', text: d, decision: true });
    }
    // World A: a return link opens ONLY when a return is owed. No expected_return →
    // the handshake at pick_up completes the whole transaction, nothing dangles.
    const r = await call('POST', `/api/sessions/${origin.id}/continue`, {}, { to: args.to, return_leg: !!args.expected_return });
    const overflowNote = await queueArtifactOverflow(core, r.dest.id, args.artifacts, args.to, origin.id);
    // Native receive: the Claude DESKTOP app ships a documented deep link —
    // claude://claude.ai/new?q=<prompt> opens a new in-app conversation with the prompt
    // prefilled (~14k char budget). The OS launches the app if it isn't running.
    // https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link
    const br = await call('GET', `/api/sessions/${r.dest.id}/brief`, { for: args.to });
    const fromName = args.from || 'cowork';
    // Design conversations cannot run the handoff MCP (measured: no return_to_origin /
    // pick_up tools there). Never instruct Design to call those — it produces a pasteable
    // return summary; Code (or Chat/Cowork with MCP) closes the link via return_to_origin
    // with title_contains / session_id naming the Design dest.
    const returnInstr = !args.expected_return ? ''
      : args.to === 'design'
        ? ` When done, write a short RETURN SUMMARY (what you made, file name, last line of copy if relevant). Do NOT call return_to_origin — that tool is not available in Design. The human will close the return from Claude Code.`
        : ` When your part is done, call the handoff MCP tool return_to_origin with a summary of the result so it lands back in ${fromName}.`;
    const prompt = `Continue this conversation seamlessly from the handoff below (arriving from ${fromName}). ` +
      `Treat locked decisions as constraints.` +
      (args.to === 'design' ? '' : ` If a "handoff" MCP is available, you may also call pick_up.`) +
      returnInstr +
      `\n\n` + br.brief.slice(0, 12000);
    const q = encodeURIComponent(prompt);
    // Per-surface deep links (documented): chat, Cowork and Code each have one; Design
    // (Labs, separate window, no MCP) has NONE — trial t9: routing design through the
    // chat link opened the wrong surface. For design: no auto-open; return the brief
    // for the user to paste into Design's composer (its intended input).
    const DEEPLINKS = { chat: 'claude://claude.ai/new?q=', cowork: 'claude://cowork/new?q=', code: 'claude://code/new?q=' };
    const appUrl = DEEPLINKS[args.to] ? DEEPLINKS[args.to] + q : null;
    const webUrl = 'https://claude.ai/new?q=' + q.slice(0, 6000);
    if (!appUrl) {
      // No DOCUMENTED Design deep link exists. claude://design/new?q= is an EXPERIMENTAL
      // probe — unknown paths are harmless (the app just focuses/ignores), so try it,
      // but never claim success: the full pasteable brief always follows.
      // MEASURED 2026-08-05 (t11): confirmed no-op on the then-current desktop build.
      // ~11 fires: the app merely activates (indistinguishable from a garbage path),
      // no window opens, and zero claude:// URLs appear anywhere in ~/Library/Logs/
      // Claude/ — the app never logs receiving the URL. Kept because a future build
      // may wire it; PASTE IS THE DELIVERY, the probe is a lottery ticket.
      let probed = false;
      if ((args.open_in || 'app') === 'app' && !process.env.HANDOFF_NO_AUTOOPEN) {
        try {
          const { spawn } = require('child_process');
          const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
          const k = spawn(opener, ['claude://design/new?q=' + q.slice(0, 12000)], { detached: true, stdio: 'ignore' });
          k.unref(); k.on('error', () => {});
          probed = true;
        } catch (_) {}
      }
      return `Handed off: "${args.title}" → recorded for Design (protocol session ${r.dest.id}).\n` +
        (probed ? `EXPERIMENTAL probe fired (claude://design/new) — measured 2026-08-05: confirmed no-op on that build (app activates, nothing opens, nothing logged). Do not treat the fire as delivery. ` : '') +
        `Design (Labs) has no documented deep link and no MCP. ` +
        // t14: Claude Code DOES have a server-side Design ingress — the DesignSync tool
        // (/design-sync, via the claude.ai login). It writes files into a design-system
        // project with no app process, no clipboard, no deep link; a brief travels as a
        // preview card. Measured live: 10KB brief round-tripped byte-complete — BUT files
        // alone left the pane showing "empty" (delivery ≠ display). The pane renders ONLY
        // what the root _ds_manifest.json indexes; contract verified against a working
        // project and confirmed rendering by the user (tokens, groups, cards, brief).
        `BEST DELIVERY — if you are Claude Code with the DesignSync tool available, deliver this brief as a card, following the PANE CONTRACT exactly (files that ignore it upload fine but display as an empty system): ` +
        `(1) card at preview/<name>.html — full <!DOCTYPE html><html><head>… skeleton, first line after doctype: <!-- @dsCard group="Handoffs" name="<title>" subtitle="<one line>" viewport="700x520" -->, brief verbatim in a <pre>, <link rel="stylesheet" href="_card.css"/>; ` +
        `(2) root _ds_manifest.json indexes it — cards[] entry {path, group, viewport ("WxH" string), subtitle, name}, plus globalCssPaths and a typed tokens[] array ({name, value, kind: color|font|radius|spacing|shadow|other, definedIn}); ` +
        `(3) tokens css at ROOT (e.g. colors_and_type.css), shared preview/_card.css. ` +
        `Push via finalize_plan + write_files; verify with get_file (truncated:false). It appears queued in Design's "Design systems" pane under the Handoffs group. ` +
        (args.expected_return
          ? `RETURN — Design cannot call return_to_origin. When Design finishes, from THIS Code session run return_to_origin with title_contains:"${args.title}" (or the Design session_id) and summary:<Design's return summary> to close the link.\n`
          : '') +
        `Otherwise, paste this brief into Design's composer:\n\n${br.brief}` + // no slice: paste has no URL budget, and silent truncation is what lost the copy in t8/t9b
        overflowNote;
    }
    // NOTE: no existing-conversation delivery here by design. The app exposes no
    // conversation IDs to users and no injection path except paste — and clipboard
    // transport is rejected (shared destructive resource, invisible to traces).
    // Delivery to existing protocol-known conversations goes through send_message
    // (queued, pulled via check_inbox on the receiver's next turn — the shipped
    // cross-session-messaging pattern).
    // Synchronous, observable auto-send: waits for the app to load the deep link, presses
    // Enter, captures the REAL outcome, logs it to ops (telemetry rule: every operation
    // emits an event), and reports honestly. Silent fire-and-forget hid an Accessibility
    // denial once — never again.
    async function pressEnter() {
      const { spawn } = require('child_process');
      const run = (cmd, cargs) => new Promise(res => {
        try {
          const c = spawn(cmd, cargs, { stdio: ['ignore', 'pipe', 'pipe'] });
          let err = '';
          c.stderr.on('data', d => err += d);
          c.on('close', code => res({ code, err: err.trim() }));
          c.on('error', e => res({ code: -1, err: e.message }));
        } catch (e) { res({ code: -1, err: e.message }); }
      });
      // No completion event exists for deep links (the OS hands the URL over and reports
      // nothing back) — so estimate adaptively instead of waiting pessimistically:
      // app already running → navigation is ~1s; cold start → give it 5s. A second
      // insurance Enter ~2.2s later covers slow loads: if the first press already sent,
      // Enter in an empty composer is a no-op. Tune with HANDOFF_AUTOSEND_DELAY_MS.
      let running = false;
      try {
        if (process.platform !== 'win32') {
          running = require('child_process').spawnSync('pgrep', ['-x', 'Claude'], { timeout: 2000 }).status === 0;
        }
      } catch (_) {}
      const delay = parseInt(process.env.HANDOFF_AUTOSEND_DELAY_MS || '', 10) || (running ? 1100 : 5000);
      if (process.platform !== 'win32') await new Promise(r => setTimeout(r, delay)); // win32 sleeps inside PS
      if (process.platform === 'darwin') {
        return run('osascript', ['-e', 'tell application "Claude" to activate', '-e', 'delay 0.4',
          '-e', 'tell application "System Events" to key code 36',
          '-e', 'delay 2.2',
          '-e', 'tell application "System Events" to key code 36']);
      }
      if (process.platform === 'win32') {
        return run('powershell', ['-NoProfile', '-Command',
          "$w = New-Object -ComObject wscript.shell; " +
          "if (Get-Process -Name Claude -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 1100 } else { Start-Sleep -Seconds 5 } ; " +
          "if ($w.AppActivate('Claude')) { Start-Sleep -Milliseconds 400; $w.SendKeys('~'); Start-Sleep -Milliseconds 2200; $w.AppActivate('Claude') | Out-Null; $w.SendKeys('~') } else { Write-Error 'AppActivate failed (foreground lock?)'; exit 1 }"]);
      }
      return run('sh', ['-c', 'command -v xdotool >/dev/null && xdotool search --name "Claude" windowactivate --sync key Return sleep 2.2 key Return']);
    }
    const where = args.open_in || 'app'; // bridge always runs in a native host → app is natural
    const openUrl = where === 'web' ? webUrl : appUrl;
    let opened = false, autosent = false;
    if (where !== 'none' && !process.env.HANDOFF_NO_AUTOOPEN) {
      try {
        const { spawn } = require('child_process');
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        const c = spawn(opener, [openUrl], { detached: true, stdio: 'ignore' });
        c.unref(); c.on('error', () => {});
        opened = true;
      } catch (_) {}
    }
    // t20: "say 'always autosend' to skip it" was a promise with nothing behind it — the
    // only durable switch was an env var the agent cannot set, so the user re-consented on
    // every single handoff. autosend_default persists the standing choice; per-call
    // autosend still wins in both directions (one-off yes, one-off no).
    if (args.autosend_default === 'always' || args.autosend_default === 'never') {
      core.setPref('autosend', args.autosend_default === 'always');
      core.ops('autosend_pref', { value: args.autosend_default });
    }
    const wantAutosend = core.resolveAutosend(args.autosend, core.getPrefs().autosend, process.env.HANDOFF_AUTOSEND);
    let autosendNote = '';
    if (opened && where === 'app' && wantAutosend.on) {
      const res = await pressEnter();
      autosent = res.code === 0;
      core.ops('autosend', { ok: autosent, code: res.code, err: (res.err || '').slice(0, 200), platform: process.platform, via: wantAutosend.via });
      if (!autosent) {
        const err = res.err || 'unknown';
        if (/assistive|not allowed|accessibility|1002/i.test(err)) {
          autosendNote = `Autosend FAILED — macOS blocked the synthetic keystroke: grant the Claude app Accessibility permission (System Settings → Privacy & Security → Accessibility → enable Claude), then try again. (${err.slice(0, 120)})`;
        } else if (/xdotool/.test(err) || (process.platform === 'linux' && res.code !== 0)) {
          autosendNote = 'Autosend FAILED — xdotool not available (or Wayland, which blocks synthetic input by design). Press send manually.';
        } else {
          autosendNote = `Autosend FAILED (${err.slice(0, 140) || 'exit ' + res.code}). Press send manually.`;
        }
      }
    }
    // t20: EVERY run must leave a trace. The app-surface handoff — the product's most-used
    // path — used to emit nothing at all: no ops event, so no auto-receipt, so the graders
    // only ever saw worker dispatches. Handoffs were literally ungradable. This event is
    // the unit `receipt_from_ops.py` grades for a handoff run.
    core.ops('handoff_sent', {
      origin: origin.id, dest: r.dest.id, surface: args.to, from: fromName, mode: 'new',
      title: (args.title || '').slice(0, 120),
      // What was asked, for summary_fidelity to ground the eventual return against. A
      // 4-word title is too thin a signal — grounding wants 2 significant shared terms
      // and would false-reject an honest return. Same 200-char excerpt convention the
      // dispatch event already uses for `task`.
      task_excerpt: (args.context || '').slice(0, 200),
      open_in: where, opened,
      autosend_requested: wantAutosend.on, autosend_via: wantAutosend.via, autosent,
      artifacts: (args.artifacts || []).length,
      artifacts_by_value: (args.artifacts || []).filter(a => a && a.content).length,
      brief_chars: (br.brief || '').length, prompt_chars: prompt.length,
      truncated: (br.brief || '').length > 12000, overflow_queued: !!overflowNote,
      return_owed: !!args.expected_return
    });
    core.autoReceipt();
    // t15: send_to_surface ALWAYS creates a NEW conversation — it must never be used to
    // reach an EXISTING one ("send this back to X" = send_message). When the existing
    // target isn't protocol-known (destroyed record, never joined), the right move is to
    // SAY SO and ask, not to silently reframe the request as a fresh handoff (A3, done
    // live by the agent on 2026-08-05 — with autosend, which also injected).
    return `Handed off: "${args.title}" → NEW ${args.to === 'cowork' ? 'Cowork session' : args.to === 'code' ? 'Code-tab session' : 'conversation'}, ${where === 'web' ? `claude.ai in your browser` : `Claude app (${args.to} surface)`}.\n` +
      (opened
        ? (autosent
          ? `It opened and was sent automatically ✓ — the conversation is live there now.${wantAutosend.via === 'pref' ? ' (standing "always autosend" preference — say "always ask me first" to undo)' : ''}\n`
          : autosendNote
            ? autosendNote + '\n'
            : `It is opening with the full context pre-loaded — press send there (the platform's consent gate for deep links). To stop being asked every time, say "always autosend" and I will set it as a standing preference.\n`)
        : `Receive it here: ${openUrl.slice(0, 100)}…\n`) +
      (where === 'web' ? '' : `Web fallback: ${webUrl.slice(0, 100)}…\n`) +
      (args.to === 'code'
        ? `NOTE (t18): the Desktop Code tab uses whichever project that tab has open — not necessarily your IDE cwd. Prefer pick_up in the terminal/IDE you intend.\n`
        : '') +
      `Or in any ${args.to} conversation with the handoff MCP: "pick up the handoff". The origin stays resumable.` +
      overflowNote + (viaSendTo ? '' : DEPRECATION_NOTE);
  }
  // ---- the remaining tools (slice 3b-10) ----

  if (name === 'send_to_worker') {
    if (!args || !args.task) throw new Error('task required');
    const r = await call('POST', '/api/workers', {}, {
      task: args.task, context: args.context, dir: args.dir, mode: args.mode
    });
    const l = r.launch || {};
    const how = l.launched
      ? (l.mode === 'ide' ? `NEW Claude Code session in a ${l.ide === 'code' ? 'VS Code' : 'Cursor'} window (interactive)` : 'NEW Claude Code session, headless in the background — its summary will come back on its own')
      : `NEW Claude Code session prepared but NOT auto-launched (${l.reason || 'unknown'}); run this in the target folder: ${l.command || 'n/a'}`;
    const nat = l.native_ref ? `\nNative Claude Code session: ${l.native_ref.session_id} (reopen anytime: ${l.native_ref.resume})` : '';
    return `Worker dispatched.\nworker_id: ${r.worker_id}\nStatus: ${how}${nat}\nCheck later with get_worker_result (worker_id optional).`;
  }
  if (name === 'list_conversations') {
    const st = await call('GET', '/api/state');
    let sessions = Object.values(st.sessions).filter(s => !s.archived);
    if (args && args.surface) sessions = sessions.filter(s => s.surface === args.surface);
    /* PASSIVE RECORDS ARE ADDRESSABLE BUT NOT OFFERED — R1 as amended. Minting on first contact
     * gives a read-only conversation an inbox (the case that decided it: a chat did useful
     * read-only work and could not be sent to, because it had never written and so did not
     * exist). The cost is picker clutter, and the answer is a filter rather than a denial: the
     * record exists, resolves and receives; it simply is not proposed as a destination until it
     * has done something. include_passive shows them, and the count is always stated — a list
     * that silently omits rows is the same defect as one that silently includes the wrong ones. */
    const passiveAll = sessions.filter(s => s.participation === 'passive');
    if (!(args && args.include_passive)) sessions = sessions.filter(s => s.participation !== 'passive');
    // Routing telemetry (t11): the ops trail showed only the final resume, never what
    // was listed — Gate A was blind to the decision path. Every routing verb now logs.
    core.ops('route_query', { verb: 'list_conversations', surface: (args && args.surface) || null, protocol: sessions.length });
    const unread = s => unreadCount(s);
    /* Superseded records stay VISIBLE here — their history is the reason they exist — but they
     * are labelled so nobody addresses one by mistake. Listing is not targeting: the target
     * surfaces (resolve_conversation, send_to) refuse them outright. */
    const supersededNote = s => {
      if (!s.superseded_by) return '';
      const to = (st.sessions || {})[s.superseded_by];
      return ` · SUPERSEDED → ${to ? `"${to.title}"` : s.superseded_by} (history kept here; send to the successor)`;
    };
    const loc = s => (s.surface === 'code' ? 'Claude Code · protocol record' : `Claude app · ${s.surface}`) + supersededNote(s);
    const banner = await attentionBanner(ctx, core);
    const parts = [];
    /* NEVER A SILENT OMISSION. Whatever the filter drops is counted out loud, so a short list is
     * legibly short rather than mysteriously so. A picker that hides rows without saying it does
     * is how someone concludes a conversation does not exist when it merely has not spoken. */
    const hiddenNote = (!(args && args.include_passive) && passiveAll.length)
      ? `\n(${passiveAll.length} passive record(s) not shown — minted on first contact, addressable and able to receive, but not yet offered as a destination. include_passive: true to list them.)`
      : '';
    if (!sessions.length && (!args || !args.surface)) {
      parts.push(
        'No conversations in the protocol yet.\n\n' +
        'Getting started (30 seconds):\n' +
        '1. Call status — confirms the bridge is current.\n' +
        '2. From any Claude chat with this MCP: /handoff code (or say "hand this off to Claude Code").\n' +
        '3. In the Code session: pick_up or /pull — then work and /return-to-origin.'
      );
    }
    if (sessions.length) {
      // Same title often appears many times after supersedes — show recap + state, not bare titles.
      const byTitle = new Map();
      for (const s of sessions) {
        const k = s.surface + '\0' + s.title;
        if (!byTitle.has(k)) byTitle.set(k, []);
        byTitle.get(k).push(s);
      }
      const lines = [];
      for (const group of byTitle.values()) {
        if (group.length === 1) {
          const s = group[0];
          lines.push(
            `- [${loc(s)}] "${s.title}"${unread(s) ? ` · ${unread(s)} unread` : ''}` +
            `${s.origin_ref ? ` · continued from ${s.origin_ref.surface}` : ''}` +
            `${s.native_ref ? ` · has live terminal session` : ''}\n` +
            `    State: ${sessionLinkNote(s, st)} · Carrier: ${sessionCarrierNote(s)}\n` +
            `    Recap: ${sessionRecap(s)}`
          );
        } else {
          lines.push(`- [${group[0].surface}] "${group[0].title}" — ${group.length} protocol records (same title; pick by letter):\n` +
            formatSessionCandidates(group, st));
        }
      }
      parts.push('EXISTING protocol-known conversations (address by title with send_message / send_to; on collision use letter → session_id):\n' +
        lines.join('\n'));
    }
    if (!args || !args.surface || args.surface === 'code') {
      const cc = localCodeSessions(8);
      if (cc.length) {
        parts.push('EXISTING local Claude Code terminal sessions (discovered from ~/.claude/projects, same store as `claude --resume`; these cannot receive queued messages — reopen them):\n' +
          cc.map(c => `- [Claude Code · local terminal] "${c.title}" · ${age(c.mtime)} · ${c.folder}\n    reopen: claude --resume ${c.id}`).join('\n'));
      }
    }
    if (!args || !args.surface || args.surface === 'cowork') {
      const cw = localCoworkSessions(5);
      if (cw.length) {
        parts.push('EXISTING local Cowork session stores (discovered on this machine; titles live in the app\'s private metadata, so some are unnamed — open them from the app sidebar):\n' +
          cw.map(c => `- [Cowork · local store] ${c.title ? `"${c.title}"` : '(untitled — pick by recency in the app sidebar)'} · ${age(c.mtime)}`).join('\n'));
      }
    }
    parts.push('NOT listable anywhere: Claude app CHAT conversations that never touched the protocol — their state is server-side with no API. They join by handing off from their own side ("/handoff" there, or "hand this off to …").');
    const body = parts.length ? parts.join('\n\n') : 'No conversations discovered yet. Conversations join by handing off, picking up, or being dispatched; local Claude Code sessions appear once ~/.claude/projects exists.';
    return banner + body + hiddenNote;
  }
  if (name === 'resume_code_session') {
    /* AMBIGUITY ENFORCEMENT (t5 regressed in t11): the ROUTING prose in tool
     * descriptions did not stop the model self-resolving "resume the <X> one" when one
     * candidate looked freshest — it opened a Terminal window and disclosed the
     * alternatives after the fact. The locked constraint ("never guess between
     * plausible referents: list candidates and ask") is now mechanical: plausible
     * referents span BOTH domains (local terminal sessions AND same-titled protocol
     * app conversations), and with more than one, this tool lists and refuses to act.
     * Acting requires a unique match, an explicit session_id from our own candidate
     * list, or pick:"latest" (which the schema reserves for user-confirmed intent). */
    let cc = localCodeSessions(30);
    if (args && args.title_contains) { const t = args.title_contains.toLowerCase(); cc = cc.filter(c => c.title.toLowerCase().includes(t)); }
    if (args && args.folder_contains) { const t = args.folder_contains.toLowerCase(); cc = cc.filter(c => c.folder.toLowerCase().includes(t)); }
    const override = process.env.CLAUDE_PROJECTS_DIR ? ` ⚠ reading OVERRIDDEN store ${process.env.CLAUDE_PROJECTS_DIR} — unset CLAUDE_PROJECTS_DIR if this surprises you (test fixtures leak this way).` : '';
    // Cross-verb referents: app conversations whose titles also match are plausible
    // targets of "resume X" — they belong to open_conversation/continue_from, but the
    // USER doesn't know that taxonomy, so their existence makes the request ambiguous.
    let appMatches = [];
    if (args && args.title_contains) {
      try {
        const st = await call('GET', '/api/state');
        const t = args.title_contains.toLowerCase();
        appMatches = Object.values(st.sessions).filter(s2 => !s2.archived && s2.surface !== 'code' && s2.title.toLowerCase().includes(t));
      } catch (_) { /* store unreadable — grade on local candidates only */ }
    }
    const explicit = args && (args.session_id || args.pick === 'latest');
    if (args && args.session_id) {
      cc = cc.filter(c => c.id === args.session_id);
      if (!cc.length) return `No local session has id ${args.session_id} — it may have been listed from a different store. Call again without session_id to re-list.`;
    }
    if (!cc.length) {
      core.ops('route_resolved', { verb: 'resume_code_session', outcome: 'no_match', query: (args && args.title_contains) || null });
      return 'No local Claude Code terminal session matches.' + override +
        (appMatches.length ? `\nBUT ${appMatches.length} Claude APP conversation(s) match that title:\n` + appMatches.map(s2 => `- [${s2.surface}] "${s2.title}"`).join('\n') + '\nGo there with open_conversation, or pull the work here with continue_from.' :
          ' If you meant a Claude APP conversation: those only become pullable after they hand off from their own side — in that conversation say "hand this off to code" (or /handoff code). Call list_conversations to see everything addressable.');
    }
    if (cc.length > 1 && args && args.pick === 'latest') cc = [cc[0]]; // already sorted newest-first
    const plausible = cc.length + (explicit ? 0 : appMatches.length);
    if (!explicit && plausible > 1) {
      core.ops('route_ambiguous', { verb: 'resume_code_session', query: (args && args.title_contains) || null, local_candidates: cc.length, app_candidates: appMatches.length });
      let stForApp = null;
      try { stForApp = await call('GET', '/api/state'); } catch (_) { /* optional */ }
      return `${plausible} plausible referents match — NOT acting until one is chosen. Ask by letter / recap / folder / latest — not a raw UUID:\n` +
        (cc.length ? 'Local terminal sessions (this tool resumes these):\n' + cc.slice(0, 8).map((c, i) =>
          `${String.fromCharCode(65 + i)} — "${c.title}" · ${age(c.mtime)} · ${c.folder}\n   Recap: local Claude Code terminal · reopen via --resume\n   (after you choose: session_id: ${c.id})`
        ).join('\n') + '\n' : '') +
        (appMatches.length ? 'Claude app / protocol conversations with the same title (NOT terminals — open_conversation or continue_from):\n' +
          (stForApp ? formatSessionCandidates(appMatches, stForApp) : appMatches.map(s2 => `- [${s2.surface}] "${s2.title}"`).join('\n')) + '\n' : '') +
        'Then: call again with session_id from the chosen card, or route to the verb matching their choice. pick:"latest" only if the user says latest.';
    }
    core.ops('route_resolved', { verb: 'resume_code_session', explicit: !!explicit, local_candidates: cc.length, app_candidates: appMatches.length, native: cc[0].id });
    const s = cc[0];
    const cmd = `claude --resume ${s.id}`;
    core.ops('resume_code_session', { native: s.id, folder: s.folder, store_override: process.env.CLAUDE_PROJECTS_DIR || null });
    if (process.env.CLAUDE_PROJECTS_DIR) {
      return `⚠ Refusing to auto-open: the session store is OVERRIDDEN (CLAUDE_PROJECTS_DIR=${process.env.CLAUDE_PROJECTS_DIR}) — this is how test fixtures masquerade as real sessions. If intentional, run manually: ${cmd}`;
    }
    if (process.platform === 'darwin') {
      try {
        const { spawn } = require('child_process');
        const dirGuess = s.folder.startsWith('/') ? s.folder : null;
        const script = dirGuess ? `cd ${JSON.stringify(dirGuess)} && ${cmd}` : cmd;
        const k = spawn('osascript', ['-e', `tell application "Terminal" to activate`, '-e', `tell application "Terminal" to do script ${JSON.stringify(script)}`], { detached: true, stdio: 'ignore' });
        k.unref(); k.on('error', () => {});
        return `Opening a NEW Terminal window resuming EXISTING local session "${s.title}" (${s.folder}, ${age(s.mtime)}). If it doesn't appear: ${cmd}`;
      } catch (_) {}
    }
    return `EXISTING local session "${s.title}" (${s.folder}, ${age(s.mtime)}). Run in a terminal: ${cmd}`;
  }
  if (name === 'open_conversation') {
    if (!args || !args.to_title) throw new Error('to_title required');
    // Referent check (t11): this verb only opens Recents and names a title to click, so
    // acting on one match is safe — but several protocol matches mean the TITLE the user
    // must click is itself ambiguous, and a same-titled terminal session means the user
    // may have wanted resume_code_session. Both get surfaced instead of guessed away.
    try {
      const st = await call('GET', '/api/state');
      const t = args.to_title.toLowerCase();
      let hits = Object.values(st.sessions).filter(s => !s.archived && s.surface !== 'code' && s.title.toLowerCase().includes(t));
      if (args.surface) hits = hits.filter(s => s.surface === args.surface);
      const term = localCodeSessions(30).filter(c => c.title.toLowerCase().includes(t));
      // confirm:true bypasses only the terminal-collision warning — several APP matches
      // still require narrowing by surface (confirm can't pick among them).
      if (hits.length > 1 || (!args.confirm && term.length)) {
        core.ops('route_ambiguous', { verb: 'open_conversation', query: args.to_title, app_candidates: hits.length, local_candidates: term.length });
        if (hits.length > 1) {
          return `${hits.length} app conversations match "${args.to_title}" — which one should the user click?\n` +
            formatSessionCandidates(hits, st) +
            (term.length ? `\n(Also ${term.length} local TERMINAL session(s) with this title — resume_code_session if they meant those.)` : '') +
            '\nAsk by letter / recap / latest — then call again with surface + session_id you selected (and confirm:true if a terminal also matched).';
        }
        return `Before opening: "${args.to_title}" also matches ${term.length} local TERMINAL session(s):\n` +
          term.slice(0, 8).map(c => `- "${c.title}" · ${age(c.mtime)} · ${c.folder}`).join('\n') +
          `\nA terminal session is resumed with resume_code_session, not clicked in the app. Ask the user which they meant; if the app conversation${hits.length ? ` "[${hits[0].surface}] ${hits[0].title}"` : ''}, call again with confirm:true.`;
      }
      core.ops('route_resolved', { verb: 'open_conversation', explicit: !!args.confirm, app_candidates: hits.length, local_candidates: term.length, query: args.to_title });
    } catch (e) { if (e && /required/.test(String(e.message))) throw e; /* store unreadable — still open Recents */ }
    const url = 'claude://claude.ai/chat/recents'; // invalid/missing id → app opens Recents (documented)
    let opened = false;
    if (!process.env.HANDOFF_NO_AUTOOPEN) {
      try {
        const { spawn } = require('child_process');
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        const k = spawn(opener, [url], { detached: true, stdio: 'ignore' });
        k.unref(); k.on('error', () => {});
        opened = true;
      } catch (_) {}
    }
    return (opened ? `The Claude app is opening at Recents — ` : `Open the Claude app's Recents — `) +
      `click the EXISTING conversation "${args.to_title}" to continue it. ` +
      `(App conversation IDs are server-side; no deep link reaches a specific one — this is the closest the platform allows. ` +
      `Tip: queue content there first with send_message so it's waiting when you arrive.)`;
  }
  /* REACHABILITY IS ASSERTED BY THE OWNING HOST, NEVER INFERRED BY AN OBSERVER.
   *
   * A pid means something only on the machine whose process table it belongs to. Checking one
   * here for a record owned by another device is inferring another host's process table from
   * our own — the same error as routing state through one daemon, applied to liveness instead.
   * It fails in the worst direction too: a live session on another device would read as
   * unreachable and a wake agent would skip a target that was sitting right there.
   *
   * So ownership decides who may answer:
   *   own host    → check the pid, which is meaningful here
   *   other host  → read that host's agent heartbeat; its agent resolved reachability LOCALLY
   *   no heartbeat, or one older than ~3 poll intervals → 'unknown'
   *
   * 'unknown' is a FOURTH value and must never collapse into 'none'. They are different facts:
   * 'none' means the owning host looked and found nothing; 'unknown' means nobody looked
   * recently. Collapsing them rebuilds the silent-degrade class removed on 2026-08-09 — a wake
   * agent skipping a leg because a stale heartbeat read as 'none' would fail with no evidence
   * trail. It is the held-vs-delivered distinction one layer down.
   *
   * This is also the platform's own doctrine: cross-machine sessions appear in /list-agents only
   * "while Remote Control is connected". Presence is asserted by the remote host's live
   * connection, never probed from the observer's side.
   *
   * A record carries no liveness claim of its own (S5): a record is data, reachability is the
   * owning agent's runtime assertion layered on top. That keeps the mint idempotent and makes a
   * record whose agent has died read honestly as 'unknown' rather than falsely as anything. */
  const HEARTBEAT_STALE_MS = 3 * 30 * 1000; // ~3 poll intervals at the 30s upper bound
  function reachabilityOf(sess, st) {
    const nr = sess && sess.native_ref;
    const remoteHost = sess && sess.remote && sess.remote.host;
    /* A record owned by another device has NO native_ref at all — the mint refuses to assert one
     * and its agent has not claimed it yet. Keying ownership off native_ref alone made those read
     * 'none' ("the owning host looked and found nothing"), which is the precise wrong-direction
     * failure the fourth value exists to prevent: nobody looked, and nobody had even been asked.
     *
     * FIXING A CLASS AT ONE LAYER DOES NOT FIX IT AT THE LAYER ABOVE. The commit that introduced
     * this vocabulary reintroduced the same failure one layer up, in itself. It surfaced only
     * because the test asserted the specific honest value ('unknown') rather than "some value
     * came back" — the second time in one day that distinction was the only thing standing
     * between a fix and its own regression. Assert the value, not the shape. */
    /* Keyed by the PROTOCOL RECORD ID, not by native_ref.session_id. A remote record has no
     * native_ref — the mint refuses to assert one — so keying the verdict off it meant a heartbeat
     * could never answer for exactly the records heartbeats exist to answer for. It would have sat
     * at 'unknown' forever with its host's agent running and reporting, and the acceptance test
     * (a remote record flipping to a host-asserted verdict) could not have passed. Found by trying
     * to run it rather than by reading it. The record id exists for every record, local or not. */
    if (!nr) return remoteHost ? remoteVerdict(remoteHost, sess.id, st) : 'none';
    /* os.hostname() ONLY — the override is gone here too, and it had to go from BOTH places at
     * once. A machine whose agent computed its name one way while its mount computed it another
     * would disagree with itself about which records it owns, which is the misnaming failure with
     * an extra layer. The device reports what it is called; nothing overrides it. */
    const here = !nr.host || nr.host === require('os').hostname();
    if (here) {
      if (!nr.pid) return 'stale-binding';
      try { process.kill(nr.pid, 0); return 'process'; }
      catch (e) { return e.code === 'EPERM' ? 'process' : 'stale-binding'; }
    }
    // Another device owns it. Only its agent may say, and only recently.
    return remoteVerdict(nr.host, sess.id, st);
  }
  /** The owning host's own verdict, or 'unknown'. Never a local inference. */
  function remoteVerdict(host, sessionKey, st) {
    const beat = (st && st.agents && st.agents[host]) || null;
    if (!beat || !beat.last_seen) return 'unknown';
    const age = Date.now() - Date.parse(beat.last_seen);
    if (!(age >= 0) || age > HEARTBEAT_STALE_MS) return 'unknown';
    const verdict = sessionKey && beat.sessions && beat.sessions[sessionKey];
    return verdict || 'unknown';
  }

  /* PEEK — read the inbox WITHOUT consuming it. The wake agent's only read verb.
   *
   * check_inbox marks what it shows as read, and it is scoped to a SURFACE rather than to the
   * caller's own records. That combination is fine for a human draining their own mail and is a
   * correctness bug for anything that polls: measured 2026-08-09, an inbox check from this
   * terminal marked another conversation's envelope and its nudge read, so the session they were
   * addressed to would have found an empty inbox and never known. A wake agent polling every
   * 15-30s would do that to every conversation on the surface, continuously.
   *
   * So peek exists as a separate verb rather than a flag on check_inbox: a flag would be one
   * default away from the same accident, and the agent must be structurally incapable of
   * consuming mail it is only watching for.
   *
   * It returns COUNTS AND ADDRESSES, never message bodies. The agent's job is to decide whether
   * to wake someone, which needs only "how much is waiting, for whom, and can it be reached" —
   * the text belongs to the reader. `since` makes repeat polls cheap, so interval tuning stops
   * being load-bearing. */
  /* REGISTER A DEVICE'S SESSION — the remote door's verb.
   *
   * Separate from register_session on purpose. register_session mints from a CLI uuid and refuses
   * without one, which is right for the local door: identity records are minted from a real
   * Claude Code session, never guessed. A device on the far side of the relay has no uuid HERE and
   * never will, so widening that refusal would weaken the local rule to serve a case it was never
   * about. Two doors, two keys.
   *
   * The record it mints is honest about what it is not: no native_ref (the owning host's agent
   * binds that), no liveness claim (peek reads the heartbeat), no transport claim (the registry
   * decides at delivery). It is addressable and visible from every device, and reachability reads
   * 'unknown' until that device's agent says otherwise — which is the correct state for a record
   * whose agent does not exist yet, not a degraded one.
   *
   * minted_by records WHO wrote it. A first record created from another machine on the device's
   * behalf is legitimate while that device has no credential yet, but it must never later be
   * mistaken for one the device's own agent wrote. */
  if (name === 'register_remote_session') {
    if (!args || !args.title) return 'REFUSED: title required — the record exists so a human can address it by name.';
    if (!args.device) return 'REFUSED: device required — name the machine this session runs on (e.g. "windows-laptop"). Without it the record cannot be deduplicated on reconnect, and reachability has no host to ask.';
    const mintedBy = (ctx && ctx.remote)
      ? `access:${(ctx && ctx.account_sub) || 'authenticated'}`
      : `local:${(ctx && ctx.cli_uuid) ? 'terminal' : 'bridge'}`;
    const r = await call('POST', '/api/register-remote', {}, {
      host: args.device, title: args.title, role: args.role,
      attested_by: (ctx && ctx.remote) ? 'access' : 'operator',
      account_sub: (ctx && ctx.account_sub) || null,
      minted_by: mintedBy,
    });
    if (!r || !r.session) return 'REFUSED: the store did not return a record.';
    const s = r.session;
    const onBehalf = !(ctx && ctx.remote);
    return `${r.minted ? 'Registered' : 'Refreshed'}: [code] "${s.title}" on device "${s.remote.host}"\n` +
      `session_id: ${s.id}\n` +
      `Identity: asserted, attested_by ${s.remote.attested_by}. NOT CLI-verified — no process on this machine answers for it, and none is claimed.\n` +
      `Reachability: unknown until that device's agent reports in. Unknown is not "unreachable"; it means nobody has looked recently.\n` +
      (onBehalf
        ? `Provenance: minted from HERE on that device's behalf (${mintedBy}), not by its own agent. Recorded on the record so it is not mistaken for one later.\n`
        : `Provenance: minted by the device itself over the authenticated relay.\n`) +
      `It is now visible and addressable from every device: send_to / send_message by the name "${s.title}".`;
  }

  if (name === 'peek_inbox') {
    const nativeId = (ctx && ctx.cli_uuid) || null;
    const surface = (args && args.surface) || (nativeId ? 'code' : 'chat');
    const since = args && args.since ? String(args.since) : null;
    const st = await call('GET', '/api/state');
    let sessions = Object.values(st.sessions).filter(s => !s.archived && s.surface === surface);
    if (args && args.title_contains) sessions = filterByName(sessions, args.title_contains);

    const rows = [];
    let newest = since;
    for (const s of sessions) {
      const fresh = freshMessages(s).filter(m => !since || String(m.id || '') > since);
      if (!fresh.length) continue;
      for (const m of fresh) if (!newest || String(m.id || '') > newest) newest = String(m.id || '');
      const nr = s.native_ref || null;
      // Whether a leg could even reach it, so the agent does not attempt a wake it cannot perform.
      rows.push({
        session_id: s.id, title: s.title, surface: s.surface,
        unread: fresh.length,
        returns: fresh.filter(m => m.kind === 'resume_summary').length,
        native_name: (nr && nr.name) || null,
        reachable: reachabilityOf(s, st),
      });
    }
    if (!rows.length) {
      return `PEEK ${surface}: nothing waiting${since ? ` since ${since}` : ''}. Cursor unchanged. Nothing was marked read — peek never consumes.`;
    }
    return `PEEK ${surface} — ${rows.length} conversation(s) holding unread mail. NOTHING MARKED READ.\n` +
      rows.map(r => `- "${r.title}"${r.native_name && r.native_name !== r.title ? ` (native: ${r.native_name})` : ''} · ${r.unread} unread${r.returns ? `, ${r.returns} return(s)` : ''} · reachable: ${r.reachable}\n  session_id: ${r.session_id}`).join('\n') +
      `\ncursor: ${newest || '(none)'} — pass it back as \`since\` to see only what is newer.` +
      `\nThe text stays unread and belongs to its reader; check_inbox in that conversation delivers it.`;
  }

  if (name === 'check_inbox') {
    const nativeId = (ctx && ctx.cli_uuid) || null;
    // Default to the surface this bridge actually lives on: a terminal bridge (CLI uuid
    // present) drains code, not chat. Found live 2026-08-08 — a terminal's no-arg drain
    // looked at chat, reported nothing, and left its own two queued probes unread.
    const surface = (args && args.surface) || (nativeId ? 'code' : 'chat');
    const st = await call('GET', '/api/state');
    /* OWN-HOST ONLY. This filtered by SURFACE ALONE, so every seat on the code surface drained
     * every code conversation in the store — including records belonging to other machines.
     *
     * Measured 2026-08-11, and it is the delivery bug the fleet spent two days chasing from the
     * wrong end: eight messages addressed to a Windows peer were marked read by this Mac's routine
     * inbox checks, minutes after each was sent. The peer reported an empty inbox every time and
     * was correct. Worse than losing them, the sender got a ✓✓ READ RECEIPT — so the system did not
     * merely fail to deliver, it reported a delivery that had never happened, which is the one
     * failure class this codebase exists to kill.
     *
     * The ownership rule already existed and was already enforced for the wake tier: a record
     * declaring another host belongs to that host's agent. check_inbox simply never asked. So it
     * asks now, by the same rule — a record with NO declared host is local and drainable, a record
     * declaring THIS machine is ours, and anything else is someone else's mail.
     *
     * Foreign mail is COUNTED AND REPORTED rather than silently skipped, because "you have no
     * mail" and "you have mail you may not read" are different facts, and hiding the second is how
     * this stayed invisible. */
    /* A REMOTE CALLER'S HOST IS NOT os.hostname(), AND THE TOOL RUNS ON THE STORE'S MACHINE.
     *
     * The ownership filter below asks "is this record mine", and for a LOCAL seat os.hostname() is
     * the honest answer. For a caller arriving over the relay it is the opposite of the answer:
     * the tool executes inside the daemon on the store host, so os.hostname() names the MAC while
     * the caller is a laptop. Scoping a remote drain by that value would hand a peer this
     * machine's mail — the same defect being fixed here, pointed the other way.
     *
     * The relay knows the caller is remote (ctx.remote) and knows nothing about which device it
     * is: it passes `sender_class: 'asserted'` and an account, never a host. So a remote caller
     * must SAY which host it is, exactly as agent_heartbeat already requires, and gets the same
     * treatment — the claim is asserted, not verified, and it is refused whole rather than guessed
     * at. Absence of a verifiable caller is not permission to drain someone's inbox. */
    const isRemoteCaller = !!(ctx && ctx.remote);
    const claimedHost = args && args.host ? String(args.host).trim() : null;
    if (isRemoteCaller && !claimedHost) {
      return `REFUSED: this call arrived over the relay, so which machine is asking cannot be established — ` +
        `and the store host's own name is NOT the answer, it is this tool's machine rather than yours. ` +
        `Nothing was read and nothing was marked read.\n\n` +
        `Pass host:"<this machine's os.hostname()>" to drain the records that declare it. The claim is ` +
        `ASSERTED, exactly as agent_heartbeat's is — which is why it is refused whole rather than guessed: ` +
        `a wrong guess here reads someone else's mail AND issues them a read receipt for it.`;
    }
    const HERE = claimedHost || require('os').hostname();
    const declaredHostOf = s => (s.remote && s.remote.host) || (s.native_ref && s.native_ref.host) || null;
    let sessions = Object.values(st.sessions).filter(s => !s.archived && s.surface === surface);
    const foreign = sessions.filter(s => {
      const h = declaredHostOf(s);
      return h && h !== HERE && freshMessages(s).length;
    });
    sessions = sessions.filter(s => {
      const h = declaredHostOf(s);
      return !h || h === HERE;
    });
    if (args && args.title_contains) {
      const t = args.title_contains.toLowerCase();
      sessions = sessions.filter(s => s.title.toLowerCase().includes(t));
    }
    const out = [];
    let returnTotal = 0;
    for (const s of sessions) {
      // t21 Bug A: reads both kinds. Returns are labeled ↩ RETURN so a completed
      // round-trip never reads as just another queued message.
      const fresh = freshMessages(s);
      if (fresh.length) {
        returnTotal += fresh.filter(m2 => m2.kind === 'resume_summary').length;
        out.push(`"${s.title}":\n` + fresh.map(m2 =>
          m2.kind === 'resume_summary'
            ? `  - ↩ RETURN (transaction closed): ${m2.text}`
            : `  - ${m2.text}`
        ).join('\n'));
        await call('POST', `/api/sessions/${s.id}/messages`, {}, { role: 'system', kind: 'progress', text: `inbox checked in ${surface}` });
        // Ambient tier: mark each drained message READ on its own record (read_at +
        // read_in). The sender's status renders that state as ✓✓ inline. No receipt
        // message is written — the core refuses the kind — so a drain can never create
        // new inbox items, and receipt-of-receipt is unwritable rather than guarded.
        for (const m2 of fresh) {
          if (!m2.from_session || m2.from_session === s.id) continue;
          try {
            await call('POST', `/api/sessions/${s.id}/messages/${m2.id}/state`, {}, {
              read_in: { surface: s.surface, title: s.title }
            });
          } catch (_) { /* state stamp is best-effort; the drain itself already succeeded */ }
        }
      }
    }
    /* Named, never silent. A count with the hosts attached lets a human see instantly that mail
     * exists and is not theirs — which is the fact that was invisible while this drained it. */
    const foreignNote = foreign.length
      ? `\n\n${foreign.length} conversation(s) on this surface hold unread mail for ANOTHER host ` +
        `(${[...new Set(foreign.map(declaredHostOf))].join(', ')}) — not shown and NOT marked read. ` +
        `Only an agent on that machine may drain them.`
      : '';
    /* AN EMPTY ANSWER MUST NAME THE QUESTION IT ANSWERED.
     *
     * "No unread messages or returns for code conversations." was returned both by a call scoped
     * to a host that owns nothing AND by the older build that dropped `host` entirely and checked
     * the whole surface. Byte-identical. So a peer verifying the scoping got a sentence that was
     * true in two different worlds and distinguished neither, and could only establish which one
     * it was in by running a SECOND call and comparing — which is exactly the round trip and the
     * two-worlds analysis this sentence caused.
     *
     * getState already refuses this shape one layer down: `sessions: null` rather than `{}`,
     * because "cannot enumerate" and "none exist" are different facts. Same rule here. Naming the
     * host makes the empty answer stand on its own as evidence, and would have made the old
     * build's silent drop visible on the FIRST call rather than the third. Proposed by the peer
     * that paid for the ambiguity. */
    if (!out.length) {
      const scope = claimedHost
        ? `no records declare host "${claimedHost}" on surface ${surface}`
        : `no unread messages or returns for ${surface} conversations on this host ("${HERE}")`;
      return `${scope.charAt(0).toUpperCase()}${scope.slice(1)}.${foreignNote}`;
    }
    return `Unread messages:\n${out.join('\n')}` + foreignNote +
      (returnTotal ? `\n\n${returnTotal} of these ${returnTotal === 1 ? 'is a' : 'are'} completed RETURN(s) — the work came back and the transaction is closed. Report it as delivered, not as still owed.` : '');
  }
  if (name === 'withdraw_handoff' || name === 'decline_handoff') {
    const declining = name === 'decline_handoff';
    if (declining && (!args || !args.reason)) throw new Error('reason required — a refused handshake owes the origin one sentence of why');
    const st = await call('GET', '/api/state');
    const claimed = settledDestIds(st);
    const state = s => offerStateOf(s, claimed);
    let candidates = Object.values(st.sessions).filter(s => s.origin_ref && !s.archived && state(s) === 'offered');
    if (declining) candidates = candidates.filter(s => s.surface === ((args && args.surface) || 'chat'));
    else if (args && args.surface) candidates = candidates.filter(s => s.surface === args.surface);
    if (args && args.title_contains) { const t = args.title_contains.toLowerCase(); candidates = candidates.filter(s => s.title.toLowerCase().includes(t)); }
    if (args && args.session_id) candidates = candidates.filter(s => s.id === args.session_id);
    if (!candidates.length) return `No PENDING handoff matches${args && args.title_contains ? ` "${args.title_contains}"` : ''}. Only unshaken hands can be ${declining ? 'declined' : 'withdrawn'} — completed transactions are closed (talk to that conversation with send_message).`;
    if (candidates.length > 1) {
      return `${candidates.length} pending handoffs match — which one?\n` +
        formatSessionCandidates(candidates, st) +
        `\nAsk by letter / recap / latest — then call again with session_id (you fill it).`;
    }
    const dest = candidates[0];
    if (declining) {
      const r = await call('POST', `/api/sessions/${dest.id}/decline`, {}, { reason: args.reason });
      return `Declined "${dest.title}" — offer closed permanently. ${r.origin_notified ? `The origin (${dest.origin_ref.surface}) receives your reason as a queued message on its next check.` : 'Origin record missing — reason recorded on the offer only.'} The origin can re-send.`;
    }
    await call('POST', `/api/sessions/${dest.id}/withdraw`, {}, { reason: (args && args.reason) || '' });
    return `Withdrawn "${dest.title}" (was addressed to ${dest.surface}) — it no longer appears in any pending list, and its return link (if any) is closed. The origin stays resumable.`;
  }
  if (name === 'list_workers') {
    const banner = await attentionBanner(ctx, core);
    const ws = await call('GET', '/api/workers');
    if (!ws.length) return banner + 'No workers yet. Use send_to_worker to dispatch one — or call status for what is waiting.';
    return banner + ws.map(w =>
      `- ${w.worker_id} [${w.status}${w.working ? ' · still working' : ''}${w.orphaned ? ' · ⚠ ORPHANED — silent past the threshold; reopen it or close with return_to_origin outcome:"failed"' : ''} → ${w.dest_surface || 'code'}] task: ${w.task}` +
      (w.native_ref ? `\n  native session: ${w.native_ref.session_id} · ${w.native_ref.resume}` : '') +
      (w.summary ? `\n  summary: ${w.summary}` : '')
    ).join('\n');
  }

  // ---- register_session (slice 3b-10): the IDENTITY writer, contract v3 ----
  // The last tool, and the one that forced the envelope to grow. It resolves the caller's
  // own protocol record, which the caller must then remember — exactly the shape the pin
  // already had. So ctx_update gains `identity` alongside `pinned`: the tool layer is the
  // sole writer of both, the caller applies what comes back. Without this a pure forwarder
  // could register but never learn its own record id, and its status would say "not yet
  // registered" immediately after registering.
  if (name === 'register_session') {
    const nativeId = (ctx && ctx.cli_uuid) || null;
    if (!nativeId) {
      return 'REFUSED: no CLI uuid in this environment (CLAUDE_CODE_SESSION_ID unset) — identity records are minted only from a real Claude Code session, never guessed (I2).';
    }
    const r = await identitySession(ctx, core, {
      title: args ? args.title : undefined, role: args ? args.role : undefined,
      // Adoption is EXPLICIT or it does not happen: the caller passes an id it already holds
      // from its own thread. Nothing here searches for candidates — a helpful suggestion
      // would be the guess the invariant forbids, wearing a friendly face.
      succeeds: args ? args.succeeds : undefined,
      adoption_evidence: args ? args.adoption_evidence : undefined
    });
    if (r && r.error) return `REFUSED: ${r.error}`;
    const s = r.session;
    // The tab you are looking at follows the name you just gave. Best-effort and silent on
    // failure: a title that did not take must never make naming look like it failed.
    const titledTty = (args && args.title) ? setTerminalTitle(ctx && ctx.cli_pid, s.title, nativeId) : null;
    const cwd = s.native_ref && s.native_ref.cwd;
    const nativeName = s.native_ref && s.native_ref.name;
    const handle = `code · ${cwd ? require('path').basename(cwd) : s.title}${s.role ? ' · ' + s.role : ''}`;
    // Name unification: the native session name is the one display handle; the protocol
    // title, when set explicitly, is the alias. Show both so they never silently diverge.
    const nameLine = nativeName
      ? (nativeName === s.title ? `\nDisplay name (native): ${nativeName}` : `\nDisplay name (native): ${nativeName} · alias: "${s.title}"`)
      : '';
    return {
      text: `${r.minted ? 'Registered' : 'Refreshed'}: ${handle} — "${s.title}"${nameLine}\n` +
        (titledTty ? `Terminal tab renamed to "${s.title}".\n`
          : (args && args.title ? `The terminal TAB still shows Claude Code's own title — it re-asserts that continuously, so naming cannot change it (anthropics/claude-code#56933). Use /rename to change what Claude Code itself calls this session.\n` : '')) +
        `CLI uuid ${nativeId} ↔ protocol record ${s.id}. ` +
        `Sends from this terminal are now attributed to this record; read state (✓✓) on them shows up inline in status.`,
      ctx_update: { identity: r.id },
    };
  }
  throw new Error(`tool "${name}" is not served by the shared tool layer: ${name}`);
}

/* Identity substrate (slice 3b-7), moved with send_message — its first migrated caller.
 * Native writes ~/.claude/sessions/<pid>.json with sessionId === the caller's CLI uuid;
 * that file carries the display name, cwd and messaging socket, and we ADOPT them rather
 * than mint a parallel identity. In the daemon this is read per REQUEST from ctx.cli_uuid,
 * never from a process global — which is the whole point: the daemon serves many terminals,
 * and each one's identity must come from its own ctx. Read-only; a missing registry is
 * non-fatal (the caller is simply anonymous). */
function readNativeRegistration(nativeId, preferPid) {
  if (!nativeId) return null;
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = process.env.HANDOFF_NATIVE_SESSIONS_DIR || path.join(os.homedir(), '.claude', 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch (_) { return null; }
  /* A uuid can have SEVERAL live rows (measured: /exit + `claude --continue` left two pids
   * both registered under one session id). First-match then returns whichever the
   * filesystem listed first — which is how this record came to record the OTHER window's pid.
   * The caller knows its own pid; prefer its row, and never infer identity from listing order. */
  const rows = [];
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (r && r.sessionId === nativeId) rows.push(r);
    } catch (_) { /* one bad registry file must not sink identity */ }
  }
  const pick = (preferPid && rows.find(r => r.pid === preferPid)) || rows[0] || null;
  for (const r of (pick ? [pick] : [])) {
    {
      return {
        name: r.name || null, cwd: r.cwd || null,
        messaging_socket: r.messagingSocketPath || null,
        pid: r.pid || null, name_source: r.nameSource || null
      };
    }
  }
  return null;
}
/* PROCESS-SCOPED ADDRESSES ARE NEVER PERSISTED **OR CACHED**. Probed 2026-08-09 on a live
 * `claude --resume`: resume FORKS a new session id and a new transcript (probed live: the uuid changes)
 * and records no lineage pointer, so CLAUDE_CODE_SESSION_ID is transcript-scoped, not
 * conversation-scoped. A bridge that froze it in a module constant at process start therefore
 * served an id with no transcript behind it at all — unresolvable, not merely stale — and the
 * wake tier read the resulting miss as "that terminal is CLOSED".
 * The registry is the authority, and it is keyed by PID: when a resume forks a new session id
 * under the same CLI process, that process's row is rewritten with the NEW id. So resolving
 * pid → row → sessionId asks, at the moment of use, "who is this process right now?".
 * Returns { id, source, healed, stale_id } — `healed` is surfaced by callers, never swallowed. */
function resolveLiveNativeId(opts) {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = process.env.HANDOFF_NATIVE_SESSIONS_DIR || path.join(os.homedir(), '.claude', 'sessions');
  const envId = (opts && opts.env_id) || null;
  const pid = (opts && opts.pid) || null;
  const alive = p => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  // The registry CORRECTS an identity; it never MANUFACTURES one. Without an env id this
  // caller is deliberately anonymous, and pid resolution must stay out of it — CLAUDE_PID is
  // inherited by every child process, so resolving from it alone let an anonymous bridge
  // adopt whichever session happened to spawn the test runner (caught by mcp-smoke's
  // anonymous-send assertions, which is exactly what they are for).
  if (!envId) return { id: null, source: 'none', healed: false, stale_id: null, pid: null };
  // 1. Authoritative: our OWN CLI process's row, read fresh.
  if (pid && alive(pid)) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, `${pid}.json`), 'utf8'));
      if (r && r.sessionId) {
        const healed = !!(envId && envId !== r.sessionId);
        return { id: r.sessionId, source: 'registry_pid', healed, stale_id: healed ? envId : null, pid };
      }
    } catch (_) { /* no row for our pid — fall through, never throw */ }
  }
  // 2. The frozen env id, honoured ONLY while a live row still carries it.
  if (envId) {
    const row = readNativeRegistration(envId);
    if (row && row.pid && alive(row.pid)) return { id: envId, source: 'registry_env', healed: false, stale_id: null, pid: row.pid };
    // Loud: an id no live process answers to is a dangling pointer, and callers must say so
    // rather than let it read as "closed".
    return { id: envId, source: 'env_unresolvable', healed: false, stale_id: envId, pid: null };
  }
  return { id: null, source: 'none', healed: false, stale_id: null, pid: null };
}
/** Mint or refresh the CALLER's own protocol record, from ctx — never a module global. */
async function identitySession(ctx, core, extra) {
  const nativeId = ctx && ctx.cli_uuid;
  if (!nativeId) return null;
  const callerPid = (ctx && ctx.cli_pid) || null;
  const nat = readNativeRegistration(nativeId, callerPid);
  /* The CALLING process knows its own pid — that is a fact. The registry lookup is an
   * inference, and with two rows on one uuid it picked the wrong window. So the caller's pid
   * wins, which also makes native_ref.pid mean something precise: THE PROCESS THAT LAST
   * SPOKE TO US. That is evidence of which window the user is actually driving, and it is what
   * lets multi-claimant succession resolve by construction instead of by guess. */
  const pid = callerPid || (nat && nat.pid) || null;
  const body = Object.assign(
    { native_id: nativeId, cwd: (nat && nat.cwd) || (ctx && ctx.cwd) || process.cwd() },
    pid ? { pid } : {},
    nat ? { native_name: nat.name, messaging_socket: nat.messaging_socket } : {},
    extra || {});
  return (await core.handleApi('POST', '/api/register', {}, body)).payload;
}
/* Refresh this terminal's binding on EVERY tool contact (ruling 2): the record's
 * uuid/pid/cwd are a last-known hint, and a hint that is never refreshed is how the wake
 * tier ends up addressing a dead process. Cheap and idempotent — /api/register is an upsert
 * — but pointless more than once a few seconds, so it is throttled per uuid. Failure is
 * non-fatal by construction: a tool call must never fail because identity bookkeeping did. */
const LAST_TOUCH = new Map();
async function touchBinding(ctx, core) {
  try {
    const uuid = ctx && ctx.cli_uuid;
    if (!uuid || !core) return null;
    const last = LAST_TOUCH.get(uuid) || 0;
    const nowMs = Date.now();
    if (nowMs - last < 5000) return null;
    LAST_TOUCH.set(uuid, nowMs);
    return await identitySession(ctx, core, { refresh_only: true });
  } catch (_) { return null; }
}

/* ---- Send-side guards (slice 3b-8), moved with send_to / send_to_surface ----
 * All four are pure argument validators returning a refusal string or null: they read no
 * session state at all, so they carry across untouched. They are the protocol's "refuse
 * before mutating" layer — every one of them exists because a real send lost something. */

/** t17: app surfaces cannot dereference paths — refuse name-only artifacts at send time. */
function assertArtifactsForAppSurface(to, artifacts) {
  if (!to || to === 'code') return null;
  const missing = (artifacts || []).filter(a => a && a.name && !(a.content && String(a.content).length));
  if (!missing.length) return null;
  const names = missing.map(a => a.name).join(', ');
  return (
    `REFUSED: cannot send artifact(s) [${names}] to ${to} without inline content. ` +
    `${to} has no filesystem — by-reference delivery is unreachable there (t8 Design, t17 Chat). ` +
    `Read the file and pass artifacts[].content by value (split via send_message if huge). Nothing was sent.`
  );
}
/** Lesson 2 (OPERATING-LESSONS): a return CONTRACT that asks for a deliverable back MUST
 * demand it BY VALUE, in the return. "deliver the report" without "by value" is invalid — it
 * is the human-as-bridge failure re-encoded as a contract (t17 extended to return contracts).
 * Refused at send time. A contract for a decision/confirmation (no deliverable named) is fine. */
// Deliberately the unambiguous DOCUMENT words only — a heavy artifact a filesystem-less
// surface cannot hand back except by value. Lightweight returns ("review notes", "the Q3
// numbers", "room confirmation") are not caught; the lesson is about documents, not every noun.
const RETURN_DELIVERABLE = /\b(reports?|summar(?:y|ies)|documents?|artifacts?|decks?|write-?ups?|deliverables?)\b/i;
const RETURN_FILENAME = /\b[\w.-]+\.(?:md|txt|markdown|pdf|docx?|html?|csv|json|jsonl|js|ts|tsx|jsx|py|png|jpg|svg)\b/i;
function assertReturnContract(expectedReturn) {
  if (!expectedReturn) return null;
  const s = String(expectedReturn);
  if (!(RETURN_DELIVERABLE.test(s) || RETURN_FILENAME.test(s))) return null; // decision/confirmation contract — fine
  if (/by[\s-]?value/i.test(s)) return null;                                  // already demands by-value
  return `REFUSED: this return contract asks for a deliverable back ("${clipText(s, 80)}") but does not demand it BY VALUE, in the return. ` +
    `A surface with no filesystem cannot hand back bytes any other way, and "deliver the report" without "by value" is exactly how the human ends up relaying it by hand ` +
    `(OPERATING-LESSONS Lesson 2 — t17 extended to return contracts). Re-send with expected_return naming the artifact(s) and the words "by value" ` +
    `(e.g. "the completion report, by value, in the return"). Nothing was sent.`;
}
/** t18: Desktop Code deep-link binds to whatever project tab is active — require explicit ack. */
function assertCodeProjectTarget(args) {
  if (!args || args.to !== 'code') return null;
  if ((args.open_in || 'app') === 'none') return null;
  const pid = args.project_state && args.project_state.project_id;
  if (pid || args.confirm_code_project === true) return null;
  return (
    `REFUSED: send_to code would open the Claude app Code tab in whichever project that tab currently has loaded ` +
    `(live t18: handoff-poc work landed under an unrelated project with no user confirmation). ` +
    `Re-call with project_state.project_id naming the intended folder/repo, or confirm_code_project:true ` +
    `if you intentionally want the active Code-tab project. Prefer open_in:"none" + pick_up in the IDE/terminal ` +
    `you already have open. Nothing was sent.`
  );
}
/** Queue overflow bytes after the brief cap so chat/cowork can still review large files (t17). */
async function queueArtifactOverflow(core, destId, artifacts, target, fromSessionId) {
  // t21 Bug E: code was skipped here because its brief claimed the remainder was
  // reachable "by reference". It never was, so an over-cap artifact to code simply lost
  // its tail. The brief now promises continuation parts — this is what makes that true.
  if (!destId) return '';
  const cap = core.artifactCap(target);
  const notes = [];
  for (const a of artifacts || []) {
    if (!a || !a.content || a.content.length <= cap) continue;
    const rest = a.content.slice(cap);
    const chunkSize = 5500;
    const parts = [];
    for (let i = 0; i < rest.length; i += chunkSize) parts.push(rest.slice(i, i + chunkSize));
    const total = parts.length + 1;
    for (let i = 0; i < parts.length; i++) {
      await core.handleApi('POST', `/api/sessions/${destId}/messages`, {}, {
        role: 'user',
        kind: 'xmsg',
        from_session: fromSessionId || null,
        text: `[${i + 2}/${total}] ${a.name} BY VALUE (continuation — brief carried part 1/${total})\n\n${parts[i]}`
      });
    }
    notes.push(`${a.name}: ${parts.length} inbox continuation part(s)`);
  }
  return notes.length ? ` Overflow queued: ${notes.join('; ')}.` : '';
}

/** t21 Bug C: the return leg gets the same by-value rule as send_to. A dest with no
 * filesystem cannot deliver a document by reference, so a summary that NAMES a file
 * without carrying it is a promise the protocol cannot keep — refuse at return time
 * rather than let the origin discover the file exists nowhere.
 * Moved here in 3b-6 with return_to_origin, its only caller on the close path. */
const FILE_MENTION = /\b[\w.-]+\.(md|txt|markdown|js|ts|tsx|jsx|py|json|jsonl|csv|html|css|ya?ml|sql|sh|tex)\b/gi;
function assertReturnArtifacts(destSurface, summary, artifacts) {
  const list = artifacts || [];
  const nameOnly = list.filter(a => a && a.name && !(a.content && String(a.content).length));
  if (nameOnly.length) {
    return `REFUSED: return artifact(s) [${nameOnly.map(a => a.name).join(', ')}] have no inline content. ` +
      `The return leg carries bytes only by value — a name alone reaches nothing. Nothing was returned; re-call with artifacts[].content.`;
  }
  // Enforced only where the dest COULD have carried the bytes and did not: chat and
  // cowork author documents as conversation text. code shares the filesystem, so a path
  // dereferences. Design renders into its own canvas, has no handoff MCP, and is
  // proxy-closed from Code where the file does not exist either — its returns are
  // name-plus-confirmation by construction (t8/t9), so a mention there is not a broken
  // promise. Refusing them would close Design's only path to closing a link at all.
  if (destSurface !== 'chat' && destSurface !== 'cowork') return null;
  const carried = new Set(list.map(a => String(a.name).toLowerCase()));
  const named = [...new Set((String(summary).match(FILE_MENTION) || []).map(x => x.toLowerCase()))]
    .filter(n => !carried.has(n));
  if (!named.length) return null;
  return (
    `REFUSED: the summary names ${named.join(', ')} but the return carries no such artifact, and ${destSurface} has no filesystem — ` +
    `there is nowhere for the origin to find that file (live t21: a cowork brainstorm returned a summary naming EXPERIMENT-FORM-PROBE.md, ` +
    `which existed on no disk anywhere). Re-call with artifacts:[{name, content}] carrying the full text by value, or rewrite the summary ` +
    `so it does not promise a file. Nothing was returned; the link is still open.`
  );
}

/* Discover local Claude Code terminal sessions the same way `claude --resume` does:
 * read ~/.claude/projects/<cwd-slug>/<uuid>.jsonl. UUIDs stay internal — users see
 * titles, age and folder; the system resolves and logs identifiers itself.
 * Moved here in 3b-5 as a continue_from dependency. Machine-local and read-only: the
 * daemon runs on the same machine as its forwarders, so it reads the same registry. */
function localCodeSessions(limit) {
  const fs = require('fs'), os = require('os'), path = require('path');
  const root = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
  const out = [];
  try {
    for (const proj of fs.readdirSync(root)) {
      const pdir = path.join(root, proj);
      let files = [];
      try { files = fs.readdirSync(pdir).filter(f => /^[0-9a-f-]{36}\.jsonl$/.test(f)); } catch (_) { continue; }
      for (const f of files) {
        const fp = path.join(pdir, f);
        try {
          const fd = fs.openSync(fp, 'r');
          const buf = Buffer.alloc(131072);
          const n = fs.readSync(fd, buf, 0, 131072, 0);
          fs.closeSync(fd);
          const head = buf.toString('utf8', 0, n);
          let title = null;
          // Skip machine noise when deriving a title: our own STALE BRIDGE warning once
          // leaked into a session title via the first tool response (found by the Cowork
          // agent reading the list). Take the first candidate that reads like content.
          const noise = t => /STALE BRIDGE|^⚠|^\[Image:/.test(t);
          for (const rx of [/"summary"\s*:\s*"((?:[^"\\]|\\.){4,120})/g, /"text"\s*:\s*"((?:[^"\\]|\\.){8,120})/g]) {
            let mm;
            while (!title && (mm = rx.exec(head))) {
              try { const t = JSON.parse('"' + mm[1] + '"'); if (!noise(t)) title = t; } catch (_) {}
            }
            if (title) break;
          }
          out.push({
            id: f.slice(0, -6),
            title: (title || '(untitled session)').slice(0, 80),
            mtime: fs.statSync(fp).mtimeMs,
            folder: proj.replace(/^-/, '/').replace(/-/g, '/')
          });
        } catch (_) {}
      }
    }
  } catch (_) { /* no local store — not a Claude Code machine or fresh install */ }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit || 8);
}

/* ---------------- Display-helper chain (slice 3b-4) ----------------
 * Pure presentation, moved here from mcp-handoff.js ahead of the heavy tools that need it
 * (send_to_surface, send_message, status/buildStatusReport all render candidate cards).
 * These take (session, state) and NOTHING else — no ctx, no core, no I/O — so they are
 * trivially safe in a shared process: there is no per-session state for two callers to
 * cross. Moving them first means the heavy tools migrate as a pure lift, with their
 * rendering dependency already on this side of the line. */

function age(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}
function clipText(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}
/* t21 Bug B — dest ids whose link has SETTLED (resolved/failed/withdrawn/declined).
 * A settled link outranks a live 'offered' flag: the flag only means "pick_up was never
 * called", which is routine when the dest works the brief straight from the deep link. */
/* One line for callers still naming the demoted verb. The WHY lives in the spec and the
 * changelog, once — rationale repeated in every result is documentation in the wrong place. */
const DEPRECATION_NOTE = '\n\n(send_to_surface is retired — use send_to with mode:"new". This call worked; reconnect to refresh your tool list.)';
/* SELF-EXECUTING SUNSET — REMOVE THIS DISPATCH AT THE NEXT CONTRACT BUMP.
 * The handler exists for exactly one reason: MCP clients cache the tool list for the life of
 * a connection, so a caller may still hold the old name. A CONTRACT bump ends that window by
 * construction — the daemon refuses a mismatched forwarder as fatal, Claude Code respawns it,
 * and the fresh list cannot contain a name we no longer advertise. So the grace is
 * connection-lifetime, not back-compat, and it expires on its own rather than on someone
 * remembering. Past the sunset contract this refuses instead of serving, and says why. */
const SUNSET_AT_CONTRACT = 3;
/* TAB TITLE — CANNOT BE SET FROM HERE, and the attempt is removed rather than retried.
 * Measured, then sourced. The tty resolves correctly (/dev/ttys082 for this session) and the
 * OSC 0 write succeeds — but Claude Code OWNS the terminal title and re-asserts it
 * continuously (anthropics/claude-code#56933: "emits an OSC 0/2 escape sequence setting the
 * host terminal's tab/window title ... and re-asserts it continuously"). The same issue
 * records this exact approach failing: a wrapper re-emitting every second loses because "CC
 * re-asserts faster", and "Cursor prioritizes the foreground process's OSC name over external
 * writes". So the write is not flaky, it is futile by construction, and no retry or interval
 * can win a race against the process that owns the surface.
 * It shipped as "Terminal tab renamed to X" because the WRITE succeeded — an effect asserted
 * from a successful syscall, never verified. That is A12 exactly, the same shape as the
 * "Started a turn" claim removed earlier the same day, committed by the person who removed it.
 * Writing bytes into the user's terminal for no benefit is worse than doing nothing, so nothing is
 * written. The fix belongs upstream: #56933 asks for CLAUDE_CODE_DISABLE_TERMINAL_TITLE or
 * --no-terminal-title. If either ships, restore the write and verify the EFFECT, not the call.
 * Kept as a function so callers stay unchanged and the reason travels with the code. */
function setTerminalTitle() { return null; }
/* WHO ELSE IS HOLDING THIS SESSION ID.
 * A session id is an ADDRESS, not a lock. Nothing in the CLI makes one exclusive: two
 * terminals reach the same session through `--continue` (which resumes the most recent
 * session in the DIRECTORY, not the one this terminal had) and equally through
 * `--resume <id>` typed twice. Neither warns, and the merge is permanent — both processes
 * then keep that transcript newest, so the next --continue lands there too.
 * Every identity fix in this codebase handles the CONSEQUENCE of that. None prevent it,
 * because it happens below us. What we can do is stop someone discovering it by seeing a
 * corrupted name, which is how it was found twice. Returns the OTHER live claimants. */
function otherLiveClaimants(uuid, myPid) {
  const out = [];
  if (!uuid) return out;
  try {
    const fs = require('fs'), os = require('os'), path = require('path');
    const dir = process.env.HANDOFF_NATIVE_SESSIONS_DIR || path.join(os.homedir(), '.claude', 'sessions');
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!r || r.sessionId !== uuid || !r.pid || r.pid === myPid) continue;
        try { process.kill(r.pid, 0); } catch (e) { if (e.code !== 'EPERM') continue; }
        out.push({ pid: r.pid, name: r.name || null });
      } catch (_) {}
    }
  } catch (_) {}
  return out;
}
/* A SUPERSEDED RECORD IS NOT A TARGET.
 * Adoption relinks DELIVERY through the successor chain, and that much shipped — but every
 * surface that OFFERS a destination kept advertising the old record, and the picker even
 * recommended one. Half a migration: sends resolved correctly while every list still pointed
 * at a record whose binding was dead. The superseded record stays readable — its history is
 * the reason it exists — it simply stops being selectable. */
/* RETIRED RECORDS LEAVE RESOLUTION, and this one function is why that is cheap: every by-name
 * path funnels through here, so a retired record stops being addressable everywhere at once
 * rather than in the places someone remembered to check.
 *
 * `include_retired` shows them again, because "gone" and "hidden" must stay distinguishable — a
 * record that has ended still has a history someone will need to read, and a store that cannot
 * show you an ending is as unhelpful as one that pretends there wasn't one. */
function isTargetable(s, opts) {
  if (!s || s.archived || s.superseded_by) return false;
  if (s.retired && !(opts && opts.include_retired)) return false;
  return true;
}
/* Walk the append-only successor chain over a state snapshot — the tools-layer twin of
 * handoff-core's resolveSuccessor. Capped and cycle-checked: a looping lineage must refuse,
 * not hang a send. Returns the final record id plus how many hops it took. */
const SUCCESSOR_HOPS_MAX = 8;
function resolveSuccessorIn(st, id) {
  const sessions = (st && st.sessions) || {};
  const seen = new Set();
  let cur = id, hops = 0;
  while (hops < SUCCESSOR_HOPS_MAX) {
    const s = sessions[cur];
    if (!s || !s.superseded_by || seen.has(cur)) break;
    seen.add(cur);
    if (!sessions[s.superseded_by]) break; // dangling: stay put rather than vanish
    cur = s.superseded_by; hops++;
  }
  return { id: cur, hops };
}
/* Dests whose offer was CLAIMED, judged from the state snapshot. Mirrors
 * handoff-core's claimEvidence: only a RESOLVED link counts as claim-by-return.
 * A failed link is not a shaken hand — see the offer-state block in handoff-core.js. */
function settledDestIds(st) {
  return new Set(Object.values((st && st.links) || {})
    .filter(l => l.status === 'resolved')
    .map(l => l.dest));
}
function offerIsPending(s, claimed) {
  if (s.archived) return false;
  if (!s.origin_ref) return false;
  if (s.offer && s.offer !== 'offered') return false;
  if (s.claimed_at) return false;
  if (s.messages && s.messages.some(m => m.kind === 'progress' && /^picked up in /.test(m.text))) return false;
  if (claimed && claimed.has(s.id)) return false; // returned work ⇒ the hand was shaken
  return !s.offer || s.offer === 'offered';
}
/** Offer state from a state snapshot — the tools-layer twin of core's offerState. */
function offerStateOf(s, claimed) {
  if (!s.origin_ref) return null;
  if (s.offer && s.offer !== 'offered') return s.offer;
  if (s.claimed_at) return 'completed';
  if (s.messages && s.messages.some(m => m.kind === 'progress' && /^picked up in /.test(m.text))) return 'completed';
  if (claimed && claimed.has(s.id)) return 'completed';
  return 'offered';
}
/** One-line recap for ambiguity lists (Claude Code–style “recap”, not a UUID). */
function sessionRecap(s) {
  const ps = s.project_state;
  if (ps && ps.context_change) return clipText(ps.context_change, 180);
  if (ps && Array.isArray(ps.progress) && ps.progress.length) {
    return clipText(ps.progress[ps.progress.length - 1], 180);
  }
  const msgs = s.messages || [];
  // Prefer real task context over short locked-decision echoes ("No clipboard…").
  const scored = [...msgs].reverse().filter(m => {
    const t = m.text || '';
    if (t.length < 48) return false;
    if (/^(Docs copy travels|No user-facing|No clipboard)/i.test(t)) return false;
    return m.kind === 'context' || m.kind === 'handoff_card' || m.kind === 'xmsg' ||
      (m.role === 'user' && (m.kind === 'chat' || !m.kind));
  });
  if (scored[0]) return clipText(scored[0].text, 180);
  if (s.open_items && s.open_items[0]) return 'Open: ' + clipText(s.open_items[0], 160);
  if (s.notes && s.notes.expected_return) return 'Return owed: ' + clipText(s.notes.expected_return, 140);
  return '(no recap yet)';
}
function sessionCarrierNote(s) {
  const arts = s.artifacts || [];
  if (!arts.length) return 'no artifacts';
  return arts.slice(0, 3).map(a => {
    const n = (a.content && a.content.length) || 0;
    const name = a.name || 'file';
    // Heuristic: pre-rewrite GETTING-STARTED snapshots were ~8KB; current ~11KB.
    let tag = '';
    if (/GETTING-STARTED|getting-started\.md/i.test(name) && n > 0 && n < 9000) tag = ' · stale snapshot';
    else if (/GETTING-STARTED|getting-started\.md/i.test(name) && n >= 10000) tag = ' · current file';
    else if (!n) tag = ' · by-ref';
    return `${name} ${n ? n + 'b' : ''}${tag}`.trim();
  }).join('; ');
}
function sessionLinkNote(s, st) {
  const links = Object.values((st && st.links) || {});
  const asOrigin = links.filter(l => l.origin === s.id);
  const asDest = links.filter(l => l.dest === s.id);
  const bits = [];
  const settledIn = asDest.some(l => l.status && l.status !== 'active');
  if (settledIn && (!s.offer || s.offer === 'offered')) bits.push('offer settled by link');
  else if (s.offer === 'offered' || (!s.offer && s.origin_ref && offerIsPending(s, settledDestIds(st)))) bits.push('offer pending');
  else if (s.offer) bits.push('offer ' + s.offer);
  if (asOrigin.length) {
    const last = asOrigin[asOrigin.length - 1];
    const dest = st.sessions[last.dest];
    bits.push(`out:${last.status}${dest ? '→' + dest.surface : ''}`);
  }
  if (asDest.length) {
    const last = asDest[asDest.length - 1];
    bits.push(`in:${last.status}`);
  }
  if (!bits.length) bits.push('no link');
  return bits.join(' · ');
}
/**
 * Human ambiguity card. Prefer letter / recency / recap — session_id only as a
 * machine field after the user picks (never lead with UUID).
 */
function formatSessionCandidates(sessions, st) {
  const sorted = [...sessions].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const newestId = sorted.length ? sorted[sorted.length - 1].id : null;
  return sorted.map((s, i) => {
    const letter = letters[i] || String(i + 1);
    const createdMs = s.created_at ? Date.parse(s.created_at) : NaN;
    const when = Number.isFinite(createdMs)
      ? `${age(createdMs)} · ${String(s.created_at).slice(0, 16).replace('T', ' ')}`
      : (s.created_at || '?');
    const tip = s.id === newestId ? ' ← latest' : '';
    return (
      `${letter}${tip} — [${s.surface}] "${s.title}" · ${when}\n` +
      `   State: ${sessionLinkNote(s, st)} · Carrier: ${sessionCarrierNote(s)}\n` +
      `   Recap: ${sessionRecap(s)}\n` +
      `   (after you choose: session_id: ${s.id} · or pick:"latest" for newest)`
    );
  }).join('\n');
}

module.exports = {
  namedOrPinned, callTool, MIGRATED,
  isTargetable,   // exported for the retirement suite: the one chokepoint every by-name path uses
  deliveryNoteFor,
  targetNames, matchesName, matchesNameExact, filterByName,
  age, clipText, settledDestIds, offerIsPending, offerStateOf, resolveLiveNativeId, setTerminalTitle,
  sessionRecap, sessionCarrierNote, sessionLinkNote, formatSessionCandidates,
  localCodeSessions, readNativeRegistration, identitySession, assertReturnArtifacts,
  buildStatusReport, attentionBanner,
  lastCheckIndex, freshMessages, unreadCount, unreadReturnCount,
  assertArtifactsForAppSurface, assertReturnContract, assertCodeProjectTarget, queueArtifactOverflow,
};
