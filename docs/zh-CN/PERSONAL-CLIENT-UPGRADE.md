# 个人多机器客户端升级说明

本次保留 SSH、tmux、Syncthing 和 Claude Code 的运行方式，完善个人工作台的安全与可维护性。完整模块表和技术细节见[英文说明](../PERSONAL-CLIENT-UPGRADE.md)。

## 已实现

- **认证闭环**：MCP 的 HTTP/SSE 接口、隧道自愈和远程桌面动作强制校验 Bearer Token。旧开关不能关闭认证，URL 参数不能传 Token。远程初始化和自愈共用配置迁移逻辑，写入带认证头的 HTTP MCP 配置。
- **默认权限**：移除旧版对整个 MCP 服务的自动放行规则，`mac_host_exec` 默认 `ask`。显式配置 `TAKT_AUTO_ALLOW_HOST_EXEC=1` 才加入该工具的 allow；保留无关设置和已有 deny。这里的确认由 Claude Code 执行，持有 Token 的进程仍可直接调用工具。
- **多节点一致性**：MCP 异步调用独立保存节点上下文，生成文件和命令工作目录跟随节点。文件缺失时不再去另一台机器的镜像查找。会话重命名、删除、标题缓存和终端选择同时考虑节点与会话 ID。
- **配置贯通**：移除作者的个人路径、SSH 别名和设备 ID，使用仓库依赖与共享配置。初次启动只有一个未绑定、未启用的节点。自定义端口贯通后端、隧道、远程 MCP 配置与原生桌面 URL。
- **隧道管理**：MCP 守护服务统一负责创建和修复隧道；不同实例使用独立 socket。自愈不再强杀远端占用端口的进程。原始 EDA 端口转发默认关闭，本地 EDA MCP 工具仍可使用。
- **模块与验证**：拆出节点注册、远程配置、SQLite 仓储、会话扫描/索引、MCP 上下文、协议分发、工具、监控和浏览器资源；增加行为回归测试及 CI 检查。HTTP/聊天/文件路由仍由工作台入口协调，前端保留原生 JS，无构建步骤。

## 升级步骤

1. 备份本机的 `nodes.json`、`takt-workbench.sqlite`、`session-titles.json`，以及远端 `~/.claude.json`、`~/.claude/settings.json`。
2. 使用旧版本的 `scripts/stop.sh` 停止旧实例。如果旧隧道仍占用远端端口，手动关闭确认属于旧实例的 ControlMaster；新版本会报告冲突，不会强杀占用者。
3. 切换到本次分支，运行 `npm ci` 和 `bash scripts/start.sh`。已有节点 ID 和目录保留，不搬动本地镜像。
4. 在 UI 中重新保存各启用节点，或点击「隧道自愈」，刷新远端认证和权限配置。随后在远端 Claude Code 中通过 `/mcp` 重连 `mac-industrial`，或重启会话，让配置生效。
5. 自定义端口写入 `$TAKT_HOME/env`；`TAKT_MCP_HOST` 必须保持 `127.0.0.1`。多个 TAKT 实例不要同时管理同一个远端 SSH 账号的 `mac-industrial` 配置。

Token 轮换：停止两项本地服务，删除 `$TAKT_HOME/mcp-token`（或更新 `TAKT_MCP_TOKEN`），重启并刷新所有可信节点。独立模型预览页的动作按钮需要输入 Token；多节点时通过 `/viewer?node=<节点ID>` 指定目录。

只有需要远端直接访问原始 EasyEDA Bridge 时才设置 `TAKT_ENABLE_EDA_TUNNEL=1`；该入口不经过 MCP Token 认证。通过 MCP 调用 EDA 工具无需开启它。

## 验证范围

```bash
npm run lint
npm run check
npm test
npm run test:smoke
```

本次测试使用临时目录与端口，没有连接你的真实服务器。已验证认证、配置迁移、并发节点隔离、同 ID 会话、SQLite 迁移、启动脚本和 HTTP 资源。完整图形交互受 Chromium 沙箱限制未能执行；macOS 原生编译由 CI 检查，真实 SSH/tmux 重连、Syncthing 配对、Mac 应用及硬件调用仍需在实际设备上验收。
