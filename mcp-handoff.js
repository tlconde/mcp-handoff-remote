#!/usr/bin/env node
/**
 * MCP bridge — reference implementation of the handoff protocol (stdio JSON-RPC 2.0).
 * Zero dependencies. Protocol runs IN this process via handoff-core (shared file store
 * at ~/.claude-handoff/). No backend; server.js is pitch-UI only.
 *
 * Install:  node bin/install.js
 * Or:       claude mcp add --scope user handoff -- node /path/to/mcp-handoff.js
 *
 * Daily entry point: status (slash /status) — bridge health, pending handoffs, inbox, next action.
 */
'use strict';
/* Serverless: the protocol runs IN this process via handoff-core (shared file store
 * at ~/.claude-handoff/). No backend, no HTTP, nothing to start. server.js exists
 * only to display the pitch mockup and is never required for the product. */
/* HOT-RELOAD (t11): bridges are per-Claude-Code-session child processes — an app
 * restart does NOT recycle them, and four stale bridges were found live serving
 * pre-t10 code. Core does load() from the shared file store on every operation, so
 * it keeps no in-memory state a reload could lose: re-require it whenever its mtime
 * changes and every live bridge picks up core fixes instantly. Only changes to
 * mcp-handoff.js itself still need a process restart (see staleWarning). */
const CORE_PATH = require.resolve('./handoff-core');
let core = require('./handoff-core');
let CORE_MTIME = (() => { try { return require('fs').statSync(CORE_PATH).mtimeMs; } catch (_) { return 0; } })();
function refreshCore() {
  try {
    const m = require('fs').statSync(CORE_PATH).mtimeMs;
    if (m !== CORE_MTIME) {
      delete require.cache[CORE_PATH];
      core = require('./handoff-core');
      const prev = CORE_MTIME; CORE_MTIME = m;
      core.ops('core_hot_reload', { from_mtime: prev, to_mtime: m });
    }
  } catch (_) { /* stat/require failed — keep serving the loaded build */ }
}

/* Consistent triggers: self-install user-level slash commands (~/.claude/commands —
 * global across all Claude Code projects). Idempotent; marker-guarded so a user's own
 * command with the same name is NEVER overwritten. */
(function installSlashCommands() {
  try {
    const os = require('os'), fs = require('fs'), path = require('path');
    const dir = process.env.CLAUDE_COMMANDS_DIR || path.join(os.homedir(), '.claude', 'commands');
    fs.mkdirSync(dir, { recursive: true });
    const MARK = '<!-- handoff-protocol command v1 -->';
    // Skills are a SEPARATE namespace that also answers /<name>, and it wins over a
    // command of the same name. Trial t9b: commands/handoff.md was ours (marker intact)
    // so the collision branch never fired, yet skills/handoff/SKILL.md still shadowed
    // /handoff — the verb stayed unreachable and no alt was ever installed. Check both.
    const skillsDir = process.env.CLAUDE_SKILLS_DIR || path.join(os.homedir(), '.claude', 'skills');
    const shadowedBySkill = base => {
      try { return fs.existsSync(path.join(skillsDir, base, 'SKILL.md')); } catch (_) { return false; }
    };
    const cmds = {
      'handoff.md':
        `---\ndescription: Hand this session to another Claude surface (or device instance) with the full carrier — summary, decisions, open items, project_state/run_breakers, return contract\n---\n${MARK}\n` +
        `Call send_to (not send_to_surface). Target surface from $ARGUMENTS (default chat). Named existing conversation → pass target_title; otherwise omit for NEW. Full carrier without asking. Include project_state.run_breakers when the other instance would fail without knowing (e.g. .env changed — names only, never secret values). expected_return when the origin wants something back. Relay the tool response verbatim (NEW vs EXISTING, return link vs standalone).\n`,
      'send-to.md':
        `---\ndescription: Send this work to another Claude surface — new linked handoff or full envelope into an existing titled conversation\n---\n${MARK}\n` +
        `Call send_to. Parse surface from $ARGUMENTS. If a conversation is named, pass target_title (session_id after disambiguation). Never invent a NEW chat when a named target misses — relay the refusal. expected_return opens a return link; omit for standalone. Do NOT use send_to to resume terminals (/resume-session). Relay the result verbatim.\n`,
      'pick-up.md':
        `---\ndescription: Pick up the one waiting handoff for this surface\n---\n${MARK}\n` +
        `Call pick_up for the current surface. If several are waiting, show the candidates and ask which title to pick; never guess.\n`,
      'btw.md':
        `---\ndescription: Fire a side task to a NEW Chat conversation; the result comes back here (check with /workers)\n---\n${MARK}\n` +
        `Call send_to with to:"chat", mode:"new", autosend:true, title "btw: <short name>", context/task from: $ARGUMENTS, and expected_return stating exactly what should come back and in what form. Then continue the main work — do not wait.\n`,
      'workers.md':
        `---\ndescription: What are my dispatched tasks/workers doing? Pull any finished results\n---\n${MARK}\n` +
        `Call list_workers. For a resolved entry whose summary the user hasn't seen, call get_worker_result with that worker_id. If exactly one worker is in flight, worker_id may be omitted; if several are in flight, pass worker_id — do not guess the last one. Present results compactly. State plainly which are still working.\n`,
      'inbox.md':
        `---\ndescription: Check queued cross-surface messages addressed to this surface\n---\n${MARK}\n` +
        `Call check_inbox with the surface you are on (code in a terminal). Deliver the unread mail. Then do what it asks: an executable assignment (a handoff envelope, work to commit, EXECUTE NOW) is the current work. Start it. Do not wait for the human to re-authorize a job they already sent. A status or chat ping is presented, not executed. "check inbox" is how queued work arrives; it is not a read-only scope.\n`,
      'pull.md':
        `---\ndescription: Pull an app conversation's work INTO this Claude Code session\n---\n${MARK}\n` +
        `Call continue_from. Parse $ARGUMENTS as a surface (chat/cowork/design) and/or title fragment (use title_contains). ROUTING: if the user means a LOCAL terminal session, use /resume-session instead; to continue in the app itself, open_conversation. Unclear → ask one short question first. Always state which session was pulled.\n`,
      'resume-session.md':
        `---\ndescription: Reopen a local Claude Code terminal session by title/folder/recency (no UUIDs needed)\n---\n${MARK}\n` +
        `Call resume_code_session with title_contains/folder_contains parsed from: $ARGUMENTS (pick:"latest" when they say latest/last). If several match, show the list and ask. NOT for app conversations — that's /pull (bring work here) or open_conversation (go there).\n`,
      'name.md':
        `---\ndescription: Name THIS terminal in one word, so you can send to it by name later\n---\n${MARK}\n` +
        /* This template OVERWRITES ~/.claude/commands/name.md at every bridge start, so a
         * correction made to the .md alone is reverted on the next boot — the copy that has to
         * be true is this one. It used to promise the terminal tab, which Claude Code owns and
         * re-asserts (anthropics/claude-code#56933), and the installed .md said elsewhere that
         * it sets the NATIVE display name, which register_session cannot do: it only reads
         * native's registry and adopts the name. Both promises are gone. */
        `The user said "You will be $ARGUMENTS" or /name. Chat/cowork/design: register_chat_session (surface, title, nickname, subscription, model_slug). A machine: register_code_session (title, device=os.hostname(), session_uuid, subscription, model_slug). Do not invent product fields. Do not call register_session. PROTOCOL title only — not the native tab. Then whoami with session_uuid set to the session_id register returned. Empty → whoami only.\n`,
      'whoami.md':
        `---\ndescription: Which session is this, and what is it called?\n---\n${MARK}\n` +
        `Call whoami. Over the relay, pass session_uuid or session_id: the sess_… value register_chat_session returned. A no-arg whoami after a successful register is unidentified — that is the relay, not a failed enrol; do not register again. Relay the single line verbatim. If it says the terminal has no name yet, offer: /name <one word>. If it says INCOMPLETE, re-register with the named fields; do not invent them.\n`,
      'status.md':
        `---\ndescription: Is handoff healthy? Pending offers, unread inbox, workers, and what to do next\n---\n${MARK}\n` +
        `Call the handoff MCP tool status. Present the report compactly. If it says STALE BRIDGE or BLOCKED, tell the user to restart this Claude session / the Claude app before any handoff. If Next action is non-empty, offer to do that action.\n`
    };
    for (const [f, c] of Object.entries(cmds)) {
      const fp = path.join(dir, f);
      const owned = fs.existsSync(fp) && !fs.readFileSync(fp, 'utf8').includes(MARK);
      if (owned || shadowedBySkill(f.replace(/\.md$/, ''))) {
        // Collision with a user-owned command, or a same-named skill that outranks our
        // command: NEVER overwrite, but don't vanish either (t8: /handoff silently
        // shadowed). Install under a plain-English alt so the verb stays reachable.
        const base = f.replace(/\.md$/, '');
        const altName = base === 'handoff' ? 'handoff-send' : 'handoff-' + base; // plain English, no decoder ring
        const alt = path.join(dir, altName + '.md');
        const why = owned ? `/${base} is user-owned` : `a user skill named "${base}" shadows /${base}`;
        if (!fs.existsSync(alt) || fs.readFileSync(alt, 'utf8').includes(MARK)) {
          fs.writeFileSync(alt, c.replace(MARK, MARK + `\n<!-- installed as /${altName} because ${why} -->`));
        }
        continue;
      }
      fs.writeFileSync(fp, c);
    }
  } catch (_) { /* best effort — tools still work by natural language */ }
})();

async function api(method, apiPath, bodyObj) {
  refreshCore();
  const q = {};
  const [p, qs] = apiPath.split('?');
  if (qs) for (const kv of qs.split('&')) { const [k, v] = kv.split('='); q[k] = decodeURIComponent(v || ''); }
  const r = await core.handleApi(method, p, q, bodyObj || {});
  if (r.code >= 400) throw new Error((r.payload && r.payload.error) || ('HTTP ' + r.code));
  return r.payload;
}
/* Session identity is pinned for the life of this process.
 * `by_surface.code` means "latest non-archived code session" — it moves every time the
 * user hits Continue in → Claude Code again. Re-resolving per tool call meant get_handoff
 * and report_progress could target different sessions within one working session
 * (found live by Claude Code in trial t2). Bind once on first use; HANDOFF_SESSION_ID
 * overrides — and the auto-launch endpoint sets it so spawned sessions are always pinned
 * to the handoff they were launched for. */
let PINNED = process.env.HANDOFF_SESSION_ID || null;

/* Identity vs transaction (t24 addendum, I2). PINNED is the TRANSACTION this bridge is
 * working — set by pick_up / continue_from / the launch env var above. IDENTITY is this
 * terminal session's OWN protocol record, minted on first protocol contact from the CLI
 * uuid Claude Code exports as CLAUDE_CODE_SESSION_ID. They are deliberately separate:
 * conflating them is how real sends went out stamped with a borrowed record id and
 * their delivery receipts aimed at a record no one was reading (C28/C29). */
/* NOT a constant, deliberately. This used to be
 *     const NATIVE_ID = process.env.CLAUDE_CODE_SESSION_ID || null;
 * captured once at bridge-process start. A bridge outlives a /clear + resume, and resume
 * FORKS a new session id (probed live: the uuid changes with no lineage pointer), so the
 * frozen value went on naming a transcript that no longer existed. Everything downstream —
 * identity, receipts, and the wake tier's open/closed answer — inherited that dead pointer,
 * which is why an OPEN terminal reported CLOSED. Same disease as the ENOENT reply socket and
 * the orphaned bridges, third variant: not persisted to disk, frozen in memory.
 * ENV_NATIVE_ID is kept only as the fallback input to the resolver, never used directly. */
const ENV_NATIVE_ID = process.env.CLAUDE_CODE_SESSION_ID || null;
const CLI_PID = Number(process.env.CLAUDE_PID) || process.ppid || null;
let LAST_HEAL = null; // last {from,to} announced, so the notice fires on CHANGE, not every call
/** This session's CURRENT native id, resolved at the moment of use. */
function nativeId() {
  const r = require('./handoff-tools').resolveLiveNativeId({ env_id: ENV_NATIVE_ID, pid: CLI_PID });
  if (r.healed && (!LAST_HEAL || LAST_HEAL.to !== r.id)) {
    LAST_HEAL = { from: r.stale_id, to: r.id };
    // Loud, per the stale-bridge doctrine: a pointer that moved is reported, never swallowed.
    try { process.stderr.write(`[handoff] identity pointer stale — healed ${r.stale_id} → ${r.id} (pid ${r.pid})\n`); } catch (_) {}
  }
  return r.id;
}
let IDENTITY = null;
/* Refactor (identity convergence, 2026-08-08): read native's OWN registration for this
 * session instead of minting a parallel identity. Native writes ~/.claude/sessions/<pid>.json
 * with sessionId === CLAUDE_CODE_SESSION_ID; that file carries the display name, cwd and the
 * messaging socket. We adopt those (native sessionId == our native_ref, native name == the
 * one display handle — name unification). Read-only; a missing registry is non-fatal.
 * Moved to handoff-tools.js in 3b-7 (ctx-threaded), because send_message needs it there.
 * What stays HERE is the caching wrapper: IDENTITY is this forwarder's OWN resolved record
 * id, and caching it is legitimate per-session state — the same category as PINNED. The
 * lookup itself is shared, so bridge and daemon adopt native's registration identically. */
async function identitySession(extra) {
  if (!nativeId()) return null;
  refreshCore();
  const r = await require('./handoff-tools')
    .identitySession({ cli_uuid: nativeId(), cwd: process.cwd(), cli_pid: CLI_PID }, core, extra);
  if (r) IDENTITY = r.id;
  return r;
}

/* Stale-bridge self-diagnostic: MCP servers load once per app/session start, so edits
 * land on disk while an old process keeps serving — which silently produced wrong
 * behavior twice (t9: design routed to chat by a pre-fix bridge; caught only because
 * the Code agent cross-checked). handoff-core.js hot-reloads (refreshCore above), so
 * since t11 this warns ONLY when mcp-handoff.js itself changed — that genuinely needs
 * a process restart — and names the file so the reader knows what's stale. */
const START_MS = Date.now();
function isBridgeStale() {
  if (process.env.HANDOFF_FORCE_STALE === '1') return true; // test / doctor probe only
  try {
    const fs = require('fs');
    return fs.statSync(__filename).mtimeMs > START_MS + 2000;
  } catch (_) {
    return false;
  }
}
function staleWarning() {
  if (!isBridgeStale()) return '';
  // AFTER THE FLIP the old remedy is wrong advice. A forwarder holds no logic and no store
  // access: the daemon (one process, launchd-managed) owns both, and it is unaffected by
  // this file being edited. Telling the user to quit the app and pkill every bridge is the
  // dance the flip exists to retire — and it would not even help, since the daemon is the
  // thing serving the protocol. A stale forwarder only means an out-of-date MCP schema and
  // forwarding path, which a plain restart of THIS session replaces.
  if (FORWARDER) {
    return '⚠ STALE FORWARDER: mcp-handoff.js on disk is newer than this forwarder process. ' +
      'Tool behaviour is unaffected — the daemon serves every tool and is not stale. Only this ' +
      'session\'s MCP schema/forwarding path may be out of date. Restart THIS session (or /mcp ' +
      'reconnect) when convenient; no app quit and no pkill, and the daemon keeps running.\n\n';
  }
  return '⚠ STALE BRIDGE: mcp-handoff.js on disk is newer than this running process (handoff-core.js hot-reloads, the bridge file itself cannot). ' +
    'An app restart alone is NOT enough — orphaned bridge processes survive it and get reused (observed 2026-08-08: a dying bridge left an existing conversation timing out for 4 minutes). ' +
    'Runbook: quit the Claude app → pkill -f mcp-handoff.js → verify none remain (pgrep -f mcp-handoff.js) → relaunch.\n\n';
}
/* Protocol-state mutations refuse to run on a stale bridge (A8). Read/status tools still
 * answer so the user can see health and next steps without making things worse. */
const MUTATING_TOOLS = new Set([
  'send_to_worker', 'send_to', 'send_to_surface', 'send_message', 'pick_up', 'withdraw_handoff',
  'decline_handoff', 'get_worker_result', 'continue_from', 'return_to_origin', 'report_progress',
  'register_session'
]);
function staleBlockMessage(toolName) {
  return (
    `BLOCKED: "${toolName}" cannot run on a STALE BRIDGE — the on-disk mcp-handoff.js is newer than this process.\n` +
    `What to do (an app restart alone is NOT enough — orphaned bridges survive it and get reused): quit the Claude app, pkill -f mcp-handoff.js, verify none remain (pgrep -f mcp-handoff.js), then relaunch and call status.\n` +
    `Read-only tools (status, list_conversations, list_workers, check_inbox, get_handoff, get_decisions) still work.`
  );
}
/* Display-helper chain — MIGRATED to handoff-tools.js (slice 3b-4). settledDestIds,
 * offerIsPending, age, clipText, sessionRecap/CarrierNote/LinkNote and
 * formatSessionCandidates are pure (session, state) renderers, so one copy serves both the
 * in-process bridge and the daemon. Bound here so the ~30 existing call sites below read
 * unchanged; the heavy tools that use them migrate next with their rendering already shared. */
const {
  age, clipText, settledDestIds, offerIsPending,
  sessionRecap, sessionCarrierNote, sessionLinkNote, formatSessionCandidates,
  localCodeSessions, // moved in 3b-5 with continue_from, its first migrated caller
} = require('./handoff-tools');
/* Unread-counting chain — MIGRATED to handoff-tools.js (3b-9) with buildStatusReport, its
 * main caller. Pure (session)->number, no ctx. Bound here so check_inbox and the other
 * bridge-side callers read unchanged. */
const { lastCheckIndex, freshMessages, unreadCount, unreadReturnCount } = require('./handoff-tools');
/* buildStatusReport + attentionBanner moved to handoff-tools.js (3b-9). This wrapper keeps
 * the two remaining bridge-side callers (check_inbox, list_workers) reading unchanged. */
async function attentionBanner() {
  refreshCore();
  return require('./handoff-tools').attentionBanner({ cli_uuid: nativeId(), pinned: PINNED }, core);
}

// namedOrPinned / codeSession moved to handoff-tools.js (ctx-threaded) in slice 3b — the
// bridge's get_handoff/get_decisions/report_progress now delegate there, so the in-process
// copies are gone. Any tool still bridge-side that needs pin resolution uses the shared one.

const { TOOLS } = require('./handoff-tool-schemas'); // extracted for t27's relay — one list, both callers


/* ---------------- Forwarder dial (the flip) ---------------- */
// Gated behind HANDOFF_FORWARDER=1 so committing this does NOT change the live path: the
// flip is set-the-flag + the runbook relaunch. When on, a tool call is ONE tools/call to the
// managed daemon over daemon.sock instead of an in-process run — same ctx in, same
// { text, ctx_update } out, so no tool changes. On contract_mismatch / daemon_stale the
// forwarder EXITS so Claude Code respawns a matching one; that respawn + the daemon's
// exit-on-stale is the stale-bridge dance, retired.
const FORWARDER = process.env.HANDOFF_FORWARDER === '1';
function daemonSockPath() {
  const path = require('path'), os = require('os');
  return process.env.HANDOFF_DAEMON_SOCK ||
    require('path').join(process.env.HANDOFF_HOME || path.join(os.homedir(), '.claude-handoff'), 'daemon.sock');
}
function forwardToDaemon(name, args, ctx) {
  const net = require('net');
  const { CONTRACT } = require('./handoff-contract');
  return new Promise((resolve, reject) => {
    const sock = daemonSockPath();
    const c = net.connect(sock, () => c.write(JSON.stringify({
      contract: CONTRACT, id: 1, tool: name, args: args || {}, ctx,
      // cli_pid is the DISCRIMINATOR: two live processes can share one session id, and the
      // pid is what tells the daemon which of them is calling. Without it the door guesses.
      identity: { cli_uuid: nativeId(), cli_pid: CLI_PID, cwd: process.cwd() }
    }) + '\n'));
    // The deadline must be CLEARED on every exit path. An uncleared timer is a live handle,
    // so the forwarder's event loop stays alive for the full 8s after it has already
    // answered — the process cannot exit promptly when Claude Code closes stdin. Found in
    // the runbook: a dead-socket call replied in 31ms but the process lingered 8034ms.
    let deadline;
    const settle = fn => (...a) => { clearTimeout(deadline); return fn(...a); };
    const done = settle(resolve), failed = settle(reject);
    let buf = '';
    c.on('data', d => {
      buf += d; const nl = buf.indexOf('\n'); if (nl < 0) return;
      c.end();
      let resp; try { resp = JSON.parse(buf.slice(0, nl)); } catch (e) { return failed(e); }
      if (resp.fatal) { // contract_mismatch / daemon_stale → exit so the client respawns us
        clearTimeout(deadline);
        try { core.ops('forwarder_respawn', { reason: resp.error }); } catch (_) {}
        process.stderr.write(`[handoff forwarder] ${resp.error} — exiting for respawn\n`);
        return process.exit(0);
      }
      if (resp.error) return failed(new Error(resp.error));
      done(resp.ctx_update ? { text: resp.result, ctx_update: resp.ctx_update } : resp.result);
    });
    c.on('error', e => failed(new Error(`daemon unreachable at ${sock}: ${e.message}`)));
    deadline = setTimeout(() => { try { c.destroy(); } catch (_) {} failed(new Error('daemon timeout')); }, 8000);
  });
}
/* PEER MODE — one fleet, one store.
 *
 * THE DEFECT THIS EXISTS TO KILL, observed on a real second machine 2026-08-10: the plugin's MCP
 * server came up on a laptop with no daemon, ran the tools in-process against handoff-core, and
 * MINTED A FRESH LOCAL STORE. Every verb then worked perfectly against a two-record universe —
 * `list_conversations` showed none of the fleet's conversations, and a send by name correctly
 * resolved nothing. The right answer in the wrong world. A phantom store is worse than an error
 * precisely because it ANSWERS: nothing is broken enough to notice.
 *
 * The seam already existed. bin/handoff-store-client.js was written for the wake agent, which has
 * always known local from remote; the MCP server simply never asked. So peer support here is one
 * question at the top of the call path, not a second artifact — the store-host/peer split becomes
 * configuration, exactly as the review seat ruled.
 *
 * FAIL CLOSED, ALWAYS. If a remote is configured and cannot be reached, this REFUSES and says why.
 * It must never degrade to the local path, because that degradation is the bug: the operator would
 * get a working-looking session pointed at a universe nobody else can see. An error is recoverable;
 * a phantom is not, because nobody goes looking for a store that answers.
 *
 * Detection is the presence of HANDOFF_REMOTE_URL — the same switch the agent uses, so a machine
 * configured as a peer is a peer for every process on it rather than per-binary. */
/* CONFIGURATION HAS TO REACH THIS PROCESS, and until now it could not.
 *
 * The peer-aware branch below reads HANDOFF_REMOTE_URL and HANDOFF_REMOTE_TOKEN from the
 * environment. But an MCP server is SPAWNED BY CLAUDE CODE and inherits Claude Code's environment
 * — so .agent-env, which the wake agent reads at its own startup, never reached here. Measured on
 * the peer: the fixed mount would have refused on that machine permanently, correctly and
 * uselessly, unless the operator exported the token into the shell before launching Claude Code,
 * by hand, every session. A fix that is right and undeliverable is the same shape as a capability
 * that ships without its instructions — the third instance of that pattern in two days.
 *
 * So the mount loads the same file the agent does, by the same loader, BEFORE deciding what it is.
 * Requiring the store client has that as a load-time side effect: .agent-env populates process.env
 * and a real environment variable always wins over the file. One file configures both consumers. */
/* Explicitly, not as a require's side effect — same reason as the wake agent's first line: the
 * value read on the NEXT line comes from this file, and a dependency that only works because of
 * statement order is one edit away from silently not working. */
try { require('./bin/handoff-store-client').loadLocalEnv(); } catch (_) { /* absent in a runtime-only tree — local mode */ }
const PEER_URL = process.env.HANDOFF_REMOTE_URL || null;

/* ABSENCE OF CONFIGURATION IS NEVER A ROLE.
 *
 * The peer-aware refusal below was gated on HANDOFF_REMOTE_URL being SET, so it only ever
 * protected a machine that had already been told what it was. A peer whose .agent-env was not
 * found — and the loader looks in cwd first, then the PACKAGE root, which for a plugin resolves
 * inside the plugin cache rather than the repo — populated no variables, failed this test, and
 * fell through to the local path, where it MINTED A STORE. Silence meant "home machine", so the
 * one case that most needed a refusal got a phantom instead: a session that answers every
 * question correctly about a universe no other machine can see. That is the artefact already
 * autopsied at 8 records, 6 of them minted by the probes investigating it.
 *
 * Two seats reasoned about this path and agreed it failed closed. Neither had read to the line
 * that gates it. So the rule is no longer "a peer must declare itself" but the symmetric one:
 * EVERY role is declared, and silence is UNKNOWN. Unknown never mints.
 *
 *   client — HANDOFF_REMOTE_URL is set (this machine uses a remote store)
 *   host   — HANDOFF_ROLE=host, OR a store already exists here (see below)
 *   else   — REFUSE, and create nothing
 * HANDOFF_ROLE=peer is the coding-agent word. It is refused and names client.
 *
 * THE GRANDFATHER CLAUSE IS EVIDENCE, NOT INFERENCE. An existing store/v1 is a durable artefact
 * a human deliberately created; reading it as "this machine is the host" is not the same move as
 * reading SILENCE that way. It also keeps every existing install working with zero declarations,
 * which the ruling required — a store host that stops serving because a rule improved would be
 * its own defect class. A fresh machine has no store, so it cannot grandfather itself into
 * minting one, which is exactly the class being removed.
 *
 * HANDOFF_ROLE=host is the INTERIM mechanism. The ratified role-choice design makes host
 * designation an EVENT in the store, and this defect is that design's absence felt early; when
 * the enrollment ceremony ships, the event supersedes the env var and this comment should say so
 * rather than leaving two answers to one question. */
function declaredRole() {
  if (PEER_URL) return 'client';
  const explicit = String(process.env.HANDOFF_ROLE || '').trim().toLowerCase();
  if (explicit === 'host') return 'host';
  if (explicit === 'peer') return 'legacy-peer';
  if (explicit === 'client') return 'client-undeliverable';
  try {
    const os = require('os'), fs = require('fs'), path = require('path');
    const home = process.env.HANDOFF_HOME || path.join(os.homedir(), '.claude-handoff');
    if (fs.existsSync(path.join(home, 'store', 'v1'))) return 'host';
  } catch (_) { /* unreadable is not a declaration */ }
  return 'undeclared';
}
const ROLE = declaredRole();
function undeclaredRefusal() {
  return `REFUSED — this machine has not declared what it is, so nothing was read and NOTHING WAS CREATED.\n\n` +
    `There is no store here and no remote configured, and the one thing this must never do is ` +
    `assume. Minting a local store on a guess produces a session that answers every question ` +
    `correctly about a universe no other machine can see — which is far harder to notice than ` +
    `this message, and has already cost one investigation.\n\n` +
    `Declare the role:\n` +
    `  • THIS MACHINE IS A CLIENT (any device or surface that uses a remote store):\n` +
    `      set HANDOFF_REMOTE_URL (and a credential) in .agent-env beside the clone\n` +
    `  • THIS MACHINE HOSTS THE STORE (exactly one machine may):\n` +
    `      set HANDOFF_ROLE=host\n\n` +
    `An existing store counts as a declaration on its own, so a machine that was already the ` +
    `host keeps working untouched. If you are seeing this on a machine that HAS a store, then ` +
    `HANDOFF_HOME is not pointing at it.`;
}
function undeliverableClientRefusal() {
  return `REFUSED — HANDOFF_ROLE=client is declared but HANDOFF_REMOTE_URL is not set, so there is ` +
    `nowhere to reach the home store. Nothing was read and NO local store was created.\n\n` +
    `A declared client with no address is a configuration that is half-arrived, and the failure it ` +
    `would otherwise produce — falling back to a local store — is the exact one this refusal exists ` +
    `to prevent. Set HANDOFF_REMOTE_URL in .agent-env beside the clone.`;
}
function legacyPeerRoleRefusal() {
  return `REFUSED — HANDOFF_ROLE=peer is the coding-agent word (Claude ListAgents / SendMessage). ` +
    `This env names a machine that uses a remote store. That machine is a client.\n\n` +
    `Set HANDOFF_ROLE=client and HANDOFF_REMOTE_URL. peer is not accepted as an alias.`;
}
function peerRefusal(reason) {
  return `REFUSED — this machine is configured as a REMOTE CLIENT (HANDOFF_REMOTE_URL is set) and the ` +
    `home store could not be reached: ${reason}\n\n` +
    `Nothing was written and NO local store was created. That refusal is deliberate: minting a local ` +
    `store here would give you a session that answers every question correctly about a universe no ` +
    `other machine can see — which is harder to notice than this message.\n\n` +
    `Fix the credential or the connection and try again:\n` +
    `  • this machine must hold a valid relay credential — either an Access service token\n` +
    `    (HANDOFF_ACCESS_CLIENT_ID + HANDOFF_ACCESS_CLIENT_SECRET, which does not expire) or\n` +
    `    HANDOFF_REMOTE_TOKEN (browser-issued, ~24h). See REMOTE-PEER-SETUP.md\n` +
    `  • the relay must be reachable at ${PEER_URL}\n` +
    `  • verify with: claude mcp list  (the remote connector should read Connected)`;
}
async function callToolViaRelay(name, args) {
  /* ONE CREDENTIAL RESOLVER, BOTH CONSUMERS. This path used to read HANDOFF_REMOTE_TOKEN itself,
   * which meant a peer could be given an unattended service token and the MCP mount would still
   * refuse for want of a browser cookie — the wake agent working while the mount does not, on the
   * same machine, from the same .agent-env. That is the "right and undeliverable" shape again, so
   * the mount asks the store client which credential this machine holds rather than deciding
   * separately. */
  /* THE PEER CARRIES ITS OWN IDENTITY ACROSS, because it is the only process that can read it.
   *
   * This forwarded every tool to the relay and sent nothing about itself. So a peer running a real
   * local mount — which is what a WSL or Linux seat has — still could not register: the store host
   * answered `whoami` with "unidentified (no CLI uuid in this environment)", which was TRUE of the
   * machine executing the verb and false about the machine asking. Every WSL seat tested today was
   * stuck there, unable to name itself or hold a verified record, and that is the identity half of
   * the enrollment ceremony failing for one missing field.
   *
   * The mount reads CLAUDE_CODE_SESSION_ID from its OWN process, where it is genuinely present, and
   * sends it as a claim. The store must treat that as ASSERTED-BY-PEER-MOUNT and never as
   * CLI-verified: this side verified it, the store did not, and I2 exists to keep those apart. What
   * it buys is real — a peer can finally be a named seat instead of an anonymous caller — without
   * pretending the store watched it happen. */
  const peerIdentity = {
    cli_uuid: nativeId() || null,
    cli_pid: CLI_PID || null,
    cwd: process.cwd(),
    host: require('./bin/platform-profile').CURRENT.hostId,
  };
  args = Object.assign({}, args || {}, peerIdentity.cli_uuid ? { _peer_identity: peerIdentity } : {});
  const { rpc, resolveCredential } = require('./bin/handoff-store-client');
  const credential = resolveCredential();
  if (!credential) return peerRefusal('no relay credential is set (neither an Access service token nor HANDOFF_REMOTE_TOKEN), so there is nothing to present.');
  if (credential.kind === 'incomplete') return peerRefusal(credential.problem);
  try {
    return await rpc(PEER_URL, credential, name, args || {}, 15000);
  } catch (e) {
    return peerRefusal((e && e.message) || String(e));
  }
}

async function callTool(name, args) {
  /* Asked FIRST, before the forwarder and before any in-process path, because both of those end at
   * a local store. On a peer there is no correct local answer to fall back to — and on a machine
   * that has declared nothing, there is no correct answer at all. Both refusals come before any
   * code that could create a directory, so an undeclared machine leaves no trace of having run. */
  if (ROLE === 'undeclared') return undeclaredRefusal();
  if (ROLE === 'legacy-peer') return legacyPeerRoleRefusal();
  if (ROLE === 'client-undeliverable') return undeliverableClientRefusal();
  if (PEER_URL) return callToolViaRelay(name, args);
  // THE FLIP: forward every tool to the managed daemon (one socket round-trip), then apply
  // the same write-back. The daemon owns TOOL staleness (exit-on-stale), so the bridge-side
  // stale GATE below is skipped — a forwarder holds no tool logic to be stale.
  //
  // But `stale` must still travel in ctx. It is not about tool logic; it is the answer to
  // "is the process serving this caller running older code than the disk?", and a forwarder
  // still owns the MCP schema and the forwarding path. Omitting it made status contradict
  // itself live: the report rendered "Bridge: ✓ current" from an undefined ctx.stale while
  // handle() prepended a locally-computed "⚠ STALE BRIDGE" banner to the same response.
  if (FORWARDER) {
    const ctx = {
      cli_uuid: nativeId(), cli_pid: CLI_PID, pinned: PINNED, cwd: process.cwd(), identity: IDENTITY,
      stale: isBridgeStale(),
    };
    const out = await forwardToDaemon(name, args, ctx);
    if (out && typeof out === 'object' && 'text' in out) {
      if (out.ctx_update && 'pinned' in out.ctx_update) PINNED = out.ctx_update.pinned;
      if (out.ctx_update && 'identity' in out.ctx_update) IDENTITY = out.ctx_update.identity;
      return out.text;
    }
    return out;
  }
  // status is exempt from the stale gate on purpose: it is the tool that REPORTS staleness,
  // so it must answer on a stale bridge (read-only tools stay available; see MUTATING_TOOLS).
  if (name !== 'status' && isBridgeStale() && MUTATING_TOOLS.has(name)) {
    core.ops('stale_blocked', { tool: name });
    return staleBlockMessage(name);
  }
  // EVERY tool is now served by the shared layer. This block is the whole bridge-side tool
  // surface: build the per-session ctx from state only THIS process has, call, apply the
  // write-back. The daemon's tools/call does the identical thing with a forwarded ctx —
  // which is what makes the forwarder cutover a swap of how ctx and the reply travel
  // (in-process call vs one socket round-trip), not a rewrite of any tool.
  refreshCore(); // keep the bridge's hot-reload semantics on the delegated path too
  const ctx = {
    cli_uuid: nativeId(), cli_pid: CLI_PID, pinned: PINNED, cwd: process.cwd(),
    identity: IDENTITY, stale: isBridgeStale(),
  };
  const out = await require('./handoff-tools').callTool(name, args, ctx, core);
  // Write-back (contract v3): a tool that changes the caller's per-session state returns
  // { text, ctx_update }. The tool layer is the sole writer of both keys; this process
  // applies them to its OWN state. `pinned` is symmetric (an id sets, null clears);
  // `identity` only ever sets. Each key is applied only if present — a plain-string return,
  // or an update naming just one key, changes nothing else.
  if (out && typeof out === 'object' && 'text' in out) {
    if (out.ctx_update && 'pinned' in out.ctx_update) PINNED = out.ctx_update.pinned;
    if (out.ctx_update && 'identity' in out.ctx_update) IDENTITY = out.ctx_update.identity;
    return out.text;
  }
  return out;
}

/* ---------------- MCP stdio (JSON-RPC 2.0) ---------------- */
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
let buf = '';
let chain = Promise.resolve(); // serialize: tool calls mutate PINNED — order matters
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (line) chain = chain.then(() => handle(line)).catch(() => {});
  }
});
async function handle(line) {
  let req; try { req = JSON.parse(line); } catch (_) { return; }
  const { id, method, params } = req;
  const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
  try {
    if (method === 'initialize') {
      return reply({
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'handoff-bridge', version: '1.0.0' },
        /* MCP's one server-level channel into the system prompt. One sentence on purpose: it is
         * read once, far from the moment of action, so it sets a default rather than carrying the
         * load. The verb-level imperative rides the check_inbox RESULT, which arrives mid-turn
         * where the decision is actually made and does not depend on the host honouring this. */
        instructions: 'Mail delivered by check_inbox is addressed to this session, not to the user: do what it asks and reply to the sender, rather than printing it back and waiting.'
      });
    }
    if (method === 'notifications/initialized' || (method && method.startsWith('notifications/'))) return;
    if (method === 'tools/list') return reply({ tools: TOOLS });
    if (method === 'tools/call') {
      try {
        const text = await callTool(params.name, params.arguments || {});
        return reply({ content: [{ type: 'text', text: staleWarning() + text }], isError: false });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true });
      }
    }
    if (method === 'ping') return reply({});
    fail(-32601, 'method not found: ' + method);
  } catch (e) { fail(-32603, e.message); }
}

/* Exported for tests only — the MCP loop above calls these directly. Exposing them lets the peer
 * mode's REFUSAL be asserted as a value rather than inferred from a missing side effect: "no store
 * was minted" proves the local path was skipped, but only reading the message proves the caller was
 * told why. */
module.exports = { callTool, PEER_URL };
