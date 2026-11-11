'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
// Runs the same hermetic HTTP/auth and native terminal checks on Windows and POSIX.
const result = spawnSync(process.execPath, ['--test', 'test/http.test.js', 'test/windows.test.js'], {
  cwd: path.join(__dirname, '..'), stdio: 'inherit', windowsHide: true,
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
