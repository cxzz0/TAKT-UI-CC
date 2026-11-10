'use strict';
module.exports = function viewer(port) {
const VIEWER_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>Mac 工业软件与硬件烧录控制台 & 3D 实时预览窗 (work/)</title>
  <script type="module" src="https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
      background: #0f1117;
      color: #e2e8f0;
      display: flex;
      height: 100vh;
      overflow: hidden;
    }
    .sidebar {
      width: 350px;
      background: #161922;
      border-right: 1px solid #262b38;
      display: flex;
      flex-direction: column;
      padding: 16px;
      gap: 12px;
    }
    h1 { font-size: 16px; font-weight: 600; color: #f8fafc; }
    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 11px;
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .btn-group { display: flex; flex-direction: column; gap: 7px; }
    button {
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 9px 12px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      text-align: left;
      display: flex;
      align-items: center;
      justify-content: space-between;
      transition: background 0.15s;
    }
    button:hover { background: #1d4ed8; }
    button.secondary { background: #262b38; color: #cbd5e1; }
    button.secondary:hover { background: #333a4b; }
    .file-list {
      flex: 1;
      overflow-y: auto;
      border: 1px solid #262b38;
      border-radius: 8px;
      padding: 8px;
      background: #0f1117;
    }
    .file-item {
      padding: 8px 10px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
    .file-item:hover, .file-item.active { background: #1e293b; color: #60a5fa; }
    .viewer-pane {
      flex: 1;
      display: flex;
      flex-direction: column;
      position: relative;
      background: radial-gradient(circle at center, #1e2433 0%, #0f1117 100%);
    }
    model-viewer {
      width: 100%;
      height: 100%;
      --poster-color: transparent;
    }
    .topbar {
      position: absolute;
      top: 16px;
      left: 16px;
      right: 16px;
      display: flex;
      justify-content: space-between;
      pointer-events: none;
      z-index: 10;
    }
    .status-pill {
      pointer-events: auto;
      background: rgba(22, 25, 34, 0.85);
      backdrop-filter: blur(8px);
      border: 1px solid #2d3548;
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 12px;
      max-width: 90%;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <div class="sidebar">
    <div>
      <h1>Mac 工业软件与硬件 MCP 工作台</h1>
      <div style="margin-top:6px;"><span class="badge">Syncthing + 19项硬件/软件 MCP 在线</span></div>
    </div>
    <div class="btn-group">
      <button onclick="openApp('freecad_open_gui')">
        <span>🔧 用 FreeCAD 打开选中模型</span>
        <span>→</span>
      </button>
      <button onclick="openApp('blender_open_gui')">
        <span>🎨 用 Blender 打开/渲染场景</span>
        <span>→</span>
      </button>
      <button onclick="openApp('jlceda_open_gui')">
        <span>⚡ 启动 嘉立创 EDA (专业版)</span>
        <span>→</span>
      </button>
      <button class="secondary" onclick="openApp('usb_list_devices_and_ports')">
        <span>🔌 查看本机 USB 烧录器与串口</span>
        <span>→</span>
      </button>
      <button class="secondary" onclick="openApp('xcode_list_devices')">
        <span>📱 查看本机连接 iPhone / Xcode 设备</span>
        <span>→</span>
      </button>
      <button class="secondary" onclick="window.open('http://127.0.0.1:${port}', '_blank')">
        <span>💬 打开 DeepSeek Harness (纯显示 UI)</span>
        <span>↗</span>
      </button>
    </div>
    <div style="font-size:12px;color:#94a3b8;margin-top:4px;">work/ 目录同步文件 (自动刷新):</div>
    <div class="file-list" id="fileList">加载中...</div>
  </div>
  <div class="viewer-pane">
    <div class="topbar">
      <div class="status-pill" id="currentFileLabel">选择左侧 .glb / .gltf 模型即可 360° 实时预览（或点击上方按钮调起 FreeCAD / Blender / 嘉立创 EDA / USB & iPhone 检测）</div>
    </div>
    <model-viewer id="mv" camera-controls auto-rotate shadow-intensity="1"></model-viewer>
  </div>
  <script>
    let selectedFile = '';
    let token = '';
    const nodeQuery = new URLSearchParams(location.search).get('node') || '';
    const withNode = (url) => url + '?node=' + encodeURIComponent(nodeQuery);
    let lastMtimeMap = {};

    async function refreshFiles() {
      const res = await fetch(withNode('/api/files'));
      const data = await res.json();
      const list = document.getElementById('fileList');
      list.innerHTML = '';
      for (const f of data.files) {
        const div = document.createElement('div');
        div.className = 'file-item' + (selectedFile === f.name ? ' active' : '');
        div.textContent = f.name + ' · ' + (f.size / 1024).toFixed(1) + ' KB';
        div.onclick = () => selectFile(f.name);
        list.appendChild(div);

        if (selectedFile === f.name && lastMtimeMap[f.name] && lastMtimeMap[f.name] !== f.mtime) {
          selectFile(f.name, true);
        }
        lastMtimeMap[f.name] = f.mtime;
      }
    }

    function selectFile(name, reload = false) {
      selectedFile = name;
      document.getElementById('currentFileLabel').textContent = '当前选中: ' + name + (reload ? ' (已实时同步更新!)' : '');
      if (name.endsWith('.glb') || name.endsWith('.gltf')) {
        document.getElementById('mv').src = '/work/' + encodeURIComponent(name) + '?node=' + encodeURIComponent(nodeQuery) + '&t=' + Date.now();
      }
      refreshFiles();
    }

    async function openApp(toolName) {
      if (!token) token = prompt('请输入本机 $TAKT_HOME/mcp-token（仅保存在当前页面内存）') || '';
      if (!token) return;
      const res = await fetch(withNode('/mcp'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: { name: toolName, arguments: selectedFile ? { file_path: selectedFile } : {} }
        })
      });
      if (res.status === 401) { token = ''; document.getElementById('currentFileLabel').textContent = 'Token 无效，请重试'; return; }
      const out = await res.json();
      const msg = out?.result?.content?.[0]?.text || '已发送指令';
      document.getElementById('currentFileLabel').textContent = msg.slice(0, 600);
    }

    refreshFiles();
    setInterval(refreshFiles, 1500);
  </script>
</body>
</html>`;

return VIEWER_HTML;
};
