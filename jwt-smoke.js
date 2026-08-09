#!/usr/bin/env node
'use strict';
/**
 * jwt-smoke — the door, tested as a door.
 *
 * Real key pairs, real signatures, a real (in-memory) JWKS. No network, no mocked crypto:
 * a token verifier tested against a stubbed verifier proves nothing, which is the same
 * fixture-honesty lesson the wake tier learned the hard way.
 *
 * Most of these are attacks. That is the point — the interesting behaviour of a door is
 * what it refuses.
 *
 * Run: node jwt-smoke.js
 */
const crypto = require('crypto');
const assert = require('assert');
const { verifyJwt } = require('./handoff-jwt');

let pass = 0, fail = 0;
const test = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log(`  ok   ${name}`); },
  e => { fail++; console.log(`  FAIL ${name}\n       ${e && e.message}`); });

const ISS = 'https://your-team.cloudflareaccess.com';
const AUD = 'https://handoff-store.example.com';
const JWKS = 'https://your-team.cloudflareaccess.com/cdn-cgi/access/certs';

const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// A real RSA key pair, and its public half published as a JWK — the shape Access serves.
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaJwk = Object.assign(rsa.publicKey.export({ format: 'jwk' }), { kid: 'k1', alg: 'RS256', use: 'sig' });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }); // an attacker's key

function sign(claims, { key = rsa.privateKey, alg = 'RS256', kid = 'k1' } = {}) {
  const h = b64u(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const p = b64u(JSON.stringify(claims));
  if (alg === 'none') return `${h}.${p}.`;
  const s = crypto.createSign('RSA-SHA256');
  s.update(`${h}.${p}`); s.end();
  return `${h}.${p}.${s.sign(key).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

const nowSec = Math.floor(Date.now() / 1000);
const good = { iss: ISS, aud: AUD, sub: 'owner@example.invalid', exp: nowSec + 600, nbf: nowSec - 10 };
let fetchCount = 0;
const fetcher = async () => { fetchCount++; return { keys: [rsaJwk] }; };
const opts = { issuer: ISS, audience: AUD, jwksUrl: JWKS, fetcher };

(async () => {
  console.log('jwt-smoke:');

  await test('a correctly signed, correctly audienced token is ACCEPTED', async () => {
    const r = await verifyJwt(sign(good), opts);
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(r.sub, 'owner@example.invalid');
  });

  // ---- attack 1: alg:none ----
  await test('alg:none is refused — a token does not get to declare itself trustworthy', async () => {
    const r = await verifyJwt(sign(good, { alg: 'none' }), opts);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'alg_not_allowed');
  });

  // ---- attack 2: HS/RS confusion ----
  await test('HS256 is refused outright — we never verify with a shared secret', async () => {
    const h = b64u(JSON.stringify({ alg: 'HS256', kid: 'k1', typ: 'JWT' }));
    const p = b64u(JSON.stringify(good));
    const mac = crypto.createHmac('sha256', JSON.stringify(rsaJwk)).update(`${h}.${p}`).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const r = await verifyJwt(`${h}.${p}.${mac}`, opts);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'alg_not_allowed', 'the classic key-confusion attack must die at the algorithm check');
  });

  // ---- attack 3: confused deputy (RFC 8707) ----
  await test('a token minted for ANOTHER service is refused, however valid its signature', async () => {
    const r = await verifyJwt(sign(Object.assign({}, good, { aud: 'https://someone-elses-app.example' })), opts);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'wrong_audience');
  });

  await test('an aud ARRAY containing our resource is accepted; one without it is not', async () => {
    const withUs = await verifyJwt(sign(Object.assign({}, good, { aud: ['https://other', AUD] })), opts);
    assert.strictEqual(withUs.ok, true, withUs.reason);
    const without = await verifyJwt(sign(Object.assign({}, good, { aud: ['https://other', 'https://third'] })), opts);
    assert.strictEqual(without.ok, false);
    assert.strictEqual(without.reason, 'wrong_audience');
  });

  // ---- signature and issuer ----
  await test('a token signed by a DIFFERENT key is refused', async () => {
    const r = await verifyJwt(sign(good, { key: other.privateKey }), opts);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'bad_signature');
  });

  await test('a valid signature from the WRONG issuer is refused', async () => {
    const r = await verifyJwt(sign(Object.assign({}, good, { iss: 'https://evil.example' })), opts);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'wrong_issuer');
  });

  await test('a tampered payload breaks the signature', async () => {
    const t = sign(good).split('.');
    t[1] = b64u(JSON.stringify(Object.assign({}, good, { sub: 'intruder@example.invalid' })));
    const r = await verifyJwt(t.join('.'), opts);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'bad_signature');
  });

  // ---- time ----
  await test('an expired token is refused', async () => {
    const r = await verifyJwt(sign(Object.assign({}, good, { exp: nowSec - 3600 })), opts);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'expired');
  });

  await test('a not-yet-valid token is refused', async () => {
    const r = await verifyJwt(sign(Object.assign({}, good, { nbf: nowSec + 3600 })), opts);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'not_yet_valid');
  });

  // ---- key rotation, and its denial-of-service edge ----
  await test('an unknown kid triggers exactly ONE refetch, then gives up', async () => {
    const before = fetchCount;
    const r = await verifyJwt(sign(good, { kid: 'rotated-away' }), opts);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'unknown_key');
    assert.ok(fetchCount - before <= 1, `refetched ${fetchCount - before} times; an attacker-chosen kid must not become a DoS on the JWKS endpoint`);
  });

  // ---- shape ----
  await test('malformed input is refused without throwing', async () => {
    for (const bad of ['', 'x', 'a.b', 'a.b.c.d', null, undefined, 42]) {
      const r = await verifyJwt(bad, opts);
      assert.strictEqual(r.ok, false, `should refuse: ${String(bad)}`);
    }
  });

  await test('an unconfigured verifier refuses even a perfect token', async () => {
    const r = await verifyJwt(sign(good), { issuer: ISS, audience: AUD /* no jwksUrl */ });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'verifier_unconfigured');
  });

  console.log(`\njwt-smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
