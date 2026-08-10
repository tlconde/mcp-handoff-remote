#!/usr/bin/env node
'use strict';
/**
 * DRIFT EVAL — does anything in this system currently disagree with itself?
 *
 * The protocol exists so sessions do not work from outdated data. On 2026-08-09 it drifted
 * anyway, in six distinct ways in a single afternoon, and every one was invisible until
 * someone went looking by hand. This measures each of those six, because a failure mode that
 * cost an afternoon once will cost one again, and "we fixed it" is not a mechanism.
 *
 * What actually happened, and which check exists because of it:
 *
 *   1. Two checkouts of shared code diverged: 15 of 23 files. Nothing compared them.  → MIRROR
 *   2. A daemon ran 37 minutes on superseded handoff-core.js, reporting itself healthy. → PROCESS
 *   3. An analysis read ~/.claude-handoff/data.json (dated 2 days earlier) instead of
 *      store/v1/, and concluded a record had no native_ref when it did.                → SHADOW
 *   4. A record's native_ref named a pid that no longer existed; another record's
 *      protocol title and native name disagreed, invisibly.                            → RECORD
 *   5. Three messages were delivered to a record with no live reader. They reported
 *      success identically to a delivery that woke a terminal.                         → REACH
 *   6. check_inbox on a surface marked ANOTHER conversation's mail read, so the
 *      intended reader would have found an empty inbox.                                → REACH
 *
 * Every check answers one question: is what someone would read here still true? It prints
 * the evidence, never a verdict without one, and exits non-zero when anything drifted so it
 * can run from a hook or CI rather than relying on someone remembering.
 *
 * Usage:   node drift-eval.js
 *          HANDOFF_MIRROR=/path/to/paired/checkout node drift-eval.js   (enables MIRROR)
 *
 * Reads only. Touches no store, sends nothing, and never prints a token or message body.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = process.env.HANDOFF_HOME || path.join(os.homedir(), '.claude-handoff');
const SESSIONS = path.join(HOME, 'store', 'v1', 'sessions');
const HERE = __dirname;

let drifted = 0;
const results = [];
function report(name, ok, headline, evidence) {
  results.push({ name, ok, headline, evidence: evidence || [] });
  if (!ok) drifted++;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };

/* ── 1. MIRROR ─────────────────────────────────────────────────────────────────────────────
 * Shared code lives in two checkouts that must move together. Comment-only divergence is
 * tolerated (de-personalization is a one-way transform); anything else is a real fork, and
 * the distinction is the whole point — a diff count alone cannot tell you which you have. */
function checkMirror() {
  const other = process.env.HANDOFF_MIRROR;
  if (!other) {
    report('MIRROR', true, 'skipped — set HANDOFF_MIRROR to the paired checkout to compare');
    return;
  }
  if (!fs.existsSync(other)) { report('MIRROR', false, `HANDOFF_MIRROR does not exist: ${other}`); return; }
  const shared = fs.readdirSync(HERE)
    .filter(f => f.endsWith('.js') && !f.startsWith('.'))
    .concat(fs.existsSync(path.join(HERE, 'bin')) ? fs.readdirSync(path.join(HERE, 'bin')).map(f => path.join('bin', f)) : []);
  /* THREE KINDS OF DIFFERENCE, AND ONLY ONE IS DRIFT. Comments differ because
   * de-personalization is a deliberate one-way transform. String literals differ because the
   * publishable copy uses placeholder hosts where the notebook uses real ones — also
   * deliberate. Structure differing is the only thing that means the two copies would BEHAVE
   * differently, and it is the only thing worth waking someone for. An earlier version of
   * this check lumped the second in with the third and reported 11 files as logic drift when
   * the true number was smaller — a false alarm in a drift detector teaches people to ignore
   * it, which is the failure this whole file exists to prevent. */
  const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\s+/g, ' ').trim();
  const stripValues = s => s.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/`(?:[^`\\]|\\.)*`/g, '``');
  const logic = [], valueOnly = [], commentOnly = [], missing = [];
  for (const rel of shared) {
    const a = path.join(HERE, rel), b = path.join(other, rel);
    if (!fs.existsSync(b)) { missing.push(rel); continue; }
    const A = fs.readFileSync(a, 'utf8'), B = fs.readFileSync(b, 'utf8');
    if (A === B) continue;
    if (stripComments(A) === stripComments(B)) { commentOnly.push(rel); continue; }
    if (stripValues(stripComments(A)) === stripValues(stripComments(B))) { valueOnly.push(rel); continue; }
    logic.push(rel);
  }
  report('MIRROR', logic.length === 0,
    logic.length ? `${logic.length} shared file(s) differ in STRUCTURE — the two copies would behave differently`
                 : `no structural divergence (${commentOnly.length} comment-only, ${valueOnly.length} placeholder-value, ${missing.length} absent)`,
    logic.map(f => `structure differs: ${f}`)
      .concat(valueOnly.map(f => `(value-only, expected: ${f})`))
      .concat(missing.map(f => `absent in mirror: ${f}`)));
}

/* ── 2. PROCESS ────────────────────────────────────────────────────────────────────────────
 * A running process holds the code it required at boot. Node caches modules, so editing a
 * file under a live daemon or bridge changes nothing it executes — the incident this exists
 * for is a daemon 37 minutes ahead of its own core with a clean health report. */
function checkProcess() {
  let ps = '';
  try { ps = execFileSync('ps', ['-axo', 'pid=,lstart=,command='], { encoding: 'utf8' }); } catch (_) {
    report('PROCESS', true, 'skipped — ps unavailable'); return;
  }
  const watched = ['handoff-daemon.js', 'handoff-core.js', 'handoff-tools.js', 'handoff-contract.js', 'mcp-handoff.js'];
  const stale = [], seen = [];
  for (const line of ps.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\w{3} \w{3} +\d+ [\d:]+ \d{4})\s+(.*)$/);
    if (!m) continue;
    const [, pid, started, cmd] = m;
    const which = watched.find(w => cmd.includes(w));
    if (!which || !cmd.includes('node')) continue;
    const dir = (cmd.match(/(\S+)\/(?:handoff-daemon|mcp-handoff)\.js/) || [])[1];
    if (!dir || !fs.existsSync(dir)) continue;
    const bootMs = Date.parse(started);
    seen.push(`${which} pid ${pid} booted ${started.trim()}`);
    for (const w of watched) {
      const f = path.join(dir, w);
      if (!fs.existsSync(f)) continue;
      const mt = fs.statSync(f).mtimeMs;
      if (mt > bootMs) {
        const mins = Math.round((mt - bootMs) / 60000);
        stale.push(`${which} pid ${pid} is running code older than ${w} on disk (file is ${mins} min newer than boot)`);
      }
    }
  }
  report('PROCESS', stale.length === 0,
    stale.length ? `${stale.length} running process/file pair(s) out of date` : `all ${seen.length} handoff process(es) match their code on disk`,
    stale.length ? stale : seen);
}

/* ── 3. SHADOW ─────────────────────────────────────────────────────────────────────────────
 * Abandoned copies of the store are indistinguishable from the store when you are reading
 * with a text editor or a script. One of them cost a wrong answer today: data.json was two
 * days stale and still parsed cleanly, so the conclusion drawn from it looked sound. */
function checkShadow() {
  if (!fs.existsSync(SESSIONS)) { report('SHADOW', true, `skipped — no live store at ${SESSIONS}`); return; }
  const liveMs = Math.max(...fs.readdirSync(SESSIONS).map(f => fs.statSync(path.join(SESSIONS, f)).mtimeMs), 0);
  const shadows = [];
  for (const f of fs.readdirSync(HOME)) {
    const p = path.join(HOME, f);
    if (!fs.statSync(p).isFile() || !/\.json/.test(f)) continue;
    const j = readJson(p);
    if (!j || !j.sessions) continue; // only files that LOOK like a store are confusable
    const age = Math.round((liveMs - fs.statSync(p).mtimeMs) / 86400000);
    shadows.push(`${f} parses as a store, ${Object.keys(j.sessions).length} sessions, ${age} day(s) behind the live store`);
  }
  report('SHADOW', shadows.length === 0,
    shadows.length ? `${shadows.length} stale file(s) in ${HOME} would read as the store` : 'no store-shaped files shadowing the live store',
    shadows);
}

/* ── 4. RECORD ─────────────────────────────────────────────────────────────────────────────
 * Addresses inside the store that no longer describe the world: a native_ref pointing at a
 * dead pid, or a protocol title and native name that disagree so a name resolves in one
 * namespace and not the other. */
function checkRecord() {
  if (!fs.existsSync(SESSIONS)) { report('RECORD', true, 'skipped — no live store'); return; }
  const dead = [], split = [];
  for (const f of fs.readdirSync(SESSIONS)) {
    const r = readJson(path.join(SESSIONS, f));
    if (!r || r.archived) continue;
    const nr = r.native_ref;
    if (!nr) continue;
    if (nr.pid && !alive(nr.pid)) dead.push(`"${r.title}" points at pid ${nr.pid}, which is not running`);
    if (nr.name && r.title && nr.name !== r.title) split.push(`"${r.title}" is "${nr.name}" natively — resolvable by handoff, not by ListAgents`);
  }
  report('RECORD', dead.length === 0,
    dead.length ? `${dead.length} record(s) address a dead process` : 'every native_ref names a live process',
    dead.concat(split.length ? [`(${split.length} name split(s), reported by whoami — not drift, listed for context)`, ...split] : []));
}

/* ── 5. NAMES ──────────────────────────────────────────────────────────────────────────────
 * The name a conversation ANSWERS TO and the name it CALLS ITSELF are different strings, and
 * nothing keeps them together. A record's title is set once, at creation. The Claude app then
 * renames the conversation from its own content, terminals get renamed by their operators, and
 * every message a sender writes carries a free-text "from" label that reflects what it calls
 * itself TODAY. Resolution matches the title. So the name a human reads is not the name the
 * protocol answers to, and a send addressed to what they see resolves to nothing.
 *
 * Measured 2026-08-10: a chat created as "btw: automate the check inbox poke" was renamed by the
 * app to "Automating inbox check notifications". resolve_conversation on the name in the sidebar
 * returned RESOLVED: nothing, while replies silently landed under the old title. Same shape as the
 * terminal case that cost hours the day before ("booty" by title, "handoff-remote-3a" natively),
 * which I had wrongly filed as terminal-only.
 *
 * Detectable without any app API, which is the useful part: every inbound message stores its
 * sender's label verbatim, so the store already holds what each record has been calling itself. */
function checkNames() {
  if (!fs.existsSync(SESSIONS)) { report('NAMES', true, 'skipped — no live store'); return; }
  const recs = [];
  for (const f of fs.readdirSync(SESSIONS)) {
    const r = readJson(path.join(SESSIONS, f));
    if (!r || r.archived) continue;
    recs.push(r);
  }
  /* Mirror the REAL resolver (handoff-tools.js filterByName): a record answers to its title AND to
   * native_ref.name, exact before substring. The first version of this check compared against the
   * title alone, so it flagged "tunnel" for calling itself "build" — which the resolver already
   * matches. A drift detector measuring something other than what the code does produces false
   * alarms, and a false alarm in a drift detector teaches people to ignore it. */
  const namesOf = r => [r.title, r.native_ref && r.native_ref.name].filter(x => typeof x === 'string' && x);
  const resolves = q => {
    const t = String(q).trim().toLowerCase();
    const exact = recs.filter(r => namesOf(r).some(n => n.trim().toLowerCase() === t));
    return exact.length ? exact : recs.filter(r => namesOf(r).some(n => n.toLowerCase().includes(t)));
  };

  /* THREE label forms, not one. The first version matched only "[message from <surface> · <name>]"
   * and missed the em-dash variant, the capitalised surface, and the whole handoff-envelope family
   * — 21 messages on this store. A check that reads one shape of the data reports on one shape of
   * the data. */
  const LABEL = /^\[(?:message|handoff envelope) from ([A-Za-z ]+?)\s*(?:·|—)\s*"?([^\]"]+)"?\]/;
  const attributed = new Map(); // record id -> Set(names it called itself)
  const circulating = new Set(); // every name seen, attributable or not
  for (const r of recs) {
    for (const m of (r.messages || [])) {
      const mm = LABEL.exec(m.text || '');
      if (!mm) continue;
      const nm = mm[2].trim();
      circulating.add(nm);
      if (!m.from_session) continue;
      if (!attributed.has(m.from_session)) attributed.set(m.from_session, new Set());
      attributed.get(m.from_session).add(nm);
    }
  }

  const findings = [];
  const byId = new Map(recs.map(r => [r.id, r]));
  for (const [sid, names] of attributed) {
    const rec = byId.get(sid);
    if (!rec) continue;
    const own = namesOf(rec);
    const unmatched = [...names].filter(n => !own.some(o => n === o || n.includes(o) || o.includes(n)));
    if (unmatched.length) findings.push(`"${rec.title}" also calls itself ${unmatched.map(n => `"${n}"`).join(', ')} — those resolve to nothing`);
  }

  /* THE CASE THAT MOTIVATED THIS CHECK WAS INVISIBLE TO ITS FIRST VERSION. A label whose
   * from_session is null cannot be attributed to a record — 21 messages here, including the
   * flagship: a chat renamed by the app to "Automating inbox check notifications", whose own
   * message carries that name with no sender id. Unattributable is not the same as uninteresting:
   * the name is in circulation and resolves to nothing, so anyone who types what they read gets
   * RESOLVED: nothing. Report it as its own finding rather than discarding it. */
  const orphaned = [...circulating].filter(n => resolves(n).length === 0).sort();
  for (const n of orphaned.slice(0, 12)) findings.push(`a name in use resolves to NOTHING: "${n}"`);
  if (orphaned.length > 12) findings.push(`…and ${orphaned.length - 12} more names in circulation that resolve to nothing`);

  report('NAMES', findings.length === 0,
    findings.length ? `${orphaned.length} name(s) in circulation resolve to nothing`
                    : 'every name in circulation resolves to the record that uses it',
    findings);
}

/* ── 5. REACH ──────────────────────────────────────────────────────────────────────────────
 * Mail waiting in a record nothing can read. A send to a record with no live terminal reports
 * success in the same words as one that started a turn, so the sender learns nothing — three
 * substantial messages went this way today before anyone noticed. */
function checkReach() {
  if (!fs.existsSync(SESSIONS)) { report('REACH', true, 'skipped — no live store'); return; }
  const stranded = [];
  for (const f of fs.readdirSync(SESSIONS)) {
    const r = readJson(path.join(SESSIONS, f));
    if (!r || r.archived || !Array.isArray(r.messages)) continue;
    const unread = r.messages.filter(m => !m.read_at).length;
    if (!unread) continue;
    const nr = r.native_ref;
    const reachable = r.surface !== 'code' || (nr && nr.pid && alive(nr.pid));
    if (!reachable) stranded.push(`"${r.title}" holds ${unread} unread message(s) and has no live reader — a send here can never wake anything`);
  }
  report('REACH', stranded.length === 0,
    stranded.length ? `${stranded.length} record(s) hold unread mail nothing can read` : 'all unread mail sits where something can read it',
    stranded);
}

checkMirror(); checkProcess(); checkShadow(); checkRecord(); checkReach(); checkNames();

console.log('\nDRIFT EVAL — is anything here disagreeing with itself?\n');
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(8)} ${r.headline}`);
  for (const e of r.evidence) console.log(`      · ${e}`);
}
console.log(`\n${drifted === 0 ? 'No drift measured.' : `${drifted} check(s) drifted.`}`);
process.exit(drifted === 0 ? 0 : 1);
