'use strict';
function shQuote(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'"; }
function sessionName(tabId) { return 'takt_' + (String(tabId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 28) || 'main'); }
function remoteSessionCommand(tabId, cwd) {
  const session = shQuote(sessionName(tabId));
  return `export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH"; CWD=${shQuote(cwd)}; ` +
    'if ! mkdir -p "$CWD" 2>/dev/null || ! cd "$CWD" 2>/dev/null; then ' +
    'if [ -d "$HOME/Documents/work" ]; then CWD="$HOME/Documents/work"; else CWD="$HOME/work"; mkdir -p "$CWD" 2>/dev/null || CWD="$HOME"; fi; ' +
    'cd "$CWD" 2>/dev/null || cd "$HOME" || exit 1; fi; ' +
    `if command -v tmux >/dev/null 2>&1; then tmux has-session -t ${session} 2>/dev/null || tmux new-session -d -s ${session} -c "$CWD" 'bash -l'; ` +
    `tmux set-option -t ${session} status off; tmux set-option -t ${session} mouse on; exec tmux attach-session -t ${session}; else exec bash -l; fi`;
}
function interactiveArgs(tabId, cwd, host) {
  if (!host || host.startsWith('-') || /[\r\n\0]/.test(host)) throw new Error('无效 SSH 主机');
  return ['-tt', '-o', 'ClearAllForwardings=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=6', '-o', 'ConnectTimeout=8', host, remoteSessionCommand(tabId, cwd)];
}
module.exports = { shQuote, sessionName, remoteSessionCommand, interactiveArgs };
