#!/usr/bin/env node
/**
 * TAKT-UI-CC — local MCP server ("mac-industrial-mcp")
 * --------------------------------------------------------------------------------------
 * Runs on YOUR machine (macOS) and is reverse-tunnelled (ssh -R) to every Linux node, so that
 * Claude Code running remotely can drive local applications and hardware:
 *   1. Blender            - bpy scripts, Metal GPU rendering, GUI launch
 *   2. FreeCAD            - freecadcmd parametric modeling, STEP inspection, GUI launch
 *   3. JLC EDA Pro (EasyEDA) - .epro/.epro2 parser & patcher, bridge scripts (optional external bridge)
 *   4. Local browser      - JS-rendered DOM dump, Markdown fetch, open URL
 *   5. Xcode / iPhone     - xcodebuild, xcrun devicectl, xctrace
 *   6. USB / serial       - enumeration and serial port I/O
 *   7. MCU flashing       - esptool / ESP-IDF, J-Link, dfu-util
 *   8. Host command bridge (mac_host_exec) and screen capture
 *   9. Built-in 3D model viewer at http://127.0.0.1:<port>/viewer
 *
 * Every tool is optional: tools whose application is not installed simply return an error message.
 * SECURITY: binds to 127.0.0.1 only and requires `Authorization: Bearer <token>` on /mcp
 * (token file: $TAKT_HOME/mcp-token). Do NOT expose this port to a network.
 */

const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const platform = require('../lib/platform');
const windowsTools = require('./windows-tools');

const cfg = require('../config');
const { isLoopbackHost, isLocalOrigin, hasBearerToken } = require('../lib/http-security');
const { createRequestContext } = require('./request-context');

const MAC_WORK_DIR = cfg.DEFAULT_WORK_DIR;
const PORT = cfg.MCP_PORT;
const BIND_HOST = cfg.MCP_HOST;
const EDA_PORT = cfg.EDA_PORT;
const SSH_SOCKET_DIR = cfg.SSH_SOCKET_DIR;
const MCP_TOKEN = cfg.getMcpToken();
fs.mkdirSync(SSH_SOCKET_DIR, { recursive: true });

const PATHS = {
  blenderBin: '/Applications/Blender.app/Contents/MacOS/Blender',
  blenderApp: '/Applications/Blender.app',
  freecadCmd: '/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd',
  freecadApp: '/Applications/FreeCAD.app',
  jlcedaApp: '/Applications/嘉立创EDA(专业版).app',
  chromeBin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  xcodeBuild: '/usr/bin/xcodebuild',
  xcrun: '/usr/bin/xcrun',
  jlinkExe: '/usr/local/bin/JLinkExe',
  dfuUtil: '/opt/homebrew/bin/dfu-util',
  esptoolPy: path.join(cfg.ESP_PYTHON_ENV, 'bin/esptool.py'),
  espPython: path.join(cfg.ESP_PYTHON_ENV, 'bin/python'),
  ...(platform.isWindows ? windowsTools.paths() : {}),
};

fs.mkdirSync(MAC_WORK_DIR, { recursive: true });



const { readNodes: loadConfiguredNodes } = require('../lib/node-registry')(cfg);

const requestContext = createRequestContext({ loadNodes: loadConfiguredNodes, defaultWorkDir: MAC_WORK_DIR });
const { getActiveNodeConfig, resolveWorkPath, rewriteScriptPaths } = requestContext;

function runCommand(cmd, args, options = {}) {
  const timeoutMs = options.timeoutMs || 180000;
  const cwd = options.cwd || cfg.TAKT_HOME;
  const isBgSsh = cmd === 'ssh' && Array.isArray(args) && args.includes('-Nf');
  const spec = platform.commandSpec(cmd, args);
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd,
      env: platform.childEnv(options.env), windowsHide: true,
      stdio: isBgSsh ? 'ignore' : [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(options.input); }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString(); });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: stderr + '\n' + err.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 0, stdout, stderr, timedOut });
    });
  });
}

// ============================================================================
// MCP Tool Definitions (19 Tools covering 3D/CAD/EDA/Browser/Xcode/USB/Flashing)
// ============================================================================
const toolRegistry = require('./tools/registry');
const TOOLS = platform.isWindows ? windowsTools.describe(toolRegistry) : toolRegistry;
const { ensureEasyEdaBridge, nodeTunnelSock, healNodeTunnel, ensureNodeTunnel, runSystemWatchdogCycle, startBridgeAndTunnelWatchdog, systemStatusState, stop: stopWatchdog } = require('./watchdog')({ cfg, runCommand, loadConfiguredNodes, TOOLS, MCP_TOKEN });
const remoteDesktop = require('./remote-desktop')({ runCommand, ensureNodeTunnel, healNodeTunnel, nodeTunnelSock });

const executeCommonTool = require('./tools')({ cfg, PATHS, resolveWorkPath, rewriteScriptPaths, getActiveNodeConfig, runCommand, ensureEasyEdaBridge, EDA_PORT });
async function executeTool(name, args = {}) {
  if (platform.isWindows) {
    const result = await windowsTools.execute(name, args, { runCommand, resolveWorkPath, rewriteScriptPaths, node: getActiveNodeConfig(), paths: PATHS });
    if (result.handled) return result.output;
  }
  return executeCommonTool(name, args);
}
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await stopWatchdog(); } finally { process.exit(0); }
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const handleJsonRpc = require('./rpc')(TOOLS, executeTool);

// ============================================================================
// Built-in 3D Real-time Model Viewer & Mac Hardware Action Bar HTML (/viewer)
// ============================================================================
const VIEWER_HTML = require('./viewer')(cfg.PORT);

if (process.argv.includes('--stdio')) {
  let buf = '';
  process.stdin.on('data', async (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
        const resp = msg.method === 'tools/call'
          ? await requestContext.run(process.env.TAKT_NODE_ID, () => handleJsonRpc(msg))
          : await handleJsonRpc(msg);
        if (resp) {
          process.stdout.write(JSON.stringify(resp) + '\n');
        }
      } catch (error) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32602, message: error.message } }) + '\n');
      }
    }
  });
} else {
  const sseClients = new Map();

  const server = http.createServer(async (req, res) => {
    try {
    // No CORS headers on purpose: browsers on other origins must not be able to call this server.
    // Reject DNS-rebinding (non-loopback Host) and any browser request carrying a foreign Origin.
    if (!isLoopbackHost(req.headers.host) || (req.headers.origin && !isLocalOrigin(req.headers.origin, PORT))) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden host or origin');
      return;
    }
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const protectedEndpoint = ['/mcp', '/messages', '/sse', '/system-heal', '/remote-desktop', '/shutdown'].includes(urlObj.pathname);
    if (protectedEndpoint && !hasBearerToken(req.headers, MCP_TOKEN)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: missing or invalid MCP token' } }));
      return;
    }
    if (['/system-heal', '/remote-desktop', '/shutdown'].includes(urlObj.pathname) && req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      res.end('Method not allowed');
      return;
    }

    if (urlObj.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'mac-industrial-mcp', workDir: MAC_WORK_DIR, tools: TOOLS.length, pid: process.pid, platform: process.platform, dataDir: cfg.TAKT_HOME }));
      return;
    }
    if (urlObj.pathname === '/shutdown') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(shutdown, 50);
      return;
    }

    if (urlObj.pathname === '/system-status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(systemStatusState));
      return;
    }

    if (urlObj.pathname === '/system-heal' && req.method === 'POST') {
      if (cfg.WATCHDOG_ENABLED) await runSystemWatchdogCycle(true);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(systemStatusState));
      return;
    }

    if (urlObj.pathname === '/remote-desktop' && (req.method === 'POST' || req.method === 'GET')) {
      let rawBody = '';
      for await (const chunk of req) rawBody += chunk.toString();
      let body = {};
      try { body = rawBody ? JSON.parse(rawBody) : {}; } catch {}
      const action = String(body.action || urlObj.searchParams.get('action') || 'start').trim();
      const nodeId = String(body.nodeId || urlObj.searchParams.get('nodeId') || '').trim();
      const nodes = loadConfiguredNodes();
      const node = nodeId ? nodes.find((n) => n.id === nodeId || n.sshHost === nodeId) : nodes.find((n) => n.enabled && n.sshHost && n.desktopWebPort);
      if (!node || !node.enabled || !node.sshHost) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '未配置可用的远程桌面节点' }));
        return;
      }
      const result = await remoteDesktop(node, action);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
      return;
    }

    if (urlObj.pathname === '/viewer' || urlObj.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(VIEWER_HTML);
      return;
    }

    if (urlObj.pathname === '/api/files') {
      let raw;
      try { raw = await requestContext.run(urlObj.searchParams.get('node'), () => executeTool('work_sync_status', {})); }
      catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message, files: [] })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(raw);
      return;
    }

    if (urlObj.pathname.startsWith('/work/')) {
      const rel = decodeURIComponent(urlObj.pathname.slice('/work/'.length));
      let root;
      try { root = requestContext.run(urlObj.searchParams.get('node'), () => resolveWorkPath()); }
      catch { res.writeHead(400); res.end('Select a valid node'); return; }
      const inside = (p) => p === root || p.startsWith(root + path.sep);
      let safePath = path.resolve(root, rel);
      if (inside(safePath) && !fs.existsSync(safePath)) {
        try {
          const topEntries = fs.readdirSync(root, { withFileTypes: true });
          for (const ent of topEntries) {
            if (ent.isDirectory() && !ent.name.startsWith('.')) {
              const cand = path.resolve(root, ent.name, rel);
              if (inside(cand) && fs.existsSync(cand)) {
                safePath = cand;
                break;
              }
            }
          }
        } catch {}
      }
      if (!inside(safePath) || !fs.existsSync(safePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const realRoot = fs.realpathSync(root);
      const realFile = fs.realpathSync(safePath);
      if (!(realFile === realRoot || realFile.startsWith(realRoot + path.sep)) || !fs.statSync(safePath).isFile()) { res.writeHead(404); res.end('Not found'); return; }
      const ext = path.extname(safePath).toLowerCase();
      const mimeMap = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.glb': 'model/gltf-binary',
        '.gltf': 'model/gltf+json',
        '.pdf': 'application/pdf',
      };
      const headers = {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      };
      if (mimeMap[ext]) {
        headers['Content-Type'] = mimeMap[ext];
      }
      res.writeHead(200, headers);
      fs.createReadStream(safePath).pipe(res);
      return;
    }

    if (urlObj.pathname === '/sse' && req.method === 'GET') {
      const clientId = String(Date.now()) + Math.random().toString(36).slice(2, 6);
      const nodeParam = urlObj.searchParams.get('node') || req.headers['x-takt-node'] || '';
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const endpointUrl = `/messages?clientId=${clientId}${nodeParam ? `&node=${encodeURIComponent(nodeParam)}` : ''}`;
      res.write(`event: endpoint\ndata: ${endpointUrl}\n\n`);
      sseClients.set(clientId, { res, nodeId: nodeParam });
      req.on('close', () => sseClients.delete(clientId));
      return;
    }

    if ((urlObj.pathname === '/mcp' || urlObj.pathname === '/messages') && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          const clientId = urlObj.searchParams.get('clientId');
          const sseEntry = clientId ? sseClients.get(clientId) : null;
          const reqNodeId = urlObj.searchParams.get('node') || req.headers['x-takt-node'] || (sseEntry && sseEntry.nodeId) || null;
          const resp = payload.method === 'tools/call'
            ? await requestContext.run(reqNodeId, () => handleJsonRpc(payload))
            : await handleJsonRpc(payload);
          if (sseEntry && sseEntry.res && resp) {
            sseEntry.res.write(`event: message\ndata: ${JSON.stringify(resp)}\n\n`);
            res.writeHead(202);
            res.end('Accepted');
            return;
          }
          if (!resp) {
            res.writeHead(202);
            res.end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(resp));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: err.message } }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'MCP request failed' }));
    }
  });

  server.listen(PORT, BIND_HOST, () => {
    console.log(`[mac-industrial-mcp] Listening on http://${BIND_HOST}:${PORT}/mcp (3D Viewer: http://127.0.0.1:${PORT}/viewer)`);
    if (cfg.WATCHDOG_ENABLED) startBridgeAndTunnelWatchdog();
  });
}
