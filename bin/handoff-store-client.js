#!/usr/bin/env node
'use strict';
/**
 * STORE CLIENT — the seam that lets one wake agent run on a machine with no store.
 *
 * WHY THIS EXISTS. The wake agent was written against `require('../handoff-core')`, which reads the
 * store off the local filesystem. That is correct on the store's own host and impossible anywhere
 * else: a second machine has no `~/.claude-handoff` to read, so the agent could not run there at
 * all — and a wake agent that cannot run on the second machine is the one place the design needed
 * it. Measured 2026-08-10: a record minted for a second device has sat at reachability 'unknown'
 * since it was created, not because anything failed but because no agent on that host has ever
 * existed to look.
 *
 * SO THE STORE BECOMES AN INTERFACE WITH TWO IMPLEMENTATIONS, and the agent stops knowing which
 * one it has:
 *   local   — handoff-core directly. The store's own host. Unchanged behaviour, no new failure mode.
 *   remote  — the same verbs over HTTPS to the relay, carrying a credential.
 *
 * The relay already exposes exactly what is needed and nothing more: it is a wire, not a source of
 * truth, and it relays JSON-RPC to the daemon that owns the store. One writer, one store, a second
 * reader — the invariant the whole relay design protects is untouched by adding a caller.
 *
 * WHY POLLING, STILL. The store is a filesystem on one host and an HTTP surface from anywhere
 * else; neither pushes. A webhook emission layer is PROPOSED and not built, so this client is
 * written as the seam it will replace: everything the agent needs arrives through `getState` and
 * `heartbeat`, so a subscription implementation swaps in without the agent changing. That is the
 * same pluggability rule the transport registry lives under — the leg is chosen by a registry, not
 * re-derived by its caller.
 *
 * CREDENTIALS ARE NEVER STORED BY THIS FILE. It reads one from the environment and sends it. On
 * Windows the operator package puts it in Credential Manager and the launcher exports it for the
 * process; nothing here writes it to disk, logs it, or echoes it back. A token in a log is a token
 * in a backup.
 *
 * Env:
 *   HANDOFF_REMOTE_URL    the relay's /mcp endpoint. Absent → local mode, and this file is inert.
 *   HANDOFF_ACCESS_CLIENT_ID / HANDOFF_ACCESS_CLIENT_SECRET
 *                         a Cloudflare Access SERVICE TOKEN — the unattended credential. Preferred
 *                         over the user token whenever BOTH halves are present. Cloudflare's own
 *                         CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET are honoured too, because
 *                         that is what an operator has already pasted from the dashboard.
 *   HANDOFF_REMOTE_TOKEN  the browser-issued user credential. Sent as Authorization: Bearer AND as
 *                         the Access assertion header, because the relay accepts either and a
 *                         caller should not have to know which door it came through. Retained, not
 *                         deprecated: it is what every configured machine holds today.
 *   HANDOFF_REMOTE_TIMEOUT_MS  per-request ceiling (default 15000).
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

/* LOCAL VALUES, NEVER COMMITTED. The relay host and the repo URL are personal identifiers — one
 * carries a domain, the other an account handle — and this repo is intended to go public, so they
 * cannot live in a tracked file. They also cannot live only in a shell variable, because that dies
 * with the window and an operator then re-pastes a credential to get it back.
 *
 * So the same pattern the mirroring instructions already use: a gitignored KEY=VALUE file the
 * process reads at startup. Real environment variables WIN over it, so a one-off override needs no
 * edit, and nothing here writes the file or echoes its contents.
 *
 * A token may live here too, but Credential Manager is better on Windows and the operator package
 * says so — a file is only as private as the backup that copies it. */
function loadLocalEnv() {
  const fs = require('fs'), path = require('path');
  for (const p of [path.join(process.cwd(), '.agent-env'), path.join(__dirname, '..', '.agent-env')]) {
    let raw;
    try { raw = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 1) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (process.env[k] === undefined) process.env[k] = v;   // a real env var always wins
    }
    return p;
  }
  return null;
}
const LOCAL_ENV_FILE = loadLocalEnv();

const TIMEOUT_MS = Number(process.env.HANDOFF_REMOTE_TIMEOUT_MS) || 15000;

/* WHICH CREDENTIAL, AND WHY THERE ARE TWO.
 *
 * The credential every configured machine holds today is a Cloudflare Access USER JWT, browser
 * issued and exactly 86400s long. No code makes it unattended — a wake agent holding one is a
 * process that works for a day and then reads as "the store is unreachable". A SERVICE TOKEN is the
 * only credential Access issues that a machine can hold without a human at a browser.
 *
 * The relay needs no change for it: Access injects Cf-Access-Jwt-Assertion after ANY passing
 * policy, and the relay already verifies that. Only the client's headers differ, which is why this
 * is a client-side slice and the dashboard half (a Service Auth policy, one token per device) is
 * the operator's.
 *
 * PREFERRED WHEN PRESENT, and present means BOTH halves. A half-configured pair is REFUSED rather
 * than quietly resolved to the user token: the failure that silence produces is a machine that
 * looks correctly configured for a service token, runs on the cookie, and dies 24 hours later —
 * which is indistinguishable at the point of failure from the service token itself not working.
 * Absence of configuration is never permission; half a configuration is not either.
 *
 * Nothing here logs, stores, or returns a secret value: the kind is nameable, the value is not. */
function resolveCredential(opts) {
  const pick = (...names) => {
    for (const n of names) {
      const v = (opts && opts[n]) || process.env[n];
      if (v && String(v).trim()) return String(v).trim();
    }
    return null;
  };
  const id = pick('HANDOFF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_ID');
  const secret = pick('HANDOFF_ACCESS_CLIENT_SECRET', 'CF_ACCESS_CLIENT_SECRET');
  const token = (opts && opts.token) || pick('HANDOFF_REMOTE_TOKEN');

  if (id && secret) {
    return {
      kind: 'service-token',
      describe: 'Access service token (unattended; does not expire with a browser session)',
      headers: { 'cf-access-client-id': id, 'cf-access-client-secret': secret },
    };
  }
  if (id || secret) {
    return {
      kind: 'incomplete',
      problem: `a service token is half-configured — ${id ? 'HANDOFF_ACCESS_CLIENT_ID is set and the SECRET is missing' : 'HANDOFF_ACCESS_CLIENT_SECRET is set and the CLIENT ID is missing'}. ` +
        'Both halves or neither. This is refused rather than resolved to the user token, because falling back silently would give you a machine that looks unattended, runs on a browser credential, and stops working in under a day.',
      headers: null,
    };
  }
  if (token) {
    return {
      kind: 'user-token',
      describe: 'browser-issued user token (expires with the Access session, ~24h)',
      headers: { authorization: `Bearer ${token}`, 'cf-access-jwt-assertion': token },
    };
  }
  return null;
}

/** One JSON-RPC tools/call to the relay. Returns the parsed tool result text, or throws.
 *  `cred` is a credential from resolveCredential, or a bare token string (treated as the user
 *  token) so an older caller keeps working unchanged. */
function rpc(urlStr, cred, name, args, timeoutMs) {
  const credential = typeof cred === 'string' ? resolveCredential({ token: cred }) : cred;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error(`HANDOFF_REMOTE_URL is not a URL: ${e.message}`)); }
    const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args || {} } });
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + (u.search || ''), method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        // Whichever door this machine actually holds a key to. For the user token that is both the
        // bearer and the assertion header — the relay verifies either by the same rules, and
        // neither is trusted for being present. For a service token it is the id/secret pair, and
        // the bearer header is deliberately NOT also sent: Access exchanges the pair itself.
        ...((credential && credential.headers) || {}),
      },
    }, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          /* NAME THE CREDENTIAL THAT WAS REFUSED. The two kinds fail for different reasons and the
           * fixes do not overlap: a user token expires, a service token does not but needs a
           * Service Auth policy on the application (an Include on an Allow policy does not admit
           * it). A refusal that does not say which was presented sends the operator to the wrong
           * half of the dashboard. */
          const kind = credential ? credential.kind : 'no credential';
          return reject(new Error(`relay refused the credential (HTTP ${res.statusCode}) — presented: ${kind}. ` +
            (kind === 'service-token'
              ? 'A service token is refused when the application has no Service Auth policy, or the token was minted for another application. It does not expire, so do not re-mint it before checking the policy.'
              : 'The token is missing, expired, or minted for another application.') +
            ' Nothing was read.'));
        }
        if (res.statusCode >= 400) return reject(new Error(`relay returned HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
        let parsed;
        try { parsed = JSON.parse(buf); } catch (e) { return reject(new Error(`relay reply was not JSON: ${e.message}`)); }
        if (parsed.error) return reject(new Error(`relay error: ${parsed.error.message || JSON.stringify(parsed.error)}`));
        const c = parsed.result && parsed.result.content && parsed.result.content[0];
        const text = c && typeof c.text === 'string' ? c.text : '';
        if (parsed.result && parsed.result.isError) return reject(new Error(`tool refused: ${text.slice(0, 300)}`));
        resolve(text);
      });
    });
    req.on('error', e => reject(new Error(`cannot reach the relay: ${e.message}`)));
    req.setTimeout(timeoutMs || TIMEOUT_MS, () => {
      req.destroy();
      /* The honest-timeout rule, same as the relay's own: a request that was DELIVERED and not
       * answered may still have landed. For a read that is merely a retry; saying so keeps the
       * caller from concluding the store is empty when it is only slow. */
      reject(new Error(`no reply from the store within ${timeoutMs || TIMEOUT_MS}ms — it may still be executing. Nothing was read; retry rather than concluding the store is empty.`));
    });
    req.end(body);
  });
}

/**
 * Build a store client. `local` is handoff-core itself; `remote` speaks to the relay.
 * The agent calls the same two methods either way and cannot tell which it has.
 */
function makeStoreClient(opts) {
  const url = (opts && opts.url) || process.env.HANDOFF_REMOTE_URL || null;
  const credential = resolveCredential(opts);

  if (!url) {
    const core = opts && opts.core ? opts.core : require('../handoff-core');
    return {
      mode: 'local',
      describe: () => 'local store (filesystem, this host owns it)',
      async getState() { return (await core.handleApi('GET', '/api/state', {}, {})).payload; },
      async heartbeat(beat) { return (await core.handleApi('POST', '/api/agents/heartbeat', {}, beat)).payload; },
    };
  }

  /* A remote agent with no credential is not a degraded agent, it is a stopped one. Refusing here
   * — before a cycle runs — means the operator sees one clear sentence instead of a stream of
   * per-cycle auth failures that look like the store is unreachable. Absence of configuration is
   * never permission, and it is never silently retried either. */
  if (credential && credential.kind === 'incomplete') {
    throw new Error(`HANDOFF_REMOTE_URL is set and ${credential.problem}`);
  }
  if (!credential) {
    throw new Error('HANDOFF_REMOTE_URL is set but no credential is — a remote agent cannot read the store without one, and will not poll blind. Set either an Access service token (HANDOFF_ACCESS_CLIENT_ID + HANDOFF_ACCESS_CLIENT_SECRET, the unattended path) or HANDOFF_REMOTE_TOKEN, and start again.');
  }

  const call = (opts && opts.rpc) || rpc;
  return {
    mode: 'remote',
    credential: credential.kind,
    /* SAY WHICH CREDENTIAL, not merely that one exists. "credential present" was true of a machine
     * whose token expires tonight and of one that runs unattended forever, and an operator reading
     * a log line cannot tell those apart at the moment it matters. */
    describe: () => `remote store via ${new URL(url).host} — ${credential.describe}`,

    /* WHAT THE RELAY ACTUALLY EXPOSES, measured 2026-08-10 against handoff-tool-schemas: 23 tools,
     * and NONE of them reads store state or writes an agent heartbeat. So a remote agent can do
     * exactly two of its three jobs:
     *
     *   peek      YES — peek_inbox reads what is waiting WITHOUT consuming it
     *   deliver   YES — send_message
     *   heartbeat YES — agent_heartbeat, added 2026-08-10 for exactly this. Own-host only, and
     *                   refused WHOLE if it names another host's records. This is the act that
     *                   flips a record from 'unknown' to host-asserted.
     *
     * State enumeration is STILL absent and deliberately so — the door widened for the acceptance
     * test, not for a convenience. This client therefore REFUSES to pretend. getState does not
     * synthesise an empty session map:
     * an agent handed `{sessions:{}}` would enumerate nothing, own nothing, report a clean cycle
     * and be silently useless — the exact failure this codebase keeps finding. It returns what it
     * genuinely has and marks the rest unavailable, so the caller must decide rather than be
     * misled. Absence is reported, never filled. */
    async peek(surface) {
      return call(url, credential, 'peek_inbox', { surface: surface || 'code' }, TIMEOUT_MS);
    },
    async getState() {
      const peek = await this.peek('code');
      return {
        mode: 'remote',
        peek,
        sessions: null,          // NOT {} — null means "cannot enumerate", {} would mean "none exist"
        links: null,
        unavailable: ['state enumeration (no tool on the relay surface)'],
      };
    },
    /* THE VERB EXISTS NOW, so HEARTBEAT_UNAVAILABLE_REMOTE is DELETED rather than kept behind a
     * fallback. A dead error path that "still works if the tool is missing" is a second behaviour
     * nobody exercises and everybody trusts; if the door narrows again this should break loudly,
     * not quietly degrade to the state it was written to complain about. */
    async heartbeat(beat) {
      const text = await call(url, credential, 'agent_heartbeat', {
        host: beat.host,
        sessions: beat.sessions || {},
        agent_version: beat.agent_version || null,
        default_verdict: beat.default_verdict,
        owns: beat.owns,
      }, TIMEOUT_MS);
      return { recorded: text };
    },
  };
}

module.exports = { makeStoreClient, rpc, resolveCredential, LOCAL_ENV_FILE };
