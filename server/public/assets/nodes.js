'use strict';
window.TaktNodes = {
  getNodeInfo(nodes, nodeId) {
    return nodes.find((n) => n.id === nodeId || n.sshHost === nodeId || n.localWorkAlias === nodeId)
      || nodes[0] || { id: 'node-1', name: 'Linux 节点 1', badge: 'LX-1', sshHost: '',
        remoteWorkDir: '/root/work', localWorkDir: '', localWorkAlias: 'work', enabled: false };
  },
};
