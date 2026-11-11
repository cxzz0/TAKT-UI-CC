'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
module.exports = function createToolExecutor({ cfg, PATHS, resolveWorkPath, rewriteScriptPaths, getActiveNodeConfig, runCommand, ensureEasyEdaBridge, EDA_PORT }) {
function stripHtmlToText(html = '') {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

// ============================================================================
// Tool Execution Implementation
// ============================================================================
async function executeTool(name, args = {}) {
  const MAC_WORK_DIR = resolveWorkPath();
  switch (name) {
    case 'blender_run_python': {
      let scriptPath;
      if (args.script_file) {
        scriptPath = resolveWorkPath(args.script_file);
        if (fs.existsSync(scriptPath)) {
          const original = await fsp.readFile(scriptPath, 'utf8');
          const rewritten = rewriteScriptPaths(original);
          if (rewritten !== original) await fsp.writeFile(scriptPath, rewritten, 'utf8');
        }
      } else if (args.script_code) {
        scriptPath = path.join(MAC_WORK_DIR, `_blender_job_${Date.now()}.py`);
        await fsp.writeFile(scriptPath, rewriteScriptPaths(args.script_code), 'utf8');
      } else {
        throw new Error('请提供 script_code 或 script_file');
      }

      const cliArgs = ['-b'];
      if (args.blend_file) {
        const bf = resolveWorkPath(args.blend_file);
        if (fs.existsSync(bf)) cliArgs.push(bf);
      }
      cliArgs.push('-P', scriptPath);

      const res = await runCommand(PATHS.blenderBin, cliArgs, { cwd: MAC_WORK_DIR });
      return `Blender 执行完成 (exitCode=${res.exitCode}):\nSTDOUT:\n${res.stdout.slice(-4000)}\nSTDERR:\n${res.stderr.slice(-2000)}`;
    }

    case 'blender_render_image': {
      const blendFile = resolveWorkPath(args.blend_file);
      const outImg = resolveWorkPath(args.output_image || 'render_preview.png');
      const engine = args.engine || 'BLENDER_EEVEE_NEXT';
      const samples = Number(args.samples || 32);

      const renderPy = path.join(MAC_WORK_DIR, `_blender_render_${Date.now()}.py`);
      const pyContent = `
import bpy
scene = bpy.context.scene
try:
    scene.render.engine = '${engine}'
except Exception:
    scene.render.engine = 'CYCLES'

if scene.render.engine == 'CYCLES':
    scene.cycles.samples = ${samples}
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = '${process.platform === 'win32' ? 'CUDA' : 'METAL'}'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        scene.cycles.device = 'GPU'
    except Exception as e:
        print("Metal GPU setup warning:", e)
else:
    try:
        scene.eevee.taa_render_samples = ${samples}
    except Exception:
        pass

if not scene.camera:
    bpy.ops.object.camera_add(location=(6.0, -6.0, 5.0), rotation=(1.1, 0.0, 0.785))
    scene.camera = bpy.context.active_object

scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = ${JSON.stringify(outImg)}
bpy.ops.render.render(write_still=True)
print("RENDER_SAVED_TO:", scene.render.filepath)
`;
      await fsp.writeFile(renderPy, pyContent, 'utf8');
      const res = await runCommand(PATHS.blenderBin, ['-b', blendFile, '-P', renderPy], { cwd: MAC_WORK_DIR });
      await fsp.unlink(renderPy).catch(() => {});
      return `Mac GPU 渲染完成 (exitCode=${res.exitCode})\n输出图片: ${outImg}\n日志:\n${res.stdout.slice(-3000)}`;
    }

    case 'blender_open_gui': {
      const target = args.file_path ? resolveWorkPath(args.file_path) : '';
      const cmdArgs = target && fs.existsSync(target)
        ? ['-a', PATHS.blenderApp, target]
        : ['-a', PATHS.blenderApp];
      await runCommand('open', cmdArgs);
      return `已在 Mac 桌面打开 Blender${target ? `: ${target}` : ''}`;
    }

    case 'freecad_run_python': {
      let scriptPath;
      if (args.script_file) {
        scriptPath = resolveWorkPath(args.script_file);
        if (fs.existsSync(scriptPath)) {
          const original = await fsp.readFile(scriptPath, 'utf8');
          const rewritten = rewriteScriptPaths(original);
          if (rewritten !== original) await fsp.writeFile(scriptPath, rewritten, 'utf8');
        }
      } else if (args.script_code) {
        scriptPath = path.join(MAC_WORK_DIR, `_freecad_job_${Date.now()}.py`);
        await fsp.writeFile(scriptPath, rewriteScriptPaths(args.script_code), 'utf8');
      } else {
        throw new Error('请提供 script_code 或 script_file');
      }

      const res = await runCommand(PATHS.freecadCmd, [scriptPath], { cwd: MAC_WORK_DIR });
      return `Mac FreeCADCmd 执行完成 (exitCode=${res.exitCode}):\nSTDOUT:\n${res.stdout.slice(-4000)}\nSTDERR:\n${res.stderr.slice(-2000)}`;
    }

    case 'freecad_inspect_step': {
      const targetFile = resolveWorkPath(args.file_path);
      if (!fs.existsSync(targetFile)) {
        throw new Error(`文件不存在: ${targetFile}`);
      }
      const inspectPy = path.join(MAC_WORK_DIR, `_freecad_inspect_${Date.now()}.py`);
      const pyCode = `
import json, FreeCAD, Part
path = ${JSON.stringify(targetFile)}
if path.lower().endswith('.fcstd'):
    doc = FreeCAD.openDocument(path)
    shapes = [o.Shape for o in doc.Objects if hasattr(o, 'Shape') and not o.Shape.isNull()]
    shape = Part.makeCompound(shapes) if shapes else Part.Shape()
else:
    shape = Part.read(path)

bb = shape.BoundBox
holes = []
for f in shape.Faces:
    surf = f.Surface
    if surf.__class__.__name__ == 'Cylinder':
        c = surf.Center
        r = surf.Radius
        holes.append({
            "center": [round(c.x, 3), round(c.y, 3), round(c.z, 3)],
            "radius": round(r, 3),
            "diameter": round(r * 2, 3)
        })

info = {
    "file": path,
    "bounding_box_mm": {
        "x_min": round(bb.XMin, 3), "x_max": round(bb.XMax, 3), "x_length": round(bb.XLength, 3),
        "y_min": round(bb.YMin, 3), "y_max": round(bb.YMax, 3), "y_length": round(bb.YLength, 3),
        "z_min": round(bb.ZMin, 3), "z_max": round(bb.ZMax, 3), "z_length": round(bb.ZLength, 3),
    },
    "solids_count": len(shape.Solids),
    "faces_count": len(shape.Faces),
    "cylindrical_features_sample": holes[:30]
}
print("STEP_INSPECT_JSON:" + json.dumps(info, ensure_ascii=False))
`;
      await fsp.writeFile(inspectPy, pyCode, 'utf8');
      const res = await runCommand(PATHS.freecadCmd, [inspectPy], { cwd: MAC_WORK_DIR });
      await fsp.unlink(inspectPy).catch(() => {});
      const match = res.stdout.match(/STEP_INSPECT_JSON:(\{.*\})/);
      if (match) {
        return JSON.stringify(JSON.parse(match[1]), null, 2);
      }
      return `FreeCAD Inspect Output:\n${res.stdout}\n${res.stderr}`;
    }

    case 'freecad_open_gui': {
      const target = args.file_path ? resolveWorkPath(args.file_path) : '';
      const cmdArgs = target && fs.existsSync(target)
        ? ['-a', PATHS.freecadApp, target]
        : ['-a', PATHS.freecadApp];
      await runCommand('open', cmdArgs);
      return `已在 Mac 桌面打开 FreeCAD${target ? `: ${target}` : ''}`;
    }

    case 'jlceda_bridge_status': {
      const bridgePort = await ensureEasyEdaBridge();
      if (args.select_window_id) {
        await runCommand('curl', [
          '-s',
          '-X',
          'POST',
          `http://127.0.0.1:${bridgePort}/eda-windows/select`,
          '-H',
          'Content-Type: application/json',
          '-d',
          JSON.stringify({ windowId: String(args.select_window_id) }),
        ]);
      }
      const healthRes = await runCommand('curl', ['-s', `http://127.0.0.1:${bridgePort}/health`]);
      const winRes = await runCommand('curl', ['-s', `http://127.0.0.1:${bridgePort}/eda-windows`]);
      let health = {};
      let windows = {};
      try { health = JSON.parse(healthRes.stdout || '{}'); } catch {}
      try { windows = JSON.parse(winRes.stdout || '{}'); } catch {}
      return JSON.stringify({
        bridgePort,
        bridgeUrl: `http://localhost:${bridgePort}`,
        health,
        windows,
      }, null, 2);
    }

    case 'jlceda_bridge_execute': {
      const bridgePort = await ensureEasyEdaBridge();
      const payload = { code: String(args.code || '') };
      if (args.window_id) payload.windowId = String(args.window_id);
      const execRes = await runCommand('curl', [
        '-s',
        '--max-time',
        '35',
        '-X',
        'POST',
        `http://127.0.0.1:${bridgePort}/execute`,
        '-H',
        'Content-Type: application/json',
        '-d',
        JSON.stringify(payload),
      ]);
      return execRes.stdout || execRes.stderr || 'No response from EasyEDA Bridge';
    }

    case 'jlceda_inspect_epro': {
      const eproPath = resolveWorkPath(args.epro_path);
      if (!fs.existsSync(eproPath)) {
        throw new Error(`未找到嘉立创工程文件: ${eproPath}`);
      }
      const pyCode = `
import zipfile, json, sys
path = sys.argv[1]
result = {"file": path, "entries": [], "json_files": {}}
with zipfile.ZipFile(path, 'r') as z:
    result["entries"] = z.namelist()
    for name in z.namelist():
        if name.endswith('.json') and z.getinfo(name).file_size < 2_000_000:
            try:
                data = json.loads(z.read(name).decode('utf-8', errors='replace'))
                result["json_files"][name] = list(data.keys()) if isinstance(data, dict) else f"list[{len(data)}]"
            except Exception as e:
                result["json_files"][name] = f"parse_error: {e}"
print(json.dumps(result, ensure_ascii=False, indent=2))
`;
      const res = await runCommand('/usr/bin/python3', ['-c', pyCode, eproPath], { cwd: MAC_WORK_DIR });
      return res.stdout || res.stderr;
    }

    case 'jlceda_modify_epro': {
      const eproPath = resolveWorkPath(args.epro_path);
      const outPath = args.output_path ? resolveWorkPath(args.output_path) : eproPath;
      if (!fs.existsSync(eproPath)) {
        throw new Error(`未找到嘉立创工程文件: ${eproPath}`);
      }
      const wrapperPy = `
import zipfile, tempfile, shutil, os, subprocess, sys
epro_path = sys.argv[1]
out_path = sys.argv[2]
patch_code = sys.argv[3]

if os.path.abspath(epro_path) == os.path.abspath(out_path):
    shutil.copy2(epro_path, epro_path + '.bak')

tmp_dir = tempfile.mkdtemp(prefix='jlceda_epro_')
try:
    with zipfile.ZipFile(epro_path, 'r') as z:
        z.extractall(tmp_dir)
    env = dict(os.environ)
    env['EPRO_UNPACK_DIR'] = tmp_dir
    proc = subprocess.run([sys.executable, '-c', patch_code], cwd=tmp_dir, env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        print("PATCH_ERROR:", proc.stderr, file=sys.stderr)
        sys.exit(proc.returncode)
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as zout:
        for root, dirs, files in os.walk(tmp_dir):
            for file in files:
                full = os.path.join(root, file)
                rel = os.path.relpath(full, tmp_dir)
                zout.write(full, rel)
    print("EPRO_REPACKED_OK:", out_path)
    if proc.stdout:
        print("PATCH_STDOUT:", proc.stdout)
finally:
    shutil.rmtree(tmp_dir, ignore_errors=True)
`;
      const res = await runCommand('/usr/bin/python3', ['-c', wrapperPy, eproPath, outPath, args.python_patch_code], {
        cwd: MAC_WORK_DIR,
      });
      return `嘉立创 .epro 工程修改结果 (exitCode=${res.exitCode}):\n${res.stdout}\n${res.stderr}`;
    }

    case 'jlceda_generate_extension_script': {
      const target = resolveWorkPath(args.file_name || 'jlc_script.js');
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, args.content, 'utf8');
      return `已生成嘉立创 EDA 自动化脚本/封装文件并同步至: ${target}`;
    }

    case 'jlceda_open_gui': {
      const target = args.file_path ? resolveWorkPath(args.file_path) : '';
      const cmdArgs = target && fs.existsSync(target)
        ? ['-a', PATHS.jlcedaApp, target]
        : ['-a', PATHS.jlcedaApp];
      await runCommand('open', cmdArgs);
      return `已在 Mac 桌面启动 嘉立创EDA(专业版)${target ? `: ${target}` : ''}`;
    }

    case 'mac_browser_fetch': {
      const maxChars = Number(args.max_chars || 20000);
      const res = await runCommand('curl', [
        '-sSL',
        '--max-time', '25',
        '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        args.url,
      ]);
      if (res.exitCode !== 0 && !res.stdout) {
        throw new Error(`请求失败: ${res.stderr}`);
      }
      const text = stripHtmlToText(res.stdout).slice(0, maxChars);
      return `URL: ${args.url}\n---\n${text}`;
    }

    case 'mac_browser_chrome_extract': {
      const maxChars = Number(args.max_chars || 20000);
      const res = await runCommand(PATHS.chromeBin, [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--virtual-time-budget=5000',
        '--dump-dom',
        args.url,
      ], { timeoutMs: 35000 });
      const content = args.raw_html ? res.stdout : stripHtmlToText(res.stdout);
      return `Chrome Rendered URL: ${args.url}\n---\n${content.slice(0, maxChars)}`;
    }

    case 'mac_browser_open_url': {
      await runCommand('open', [args.url]);
      return `已在 Mac 默认浏览器打开: ${args.url}`;
    }

    // --- 5. Xcode & iPhone Build / Flash / Debug ---
    case 'xcode_list_devices': {
      const devCtl = await runCommand(PATHS.xcrun, ['devicectl', 'list', 'devices'], { timeoutMs: 20000 });
      const xcTrace = await runCommand(PATHS.xcrun, ['xctrace', 'list', 'devices'], { timeoutMs: 20000 });
      return `=== xcrun devicectl list devices ===\n${devCtl.stdout}\n${devCtl.stderr}\n=== xcrun xctrace list devices ===\n${xcTrace.stdout}`;
    }

    case 'xcode_build_and_deploy_iphone': {
      const projPath = resolveWorkPath(args.project_or_workspace_path);
      const isWorkspace = projPath.endsWith('.xcworkspace');
      const cfg = args.configuration || 'Debug';
      const derivedData = path.join(MAC_WORK_DIR, '.xcode_derived_data');

      const buildArgs = [
        isWorkspace ? '-workspace' : '-project',
        projPath,
        '-scheme',
        args.scheme,
        '-configuration',
        cfg,
        '-derivedDataPath',
        derivedData,
        '-allowProvisioningUpdates',
      ];
      if (args.device_udid) {
        buildArgs.push('-destination', `id=${args.device_udid}`);
      } else {
        buildArgs.push('-destination', 'generic/platform=iOS');
      }
      if (Array.isArray(args.extra_xcodebuild_args)) {
        buildArgs.push(...args.extra_xcodebuild_args);
      }
      buildArgs.push('build');

      const buildRes = await runCommand(PATHS.xcodeBuild, buildArgs, {
        cwd: path.dirname(projPath),
        timeoutMs: 300000,
      });

      let outputLog = `xcodebuild 结果 (exitCode=${buildRes.exitCode}):\n${buildRes.stdout.slice(-3500)}\n${buildRes.stderr.slice(-1500)}`;
      if (buildRes.exitCode !== 0 || args.install_and_launch === false || !args.device_udid) {
        return outputLog;
      }

      const findRes = await runCommand('find', [derivedData, '-name', '*.app', '-type', 'd']);
      const appPath = findRes.stdout.split('\n').map((s) => s.trim()).find((s) => s.includes(`${cfg}-iphoneos`));
      if (!appPath) {
        return `${outputLog}\n⚠️ 未找到真机 .app 产物，请检查编译日志。`;
      }

      const installRes = await runCommand(PATHS.xcrun, [
        'devicectl', 'device', 'install', 'app',
        '--device', args.device_udid,
        appPath,
      ], { timeoutMs: 120000 });
      outputLog += `\n\n=== 真机烧录安装 (${appPath}) ===\n${installRes.stdout}\n${installRes.stderr}`;

      if (args.bundle_id && installRes.exitCode === 0) {
        const launchRes = await runCommand(PATHS.xcrun, [
          'devicectl', 'device', 'process', 'launch',
          '--device', args.device_udid,
          args.bundle_id,
        ]);
        outputLog += `\n=== 真机启动 (${args.bundle_id}) ===\n${launchRes.stdout}\n${launchRes.stderr}`;
      }
      return outputLog;
    }

    // --- 6. Local USB & Serial Port Tools ---
    case 'usb_list_devices_and_ports': {
      const serials = fs.readdirSync('/dev')
        .filter((f) => f.startsWith('cu.') || f.startsWith('tty.usb'))
        .map((f) => `/dev/${f}`);
      const usbRes = await runCommand('system_profiler', ['SPUSBDataType', '-detailLevel', 'mini'], { timeoutMs: 15000 });
      return `=== Mac 本地串口设备 (/dev/cu.*) ===\n${serials.join('\n')}\n\n=== Mac USB 物理设备树 ===\n${usbRes.stdout}`;
    }

    case 'usb_serial_monitor': {
      const port = args.port;
      const baud = Number(args.baudrate || 115200);
      const duration = Math.min(30, Math.max(1, Number(args.read_duration_sec || 3)));
      const sendData = args.send_data || '';

      const pyScript = `
import os, sys, termios, time, select

port = sys.argv[1]
baud = int(sys.argv[2])
duration = float(sys.argv[3])
send_str = sys.argv[4]

BAUD_MAP = {
    9600: termios.B9600,
    19200: termios.B19200,
    38400: termios.B38400,
    57600: termios.B57600,
    115200: termios.B115200,
    230400: termios.B230400,
}

fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
try:
    attrs = termios.tcgetattr(fd)
    spd = BAUD_MAP.get(baud, termios.B115200)
    attrs[0] = 0
    attrs[1] = 0
    attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
    attrs[3] = 0
    attrs[4] = spd
    attrs[5] = spd
    termios.tcsetattr(fd, termios.TCSANOW, attrs)

    if send_str:
        os.write(fd, (send_str + "\\r\\n").encode('utf-8'))

    end_time = time.time() + duration
    buf = bytearray()
    while time.time() < end_time:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            chunk = os.read(fd, 4096)
            if chunk:
                buf.extend(chunk)
    print(buf.decode('utf-8', errors='replace'))
finally:
    os.close(fd)
`;
      const res = await runCommand('/usr/bin/python3', ['-c', pyScript, port, String(baud), String(duration), sendData], {
        timeoutMs: (duration + 5) * 1000,
      });
      return `串口 ${port} (@${baud}bps, 采集 ${duration}s) 输出:\n${res.stdout}\n${res.stderr}`;
    }

    // --- 7. Local MCU / Embedded Firmware Flashing ---
    case 'hardware_flash_firmware': {
      const flasher = args.flasher;
      const fwPath = args.firmware_path ? resolveWorkPath(args.firmware_path) : '';
      const addr = args.flash_address || '0x0';

      if (flasher === 'esptool') {
        const port = args.port || '/dev/cu.usbserial-5B0B0246551';
        const chip = args.chip || 'auto';
        const cliArgs = [PATHS.esptoolPy, '--chip', chip, '--port', port, 'write_flash', addr, fwPath];
        if (Array.isArray(args.extra_args)) cliArgs.push(...args.extra_args);
        const res = await runCommand(PATHS.espPython, cliArgs, { timeoutMs: 120000 });
        return `ESP32 烧录结果 (exitCode=${res.exitCode}):\n${res.stdout}\n${res.stderr}`;
      }

      if (flasher === 'jlink') {
        const chip = args.chip || 'STM32F103RC';
        const jlinkScript = path.join(MAC_WORK_DIR, `_jlink_flash_${Date.now()}.jlink`);
        const loadAddr = fwPath.endsWith('.bin') ? ` ${addr === '0x0' ? '0x08000000' : addr}` : '';
        const content = `r\nh\nloadfile "${fwPath}"${loadAddr}\nr\ng\nq\n`;
        await fsp.writeFile(jlinkScript, content, 'utf8');
        const res = await runCommand(PATHS.jlinkExe, [
          '-device', chip,
          '-if', 'SWD',
          '-speed', '4000',
          '-autoconnect', '1',
          '-CommandFile', jlinkScript,
        ], { timeoutMs: 60000 });
        await fsp.unlink(jlinkScript).catch(() => {});
        return `SEGGER J-Link 烧录结果 (exitCode=${res.exitCode}):\n${res.stdout}\n${res.stderr}`;
      }

      if (flasher === 'dfu') {
        const cliArgs = ['-a', '0', '-D', fwPath];
        if (Array.isArray(args.extra_args)) cliArgs.push(...args.extra_args);
        const res = await runCommand(PATHS.dfuUtil, cliArgs, { timeoutMs: 60000 });
        return `DFU 烧录结果 (exitCode=${res.exitCode}):\n${res.stdout}\n${res.stderr}`;
      }

      if (flasher === 'idf_py') {
        const projDir = fwPath || MAC_WORK_DIR;
        const portFlag = args.port ? `-p ${args.port}` : '';
        const cmd = `source ${JSON.stringify(cfg.IDF_EXPORT_SH)} && idf.py ${portFlag} build flash`;
        const res = await runCommand('/bin/zsh', ['-c', cmd], { cwd: projDir, timeoutMs: 300000 });
        return `ESP-IDF 编译烧录结果 (exitCode=${res.exitCode}):\n${res.stdout.slice(-4000)}\n${res.stderr.slice(-2000)}`;
      }

      throw new Error(`未知烧录器类型: ${flasher}`);
    }

    // --- 8. Local Mac Screen Capture & Host Command Bridge ---
    case 'mac_screen_capture': {
      const shotsDir = path.join(MAC_WORK_DIR, 'screenshots');
      await fsp.mkdir(shotsDir, { recursive: true });
      const fileName = args.output_filename || `screen_${Date.now()}.png`;
      const outPath = path.join(shotsDir, path.basename(fileName));
      const shotNode = getActiveNodeConfig();
      const linuxSyncedPath = `${((shotNode && shotNode.remoteWorkDir) || "/root/work").replace(/\/+$/, '')}/screenshots/${path.basename(fileName)}`;

      if (args.activate_app) {
        await runCommand('osascript', ['-e', `tell application "${args.activate_app}" to activate`], { timeoutMs: 5000 });
        await new Promise((r) => setTimeout(r, 500));
      }

      const capArgs = ['-x'];
      if (args.region) {
        capArgs.push('-R', String(args.region));
      }
      capArgs.push(outPath);
      const capRes = await runCommand('/usr/sbin/screencapture', capArgs, { timeoutMs: 15000 });
      if (!fs.existsSync(outPath)) {
        throw new Error(`Mac 截屏失败 (请确认终端/Node 具有 macOS 屏幕录制权限): ${capRes.stderr}`);
      }

      const maxDim = Number(args.max_dimension_px || 1600);
      if (maxDim > 0) {
        await runCommand('/usr/bin/sips', ['-Z', String(maxDim), outPath], { timeoutMs: 10000 });
      }

      const textSummary = `✅ Mac 截屏成功！\n- Mac 本地路径: ${outPath}\n- 远端 Linux 同步路径: ${linuxSyncedPath}`;
      if (args.return_inline_image !== false) {
        const imgBuf = await fsp.readFile(outPath);
        return {
          __mcp_content: [
            { type: 'text', text: textSummary },
            { type: 'image', data: imgBuf.toString('base64'), mimeType: 'image/png' },
          ],
        };
      }
      return textSummary;
    }

    case 'mac_host_exec': {
      const cwd = args.cwd ? resolveWorkPath(args.cwd) : MAC_WORK_DIR;
      const timeoutMs = Math.min(600000, Math.max(5000, Number(args.timeout_sec || 120) * 1000));
      const cmd = rewriteScriptPaths(args.command);
      const res = await runCommand('/bin/zsh', ['-c', cmd], { cwd, timeoutMs });
      return `Mac 本机命令执行完成 (exitCode=${res.exitCode}, cwd=${cwd}):\nSTDOUT:\n${res.stdout.slice(-6000)}\nSTDERR:\n${res.stderr.slice(-3000)}`;
    }

    case 'work_sync_status': {
      const dir = args.subdir ? resolveWorkPath(args.subdir) : MAC_WORK_DIR;
      const items = await fsp.readdir(dir, { withFileTypes: true });
      const rows = [];
      for (const item of items) {
        const full = path.join(dir, item.name);
        const st = await fsp.stat(full).catch(() => null);
        rows.push({
          name: item.name,
          type: item.isDirectory() ? 'dir' : 'file',
          size: st ? st.size : 0,
          mtime: st ? st.mtime.toISOString() : null,
        });
      }
      return JSON.stringify({ mac_work_dir: dir, files: rows }, null, 2);
    }

    default:
      throw new Error(`未知工具: ${name}`);
  }
}

// ============================================================================
// JSON-RPC 2.0 MCP Handler

return executeTool;
};
