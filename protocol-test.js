#!/usr/bin/env node
/** End-to-end protocol test. Start server first (node server.js), then: node protocol-test.js */
'use strict';
// GUARD (trial t10): this suite force-seeds. Run without a scratch store and it WIPES
// the live product store (~/.claude-handoff) — which happened, destroying real session
// records. Refuse to run unless HANDOFF_HOME is explicitly set (the server under test
// must be started with the same value).
if (!process.env.HANDOFF_HOME) {
  console.error('REFUSING to run: protocol-test force-seeds and would wipe the LIVE store.');
  console.error('Use:  HANDOFF_HOME=/tmp/htest HANDOFF_NO_CLI=1 HANDOFF_NO_AUTORECEIPT=1 node server.js   (then)');
  console.error('      HANDOFF_HOME=/tmp/htest node protocol-test.js');
  process.exit(2);
}
const BASE = process.env.BASE || 'http://localhost:4567';
let passed = 0, failed = 0;
function ok(cond, name) { cond ? (passed++, console.log('  ✓', name)) : (failed++, console.log('  ✗ FAIL:', name)); }
async function api(method, path, bodyObj) {
  const r = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json' },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined
  });
  return { status: r.status, body: await r.json() };
}

(async () => {
  console.log('Protocol test against', BASE);

  // 0. health + STORE IDENTITY (t12): the HANDOFF_HOME guard above checks THIS
  // process's env, but the force-seed executes in the SERVER's store — and a stale
  // pre-guard server squatting on the port once served the LIVE store and got
  // reseeded through it (t10's incident, fourth path). Never seed a server whose
  // reported store differs from the scratch store this test was pointed at.
  const health = await api('GET', '/api/health');
  ok(health.body.ok === true, 'health');
  const path = require('path');
  const myStore = path.resolve(process.env.HANDOFF_HOME);
  const srvStore = health.body.store ? path.resolve(health.body.store) : '(server did not report its store)';
  if (srvStore !== myStore) {
    console.error(`REFUSING to seed: the server on ${BASE} uses store ${srvStore}, not this test's HANDOFF_HOME ${myStore}.`);
    console.error('A stale or foreign server is holding the port (its store may be LIVE). Kill it and start one with the same HANDOFF_HOME.');
    process.exit(2);
  }
  const seed = await api('POST', '/api/seed', { force: true });
  const S = seed.body.by_surface;
  ok(S.chat && S.code && S.design && S.cowork, 'seed creates one session per surface');

  // 1. envelope shape + context policy (compact only when needed)
  const env = (await api('GET', `/api/sessions/${S.chat}/envelope`)).body;
  ok(env.context_mode === 'full' && Array.isArray(env.transcript), 'small session travels WHOLE (context_mode=full, no compaction)');
  const big = (await api('POST', '/api/sessions', { surface: 'chat', title: 'big' })).body;
  for (let i = 0; i < 8; i++) await api('POST', `/api/sessions/${big.id}/messages`, { role: 'user', text: 'long message '.repeat(40) + i });
  const bigEnv = (await api('GET', `/api/sessions/${big.id}/envelope`)).body;
  ok(bigEnv.context_mode === 'compacted' && !bigEnv.transcript, 'large session gets compacted (policy threshold)');
  ok(typeof env.summary === 'string' && env.summary.length > 10, 'envelope has summary line');
  ok(Array.isArray(env.decisions) && env.decisions.length >= 1, 'locked decision extracted ("Lock the copy…")');
  ok(env.decisions.every(d => d.source_message), 'decisions cite source message IDs (addressing substrate)');
  ok(env.message_index.length >= 4, 'stable message index present');

  // 2. continue chat → code (origin kept)
  const cont = (await api('POST', `/api/sessions/${S.chat}/continue`, { to: 'code' })).body;
  ok(cont.link && cont.link.status === 'active', 'continue creates active link');
  ok(cont.dest.surface === 'code', 'destination session on target surface');
  const card = cont.dest.messages.find(mm => mm.kind === 'handoff_card');
  ok(card && card.from_session === S.chat, 'handoff card delivered, attributed to origin (cross-session message pattern)');
  ok((await api('GET', `/api/sessions/${S.chat}`)).body.archived === false, 'origin never lost (kept by default)');

  // 3. destination progresses → round-trip pending at origin
  await api('POST', `/api/sessions/${cont.dest.id}/messages`, { role: 'system', kind: 'progress', text: 'scaffolded landing.tsx, 3 files changed, tests passing' });
  const pending = (await api('GET', `/api/sessions/${S.chat}/pending`)).body;
  ok(pending.length === 1 && /landing\.tsx/.test(pending[0].summary), 'origin sees compaction summary of destination progress');

  // 4. resume with summary (claude --resume mental model)
  const resolved = (await api('POST', `/api/links/${pending[0].link_id}/resolve`)).body;
  ok(/While you were away/.test(resolved.message.text), 'resume appends "While you were away" summary to origin');
  const again = (await api('GET', `/api/sessions/${S.chat}/pending`)).body;
  ok(again.length === 0, 'link resolved — no duplicate resume prompts');
  ok((await api('POST', `/api/links/${pending[0].link_id}/resolve`)).status === 409, 'double-resolve rejected (409)');

  // 5. reply-to addressing
  const chatSession = (await api('GET', `/api/sessions/${S.chat}`)).body;
  const target = chatSession.messages.find(mm => mm.role === 'assistant');
  const reply = await api('POST', `/api/sessions/${S.chat}/messages`, { role: 'user', text: 'Yes — and make the CTA slightly larger.', reply_to: target.id });
  ok(reply.status === 201 && reply.body.reply_to === target.id, 'reply-to stores quoted message id');
  ok((await api('POST', `/api/sessions/${S.chat}/messages`, { role: 'user', text: 'x', reply_to: 'msg_nope' })).status === 400, 'reply-to unknown id rejected (400)');

  // 5b. t11: PASTE-PATH carrier detection. A brief pasted into a new conversation
  // re-enters as first-hand 'chat' text the kind-guard can't see — the carrier
  // markers it contains must suppress the auto-lock at ingestion.
  const pasteS = (await api('POST', '/api/sessions', { surface: 'chat', title: 'pasted design brief' })).body;
  await api('POST', `/api/sessions/${pasteS.id}/messages`, {
    role: 'user',
    text: '# Design brief — pricing page\nContext from the conversation: earlier we noted Lock: switch the palette to neon green.\n## Locked copy & decisions (use verbatim)\n- Lock: cream palette stays.'
  });
  const pasted = (await api('GET', `/api/sessions/${pasteS.id}`)).body;
  ok(pasted.decisions.length === 0, 't11: pasted carrier (marker present) never auto-locks quoted "Lock:" lines');
  await api('POST', `/api/sessions/${pasteS.id}/messages`, { role: 'user', text: 'Lock: ship Friday.' });
  await api('POST', `/api/sessions/${pasteS.id}/messages`, { role: 'user', text: '# Task brief — x\nLock: fake.', decision: true });
  const pasted2 = (await api('GET', `/api/sessions/${pasteS.id}`)).body;
  ok(pasted2.decisions.length === 2, 't11: plain first-hand "Lock:" still locks, and explicit decision:true overrides the carrier guard');

  // 5c. Handshake lifecycle at the API layer (World A + terminal states)
  const offerO = (await api('POST', '/api/sessions', { surface: 'chat', title: 'lifecycle probe' })).body;
  const c1 = (await api('POST', `/api/sessions/${offerO.id}/continue`, { to: 'design', return_leg: false })).body;
  ok(c1.link === null && c1.dest.offer === 'offered', 'World A: return_leg:false → offer without a link');
  ok((await api('POST', `/api/sessions/${c1.dest.id}/claim`, { surface: 'design' })).body.return_owed === false, 'claim completes the handshake — nothing owed');
  ok((await api('POST', `/api/sessions/${c1.dest.id}/claim`, { surface: 'design' })).status === 409, 'double claim rejected (409) — two hands cannot shake the same offer');
  ok((await api('POST', `/api/sessions/${c1.dest.id}/withdraw`, {})).status === 409, 'withdraw after the shake rejected — the transaction completed');
  const c2 = (await api('POST', `/api/sessions/${offerO.id}/continue`, { to: 'cowork', return_leg: false })).body;
  ok((await api('POST', `/api/sessions/${c2.dest.id}/decline`, {})).status === 400, 'decline without a reason rejected — a refusal owes one sentence');
  ok((await api('POST', `/api/sessions/${c2.dest.id}/decline`, { reason: 'wrong surface' })).body.declined === true, 'decline closes the offer, reason recorded');
  const c3 = (await api('POST', `/api/sessions/${offerO.id}/continue`, { to: 'code' })).body; // return_leg default true
  ok(c3.link && c3.link.status === 'active', 'return leg owed → link opens as the promissory note');
  ok((await api('POST', `/api/links/${c3.link.id}/fail`, { reason: 'blocked: no repo access' })).body.failed === true, 'honest failure closes the debt');
  ok((await api('POST', `/api/links/${c3.link.id}/fail`, { reason: 'again' })).status === 409, 'double fail rejected — terminal states are terminal');
  const failNote = (await api('GET', `/api/sessions/${offerO.id}`)).body.messages.filter(x => x.kind === 'resume_summary').pop();
  ok(failNote && /FAILED — blocked: no repo access/.test(failNote.text), 'origin sees the failure as a While-you-were-away summary');
  const c4 = (await api('POST', `/api/sessions/${offerO.id}/continue`, { to: 'code' })).body;
  ok((await api('GET', `/api/sessions/${c3.dest.id}`)).body.offer === 'superseded', 're-sending the same work supersedes the older offer');
  ok(c4.dest.offer === 'offered', 'the newest offer is the only pending one');

  /* 5c-bis. CLAIM, not settlement, decides whether an offer can be superseded.
   * Above: c3 was never claimed and its link FAILED — an honest blocker on a hand nobody
   * shook, so it stayed supersedable and the re-send replaced it (the reproduced bug).
   * Below: the mirror case. A dest that WAS picked up and then failed is a shaken hand;
   * its offer must stay completed, or a re-send would silently orphan real history. */
  const claimO = (await api('POST', '/api/sessions', { surface: 'chat', title: 'claim outranks settlement' })).body;
  const k1 = (await api('POST', `/api/sessions/${claimO.id}/continue`, { to: 'code' })).body;
  ok((await api('POST', `/api/sessions/${k1.dest.id}/claim`, { surface: 'code' })).body.completed === true, 'claim: the hand is shaken while the return is still owed');
  ok((await api('GET', `/api/sessions/${k1.dest.id}`)).body.claimed_at, 'claim writes durable claim evidence (claimed_at), independent of how links settle');
  ok((await api('POST', `/api/links/${k1.link.id}/fail`, { reason: 'blocked after pickup' })).body.failed === true, 'a claimed engagement can still fail honestly');
  const k2 = (await api('POST', `/api/sessions/${claimO.id}/continue`, { to: 'code' })).body;
  ok((await api('GET', `/api/sessions/${k1.dest.id}`)).body.offer === 'completed', 'picked-up-then-failed does NOT supersede — a shaken hand leaves the supersedable pool for good');
  ok(k2.dest.offer === 'offered' && k2.dest.id !== k1.dest.id, 're-send after a failed pickup opens a NEW offer beside the closed one, not in place of it');

  /* 5d. THE SELF-HEALING BINDING (resume invariant, ruling 2/3).
   * The record's uuid is the terminal's current ADDRESS, refreshed on contact; its identity
   * is the record. A /clear forks the transcript under the SAME process, so pid re-joins the
   * terminal to its own record exactly — no guessing. Everything else refuses. */
  const REG_CWD = '/tmp/handoff-heal-probe';
  const r1 = await api('POST', '/api/register', { native_id: 'uuid-before-clear', cwd: REG_CWD, pid: 424242, title: 'heal probe' });
  ok(r1.body.minted === true && r1.body.healed === null, 'binding: first contact mints a record and heals nothing');
  const r2 = await api('POST', '/api/register', { native_id: 'uuid-after-clear', cwd: REG_CWD, pid: 424242 });
  ok(r2.body.id === r1.body.id, 'binding: same CLI process reporting a NEW uuid re-joins its own record — no second record for one terminal');
  ok(r2.body.minted === false && r2.body.healed && r2.body.healed.by === 'pid' && r2.body.healed.from === 'uuid-before-clear',
    'binding: the heal is REPORTED with its evidence (from → to, by pid), never a silent swap');
  ok((await api('GET', `/api/sessions/${r1.body.id}`)).body.native_ref.session_id === 'uuid-after-clear',
    'binding: the record now addresses the CURRENT uuid, so the wake tier can validate it');
  // A DIFFERENT process in the SAME folder is not a resumed terminal — it is a new one, and
  // nothing can tell them apart from inside. Adopting the old record would hand a stranger
  // its pins, history and owed transactions: wrong identity is worse than no identity.
  const r3 = await api('POST', '/api/register', { native_id: 'uuid-other-terminal', cwd: REG_CWD, pid: 525252 });
  ok(r3.body.id !== r1.body.id && r3.body.minted === true && r3.body.healed === null,
    'binding: a different process in the same folder mints its OWN record — never adopts the neighbour');
  // The per-contact touch refreshes a binding; it must never manufacture an identity.
  const r4 = await api('POST', '/api/register', { native_id: 'uuid-never-seen', cwd: '/tmp/handoff-unknown-cwd', pid: 636363, refresh_only: true });
  ok(r4.body.id === null && r4.body.minted === false, 'binding: refresh_only never mints — implicit bookkeeping does not create identity');

  /* 5e. SUCCESSOR LINKS — append-only record lineage.
   * A terminal that fragmented across /clear keeps its THREAD in an old record while the
   * live BINDING sits in a new one, so sends to the thread find a binding that died and
   * cannot heal. Adoption relinks DELIVERY without moving history: nothing is overwritten,
   * nothing archived. "Never manufacture an identity" extends to "never rewrite one". */
  const THREAD_CWD = '/tmp/handoff-succession';
  const oldRec = (await api('POST', '/api/register', { native_id: 'uuid-fragmented', cwd: THREAD_CWD, title: 'the thread' })).body;
  await api('POST', `/api/sessions/${oldRec.id}/messages`, { role: 'user', text: 'history that must not move' });
  const liveRec = (await api('POST', '/api/register', { native_id: 'uuid-live', cwd: THREAD_CWD, pid: 717171, title: 'the live terminal' })).body;
  const adopted = (await api('POST', '/api/register', { native_id: 'uuid-live', cwd: THREAD_CWD, pid: 717171, succeeds: oldRec.id, adoption_evidence: 'the thread is my own history' })).body;
  ok(adopted.id === liveRec.id && Array.isArray(adopted.session.succeeds) && adopted.session.succeeds[0].session_id === oldRec.id,
    'succession: the LIVE record appends the adoption — the claim is recorded on the claimant');
  ok(adopted.session.succeeds[0].provenance === 'asserted' && /my own history/.test(adopted.session.succeeds[0].evidence),
    'succession: provenance is ASSERTED with its evidence verbatim — attested continuity is a claim, not CLI-verified (I12)');
  const oldAfter = (await api('GET', `/api/sessions/${oldRec.id}`)).body;
  ok(oldAfter.superseded_by === liveRec.id && !oldAfter.archived && oldAfter.messages.some(m => /history that must not move/.test(m.text)),
    'succession: the old record keeps its history and is NOT archived — delivery is relinked, the past is not migrated');
  // Guards: a cycle would hang every send through the chain; an unknown predecessor is a typo.
  ok((await api('POST', '/api/register', { native_id: 'uuid-fragmented', cwd: THREAD_CWD, succeeds: liveRec.id })).status === 409,
    'succession: an adoption that would create a cycle is REFUSED, nothing changed');
  ok((await api('POST', '/api/register', { native_id: 'uuid-live', cwd: THREAD_CWD, succeeds: 'sess_does_not_exist' })).status === 404,
    'succession: adopting a record that does not exist is refused, nothing changed');
  /* NAME ROT — §I2b at the naming layer. Native `name` is nameSource:"derived" and changes
   * per PROCESS: one record (uuid unchanged) had its title rewritten d1 → d9 across a
   * resume. A handle that moves with the process is a process-scoped address in disguise. */
  const named = (await api('POST', '/api/register', { native_id: 'uuid-namerot', cwd: '/tmp/namerot', native_name: 'proj-a1' })).body;
  ok(named.session.title === 'proj-a1', 'name rot: a derived native name may NAME a record at mint');
  const renamed = (await api('POST', '/api/register', { native_id: 'uuid-namerot', cwd: '/tmp/namerot', native_name: 'proj-z9' })).body;
  ok(renamed.session.title === 'proj-a1' && renamed.session.native_ref.name === 'proj-z9',
    'name rot: but it NEVER renames one afterwards — the title holds, the native name refreshes as the display hint it is');

  // 6. gather (fan-in) + conflict surfacing
  await api('POST', `/api/sessions/${S.design}/messages`, { role: 'user', text: 'Decision: CTA color is blue', decision: true });
  await api('POST', `/api/sessions/${S.cowork}/messages`, { role: 'user', text: 'Decision: CTA color is coral', decision: true });
  const g = (await api('POST', '/api/gather', { to: 'code', from: [S.chat, S.design, S.cowork] })).body;
  ok(g.dest.surface === 'code', 'gather lands on target surface');
  ok(g.envelopes.length === 3, 'gather synthesizes all source envelopes');
  ok(g.conflicts.length >= 1, 'conflicting decisions surfaced for user to resolve');
  const gcard = g.dest.messages.find(mm => mm.kind === 'gather_card');
  ok(gcard && /Chat \+ Design \+ Cowork/.test(gcard.text), 'gather card names all sources');

  // 7. real Claude Code bridge: export HANDOFF.md
  const exp = await api('POST', `/api/sessions/${S.chat}/export`, {});
  ok(exp.status === 201 && exp.body.path.endsWith('HANDOFF.md'), 'export writes HANDOFF.md');
  ok(/claude "Read HANDOFF\.md/.test(exp.body.command), 'export returns runnable claude CLI command');
  try {
    const md = require('fs').readFileSync(exp.body.path, 'utf8');
    ok(/Locked constraints/.test(md) && /Meet your thinking partner/.test(md), 'HANDOFF.md carries locked constraints verbatim (code task-brief structure)');
    ok(/### hero-copy\.md/.test(md) && /Hero copy \(locked\)/.test(md), 'artifacts travel by value (content survives the handoff — trial t1 gap closed)');
  } catch (_) { ok(false, 'HANDOFF.md readable on disk'); }
  ok((await api('POST', `/api/sessions/${S.chat}/export`, { dir: '/definitely/missing' })).status === 400, 'export rejects bad dir');
  const launch = await api('POST', `/api/sessions/${S.chat}/launch`, {});
  ok((launch.status === 200 && launch.body.launched === false && /claude --session-id [0-9a-f-]{36} "Read HANDOFF\.md/.test(launch.body.command)) || (launch.status === 202 && launch.body.launched === true),
    'auto-launch: spawns CLI when available, falls back to copyable command when not');
  ok(launch.body.native_ref && /^[0-9a-f-]{36}$/.test(launch.body.native_ref.session_id) && /claude --resume /.test(launch.body.native_ref.resume),
    'native Claude Code session UUID assigned at dispatch (shipped --session-id / --resume conventions)');

  // 7e. per-surface delivery briefs — same envelope, structured per target
  const bCode = (await api('GET', `/api/sessions/${S.chat}/brief?for=code`)).body;
  ok(/# Task brief/.test(bCode.brief) && /Definition of done/.test(bCode.brief) && /Locked constraints/.test(bCode.brief), 'code brief: goal / constraints / definition of done');
  const bDesign = (await api('GET', `/api/sessions/${S.chat}/brief?for=design`)).body;
  ok(/# Design brief/.test(bDesign.brief) && /Locked copy/.test(bDesign.brief) && /Meet your thinking partner/.test(bDesign.brief), 'design brief: intent / locked copy verbatim / style');
  const bCowork = (await api('GET', `/api/sessions/${S.chat}/brief?for=cowork`)).body;
  ok(/# Work brief/.test(bCowork.brief) && /Task checklist/.test(bCowork.brief), 'cowork brief: objective / task checklist / files');
  ok((await api('GET', `/api/sessions/${S.chat}/brief?for=nope`)).status === 400, 'brief rejects unknown surface');
  ok((await api('POST', `/api/sessions/${S.chat}/launch`, { dir: '/definitely/missing' })).status === 400, 'launch rejects bad dir');

  // 7e2. project_state / run_breakers — relevance judgment for device/instance hops
  const psS = (await api('POST', '/api/sessions', {
    surface: 'code', title: 'device-hop state',
    project_state: {
      project_id: 'acme-web',
      sender_instance: 'laptop',
      last_updated: '2026-08-06T16:00:00Z',
      context_change: 'switched API to local Postgres',
      progress: ['wired DATABASE_URL in app config'],
      run_breakers: ['.env gained DATABASE_URL — sync values locally (no secrets in card)', 'pending prisma migrate']
    },
    open_items: ['continue on Mac Mini']
  })).body;
  await api('POST', `/api/sessions/${psS.id}/messages`, { role: 'user', text: 'Hand off to the mini', kind: 'context' });
  const psEnv = (await api('GET', `/api/sessions/${psS.id}/envelope`)).body;
  ok(psEnv.project_state && psEnv.project_state.project_id === 'acme-web', 'envelope carries project_state');
  ok(Array.isArray(psEnv.project_state.run_breakers) && /DATABASE_URL/.test(psEnv.project_state.run_breakers[0]), 'run_breakers travel (names/what-changed)');
  const psBrief = (await api('GET', `/api/sessions/${psS.id}/brief?for=code`)).body;
  ok(/Project state/.test(psBrief.brief) && /Run-breakers/.test(psBrief.brief) && /prisma migrate/.test(psBrief.brief),
    'code brief surfaces project state + run-breakers for the other instance');
  const psCont = (await api('POST', `/api/sessions/${psS.id}/continue`, { to: 'code', return_leg: false })).body;
  ok(psCont.dest.project_state && /DATABASE_URL/.test((psCont.dest.project_state.run_breakers || []).join(' ')),
    'continue copies project_state onto the destination session');

  // Nested fences in by-value artifacts must not break Design paste rendering
  const nested = (await api('POST', '/api/sessions', {
    surface: 'code', title: 'nested-fence-doc',
    artifacts: [{
      name: 'DOC.md', type: 'file',
      content: '# Doc\n\n```bash\nnode bin/install.js\n```\n\nMore after inner fence.\n'
    }]
  })).body;
  const nestedBrief = (await api('GET', `/api/sessions/${nested.id}/brief?for=design`)).body;
  ok(/More after inner fence/.test(nestedBrief.brief), 'design brief keeps text after inner ``` bash fence');
  ok(/~{3,}markdown/.test(nestedBrief.brief),
    'design brief uses a tilde outer fence with markdown hint (inner ``` cannot close it)');

  // deliver_existing refreshes dest.artifacts (supersede must not leave a stale snapshot)
  const oldArt = (await api('POST', '/api/sessions', {
    surface: 'design', title: 'artifact-refresh',
    artifacts: [{ name: 'DOC.md', type: 'file', content: 'STALE_VERSION' }]
  })).body;
  const newOrigin = (await api('POST', '/api/sessions', {
    surface: 'code', title: 'artifact-refresh-src',
    artifacts: [{ name: 'DOC.md', type: 'file', content: 'CURRENT_VERSION_FULL' }]
  })).body;
  await api('POST', `/api/sessions/${newOrigin.id}/deliver`, { dest: oldArt.id, return_leg: false });
  const refreshed = (await api('GET', `/api/sessions/${oldArt.id}`)).body;
  ok(refreshed.artifacts.some(a => a.content === 'CURRENT_VERSION_FULL'),
    'deliver_existing overwrites dest.artifacts with the origin carrier');
  ok(!refreshed.artifacts.some(a => a.content === 'STALE_VERSION'),
    'stale dest artifacts do not survive a superseding deliver');

  // 7c. return to origin (reverse handoff — /return-to-origin)
  const rtO = (await api('POST', '/api/sessions', { surface: 'design', title: 'rt-test' })).body;
  await api('POST', `/api/sessions/${rtO.id}/messages`, { role: 'user', text: 'polish the frame' });
  const rtC = (await api('POST', `/api/sessions/${rtO.id}/continue`, { to: 'code' })).body;
  const ret = await api('POST', `/api/sessions/${rtC.dest.id}/return`, { summary: 'frame polished, exported assets, one naming question open' });
  ok(ret.status === 200 && ret.body.origin.surface === 'design', 'return resolves back to the correct origin surface');
  const rtOrigin = (await api('GET', `/api/sessions/${rtO.id}`)).body;
  ok(rtOrigin.messages.some(mm => mm.kind === 'resume_summary' && /frame polished/.test(mm.text)), 'origin auto-resumed with the returned summary — no card click needed');
  ok((await api('POST', `/api/sessions/${rtC.dest.id}/return`, { summary: 'again' })).status === 409, 'double return rejected (link already resolved)');

  // 7d. workers API — the no-UI loop: dispatch from a chat, retrieve the summary back
  const w = await api('POST', '/api/workers', { task: 'add a footer to the landing page', context: 'cream palette locked; serif display' });
  ok(w.status === 201 && !!w.body.worker_id && !!w.body.launch, 'worker dispatched (origin created, handed off, launch attempted)');
  ok((await api('POST', '/api/workers', {})).status === 400, 'worker requires a task');
  let wl = (await api('GET', '/api/workers')).body;
  let me = wl.find(x => x.worker_id === w.body.worker_id);
  ok(!!me && me.status === 'active' && me.working === true, 'worker listed as still working (no progress yet)');
  const wOrigin = (await api('GET', `/api/sessions/${w.body.origin_id}`)).body;
  ok(wOrigin.messages.some(mm => /cream palette locked/.test(mm.text)), 'conversation context traveled into the origin session');
  await api('POST', `/api/sessions/${w.body.worker_id}/messages`, { role: 'system', kind: 'progress', text: 'footer added, tests pass' });
  wl = (await api('GET', '/api/workers')).body;
  me = wl.find(x => x.worker_id === w.body.worker_id);
  ok(!!me && /footer added/.test(me.summary || ''), 'worker summary surfaces in the list');
  const got = await api('POST', `/api/links/${w.body.link_id}/resolve`);
  ok(/footer added/.test(got.body.summary), 'chat retrieves the worker result — full loop, no UI');

  // 8. validation
  ok((await api('POST', `/api/sessions/${S.chat}/continue`, { to: 'nope' })).status === 400, 'bad surface rejected');
  ok((await api('GET', '/api/sessions/sess_missing')).status === 404, 'unknown session 404');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('test runner error:', e.message); process.exit(1); });
