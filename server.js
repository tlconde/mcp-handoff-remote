#!/usr/bin/env node
/**
 * server.js — PITCH-ONLY thin HTTP wrapper around handoff-core.
 *
 * The product is the MCP (mcp-handoff.js), which requires handoff-core directly:
 * no server needed for daily use. Run this only to show the mockup UI
 * (http://localhost:4567) — it visualizes the SAME shared store the MCP writes
 * (~/.claude-handoff/), so the pitch shows your real workers.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
// Store isolation (trial t10): the pitch UI seeds demo data — it must NEVER share the
// live product store. Default to a separate demo store unless explicitly overridden.
if (!process.env.HANDOFF_HOME) {
  process.env.HANDOFF_HOME = path.join(require('os').homedir(), '.claude-handoff-demo');
}
const core = require('./handoff-core');

const PORT = process.env.PORT || 4567;
const UI = path.join(__dirname, 'claude-handoff-poc.html');

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(Object.assign(e, { status: 400 })); } });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST', 'access-control-allow-headers': 'content-type' });
    return res.end();
  }
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/app')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(fs.readFileSync(UI));
  }
  try {
    const r = await core.handleApi(req.method, u.pathname, Object.fromEntries(u.searchParams), await body(req));
    return json(res, r.code, r.payload);
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
});

// Loopback only: no auth by design (single-user local pitch tool); the boundary is
// your machine. Override consciously with HANDOFF_BIND.
server.listen(PORT, process.env.HANDOFF_BIND || '127.0.0.1', () => {
  console.log(`Pitch UI → http://localhost:${PORT}  (shared store: ${core.HOME})`);
  const chain = core.claudeCliAvailable() ? 'via your Claude Code subscription ✓'
    : process.env.ANTHROPIC_API_KEY ? 'via Anthropic API (haiku)'
    : 'extractive only (no Claude Code CLI found)';
  console.log('Compaction: ' + chain + ` · sessions under ${core.FULL_THRESHOLD} chars travel whole`);
  console.log(`Note: the MCP does not need this server — this exists only to show the mockup.`);
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') { console.log('Pitch UI already running on this port — exiting.'); process.exit(0); }
  throw e;
});
