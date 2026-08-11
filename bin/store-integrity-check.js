#!/usr/bin/env node
'use strict';
/**
 * STORE INTEGRITY — find records that CANNOT receive, before someone sends to them.
 *
 * WHY THIS EXISTS. A `lulu` record declaring device `windows-laptop` sat live in the store for two
 * days after that machine stopped reporting that name. It surfaced only when a peer re-registered
 * and the verb answered "Refreshed" — adopting a record nobody had gone looking for, and reporting
 * it as success. Two `lili` records had already been retired for exactly this, and this one was
 * missed because the reconciliation was scoped BY TITLE — "the lili records" — instead of by the
 * INVARIANT that was actually broken.
 *
 * That is the whole lesson and the operator stated it: this cannot be allowed to happen by
 * omission. A cleanup driven by memory misses the record nobody remembers. A cleanup driven by a
 * check misses nothing, and the check is cheap.
 *
 * THE INVARIANT: a record that declares a host must be reachable by an agent on that host. When it
 * is not, the record is UNDELIVERABLE — a send to it is stored durably, reports success, and can
 * never be read. That is this project's founding failure class (a receipt for a delivery that
 * never happened), sitting in the store as data rather than in code as a bug.
 *
 * WHAT IT DOES NOT DO: judge names. It never guesses what a host "should" be called — it only
 * reports where a record's declared host has no live agent answering for it. The fix is always an
 * operator decision (retire, re-register, or start the agent), never this script's.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.HANDOFF_HOME || path.join(os.homedir(), '.claude-handoff');
const STORE = path.join(HOME, 'store', 'v1');
const AGENT_STALE_MS = Number(process.env.HANDOFF_AGENT_STALE_MS || 24 * 60 * 60 * 1000);

function readAll(coll) {
  const dir = path.join(STORE, coll);
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return out; }
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch (_) { /* unreadable row is its own problem */ }
  }
  return out;
}

function check(now) {
  const at = now || Date.now();
  const sessions = readAll('sessions');
  const agents = readAll('agents');
  const byHost = new Map(agents.map(a => [a.host || a.id, a]));
  const findings = [];

  for (const s of sessions) {
    if (s.archived || s.retired) continue;                       // an ended record is allowed to be unreachable
    const host = (s.remote && s.remote.host) || (s.native_ref && s.native_ref.host) || null;
    if (!host) continue;                                          // hostless = local to the store host
    const unread = (s.messages || []).filter(m => !m.read_at && m.role !== 'system').length;
    const agent = byHost.get(host);

    if (!agent) {
      findings.push({ kind: 'no-agent-record', id: s.id, title: s.title, host, unread,
        detail: `declares host "${host}", and NO agent record exists for it. Nothing on that machine has ever reported in, so a send here is stored and never read.` });
    } else if (agent.retired) {
      findings.push({ kind: 'agent-retired', id: s.id, title: s.title, host, unread,
        detail: `declares host "${host}", whose AGENT RECORD IS RETIRED (${agent.retired.reason || 'no reason recorded'}). The record outlived the agent that answered for it.` });
    } else if (agent.last_seen && (at - Date.parse(agent.last_seen)) > AGENT_STALE_MS) {
      findings.push({ kind: 'agent-stale', id: s.id, title: s.title, host, unread, soft: true,
        detail: `declares host "${host}", whose agent last reported ${new Date(agent.last_seen).toISOString().slice(0, 16)}. Not broken — but nothing has looked in a long time.` });
    }
  }

  /* The reverse direction, which is how the missed record would ALSO have surfaced: a live agent
   * whose host no live record declares is not an error, but a RETIRED agent still named by live
   * records is the exact shape that was missed. Reported above per-record; here we name the hosts
   * so the operator sees the machine rather than a list of ids. */
  const orphanHosts = [...new Set(findings.filter(f => !f.soft).map(f => f.host))];
  return { findings, orphanHosts, sessions: sessions.length, agents: agents.length };
}

if (require.main === module) {
  const r = check();
  console.log(`store-integrity-check — ${r.sessions} session record(s), ${r.agents} agent record(s)\n`);
  const hard = r.findings.filter(f => !f.soft);
  const soft = r.findings.filter(f => f.soft);

  for (const f of hard) {
    console.log(`  ✗ UNDELIVERABLE  "${f.title}"  [${f.id.slice(0, 28)}…]`);
    console.log(`      ${f.detail}`);
    if (f.unread) console.log(`      ⚠ ${f.unread} unread message(s) are sitting on it RIGHT NOW and cannot be read.`);
  }
  for (const f of soft) {
    console.log(`  ~ quiet          "${f.title}" — ${f.detail}`);
  }

  if (hard.length) {
    console.log(`\n${hard.length} record(s) cannot receive. Host(s) with no answering agent: ${r.orphanHosts.join(', ')}`);
    console.log('Each needs an OPERATOR decision — retire it, re-register on the name the machine actually reports,');
    console.log('or start an agent there. This check never guesses a name and never edits the store.');
    process.exit(1);
  }
  console.log(soft.length ? '\nNo undeliverable records. Quiet hosts noted above.' : '\nstore-integrity-check: OK — every record declaring a host has an agent answering for it.');
}

module.exports = { check };
