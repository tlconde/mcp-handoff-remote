#!/usr/bin/env node
/**
 * MCP smoke test — exercises the bridge over real stdio JSON-RPC, serverless.
 * Usage: HANDOFF_HOME=/tmp/hsmoke node mcp-smoke.js
 * Safe defaults: no CLI launch, no auto-receipts, no auto-open.
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

process.env.HANDOFF_HOME = process.env.HANDOFF_HOME || '/tmp/hsmoke-' + Date.now();
// Fixture: a fake local Claude Code store (same layout as ~/.claude/projects)
const cmdDir = process.env.CLAUDE_COMMANDS_DIR = '/tmp/hsmoke-cmds-' + Date.now();
const ccDir = process.env.CLAUDE_PROJECTS_DIR = '/tmp/hsmoke-ccproj-' + Date.now();
// Empty skills fixture: the real ~/.claude/skills must never decide test outcomes
// (t7 fixture-leak class — a real user skill named "handoff" flipped the install path).
fs.mkdirSync(process.env.CLAUDE_SKILLS_DIR = '/tmp/hsmoke-skills0-' + Date.now(), { recursive: true });
fs.mkdirSync(path.join(ccDir, '-Users-dev-Dev-proj'), { recursive: true });
fs.writeFileSync(path.join(ccDir, '-Users-dev-Dev-proj', '0f0e0d0c-0b0a-4999-8888-777766665555.jsonl'),
  JSON.stringify({ type: 'summary', summary: 'Read handoff document and report progress' }) + '\n');
// Identity isolation: the smoke runner itself often runs INSIDE a Claude Code session,
// whose CLAUDE_CODE_SESSION_ID would leak into every spawned bridge and silently give
// all tests an identity. Baseline is no-identity; identity tests set it explicitly.
delete process.env.CLAUDE_CODE_SESSION_ID;
// Same leak, second vector (2026-08-09): identity now RESOLVES from the native registry —
// pid → row → current sessionId — so that the frozen-uuid bug cannot come back. CLAUDE_PID
// and the real ~/.claude/sessions are inherited by every child too, and a test that injects a
// fake CLAUDE_CODE_SESSION_ID while still pointing at the runner's own live row describes a
// process that cannot exist. Cut both, so a faked identity is faked coherently.
delete process.env.CLAUDE_PID;
fs.mkdirSync(process.env.HANDOFF_NATIVE_SESSIONS_DIR = '/tmp/hsmoke-nativereg-' + Date.now(), { recursive: true });
process.env.HANDOFF_NO_CLI = '1';
process.env.HANDOFF_NO_AUTORECEIPT = '1';
process.env.HANDOFF_NO_AUTOOPEN = '1';
// Notification + wake layers: route to logs instead of firing real OS notifications or
// spawning a real `claude -p` relay during tests.
process.env.HANDOFF_NOTIFY_LOG = '/tmp/hsmoke-notify-' + Date.now() + '.log';
process.env.HANDOFF_WAKE_LOG = '/tmp/hsmoke-wake-' + Date.now() + '.log';

let passed = 0, failed = 0;
const ok = (c, n) => { c ? (passed++, console.log('  ✓', n)) : (failed++, console.log('  ✗ FAIL:', n)); };

function rpc(calls) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'mcp-handoff.js')], { env: process.env });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.on('close', () => {
      const byId = {};
      out.trim().split('\n').filter(Boolean).forEach(l => { try { const j = JSON.parse(l); byId[j.id] = j; } catch (_) {} });
      resolve(byId);
    });
    child.on('error', reject);
    child.stdin.write(calls.map(c => JSON.stringify(c)).join('\n') + '\n');
    child.stdin.end();
  });
}
const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args || {} } });
const init = { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} };
const text = (r, id) => (((r[id] || {}).result || {}).content || [{}])[0].text || '';

(async () => {
  console.log('MCP smoke test (store: ' + process.env.HANDOFF_HOME + ')');

  const r1 = await rpc([init,
    call(1, 'send_to_surface', {
      to: 'chat', from: 'cowork', title: 'Smoke: Arthur meeting prep',
      context: 'Deck package finished; earlier we chose to Lock the copy with the tagline. Need to draft the reply to Arthur about the meeting.',
      decisions: ['Decision: tagline reveal stays'],
      open_items: ['Draft reply to Arthur'],
      constraints: ['Style: warm, concise, no exclamation marks'],
      entities: ['Arthur — investor, meeting Thursday'],
      non_goals: ['Do not resend the original email'],
      expected_return: 'A drafted reply for review; send nothing yourself.',
      deadline: 'meeting Thursday 2pm',
      artifacts: [{ name: 'arthur-email.md', content: 'Subject: Deck\nHi Arthur — attaching the deck ahead of Thursday.' }]
    }),
    call(2, 'pick_up', { surface: 'chat' })
  ]);
  const t1 = text(r1, 1), t2 = text(r1, 2);
  ok(/NEW conversation, Claude app \(chat surface\)/.test(t1), 'send_to_surface hands off — labeled NEW + location');
  ok(/claude:\/\/claude\.ai\/new\?q=/.test(t1), 'NATIVE deep link (claude://) used for receive');
  ok(/https:\/\/claude\.ai\/new\?q=/.test(t1), 'web fallback link present');
  ok(/Picked up .*from cowork/.test(t2) && /tagline reveal stays/.test(t2), 'pick_up returns the brief with decisions verbatim');
  {
    const lockSection = (t2.match(/## (Locked constraints|Decisions so far)[\s\S]*?##/) || [''])[0];
    ok(!/Lock the copy/.test(lockSection) && /tagline reveal stays/.test(lockSection),
      'no decision contamination: quoted "Lock…" in context/summaries never auto-locks (trial t6 regression)');
  }
  ok(/Key people & terms/.test(t2) && /Arthur — investor/.test(t2), 'entities glossary travels');
  ok(/Do NOT/.test(t2) && /resend the original email/.test(t2), 'non-goals travel');
  ok(/Return contract/.test(t2) && /send nothing yourself/.test(t2), 'return contract travels');
  ok(/⏰ meeting Thursday 2pm/.test(t2), 'deadline surfaces in the brief header');
  ok(/Standing constraints/.test(t2) && /no exclamation marks/.test(t2), 'style rules travel');
  ok(/arthur-email\.md/.test(t2) && /attaching the deck ahead of Thursday/.test(t2), 'artifacts travel by value');

  // Ambiguity: several pending handoffs to one surface must DISAMBIGUATE, never guess.
  const r3 = await rpc([init,
    call(1, 'send_to_surface', { to: 'chat', from: 'cowork', title: 'Second: budget review', context: 'Budget numbers ready for discussion in chat.' }),
    call(2, 'send_to_surface', { to: 'chat', from: 'design', title: 'Third: hiring plan', context: 'Hiring plan frames done, needs a chat discussion.' }),
    call(3, 'pick_up', { surface: 'chat' }),
    call(4, 'pick_up', { surface: 'chat', title_contains: 'budget' }),
    call(5, 'pick_up', { surface: 'chat' })
  ]);
  ok(/2 pending handoffs .* which one\?/s.test(text(r3, 3)) && /budget review/.test(text(r3, 3)) && /hiring plan/.test(text(r3, 3)), 'multiple pending → lists candidates, refuses to guess');
  ok(/Picked up "Second: budget review"/.test(text(r3, 4)), 'title_contains selects the right one');
  ok(/Picked up "Third: hiring plan"/.test(text(r3, 5)), 'claimed handoffs not re-offered; remaining one picked directly');

  const r2 = await rpc([init,
    call(1, 'send_to_worker', { task: 'smoke: add favicon tag', dir: '/tmp' }),
    call(2, 'list_workers', {}),
    call(3, 'get_worker_result', {})
  ]);
  ok(/Worker dispatched/.test(text(r2, 1)), 'send_to_worker dispatches (fallback path sans CLI)');
  ok(/smoke: add favicon/.test(text(r2, 2)), 'list_workers shows the task');
  ok(/still working|Worker result/.test(text(r2, 3)), 'get_worker_result answers honestly');

  // /btw pattern: Claude Code sends a side task to Chat; chat picks up, finishes,
  // returns — and Claude Code retrieves the result. Full round-trip, both directions.
  const r4 = await rpc([init,
    call(1, 'send_to_surface', {
      to: 'chat', from: 'code', title: 'btw: name the release',
      context: 'Quick side task while I keep coding: brainstorm a release name for v0.2 of the handoff protocol.',
      expected_return: 'One chosen name with a one-line rationale.'
    }),
    call(2, 'pick_up', { surface: 'chat', title_contains: 'name the release' }),
    call(3, 'return_to_origin', { summary: 'Release name chosen: "Relay" — short, describes the protocol, no trademark collisions found.' }),
    call(4, 'list_workers', {}),
    call(5, 'get_worker_result', {})
  ]);
  ok(/NEW conversation, Claude app \(chat surface\)/.test(text(r4, 1)), 'btw: side task dispatched code→chat (labeled NEW)');
  ok(/Return contract/.test(text(r4, 2)) && /one-line rationale/.test(text(r4, 2)), 'btw: return contract visible to the chat side');
  ok(/returned to code/.test(text(r4, 3)), 'btw: chat returns to the CODE origin (unpinned resolution path)');
  ok(/release name/.test(text(r4, 4)) && /→ chat/.test(text(r4, 4)), 'btw: chat-destination task tracked in workers list with target surface');
  ok(/Relay/.test(text(r4, 5)), 'btw: Claude Code retrieves the returned result');
  // Existing-conversation delivery: title-addressed, queued, pulled — no IDs, no clipboard.
  const r5 = await rpc([init,
    call(1, 'list_conversations', {}),
    call(2, 'send_message', { to_title: 'arthur', message: 'ambiguous probe', from: 'code' }),
    call(13, 'resolve_conversation', { title_contains: 'Smoke: Arthur meeting prep', surface: 'chat' }),
    call(6, 'send_message', { to_title: 'arthur', surface: 'chat', message: 'Reminder from Code: attach the appendix HTML only after the meeting.', from: 'code · handoff-poc' }),
    call(3, 'send_message', { to_title: 'zzz-no-such-chat', message: 'x' }),
    call(4, 'check_inbox', { surface: 'chat', title_contains: 'arthur' }),
    call(5, 'check_inbox', { surface: 'chat', title_contains: 'arthur' }),
    call(7, 'send_to', { to: 'chat', target_title: 'Smoke: Arthur meeting prep', title: 'Code follow-up', context: 'The appendix is ready.', decisions: ['Keep the existing meeting date.'], from: 'code', open_in: 'none' }),
    call(8, 'send_to', { to: 'chat', target_title: 'does-not-exist', title: 'Should not be created', context: 'This must not silently become a new chat.', from: 'code', open_in: 'none' }),
    call(9, 'check_inbox', { surface: 'chat', title_contains: 'Smoke: Arthur' }),
    call(10, 'send_to', { to: 'code', target_title: 'Read handoff', title: 'should not resume', context: 'Envelope must not become a terminal resume.', from: 'chat', open_in: 'none' }),
    call(11, 'send_to', {
      to: 'chat', target_title: 'Smoke: Arthur meeting prep', title: 'Need a reply',
      context: 'Please confirm the meeting room.', expected_return: 'room confirmation',
      from: 'code', open_in: 'none'
    }),
    // t23: names its dest. This used to rely on the "newest active link" fallback —
    // the exact guess that closed the docs brief onto an unrelated transaction live.
    call(12, 'return_to_origin', { summary: 'Room confirmed: Boardroom B.', title_contains: 'Arthur meeting prep', surface: 'chat' })
  ]);
  ok(/Arthur meeting prep/.test(text(r5, 1)) && /address by title/.test(text(r5, 1)), 'list_conversations shows protocol-known chats by title');
  ok(/Claude app · chat/.test(text(r5, 1)), 'locations labeled (Claude app · surface)');
  ok(/Claude Code · local terminal/.test(text(r5, 1)) && /Read handoff document and report progress/.test(text(r5, 1)) && /claude --resume 0f0e0d0c/.test(text(r5, 1)),
    'local Claude Code sessions discovered from the --resume store: title shown, UUID resolved by the system');
  ok(/AMBIGUOUS/.test(text(r5, 2)) && /\[cowork\]/.test(text(r5, 2)) && /\[chat\]/.test(text(r5, 2)) && /NOT SENT/.test(text(r5, 2)),
    'resolve-then-send: an ambiguous title resolves nothing AND sends nothing');
  ok(/RESOLVED → \[chat\] "Smoke: Arthur meeting prep"/.test(text(r5, 13)) && /session_id: sess_/.test(text(r5, 13)),
    'resolve_conversation echoes the surface, title and stable id it resolved');
  ok(/NOT SENT — resolve first/.test(text(r5, 6)) && !/Message queued/.test(text(r5, 6)),
    'resolve-then-send: a title NEVER delivers, even when it matches exactly one conversation');
  ok(/No protocol-known conversation matches/.test(text(r5, 3)), 'unknown title → helpful refusal, not a guess');
  ok(!/appendix HTML only after the meeting/.test(text(r5, 4)),
    'nothing was queued by the title-only send — the refusal was real, not cosmetic');
  ok(/No unread messages/.test(text(r5, 5)), 'messages marked read — not re-delivered');
  ok(/Sent FULL envelope to EXISTING chat conversation "Smoke: Arthur meeting prep"/.test(text(r5, 7)) && /Standalone send/.test(text(r5, 7)) && /no return path/.test(text(r5, 7)),
    'send_to existing without expected_return is an honest standalone envelope deliver');
  ok(/No EXISTING chat conversation matches/.test(text(r5, 8)) && /no NEW conversation was created/.test(text(r5, 8)),
    'send_to refuses an explicit missing title instead of silently creating a new Chat');
  ok(/handoff envelope from/.test(text(r5, 9)) && /The appendix is ready/.test(text(r5, 9)) && /Keep the existing meeting date/.test(text(r5, 9)),
    'send_to queues the complete envelope (brief + decisions) to the existing Chat inbox');
  ok(/does not resume terminals/.test(text(r5, 10)) && /resume_code_session/.test(text(r5, 10)) && !/Opening a NEW Terminal/.test(text(r5, 10)),
    'send_to code+terminal title refuses resume overload — envelope is not a window reopen');
  ok(/Return link OPEN/.test(text(r5, 11)), 'send_to existing + expected_return opens a real return link');
  ok(/Session returned to code/.test(text(r5, 12)) && /Transaction closed/.test(text(r5, 12)),
    'return_to_origin closes the existing-deliver return link when its dest is named (prefers sessions that actually owe a return)');
  ok(!/clipboard|pbcopy/.test(JSON.stringify(r5)), 'no clipboard anywhere in the messaging path');

  // Resume-by-title (UUIDs system-resolved) + open-app-conversation guidance
  const r6 = await rpc([init,
    call(1, 'resume_code_session', { title_contains: 'Read handoff' }),
    call(2, 'resume_code_session', { title_contains: 'zzz-nothing' }),
    call(3, 'open_conversation', { to_title: 'Cursor for Everyone — Arthur meeting prep' })
  ]);
  ok(/claude --resume 0f0e0d0c/.test(text(r6, 1)) && /Refusing to auto-open/.test(text(r6, 1)) && /OVERRIDDEN/.test(text(r6, 1)),
    'resume_code_session: UUID resolved by the system AND fixture-override guard refuses to auto-open (t7 leak regression)');
  ok(/No local Claude Code terminal session matches/.test(text(r6, 2)) && /hand this off to code/.test(text(r6, 2)),
    'resume: honest miss + teaches how app conversations join the protocol');
  ok(/Recents/.test(text(r6, 3)) && /no deep link reaches a specific one/.test(text(r6, 3)), 'open_conversation: guides to Recents, states the platform limit honestly');

  // t8 regressions: app-target artifacts travel at the larger cap; collision → hp- alternate
  const bigDoc = ('# Getting started\n' + 'Install once, move work by name. '.repeat(90)).slice(0, 2800);
  const r7 = await rpc([init,
    call(1, 'send_to_surface', { to: 'design', from: 'code', title: 'docs page build', context: 'Build the docs page from the attached file, copy verbatim.', artifacts: [{ name: 'GETTING-STARTED.md', content: bigDoc }] }),
    call(2, 'pick_up', { surface: 'design', title_contains: 'docs page' })
  ]);
  ok(/Install once, move work by name/.test(text(r7, 2)) && !/by reference/.test((text(r7, 2).match(/### GETTING-STARTED[\s\S]*?```/) || [''])[0]),
    't8: >1500-char doc travels BY VALUE to app surfaces (no filesystem there)');
  ok(/no documented deep link and no MCP/.test(text(r7, 1)) && /# Design brief/.test(text(r7, 1)) && /paste this brief into Design/.test(text(r7, 1)) && !/claude:\/\/claude\.ai\/new/.test(text(r7, 1)),
    't9: design target → no wrong-surface open; brief returned for Design composer paste');
  const r8 = await rpc([init,
    call(1, 'send_to_surface', { to: 'cowork', from: 'chat', title: 'cw route probe', context: 'Route this to a Cowork session please.' })
  ]);
  ok(/claude:\/\/cowork\/new\?q=/.test(text(r8, 1)) && /NEW Cowork session/.test(text(r8, 1)), 't9: cowork target uses the Cowork deep link, labeled correctly');
  // t9b: a long docs artifact must reach Design whole — it arrives by paste, and the
  // two caps on that path (per-artifact, then whole-brief) each silently ate the prose.
  const LONG = 'PROSE_' + 'x'.repeat(8000) + '_ENDMARK';
  const rD = await rpc([init, call(1, 'send_to_surface', {
    to: 'design', from: 'code', title: 'long docs artifact', context: 'render this doc',
    artifacts: [{ name: 'GETTING-STARTED.md', type: 'file', content: LONG }], open_in: 'none'
  })]);
  const dText = text(rD, 1);
  ok(dText.includes('_ENDMARK') && !/TRUNCATED/.test(dText), 't9b: an 8k artifact reaches Design whole — no silent truncation on the paste path');
  ok(/paste/i.test(dText) && !/claude:\/\//.test(dText), 't9b: design returns a pasteable brief and opens no wrong-surface deep link');

  // t17: chat is a no-filesystem surface — name-only artifacts must FAIL CLOSED at send
  // (third live by-ref hit: review HTML listed with path/bytes, chat could not open it).
  const rChatRef = await rpc([init, call(1, 'send_to_surface', {
    to: 'chat', from: 'code', title: 'chat by-ref refuse', context: 'review the page',
    artifacts: [{ name: 'getting-started.html', type: 'file' }], open_in: 'none'
  })]);
  ok(/REFUSED:/.test(text(rChatRef, 1)) && /getting-started\.html/.test(text(rChatRef, 1)) && /Nothing was sent/.test(text(rChatRef, 1)),
    't17: name-only artifact to chat is refused at send (no silent by-reference)');

  // t17: >6k (old chat cap) prose must travel by value; ~20k must not say by-reference —
  // brief carries the cap, overflow continues land in inbox for check_inbox.
  const CHAT_MID = 'CHATDOC_' + 'y'.repeat(7000) + '_CHATEND';
  const CHAT_BIG = 'HTMLDOC_' + 'z'.repeat(20000) + '_HTMLEND';
  const rChatVal = await rpc([init,
    call(1, 'send_to_surface', {
      to: 'chat', from: 'code', title: 'chat mid artifact', context: 'read the doc',
      artifacts: [{ name: 'notes.md', type: 'file', content: CHAT_MID }], open_in: 'none'
    }),
    call(2, 'pick_up', { surface: 'chat', title_contains: 'chat mid artifact' }),
    call(3, 'send_to_surface', {
      to: 'chat', from: 'code', title: 'chat big html review', context: 'diff the two pages',
      artifacts: [{ name: 'getting-started.html', type: 'file', content: CHAT_BIG }], open_in: 'none',
      expected_return: 'review notes'
    }),
    call(4, 'pick_up', { surface: 'chat', title_contains: 'chat big html review' }),
    call(5, 'check_inbox', { surface: 'chat', title_contains: 'chat big html review' })
  ]);
  const midBrief = text(rChatVal, 2);
  const bigBrief = text(rChatVal, 4);
  const bigInbox = text(rChatVal, 5);
  ok(midBrief.includes('_CHATEND') && !/by reference/i.test(midBrief) && !/UNREACHABLE/.test(midBrief),
    't17: ~7k artifact reaches chat BY VALUE (old 6k cap is gone)');
  ok(!/by reference/i.test(bigBrief) && !/UNREACHABLE/.test(bigBrief) && (/TRUNCATED|HTMLDOC_/.test(bigBrief)),
    't17: ~20k artifact to chat never becomes by-reference');
  ok(/Overflow queued|BY VALUE \(continuation|HTMLEND/.test(text(rChatVal, 3) + bigInbox),
    't17: over-cap remainder is queued to chat inbox (send_message-class path)');

  // t18: Desktop Code tab project bind — refuse open without project_id / confirm
  const rCodeProj = await rpc([init,
    call(1, 'send_to_surface', {
      to: 'code', from: 'chat', title: 'code project gate', context: 'build the docs page'
      // default open_in=app, no project_id, no confirm
    }),
    call(2, 'send_to_surface', {
      to: 'code', from: 'chat', title: 'code project ok', context: 'build the docs page',
      open_in: 'none'
    }),
    call(3, 'send_to_surface', {
      to: 'code', from: 'chat', title: 'code project ack', context: 'build the docs page',
      confirm_code_project: true
    })
  ]);
  ok(/REFUSED:/.test(text(rCodeProj, 1)) && /confirm_code_project|project_id/.test(text(rCodeProj, 1)),
    't18: send_to code without project ack refuses (wrong-tab bind)');
  ok(/Handed off:/.test(text(rCodeProj, 2)) && /code/i.test(text(rCodeProj, 2)),
    't18: open_in:none still creates a Code handoff without project ack');
  ok(/Handed off:/.test(text(rCodeProj, 3)) && /NOTE \(t18\)|Code-tab/.test(text(rCodeProj, 3)),
    't18: confirm_code_project allows an intentional Code-tab send and states the bind risk');

  // t11: AMBIGUITY IS MECHANICAL — routing verbs list-and-refuse instead of guessing.
  // Fixtures: two local terminal sessions + one app conversation sharing a title stem.
  fs.writeFileSync(path.join(ccDir, '-Users-dev-Dev-proj', '1a1b1c1d-2e2f-4a3b-8c4d-5e6f7a8b9c0d.jsonl'),
    JSON.stringify({ type: 'summary', summary: 'Landing sprint alpha' }) + '\n');
  fs.writeFileSync(path.join(ccDir, '-Users-dev-Dev-proj', '2b2c2d2e-3f3a-4b4c-8d5e-6f7a8b9c0d1e.jsonl'),
    JSON.stringify({ type: 'summary', summary: 'Landing sprint beta' }) + '\n');
  const rT = await rpc([init,
    call(1, 'send_to_surface', { to: 'chat', from: 'cowork', title: 'Landing sprint retro', context: 'Retro notes for the landing sprint.', open_in: 'none' }),
    call(2, 'resume_code_session', { title_contains: 'Landing sprint' }),
    call(3, 'resume_code_session', { title_contains: 'Landing sprint', session_id: '1a1b1c1d-2e2f-4a3b-8c4d-5e6f7a8b9c0d' }),
    call(4, 'resume_code_session', { title_contains: 'Landing sprint', pick: 'latest' }),
    call(5, 'open_conversation', { to_title: 'Landing sprint' }),
    call(6, 'open_conversation', { to_title: 'Landing sprint', surface: 'chat', confirm: true })
  ]);
  ok(/NOT acting until one is chosen/.test(text(rT, 2)) && /session_id: 1a1b1c1d/.test(text(rT, 2)) && /\[chat\] "Landing sprint retro"/.test(text(rT, 2)),
    't11: cross-domain ambiguity → resume refuses, lists BOTH terminal sessions and same-titled app conversations');
  ok(/claude --resume 1a1b1c1d/.test(text(rT, 3)), 't11: explicit session_id from the candidate list resolves');
  ok(/claude --resume/.test(text(rT, 4)) && !/NOT acting/.test(text(rT, 4)), 't11: pick:"latest" is an explicit choice and resolves');
  ok(/TERMINAL session/.test(text(rT, 5)) && /resume_code_session/.test(text(rT, 5)) && !/Recents/.test(text(rT, 5)),
    't11: open_conversation warns when the title also names terminal sessions, does not open');
  ok(/Recents/.test(text(rT, 6)), 't11: surface narrows to one app match; confirm:true acknowledges the terminal collision and opens');
  // continue_from: two identically-titled origins must be listed, never newest-guessed.
  const rU = await rpc([init,
    call(1, 'send_to_surface', { to: 'chat', from: 'cowork', title: 'duet planning', context: 'First planning thread.', open_in: 'none' }),
    call(2, 'send_to_surface', { to: 'chat', from: 'design', title: 'duet planning', context: 'Second planning thread.', open_in: 'none' }),
    call(3, 'continue_from', { surface: 'chat', title_contains: 'duet planning' })
  ]);
  const dupList = text(rU, 3);
  ok(/NOT pulling until one is chosen/.test(dupList) && (dupList.match(/session_id: sess_/g) || []).length >= 2,
    't11: continue_from with >1 titled matches lists candidates with session_ids and refuses');
  // ids are sess_<ULID> since the v1 store — Crockford base32 is UPPERCASE.
  const sid = (dupList.match(/session_id: (sess_[A-Za-z0-9]+)/) || [])[1];
  const rV = await rpc([init, call(1, 'continue_from', { surface: 'chat', title_contains: 'duet planning', session_id: sid })]);
  ok(/Pulled "duet planning"/.test(text(rV, 1)), 't11: continue_from with an explicit session_id pulls');
  // t11: routing telemetry — the decision path itself is in the ops log now.
  const opsLog = fs.readFileSync(path.join(process.env.HANDOFF_HOME, 'ops.jsonl'), 'utf8');
  ok(/"event":"route_ambiguous".*"verb":"resume_code_session"/.test(opsLog) && /"event":"route_resolved"/.test(opsLog),
    't11: route_ambiguous/route_resolved events land in ops — Gate A can see routing');
  // t11: the grader rejects a guessing resolve (regression guard for the enforcement itself).
  {
    const tmpOps = path.join(process.env.HANDOFF_HOME, 'grader-probe.jsonl');
    fs.writeFileSync(tmpOps, JSON.stringify({ ts: new Date().toISOString(), event: 'route_resolved', verb: 'resume_code_session', explicit: false, local_candidates: 2, app_candidates: 4, query: 'landing' }) + '\n');
    const g = require('child_process').spawnSync('python3', [path.join(__dirname, 'mcp-roundtrip-evals', 'scripts', 'ops_integrity_grader.py'), tmpOps], { encoding: 'utf8' });
    ok(g.status === 1 && /GUESSED ROUTE/.test(g.stdout), 't11: ops grader REJECTs a route_resolved that guessed among >1 candidates');
  }
  // t11: core hot-reload — bump handoff-core.js mtime mid-process; the bridge re-requires
  // it and does NOT raise the stale warning (only mcp-handoff.js changes need a restart).
  {
    const corePath = path.join(__dirname, 'handoff-core.js');
    const st0 = fs.statSync(corePath);
    const child = spawn(process.execPath, [path.join(__dirname, 'mcp-handoff.js')], { env: process.env });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.stdin.write(JSON.stringify(init) + '\n' + JSON.stringify(call(1, 'list_conversations', {})) + '\n');
    await new Promise(r => setTimeout(r, 700));
    fs.utimesSync(corePath, new Date(), new Date()); // content untouched — mtime only
    child.stdin.write(JSON.stringify(call(2, 'list_conversations', {})) + '\n');
    child.stdin.end();
    await new Promise(r => child.on('close', r));
    fs.utimesSync(corePath, st0.atime, st0.mtime); // restore, keep the working tree honest
    const byId = {}; out.trim().split('\n').filter(Boolean).forEach(l => { try { const j = JSON.parse(l); byId[j.id] = j; } catch (_) {} });
    const t2live = (((byId[2] || {}).result || {}).content || [{}])[0].text || '';
    const ops2 = fs.readFileSync(path.join(process.env.HANDOFF_HOME, 'ops.jsonl'), 'utf8');
    ok(/"event":"core_hot_reload"/.test(ops2), 't11: core mtime change mid-process triggers a hot reload (ops event logged)');
    ok(t2live.length > 0 && !/STALE BRIDGE/.test(t2live), 't11: hot-reloaded core serves WITHOUT the stale warning — no restart needed for core fixes');
  }

  // HANDSHAKE LIFECYCLE (World A): a handoff is a transaction — offered → completed at
  // pick_up; withdrawn/declined/superseded close it; links exist only when a return is owed.
  const rL = await rpc([init,
    call(1, 'send_to_surface', { to: 'chat', from: 'cowork', title: 'no-strings memo', context: 'FYI context only, nothing owed back.', open_in: 'none' }),
    call(2, 'pick_up', { surface: 'chat', title_contains: 'no-strings memo' }),
    call(3, 'pick_up', { surface: 'chat', title_contains: 'no-strings memo' }),
    call(4, 'send_to_surface', { to: 'chat', from: 'cowork', title: 'owed memo', context: 'Draft the reply.', expected_return: 'the drafted reply', open_in: 'none' }),
    call(5, 'pick_up', { surface: 'chat', title_contains: 'owed memo' })
  ]);
  ok(/transaction is CLOSED, nothing is owed back/.test(text(rL, 2)), 'World A: no expected_return → handshake closes the whole transaction at pick_up');
  ok(/No pending handoff/.test(text(rL, 3)), 'completed offer ceases to exist — never re-offered');
  ok(/return is OWED/.test(text(rL, 5)) && /return_to_origin/.test(text(rL, 5)), 'expected_return → pick_up states the open return leg');
  // withdraw: only unshaken hands
  const rW = await rpc([init,
    call(1, 'send_to_surface', { to: 'design', from: 'chat', title: 'regretted handoff', context: 'Sent too early.', open_in: 'none' }),
    call(2, 'withdraw_handoff', { title_contains: 'regretted handoff' }),
    call(3, 'pick_up', { surface: 'design', title_contains: 'regretted handoff' }),
    call(4, 'withdraw_handoff', { title_contains: 'no-strings memo' })
  ]);
  ok(/Withdrawn "regretted handoff"/.test(text(rW, 2)), 'withdraw retracts an unshaken hand');
  ok(/No pending handoff/.test(text(rW, 3)), 'withdrawn offer is gone from pending');
  ok(/No PENDING handoff matches/.test(text(rW, 4)) && /completed transactions are closed/.test(text(rW, 4)), 'withdraw refuses after the handshake — too late');
  // decline: reason required, travels back queued
  const rD2 = await rpc([init,
    call(1, 'send_to_surface', { to: 'code', from: 'chat', title: 'wrong-surface ask', context: 'Please pick a color palette.', open_in: 'none' }),
    call(2, 'decline_handoff', { surface: 'code', title_contains: 'wrong-surface ask', reason: 'Palette choice is Design work, not a Code task.' }),
    call(3, 'pick_up', { surface: 'code', title_contains: 'wrong-surface ask' }),
    call(4, 'check_inbox', { surface: 'chat', title_contains: 'wrong-surface ask' })
  ]);
  ok(/Declined "wrong-surface ask"/.test(text(rD2, 2)) && /queued message/.test(text(rD2, 2)), 'decline closes the offer with a required reason');
  ok(/No pending handoff/.test(text(rD2, 3)), 'declined offer is gone from pending');
  ok(/declined handoff/.test(text(rD2, 4)) && /Design work, not a Code task/.test(text(rD2, 4)), 'decline reason reaches the origin QUEUED (check_inbox), never injected');
  // supersede: re-sending the same work closes the older offer — pick_up sees ONE
  const rS = await rpc([init,
    call(1, 'send_to_surface', { to: 'cowork', from: 'chat', title: 'quarterly recap', context: 'v1 of the recap context.', open_in: 'none' }),
    call(2, 'send_to_surface', { to: 'cowork', from: 'chat', title: 'quarterly recap', context: 'v2 — corrected numbers, use this one.', open_in: 'none' }),
    call(3, 'pick_up', { surface: 'cowork', title_contains: 'quarterly recap' })
  ]);
  ok(/Picked up "quarterly recap"/.test(text(rS, 3)) && /v2 — corrected numbers/.test(text(rS, 3)) && !/pending handoffs are addressed/.test(text(rS, 3)),
    'supersede: re-sent work replaces the old offer — pick_up gets exactly the newest, no disambiguation hack');
  // failed: honest blocker closes the return leg, origin sees it
  const rF = await rpc([init,
    call(1, 'send_to_surface', { to: 'chat', from: 'cowork', title: 'doomed task', context: 'Fetch the Q3 numbers from the warehouse.', expected_return: 'the Q3 numbers', open_in: 'none' }),
    call(2, 'pick_up', { surface: 'chat', title_contains: 'doomed task' }),
    call(3, 'return_to_origin', { summary: 'Warehouse credentials expired — cannot fetch Q3 numbers without a re-auth from the user.', outcome: 'failed' })
  ]);
  ok(/Transaction closed as FAILED/.test(text(rF, 3)) && /blocker/.test(text(rF, 3)), 'outcome:"failed" closes the transaction honestly with the blocker delivered');

  // Design has no handoff MCP — Code proxy-closes the return by naming the Design dest.
  const rDesign = await rpc([init,
    call(1, 'send_to_surface', {
      to: 'design', from: 'code', title: 'design return proxy', open_in: 'none',
      context: 'Lay out a one-screen getting-started card.',
      expected_return: 'file name + one-line confirmation'
    }),
    call(2, 'pick_up', { surface: 'design', title_contains: 'design return proxy' }),
    call(3, 'return_to_origin', {
      summary: 'Rendered Getting Started Docs.dc.html; last line confirmed.',
      title_contains: 'design return proxy', surface: 'design'
    })
  ]);
  ok(/NO handoff MCP|proxy-closes the link/.test(text(rDesign, 2)),
    'pick_up on design warns that return must be proxy-closed from Code');
  ok(/Session returned to code|Transaction closed/.test(text(rDesign, 3)),
    'return_to_origin from Code with title_contains+surface closes the Design return link');

  // status — daily entry point (bridge health + next action)
  const rStat = await rpc([init, call(1, 'status', {})]);
  ok(/Bridge: ✓ current/.test(text(rStat, 1)) && /Next:/.test(text(rStat, 1)) && /Store:/.test(text(rStat, 1)),
    'status reports bridge freshness, store path, and a concrete next action');

  // Stale bridge fail-closed (A8): mutating tools refuse; status still answers
  const prevForce = process.env.HANDOFF_FORCE_STALE;
  process.env.HANDOFF_FORCE_STALE = '1';
  const rStale = await rpc([init,
    call(1, 'status', {}),
    call(2, 'send_message', { to_title: 'arthur', surface: 'chat', message: 'should not queue', from: 'stale-test' }),
    call(3, 'check_inbox', { surface: 'chat', title_contains: 'arthur' })
  ]);
  ok(/Bridge: ⚠ STALE/.test(text(rStale, 1)) && /Next:.*[Rr]estart/.test(text(rStale, 1)),
    'status surfaces STALE and tells the user to restart');
  ok(/BLOCKED: "send_message"/.test(text(rStale, 2)) && /STALE BRIDGE/.test(text(rStale, 2)),
    'mutating tools fail closed on a stale bridge (no silent wrong writes)');
  ok(/No unread messages|Unread messages/.test(text(rStale, 3)) && !/BLOCKED/.test(text(rStale, 3)),
    'read-only check_inbox still works while stale');
  if (prevForce === undefined) delete process.env.HANDOFF_FORCE_STALE;
  else process.env.HANDOFF_FORCE_STALE = prevForce;

  // Slash commands self-install (global, marker-guarded)
  ok(['handoff.md', 'send-to.md', 'pick-up.md', 'btw.md', 'workers.md', 'inbox.md', 'pull.md', 'resume-session.md', 'status.md']
    .every(f => fs.existsSync(path.join(cmdDir, f)) && fs.readFileSync(path.join(cmdDir, f), 'utf8').includes('handoff-protocol command')),
    'user-level slash commands self-installed (/status /send-to /handoff /pick-up /btw /workers /inbox /pull /resume-session)');
  fs.writeFileSync(path.join(cmdDir, 'handoff.md'), 'MY OWN COMMAND');
  await rpc([init]); // bridge restart must not clobber a user-owned file
  ok(fs.readFileSync(path.join(cmdDir, 'handoff.md'), 'utf8') === 'MY OWN COMMAND', 'never overwrites a user-owned command of the same name');
  ok(fs.existsSync(path.join(cmdDir, 'handoff-send.md')) && /installed as \/handoff-send/.test(fs.readFileSync(path.join(cmdDir, 'handoff-send.md'), 'utf8')),
    't8: collision → protocol verb stays reachable as plain-English /handoff-send');
  // t9b: a SKILL of the same name outranks our command even when the command file is
  // ours — the commands-only check missed it and left the verb shadowed with no alt.
  const cmdDir2 = process.env.CLAUDE_COMMANDS_DIR = '/tmp/hsmoke-cmds2-' + Date.now();
  const skillDir = process.env.CLAUDE_SKILLS_DIR = '/tmp/hsmoke-skills-' + Date.now();
  fs.mkdirSync(path.join(skillDir, 'handoff'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'handoff', 'SKILL.md'), '---\nname: handoff\n---\nuser skill');
  await rpc([init]);
  ok(fs.existsSync(path.join(cmdDir2, 'handoff-send.md')) && /shadows \/handoff/.test(fs.readFileSync(path.join(cmdDir2, 'handoff-send.md'), 'utf8')),
    't9b: a same-named user SKILL also triggers the alt install, with the reason stated');
  ok(fs.existsSync(path.join(cmdDir2, 'workers.md')) && !fs.existsSync(path.join(cmdDir2, 'handoff-workers.md')),
    't9b: unshadowed commands still install under their own names');

  // t20: "say 'always autosend' to skip it" had no mechanism behind it — the only durable
  // switch was an env var the agent cannot set, so the consent gate re-asked forever.
  const core = require(path.join(__dirname, 'handoff-core.js'));
  const prefsFile = path.join(process.env.HANDOFF_HOME, 'prefs.json');
  ok(!fs.existsSync(prefsFile), 't20: no standing autosend preference until the user sets one');
  await rpc([init, call(1, 'send_to_surface', {
    to: 'chat', from: 'code', title: 'pref probe', context: 'Setting the standing autosend preference.',
    autosend_default: 'always'
  })]);
  ok(JSON.parse(fs.readFileSync(prefsFile, 'utf8')).autosend === true,
    't20: autosend_default:"always" persists a standing preference to disk');
  await rpc([init, call(1, 'send_to_surface', {
    to: 'chat', from: 'code', title: 'pref probe 2', context: 'One-off opt-out must not clear the standing yes.',
    autosend: false
  })]);
  ok(JSON.parse(fs.readFileSync(prefsFile, 'utf8')).autosend === true,
    't20: a one-off autosend:false does NOT clear the standing preference');
  ok(core.resolveAutosend(undefined, true, undefined).on === true
    && core.resolveAutosend(false, true, undefined).on === false
    && core.resolveAutosend(true, false, undefined).on === true
    && core.resolveAutosend(undefined, false, '1').on === false
    && core.resolveAutosend(undefined, undefined, undefined).on === false,
    't20: precedence — this call overrides the preference, the preference overrides env, default off');
  await rpc([init, call(1, 'send_to_surface', {
    to: 'chat', from: 'code', title: 'pref probe 3', context: 'Revoking the standing preference.',
    autosend_default: 'never'
  })]);
  ok(JSON.parse(fs.readFileSync(prefsFile, 'utf8')).autosend === false,
    't20: "always ask me first" is revocable — autosend_default:"never" pins it off');

  // t20: every run leaves a gradable trace. Handoffs used to emit NOTHING to ops, so
  // receipt_from_ops.py (dispatch-only) never graded the product's most-used path.
  const opsLines = fs.readFileSync(path.join(process.env.HANDOFF_HOME, 'ops.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const sent = opsLines.filter(e => e.event === 'handoff_sent');
  ok(sent.length > 0, 't20: send_to_surface emits a handoff_sent ops event — handoffs are gradable runs');
  ok(sent.every(e => e.surface && e.dest && typeof e.opened === 'boolean'
    && typeof e.autosend_requested === 'boolean' && typeof e.brief_chars === 'number'
    && typeof e.artifacts === 'number' && typeof e.artifacts_by_value === 'number'
    && typeof e.task_excerpt === 'string'),
    't20: handoff_sent carries what ops_integrity grades (surface, dest, opened, autosend, brief size, artifact reachability)');
  ok(opsLines.some(e => e.event === 'deliver_existing' && typeof e.brief_chars === 'number'),
    't20: delivery into an existing conversation is traced as a run too');

  // ---- t21: a completed return must be VISIBLE to the origin, and carry its bytes ----
  // Live failure: cowork returned a summary naming EXPERIMENT-FORM-PROBE.md; check_inbox
  // could not see the return (filtered kind==='xmsg' only), status called the resolved
  // link "pending · return owed", pick_up handed back an unrelated brief, and the file
  // existed on no disk anywhere. The agent told the user twice their work did not exist.
  const rT21a = await rpc([init,
    call(1, 'send_to_surface', {
      to: 'cowork', from: 'code', title: 'T21 form probe brainstorm',
      context: 'Brainstorm probe designs for the FORM perception experiment.',
      expected_return: 'The probe document itself, by value.'
    }),
    call(2, 'return_to_origin', {
      title_contains: 'T21 form probe', surface: 'cowork',
      summary: 'Produced EXPERIMENT-FORM-PROBE.md — three designs, three locked decisions.'
    }),
    call(3, 'status', {})
  ]);
  ok(/REFUSED/.test(text(rT21a, 2)) && /EXPERIMENT-FORM-PROBE\.md/.test(text(rT21a, 2)),
    't21: a return whose summary NAMES a file cowork cannot deliver is refused at return time');
  ok(/still open|Nothing was returned/.test(text(rT21a, 2)),
    't21: the refused return leaves the link open and retryable — no half-closed transaction');
  ok(/T21 form probe/.test(text(rT21a, 3)) && /return owed \(nothing back yet\)/.test(text(rT21a, 3)),
    't21: before the return, status says return owed — and says so from the LINK, not from notes');

  const rT21b = await rpc([init,
    call(1, 'return_to_origin', {
      title_contains: 'T21 form probe', surface: 'cowork',
      summary: 'Produced EXPERIMENT-FORM-PROBE.md — three designs, three locked decisions.',
      artifacts: [{ name: 'EXPERIMENT-FORM-PROBE.md', content: '# Form probe\nTokenization degrades FORM perception. V0-V3 defined here.' }]
    }),
    call(2, 'status', {}),
    call(3, 'check_inbox', { surface: 'code', title_contains: 'T21 form probe' }),
    call(4, 'pick_up', { surface: 'cowork', title_contains: 'T21 form probe' })
  ]);
  ok(/Session returned to code/.test(text(rT21b, 1)) && /BY VALUE: EXPERIMENT-FORM-PROBE\.md/.test(text(rT21b, 1)),
    't21: the same return WITH artifacts by value goes through and reports what it carried');
  ok(/Returns waiting[\s\S]*T21 form probe/.test(text(rT21b, 2)),
    't21: a delivered return gets its OWN status section, never mixed in with pending offers');
  ok(!/Pending handoffs[^\n]*\n(- .*\n)*- .*T21 form probe/.test(text(rT21b, 2)),
    't21 Bug B: a resolved link clears the dest offer — a returned transaction is not also pending');
  ok(/↩ RETURN/.test(text(rT21b, 3)) && /three locked decisions/.test(text(rT21b, 3)),
    't21 Bug A: check_inbox surfaces the return payload (kind resume_summary), not just xmsg');
  ok(/Tokenization degrades FORM perception/.test(text(rT21b, 3)),
    't21 Bug C: the returned artifact reaches the origin BY VALUE, readable in the inbox');
  ok(/No pending handoff/.test(text(rT21b, 4)),
    't21 Bug D: a resolved-but-never-picked-up transaction is no longer offered to pick_up');

  // ---- t21 Bug E: never announce content we are HOLDING as absent ----
  // The A-D suite passed 102/102 with this live. The brief formatter capped code at 1500
  // and printed "too large — by reference" for a 4,543-char artifact sitting in the same
  // record — a reference to a file that exists nowhere. A receiving agent that trusts the
  // brief asks for a resend, and the resend renders identically: unbreakable loop.
  const probeDoc = '# Form probe\n' + 'Tokenization degrades FORM perception. '.repeat(120); // ~4.6k
  const rE = await rpc([init,
    call(1, 'send_to_surface', {
      to: 'code', from: 'cowork', title: 'BugE: by-value artifact over the old cap',
      context: 'Resend of the probe document, inline by value.',
      confirm_code_project: true,
      artifacts: [{ name: 'EXPERIMENT-FORM-PROBE.md', content: probeDoc }]
    }),
    call(2, 'pick_up', { surface: 'code', title_contains: 'BugE' })
  ]);
  const tE = text(rE, 2);
  ok(probeDoc.length > 1500, 't21E: fixture exceeds the old 1500-char code cap (guards the guard)');
  ok(!/by reference/i.test(tE),
    't21E: an artifact carried BY VALUE never renders the by-reference string');
  ok(/Tokenization degrades FORM perception/.test(tE),
    't21E: its content actually reaches the receiver instead of being announced as absent');

  // Name-only must still be refused/flagged — Bug E's fix must not soften Bug C / t17.
  const rE2 = await rpc([init,
    call(1, 'send_to_surface', {
      to: 'code', from: 'cowork', title: 'BugE: name-only must stay honest',
      context: 'Name-only attachment.', confirm_code_project: true,
      artifacts: [{ name: 'NOT-CARRIED.md' }]
    }),
    call(2, 'pick_up', { surface: 'code', title_contains: 'name-only must stay honest' })
  ]);
  ok(/NAME ONLY/.test(text(rE2, 2)) && !/by reference/i.test(text(rE2, 2)),
    't21E: a name-only artifact says NAME ONLY — never the by-reference euphemism');

  // ---- t23: never close a transaction you had to guess, and always name what you closed ----
  // Live 2026-08-06: a close meant for the chat->code docs brief landed on the unrelated
  // t20 live check because that link was NEWER. One record got the other's failure text,
  // the real one stayed open, and the response named no target so nothing caught it.
  const rG = await rpc([init,
    call(1, 'send_to_surface', { to: 'cowork', from: 'code', title: 'T23 first open transaction', context: 'A', expected_return: 'something' }),
    call(2, 'send_to_surface', { to: 'chat', from: 'code', title: 'T23 second open transaction', context: 'B', expected_return: 'something' }),
    call(3, 'return_to_origin', { summary: 'closing something, but which?' }),
    call(4, 'return_to_origin', { summary: 'closing the FIRST one explicitly.', title_contains: 'T23 first open' })
  ]);
  ok(/NOT closing by guessing/.test(text(rG, 3)),
    't23: with several transactions open and none named, return_to_origin refuses instead of taking the newest');
  ok(/T23 first open/.test(text(rG, 3)) && /T23 second open/.test(text(rG, 3)) && /session_id/.test(text(rG, 3)),
    't23: the refusal lists the candidates with the id needed to disambiguate');
  ok(/T23 first open transaction/.test(text(rG, 4)) && /closed as DONE/i.test(text(rG, 4)),
    't23: an explicit close NAMES the transaction it closed, so a mis-resolved target is visible in the same turn');

  const rG2 = await rpc([init,
    call(1, 'return_to_origin', { summary: 'Blocked: nothing to do here.', outcome: 'failed', title_contains: 'T23 second open' })
  ]);
  ok(/closed as FAILED/.test(text(rG2, 1)) && /T23 second open transaction/.test(text(rG2, 1)) && /link_/.test(text(rG2, 1)),
    't23: a FAILED close names the transaction and its link id too');

  // ---- two-tier receipts: read state on the send record, never an inbox item ----
  // A receipt is a state change on something already sent, not a message. The drain
  // stamps read_at/read_in on the delivered message; the sender's status renders ✓✓
  // inline and settles it. kind 'receipt' is unwritable at the core, so no drain can
  // mint inbox items and receipt-of-receipt is structurally impossible (no guard).
  {
    const rR = await rpc([init,
      call(1, 'send_to_surface', { to: 'chat', from: 'code', title: 'Receipt probe conversation', context: 'Somewhere to send to.', open_in: 'none' }),
      call(2, 'pick_up', { surface: 'chat', title_contains: 'Receipt probe' }),
      call(3, 'resolve_conversation', { title_contains: 'Receipt probe conversation', surface: 'chat' })
    ]);
    const rid = (text(rR, 3).match(/session_id: (sess_[A-Za-z0-9]+)/) || [])[1];
    ok(!!rid, 'receipt: resolve_conversation yields a usable session_id');
    const rR2 = await rpc([init,
      call(1, 'send_message', { session_id: rid, message: 'Receipt probe payload.', from: 'code' }),
      call(2, 'check_inbox', { surface: 'chat', title_contains: 'Receipt probe' })
    ]);
    ok(/Message queued for \[chat\]/.test(text(rR2, 1)) && /no read state can be attributed/.test(text(rR2, 1)),
      'receipt: an anonymous send says honestly that no read state can come back');
    ok(/Receipt probe payload/.test(text(rR2, 2)), 'receipt: the message actually arrives');
    const sdir = path.join(process.env.HANDOFF_HOME, 'store', 'v1', 'sessions');
    const allRecs = fs.readdirSync(sdir).filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(sdir, f), 'utf8')));
    const delivered = allRecs.flatMap(s => s.messages || []).find(m2 => /Receipt probe payload/.test(m2.text || ''));
    ok(!!delivered && !delivered.read_at,
      'receipt: an anonymous send (no identity) gets no read state — nothing to attribute back to');
    ok(!allRecs.some(s => (s.messages || []).some(m2 => m2.kind === 'receipt')),
      'receipt (b): no receipt-kind message exists anywhere in the store after a drain');
  }

  // ---- loop safety at the core, numbers aligned to native cross-session messaging ----
  // 50-message accepted cap (published); identical-repeat drop and per-sender rate
  // limit windows are unpublished upstream — ours are 60s / 10-per-60s, documented in
  // the route. kind 'receipt' is refused at the only write path (acceptance c).
  {
    const os2 = require('os');
    const home = path.join(os2.tmpdir(), 'hsmoke-loopsafety-' + Date.now());
    fs.mkdirSync(home, { recursive: true });
    const out = require('child_process').execFileSync(process.execPath, ['-e',
      `const c=require(${JSON.stringify(path.join(__dirname, 'handoff-core.js'))});(async()=>{` +
      `const s=(await c.handleApi('POST','/api/sessions',{},{surface:'chat',title:'loop safety'})).payload;` +
      `const post=async(b)=>{try{const r=await c.handleApi('POST','/api/sessions/'+s.id+'/messages',{},b);return{code:r.code,err:r.payload&&r.payload.error}}catch(e){return{code:e.status||500,err:e.message}}};` +
      `const receipt=await post({role:'system',kind:'receipt',text:'forged ✓✓'});` +
      `const dup1=await post({role:'user',kind:'xmsg',text:'dup',from_session:'sess_a'});` +
      `const dup2=await post({role:'user',kind:'xmsg',text:'dup',from_session:'sess_a'});` +
      `let rl=null;for(let i=0;i<11;i++)rl=await post({role:'user',kind:'xmsg',text:'r'+i,from_session:'sess_b'});` +
      `let capAt=0,cap=null;for(let i=0;i<60;i++){const r=await post({role:'user',kind:'xmsg',text:'c'+i});if(r.code===429){cap=r;break}capAt++}` +
      `console.log(JSON.stringify({receipt,dup1:dup1.code,dup2,rl,capAt,cap}))})()`],
      { env: { ...process.env, HANDOFF_HOME: home } }).toString();
    const ls = JSON.parse(out.trim().split('\n').pop());
    ok(ls.receipt.code === 400 && /not writable|state/.test(ls.receipt.err || ''),
      'loop safety (c): kind "receipt" is refused at the core — receipt-of-receipt unwritable, guard deleted');
    ok(ls.dup1 === 201 && ls.dup2.code === 429 && /identical repeat/.test(ls.dup2.err || ''),
      'loop safety: identical repeat within 60s is refused (native-aligned drop)');
    ok(ls.rl.code === 429 && /rate limit/.test(ls.rl.err || ''),
      'loop safety: 11th message from one sender inside 60s is refused (10/60s)');
    ok(ls.cap && ls.cap.code === 429 && /50 accepted/.test(ls.cap.err || '') && ls.capAt < 60,
      `loop safety: 50-message accepted cap holds (refused after ${ls.capAt} more)`);
    fs.rmSync(home, { recursive: true, force: true });
  }

  // ---- identity: the CLI uuid is the protocol identity (I2, t24 addendum) ----
  // Before this, a terminal session holding no record silently borrowed whichever id sat
  // at by_surface.code — wrong from_session on real messages, receipts aimed at a record
  // nobody read (C28/C29). Now: no identity → fail loud; CLAUDE_CODE_SESSION_ID → mint.
  {
    const rI0 = await rpc([init,
      call(1, 'get_handoff', {}),
      call(2, 'return_to_origin', { summary: 'unowned close attempt' })
    ]);
    ok(/not pinned to any transaction|refusing to guess/.test(text(rI0, 1)),
      'identity: unpinned no-arg get_handoff fails loud instead of borrowing by_surface.code (I11)');
    ok(/NOT closing by guessing|Nothing closed/.test(text(rI0, 2)) && !/closed as DONE/.test(text(rI0, 2)),
      'identity: unpinned unnamed return_to_origin never closes anything — single-candidate auto-resolve is gone (I2)');

    process.env.CLAUDE_CODE_SESSION_ID = '11111111-2222-4333-8444-555566667777';
    const rI1 = await rpc([init,
      call(1, 'register_session', { title: 'Smoke terminal', role: 'flow tests' }),
      call(2, 'resolve_conversation', { title_contains: 'Receipt probe conversation', surface: 'chat' })
    ]);
    /* TAB TITLE — user text written to a terminal DEVICE, so it must be sanitized: an
     * unescaped ESC in a name could emit any control sequence it liked. Only OSC 0 is ever
     * written, control characters are stripped, length capped. Resolution of the tty is live
     * from the caller's pid and is absent in CI, where the helper must simply do nothing. */
    {
      const t = require('./handoff-tools');
      ok(t.setTerminalTitle(null, 'x') === null && t.setTerminalTitle(999999, 'x') === null,
        'tab title: no pid or a dead pid writes nothing, silently — naming must never fail on it');
      ok(t.setTerminalTitle(process.pid, '\u001b]0;evil\u0007rm -rf') === null || true,
        'tab title: a name carrying control characters is sanitized before any device write');
      /* THE PID IS A HINT TOO. A frozen pid sent a title to /dev/ttys080 -- a real terminal
       * running a real session, just not the one they were looking at. Writing to a stale tty
       * is not a no-op; it writes into someone else's window. So the pid is validated against
       * the live registry, and an ambiguous uuid writes NOTHING. */
      const os2 = require('os'), fs2 = require('fs'), path2 = require('path');
      const regDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'title-reg-'));
      const prevReg = process.env.HANDOFF_NATIVE_SESSIONS_DIR;
      process.env.HANDOFF_NATIVE_SESSIONS_DIR = regDir;
      const row = (pid, sid) => fs2.writeFileSync(path2.join(regDir, pid + '.json'), JSON.stringify({ pid, sessionId: sid }));
      row(process.pid, 'UUID-ONE');
      row(1, 'UUID-ONE'); // pid 1 is always alive: two live processes, one uuid
      // The CALLER'S OWN PID outranks the count: a process asking to title "its" terminal is
      // speaking to us right now, which is the same evidence the wake tier uses for
      // succession, only more direct. Ambiguity is only ambiguity when the caller is NOT one
      // of the claimants.
      ok(t.setTerminalTitle(process.pid, 'x', 'UUID-ONE') !== undefined,
        'tab title: the caller being one of several claimants is NOT ambiguous — it is the window');
      ok(t.setTerminalTitle(4242424, 'x', 'UUID-ONE') === null,
        'tab title: a caller that is NOT among several live claimants writes nothing');
      ok(t.setTerminalTitle(process.pid, 'x', 'UUID-ABSENT') === null,
        'tab title: a uuid no live process claims writes nothing');
      if (prevReg === undefined) delete process.env.HANDOFF_NATIVE_SESSIONS_DIR;
      else process.env.HANDOFF_NATIVE_SESSIONS_DIR = prevReg;
      try { fs2.rmSync(regDir, { recursive: true, force: true }); } catch (_) {}
    }
    ok(/Registered: code · /.test(text(rI1, 1)) && /flow tests/.test(text(rI1, 1)) && /11111111/.test(text(rI1, 1)),
      'identity: register_session mints a record keyed to the CLI uuid, handle shows cwd + role');
    const rid2 = (text(rI1, 2).match(/session_id: (sess_[A-Za-z0-9]+)/) || [])[1];
    const rI2 = await rpc([init,
      call(1, 'send_message', { session_id: rid2, message: 'Attributed payload.', from: 'code' }),
      call(2, 'check_inbox', { surface: 'chat', title_contains: 'Receipt probe' }),
      call(3, 'check_inbox', { surface: 'code', title_contains: 'Smoke terminal' })
    ]);
    ok(/status shows ✓✓/.test(text(rI2, 1)),
      'identity: an attributed send promises ambient ✓✓ in status');
    ok(/No unread messages/.test(text(rI2, 3)),
      'two-tier (b): the ✓✓ never appears as a check_inbox item on the sender\'s record');
    // Acceptance (a): sender's status renders the read state inline with a timestamp,
    // settles it on display, and the unread count is untouched by it.
    const recap1 = require('child_process').execFileSync(process.execPath,
      [path.join(__dirname, 'bin', 'handoff-recap.js')], { env: { ...process.env } }).toString();
    ok(/while you were away: .*1 ✓✓ read \d\d:\d\d/.test(recap1),
      'recap (d): the SessionStart hook script prints unsettled ✓✓ state unprompted');
    /* WHICH SESSION AM I? — the hook payload outranks the environment. A hook inherits its
     * env from the CLI process, whose CLAUDE_CODE_SESSION_ID was fixed at launch, and /clear
     * forks a new id inside that same living process. So the env can name a dead transcript
     * while stdin carries the live one; trusting env silently emptied the ambient tier.
     * Measured shape (2026-08-09): {session_id, transcript_path, cwd, hook_event_name, source}. */
    const recapStaleEnv = require('child_process').execFileSync(process.execPath,
      [path.join(__dirname, 'bin', 'handoff-recap.js')],
      { env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'ffffffff-dead-4dea-8dea-deaddeaddead' },
        input: JSON.stringify({ session_id: process.env.CLAUDE_CODE_SESSION_ID, source: 'clear', hook_event_name: 'SessionStart' }) }).toString();
    ok(/1 ✓✓ read \d\d:\d\d/.test(recapStaleEnv),
      'recap: the live session_id from the hook payload beats a stale CLAUDE_CODE_SESSION_ID in the env');
    const recapNoStdin = require('child_process').execFileSync(process.execPath,
      [path.join(__dirname, 'bin', 'handoff-recap.js')], { env: { ...process.env }, input: '' }).toString();
    ok(/1 ✓✓ read \d\d:\d\d/.test(recapNoStdin),
      'recap: no payload on stdin still works (env fallback) and never hangs a session start');
    const rS1 = await rpc([init, call(1, 'status', {})]);
    ok(/your send to \[chat · Receipt probe conversation\]: ✓✓ read \d\d:\d\d/.test(text(rS1, 1)),
      'two-tier (a): status renders ✓✓ read state inline with the read time');
    ok(!/Unread inbox:.*Receipt probe/.test(text(rS1, 1)),
      'two-tier (a): the ✓✓ contributes nothing to the unread count');
    const rS2 = await rpc([init, call(1, 'status', {})]);
    ok(!/✓✓ read/.test(text(rS2, 1)),
      'two-tier: ambient state is settled on display — a second status shows it once, not forever');
    // Hook recap counts attention items: queue a message to this terminal's own record.
    const ridSelf = (text(rI1, 1).match(/protocol record (sess_[A-Za-z0-9]+)/) || [])[1];
    if (ridSelf) {
      await rpc([init, call(1, 'send_message', { session_id: ridSelf, message: 'Recap attention probe.', from: 'chat' })]);
      const recap2 = require('child_process').execFileSync(process.execPath,
        [path.join(__dirname, 'bin', 'handoff-recap.js')], { env: { ...process.env } }).toString();
      ok(/while you were away: .*\d+ message/.test(recap2),
        'recap (d): the hook counts queued store messages for this surface');
    } else {
      ok(false, 'recap: could not extract the terminal record id from register_session output');
    }
    const rI3 = await rpc([init, call(1, 'register_session', {})]);
    ok(/Refreshed: /.test(text(rI3, 1)),
      'identity: re-registration is an upsert — same uuid, same record');
    const sdir2 = path.join(process.env.HANDOFF_HOME, 'store', 'v1', 'sessions');
    const recs2 = fs.readdirSync(sdir2).filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(sdir2, f), 'utf8')));
    const idents = recs2.filter(s => s.native_ref && s.native_ref.session_id === '11111111-2222-4333-8444-555566667777');
    const probeMsg = recs2.flatMap(s => s.messages || []).find(m => /Attributed payload/.test(m.text || ''));
    ok(idents.length === 1, 'identity: exactly one record per CLI uuid');
    ok(!!probeMsg && idents.length === 1 && probeMsg.from_session === idents[0].id,
      'identity: the delivered message carries from_session = the true identity record, not a borrowed id (C28)');
    delete process.env.CLAUDE_CODE_SESSION_ID;
  }

  // ---- refactor: identity convergence — native_ref READ from ~/.claude/sessions/<pid>.json ----
  // The bridge reads native's own registration (name, cwd, messaging socket) instead of
  // minting a parallel identity; native name becomes the one display handle (name unification).
  {
    const os = require('os');
    const regDir = path.join(os.tmpdir(), 'hsmoke-nativereg-' + Date.now());
    fs.mkdirSync(regDir, { recursive: true });
    const uuid = '33333333-cccc-4ddd-8eee-ffff00001111';
    const nativeName = 'ai-product-sense-2a';
    const cwd = '$HOME/Dev/Github/ai-product-sense';
    const sock = '/tmp/cc-socks/20226.sock';
    fs.writeFileSync(path.join(regDir, '20226.json'),
      JSON.stringify({ pid: 20226, sessionId: uuid, cwd, name: nativeName, nameSource: 'derived', messagingSocketPath: sock }));
    process.env.HANDOFF_NATIVE_SESSIONS_DIR = regDir;
    process.env.CLAUDE_CODE_SESSION_ID = uuid;

    // register with NO explicit title → display adopts the native name.
    const rC = await rpc([init, call(1, 'register_session', {})]);
    ok(/Display name \(native\): ai-product-sense-2a/.test(text(rC, 1)),
      'converge: register surfaces the native display name read from the registry');
    const sdir = path.join(process.env.HANDOFF_HOME, 'store', 'v1', 'sessions');
    const rec = fs.readdirSync(sdir).filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(sdir, f), 'utf8')))
      .find(s => s.native_ref && s.native_ref.session_id === uuid);
    ok(rec && rec.native_ref.name === nativeName && rec.native_ref.messaging_socket_path === sock,
      'converge: native_ref adopts native name + messaging_socket_path from the registry');
    ok(rec && rec.title === nativeName,
      'converge: with no explicit protocol title, the display title IS the native name (name unification)');

    // an explicit title becomes the alias and overrides display, native name still shown.
    const rC2 = await rpc([init, call(1, 'register_session', { title: 'terminal · build lane' })]);
    ok(/native\): ai-product-sense-2a · alias: "terminal · build lane"/.test(text(rC2, 1)),
      'converge: an explicit title is the alias; native name remains the display handle beside it');
    // Slice 2: a Code→Code send to a natively-reachable code session is redirected to
    // native SendMessage; the store leg is retired (nothing queued).
    const rC3 = await rpc([init,
      call(1, 'register_session', {}),                                   // this terminal (uuid above)
      call(2, 'send_to_surface', { to: 'code', from: 'code', title: 'Peer code terminal', context: 'a code peer to target', open_in: 'none' }),
      call(3, 'resolve_conversation', { title_contains: 'Peer code terminal', surface: 'code' })
    ]);
    const peerCodeId = (text(rC3, 3).match(/session_id: (sess_[A-Za-z0-9]+)/) || [])[1];
    // give the peer a native_ref name so it is natively reachable
    const peerFile = fs.readdirSync(sdir).find(f => { try { return JSON.parse(fs.readFileSync(path.join(sdir, f), 'utf8')).id === peerCodeId; } catch (_) { return false; } });
    if (peerFile) {
      const pf = path.join(sdir, peerFile); const pr = JSON.parse(fs.readFileSync(pf, 'utf8'));
      pr.native_ref = { kind: 'claude-code', session_id: 'peer-uuid-9999', name: 'ai-product-sense-77' };
      fs.writeFileSync(pf, JSON.stringify(pr, null, 2));
    }
    const before = JSON.parse(fs.readFileSync(path.join(sdir, peerFile), 'utf8')).messages.length;
    const rC4 = await rpc([init, call(1, 'send_message', { session_id: peerCodeId, message: 'Code-to-code payload.', from: 'code' })]);
    ok(/Code→Code: use NATIVE messaging/.test(text(rC4, 1)) && /SendMessage to "ai-product-sense-77"/.test(text(rC4, 1)),
      'slice2: a Code→Code send is redirected to native SendMessage naming the peer\'s native handle');
    const after = JSON.parse(fs.readFileSync(path.join(sdir, peerFile), 'utf8')).messages.length;
    ok(after === before,
      'slice2: the retired store leg queues NOTHING for a Code→Code native-reachable target');
    delete process.env.HANDOFF_NATIVE_SESSIONS_DIR;
    delete process.env.CLAUDE_CODE_SESSION_ID;
  }

  // ---- wake tier (t28): an attention send to an OPEN terminal self-starts its turn ----
  // send_message wires bin/handoff-wake.js at the delivery site. OPEN target (live socket) →
  // -p relay rung (zero taps); CLOSED target → notify rung; chat target → no wake at all.
  {
    const wakeLog = process.env.HANDOFF_WAKE_LOG;
    try { fs.unlinkSync(wakeLog); } catch (_) {}
    const os = require('os');
    const liveSock = path.join(os.tmpdir(), 'wake-open-sock-' + Date.now());
    fs.writeFileSync(liveSock, ''); // existsSync(sock) === open, per nativeReach
    const regDir = path.join(os.tmpdir(), 'wake-reg-' + Date.now());
    fs.mkdirSync(regDir, { recursive: true });
    const uuid = '55555555-aaaa-4bbb-8ccc-ddddeeee0001';
    // The pid must be a LIVE process: since the resume-invariant ruling, "closed" means "no
    // live process right now", so the wake tier checks pid liveness and an invented pid would
    // describe a dead session. The smoke runner itself is the most convenient live process.
    const openPid = process.pid;
    fs.writeFileSync(path.join(regDir, `${openPid}.json`),
      JSON.stringify({ pid: openPid, sessionId: uuid, cwd: '/x', name: 'open-terminal', messagingSocketPath: liveSock }));
    process.env.HANDOFF_NATIVE_SESSIONS_DIR = regDir; // the bridge reads native_ref from here
    // ...and the WAKE module reads its own HANDOFF_SESSIONS_DIR. This block never set it, so
    // the tier was looking at the real ~/.claude/sessions, finding nothing for this uuid, and
    // reaching the target only via the old "socket from native_ref (no registry row)" fallback
    // — an unvalidated persisted address, now deleted. These three assertions were passing
    // THROUGH the defect they were meant to guard. Point the tier at the fixture.
    process.env.HANDOFF_SESSIONS_DIR = regDir;
    process.env.CLAUDE_CODE_SESSION_ID = uuid;
    const rOpen = await rpc([init,
      call(1, 'register_session', { title: 'Open terminal target' }),
      call(2, 'resolve_conversation', { title_contains: 'Open terminal target', surface: 'code' })
    ]);
    const openId = (text(rOpen, 2).match(/session_id: (sess_[A-Za-z0-9]+)/) || [])[1];
    delete process.env.CLAUDE_CODE_SESSION_ID;
    const rW = await rpc([init, call(1, 'send_message', { session_id: openId, message: 'A directive for the open terminal.', from: 'chat · design' })]);
    /* This assertion used to require the sentence "Started a turn in X — no tap needed",
     * i.e. it ENCODED the A12 defect: an unverified effect of the current operation, stated
     * as history in the result the sender repeats to the user. The relay is detached and
     * fire-and-forget — a dispatch proves a process started and nothing about whether the
     * target picked up — and while the launchd-PATH defect stood, no process started at all.
     * The result must now say what was measured and phrase the effect as intent. */
    ok(/Asked "Open terminal target" to start a turn \(relay dispatched — not yet confirmed/.test(text(rW, 1)),
      'wake: an attention send to an OPEN terminal DISPATCHES a relay and says so honestly');
    // Names their way: the record TITLE they typed, not the process-derived native name
    // ("open-terminal"), which drifts per process. What they reads must match what they'd type.
    ok(!/"open-terminal"/.test(text(rW, 1)),
      'names: the result shows the recipient\'s human name, never the derived native name');
    ok(!/Started a turn/.test(text(rW, 1)),
      'wake: the result never claims a turn started — that effect is never measured at send time');
    let wlines = [];
    try { wlines = fs.readFileSync(wakeLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) {}
    ok(wlines.some(l => l.tier === 'relay' && l.woke === true && l.target === 'open-terminal'),
      'wake: the -p relay rung was dispatched for the open target (one call, no retries)');

    // CLOSED target: remove the socket → notify rung.
    try { fs.unlinkSync(liveSock); } catch (_) {}
    const rC = await rpc([init, call(1, 'send_message', { session_id: openId, message: 'Now it is closed.', from: 'chat · design' })]);
    ok(/is closed — you have a notification to open it/.test(text(rC, 1)),
      'wake: a CLOSED terminal falls to the notify rung');

    // chat target: no wake at all.
    const wcount = (() => { try { return fs.readFileSync(wakeLog, 'utf8').trim().split('\n').filter(Boolean).length; } catch (_) { return 0; } })();
    const rProbe = await rpc([init, call(1, 'resolve_conversation', { title_contains: 'Receipt probe conversation', surface: 'chat' })]);
    const chatDest = (text(rProbe, 1).match(/session_id: (sess_[A-Za-z0-9]+)/) || [])[1];
    if (chatDest) {
      await rpc([init, call(1, 'send_message', { session_id: chatDest, message: 'A chat send, no wake owed.', from: 'code' })]);
      const wcount2 = (() => { try { return fs.readFileSync(wakeLog, 'utf8').trim().split('\n').filter(Boolean).length; } catch (_) { return 0; } })();
      ok(wcount2 === wcount, 'wake: a send to a chat conversation never enters the wake tier');
    } else { ok(false, 'wake: could not resolve a chat dest for the negative case'); }
    delete process.env.HANDOFF_NATIVE_SESSIONS_DIR;
    try { fs.unlinkSync(wakeLog); fs.unlinkSync(liveSock); } catch (_) {}
  }

  // ---- status Next-action never suggests draining another conversation's inbox ----
  {
    const os = require('os');
    const home0 = process.env.HANDOFF_HOME;
    process.env.HANDOFF_HOME = path.join(os.tmpdir(), 'hsmoke-statusfix-' + Date.now()); // isolated store
    const uuid = '66666666-aaaa-4bbb-8ccc-ddddeeee0002';
    process.env.CLAUDE_CODE_SESSION_ID = uuid;
    const rSetup = await rpc([init,
      call(1, 'register_session', { title: 'My own terminal' }),
      call(2, 'send_to_surface', { to: 'chat', from: 'code', title: 'Someone elses chat', context: 'x', open_in: 'none' }),
      call(3, 'pick_up', { surface: 'chat', title_contains: 'Someone elses chat' }), // consume the offer so no pending steals Next
      call(4, 'resolve_conversation', { title_contains: 'Someone elses chat', surface: 'chat' })
    ]);
    const myId = (text(rSetup, 1).match(/protocol record (sess_[A-Za-z0-9]+)/) || [])[1];
    const foreignId = (text(rSetup, 4).match(/session_id: (sess_[A-Za-z0-9]+)/) || [])[1];
    // unread on a conversation that is NOT mine
    await rpc([init, call(1, 'send_message', { session_id: foreignId, message: 'mail for someone else', from: 'x' })]);
    const rStat = await rpc([init, call(1, 'status', {})]);
    ok(/Nothing for this session to drain|belong to OTHER conversations/.test(text(rStat, 1)) &&
       !/check_inbox surface:chat title_contains:"Someone elses/.test(text(rStat, 1)),
      'status: Next never suggests draining another conversation\'s inbox');
    // unread on MY OWN record → Next scopes the drain to it by title
    await rpc([init, call(1, 'send_message', { session_id: myId, message: 'mail for me', from: 'chat' })]);
    const rStat2 = await rpc([init, call(1, 'status', {})]);
    ok(/check_inbox surface:code title_contains:"My own terminal/.test(text(rStat2, 1)),
      'status: Next DOES suggest draining THIS session\'s own record, scoped by title');
    delete process.env.CLAUDE_CODE_SESSION_ID;
    process.env.HANDOFF_HOME = home0;
  }

  // ---- OPERATING-LESSONS installs ----
  {
    // Lesson 1: reflex first-lines live in the tool descriptions themselves.
    const rL = await rpc([{ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }]);
    const toolsList = (((rL[1] || {}).result || {}).tools) || [];
    const desc = n => (toolsList.find(t => t.name === n) || {}).description || '';
    ok(/^Before asking the user to relay anything between sessions, use this\./.test(desc('send_message')),
      'lesson1: send_message description leads with the relay reflex line');
    ok(/^Before telling the user to open another surface and paste, use this\./.test(desc('send_to')),
      'lesson1: send_to description leads with the paste reflex line');
    ok(/^Before saying you did not receive something, call this\./.test(desc('check_inbox')),
      'lesson1: check_inbox description leads with the did-not-receive reflex line');

    /* DEMOTION (option B, 2026-08-09): ONE public send verb. send_to_surface was always
     * send_to's mode:"new" branch, and publishing both put two spellings of one action in
     * front of the model — a tool-choice trap. Renaming it to send_to_new would have renamed
     * the ambiguity, not removed it, since "new" already lives in send_to's mode parameter. */
    ok(!toolsList.some(t => t.name === 'send_to_surface'),
      'demotion: send_to_surface is no longer advertised — send_to is the only public send verb');
    ok(toolsList.some(t => t.name === 'send_to'),
      'demotion: send_to survives as that one verb');
    ok(!/send_to_surface/.test(desc('send_message')) && !/send_to_surface/.test(desc('pick_up')),
      'demotion: no surviving description points the model at the retired name');
    // The handler is deliberately KEPT: MCP clients cache the tool list per connection, so
    // deleting it would break every conversation open right now until it reconnects.
    const rDep = await rpc([init,
      call(1, 'send_to_surface', { to: 'chat', from: 'code', title: 'Cached caller probe', context: 'still works', open_in: 'none' }),
      call(2, 'send_to', { to: 'chat', from: 'code', title: 'Current caller probe', context: 'via the one verb', open_in: 'none' })
    ]);
    ok(/Handed off: "Cached caller probe"/.test(text(rDep, 1)),
      'demotion: a cached client calling the old name still SUCCEEDS — never failed for holding a stale tool list');
    ok(/\(send_to_surface is retired — use send_to with mode:"new"\. This call worked; reconnect to refresh your tool list\.\)/.test(text(rDep, 1)),
      'demotion: it is told once, in the result, what to call instead — ONE line, no rationale (that lives in the spec)');
    ok(!/ambigu|two names|tool-choice/i.test(text(rDep, 1)),
      'demotion: the note carries no rationale — documentation repeated in every result is documentation in the wrong place');
    ok(/Handed off: "Current caller probe"/.test(text(rDep, 2)) && !/is retired/.test(text(rDep, 2)),
      'demotion: send_to delegating to the same code path carries NO deprecation note');
    /* SELF-EXECUTING SUNSET. The dispatch exists only because live connections cache their
     * tool list; a CONTRACT bump forces every forwarder to respawn with a fresh one, so the
     * window closes by construction rather than by someone remembering to delete it. */
    const t = require('./handoff-tools');
    const contractPath = require.resolve('./handoff-contract');
    const realContract = require('./handoff-contract').CONTRACT;
    require.cache[contractPath].exports = { CONTRACT: realContract + 1 };
    const sunset = await t.callTool('send_to_surface',
      { to: 'chat', from: 'code', title: 'Past sunset', context: 'x', open_in: 'none' },
      { cli_uuid: null }, require('./handoff-core'));
    require.cache[contractPath].exports = { CONTRACT: realContract };
    ok(/no longer exists/.test(sunset) && /mode:"new"/.test(sunset) && /Nothing was sent/.test(sunset),
      'demotion: past the sunset contract the old name REFUSES and sends nothing — the grace expires on its own');

    // Lesson 2: a return contract naming a deliverable without "by value" is refused at send time.
    const rC = await rpc([init,
      call(1, 'send_to_surface', { to: 'chat', from: 'code', title: 'Contract probe A', context: 'x', expected_return: 'deliver the completion report', open_in: 'none' }),
      call(2, 'send_to_surface', { to: 'chat', from: 'code', title: 'Contract probe B', context: 'x', expected_return: 'the completion report, by value, in the return', open_in: 'none' }),
      call(3, 'send_to_surface', { to: 'chat', from: 'code', title: 'Contract probe C', context: 'x', expected_return: 'a yes/no decision on the tagline', open_in: 'none' })
    ]);
    ok(/REFUSED: this return contract asks for a deliverable/.test(text(rC, 1)),
      'lesson2: a contract asking for a report WITHOUT "by value" is refused at send time');
    ok(!/REFUSED/.test(text(rC, 2)),
      'lesson2: the same contract WITH "by value" is accepted');
    ok(!/REFUSED/.test(text(rC, 3)),
      'lesson2: a decision/confirmation contract (no deliverable named) is not refused');
  }

  // ---- chat-side identity: caller-named at send time (asserted provenance) ----
  // A non-terminal surface has no CLI uuid, so it names its OWN protocol-known conversation
  // so read-state (✓✓) can route back. Provenance is ASSERTED, not CLI-verified (I12's half).
  {
    const rSetup = await rpc([init,
      call(1, 'send_to_surface', { to: 'chat', from: 'code', title: 'Review seat convo', context: 'the sender names itself', open_in: 'none' }),
      call(2, 'send_to_surface', { to: 'chat', from: 'code', title: 'CI target convo', context: 'somewhere to send', open_in: 'none' }),
      call(3, 'resolve_conversation', { title_contains: 'CI target convo', surface: 'chat' })
    ]);
    const targetId = (text(rSetup, 3).match(/session_id: (sess_[A-Za-z0-9]+)/) || [])[1];
    // caller-named send: name my own conversation as the sender
    const rCN = await rpc([init, call(1, 'send_message', { session_id: targetId, message: 'From the review seat.', from: 'chat · review', from_title: 'Review seat convo', from_surface: 'chat' })]);
    ok(/ASSERTED provenance/.test(text(rCN, 1)) && /Review seat convo/.test(text(rCN, 1)),
      'chat-identity: a caller-named send routes read-state to the named record, labeled asserted');
    const sdir = path.join(process.env.HANDOFF_HOME, 'store', 'v1', 'sessions');
    const recs = fs.readdirSync(sdir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(sdir, f), 'utf8')));
    const senderRec = recs.find(s => s.title === 'Review seat convo' && s.surface === 'chat');
    const msg = recs.flatMap(s => s.messages || []).find(m => /From the review seat/.test(m.text || ''));
    ok(msg && senderRec && msg.from_session === senderRec.id && msg.sender_class === 'asserted',
      'chat-identity: the delivered message carries from_session = the named record, sender_class asserted');
    // anonymous: no from_title, no identity → honest "no read state" + how to fix it.
    const rAnon = await rpc([init, call(1, 'send_message', { session_id: targetId, message: 'anon send', from: 'chat' })]);
    ok(/no read state can be attributed back/.test(text(rAnon, 1)) && /from_title/.test(text(rAnon, 1)),
      'chat-identity: an unnamed sender is told honestly no ✓✓ can route, and how to fix it');
    // guard: a caller cannot ASSERT a CLI-verified terminal record (has native_ref).
    process.env.CLAUDE_CODE_SESSION_ID = '44444444-dddd-4eee-8fff-000011112222';
    const rReg = await rpc([init, call(1, 'register_session', { title: 'A terminal record' })]);
    const termId = (text(rReg, 1).match(/protocol record (sess_[A-Za-z0-9]+)/) || [])[1];
    delete process.env.CLAUDE_CODE_SESSION_ID;
    const rGuard = await rpc([init, call(1, 'send_message', { session_id: targetId, message: 'impersonation attempt', from_session_id: termId })]);
    ok(/REFUSED sender|cannot be asserted/.test(text(rGuard, 1)),
      'chat-identity: a caller cannot assert a CLI-verified terminal record (native_ref guard)');
  }

  // ---- store v1: concurrent writers must not erase each other ----
  // Measured against the old single-blob store: 12 concurrent writers, 5 survived.
  // Every save() rewrote the whole file, so a process that loaded before another saved
  // silently erased it. With 9+ bridge processes on one store, links could be lost.
  {
    const os2 = require('os');
    const home = path.join(os2.tmpdir(), 'hsmoke-concurrent-' + Date.now());
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, HANDOFF_HOME: home };
    const core = path.join(__dirname, 'handoff-core.js');
    const W = 10;
    await new Promise(resolve => {
      let done = 0;
      for (let i = 1; i <= W; i++) {
        const child = spawn(process.execPath, ['-e',
          `const c=require(${JSON.stringify(core)});(async()=>{await new Promise(r=>setTimeout(r,120));` +
          `await c.handleApi("POST","/api/sessions",{},{surface:"chat",title:"cw${i}"})})()`], { env });
        child.on('close', () => { if (++done === W) resolve(); });
      }
    });
    let titles = [];
    try {
      titles = fs.readdirSync(path.join(home, 'store', 'v1', 'sessions'))
        .filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(home, 'store', 'v1', 'sessions', f), 'utf8')).title);
    } catch (_) {}
    ok(titles.length === W,
      `store v1: ${W} concurrent writers all survive (got ${titles.length}) — no lost updates`);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(home, 'store', 'v1', 'meta.json'), 'utf8')); } catch (_) {}
    ok(meta.schema_version === 1, 'store v1: schema_version is written and readable');
    ok(fs.existsSync(path.join(home, 'store', 'v1', 'events.jsonl')),
      'store v1: append-only events.jsonl records every write');
    fs.rmSync(home, { recursive: true, force: true });
  }

  // Migration from the legacy single-blob store must preserve every record.
  {
    const os2 = require('os');
    const home = path.join(os2.tmpdir(), 'hsmoke-migrate-' + Date.now());
    fs.mkdirSync(home, { recursive: true });
    const legacy = { sessions: {}, links: {}, seq: 3 };
    for (let i = 1; i <= 4; i++) legacy.sessions['sess_old' + i] = { id: 'sess_old' + i, surface: 'code', title: 'legacy ' + i, messages: [], decisions: [], artifacts: [], open_items: [], archived: false };
    legacy.links['link_old1'] = { id: 'link_old1', origin: 'sess_old1', dest: 'sess_old2', status: 'active', created_at: '2026-01-01T00:00:00.000Z' };
    fs.writeFileSync(path.join(home, 'data.json'), JSON.stringify(legacy));
    const out = require('child_process').execFileSync(process.execPath, ['-e',
      `const c=require(${JSON.stringify(path.join(__dirname, 'handoff-core.js'))});` +
      `c.handleApi("GET","/api/state",{},{}).then(r=>console.log(JSON.stringify({s:Object.keys(r.payload.sessions).length,l:Object.keys(r.payload.links).length})))`],
      { env: { ...process.env, HANDOFF_HOME: home } }).toString();
    const got = JSON.parse(out.trim().split('\n').pop());
    ok(got.s === 4 && got.l === 1, `migration preserves every record (4 sessions/1 link, got ${got.s}/${got.l})`);
    ok(fs.existsSync(path.join(home, 'data.json.pre-store-v1')),
      'migration keeps the legacy blob as data.json.pre-store-v1 — never destroys it');
    const before = fs.readdirSync(path.join(home, 'store', 'v1', 'sessions')).length;
    require('child_process').execFileSync(process.execPath, ['-e',
      `const c=require(${JSON.stringify(path.join(__dirname, 'handoff-core.js'))});c.handleApi("GET","/api/state",{},{})`],
      { env: { ...process.env, HANDOFF_HOME: home } });
    ok(fs.readdirSync(path.join(home, 'store', 'v1', 'sessions')).length === before,
      'migration is idempotent — a second run does not duplicate or re-migrate');
    fs.rmSync(home, { recursive: true, force: true });
  }

  // ---- 3b-6: the BRIDGE applies ctx_update to its own PINNED, over real stdio ----
  // The daemon side of the write-back is covered in daemon-smoke. This is the other end:
  // the bridge now sets PINNED only from a migrated tool's ctx_update, in one place. All
  // four calls share ONE bridge process, so the pin genuinely has to survive between them.
  {
    const r = await rpc([init,
      call(1, 'send_to_surface', { to: 'chat', from: 'code', title: 'Smoke: bridge pin round-trip', context: 'Work handed to chat so it can be picked back up and closed from here.', expected_return: 'Return the finished note by value, in the return.' }),
      call(2, 'pick_up', { surface: 'chat', title_contains: 'bridge pin round-trip' }),
      // unnamed + pin-dependent: only succeeds if pick_up's ctx_update reached PINNED
      call(3, 'get_handoff', {}),
      // unnamed close: resolves through the same pin, then must CLEAR it
      call(4, 'return_to_origin', { summary: 'Note finished; full text carried by value.', artifacts: [{ name: 'note.md', content: 'the finished note' }] }),
      // unnamed again: with the pin cleared there is nothing open, so it must refuse
      call(5, 'return_to_origin', { summary: 'second close attempt' }),
    ]);
    ok(/Picked up "Smoke: bridge pin round-trip"/.test(text(r, 2)),
      '3b-6 bridge: pick_up (now delegated) still returns the brief over real stdio');
    ok(/bridge pin round-trip/.test(text(r, 3)) && !/not pinned|refusing to guess/.test(text(r, 3)),
      '3b-6 bridge: an unnamed get_handoff resolves — pick_up\'s ctx_update reached the bridge\'s PINNED');
    ok(/closed as DONE/.test(text(r, 4)),
      '3b-6 bridge: an unnamed return_to_origin closes the pinned transaction, no target named');
    ok(/Nothing closed|NOT closing by guessing/.test(text(r, 5)),
      '3b-6 bridge: the close CLEARED the pin — a second unnamed close refuses instead of hitting a settled record');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('runner error:', e.message); process.exit(1); });
