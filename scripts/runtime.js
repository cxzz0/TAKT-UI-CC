#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
if (process.platform === 'win32') require('./load-env').load();
const cfg = require('../config');
const platform = require('../lib/platform');
const { spawn } = require('node:child_process');
const runDir = path.join(cfg.TAKT_HOME, 'run');
const services = [
  { name: 'mcp-server', file: 'mcp-server/server.js', args: ['--http'], port: cfg.MCP_PORT, health: '/health' },
  { name: 'workbench', file: 'server/server.js', args: [], port: cfg.PORT, health: '/api/health' },
];
async function health(service) {
  try { const r = await fetch(`http://127.0.0.1:${service.port}${service.health}`, { signal: AbortSignal.timeout(1500) }); return r.ok && await r.json(); } catch { return false; }
}
async function start() {
  fs.mkdirSync(runDir, { recursive: true }); fs.mkdirSync(cfg.LOG_DIR, { recursive: true });
  const started = [];
  try {
  for (const service of services) {
    const existing = await health(service);
    if (existing) {
      if (existing.dataDir !== cfg.TAKT_HOME) throw new Error(`端口 ${service.port} 正由另一个实例使用，请设置独立端口`);
      console.log(`${service.name} 已运行 (PID ${existing.pid})`); continue;
    }
    const log = fs.openSync(path.join(cfg.LOG_DIR, `${service.name}.log`), 'a');
    const child = spawn(process.execPath, [path.join(cfg.REPO_ROOT, service.file), ...service.args], {
      detached: true, windowsHide: true, env: platform.childEnv({ TAKT_MANAGED_SERVICES: '1' }), stdio: ['ignore', log, log],
    });
    fs.closeSync(log);
    started.push({ service, child });
    child.on('error', (err) => console.error(err.message)); child.unref();
    let ready;
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); ready = await health(service); if (ready) break; if (child.exitCode !== null) break; }
    if (!ready || ready.pid !== child.pid) throw new Error(`${service.name} 启动失败，查看 ${cfg.LOG_DIR}`);
    fs.writeFileSync(path.join(runDir, `${service.name}.json`), JSON.stringify({ pid: child.pid, port: service.port, dataDir: cfg.TAKT_HOME }));
    console.log(`${service.name} 已启动 (PID ${child.pid})`);
  }
  console.log(`工作台: http://127.0.0.1:${cfg.PORT}`);
  } catch (error) {
    for (const { service, child } of started.reverse()) {
      if (child.exitCode !== null) continue;
      try { await stopService(service, child.pid); } catch { child.kill(); }
    }
    throw error;
  }
}
async function stopService(service, expectedPid) {
  const running = await health(service);
  if (!running || running.dataDir !== cfg.TAKT_HOME || !Number.isInteger(running.pid) || (expectedPid && running.pid !== expectedPid)) return;
  const response = await fetch(`http://127.0.0.1:${service.port}${service.name === 'workbench' ? '/api/shutdown' : '/shutdown'}`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + cfg.getMcpToken() }, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`无法停止 ${service.name}: HTTP ${response.status}`);
  for (let i = 0; i < 60; i++) {
    const current = await health(service);
    let alive = false;
    try { process.kill(running.pid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if ((!current || current.pid !== running.pid) && !alive) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${service.name} 未能退出`);
}
async function stop() {
  // Identity comes from the running service, so a stale PID file can never kill another application.
  for (const service of [...services].reverse()) {
    await stopService(service);
    console.log(`已停止 ${service.name}`);
    try { fs.unlinkSync(path.join(runDir, `${service.name}.json`)); } catch {}
  }
}
async function doctor() {
  console.log(`TAKT ${require('../package.json').version} | ${process.platform} ${process.arch} | Node ${process.versions.node}`);
  console.log(`数据: ${cfg.TAKT_HOME}\nSSH: ${platform.ssh}`);
  const ssh = spawn(platform.ssh, ['-V'], { windowsHide: true, stdio: 'inherit' });
  await new Promise((r) => { ssh.on('error', (e) => { console.log('SSH 缺失: ' + e.message); r(); }); ssh.on('close', r); });
  for (const service of services) console.log(`${service.name}: ${await health(service) ? '运行中' : '未运行'} (:${service.port})`);
  console.log(`Syncthing 配置: ${cfg.findSyncthingConfig()} (${fs.existsSync(cfg.findSyncthingConfig()) ? '存在' : '未安装或未配置'})`);
  console.log('Tailscale 可单独安装并登录；通过 ~/.ssh/config 的 HostName 指定服务器的 Tailscale IP。');
}
if (require.main === module) {
  const command = process.argv[2] || 'start';
  const action = { start, stop, doctor }[command];
  if (!platform.isWindows && action) {
    const script = { start: 'start.sh', stop: 'stop.sh', doctor: 'doctor.sh' }[command];
    const child = spawn('bash', [path.join(__dirname, script)], { stdio: 'inherit' });
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code || 0; });
  } else (action ? action() : Promise.reject(new Error('用法: node scripts/runtime.js start|stop|doctor'))).catch((err) => { console.error(err.message); process.exitCode = 1; });
}
module.exports = { start, stop, health, services };
