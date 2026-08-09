'use strict';
/* JWT verification for the t27 relay — zero dependencies, asymmetric only.
 *
 * This is the whole door. Everything in the store sits behind it, so it is written to
 * REFUSE by default and to refuse loudly: every failure returns a reason, and no failure
 * path falls through to success.
 *
 * The three attacks this shape exists to stop, each of which has broken real systems:
 *   1. alg:none — a token that says "I am unsigned, trust me". We allowlist algorithms
 *      rather than reading the header's word for it.
 *   2. HS/RS confusion — an attacker signs HS256 using the PUBLIC key as the HMAC secret.
 *      Symmetric algorithms are refused outright; we never verify with a shared secret.
 *   3. Confused deputy — a token minted for a DIFFERENT service, replayed at us. RFC 8707
 *      audience binding is the answer: `aud` must contain OUR resource identifier, exactly.
 *
 * Node's crypto verifies from a JWK directly (createPublicKey), so no JWT library is
 * needed — which keeps the zero-dependency rule and, more usefully, keeps the security
 * decisions visible in this file instead of behind someone else's defaults.
 */
const crypto = require('crypto');
const https = require('https');

// Asymmetric only. HS* would mean verifying with a shared secret — see attack 2.
const ALLOWED_ALGS = {
  RS256: { alg: 'RSA-SHA256', pad: crypto.constants.RSA_PKCS1_PADDING },
  RS512: { alg: 'RSA-SHA512', pad: crypto.constants.RSA_PKCS1_PADDING },
  ES256: { alg: 'sha256', ec: true },
  ES384: { alg: 'sha384', ec: true }
};

const b64uToBuf = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const jsonPart = s => { try { return JSON.parse(b64uToBuf(s).toString('utf8')); } catch (_) { return null; } };

/* JWKS cache. Keyed by URL, with a TTL and a refresh-on-unknown-kid path: key rotation is
 * normal, so an unknown kid means "re-fetch once", not "reject forever". The cache is
 * process-local and expendable — it is a cache, never an address (§I2b): every use
 * re-validates against what the endpoint says now once the TTL is out. */
const JWKS_CACHE = new Map(); // url -> { at, keys }
const JWKS_TTL_MS = 10 * 60 * 1000;

function fetchJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`JWKS fetch ${res.statusCode}`)); }
      let b = ''; res.setEncoding('utf8');
      res.on('data', d => { b += d; if (b.length > 1e6) req.destroy(new Error('JWKS too large')); });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('JWKS fetch timeout')));
    req.on('error', reject);
  });
}

async function getKeys(jwksUrl, { force = false, fetcher = fetchJson } = {}) {
  const hit = JWKS_CACHE.get(jwksUrl);
  if (!force && hit && (Date.now() - hit.at) < JWKS_TTL_MS) return hit.keys;
  const doc = await fetcher(jwksUrl);
  const keys = (doc && Array.isArray(doc.keys)) ? doc.keys : [];
  JWKS_CACHE.set(jwksUrl, { at: Date.now(), keys });
  return keys;
}

function verifySignature(alg, signingInput, sigB64u, jwk) {
  const spec = ALLOWED_ALGS[alg];
  if (!spec) return false;
  let key;
  try { key = crypto.createPublicKey({ key: jwk, format: 'jwk' }); } catch (_) { return false; }
  const sig = b64uToBuf(sigB64u);
  if (spec.ec) {
    // JWS ES* signatures are raw r||s; Node expects DER unless told otherwise.
    return crypto.verify(spec.alg, Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' }, sig);
  }
  const v = crypto.createVerify(spec.alg);
  v.update(signingInput);
  v.end();
  return v.verify(key, sig);
}

/**
 * Verify a JWT. Returns { ok, sub, claims } or { ok:false, reason, detail }.
 * `audience` is the RESOURCE identifier this relay is known by — RFC 8707. A token whose
 * `aud` does not contain it was minted for someone else and must not open this door,
 * however valid its signature.
 */
async function verifyJwt(token, opts) {
  const { issuer, audience, jwksUrl, now = Date.now(), clockSkewSec = 60, fetcher } = opts || {};
  if (!issuer || !audience || !jwksUrl) return { ok: false, reason: 'verifier_unconfigured' };
  if (typeof token !== 'string') return { ok: false, reason: 'no_token' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed_token' };
  const header = jsonPart(parts[0]);
  const claims = jsonPart(parts[1]);
  if (!header || !claims) return { ok: false, reason: 'malformed_token' };

  // Attack 1 and 2, closed before any key is even looked up.
  if (!header.alg || !ALLOWED_ALGS[header.alg]) {
    return { ok: false, reason: 'alg_not_allowed', detail: `algorithm "${header.alg}" is refused; asymmetric only` };
  }

  const signingInput = parts[0] + '.' + parts[1];
  let keys = await getKeys(jwksUrl, { fetcher });
  let jwk = keys.find(k => !header.kid || k.kid === header.kid);
  if (!jwk) {
    // Unknown kid: keys rotate. Re-fetch ONCE, then give up — an unbounded refetch loop on
    // an attacker-chosen kid is a free denial-of-service against the JWKS endpoint.
    keys = await getKeys(jwksUrl, { force: true, fetcher });
    jwk = keys.find(k => !header.kid || k.kid === header.kid);
  }
  if (!jwk) return { ok: false, reason: 'unknown_key', detail: `no JWKS key for kid "${header.kid}"` };

  if (!verifySignature(header.alg, signingInput, parts[2], jwk)) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Only now are the claims worth reading: an unverified claim is an assertion by a stranger.
  if (claims.iss !== issuer) return { ok: false, reason: 'wrong_issuer', detail: `issued by "${claims.iss}"` };

  const aud = Array.isArray(claims.aud) ? claims.aud : (claims.aud ? [claims.aud] : []);
  if (!aud.includes(audience)) {
    return { ok: false, reason: 'wrong_audience', detail: 'this token was minted for another service (RFC 8707 audience binding)' };
  }

  const nowSec = Math.floor(now / 1000);
  if (typeof claims.exp === 'number' && nowSec > claims.exp + clockSkewSec) return { ok: false, reason: 'expired' };
  if (typeof claims.nbf === 'number' && nowSec + clockSkewSec < claims.nbf) return { ok: false, reason: 'not_yet_valid' };

  return { ok: true, sub: claims.sub || claims.email || null, claims };
}

module.exports = { verifyJwt, getKeys, ALLOWED_ALGS, _cache: JWKS_CACHE };
