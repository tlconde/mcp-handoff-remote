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
 *   HANDOFF_REMOTE_TOKEN  the credential. Sent as Authorization: Bearer AND as the Access
 *                         assertion header, because the relay accepts either and a caller should
 *                         not have to know which door it came through.
 *   HANDOFF_REMOTE_TIMEOUT_MS  per-request ceiling (default 15000).
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

const TIMEOUT_MS = Number(process.env.HANDOFF_REMOTE_TIMEOUT_MS) || 15000;

/** One JSON-RPC tools/call to the relay. Returns the parsed tool result text, or throws. */
function rpc(urlStr, token, name, args, timeoutMs) {
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
        // Both doors. The relay verifies either by the same rules; sending both spares the caller
        // knowing which one the deployment uses, and neither is trusted for being present.
        ...(token ? { authorization: `Bearer ${token}`, 'cf-access-jwt-assertion': token } : {}),
      },
    }, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error(`relay refused the credential (HTTP ${res.statusCode}) — the token is missing, expired, or minted for another application. Nothing was read.`));
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
  const token = (opts && opts.token) || process.env.HANDOFF_REMOTE_TOKEN || null;

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
  if (!token) {
    throw new Error('HANDOFF_REMOTE_URL is set but HANDOFF_REMOTE_TOKEN is not — a remote agent cannot read the store without a credential, and will not poll blind. Set the token (see the Windows operator package) and start again.');
  }

  const call = (opts && opts.rpc) || rpc;
  return {
    mode: 'remote',
    describe: () => `remote store via ${new URL(url).host} (credential present)`,

    /* WHAT THE RELAY ACTUALLY EXPOSES, measured 2026-08-10 against handoff-tool-schemas: 23 tools,
     * and NONE of them reads store state or writes an agent heartbeat. So a remote agent can do
     * exactly two of its three jobs:
     *
     *   peek      YES — peek_inbox reads what is waiting WITHOUT consuming it
     *   deliver   YES — send_message
     *   heartbeat NO  — /api/agents/heartbeat has no tool, so a remote host cannot write its own
     *                   verdict, which is the one act that flips a record from 'unknown' to
     *                   host-asserted
     *
     * This client therefore REFUSES to pretend. getState does not synthesise an empty session map:
     * an agent handed `{sessions:{}}` would enumerate nothing, own nothing, report a clean cycle
     * and be silently useless — the exact failure this codebase keeps finding. It returns what it
     * genuinely has and marks the rest unavailable, so the caller must decide rather than be
     * misled. Absence is reported, never filled. */
    async peek(surface) {
      return call(url, token, 'peek_inbox', { surface: surface || 'code' }, TIMEOUT_MS);
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
    async heartbeat() {
      const err = new Error('a remote agent cannot write a heartbeat: /api/agents/heartbeat is not exposed as a tool on the relay, so this host cannot assert a verdict for its own records. Reachability stays "unknown" — which is honest, and is exactly the acceptance test that stays open until the verb exists.');
      err.code = 'HEARTBEAT_UNAVAILABLE_REMOTE';
      throw err;
    },
  };
}

module.exports = { makeStoreClient, rpc };
