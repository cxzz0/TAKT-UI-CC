# Windows 11 客户端（codex 分支）

本分支在 `codex/personal-multinode-hardening` 的模块结构上接入原生 Windows 客户端，参考上游 `windows` 分支：Electron 桌面壳、ConPTY 终端、Windows OpenSSH 和本机 MCP 工具。远端仍为运行 Claude Code 的 Linux 服务器。

## 从源码启动

安装 **Node.js 24 LTS**（最低 22.13，包含 `node:sqlite`），以及 Windows「可选功能」中的 **OpenSSH 客户端**。不需要 WSL、macOS 或 Xcode。终端使用 `node-pty` 提供的 Windows 预编译组件；若安装时回退到源码编译，需要 Visual Studio C++ Build Tools。

在 PowerShell 中执行：

```powershell
git clone --branch codex/personal-multinode-hardening https://github.com/cxzz0/TAKT-UI-CC.git
cd TAKT-UI-CC
npm ci
npm run desktop
```

已经下载源码的用户也可以双击根目录的 `start-windows.cmd`，它会在首次启动时安装依赖。桌面壳启动工作台和 MCP，关闭应用时回收本实例的服务、ConPTY 和 SSH 子进程。远端 tmux 会话继续运行。

只使用浏览器界面时：

```powershell
npm run start:all
# 在浏览器打开 http://127.0.0.1:3080
npm run doctor
npm run stop
```

桌面壳使用独立的工作台端口；MCP 默认端口为 18765。请先停止浏览器模式服务，再运行桌面壳。

## 连接 Linux 节点

在 `$env:USERPROFILE\.ssh\config` 中配置 SSH 别名，例如：

```sshconfig
Host my-linux
    HostName your-server.example.com
    User ubuntu
    IdentityFile ~/.ssh/id_ed25519
```

先执行 `ssh my-linux`，确认主机指纹并验证密钥登录；带密码的私钥可配合 Windows `ssh-agent`。再执行 `ssh -o BatchMode=yes my-linux true` 验证后台连接无需交互。远端需要 `tmux`、`python3`、`curl` 和 Claude Code。

在工作台「节点」中绑定该别名并启用节点。全新安装的默认节点是禁用、未绑定状态，配置完成后才能开启终端。

Windows OpenSSH 不支持 ControlMaster。本分支由 MCP 看门狗为每个节点管理一个前台 SSH 子进程，确认端口转发成功后才认为隧道已启动。MCP、可选的 Syncthing 和远程桌面转发保持回环绑定。节点变更、禁用或退出应用会停止本实例的子进程；端口冲突会报错，不会杀掉远端占用端口的进程。原始 EDA 转发需要显式启用 `TAKT_ENABLE_EDA_TUNNEL=1`。

## 数据、同步和配置

默认数据目录为 `$env:USERPROFILE\.takt-ai`，包含节点、SQLite、日志、`mcp-token` 和每台节点的文件镜像。可用环境变量指定 `TAKT_HOME`、`TAKT_PORT` 和 `TAKT_MCP_PORT`。路径支持盘符、空格和中文。

桌面壳和 Windows 启停命令还会读取初始数据目录下的 `env` 文件，在解析端口和路径前应用配置。格式为字面量 `KEY=value`，允许单双引号、CRLF 和 UTF-8 BOM，不执行 shell 表达式或变量展开：

```text
TAKT_HOME="D:\TAKT 数据"
TAKT_PORT=3080
TAKT_MCP_PORT=18765
```

可选安装 [Syncthing](https://syncthing.net/downloads/)，并在 Windows 与远端启动它。本机配置按 `%LOCALAPPDATA%\Syncthing\config.xml`、`%APPDATA%\Syncthing\config.xml` 查找，也可设置 `TAKT_SYNCTHING_CONFIG`。每个节点使用独立的本地镜像和远端目录；在 Syncthing 中确认两端设备和文件夹共享。可选安装 Tailscale，并让 SSH 的 `HostName` 指向服务器的 Tailscale 地址。

## MCP 鉴权与工具

沿用 codex 分支的安全策略：`/mcp`、`/messages`、`/sse` 和管理操作要求 `Authorization: Bearer <token>`；不能用查询参数、`X-Takt-Token` 或 `TAKT_REQUIRE_MCP_TOKEN=0` 绕过。自动创建的 token 文件使用当前用户专属 NTFS ACL。请将数据目录放在支持硬链接及 ACL 的本地 NTFS 卷。

初次配置和隧道修复都通过 SSH stdin 传送远端配置程序，将带 Authorization 头的 HTTP MCP 写入 Linux 的 `~/.claude.json`，保留其他配置与权限规则。`mac_host_exec` 仍默认由 Claude 询问权限；名称为兼容旧配置而保留，在 Windows 实际运行 **PowerShell**。Claude 的询问属于客户端策略，持有 token 的受信调用方仍可直接调用工具。

Windows 发布 21 个工具，包括 Blender、FreeCAD、嘉立创 EDA、浏览器、COM 串口、烧录、桌面截图和 PowerShell。Xcode 的两个工具仅在 macOS 发布。依赖的本机软件和驱动需自行安装，可用以下变量指定路径：

| 变量 | 用途 |
|---|---|
| `TAKT_SSH_BIN` | Windows OpenSSH 路径 |
| `TAKT_BLENDER_BIN` | `blender.exe` |
| `TAKT_FREECAD_CMD` / `TAKT_FREECAD_GUI` | FreeCAD 命令行 / GUI |
| `TAKT_EASYEDA_EXE` | 嘉立创 EDA 可执行文件 |
| `TAKT_CHROME_BIN` | Chrome / Edge |
| `TAKT_PYTHON` | Python 可执行文件 |
| `TAKT_IDF_EXPORT_PS1` | ESP-IDF 的 `export.ps1` |
| `TAKT_JLINK_EXE` / `TAKT_DFU_UTIL` | 烧录工具 |
| `TAKT_TAILSCALE_BIN` | Tailscale 可执行文件 |

## 打包与验证

在 Windows x64、Node.js 24 下执行：

```powershell
npm ci
npm run lint
npm run check
npm test
npm run build:windows
```

输出在 `dist\windows`：NSIS 安装版与 portable `.exe`。安装包包含独立 Node、SQLite、生产依赖和相应许可证，用户运行成品不需要另装 Node。打包钩子会用包内 Node 加载原生依赖，防止错误地依赖源码目录。产物未签名。

PR 的 Windows CI 执行鉴权、节点隔离、Windows 路径、NTFS ACL 和真实 ConPTY 回归测试，并上传 `takt-windows-x64` 构建产物。测试不连接真实 Linux 节点，也不验证 USB 硬件、外部应用或桌面交互；这些需要使用实际环境验证。

参考实现：[上游 Windows 分支](https://github.com/willwill85/TAKT-UI-CC/tree/windows)。另一个 [WSL2 fork 的 PR](https://github.com/willwill85/TAKT-UI-CC/pull/3) 提供以 WSL2 为客户端运行环境的方案。
