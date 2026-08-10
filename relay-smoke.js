#!/usr/bin/env node
'use strict';
/**
 * relay-smoke — t27 sub-step 1. Proves the relay's SAFETY properties, not its features.
 *
 * The thing this file exists to prevent: a relay that appears to work because auth was not
 * wired yet. That relay would publish the whole protocol store — every conversation,
 * decision and artifact — to the public internet, and it would look like success while
 * doing it. So the assertions below are mostly refusals.
 *
 * Run: node relay-smoke.js
 */
const http = require('http');
const os = require('os');
const path = require('path');
const assert = require('assert');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log(`  ok   ${name}`); },
    e => { fail++; console.log(`  FAIL ${name}\n       ${e && e.message}`); });
}

const PORT = 8790 + (process.pid % 50); // avoid collisions with a live relay
function req(opts, body) {
  return new Promise(r => {
    const q = http.request(Object.assign({ host: '127.0.0.1', port: PORT }, opts), s => {
      let b = ''; s.on('data', d => b += d);
      s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} r({ code: s.statusCode, hdr: s.headers, body: b, json: j }); });
    });
    q.on('error', e => r({ err: e.message }));
    if (body) q.write(body);
    q.end();
  });
}

(async () => {
  console.log('relay-smoke:');
  process.env.HANDOFF_RELAY_PORT = String(PORT);
  process.env.HANDOFF_DAEMON_SOCK = path.join(os.tmpdir(), 'relay-smoke-no-daemon-' + process.pid + '.sock');
  delete process.env.HANDOFF_RELAY_AS;
  delete process.env.HANDOFF_RELAY_JWKS;
  delete process.env.HANDOFF_RELAY_RESOURCE;
  const relay = require('./handoff-relay');
  await new Promise(r => relay.server.listen(PORT, '127.0.0.1', r));

  // ---- fail closed ----
  await test('unconfigured: a call with NO token is refused 401', async () => {
    const r = await req({ method: 'POST', path: '/mcp' }, '{"method":"status"}');
    assert.strictEqual(r.code, 401);
    assert.strictEqual(r.json.error, 'relay_unconfigured');
  });

  await test('unconfigured: a call WITH a bearer token is refused too — absence of config is never permission', async () => {
    const r = await req({ method: 'POST', path: '/mcp', headers: { authorization: 'Bearer eyJ.looks.real' } }, '{"method":"status"}');
    assert.strictEqual(r.code, 401, 'a syntactically valid token must not pass an unconfigured relay');
    assert.strictEqual(r.json.error, 'relay_unconfigured');
  });

  await test('401 carries WWW-Authenticate so a spec client can discover where to get a token', async () => {
    const r = await req({ method: 'POST', path: '/mcp' }, '{}');
    assert.match(r.hdr['www-authenticate'] || '', /^Bearer/);
  });

  // ---- RFC 9728 discovery ----
  await test('PRM is served at the well-known path and declares audience + scopes', async () => {
    const r = await req({ method: 'GET', path: '/.well-known/oauth-protected-resource' });
    assert.strictEqual(r.code, 200);
    assert.ok(Array.isArray(r.json.authorization_servers), 'authorization_servers must be present');
    assert.deepStrictEqual(r.json.scopes_supported, ['handoff.read', 'handoff.write']);
  });

  // ---- offline honesty ----
  await test('home offline is stated explicitly, never a hang or a stale success', async () => {
    const r = await req({ method: 'GET', path: '/healthz' });
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.json.home, 'offline', 'the daemon socket does not exist in this fixture');
    assert.strictEqual(r.json.relay, 'up', 'and the relay still answers — the two facts are separate');
  });

  await test('healthz leaks NO protocol facts — it is unauthenticated on purpose', async () => {
    const r = await req({ method: 'GET', path: '/healthz' });
    const keys = Object.keys(r.json).sort();
    assert.deepStrictEqual(keys, ['configured', 'home', 'relay'],
      'liveness may say up/offline/configured and nothing else — no titles, ids, or counts');
  });

  await test('an unknown path is a plain 404, with no hint of what else exists', async () => {
    const r = await req({ method: 'GET', path: '/store' });
    assert.strictEqual(r.code, 404);
    assert.deepStrictEqual(Object.keys(r.json), ['error']);
  });

  /* ---- the MCP surface, exercised directly ----
   * Through handleMcp, NOT through HTTP: the protocol must be provable without ever adding
   * a way to bypass the refusal in production. The HTTP door stays shut in every test above. */
  await test('initialize answers with a protocol version and server info', async () => {
    const r = await relay.handleMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.ok(r.result.protocolVersion, 'must state a protocol version');
    assert.strictEqual(r.result.serverInfo.name, 'handoff-relay');
    assert.ok(r.result.capabilities.tools, 'declares the tools capability');
  });

  await test('tools/list serves the SAME schemas the local bridge advertises', async () => {
    const r = await relay.handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const local = require('./handoff-tool-schemas').TOOLS;
    assert.strictEqual(r.result.tools.length, local.length, 'a remote list that differs from the local one is drift with a network in the middle');
    assert.deepStrictEqual(r.result.tools.map(t => t.name).sort(), local.map(t => t.name).sort());
  });

  await test('the retired verb is absent remotely too — one public send verb everywhere', async () => {
    const r = await relay.handleMcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const names = r.result.tools.map(t => t.name);
    assert.ok(names.includes('send_to'), 'send_to is the verb');
    assert.ok(!names.includes('send_to_surface'), 'the demoted name must not reappear on the remote surface');
  });

  await test('a non-JSON-RPC message is refused, not guessed at', async () => {
    const r = await relay.handleMcp({ id: 4, method: 'tools/list' });
    assert.strictEqual(r.error.code, -32600);
  });

  await test('an unknown method is -32601, never silently ignored', async () => {
    const r = await relay.handleMcp({ jsonrpc: '2.0', id: 5, method: 'store/dump' });
    assert.strictEqual(r.error.code, -32601);
  });

  await test('notifications get no reply at all', async () => {
    const r = await relay.handleMcp({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.strictEqual(r, null);
  });

  await test('tools/call with home offline returns an isError result naming home-offline', async () => {
    const r = await relay.handleMcp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'status', arguments: {} } });
    assert.strictEqual(r.result.isError, true);
    assert.match(r.result.content[0].text, /home-offline/, 'the Mac being asleep is an ANSWER; a hang is not');
  });

  /* The NAMED DEVIATION, pinned as behaviour so it cannot quietly drift back.
   * We bind audience to the Access client_id because Access does not consume RFC 8707
   * `resource`. Confinement is preserved: a token for another app still fails. */
  await test('audience: HANDOFF_RELAY_AUDIENCE overrides the resource URI when set', async () => {
    const jwt = require('./handoff-jwt');
    const crypto = require('crypto');
    const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = Object.assign(kp.publicKey.export({ format: 'jwk' }), { kid: 'a1', alg: 'RS256', use: 'sig' });
    const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const mk = aud => {
      const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'a1', typ: 'JWT' }));
      const p = b64u(JSON.stringify({ iss: 'https://team.cloudflareaccess.com', aud, sub: 'x', exp: Math.floor(Date.now() / 1000) + 300 }));
      const sg = crypto.createSign('RSA-SHA256'); sg.update(`${h}.${p}`); sg.end();
      return `${h}.${p}.${sg.sign(kp.privateKey).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
    };
    const o = { issuer: 'https://team.cloudflareaccess.com', jwksUrl: 'https://team.cloudflareaccess.com/certs', fetcher: async () => ({ keys: [jwk] }) };
    const CLIENT_ID = 'abc123.access';
    const good = await jwt.verifyJwt(mk(CLIENT_ID), Object.assign({ audience: CLIENT_ID }, o));
    assert.strictEqual(good.ok, true, 'an Access token audienced to the client_id is accepted: ' + good.reason);
    const other = await jwt.verifyJwt(mk('someone-elses-app'), Object.assign({ audience: CLIENT_ID }, o));
    assert.strictEqual(other.ok, false, 'confinement is KEPT — another app\'s token still fails');
    assert.strictEqual(other.reason, 'wrong_audience');
  });

  await new Promise(r => relay.server.close(r));
  
/* EXIT-ON-STALE — the relay served pre-change code for ELEVEN HOURS while looking healthy, because
 * it had no staleness check and nothing else watched its file. The dangerous part was not the
 * staleness but that the artifact kept being produced: the access log grew with 145 well-formed
 * lines of real traffic, missing the one field a design decision depended on. ABSENT, not
 * malformed — which reads as "no traffic yet" rather than "this process cannot produce it".
 *
 * Asserted at the SOURCE level rather than by bouncing a live relay: the process exits on detect,
 * so exercising it would mean killing a server mid-test, and the property worth guarding is that
 * the check exists, watches the right files, and compares against BOOT rather than a threshold. */
{
  const src = require('fs').readFileSync(require('path').join(__dirname, 'handoff-relay.js'), 'utf8');
  await test('stale: the relay checks its own freshness at all', () => {
    assert.match(src, /relayStaleFile/, 'a long-lived process with no staleness check serves old code silently');
  });
  await test('stale: staleness is measured against BOOT mtimes, never "newer than start"', () => {
    assert.match(src, /RELAY_BOOT_MTIMES/, 'captures what it loaded');
    assert.ok(!/mtimeMs\s*>\s*START/.test(src),
      'a threshold comparison never recovers: a future-dated file satisfies it forever and loops the service manager');
  });
  await test('stale: it refuses and exits rather than hot-reloading under live connections', () => {
    assert.match(src, /relay_stale/, 'the refusal is named so a client can tell it apart from a crash');
    assert.match(src, /503/, 'refuses with a retryable status rather than serving stale answers');
  });
  await test('stale: the contract file is watched too, not only the relay itself', () => {
    assert.match(src, /require\.resolve\('\.\/handoff-contract'\)/,
      'a contract change the relay has not loaded is the same defect one file over');
  });
}

console.log(`\nrelay-smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
