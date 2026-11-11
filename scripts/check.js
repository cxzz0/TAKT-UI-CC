'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', 'vendor', 'desktop', 'build', 'dist'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (/\.(c?js|sh)$/.test(file)) {
      if (file.endsWith('.sh') && process.platform === 'win32') continue;
      const js = /\.c?js$/.test(file);
      const result = spawnSync(js ? process.execPath : 'bash',
        [js ? '--check' : '-n', file], { stdio: 'inherit', windowsHide: true });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}
visit(path.resolve(__dirname, '..'));
