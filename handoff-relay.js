#!/usr/bin/env node
'use strict';
/**
 * t27 sub-step 1 — the remote MCP relay: OAuth 2.1 resource server + stateless relay.
 *
 * Shape is the spike's (b847465) recommendation, unchanged:
 *   device → claude.ai custom connector (HTTPS + OAuth) → THIS relay → outbound tunnel
 *          → the Mac daemon's control socket → store/v1 on the Mac.
 * The relay holds NO store and NO session state. It is a wire, not a source of truth —
 * that is what preserves the daemon's one-store / single-writer invariant with a remote
 * leg attached. If this process dies, nothing is lost but reachability.
 *
 * WHAT IS DELIBERATELY NOT HERE (sub-step 1 scope):
 *   - No authorization server. This relay is a RESOURCE server: it validates tokens, it
 *     does not issue them. Which AS signs them is the one open decision this sub-step
 *     surfaces, and until it is answered every token fails closed (see verifyToken).
 *   - No read cache. Offline is an explicit error, per the spike (a cache adds storage,
 *     which is a post-v1 ruling).
 *
 * FAIL CLOSED, ALWAYS. An unconfigured relay refuses every call. A relay that "worked"
 * because auth was not wired yet would publish the entire protocol store — every
 * conversation, decision and artifact — to the public internet, and it would look like
 * success while doing it. Absence of configuration is never permission.
 *
 * Env:
 *   HANDOFF_RELAY_PORT       listen port (default 8787, loopback only)
 *   HANDOFF_RELAY_RESOURCE   this relay's canonical https URL — the token audience
 *   HANDOFF_RELAY_AS         issuer URL of the authorization server (unset = refuse all)
 *   HANDOFF_RELAY_JWKS       JWKS URL for signature verification (unset = refuse all)
 *   HANDOFF_DAEMON_SOCK      daemon control socket (default ~/.claude-handoff/daemon.sock)
 */
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { CONTRACT } = require('./handoff-contract');
const { verifyJwt } = require('./handoff-jwt');

const PORT = Number(process.env.HANDOFF_RELAY_PORT) || 8787;
const HOME = process.env.HANDOFF_HOME || path.join(os.homedir(), '.claude-handoff');
const SOCK = process.env.HANDOFF_DAEMON_SOCK || path.join(HOME, 'daemon.sock');
const RESOURCE = process.env.HANDOFF_RELAY_RESOURCE || null;
const AS_ISSUER = process.env.HANDOFF_RELAY_AS || null;
const JWKS_URL = process.env.HANDOFF_RELAY_JWKS || null;
/* AUDIENCE — a NAMED DEVIATION, ruled by the user 2026-08-09, written here rather than
 * discovered later. The MCP spec has the client send RFC 8707 `resource` and has us verify
 * the token was minted for that resource. Cloudflare Access does not consume `resource`: as
 * an OIDC provider it issues `aud` = the registered application's client_id. So we bind the
 * audience to the CLIENT_ID instead of the resource URI.
 *
 * The spec sanctions this rather than merely tolerating it — it requires the client to send
 * the parameter "regardless of whether authorization servers support it", which only makes
 * sense if an AS ignoring it is an expected case.
 *
 * WHAT WE KEEP: audience confinement, entirely. The token is minted for exactly one
 * registered application and is useless at any other. A token for someone else's Access app
 * fails here, which is the confused-deputy protection requirement 5 exists to provide.
 * WHAT WE FORGO: cross-AS resource-indicator binding — the ability to distinguish two
 * DIFFERENT resources served by the SAME authorization server. This is a single-tenant
 * personal connector with one resource and one app, so that distinction has nothing to
 * distinguish. If a second resource ever shares this AS, the deviation stops being free and
 * must be revisited.
 * Unset falls back to RESOURCE, so a spec-conformant AS needs no special casing. */
const AUDIENCE = process.env.HANDOFF_RELAY_AUDIENCE || null;

/* RFC 9728 Protected Resource Metadata. The client fetches this to learn WHICH authorization
 * server can issue tokens for us, and MUST then bind the token's audience to `resource`.
 * Audience binding is the point: a token minted for some other service must not open this
 * one, which is precisely how a confused-deputy attack gets in. */
function protectedResourceMetadata() {
  return {
    resource: RESOURCE,
    authorization_servers: AS_ISSUER ? [AS_ISSUER] : [],
    bearer_methods_supported: ['header'],
    scopes_supported: ['handoff.read', 'handoff.write'],
    resource_documentation: 'https://github.com/anthropics/handoff-poc#remote-connector'
  };
}

/* Token validation. Returns {ok, sub, reason}.
 * UNCONFIGURED = REFUSE. Not "allow for now", not "warn and continue". The whole store sits
 * behind this function, and the failure mode of getting it wrong is silent and total. */
async function verifyToken(headers) {
  if (!AS_ISSUER || !JWKS_URL || !RESOURCE) {
    return { ok: false, reason: 'relay_unconfigured', detail: 'no authorization server configured — this relay refuses every call until one is' };
  }
  const h = headers || {};
  /* Two places a token can arrive, because two things can be in front of us:
   *   - Authorization: Bearer …  — the MCP client's own OAuth token (the spec path).
   *   - Cf-Access-Jwt-Assertion  — Cloudflare Access's identity assertion, set at the edge
   *     when the request has already passed the Access application.
   * Both are verified by the SAME rules — issuer, audience, signature, expiry. Neither is
   * trusted for being present: an edge header is only as good as its signature, and if
   * someone reached us without going through the edge, an unsigned header would be theirs
   * to invent. */
  const bearer = /^Bearer\s+(.+)$/i.exec(h.authorization || '');
  const token = (bearer && bearer[1]) || h['cf-access-jwt-assertion'] || null;
  if (!token) return { ok: false, reason: 'no_token' };
  const r = await verifyJwt(token, { issuer: AS_ISSUER, audience: AUDIENCE || RESOURCE, jwksUrl: JWKS_URL });
  if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail };
  return { ok: true, sub: r.sub, claims: r.claims };
}

/* One JSON-RPC call, relayed to the daemon over its control socket, newline-delimited —
 * the framing the forwarder already speaks, so only the remote leg is new (spike §transport).
 * HOME OFFLINE IS AN EXPLICIT ERROR. A silent hang or a stale success would be the same
 * dishonesty the wake tier was just cured of: if the Mac is asleep, say so. */
function relayToDaemon(envelope, timeoutMs = 10000) {
  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    let conn;
    try { conn = net.createConnection(SOCK); } catch (_) {
      return done({ error: 'home_offline', detail: 'the home Mac is not reachable (daemon socket refused)' });
    }
    const timer = setTimeout(() => { try { conn.destroy(); } catch (_) {} done({ error: 'home_timeout', detail: `no reply from home within ${timeoutMs}ms` }); }, timeoutMs);
    let buf = '';
    conn.on('connect', () => conn.write(JSON.stringify(envelope) + '\n'));
    conn.on('data', d => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      try { done(JSON.parse(buf.slice(0, nl))); } catch (e) { done({ error: 'bad_reply', detail: e.message }); }
      try { conn.end(); } catch (_) {}
    });
    conn.on('error', () => { clearTimeout(timer); done({ error: 'home_offline', detail: 'the home Mac is not reachable (daemon socket refused)' }); });
    conn.on('close', () => { clearTimeout(timer); done({ error: 'home_offline', detail: 'the home connection closed before replying' }); });
  });
}

/* THE MCP SURFACE. A remote connector speaks JSON-RPC over Streamable HTTP — initialize,
 * tools/list, tools/call — not a bare "call this daemon verb" passthrough, which is what the
 * first cut did. Kept as a pure function of (message) so it can be exercised without going
 * through the HTTP auth layer: the tests must be able to prove the protocol without ever
 * providing a way to bypass the refusal in production.
 *
 * tools/list serves the SAME schema array the local bridge advertises (handoff-tool-schemas),
 * because a remote surface offering a different tool list from the local one is drift with a
 * network in the middle — invisible until someone calls the verb that only exists on one side.
 *
 * The daemon stays the single serializer: every tools/call is relayed to it and it applies
 * contract checks, load-safety and the identity stamp to a remote caller exactly as to a
 * local one. The relay adds no logic of its own to a call — that is what "stateless" means
 * here, and it is why a remote leg does not fork the store's behaviour. */
const { TOOLS } = require('./handoff-tool-schemas');
const PROTOCOL_VERSION = '2025-06-18';

async function handleMcp(msg, identity) {
  const id = msg && msg.id;
  const ok = result => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0') return err(-32600, 'invalid request: expected JSON-RPC 2.0');

  if (msg.method === 'initialize') {
    return ok({
      protocolVersion: (msg.params && msg.params.protocolVersion) || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'handoff-relay', version: '1.0.0' }
    });
  }
  if (typeof msg.method === 'string' && msg.method.startsWith('notifications/')) return null; // no reply
  if (msg.method === 'ping') return ok({});
  if (msg.method === 'tools/list') return ok({ tools: TOOLS });
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    if (!name) return err(-32602, 'tools/call requires params.name');
    const reply = await relayToDaemon({
      contract: CONTRACT, id: id || 'relay', tool: name, args: (msg.params && msg.params.arguments) || {},
      /* A remote caller holds an ACCOUNT, not a CLI session, so its stamp is honestly
       * `asserted` — account-verified, not session-verified. The door model already has that
       * vocabulary (I12); we do not mint a stronger claim than we hold. */
      ctx: { remote: true, sender_class: 'asserted', account_sub: (identity && identity.sub) || null }
    });
    if (reply && (reply.error === 'home_offline' || reply.error === 'home_timeout')) {
      // Surfaced as a TOOL error, not a transport error: the call reached us and we know
      // precisely why it cannot be served. "The Mac is asleep" is an answer; a hang is not.
      return ok({ content: [{ type: 'text', text: `home-offline: ${reply.detail}` }], isError: true });
    }
    if (reply && reply.error) return ok({ content: [{ type: 'text', text: `Error: ${reply.error}${reply.detail ? ' — ' + reply.detail : ''}` }], isError: true });
    const text = (reply && (reply.result || reply.text)) || '';
    return ok({ content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text) }], isError: false });
  }
  return err(-32601, 'method not found: ' + msg.method);
}

function send(res, code, body, headers) {
  const payload = JSON.stringify(body);
  res.writeHead(code, Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, headers || {}));
  res.end(payload);
}

/* 401 carries WWW-Authenticate pointing at our PRM, which is how a spec-compliant client
 * discovers where to get a token (RFC 9728 §5.1). An opaque 401 would leave it guessing. */
function unauthorized(res, reason, detail) {
  /* The advertised metadata URL must be one we SERVE. Appending the well-known path to
   * RESOURCE was wrong the moment RESOURCE gained its required `/mcp` suffix: it advertised
   * /mcp/.well-known/… , which 404s. Claude would have limped through on its second fallback
   * probe — working by accident, and paying extra round-trips for it. Build from the ORIGIN.
   * (Found by calling the endpoint from the public internet, not by reading this code.) */
  let prm = null;
  if (RESOURCE) {
    try { prm = new URL(RESOURCE).origin + '/.well-known/oauth-protected-resource'; }
    catch (_) { prm = null; }
  }
  send(res, 401, { error: reason, detail: detail || null }, {
    'www-authenticate': `Bearer${prm ? ` resource_metadata="${prm}"` : ''}, error="${reason}"`
  });
}

/* EXIT-ON-STALE, the same doctrine the daemon follows — added 2026-08-10 after this process
 * served pre-change code for ELEVEN HOURS while looking healthy.
 *
 * Measured: the relay booted 19:38:08 and its own file was modified 06:48:44 the next morning. It
 * had loaded the file at boot and never reloaded. handoff-relay.js is not in the daemon's WATCHED
 * set (that covers daemon/core/tools/contract), and the relay had no check of its own, so the new
 * code sat on disk and nowhere else.
 *
 * WHAT MADE IT DANGEROUS was not the staleness, it was that the artifact kept being produced. The
 * access log was enabled and growing — 145 well-formed lines of real client traffic — while missing
 * the one field a pending design decision depended on. Not malformed: ABSENT. Anyone checking would
 * have found a healthy log and concluded "no traffic yet, check later" rather than "the process
 * serving this cannot produce it". A growing log file is not the measurement, exactly as an exit
 * status is not an effect.
 *
 * Refuse, report, exit — launchd restarts with the new code. Deliberately NOT a hot-reload: this
 * process holds live client connections and swapping module state under them is the mixed-version
 * corruption the daemon spec forbids for the same reason.
 *
 * Staleness is "differs from the mtime captured at BOOT", never "mtime > start". A file dated in
 * the future satisfies the latter forever and would put launchd in a restart loop; "differs from
 * what I loaded" cannot. That lesson is already paid for on the daemon side. */
const RELAY_WATCHED = [__filename, require.resolve('./handoff-contract')];
const relayMtime = f => { try { return fs.statSync(f).mtimeMs; } catch (_) { return 0; } };
const RELAY_BOOT_MTIMES = new Map(RELAY_WATCHED.map(f => [f, relayMtime(f)]));
function relayStaleFile() {
  for (const f of RELAY_WATCHED) if (relayMtime(f) !== RELAY_BOOT_MTIMES.get(f)) return path.basename(f);
  return null;
}

const server = http.createServer(async (req, res) => {
  /* Checked per request rather than on a timer: a relay with no traffic is not serving anything
   * stale, and the first request after a deploy is exactly when it matters. */
  const staleRelay = relayStaleFile();
  if (staleRelay) {
    // eslint-disable-next-line no-console
    console.error(`handoff-relay: ${staleRelay} changed since boot — exiting for restart with current code (pid ${process.pid})`);
    try {
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '2' });
      res.end(JSON.stringify({ error: 'relay_stale', detail: `${staleRelay} changed since this relay booted; it is restarting with current code` }));
    } catch (_) {}
    setImmediate(() => { try { server.close(); } catch (_) {} process.exit(0); });
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  /* ACCESS LOG, opt-in. An operator debugging "my client cannot reach the server" needs to
   * know whether requests ARRIVE at all — the difference between a routing problem upstream
   * and a refusal here is the whole diagnosis, and without this you are guessing. Logs the
   * request line, whether a token was present, and the status; never the token itself. */
  let rpcMethod = '-'; // set once the body is parsed; harmless when the request carries none
  if (process.env.HANDOFF_RELAY_ACCESS_LOG) {
    const started = Date.now();
    const auth = req.headers.authorization ? 'bearer' : (req.headers['cf-access-jwt-assertion'] ? 'cf-access' : 'none');
    /* Mcp-Session-Id, logged to answer ONE question that gates a design decision: does the Claude
     * app open a DISTINCT transport session per conversation, or one shared across all of them?
     *
     * It decides whether identity can be pinned to a connection. Distinct per conversation → the
     * pin is very nearly conversation identity, and a chat stops having to remember and re-assert
     * its own record id on every call. Shared → pinning cannot tell two concurrent chats apart and
     * must NOT auto-attach, or one conversation inherits another's identity, which is the wrong-
     * match class with a much larger blast radius than a mis-resolved name.
     *
     * A HEADER VALUE IS AN OPAQUE HANDLE, NOT A SECRET, but it is still someone's session, so only
     * a short prefix is written — enough to tell two sessions apart and to see one persist across
     * calls, never enough to replay. Absent is logged as "none", which is itself the answer if this
     * client does not use streamable-HTTP session ids at all. */
    const mcpSession = (() => {
      const v = req.headers['mcp-session-id'];
      return v ? String(v).slice(0, 8) : 'none';
    })();
    res.on('finish', () => {
      try {
        require('fs').appendFileSync(process.env.HANDOFF_RELAY_ACCESS_LOG,
          `${new Date().toISOString()} ${req.method} ${url.pathname} token=${auth} → ${res.statusCode} ${Date.now() - started}ms ua=${(req.headers['user-agent'] || '-').slice(0, 60)} mcp-session=${mcpSession} rpc=${rpcMethod}\n`);
      } catch (_) {}
    });
  }

  // Liveness, unauthenticated ON PURPOSE and deliberately empty of protocol facts: it says
  // the relay is up and whether home answers, and nothing about what is in the store.
  if (req.method === 'GET' && url.pathname === '/healthz') {
    const home = await relayToDaemon({ contract: CONTRACT, id: 'health', tool: '__ping__', args: {}, ctx: {} }, 2000);
    const homeUp = !(home && (home.error === 'home_offline' || home.error === 'home_timeout'));
    return send(res, 200, { relay: 'up', home: homeUp ? 'reachable' : 'offline', configured: !!(AS_ISSUER && JWKS_URL && RESOURCE) });
  }

  /* Anthropic probes /.well-known/oauth-protected-resource/<mcp-path> FIRST, then the bare
   * path. Serve both, so discovery succeeds on the first request rather than the second. */
  if (req.method === 'GET' && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
    return send(res, 200, protectedResourceMetadata());
  }

  /* GET /mcp — the Streamable HTTP transport's SSE leg. We do not offer a server-initiated
   * stream (every reply is a direct JSON response to a POST), and the spec allows saying so.
   * It must NOT fall through to the catch-all 404: a 404 means "no such endpoint", which is
   * why a connector reported "please verify the server URL" about a URL that was correct.
   * Found by an access log showing GET /mcp → 404 three times while the POST leg answered
   * perfectly. Unauthenticated still gets the 401 challenge, so discovery is unchanged; an
   * authenticated GET gets an honest 405 naming what the endpoint accepts. */
  if (req.method === 'GET' && url.pathname === '/mcp') {
    const auth = await verifyToken(req.headers);
    if (!auth.ok) return unauthorized(res, auth.reason, auth.detail);
    return send(res, 405, { error: 'method_not_allowed', detail: 'this server replies to POST; it does not offer a server-initiated SSE stream' }, { allow: 'POST' });
  }

  if (req.method === 'POST' && url.pathname === '/mcp') {
    const auth = await verifyToken(req.headers);
    if (!auth.ok) return unauthorized(res, auth.reason, auth.detail);
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e6) req.destroy(); });
    return req.on('end', async () => {
      let rpc;
      try { rpc = JSON.parse(body); } catch (_) { return send(res, 400, { error: 'invalid_json' }); }
      // For the access log only: initialize vs tools/call is what makes a session's lifecycle
      // legible — one initialize followed by many tools/call on one Mcp-Session-Id is a persistent
      // connection; repeated initializes are a client reconnecting per request.
      if (rpc && typeof rpc.method === 'string') rpcMethod = rpc.method;
      const out = await handleMcp(rpc, auth);
      // A notification carries no reply: 202, empty body, per JSON-RPC.
      if (out === null) return res.writeHead(202).end();
      return send(res, 200, out);
    });
  }

  send(res, 404, { error: 'not_found' });
});

if (require.main === module) {
  // LOOPBACK ONLY. The tunnel is the only way in, so a misconfigured firewall cannot expose
  // this directly, and the relay is never reachable on the LAN by accident.
  server.listen(PORT, '127.0.0.1', () => {
    const configured = !!(AS_ISSUER && JWKS_URL && RESOURCE);
    /* THE RESOURCE MUST MATCH THE URL THE USER TYPES, EXACTLY — including the path.
     * Anthropic's connector docs: the protected resource metadata `resource` field "must
     * match your MCP server URL exactly as the user enters it in Claude, including any path
     * component." A mismatch does not fail loudly at the mismatch; it surfaces much later as
     * "Couldn't reach the MCP server", with the authorization server seeing no traffic at
     * all. So we say it at startup, where it is cheap to notice. */
    if (RESOURCE && !/\/mcp$/.test(RESOURCE)) {
      process.stdout.write(`[handoff-relay] ⚠ HANDOFF_RELAY_RESOURCE is "${RESOURCE}" but the MCP endpoint is /mcp.\n` +
        '[handoff-relay]   If the user types <origin>/mcp into Claude, this MUST be <origin>/mcp too — the\n' +
        '[handoff-relay]   metadata `resource` has to match what they typed, path included, or discovery fails late.\n');
    }
    process.stdout.write(`[handoff-relay] listening on 127.0.0.1:${PORT} · home=${SOCK}\n`);
    process.stdout.write(configured
      ? '[handoff-relay] auth configured\n'
      : '[handoff-relay] REFUSING ALL CALLS — no authorization server configured (set HANDOFF_RELAY_AS / _JWKS / _RESOURCE)\n');
  });
}

module.exports = { server, protectedResourceMetadata, verifyToken, relayToDaemon, handleMcp, PORT };
