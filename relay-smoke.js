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
let SESSION_ID = null; // issued by the server in the session-contract tests below
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
    assert.match(r.result.content[0].text, /did not run|Safe to retry/i,
      'offline means NOTHING was delivered — say so, because the caller\'s next move depends on it');
    assert.doesNotMatch(r.result.content[0].text, /MAY HAVE LANDED/,
      'offline must NOT carry the timeout\'s warning — the two are opposite facts');
  });

  /* A TIMEOUT IS NOT AN OFFLINE, AND SAYING SO IS THE WHOLE FIX. Both used to render as
   * "home-offline", which reads as "nothing happened". Measured 2026-08-10: three send_to_worker
   * calls returned that error having ALREADY DISPATCHED — record written, process running, access
   * log showing 200 in 10004ms. A caller that believes it and retries creates duplicate workers.
   * Exit-status-is-not-effect, living in the last place anyone looks for it: the error path. */
  await test('a home TIMEOUT says the request may have landed, and refuses to imply otherwise', async () => {
    const t = relay.homeErrorText({ error: 'home_timeout', detail: 'no reply from home within 10000ms' });
    assert.match(t, /MAY HAVE LANDED/, 'a delivered-but-unanswered request may have completed — the caller must be told');
    assert.match(t, /verify by effect/i, '...and told what to do instead of retrying blind');
    assert.doesNotMatch(t, /^home-offline/, 'it must not claim the opposite fact');
    const off = relay.homeErrorText({ error: 'home_offline', detail: 'daemon socket refused' });
    assert.doesNotMatch(off, /MAY HAVE LANDED/, 'and offline must not borrow the timeout\'s warning');
    assert.notStrictEqual(off, t, 'two opposite facts must not render as the same sentence — that was the bug');
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

  /* THE FOUR ASSERTIONS ABOVE PASSED GREEN FOR A DAY WHILE THIS GUARD WAS INERT, and that is the
   * lesson worth more than the bug. `fs` was never required in handoff-relay.js, so fs.statSync
   * threw ReferenceError, a bare `catch (_)` swallowed it, and relayMtime returned 0 for the boot
   * snapshot AND every later check — 0 === 0 forever. Every source-level assertion about shape
   * remained true; the behaviour was dead.
   *
   * Found by experiment, not by reading: the daemon's identical guard fired twelve times that day
   * while this one had never fired once, so the relay was bounced, its file touched to be strictly
   * newer than boot, and one request made — served in 54ms, no exit, no log.
   *
   * These two assert the VALUE. A boot mtime of 0 for a file we are executing is impossible unless
   * the check is broken, and that single comparison would have caught it on day one. */
  await test('stale: the boot snapshot holds a REAL mtime — 0 for a file we are executing means the check is broken', () => {
    const boot = relay.__relayBootMtime();
    assert.ok(typeof boot === 'number' && boot > 0,
      `boot mtime was ${boot} — relayMtime is swallowing an error and returning a value that means "unchanged" forever`);
  });
  await test('stale: a file newer than boot is actually DETECTED, not merely watched', () => {
    const fs2 = require('fs'), p2 = require('path');
    const target = p2.join(__dirname, 'handoff-relay.js');
    const before = fs2.statSync(target);
    assert.strictEqual(relay.relayStaleFile(), null, 'unchanged must read as fresh, or the guard loops the service manager');
    const future = new Date(Date.now() + 60000);
    fs2.utimesSync(target, future, future);
    try {
      assert.strictEqual(relay.relayStaleFile(), 'handoff-relay.js',
        'a changed file must be NAMED — this is the whole behaviour, and it was absent while four shape assertions passed');
    } finally {
      fs2.utimesSync(target, before.atime, before.mtime); // leave the tree exactly as found
    }
  });
}

/* TRANSPORT SESSION CONTRACT.
 *
 * ASSERTED AT SOURCE LEVEL, AND HERE IS WHAT THAT DOES NOT PROVE. This suite runs against an
 * UNCONFIGURED relay on purpose — no HANDOFF_RELAY_AS — so every /mcp POST is refused 401 before
 * reaching the handler. That is the right default (an unconfigured relay must refuse everything)
 * and it means these cannot exercise the session contract over the wire. My first version tried and
 * failed five-for-five against the 401.
 *
 * So these guard the SHAPE: that an id is issued on initialize, that an echoed id is honoured, that
 * an unknown one is refused with the spec's 404 rather than silently accepted, and that absence is
 * tolerated. The BEHAVIOUR is confirmed elsewhere and better — by the production access log, where
 * a real client's requests either carry mcp-session=<prefix> or do not. That is the measurement
 * anyway, so the honest division is: the test stops the contract being edited into a half-
 * implementation, the log says what the client actually does. Neither substitutes for the other,
 * and I would rather write that down than let a green suite imply the wire was tested. */
{
  const src = require('fs').readFileSync(require('path').join(__dirname, 'handoff-relay.js'), 'utf8');
  await test('session: an id is ISSUED on the initialize response', () => {
    assert.match(src, /rpc\.method === 'initialize'[\s\S]{0,400}'mcp-session-id': sid/,
      'the server assigns it; a client has nothing to echo otherwise, which is what made the first measurement read our omission as the client\'s design');
  });
  await test('session: an echoed id is HONOURED rather than ignored', () => {
    assert.match(src, /knownSession\(echoed\)[\s\S]{0,120}touchSession\(echoed\)/,
      'issuing an id and then ignoring it on receipt is a field that exists and means nothing');
  });
  await test('session: an UNKNOWN id gets the spec 404, not silent acceptance', () => {
    assert.match(src, /session_not_found/, 'the refusal names itself so a compliant client re-initializes cleanly');
    assert.match(src, /!knownSession\(echoed\)[\s\S]{0,200}404/, 'unknown must be refused, not tolerated');
  });
  await test('session: absence of the header is TOLERATED, never an error', () => {
    assert.match(src, /const echoed = req\.headers\['mcp-session-id'\] \? String[\s\S]{0,40}: null/,
      'requiring it would break every client that keeps no session — including, possibly, the one we are measuring');
  });
  await test('session: ids are random and opaque, and only a prefix is ever logged', () => {
    assert.match(src, /randomBytes\(16\)/, 'an id names a connection, not a person; nothing is derived from it');
    assert.match(src, /String\(v\)\.slice\(0, 8\)/, 'only a prefix reaches the log — enough to tell two apart, never enough to replay');
  });
  await test('session: the table is bounded, so a long-lived relay cannot accumulate ids forever', () => {
    assert.match(src, /pruneSessions/, 'unbounded growth in a process that runs for weeks is a slow leak');
  });
}


console.log(`\nrelay-smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
