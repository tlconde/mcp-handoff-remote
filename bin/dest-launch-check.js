#!/usr/bin/env node
'use strict';
/**
 * DEST LAUNCH CHECK — enrolled chat is origin; dest is a capability pick, not Claude-only.
 *
 * Against a scratch store (never the operator's):
 *   1. Door B grok-app send_to_worker without origin_session_id is REFUSED (no shadow carrier).
 *   2. register_chat_session then send_to_worker with that id uses THIS chat as origin.
 *   3. dest:"codex" when both are present (test seam) sets native_ref.kind to codex.
 *   4. dest omitted when both present is REFUSED as ambiguous.
 *   5. dest omitted when only one is present defaults to that one.
 *   6. A dest that never launched is not duplicate_in_flight; a launched dest with the same fp is.
 *   6b. A different task still dispatches even if a return-owed non-code dest exists from this origin.
 *   6c. A code dest with no worker_task_fp is not a duplicate of any task.
 *   7. origin.project_state.project_id binds cwd when dir is omitted, and the result names it.
 *   8. worker_id reused as session_id is refused (origin is the enrolled chat).
 *   9. omitted dir and missing project_id prints the home cwd fallback.
 *  10. worker spawn ignores stdin and drains stderr (Codex exec hang class) without a live Codex.
 *  11. stderr progress is NOT concatenated into the stdout auto-summary sink.
 *  12. Claude headless prompt keeps MCP close; Codex/Gemini read HANDOFF.md and print stdout.
 *  13. get_worker_result without worker_id refuses when several workers are in flight.
 *  14. A single in-flight worker may omit worker_id.
 *  15. Codex spawn uses --json (not --session-id); harvest thread.started; resume is that id, not --last.
 *  16. Codex HANDOFF.md On completion is stdout-summary, not MCP/return_to_origin.
 *
 *   node bin/dest-launch-check.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dest-launch-check-'));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dest-launch-ws-'));
process.env.HANDOFF_HOME = tmp;
process.env.HANDOFF_TEST = '1';
process.env.HANDOFF_NO_CLI = '1';
process.env.HANDOFF_NO_AUTORECEIPT = '1';
process.env.HANDOFF_NO_AUTOOPEN = '1';
process.env.HANDOFF_DEST_PRESENT = 'claude-code,codex';
process.env.HANDOFF_WORKER_DEDUP_MS = '60000';

const core = require('../handoff-core');
const { callTool } = require('../handoff-tools');

function fail(msg) {
  console.error('dest-launch-check: FAIL — ' + msg);
  process.exit(1);
}

(async () => {
  const ctx = { remote: true, surface_class: 'grok-app', account_sub: 'sandbox-account' };

  const refused = String(await callTool('send_to_worker', { task: 'write a marker' }, ctx, core));
  if (!/^REFUSED:/.test(refused) || !/origin_session_id/.test(refused) || /Worker dispatched/.test(refused)) {
    fail('Door B send_to_worker without origin_session_id must refuse and mint nothing\n' + refused);
  }
  const st0 = (await core.handleApi('GET', '/api/state', {}, {})).payload;
  if (Object.keys(st0.sessions || {}).length) {
    fail('refused Door B dispatch must not mint a shadow origin, got ' + Object.keys(st0.sessions).join(','));
  }

  const reg = String(await callTool('register_chat_session', {
    surface: 'chat', title: 'Chad', nickname: 'Chad',
    subscription: 'grok', model_slug: 'grok-4.6',
  }, ctx, core));
  const m = /session_id:\s*(sess_chat_\S+)/.exec(reg);
  if (!m) fail('register did not return a sess_chat_ session_id\n' + reg);
  const originId = m[1];

  const ambi = String(await callTool('send_to_worker', {
    task: 'ship the dest picker', origin_session_id: originId,
  }, ctx, core));
  if (!/^REFUSED:/.test(ambi) || !/several agent CLIs/.test(ambi) || !/Codex/.test(ambi)) {
    fail('both CLIs present and no dest name must refuse, listing them\n' + ambi);
  }

  const dispatched = String(await callTool('send_to_worker', {
    task: 'ship the dest picker',
    origin_session_id: originId,
    dest: 'codex',
    context: 'enrolled grok.com chat is origin',
    project_state: { project_id: ws },
  }, ctx, core));
  if (!/Worker dispatched/.test(dispatched)) fail('named Codex must dispatch\n' + dispatched);
  if (!/no shadow carrier/.test(dispatched)) fail('enrolled origin must say no shadow carrier\n' + dispatched);
  if (!/Codex/.test(dispatched)) fail('result must name Codex\n' + dispatched);
  const wid = /worker_id:\s*(\S+)/.exec(dispatched);
  if (!wid) fail('dispatch must print worker_id\n' + dispatched);

  const st = (await core.handleApi('GET', '/api/state', {}, {})).payload;
  if (!st.sessions[originId] || st.sessions[originId].archived) {
    fail('enrolled chat must remain the live origin');
  }
  const extras = Object.values(st.sessions).filter(s => s.surface !== 'code' && s.id !== originId && !s.archived);
  if (extras.length) {
    fail('must not mint a shadow chat origin, extra records: ' + extras.map(s => s.id + ':' + s.title).join(','));
  }
  const worker = st.sessions[wid[1]];
  if (!worker) fail('worker record missing');
  if (!worker.native_ref || worker.native_ref.kind !== 'codex') {
    fail('dest native_ref.kind must be codex, got ' + JSON.stringify(worker.native_ref));
  }
  if (/--last/.test(String(worker.native_ref.resume || '')) || /--last/.test(dispatched)) {
    fail('must not print codex exec resume --last as if it addressed this worker\n' + dispatched);
  }
  if (worker.native_ref.session_id && worker.native_ref.resume !== 'codex exec resume ' + worker.native_ref.session_id) {
    fail('Codex resume must use the harvested session id, got ' + worker.native_ref.resume);
  }
  if (worker.worker_launched === true) {
    fail('HANDOFF_NO_CLI dest must not be marked launched');
  }
  const brief = fs.readFileSync(path.join(ws, 'HANDOFF.md'), 'utf8');
  if (/return_to_origin|handoff MCP|mcp__handoff/.test(brief)) {
    fail('Codex HANDOFF.md On completion must not chase MCP tools\n' + brief.slice(-500));
  }
  if (!/stdout/.test(brief)) {
    fail('Codex HANDOFF.md must tell the dest to print a summary on stdout\n' + brief.slice(-400));
  }
  if (worker.native_ref.cwd !== ws) {
    fail('workspace bind: native_ref.cwd must be origin project_id when dir omitted, got ' + worker.native_ref.cwd);
  }
  if (!dispatched.includes(ws) || !/bound from project_id/.test(dispatched)) {
    fail('send_to_worker result must print the bound workspace and that it came from project_id\n' + dispatched);
  }
  const link = Object.values(st.links || {}).find(l => l.origin === originId && l.dest === worker.id && l.status === 'active');
  if (!link) fail('return link must be open from the enrolled chat to the worker');

  const nested = String(await callTool('send_to_worker', {
    task: 'nested dest must not use the worker as origin',
    session_id: wid[1],
    dest: 'codex',
  }, ctx, core));
  if (!/^REFUSED:/.test(nested) || !/not a code worker/.test(nested) || /Worker dispatched/.test(nested)) {
    fail('worker_id reused as session_id must refuse — origin is the enrolled chat, not a code dest\n' + nested);
  }
  const stNested = (await core.handleApi('GET', '/api/state', {}, {})).payload;
  const extraCode = Object.values(stNested.sessions || {}).filter(s => s.surface === 'code' && s.id !== worker.id && !s.archived);
  if (extraCode.length) {
    fail('refused nested origin must not mint another dest, extra code records: ' + extraCode.map(s => s.id).join(','));
  }

  const retryUnlaunched = String(await callTool('send_to_worker', {
    task: 'ship the dest picker', origin_session_id: originId, dest: 'codex',
  }, ctx, core));
  if (!/Worker dispatched/.test(retryUnlaunched) || /Duplicate in-flight/.test(retryUnlaunched)) {
    fail('a dest that never launched must not count as duplicate_in_flight\n' + retryUnlaunched);
  }
  const stLaunch = (await core.handleApi('GET', '/api/state', {}, {})).payload;
  const launchedRec = JSON.parse(JSON.stringify(stLaunch.sessions[wid[1]]));
  launchedRec.worker_launched = true;
  core.__writeRecordForTests('sessions', launchedRec.id, launchedRec);
  const dup = String(await callTool('send_to_worker', {
    task: 'ship the dest picker', origin_session_id: originId, dest: 'codex',
  }, ctx, core));
  if (!/Duplicate in-flight/.test(dup) || dup.indexOf(wid[1]) < 0) {
    fail('second identical dispatch after a real start must hit the duplicate guard and name the existing worker\n' + dup);
  }

  const side = await core.handleApi('POST', `/api/sessions/${originId}/continue`, {}, { to: 'chat', return_leg: true });
  if (side.code >= 400 || !side.payload || !side.payload.dest) {
    fail('continue chat dest for duplicate-guard fixture failed: ' + JSON.stringify(side.payload));
  }
  const chatDestId = side.payload.dest.id;
  const otherTask = String(await callTool('send_to_worker', {
    task: 'a different task so it is not a duplicate',
    origin_session_id: originId,
    dest: 'codex',
  }, ctx, core));
  if (!/Worker dispatched/.test(otherTask) || /Duplicate in-flight/.test(otherTask)) {
    fail('a different task must dispatch even when a return-owed chat dest exists from this origin\n' + otherTask);
  }
  if (otherTask.indexOf(chatDestId) >= 0) {
    fail('duplicate guard must not point at a non-code dest\n' + otherTask);
  }

  const stFp = (await core.handleApi('GET', '/api/state', {}, {})).payload;
  const workerRec = stFp.sessions[wid[1]];
  if (!workerRec) fail('worker record missing before fingerprint-strip test');
  const stripped = JSON.parse(JSON.stringify(workerRec));
  delete stripped.worker_task_fp;
  core.__writeRecordForTests('sessions', workerRec.id, stripped);
  const afterStrip = String(await callTool('send_to_worker', {
    task: 'ship the dest picker', origin_session_id: originId, dest: 'codex',
  }, ctx, core));
  if (!/Worker dispatched/.test(afterStrip) || /Duplicate in-flight/.test(afterStrip)) {
    fail('a code dest with no worker_task_fp must not count as duplicate_in_flight\n' + afterStrip);
  }

  process.env.HANDOFF_DEST_PRESENT = 'claude-code';
  const def = String(await callTool('send_to_worker', {
    task: 'a different task so it is not a duplicate',
    origin_session_id: originId,
  }, ctx, core));
  if (!/Worker dispatched/.test(def) || !/Claude Code/.test(def) || !/the one present/.test(def)) {
    fail('one CLI present and no name must default to that CLI\n' + def);
  }

  const reg2 = String(await callTool('register_chat_session', {
    surface: 'chat', title: 'Lane', nickname: 'Lane',
    subscription: 'grok', model_slug: 'grok-4.6',
  }, ctx, core));
  const m2 = /session_id:\s*(sess_chat_\S+)/.exec(reg2);
  if (!m2) fail('second register did not return a sess_chat_ session_id\n' + reg2);
  const fallback = String(await callTool('send_to_worker', {
    task: 'no dir and no project_id',
    origin_session_id: m2[1],
    dest: 'claude-code',
  }, ctx, core));
  if (!/Worker dispatched/.test(fallback) || !/home cwd fallback/.test(fallback)) {
    fail('omitted dir and missing project_id must print the cwd fallback so a missed bind cannot hide\n' + fallback);
  }

  const many = String(await callTool('get_worker_result', { origin_session_id: originId }, ctx, core));
  if (!/^REFUSED:/.test(many) || !/pass worker_id/.test(many) || !/will not pick the last one/.test(many)) {
    fail('get_worker_result without worker_id and several in-flight workers must refuse, listing ids\n' + many);
  }
  if (many.indexOf(wid[1]) < 0) {
    fail('ambiguous get_worker_result must list the in-flight worker ids\n' + many);
  }
  const named = String(await callTool('get_worker_result', { worker_id: wid[1] }, ctx, core));
  if (/^REFUSED:/.test(named) || named.indexOf(wid[1]) < 0) {
    fail('get_worker_result with worker_id must address that worker\n' + named);
  }
  const one = String(await callTool('get_worker_result', { origin_session_id: m2[1] }, ctx, core));
  if (/^REFUSED:/.test(one) || /will not pick the last one/.test(one)) {
    fail('a single in-flight worker may omit worker_id\n' + one);
  }
  if (!/still working|ORPHANED|Worker /.test(one)) {
    fail('single in-flight omit worker_id must report that worker, got\n' + one);
  }

  const dests = require('../handoff-dest-runtimes');
  const { spawn } = require('child_process');
  if (dests.WORKER_STDIO[0] !== 'ignore' || dests.WORKER_STDIO[1] !== 'pipe' || dests.WORKER_STDIO[2] !== 'pipe') {
    fail('worker stdio must ignore stdin and pipe stdout+stderr, got ' + JSON.stringify(dests.WORKER_STDIO));
  }
  const plan = dests.spawnArgv({ spawnKind: 'codex', binPath: 'codex' }, { nativeId: 'uuid-this-worker', prompt: 'x' });
  if (!plan || plan.args.indexOf('--json') < 0) {
    fail('Codex spawn argv must pass --json so thread.started can be harvested, got ' + JSON.stringify(plan && plan.args));
  }
  if (plan.args.indexOf('--session-id') >= 0) {
    fail('Codex spawn must not pass --session-id (clap rejects it), got ' + JSON.stringify(plan.args));
  }
  if (plan.args.indexOf('--last') >= 0) fail('Codex spawn argv must not use --last');
  const pendingRef = dests.nativeRefFor({ id: 'codex' }, null, '/tmp/ws');
  if (pendingRef.resume || pendingRef.session_id) {
    fail('Codex native_ref must not invent a session id or resume command before harvest, got ' + JSON.stringify(pendingRef));
  }
  if (/--last/.test(String(pendingRef.resume || ''))) fail('Codex resume must never be --last');
  const harvestedRef = dests.nativeRefFor({ id: 'codex' }, '0199a213-81c0-7800-8aa1-bbab2a035a53', '/tmp/ws');
  if (harvestedRef.resume !== 'codex exec resume 0199a213-81c0-7800-8aa1-bbab2a035a53') {
    fail('harvested Codex resume must target that thread id, got ' + harvestedRef.resume);
  }
  const claudePrompt = dests.workerHeadlessPrompt({
    runtime: dests.CATALOG.find(r => r.id === 'claude-code'),
    sessionId: 'sess_code_test',
    viaMcp: true,
  });
  if (!/get_handoff/.test(claudePrompt) || !/return_to_origin/.test(claudePrompt) || !/mcp__handoff__/.test(claudePrompt)) {
    fail('Claude headless prompt must keep the MCP close chain\n' + claudePrompt);
  }
  const codexPrompt = dests.workerHeadlessPrompt({
    runtime: dests.CATALOG.find(r => r.id === 'codex'),
    sessionId: 'sess_code_test',
    viaMcp: false,
  });
  if (!/HANDOFF\.md/.test(codexPrompt) || !/stdout/.test(codexPrompt)) {
    fail('Codex prompt must say read HANDOFF.md and print a summary on stdout\n' + codexPrompt);
  }
  if (/mcp__handoff|return_to_origin|get_handoff|CLAUDE_CODE_SESSION_ID/.test(codexPrompt)) {
    fail('Codex prompt must not mention Claude MCP close tools\n' + codexPrompt);
  }
  const geminiPrompt = dests.workerHeadlessPrompt({ runtime: dests.CATALOG.find(r => r.id === 'gemini') });
  if (!/HANDOFF\.md/.test(geminiPrompt) || /mcp__handoff|return_to_origin|get_handoff/.test(geminiPrompt)) {
    fail('Gemini prompt must be the non-Claude HANDOFF.md path, not MCP\n' + geminiPrompt);
  }
  const fake = path.join(tmp, 'fake-codex-exec.js');
  fs.writeFileSync(fake, [
    "'use strict';",
    "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-real' }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'did the work' } }) + '\\n');",
    "let got = false;",
    "process.stderr.write('progress-1\\n'.repeat(4000));",
    "process.stdin.on('data', () => { got = true; });",
    "const done = (msg, code) => { process.stdout.write(msg + '\\n'); process.exit(code); };",
    "if (process.stdin.readableEnded) done('STDIN_EOF', 0);",
    "const t = setTimeout(() => done(got ? 'STDIN_DATA' : 'STDIN_HUNG', 2), 1500);",
    "process.stdin.on('end', () => { clearTimeout(t); done('STDIN_EOF', 0); });",
    "process.stdin.resume();",
    '',
  ].join('\n'));
  const child = spawn(process.execPath, [fake], dests.workerSpawnOpts({ cwd: tmp }));
  const sink = { out: '', err: '' };
  dests.consumeWorkerPipes(child, sink);
  const started = await dests.waitChildStarted(child);
  if (!started.started) fail('fixture spawn must start: ' + ((started.error && started.error.message) || 'unknown'));
  const harvested = await dests.waitForCodexSession(child, sink, 2000);
  if (harvested.sessionId !== 'codex-thread-real') {
    fail('must harvest Codex thread_id from --json thread.started, got ' + JSON.stringify(harvested));
  }
  const code = await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      try { child.kill(); } catch (_) { /* already gone */ }
      reject(new Error('fixture hung — stdin was left open or stderr was unread; out=' + sink.out.slice(0, 200)));
    }, 4000);
    child.on('close', c => { clearTimeout(t); resolve(c); });
  });
  if (code !== 0 || !/STDIN_EOF/.test(sink.out)) {
    fail('Codex-shaped spawn must see stdin EOF and drain stderr, exit ' + code + ' out=' + sink.out.slice(0, 300));
  }
  if (dests.harvestCodexSummary((sink.head || '') + '\n' + (sink.out || '')) !== 'did the work') {
    fail('must harvest Codex agent_message for the auto summary, got ' + dests.harvestCodexSummary((sink.head || '') + '\n' + (sink.out || '')));
  }
  if (/progress-1/.test(sink.out)) {
    fail('stderr progress must not land in the stdout auto-summary sink, out=' + sink.out.slice(0, 300));
  }
  if (!/progress-1/.test(sink.err)) {
    fail('stderr must still be drained into the discarded err buffer');
  }
  const dead = spawn(process.execPath, ['-e', 'process.exit(2)'], dests.workerSpawnOpts({ cwd: tmp }));
  const deadSink = { out: '', err: '' };
  dests.consumeWorkerPipes(dead, deadSink);
  const deadStarted = await dests.waitChildStarted(dead);
  if (!deadStarted.started) fail('immediate-exit fixture must still spawn');
  const deadHarvest = await dests.waitForCodexSession(dead, deadSink, 2000);
  if (deadHarvest.sessionId || !deadHarvest.exited) {
    fail('Codex that dies before thread.started must not report a session id, got ' + JSON.stringify(deadHarvest));
  }
  const missing = spawn(path.join(tmp, 'no-such-codex-bin'), ['exec'], dests.workerSpawnOpts({ cwd: tmp }));
  dests.consumeWorkerPipes(missing, { out: '', err: '' });
  const missed = await dests.waitChildStarted(missing);
  if (missed.started) fail('ENOENT spawn must not report started/launched:true');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* scratch */ }
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) { /* scratch */ }
  console.log('dest-launch-check: OK — enrolled origin, dest probe/name/default, workspace bind, duplicate guard, spawn stdio, dest prompt.');
})().catch(e => {
  console.error('dest-launch-check: threw — ' + (e && e.stack || e));
  process.exit(2);
});
