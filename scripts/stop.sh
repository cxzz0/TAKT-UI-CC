#!/usr/bin/env bash
# Stops the web workbench and the local MCP server. Remote tmux sessions keep running.
. "$(dirname "$0")/_common.sh"

stop_one() { # name port
  local name="$1" port="$2" pids
  if [ -f "$RUN_DIR/$name.pid" ]; then
    local pid script command_line
    pid="$(cat "$RUN_DIR/$name.pid")"
    case "$name" in workbench) script="$REPO_ROOT/server/server.js";; *) script="$REPO_ROOT/mcp-server/server.js";; esac
    command_line="$(ps -p "$pid" -o args= 2>/dev/null)"
    case "$command_line" in *"$script"*) kill "$pid" 2>/dev/null;; esac
    rm -f "$RUN_DIR/$name.pid"
  fi
  sleep 0.3
  port_listening "$port" && fail "$name (:$port) still listening" || ok "$name stopped"
}

stop_one workbench  "$TAKT_PORT"
stop_one mcp-server "$TAKT_MCP_PORT"

# Tear down the MCP reverse tunnels of the nodes configured in THIS $TAKT_HOME only
# (interactive terminals are separate ssh processes and are not touched).
NODE_BIN="$(find_node)" || exit 0
[ -f "$TAKT_HOME/nodes.json" ] || exit 0
"$NODE_BIN" -e '
const n = (require(process.argv[1]).nodes || []).filter((x) => x.sshHost);
const cfg = require(process.argv[2] + "/config");
const { nodeTunnelSock } = require(process.argv[2] + "/lib/tunnel-config");
for (const x of n) console.log(nodeTunnelSock(cfg, x) + "\t" + x.sshHost);
' "$TAKT_HOME/nodes.json" "$REPO_ROOT" | while IFS=$'\t' read -r sock host; do
  [ -S "$sock" ] && ssh -S "$sock" -O exit "$host" >/dev/null 2>&1 && ok "closed tunnel for $host"
done
exit 0
