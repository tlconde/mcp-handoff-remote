#!/usr/bin/env node
/* handoff-preflight — can a worker dispatched RIGHT NOW actually do work?
 *
 * WHY THIS EXISTS. On 2026-08-10 one ruled, owed task was dispatched four times and never done.
 * Five independent things stood between "dispatch reported success" and "work happened", and every
 * one of them reported success at the layer that broke it:
 *
 *   1. the offer sat pending and was never opened      — dispatch is not appearance
 *   2. the brief was built from the dest, not the origin — worker read no task, exited 0
 *   3. `claude` was spawned by bare name under a minimal PATH — "prepared but NOT auto-launched"
 *   4. the tool grant named one of the server's TWO mount names — denied, non-interactive
 *   5. get_handoff needed a pin, and the pinning verb was not granted — worker stopped and asked
 *
 * Each was found only by fixing the one before it: five round trips, one link per trip. Nothing in
 * the system answered the whole question, because every layer answers only for itself.
 *
 * So this runs the REAL chain against a TRIVIAL task and checks a REAL EFFECT. The task is to write
 * a marker file whose content this script chooses; the verdict is whether that file exists with that
 * content. Not an exit code, not a status string, not a well-formed log line — the effect itself.
 * "Exit status is not effect" is the house rule; a preflight that trusted an exit code would be the
 * joke telling itself.
 *
 * It is deliberately NOT part of daemon-smoke: it spawns a real Claude and costs real time and
 * tokens. It is the acceptance test you run BEFORE a real dispatch you care about.
 *
 *   node bin/handoff-preflight.js            # against the live store
 *   HANDOFF_HOME=/tmp/pf node bin/...        # against a scratch store
 *
 * Exits 0 only if the marker landed. Any other outcome names the link that broke.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const core = require('../handoff-core');

const TIMEOUT_MS = Number(process.env.HANDOFF_PREFLIGHT_TIMEOUT || 180000);
const POLL_MS = 3000;

/* The marker is generated per run and asserted by CONTENT, not by existence. A stale marker from a
 * previous preflight sitting in a reused directory would otherwise pass this forever — the healthy-
 * artifact trap, which this project has already been bitten by once. */
const RUN_ID = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
const MARKER_TEXT = `PREFLIGHT-OK ${RUN_ID}`;

const links = [];
function link(name, ok, detail) {
  links.push({ name, ok, detail: detail || '' });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-preflight-'));
  const markerPath = path.join(dir, 'PREFLIGHT-MARKER.txt');
  console.log(`handoff-preflight ${RUN_ID}`);
  console.log(`  store: ${core.HOME}`);
  console.log(`  dir:   ${dir}\n`);

  // ---- link 0: the binary resolves. Barrier 3 was invisible until a dispatch reported it. ----
  const bin = core.claudeBin ? core.claudeBin() : null;
  link('claude binary resolves', !!bin, bin || 'not found on any candidate path or PATH');
  if (!bin) return finish(false);

  const available = core.claudeCliAvailable();
  link('claude CLI answers --version', available);
  if (!available) return finish(false);

  // ---- dispatch the real thing ----
  /* THE TASK ASKS FOR THE REPORT, because the check below tests for one. The first version said
   * "do exactly one thing and then stop", and then scored the worker red for not calling
   * report_progress — penalising it for obeying. A false negative in the tool whose whole job is to
   * tell you which link is broken is worse than no check: it spends the reader's trust on noise.
   * Two links, so two instructions. */
  const task = [
    'PREFLIGHT — this is a no-op acceptance test of the dispatch chain, not real work.',
    '',
    'Do exactly two things, in order, then stop:',
    `  1. Write the file ${JSON.stringify(markerPath)} containing exactly this line:`,
    `     ${MARKER_TEXT}`,
    '  2. Call report_progress with a one-line confirmation that you wrote it.',
    '',
    'Do not create, modify or delete any other file. Do not run tests. Do not commit anything.',
    'If you cannot do either step, say plainly which one blocked you and stop — naming the broken',
    'link IS the useful outcome here, and is worth more than working around it.',
  ].join('\n');

  const res = await core.handleApi('POST', '/api/workers', {}, {
    task,
    context: 'Dispatch-chain preflight. The only success criterion is the marker file with the exact content given in the task.',
    dir,
    mode: 'headless',
  });

  const payload = (res && res.payload) || {};
  const workerId = (payload.session && payload.session.id) || payload.session_id || payload.worker_id || null;
  link('dispatch accepted', res.code >= 200 && res.code < 300, `HTTP ${res.code}${workerId ? ` · ${workerId}` : ''}`);
  if (!workerId) return finish(false);

  /* Barrier 3 again, from the other side: doLaunch returns launched:false with a reason instead of
   * throwing, which is honest — and is exactly the kind of soft failure a caller reads past. */
  if (payload.launched === false) {
    link('worker launched', false, payload.reason || 'launched:false with no reason given');
    return finish(false);
  }
  link('worker launched', true, payload.native_ref && payload.native_ref.session_id
    ? `native ${payload.native_ref.session_id}` : '');

  /* THE BRIEF IS CHECKED BEFORE THE MARKER. If the marker never lands we need to distinguish "the
   * worker never learned the task" (barrier 2) from "the worker knew and failed", and after the
   * fact the brief is the only place that answer lives. */
  /* ASSERT THE PAYLOAD, NOT THE WORD. The first version of this check tested
   * brief.includes('PREFLIGHT') and passed green while the brief carried no task at all — the word
   * matched the context line. It reported "brief carries the task" on the exact run that proved it
   * did not, which is the vacuous-assertion disease this file was written to catch, committed
   * inside the catcher. The marker path and text are the payload; nothing else will do. */
  const brief = await readBrief(workerId, dir);
  const carriesTask = brief.includes(MARKER_TEXT) && brief.includes(path.basename(markerPath));
  link('brief carries the TASK payload (marker path + exact content)', carriesTask,
    brief
      ? `${brief.length} chars${carriesTask ? '' : ' — the brief reached the worker but the task was not in it'}`
      : 'brief unreadable — could not confirm the worker was told anything');

  // ---- the only verdict that counts ----
  console.log(`\n  waiting up to ${Math.round(TIMEOUT_MS / 1000)}s for the effect…`);
  const started = Date.now();
  let content = null;
  while (Date.now() - started < TIMEOUT_MS) {
    try {
      const c = fs.readFileSync(markerPath, 'utf8');
      if (c.includes(MARKER_TEXT)) { content = c; break; }
    } catch (_) { /* not yet */ }
    await sleep(POLL_MS);
  }
  const secs = Math.round((Date.now() - started) / 1000);
  link('EFFECT: marker file written with this run\'s content', !!content,
    content ? `after ${secs}s` : `not present after ${secs}s — the chain is broken at or before the worker's first write`);

  /* Reporting is a SEPARATE link from doing. A worker that did the work and could not report it is
   * a different failure from one that did nothing, and conflating them is how barrier 5 read as
   * barrier 2 for an hour.
   *
   * POLLED, NOT SAMPLED ONCE, because the marker lands BEFORE the report: the worker writes the
   * file, then calls report_progress. Checking the instant the marker appeared scored a red on a
   * worker that went on to report seconds later — asserting a value at a moment it could not yet be
   * true. That is the third defect this tool has had in its own checks, after a vacuous brief
   * assertion and a task whose wording contradicted what it scored, and all three shared one shape:
   * the checker was wrong about the world, not the world about the checker. A preflight that cries
   * wolf spends the trust it exists to earn. */
  const progressed = await waitFor(() => workerReported(workerId), 45000);
  link('worker reported progress back to the store', progressed,
    progressed ? '' : 'no progress message after 45s — report_progress may be ungranted or unreachable');

  return finish(!!content);
}

async function readBrief(workerId, dir) {
  try {
    const r = await core.handleApi('GET', `/api/sessions/${workerId}/brief`, { for: 'code' }, {});
    if (r && r.payload && r.payload.brief) return String(r.payload.brief);
  } catch (_) {}
  try { return fs.readFileSync(path.join(dir, 'HANDOFF.md'), 'utf8'); } catch (_) {}
  return '';
}

async function workerReported(workerId) {
  try {
    const r = await core.handleApi('GET', '/api/state', {}, {});
    const s = r && r.payload && r.payload.sessions && r.payload.sessions[workerId];
    return !!(s && (s.messages || []).some(m => m.kind === 'progress'));
  } catch (_) { return false; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Poll a predicate until true or the budget runs out. Returns the last value, so a false is a
 *  measured false rather than an impatient one. */
async function waitFor(fn, budgetMs, everyMs = 2000) {
  const until = Date.now() + budgetMs;
  let last = false;
  do {
    last = await fn();
    if (last) return last;
    await sleep(everyMs);
  } while (Date.now() < until);
  return last;
}

function finish(ok) {
  const broken = links.filter(l => !l.ok);
  console.log('');
  if (ok) {
    console.log(`handoff-preflight: PASS — the dispatch chain delivers work end to end (${links.length} links).`);
  } else {
    console.log('handoff-preflight: FAIL — first broken link: ' + (broken[0] ? broken[0].name : 'unknown'));
    console.log('A dispatch made now will report success and produce nothing. Fix that link before dispatching real work.');
  }
  process.exit(ok ? 0 : 1);
}

main().catch(e => {
  console.error('handoff-preflight: threw before reaching a verdict — ' + (e && e.stack || e));
  process.exit(2);
});
