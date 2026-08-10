#!/usr/bin/env node
/**
 * One-command setup for the handoff reference MCP.
 * Registers with Claude Code (user scope) and prints the one remaining
 * Claude-app step + a live status check.
 *
 *   node bin/install.js
 *   node bin/install.js --check   # status only, no re-register
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE = path.join(ROOT, 'mcp-handoff.js');
const checkOnly = process.argv.includes('--check');

function die(msg) {
  console.error('install failed:', msg);
  process.exit(1);
}

/** Drive stdio MCP: initialize → tools/call status → return text. */
function probeStatus() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Always probe the live product store. A leftover HANDOFF_HOME=/tmp/htest
        // from protocol-test would make --check look broken after /tmp was wiped.
        HANDOFF_HOME: path.join(os.homedir(), '.claude-handoff'),
        HANDOFF_NO_AUTORECEIPT: '1',
        HANDOFF_NO_CLI: '1', // status must not invoke claude -p during probe
        CLAUDE_COMMANDS_DIR: path.join(os.tmpdir(), 'handoff-install-cmds-' + process.pid)
      }
    });
    let out = '', err = '', settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch (_) { /* ignore */ }
      try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
      fn(val);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(
        'status timed out (15s). stderr: ' + (err || '(empty)').slice(0, 300) +
        ' stdout: ' + (out || '(empty)').slice(0, 300)
      ));
    }, 15000);

    child.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.id === 1 && msg.result && msg.result.content) {
          finish(resolve, msg.result.content.map(c => c.text).join('\n'));
          return;
        }
        if (msg.id === 1 && msg.error) {
          finish(reject, new Error(msg.error.message || JSON.stringify(msg.error)));
          return;
        }
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish(reject, e));
    child.on('exit', (code, signal) => {
      if (!settled) {
        finish(reject, new Error(
          `bridge exited before status (code=${code} signal=${signal}). stderr: ${(err || '(empty)').slice(0, 300)}`
        ));
      }
    });

    const write = (obj) => { child.stdin.write(JSON.stringify(obj) + '\n'); };
    write({
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: {
        protocolVersion: '2025-06-18', capabilities: {},
        clientInfo: { name: 'handoff-install', version: '1.0.0' }
      }
    });
    write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    write({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'status', arguments: {} }
    });
  });
}

async function main() {
  if (!fs.existsSync(BRIDGE)) die('mcp-handoff.js missing at ' + BRIDGE);

  console.log('Continue in… — install\n');
  console.log('Bridge:', BRIDGE);

  if (!checkOnly) {
    const claude = spawnSync('claude', ['--version'], { encoding: 'utf8' });
    if (claude.status !== 0) {
      die('`claude` CLI not found on PATH. Install Claude Code first: https://code.claude.com/docs/en/overview');
    }
    console.log('Claude Code:', (claude.stdout || claude.stderr || '').trim().split('\n')[0]);

    spawnSync('claude', ['mcp', 'remove', 'handoff', '-s', 'user'], { encoding: 'utf8' });
    const add = spawnSync(
      'claude',
      ['mcp', 'add', '--scope', 'user', 'handoff', '--', 'node', BRIDGE],
      { encoding: 'utf8' }
    );
    if (add.status !== 0) {
      die((add.stderr || add.stdout || 'claude mcp add failed').trim());
    }
    console.log('✓ Registered MCP "handoff" at user scope (every Claude Code project + Desktop Code tab).\n');
  } else {
    console.log('(--check: skipping registration)\n');
  }

  console.log('One manual step left — Claude app (Chat / Cowork / Design):');
  console.log('  Settings → MCP / extensions → add the same command:');
  console.log(`  node ${BRIDGE}`);
  console.log('  (Desktop Code tab already sees the user-scope registration above.)\n');

  console.log('Self-check (stdio status)…');
  let statusText;
  try {
    statusText = await probeStatus();
  } catch (e) {
    console.error('status tool did not respond:', e.message);
    console.error('Tip: unset HANDOFF_HOME if it points somewhere other than your real store, then retry.');
    console.error('Or skip this self-check and run /status inside a new Claude Code session.');
    process.exit(1);
  }

  console.log(statusText.replace(/^/gm, '  '));
  console.log('\nDone. In a new Claude Code session run /status (or ask "is handoff working?").');
  console.log('Docs: GETTING-STARTED.md');
}

main().catch((e) => die(e.message || String(e)));
