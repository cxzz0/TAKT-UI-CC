'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('node:path');

function createRequestContext({ loadNodes, defaultWorkDir }) {
  const storage = new AsyncLocalStorage();
  function selectNode(nodeId) {
    const nodes = loadNodes();
    if (nodeId) {
      const node = nodes.find((n) => [n.id, n.sshHost, n.localWorkAlias].includes(nodeId));
      if (!node) throw new Error(`Unknown node: ${nodeId}`);
      return { ...node };
    }
    if (nodes.length !== 1) throw new Error('Multiple nodes configured; supply ?node=<id> or TAKT_NODE_ID for stdio');
    return { ...nodes[0] };
  }
  function getActiveNodeConfig() { return storage.getStore() || selectNode(process.env.TAKT_NODE_ID); }
  function run(nodeId, callback) { return storage.run(selectNode(nodeId), callback); }
  function resolveWorkPath(input = '') {
    const node = getActiveNodeConfig();
    const local = node.localWorkDir || defaultWorkDir;
    const remote = (node.remoteWorkDir || '/root/work').replace(/\/+$/, '');
    const value = String(input).trim();
    if (!value) return local;
    for (const prefix of [remote, '/root/work', '/home/ubuntu/work', '/home/ubuntu/Projects']) {
      if (value === prefix || value.startsWith(prefix + '/')) {
        return path.resolve(local, '.' + value.slice(prefix.length));
      }
    }
    // Absolute host paths remain available to the trusted local tool pack.
    // Relative/remote paths never search another node's mirror on a cache miss.
    return path.isAbsolute(value) ? path.resolve(value) : path.resolve(local, value);
  }
  function rewriteScriptPaths(code = '') {
    const node = getActiveNodeConfig();
    const local = node.localWorkDir || defaultWorkDir;
    const prefixes = [...new Set([node.remoteWorkDir, '/root/work', '/home/ubuntu/work', '/home/ubuntu/Projects'].filter(Boolean))]
      .sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return String(code).replace(new RegExp(`(?:${prefixes.join('|')})(?=/|[^a-zA-Z0-9_.-]|$)`, 'g'), () => local);
  }
  return { run, getActiveNodeConfig, resolveWorkPath, rewriteScriptPaths };
}

module.exports = { createRequestContext };
