'use strict';
const { spawn } = require('node:child_process');
const platform = require('./platform');
const { tunnelArgs } = require('./tunnel-config');

// Only the MCP watchdog owns these foreground Windows OpenSSH processes.
class TunnelManager {
  constructor(cfg, launch = spawn) { this.cfg = cfg; this.launch = launch; this.tunnels = new Map(); this.jobs = new Map(); this.closing = false; }
  signature(node) { return JSON.stringify(tunnelArgs(this.cfg, node, true)); }
  isRunning(node) {
    const entry = this.tunnels.get(node.id);
    return Boolean(entry && entry.ready && !entry.failed && entry.signature === this.signature(node));
  }
  ensure(node) {
    if (this.closing) return Promise.reject(new Error('Tunnel manager is stopping'));
    if (this.jobs.has(node.id)) return this.jobs.get(node.id);
    const job = this.start(node).finally(() => this.jobs.delete(node.id));
    this.jobs.set(node.id, job);
    return job;
  }
  async start(node) {
    const previous = this.tunnels.get(node.id);
    if (previous && !previous.failed && previous.signature === this.signature(node)) return previous.started;
    await this.stop(node.id);
    if (this.closing) throw new Error('Tunnel manager is stopping');
    const child = this.launch(platform.ssh, tunnelArgs(this.cfg, node, true), {
      env: platform.childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const entry = { child, signature: this.signature(node), ready: false, failed: false, error: '' };
    this.tunnels.set(node.id, entry);
    entry.closed = new Promise(resolve => { child.once('close', resolve); child.once('error', resolve); });
    entry.started = new Promise((resolve, reject) => {
      const fail = () => { entry.failed = true; clearTimeout(timer); reject(new Error(`Tunnel failed for ${node.id}: check SSH and remote port ownership`)); };
      const timer = setTimeout(() => { fail(); child.kill(); }, 10000);
      let output = '';
      child.stdout.on('data', data => {
        output = (output + data).slice(-1000);
        if (output.includes('TAKT_TUNNEL_READY')) { clearTimeout(timer); entry.ready = true; resolve(entry); }
      });
      child.stderr.on('data', data => { entry.error = (entry.error + data).slice(-2000); });
      child.stdin.on('error', () => {});
      child.once('error', fail);
      child.once('close', fail);
    });
    return entry.started;
  }
  async stop(id) {
    const entry = this.tunnels.get(id);
    if (!entry) return;
    this.tunnels.delete(id);
    if (entry.child.exitCode !== null || entry.child.signalCode) return;
    entry.child.kill();
    let timer;
    try {
      await Promise.race([entry.closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SSH tunnel did not stop')), 3000); })]);
    } finally { clearTimeout(timer); }
  }
  async reconcile(nodes) {
    for (const id of this.tunnels.keys()) {
      const node = nodes.find(n => n.id === id && n.enabled && n.sshHost);
      if (!node || this.tunnels.get(id).signature !== this.signature(node)) await this.stop(id);
    }
  }
  async stopAll() {
    this.closing = true;
    for (const id of this.tunnels.keys()) await this.stop(id);
    await Promise.allSettled(this.jobs.values());
  }
}
module.exports = { TunnelManager };
