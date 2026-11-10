'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildRemoteConfigPy } = require('../lib/remote-config');
const { nodeTunnelSock: tunnelSocket, tunnelArgs } = require('../lib/tunnel-config');
module.exports = function createWatchdog({ cfg, runCommand, loadConfiguredNodes, TOOLS, MCP_TOKEN }) {
const PORT = cfg.MCP_PORT;
const EDA_PORT = cfg.EDA_PORT;
const SYNCTHING_URL = cfg.SYNCTHING_URL;
async function ensureEasyEdaBridgeDetailed() {
  for (let p = EDA_PORT; p <= EDA_PORT + 9; p++) {
    const r = await runCommand('curl', ['-s', '--max-time', '1', `http://127.0.0.1:${p}/health`]);
    if (r.stdout && r.stdout.includes('"easyeda-bridge"')) {
      try {
        const parsed = JSON.parse(r.stdout);
        return { port: p, ok: true, edaConnected: Boolean(parsed.edaConnected), windowCount: Number(parsed.edaWindowCount || 0) };
      } catch {
        return { port: p, ok: true, edaConnected: false, windowCount: 0 };
      }
    }
  }
  const candidates = [
    cfg.EASYEDA_BRIDGE_SCRIPT,
    path.join(cfg.HOME, '.claude/skills/easyeda-api/scripts/bridge-server.mjs'),
    path.join(cfg.TAKT_HOME, 'easyeda-api/scripts/bridge-server.mjs'),
  ].filter(Boolean);
  const bridgeScript = candidates.find((c) => fs.existsSync(c));
  if (bridgeScript) {
    const child = spawn(process.execPath, [bridgeScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
    await new Promise((r) => setTimeout(r, 1000));
    for (let p = EDA_PORT; p <= EDA_PORT + 9; p++) {
      const r = await runCommand('curl', ['-s', '--max-time', '1', `http://127.0.0.1:${p}/health`]);
      if (r.stdout && r.stdout.includes('"easyeda-bridge"')) {
        try {
          const parsed = JSON.parse(r.stdout);
          return { port: p, ok: true, edaConnected: Boolean(parsed.edaConnected), windowCount: Number(parsed.edaWindowCount || 0) };
        } catch {
          return { port: p, ok: true, edaConnected: false, windowCount: 0 };
        }
      }
    }
  }
  return { port: EDA_PORT, ok: false, edaConnected: false, windowCount: 0 };
}

async function ensureEasyEdaBridge() {
  const info = await ensureEasyEdaBridgeDetailed();
  return info.port;
}

const systemStatusState = {
  ok: false,
  updatedAt: Date.now(),
  healing: false,
  healCount: 0,
  lastHealAt: null,
  remoteCli: {
    online: false,
    processCount: 0,
    uptimeSec: 0,
    pids: [],
    egressIp: '',
  },
  mcpStatus: {
    ok: false,
    localMcpOk: true,
    remoteTunnelOk: false,
    edaBridgeOk: false,
    edaClientConnected: false,
    tools: TOOLS.length,
    pingMs: null,
  },
  diskSync: {
    ok: false,
    connected: false,
    state: 'idle',
    inSyncFiles: 0,
    globalFiles: 0,
    needFiles: 0,
    needBytes: 0,
    inBps: 0,
    outBps: 0,
    address: '',
  },
  claudeUsage: null,
  nodesStatus: {},
};

let prevSyncthingSample = null;
let watchdogRunning = false;
const lastNodeHealAt = new Map();

function getSyncthingApiKey() {
  try {
    const cfgXml = fs.readFileSync(cfg.findSyncthingConfig(), 'utf8');
    const m = cfgXml.match(/<apikey>([^<]+)<\/apikey>/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

async function syncthingGet(apiKey, apiPath) {
  const r = await runCommand('curl', ['-s', '--max-time', '1.5', '-H', `X-API-Key: ${apiKey}`, `${SYNCTHING_URL}${apiPath}`]);
  return r.stdout;
}

/** Aggregates Syncthing state over every node's folder / device (local Syncthing REST API). */
async function checkSyncthingStatus(nodes = loadConfiguredNodes().filter((n) => n.enabled && n.sshHost)) {
  const apiKey = getSyncthingApiKey();
  if (!apiKey) return; // Syncthing not installed / not configured: leave diskSync at defaults
  try {
    const connRaw = await syncthingGet(apiKey, '/rest/system/connections');
    if (!connRaw) {
      systemStatusState.diskSync.ok = false;
      systemStatusState.diskSync.connected = false;
      return;
    }
    const conns = JSON.parse(connRaw).connections || {};
    const deviceIds = nodes.map((n) => n.syncthingDeviceId).filter(Boolean);
    const relevant = deviceIds.length ? deviceIds.map((id) => conns[id]).filter(Boolean) : Object.values(conns);
    const connectedEntry = relevant.find((c) => c && c.connected) || {};
    const anyConnected = Boolean(connectedEntry.connected);

    const nowMs = Date.now();
    const inTotal = relevant.reduce((a, c) => a + Number(c.inBytesTotal || 0), 0);
    const outTotal = relevant.reduce((a, c) => a + Number(c.outBytesTotal || 0), 0);
    let inBps = 0;
    let outBps = 0;
    if (prevSyncthingSample && nowMs > prevSyncthingSample.ts) {
      const dtSec = (nowMs - prevSyncthingSample.ts) / 1000;
      if (dtSec > 0.5 && inTotal >= prevSyncthingSample.inTotal && outTotal >= prevSyncthingSample.outTotal) {
        inBps = Math.round((inTotal - prevSyncthingSample.inTotal) / dtSec);
        outBps = Math.round((outTotal - prevSyncthingSample.outTotal) / dtSec);
      }
    }
    prevSyncthingSample = { ts: nowMs, inTotal, outTotal };

    let inSyncFiles = 0, globalFiles = 0, needFiles = 0, needBytes = 0;
    let state = 'idle';
    const folderIds = [...new Set(nodes.map((n) => n.syncthingFolderId).filter(Boolean))];
    for (const fid of folderIds) {
      try {
        const db = JSON.parse((await syncthingGet(apiKey, `/rest/db/status?folder=${encodeURIComponent(fid)}`)) || '{}');
        inSyncFiles += Number(db.inSyncFiles || 0);
        globalFiles += Number(db.globalFiles || 0);
        needFiles += Number(db.needFiles || 0);
        needBytes += Number(db.needBytes || 0);
        if (db.state && db.state !== 'idle') state = db.state;
      } catch {}
    }

    systemStatusState.diskSync = {
      ok: anyConnected || inSyncFiles > 0,
      connected: anyConnected,
      state,
      inSyncFiles,
      globalFiles,
      needFiles,
      needBytes,
      inBps,
      outBps,
      address: connectedEntry.address || '',
    };
  } catch {}
}

// Python probe executed on each remote Linux node (over the node's ssh ControlMaster socket).
const REMOTE_PROBE_PY = `
import subprocess, json, urllib.request, glob, os, time, re
from datetime import datetime

pids = []
max_et = 0
out = subprocess.run(["ps", "-eo", "pid,etimes,comm,args"], capture_output=True, text=True).stdout
for line in out.splitlines()[1:]:
    parts = line.strip().split(None, 3)
    if len(parts) >= 3 and parts[2] == "claude":
        pids.append(int(parts[0]))
        et = int(parts[1])
        if et > max_et: max_et = et
mcp_ok = False
try:
    req = urllib.request.Request(
        "http://127.0.0.1:${PORT}/mcp",
        data=b'{"jsonrpc":"2.0","id":1,"method":"ping"}',
        headers={"Content-Type": "application/json", **json.load(open(os.path.expanduser("~/.claude.json"), encoding="utf-8")).get("mcpServers", {}).get("mac-industrial", {}).get("headers", {})},
        method="POST",
    )
    r = urllib.request.urlopen(req, timeout=1.5).read().decode()
    mcp_ok = '"result"' in r and '"error"' not in r
except Exception:
    pass
eda_ok = False
try:
    r2 = urllib.request.urlopen("http://127.0.0.1:${EDA_PORT}/health", timeout=1.5).read().decode()
    eda_ok = '"easyeda-bridge"' in r2
except Exception:
    pass
egress = ""
try:
    rt = subprocess.run(["ip", "route", "get", "160.79.104.10"], capture_output=True, text=True, timeout=2).stdout
    m_src = re.search(r"src\\s+(\\S+)", rt)
    egress = m_src.group(1) if m_src else ""
except Exception:
    pass

# Claude usage estimate (cached for 60s; skips api-request-blob and reads tail 1MB max per file)
home = os.path.expanduser("~")
now = time.time()
usage_cache_file = "/tmp/takt-claude-usage-cache.json"
usage_info = None
try:
    if os.path.exists(usage_cache_file) and (now - os.path.getmtime(usage_cache_file)) < 60:
        usage_info = json.load(open(usage_cache_file, "r", encoding="utf-8"))
except Exception:
    usage_info = None

if not usage_info:
    creds_path = os.path.join(home, ".claude", ".credentials.json")
    settings_path = os.path.join(home, ".claude", "settings.json")
    creds_mtime = os.path.getmtime(creds_path) if os.path.exists(creds_path) else 0
    plan_name = "Claude"
    is_api_proxy = False
    try:
        st = json.load(open(settings_path))
        if (st.get("env") or {}).get("ANTHROPIC_BASE_URL"):
            is_api_proxy = True
            plan_name = "API Proxy"
    except Exception:
        pass

    win_5h_start = max(now - 5 * 3600, creds_mtime if not is_api_proxy else 0)
    win_7d_start = max(now - 7 * 86400, creds_mtime if not is_api_proxy else 0)
    seen_ids = set()
    turns_5h = 0; weighted_5h = 0.0; tokens_5h = 0; oldest_5h_ts = None
    turns_7d = 0; weighted_7d = 0.0; tokens_7d = 0; oldest_7d_ts = None

    for p in glob.glob(os.path.join(home, ".claude", "projects", "*", "*.jsonl")):
        try:
            st_f = os.stat(p)
            if st_f.st_mtime < (now - 7 * 86400):
                continue
            with open(p, "rb") as fb:
                if st_f.st_size > 1048576:
                    fb.seek(st_f.st_size - 1048576)
                    raw_lines = fb.read().decode("utf-8", errors="replace").splitlines()[1:]
                else:
                    raw_lines = fb.read().decode("utf-8", errors="replace").splitlines()
            for l in raw_lines:
                if "api-request-blob" in l or '"usage"' not in l or '"assistant"' not in l:
                    continue
                d = json.loads(l)
                if d.get("type") != "assistant":
                    continue
                msg = d.get("message") or {}
                mid = msg.get("id")
                if not mid or mid in seen_ids:
                    continue
                seen_ids.add(mid)
                ts_str = d.get("timestamp")
                if not ts_str:
                    continue
                ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00")).timestamp()
                if ts < win_7d_start:
                    continue
                u = msg.get("usage") or {}
                inp = int(u.get("input_tokens") or 0)
                cc = int(u.get("cache_creation_input_tokens") or 0)
                cr = int(u.get("cache_read_input_tokens") or 0)
                out_t = int(u.get("output_tokens") or 0)
                raw = inp + cc + cr + out_t
                if raw <= 0:
                    continue
                w = inp * 1.0 + cc * 0.25 + cr * 0.05 + out_t * 4.0
                turns_7d += 1; weighted_7d += w; tokens_7d += raw
                if oldest_7d_ts is None or ts < oldest_7d_ts: oldest_7d_ts = ts
                if ts >= win_5h_start:
                    turns_5h += 1; weighted_5h += w; tokens_5h += raw
                    if oldest_5h_ts is None or ts < oldest_5h_ts: oldest_5h_ts = ts
        except Exception:
            pass

    cap_5h_turns = 250.0 if is_api_proxy else 45.0
    cap_5h_weight = 2500000.0 if is_api_proxy else 450000.0
    cap_7d_turns = 2500.0 if is_api_proxy else 450.0
    cap_7d_weight = 25000000.0 if is_api_proxy else 4500000.0
    used_5h_pct = min(100, round(max(turns_5h / cap_5h_turns, weighted_5h / cap_5h_weight) * 100))
    used_7d_pct = min(100, round(max(turns_7d / cap_7d_turns, weighted_7d / cap_7d_weight) * 100))
    reset_5h_sec = max(0, int((oldest_5h_ts + 5 * 3600) - now)) if oldest_5h_ts else 5 * 3600
    reset_7d_sec = max(0, int((oldest_7d_ts + 7 * 86400) - now)) if oldest_7d_ts else 7 * 86400

    usage_info = {
        "plan": plan_name, "source": "session_meter", "authStatus": "ok",
        "remaining5hPct": max(0, 100 - used_5h_pct), "used5hPct": used_5h_pct, "reset5hSec": reset_5h_sec,
        "turns5h": turns_5h, "tokens5h": tokens_5h,
        "remaining7dPct": max(0, 100 - used_7d_pct), "used7dPct": used_7d_pct, "reset7dSec": reset_7d_sec,
        "turns7d": turns_7d, "tokens7d": tokens_7d,
    }
    try:
        json.dump(usage_info, open(usage_cache_file, "w", encoding="utf-8"))
    except Exception:
        pass

ts_ok = False
ts_ip = ""
try:
    ts_ok = subprocess.run(["systemctl", "is-active", "tailscaled"], capture_output=True, text=True, timeout=2).stdout.strip() == "active"
    ts_ip_out = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=1.5).stdout.strip()
    if ts_ip_out:
        ts_ip = ts_ip_out.splitlines()[0].strip()
except Exception:
    pass

print(json.dumps({"pids": pids, "count": len(pids), "uptimeSec": max_et, "mcpOk": mcp_ok, "edaOk": eda_ok,
                  "egressIp": egress, "tailscaleOk": ts_ok, "tailscaleIp": ts_ip, "usage": usage_info}))
`.trim();

const REMOTE_PROBE_CMD = `python3 -c "import base64;exec(base64.b64decode('${Buffer.from(REMOTE_PROBE_PY, 'utf8').toString('base64')}'))"`;

function nodeTunnelSock(node) { return tunnelSocket(cfg, node); }

async function probeNode(node, timeoutMs = 5500) {
  const sock = nodeTunnelSock(node);
  const t0 = Date.now();
  const res = await runCommand('ssh', ['-S', sock, '-o', 'ConnectTimeout=4', node.sshHost, REMOTE_PROBE_CMD], { timeoutMs });
  const rtt = Date.now() - t0;
  let data = null;
  if (res.exitCode === 0 && res.stdout) {
    try { data = JSON.parse(res.stdout.trim().split('\n').pop()); } catch {}
  }
  return { data, pingMs: data ? Math.min(999, Math.round(rtt / 2)) : null };
}

const nodeHealInFlight = new Map();

/** Rebuilds the dedicated MCP reverse-tunnel ControlMaster for one node. Never touches interactive terminals. */
async function healNodeTunnel(node) {
  if (nodeHealInFlight.has(node.id)) {
    return nodeHealInFlight.get(node.id);
  }
  const job = (async () => {
    const current = loadConfiguredNodes().find((n) => n.id === node.id && n.enabled && n.sshHost === node.sshHost);
    if (!current) throw new Error(`Node ${node.id} is disabled or changed`);
    const sock = nodeTunnelSock(node);
    await runCommand('ssh', ['-S', sock, '-O', 'exit', node.sshHost], { timeoutMs: 2000 });
    // Close only the ControlMaster owned by this instance. A port collision is an
    // error to report, never a reason to kill arbitrary remote sshd processes.
    const tunnel = await runCommand('ssh', tunnelArgs(cfg, node), { timeoutMs: 7000 });
    if (tunnel.exitCode !== 0) throw new Error(`Tunnel failed for ${node.id}: check remote port ownership`);
    const program = buildRemoteConfigPy({ node, port: PORT, token: MCP_TOKEN, autoAllowHostExec: cfg.AUTO_ALLOW_HOST_EXEC });
    const result = await runCommand('ssh', [
      '-S', sock, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', node.sshHost, 'python3 -',
    ], { timeoutMs: 6000, input: program });
    if (result.exitCode !== 0) throw new Error(`Remote MCP configuration failed for ${node.id}`);
    const stillEnabled = loadConfiguredNodes().some((n) => n.id === node.id && n.enabled && n.sshHost === node.sshHost);
    if (!stillEnabled) {
      await runCommand('ssh', ['-S', sock, '-O', 'exit', node.sshHost], { timeoutMs: 2000 });
      throw new Error(`Node ${node.id} changed during tunnel setup`);
    }

  })().finally(() => {
    nodeHealInFlight.delete(node.id);
  });
  nodeHealInFlight.set(node.id, job);
  return job;
}

async function runSystemWatchdogCycle(forceHeal = false) {
  if (watchdogRunning) return;
  watchdogRunning = true;
  try {
    const nodes = loadConfiguredNodes().filter((n) => n.enabled && n.sshHost);
    const [edaInfo] = await Promise.all([ensureEasyEdaBridgeDetailed(), checkSyncthingStatus(nodes)]);

    const nodesStatus = {};
    const probeData = {};
    await Promise.all(nodes.map(async (node) => {
      let data = null;
      let pingMs = null;
      if (!forceHeal) {
        ({ data, pingMs } = await probeNode(node));
      }
      const needHeal = forceHeal || !data || !data.mcpOk;
      const sinceHeal = Date.now() - (lastNodeHealAt.get(node.id) || 0);
      if (needHeal && (forceHeal || sinceHeal > 15000)) {
        systemStatusState.healing = true;
        lastNodeHealAt.set(node.id, Date.now());
        try { await healNodeTunnel(node); } catch (error) {
          nodesStatus[node.id] = { id: node.id, online: Boolean(data), mcpOk: false, error: error.message };
          return;
        }
        ({ data, pingMs } = await probeNode(node));
        systemStatusState.healCount += 1;
        systemStatusState.lastHealAt = Date.now();
      }
      probeData[node.id] = data;
      nodesStatus[node.id] = {
        id: node.id,
        name: node.name || node.id,
        badge: node.badge || node.id,
        sshHost: node.sshHost,
        online: Boolean(data),
        mcpOk: Boolean(data && data.mcpOk),
        edaOk: Boolean(data && data.edaOk),
        egressIp: (data && data.egressIp) || '',
        processCount: Number((data && data.count) || 0),
        pingMs,
        tailscaleOk: Boolean(data && data.tailscaleOk),
        tailscaleIp: (data && data.tailscaleIp) || '',
      };
    }));
    systemStatusState.healing = false;
    systemStatusState.nodesStatus = nodesStatus;

    const onlineIds = Object.keys(nodesStatus).filter((id) => nodesStatus[id].online);
    const first = onlineIds.length ? nodesStatus[onlineIds[0]] : null;
    const firstData = first ? probeData[first.id] : null;
    const allOnlineMcpOk = onlineIds.length > 0 && onlineIds.every((id) => nodesStatus[id].mcpOk);
    const anyEdaOk = onlineIds.some((id) => nodesStatus[id].edaOk);
    const bestPing = onlineIds.length ? Math.min(...onlineIds.map((id) => nodesStatus[id].pingMs || 999)) : null;

    systemStatusState.remoteCli = firstData
      ? {
          online: true,
          processCount: onlineIds.reduce((a, id) => a + nodesStatus[id].processCount, 0),
          uptimeSec: Number(firstData.uptimeSec || 0),
          pids: Array.isArray(firstData.pids) ? firstData.pids : [],
          egressIp: firstData.egressIp || '',
          tailscaleOk: Boolean(firstData.tailscaleOk),
          tailscaleIp: firstData.tailscaleIp || '',
        }
      : { online: false, processCount: 0, uptimeSec: 0, pids: [], egressIp: '' };
    systemStatusState.mcpStatus = {
      ok: allOnlineMcpOk,
      localMcpOk: true,
      remoteTunnelOk: allOnlineMcpOk,
      edaBridgeOk: Boolean(edaInfo.ok && anyEdaOk),
      edaClientConnected: Boolean(edaInfo.edaConnected),
      tools: TOOLS.length,
      pingMs: bestPing,
    };
    if (firstData && firstData.usage) systemStatusState.claudeUsage = firstData.usage;

    systemStatusState.ok = Boolean(onlineIds.length && allOnlineMcpOk);
    systemStatusState.updatedAt = Date.now();
  } catch {
    systemStatusState.healing = false;
  } finally {
    watchdogRunning = false;
  }
}

function startBridgeAndTunnelWatchdog() {
  runSystemWatchdogCycle(false).catch(() => {});
  setInterval(() => {
    runSystemWatchdogCycle(false).catch(() => {});
  }, 5000);
}



return { ensureEasyEdaBridge, nodeTunnelSock, healNodeTunnel, runSystemWatchdogCycle, startBridgeAndTunnelWatchdog, systemStatusState };
};
