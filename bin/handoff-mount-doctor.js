#!/usr/bin/env node
'use strict';
/**
 * MOUNT DOCTOR — two doors, never both on one client.
 *
 * WHY THIS EXISTS. Measured on a Grok Build session: the MCP Servers tab showed three Handoff
 * rows. They were not two plugins plus one MCP. They were three mounts of the SAME tool list:
 * local plugin "handoff" (stdio mcp-handoff.js), user-config "handoff-store" (HTTP to the relay),
 * and the managed grok.com connector "Handoff Remote" appearing as handoff_remote. Each advertised
 * 27 tools with an identical tool-names hash. Agents picked among aliases. Pretty names already
 * differed, so a checker that matches on "handoff" in the label would miss the defect that was
 * actually measured.
 *
 * The install rule is two doors, mutually exclusive PER CLIENT, same store, same tools:
 *   Door A — code on a machine: one stdio server running mcp-handoff.js (repo-link / plugin).
 *   Door B — chat or another device: one remote MCP (on grok.com, the connector named
 *            "Handoff Remote" — do not rename it).
 * A second mount of the same tool-name hash is a refuse + one-line disable, not a silent extra
 * server and not an auto-delete. Deleting a connector from under grok.com would break chat→code.
 *
 * WHAT IT CHECKS
 *   1. Connected / configured MCP servers, hashed by SORTED TOOL NAMES (sha256), never by the
 *      pretty server name. A hash that matches this product's handoff-tool-schemas.js list on
 *      two or more mounts is the defect.
 *   2. Installed plugin.json caches whose version is older than this repo's plugin.json — the
 *      same class of lie as `claude plugin update` reporting success while the cache stayed at
 *      0.1.13. Named, not auto-fixed; update is version-gated and a same-version update is a no-op.
 *
 * WHAT IT DOES NOT DO, stated rather than implied:
 *   - It does not delete, uncheck, or rewrite a connector. The operator (or the host UI) disables.
 *   - It does not rename "Handoff Remote".
 *   - It does not claim a live tools/list from an HTTP server it cannot authenticate to. Pass
 *     --from-list with the names the client already fetched, or point stdio at mcp-handoff.js
 *     (the producer file — not the pretty name — fills the canonical list).
 *   - Finding zero mounts is not "no duplicates". It prints that nothing was observed.
 *
 *   node bin/handoff-mount-doctor.js              # this machine's client configs
 *   node bin/handoff-mount-doctor.js --from-list mounts.json
 *   node bin/handoff-mount-doctor.js --self-test  # fixtures; must go red on a triple mount
 *
 * HANDOFF_DOCTOR_HOME overrides os.homedir() so a fixture can describe the measured failure.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const { TOOLS } = require('../handoff-tool-schemas');

function canonicalToolNames() {
  return TOOLS.map(t => t.name);
}

function toolNamesHash(names) {
  const sorted = [...names].map(String).filter(Boolean).sort();
  return crypto.createHash('sha256').update(sorted.join('\n'), 'utf8').digest('hex');
}

function canonicalHandoffHash() {
  return toolNamesHash(canonicalToolNames());
}

function productVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO, 'plugin.json'), 'utf8')).version;
  } catch (_) {
    return null;
  }
}

function cmpVer(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function looksLikeHandoffProducer(mount) {
  const blob = [mount.command, ...(mount.args || []), mount.script].filter(Boolean).join(' ');
  return /mcp-handoff\.js\b/.test(blob);
}

function disableLine(mount, keep) {
  const where = mount.config_file ? ` in ${mount.config_file}` : (mount.origin === 'managed'
    ? ' in this client\'s MCP panel only'
    : '');
  const keepBit = keep
    ? ` Keep "${keep.name}" (${keep.transport || keep.origin || 'stdio'}).`
    : '';
  if (mount.origin === 'managed') {
    return `DISABLE "${mount.name}"${where}.${keepBit} Leave the grok.com connector named Handoff Remote enabled on grok.com — do not rename it. Do not delete a connector.`;
  }
  if (mount.transport === 'http' || mount.origin === 'user-config') {
    return `DISABLE "${mount.name}"${where}.${keepBit} This client already has a handoff mount; a second copy of the same tool-name hash is the defect. Do not delete a connector — uncheck it here.`;
  }
  return `DISABLE "${mount.name}"${where}.${keepBit} Do not delete a connector — uncheck/disable this extra mount.`;
}

function fillProducerNames(mount) {
  if (mount.tool_names && mount.tool_names.length) return mount;
  if (looksLikeHandoffProducer(mount)) {
    return Object.assign({}, mount, { tool_names: canonicalToolNames(), names_from: 'producer:mcp-handoff.js' });
  }
  return mount;
}

function diagnose(mounts, caches, opts) {
  const product = (opts && opts.productVersion) || productVersion();
  const canonical = (opts && opts.canonicalHash) || canonicalHandoffHash();
  const filled = (mounts || []).map(fillProducerNames);
  const hashed = filled.map(m => {
    const names = m.tool_names;
    const hash = names && names.length ? toolNamesHash(names) : null;
    return Object.assign({}, m, { hash, is_handoff: hash === canonical || looksLikeHandoffProducer(m) });
  });

  const byHash = new Map();
  for (const m of hashed) {
    if (!m.hash || !m.is_handoff) continue;
    if (!byHash.has(m.hash)) byHash.set(m.hash, []);
    byHash.get(m.hash).push(m);
  }
  const dupes = [...byHash.values()].filter(g => g.length >= 2);

  const keepOf = (group) => {
    const stdio = group.find(m => m.transport === 'stdio' || looksLikeHandoffProducer(m));
    return stdio || group[0];
  };

  const disable = [];
  for (const group of dupes) {
    const keep = keepOf(group);
    for (const m of group) {
      if (m === keep) continue;
      disable.push(disableLine(m, keep));
    }
  }

  const stale = [];
  for (const c of caches || []) {
    if (!c || !c.version || !product) continue;
    if (cmpVer(c.version, product) < 0) {
      stale.push(
        `STALE plugin cache ${c.version} at ${c.path} — product is ${product}. ` +
        `Update or reinstall the plugin. claude plugin update is version-gated (a same-version ` +
        `update is a no-op); Grok's installed-plugins cache has the same class of bug. ` +
        `Do not delete a connector to "fix" this.`
      );
    }
  }

  return {
    ok: dupes.length === 0 && stale.length === 0,
    product,
    canonical,
    mounts: hashed,
    dupes,
    disable,
    stale,
    observed: hashed.length,
  };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function mountsFromMcpServers(servers, origin, configFile) {
  if (!servers || typeof servers !== 'object') return [];
  const out = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') continue;
    const args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
    const url = cfg.url || cfg.serverUrl || cfg.href || null;
    const command = cfg.command || cfg.cmd || null;
    const transport = url ? 'http' : (command ? 'stdio' : (cfg.type || 'unknown'));
    out.push({
      name: String(name),
      origin,
      transport,
      command,
      args,
      config_file: configFile,
      /* URL is used only to classify transport. Never printed — it may be a real relay host. */
      has_url: !!url,
    });
  }
  return out;
}

function parseTomlMcpServers(text, configFile) {
  const mounts = [];
  let current = null;
  const flush = () => { if (current) mounts.push(current); current = null; };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const header = /^\[mcp_servers\.([^\]]+)\]$/.exec(line);
    if (header) {
      flush();
      current = { name: header[1].trim(), origin: 'user-config', transport: 'unknown', args: [], config_file: configFile };
      continue;
    }
    if (!current) continue;
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    if (key === 'args' && val.startsWith('[')) {
      const inner = val.replace(/^\[/, '').replace(/\]$/, '');
      current.args = [...inner.matchAll(/"([^"]*)"|'([^']*)'/g)].map(m => m[1] || m[2]);
    } else {
      val = val.replace(/^["']|["']$/g, '');
      if (key === 'command' || key === 'cmd') current.command = val;
      if (key === 'url' || key === 'serverUrl') { current.has_url = true; current.transport = 'http'; }
    }
  }
  flush();
  for (const m of mounts) {
    if (m.transport === 'unknown') m.transport = m.command ? 'stdio' : (m.has_url ? 'http' : 'unknown');
  }
  return mounts;
}

function collectJsonFile(file, origin) {
  const j = readJson(file);
  if (!j) return [];
  const servers = j.mcpServers || (j.mcp && j.mcp.servers) || (j.mcp && j.mcp.mcpServers) || null;
  return mountsFromMcpServers(servers, origin, file);
}

function walkPluginCaches(home) {
  const caches = [];
  const extraMounts = [];
  const roots = [
    path.join(home, '.grok', 'installed-plugins'),
    path.join(home, '.claude', 'plugins'),
    path.join(home, '.cursor', 'plugins'),
  ];
  const stack = roots.filter(r => { try { return fs.statSync(r).isDirectory(); } catch (_) { return false; } });
  const seen = new Set();
  let steps = 0;
  while (stack.length && steps < 400) {
    steps++;
    const dir = stack.pop();
    if (seen.has(dir)) continue;
    seen.add(dir);
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && seen.size < 200) stack.push(p);
      if (!e.isFile()) continue;
      if (e.name === 'plugin.json') {
        const j = readJson(p);
        if (j && j.name === 'handoff' && j.version) caches.push({ path: p, version: String(j.version) });
        if (j && j.mcpServers) extraMounts.push(...mountsFromMcpServers(j.mcpServers, 'plugin', p));
      }
      if (e.name === 'mcp.json') extraMounts.push(...collectJsonFile(p, 'plugin'));
    }
  }
  return { caches, extraMounts };
}

function discover(home) {
  const mounts = [];
  const files = [
    [path.join(home, '.grok', 'config.toml'), 'user-config', 'toml'],
    [path.join(home, '.cursor', 'mcp.json'), 'user-config', 'json'],
    [path.join(home, '.claude.json'), 'user-config', 'json'],
    [path.join(home, '.claude', 'settings.json'), 'user-config', 'json'],
  ];
  const project = process.env.HANDOFF_DOCTOR_PROJECT;
  if (project) files.push([path.join(project, '.cursor', 'mcp.json'), 'user-config', 'json']);

  for (const [file, origin, kind] of files) {
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    if (kind === 'toml') mounts.push(...parseTomlMcpServers(text, file));
    else mounts.push(...collectJsonFile(file, origin));
  }
  const walked = walkPluginCaches(home);
  mounts.push(...walked.extraMounts);
  return { mounts, caches: walked.caches };
}

function loadFromList(file) {
  const j = readJson(file);
  if (!j) return { mounts: [], caches: [] };
  const mounts = Array.isArray(j) ? j : (j.mounts || []);
  const caches = j.plugin_caches || j.caches || [];
  return { mounts, caches };
}

function render(result) {
  const lines = [];
  lines.push(`handoff-mount-doctor — product ${result.product || '(unreadable)'} · canonical hash ${result.canonical.slice(0, 12)}…`);
  if (!result.observed) {
    lines.push('No MCP mounts observed. That is not a pass on duplicates — nothing was hashed.');
    lines.push('Pass --from-list with the tool names the client fetched, or run on a machine whose host config is readable.');
    return lines.join('\n');
  }
  lines.push(`Observed ${result.observed} mount(s):`);
  for (const m of result.mounts) {
    const hash = m.hash ? m.hash.slice(0, 12) + '…' : '(no tool names — not hashed)';
    const mark = m.is_handoff ? 'handoff-hash' : 'other';
    lines.push(`  - "${m.name}" · ${m.transport || '?'} · ${m.origin || '?'} · ${mark} · ${hash}`);
  }
  if (result.dupes.length) {
    lines.push('\nREFUSE: two or more connected servers expose the same handoff tool-name hash.');
    lines.push('Pretty names are not the signal — detect by hash. Two doors, never both on one client.');
    for (const d of result.disable) lines.push('  ' + d);
    lines.push('The doctor does not delete or rename anything. Disable the named mount in this client.');
  } else {
    lines.push('\nNo duplicate handoff tool-name hash on this client.');
  }
  for (const s of result.stale) {
    lines.push('\n' + s);
  }
  if (result.ok) lines.push('\nhandoff-mount-doctor: OK');
  else lines.push(`\nhandoff-mount-doctor: ${result.disable.length + result.stale.length} problem(s).`);
  return lines.join('\n');
}

function runDoctor(opts) {
  const home = opts.home || process.env.HANDOFF_DOCTOR_HOME || os.homedir();
  let mounts = [];
  let caches = [];
  if (opts.fromList) {
    const loaded = loadFromList(opts.fromList);
    mounts = loaded.mounts;
    caches = loaded.caches;
  } else {
    const found = discover(home);
    mounts = found.mounts;
    caches = found.caches;
  }
  if (opts.extraCaches) caches = caches.concat(opts.extraCaches);
  return diagnose(mounts, caches, opts);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function runSelfTest() {
  const names = canonicalToolNames();
  assert(names.length >= 20, `canonical tool list too small (${names.length}) — a short list would make the hash check vacuous`);
  assert(names.includes('register_session') && names.includes('register_remote_session'),
    'retired enrol verbs must stay in the advertised list so cached clients are not a 404');
  const otherNames = names.map((n, i) => (i === 0 ? 'not-handoff-' + n : n));
  assert(toolNamesHash(names) !== toolNamesHash(otherNames), 'hash must change when a tool name changes');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-mount-doctor-'));
  const cli = (args, env) => spawnSync(process.execPath, [__filename, ...args], {
    encoding: 'utf8', cwd: REPO, env: Object.assign({}, process.env, env || {}), timeout: 20000,
  });
  const writeList = (rel, obj) => {
    const p = path.join(tmp, rel);
    fs.writeFileSync(p, JSON.stringify(obj, null, 2));
    return p;
  };

  /* THE RED CASE — three mounts, three pretty names, one hash. This is the measured defect.
   * If the doctor ever starts matching on the server name, this fixture still fails it, because
   * none of the names need to equal "handoff" for the refuse (test 4 below makes that explicit). */
  const triple = writeList('triple.json', {
    mounts: [
      { name: 'handoff', origin: 'plugin', transport: 'stdio', tool_names: names, command: 'node', args: [path.join(REPO, 'mcp-handoff.js')] },
      { name: 'handoff-store', origin: 'user-config', transport: 'http', tool_names: names, config_file: path.join(tmp, 'config.toml') },
      { name: 'handoff_remote', origin: 'managed', transport: 'http', tool_names: names },
    ],
  });
  fs.writeFileSync(path.join(tmp, 'config.toml'), '[mcp_servers.handoff-store]\nurl = "https://mcp.example.invalid/mcp"\n');
  let r = cli(['--from-list', triple], { HANDOFF_DOCTOR_HOME: tmp });
  assert(r.status === 1, `triple mount must exit 1, got ${r.status}\n${r.stdout}${r.stderr}`);
  assert(/DISABLE/i.test(r.stdout), 'triple mount must name a DISABLE');
  assert(/Handoff Remote/.test(r.stdout), 'managed extra must mention leaving Handoff Remote on grok.com');
  assert(!/deleted/i.test(r.stdout), 'doctor must not claim it deleted anything');
  assert(!/renam(?:e|ed|ing) Handoff Remote/i.test(r.stdout), 'doctor must not tell anyone to rename Handoff Remote');
  assert(fs.existsSync(triple) && fs.existsSync(path.join(tmp, 'config.toml')),
    'doctor must not delete fixture files — disable is a sentence, not an effect on disk');

  const single = writeList('single.json', {
    mounts: [{ name: 'handoff', origin: 'plugin', transport: 'stdio', tool_names: names, args: ['mcp-handoff.js'] }],
  });
  r = cli(['--from-list', single], { HANDOFF_DOCTOR_HOME: tmp });
  assert(r.status === 0, `single mount must exit 0, got ${r.status}\n${r.stdout}${r.stderr}`);
  assert(/OK/.test(r.stdout), 'single mount should print OK');

  const mixed = writeList('mixed.json', {
    mounts: [
      { name: 'handoff', origin: 'plugin', transport: 'stdio', tool_names: names, args: ['mcp-handoff.js'] },
      { name: 'other', origin: 'user-config', transport: 'http', tool_names: otherNames },
    ],
  });
  r = cli(['--from-list', mixed], { HANDOFF_DOCTOR_HOME: tmp });
  assert(r.status === 0, `different hashes must exit 0, got ${r.status}\n${r.stdout}${r.stderr}`);

  /* Pretty names are irrelevant: two servers called alpha/beta with the handoff tool list still refuse. */
  const aliases = writeList('aliases.json', {
    mounts: [
      { name: 'alpha', origin: 'plugin', transport: 'stdio', tool_names: names },
      { name: 'beta', origin: 'user-config', transport: 'http', tool_names: names },
    ],
  });
  r = cli(['--from-list', aliases], { HANDOFF_DOCTOR_HOME: tmp });
  assert(r.status === 1, `same hash under different pretty names must exit 1, got ${r.status}\n${r.stdout}${r.stderr}`);
  assert(/DISABLE "beta"/i.test(r.stdout) || /DISABLE "alpha"/i.test(r.stdout),
    'alias-name duplicate must name a DISABLE by the extra mount, not by guessing "handoff"');

  /* Stale cache: one healthy mount, an old plugin.json. Must fail for the version, not invent a duplicate. */
  const cacheDir = path.join(tmp, '.grok', 'installed-plugins', 'handoff-remote');
  fs.mkdirSync(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, 'plugin.json');
  fs.writeFileSync(cachePath, JSON.stringify({ name: 'handoff', version: '0.1.0' }));
  const staleList = writeList('stale.json', {
    mounts: [{ name: 'handoff', origin: 'plugin', transport: 'stdio', tool_names: names, args: ['mcp-handoff.js'] }],
    plugin_caches: [{ path: cachePath, version: '0.1.0' }],
  });
  r = cli(['--from-list', staleList], { HANDOFF_DOCTOR_HOME: tmp });
  assert(r.status === 1, `stale cache must exit 1, got ${r.status}\n${r.stdout}${r.stderr}`);
  assert(/STALE plugin cache 0\.1\.0/.test(r.stdout), 'stale cache must name the old version');
  assert(/version-gated/.test(r.stdout), 'stale cache must name the version-gated update');
  assert(fs.existsSync(cachePath), 'stale check must not delete the cache');

  /* Discovery path: two stdio producers in different client files, no --from-list, no pretty-name match required. */
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(home, '.grok', 'config.toml'),
    `[mcp_servers.alpha]\ncommand = "node"\nargs = ["${path.join(REPO, 'mcp-handoff.js')}"]\n`);
  fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({
    mcpServers: { beta: { command: 'node', args: [path.join(REPO, 'mcp-handoff.js')] } },
  }));
  r = cli([], { HANDOFF_DOCTOR_HOME: home });
  assert(r.status === 1, `two discovered producers must exit 1, got ${r.status}\n${r.stdout}${r.stderr}`);
  assert(/DISABLE/.test(r.stdout), 'discovered duplicate producers must name a DISABLE');

  const cleanHome = path.join(tmp, 'clean');
  fs.mkdirSync(path.join(cleanHome, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(cleanHome, '.cursor', 'mcp.json'), JSON.stringify({
    mcpServers: { handoff: { command: 'node', args: [path.join(REPO, 'mcp-handoff.js')] } },
  }));
  r = cli([], { HANDOFF_DOCTOR_HOME: cleanHome });
  assert(r.status === 0, `one discovered producer must exit 0, got ${r.status}\n${r.stdout}${r.stderr}`);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* scratch */ }
  console.log('handoff-mount-doctor --self-test: OK — triple mount red, one mount green, hash not pretty-name, stale named, nothing deleted.');
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    try { runSelfTest(); }
    catch (e) {
      console.error('handoff-mount-doctor --self-test: FAIL — ' + (e && e.message));
      process.exit(2);
    }
    return;
  }
  const fromListIdx = argv.indexOf('--from-list');
  const fromList = fromListIdx >= 0 ? argv[fromListIdx + 1] : process.env.HANDOFF_DOCTOR_MOUNTS;
  if (fromListIdx >= 0 && !fromList) {
    console.error('REFUSED: --from-list needs a path.');
    process.exit(2);
  }
  const result = runDoctor({ fromList: fromList || null });
  console.log(render(result));
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  toolNamesHash, canonicalHandoffHash, canonicalToolNames,
  diagnose, looksLikeHandoffProducer, parseTomlMcpServers, cmpVer,
};
