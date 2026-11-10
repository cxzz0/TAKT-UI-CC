'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', 'vendor', 'desktop', 'build'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (/\.(js|sh)$/.test(file)) {
      const result = spawnSync(file.endsWith('.js') ? process.execPath : 'bash',
        [file.endsWith('.js') ? '--check' : '-n', file], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}
visit(path.resolve(__dirname, '..'));
