# Personal multi-machine client: upgrade notes

This fork keeps the existing execution model: Windows/Electron or macOS UI + Node workbench, SSH/tmux on trusted Linux machines, Syncthing file mirrors, and local MCP tools. See [Windows setup](WINDOWS11.md) for the native Windows client. It does not add accounts, a task scheduler, or a replacement agent runtime.

## What changed

- Workbench dependencies now resolve from this checkout's `node_modules`. Paths, ports, Syncthing discovery and optional workspace links come from `config.js`. A fresh installation has one **disabled, unbound** node.
- All MCP transports (`/mcp`, `/messages`, `/sse`) and management actions (`/system-heal`, `/remote-desktop`) require a bearer header. `TAKT_REQUIRE_MCP_TOKEN=0` cannot disable authentication. Query-string tokens and `X-Takt-Token` are not accepted.
- The workbench provisions remote configuration; the MCP watchdog alone owns tunnel creation/repair. Both initial provisioning and tunnel repair write an HTTP MCP entry with an Authorization header to the remote `~/.claude.json`. They replace the legacy stdio client entry, preserve unrelated configuration, and write files atomically with mode `0600`. Invalid existing JSON produces an error instead of being replaced.
- Provisioning removes the legacy blanket allow entries for this tool server, defaults `mac_host_exec` to `ask`, and preserves unrelated allow/ask/deny rules. `TAKT_AUTO_ALLOW_HOST_EXEC=1` opts into allowing that exact tool. An existing deny rule continues to win. Claude's prompts are **client policy**, not server-side approval enforcement; a trusted token holder can call tools directly.
- MCP request context is scoped with `AsyncLocalStorage`. Relative and remote paths use the selected node's mirror, including generated scripts, captures and command working directories. A missing file is no longer looked up in other mirrors. These mappings prevent accidental routing mistakes; they are not a filesystem sandbox for trusted shell/Python tools.
- Session renames, deletions, title mirrors and terminal selection include the node identity. Duplicate session IDs on different machines no longer share mutations. Legacy ID-only title entries are applied only when the local database identifies one owner.
- Tunnel sockets include an instance/node/port hash. Repair closes only that instance's ControlMaster; it no longer kills remote processes to reclaim ports. A conflicting port is reported as an error. Raw EDA forwarding is off by default; local EDA MCP tools still work.
- Browser requests for remote desktop go through the same-origin workbench proxy. The native shell resolves `$TAKT_HOME/env` through the same configuration as the launch scripts. The standalone MCP viewer asks for a token for action buttons and keeps it only in page memory.

## Upgrade an existing installation

1. Back up `nodes.json`, `takt-workbench.sqlite`, `session-titles.json`, and the remote `~/.claude.json` / `~/.claude/settings.json`. Local mirrors are not moved or deleted by this upgrade.
2. Stop the previous instance with its existing `scripts/stop.sh`. If an older hardcoded tunnel is still holding a remote port, close its **known** ControlMaster manually. The new repair code intentionally reports this conflict instead of killing the port's owner.
3. Install this revision's dependencies with `npm ci`, then run `bash scripts/start.sh`. Existing node IDs and configured directories are retained; new installations use `node-1` without an SSH binding.
4. Re-save each enabled node or click **隧道自愈**. This updates its MCP authentication and permission entries. Reconnect the `mac-industrial` server with `/mcp`, or restart the remote Claude Code session, so it reloads the configuration.
5. Keep `TAKT_MCP_HOST=127.0.0.1`. If custom ports are used, set them in `$TAKT_HOME/env`; the workbench, MCP service, remote configuration, tunnels and desktop URL now agree on those values.

Rotate a token by stopping both local services, deleting `$TAKT_HOME/mcp-token` (or changing `TAKT_MCP_TOKEN`), restarting, and re-saving/healing every trusted node. A node with the old token will fail authentication until refreshed. Remote user-scoped Claude configuration has one `mac-industrial` entry; two TAKT instances must not simultaneously manage the same remote SSH account.

If you intentionally need direct remote access to an existing unauthenticated EasyEDA bridge, set `TAKT_ENABLE_EDA_TUNNEL=1`. This forwards its configured base port outside MCP authentication and grants that remote account the bridge's capabilities. The authenticated EDA MCP tools do not require this setting.

## Module map

| Path | Responsibility |
|---|---|
| `config.js` | Runtime paths, validated ports, loopback binding and feature options |
| `lib/mcp-token.js`, `lib/http-security.js` | Atomic shared token creation, bearer and Host/Origin validation |
| `lib/node-registry.js` | Shared node loading, validation, persistence and SSH alias discovery |
| `lib/remote-config.js`, `lib/tunnel-config.js` | One remote config migration and one tunnel argument/socket definition |
| `server/repositories/workbench-db.js` | SQLite schema, migration and prepared statements |
| `server/services/session-scanner.js`, `session-index.js` | Passive remote history scan and persistent local session index |
| `server/services/node-provisioner.js` | Node setup and authenticated remote client provisioning |
| `mcp-server/request-context.js` | Request-local node and work-path routing |
| `mcp-server/rpc.js`, `tools/` | MCP dispatch, tool metadata and tool execution |
| `mcp-server/watchdog.js`, `viewer.js` | Health/repair lifecycle and standalone viewer |
| `server/public/assets/` | Browser behavior, styles, node display helpers and icons; no build step |

The workbench entrypoint still composes HTTP/WebSocket routes and chat/file behavior. This is an incremental separation of tested boundaries; it is not a wholesale frontend framework rewrite or a claim that every feature is independently modularized.

## Verification

```bash
npm ci
npm run lint
npm run check
npm test
npm run test:smoke
```

The regression suite uses temporary state and no real SSH machines. It covers concurrent token creation, authenticated HTTP endpoints and proxy behavior, remote Python migration, overlapping node tool execution, cross-node session identity, SQLite migration, invalid registry input, file-preview containment and nondefault ports. The shell smoke test starts and stops both real local services with isolated data/ports. CI runs these checks and builds the Swift desktop target on macOS.

Real SSH/tmux reconnects, Syncthing pairing, macOS application permissions and hardware actions still need acceptance testing on your Mac and trusted Linux nodes. The Linux development environment cannot substitute for those checks. Browser automation was also blocked by the local Chromium sandbox; HTTP asset loading and JavaScript syntax/lint checks passed, but a complete graphical interaction check was not performed.
