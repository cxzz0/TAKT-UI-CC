'use strict';
const TOOLS = [
  // --- 1. Blender Tools ---
  {
    name: 'blender_run_python',
    description:
      '在用户本机 Mac 的 Blender (/Applications/Blender.app) 中无头执行 bpy Python 脚本。脚本默认在共享目录 work/ 下运行，支持将 /root/work 路径自动映射为 Mac 本地 work 目录。可用于组装 .stl/.obj、赋予材质、设置灯光动画并导出 .blend 或 .glb。',
    inputSchema: {
      type: 'object',
      properties: {
        script_code: { type: 'string', description: '完整的 Blender Python (bpy) 脚本内容。' },
        script_file: { type: 'string', description: 'work/ 目录下已有的 .py 脚本路径。' },
        blend_file: { type: 'string', description: '可选：启动时先加载的 .blend 文件路径。' },
      },
    },
  },
  {
    name: 'blender_render_image',
    description:
      '调用用户本机 MacBook 的 Apple Silicon (Metal GPU) 对指定的 .blend 工程进行高速硬件光追/EEVEE渲染，并将渲染出的 PNG 图片保存到同步的 work/ 目录中。',
    inputSchema: {
      type: 'object',
      properties: {
        blend_file: { type: 'string', description: '要渲染的 .blend 文件路径（位于 work/ 下）。' },
        output_image: { type: 'string', description: '输出的 PNG 文件路径（默认 render_preview.png）。' },
        engine: {
          type: 'string',
          enum: ['BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'CYCLES'],
          description: '渲染引擎，快速预览推荐 BLENDER_EEVEE_NEXT，真实光追推荐 CYCLES（自动开启苹果 Metal GPU）。',
        },
        samples: { type: 'number', description: '渲染采样数（默认 32）。' },
      },
      required: ['blend_file'],
    },
  },
  {
    name: 'blender_open_gui',
    description: '在用户本地 MacBook 桌面上直接唤起原生 Blender GUI 界面并打开指定的 .blend 文件。',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '要打开的 .blend 文件路径（可选）。' },
      },
    },
  },

  // --- 2. FreeCAD Tools ---
  {
    name: 'freecad_run_python',
    description:
      '在用户本机 Mac 的 FreeCAD (/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd) 中无头执行 Python 参数化建模脚本，生成原生 .FCStd（带完整特征树）、.step 与 .stl 文件到同步的 work/ 目录。',
    inputSchema: {
      type: 'object',
      properties: {
        script_code: { type: 'string', description: '完整的 FreeCAD Python 脚本代码（可使用 FreeCAD, Part, Mesh 等模块）。' },
        script_file: { type: 'string', description: 'work/ 目录下已有的 .py 脚本路径。' },
      },
    },
  },
  {
    name: 'freecad_inspect_step',
    description:
      '使用本机 Mac 的 FreeCAD 引擎读取 work/ 目录下的 .step / .stp / .FCStd 文件（如 PCB 3D 模型），精确提取 BoundingBox 边界尺寸以及安装孔坐标与半径。',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'STEP 或 FCStd 文件路径（位于 work/ 下）。' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'freecad_open_gui',
    description: '在用户本地 MacBook 桌面上直接唤起原生 FreeCAD GUI 并打开指定的 .FCStd / .step 文件。',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '要打开的 .FCStd 或 .step 文件路径。' },
      },
    },
  },

  // --- 3. 嘉立创 EDA Pro Tools (EasyEDA Bridge + .epro Tools) ---
  {
    name: 'jlceda_bridge_status',
    description:
      '检查本地 Mac 嘉立创EDA专业版 (EasyEDA) WebSocket Bridge (端口 49620-49629) 的健康状态与已连接的 EDA 窗口列表 (/health 与 /eda-windows)，若 Bridge 未启动会自动在 Mac 后台拉起，并支持切换当前激活的 EDA 窗口。请通过此已认证的 MCP 工具访问 Bridge；原始 EDA 端口的 SSH 转发默认关闭。',
    inputSchema: {
      type: 'object',
      properties: {
        select_window_id: {
          type: 'string',
          description: '可选：若传入 windowId，则将该窗口设为当前活动的嘉立创EDA窗口 (/eda-windows/select)。',
        },
      },
    },
  },
  {
    name: 'jlceda_bridge_execute',
    description:
      '通过本地 Mac 嘉立创EDA专业版 (EasyEDA) WebSocket Bridge (POST http://127.0.0.1:49620/execute) 在正在运行的嘉立创EDA客户端内实时执行 eda.* API JavaScript 代码并返回结果（如创建/打开工程、绘制原理图器件与连线、PCB 布局布线、DRC 检查等）。完整 API 规范请参考 ~/.claude/skills/easyeda-api/SKILL.md。',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            '要在嘉立创EDA客户端 async function(eda) { ... } 上下文中执行的 JavaScript 代码（必须使用 return 返回结果，不要包含单行 // 注释）。例如: return await eda.dmt_Project.getCurrentProjectInfo();',
        },
        window_id: {
          type: 'string',
          description: '可选：指定执行的 EDA 窗口 ID（默认使用当前激活窗口）。',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'jlceda_inspect_epro',
    description:
      '解析 work/ 目录下的嘉立创 EDA 专业版工程文件（.epro / .epro2），提取内部结构、原理图/PCB 列表、器件 BOM 清单及网表概要。',
    inputSchema: {
      type: 'object',
      properties: {
        epro_path: { type: 'string', description: 'work/ 目录下的 .epro 或 .epro2 文件路径。' },
      },
      required: ['epro_path'],
    },
  },
  {
    name: 'jlceda_modify_epro',
    description:
      '对 work/ 目录下的嘉立创 EDA 专业版 (.epro / .epro2) 工程进行源码级修改：自动解压、执行 Python 修改脚本后重打包（自动备份原文件）。',
    inputSchema: {
      type: 'object',
      properties: {
        epro_path: { type: 'string', description: '目标 .epro / .epro2 文件路径。' },
        output_path: { type: 'string', description: '输出文件路径（默认覆盖原文件并创建 .bak 备份）。' },
        python_patch_code: {
          type: 'string',
          description: '用于修改解压后目录的 Python 代码（环境变量 EPRO_UNPACK_DIR 指向解压后的根目录）。',
        },
      },
      required: ['epro_path', 'python_patch_code'],
    },
  },
  {
    name: 'jlceda_generate_extension_script',
    description:
      '生成嘉立创 EDA 专业版扩展 SDK (eda.* API) 自动化脚本并保存至 work/ 目录，同时支持生成标准 .kicad_mod 封装文件。',
    inputSchema: {
      type: 'object',
      properties: {
        file_name: { type: 'string', description: '保存的文件名，如 jlc_script.js 或 sensor.kicad_mod。' },
        content: { type: 'string', description: '脚本或封装文件的完整内容。' },
      },
      required: ['file_name', 'content'],
    },
  },
  {
    name: 'jlceda_open_gui',
    description: '在用户本地 MacBook 桌面上直接启动 嘉立创EDA(专业版).app，可选传入工程文件路径。',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '可选：要在嘉立创 EDA 专业版中打开的 .epro / .epro2 文件路径。' },
      },
    },
  },

  // --- 4. Local Mac Browser Tools ---
  {
    name: 'mac_browser_fetch',
    description:
      '使用用户本机 Mac 的真实网络请求 URL 并提取文本/Markdown。可绕过远端 Linux 服务器机房 IP 访问立创商城、GitHub、国内网站时的验证码或拦截。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要访问的完整 URL (http/https)。' },
        max_chars: { type: 'number', description: '返回的最大字符数（默认 20000）。' },
      },
      required: ['url'],
    },
  },
  {
    name: 'mac_browser_chrome_extract',
    description:
      '使用用户本机 Mac 的 Google Chrome 浏览器渲染动态网页（支持 SPA / JavaScript 渲染页面）并提取渲染后的 DOM 文本或 HTML。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要使用本地 Chrome 渲染提取的网页 URL。' },
        raw_html: { type: 'boolean', description: '是否返回原始 HTML（默认 false）。' },
        max_chars: { type: 'number', description: '返回的最大字符数（默认 20000）。' },
      },
      required: ['url'],
    },
  },
  {
    name: 'mac_browser_open_url',
    description: '在用户本机 Mac 的默认浏览器中打开指定 URL。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要在 Mac 桌面浏览器打开的 URL。' },
      },
      required: ['url'],
    },
  },

  // --- 5. Xcode & iPhone Build / Flash / Debug Tools ---
  {
    name: 'xcode_list_devices',
    description:
      '列出当前连接到用户 MacBook 的所有 iPhone / iPad / Apple Watch 真机设备及 iOS 模拟器（获取设备名称、UDID、连接状态与系统版本）。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'xcode_build_and_deploy_iphone',
    description:
      '调用本机 Mac 的 Xcode (xcodebuild + xcrun devicectl) 编译 iOS/macOS 工程，并支持直接将编译生成的 .app 烧录安装并启动到连接在 Mac 上的 iPhone 真机！',
    inputSchema: {
      type: 'object',
      properties: {
        project_or_workspace_path: {
          type: 'string',
          description: '.xcodeproj 或 .xcworkspace 路径（可位于 work/ 或 Mac 本机任意路径）。',
        },
        scheme: { type: 'string', description: 'Xcode 编译 Scheme 名称。' },
        configuration: { type: 'string', enum: ['Debug', 'Release'], description: '默认 Debug。' },
        device_udid: {
          type: 'string',
          description: '目标 iPhone 真机的 UDID（可通过 xcode_list_devices 获取；若为空则仅编译或安装到首台连接的真机）。',
        },
        install_and_launch: {
          type: 'boolean',
          description: '编译成功后是否自动烧录安装并启动到 iPhone 真机（默认 true）。',
        },
        bundle_id: {
          type: 'string',
          description: '可选：安装后自动在 iPhone 上启动的 App Bundle Identifier。',
        },
        extra_xcodebuild_args: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：附加给 xcodebuild 的参数（如 ["-allowProvisioningUpdates"]）。',
        },
      },
      required: ['project_or_workspace_path', 'scheme'],
    },
  },

  // --- 6. Local USB Hardware & Serial Port Tools ---
  {
    name: 'usb_list_devices_and_ports',
    description:
      '枚举本机 Mac 当前连接的所有物理 USB 设备树（system_profiler SPUSBDataType）以及所有可用串口设备（/dev/cu.* 与 /dev/tty.*，如 ESP32、CH340、CP2102、J-Link、ST-Link、WCH-Link、iPhone 等）。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'usb_serial_monitor',
    description:
      '读写本机 Mac 上的 USB 串口设备（如 /dev/cu.usbserial-* 或 /dev/cu.usbmodem*）。支持发送串口指令并采集指定时长的硬件串口日志输出。',
    inputSchema: {
      type: 'object',
      properties: {
        port: {
          type: 'string',
          description: '串口路径，例如 /dev/cu.usbserial-5B0B0246551。',
        },
        baudrate: {
          type: 'number',
          description: '波特率，默认 115200。',
        },
        send_data: {
          type: 'string',
          description: '可选：连接后先向串口发送的字符串指令（会自动附带 \\r\\n）。',
        },
        read_duration_sec: {
          type: 'number',
          description: '持续读取串口输出的时间（秒，默认 3 秒，最大 30 秒）。',
        },
      },
      required: ['port'],
    },
  },

  // --- 7. Local MCU / Embedded Firmware Flashing Tools ---
  {
    name: 'hardware_flash_firmware',
    description:
      '通过本机 Mac 的物理 USB 接口向硬件板卡烧录固件！支持 4 种常用烧录器模式：\n' +
      '1. "esptool"：使用本机 ESP-IDF 的 esptool.py 烧录 ESP32 / ESP32-S3 / ESP32-C3 固件 (.bin)\n' +
      '2. "jlink"：使用本机 SEGGER JLinkExe (/Applications/SEGGER/JLink) 通过 SWD/JTAG 烧录 STM32 / NRF52 / ARM 芯片 (.hex / .bin / .elf)\n' +
      '3. "dfu"：使用本机 dfu-util 通过 USB DFU 模式烧录固件\n' +
      '4. "idf_py"：在指定 ESP-IDF 工程目录下直接执行 `idf.py -p <port> build flash`',
    inputSchema: {
      type: 'object',
      properties: {
        flasher: {
          type: 'string',
          enum: ['esptool', 'jlink', 'dfu', 'idf_py'],
          description: '烧录工具类型：esptool | jlink | dfu | idf_py',
        },
        port: {
          type: 'string',
          description: '串口设备路径（用于 esptool / idf_py，如 /dev/cu.usbserial-5B0B0246551）。',
        },
        chip: {
          type: 'string',
          description: '目标芯片型号（如 esp32s3、STM32F103RC、NRF52840_XXAA 等）。',
        },
        firmware_path: {
          type: 'string',
          description: '要烧录的固件文件路径（.bin / .hex / .elf，位于 work/ 或本机路径）。',
        },
        flash_address: {
          type: 'string',
          description: '烧录起始地址（默认 0x0 或 0x08000000）。',
        },
        extra_args: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：附加命令行参数。',
        },
      },
      required: ['flasher'],
    },
  },

  // --- 8. Local Mac Host Command Execution Bridge & Screen Capture ---
  {
    name: 'mac_screen_capture',
    description:
      '对用户本机 MacBook 桌面或指定应用窗口（如 嘉立创EDA、FreeCAD、Blender、Xcode、iOS 模拟器、Chrome）进行截屏！\n' +
      '截图会自动保存到同步目录 work/screenshots/（远端 /root/work/screenshots/ 可直接访问），并同时将压缩后的高清图像直接作为 MCP 视觉图像块返回给 Claude 直接查看。',
    inputSchema: {
      type: 'object',
      properties: {
        activate_app: {
          type: 'string',
          description: '可选：截屏前先激活置顶的 Mac 应用名称（例如 "FreeCAD"、"Blender"、"嘉立创EDA(专业版)"、"Google Chrome"、"Xcode"、"Simulator"）。',
        },
        region: {
          type: 'string',
          description: '可选：指定截取区域 "x,y,width,height"（如 "0,0,1440,900"），不填则截取整个主屏幕。',
        },
        output_filename: {
          type: 'string',
          description: '可选：保存在 work/screenshots/ 下的文件名（默认 screen_<timestamp>.png）。',
        },
        max_dimension_px: {
          type: 'number',
          description: '返回给 AI 视觉识别的最大长边像素（默认 1600，使用 macOS sips 缩放以保证清晰且低延迟）。',
        },
        return_inline_image: {
          type: 'boolean',
          description: '是否在 MCP 响应中直接返回 base64 图像块供 Claude 视觉查看（默认 true）。',
        },
      },
    },
  },
  {
    name: 'mac_host_exec',
    description:
      '在用户本机 MacBook 上直接执行 Shell 命令（如调用本机编译器、自定义烧录脚本、操控本地软件、查看硬件状态等）。默认工作目录为 $TAKT_HOME/work。',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要在 Mac 本机执行的 zsh/bash 命令字符串。',
        },
        cwd: {
          type: 'string',
          description: '可选：执行目录（默认 $TAKT_HOME/work，支持自动转换 /root/work）。',
        },
        timeout_sec: {
          type: 'number',
          description: '超时时间（秒，默认 120）。',
        },
      },
      required: ['command'],
    },
  },

  // --- 9. Work Directory Sync Status ---
  {
    name: 'work_sync_status',
    description: '查看本机 Mac 的 work/ 同步文件夹文件列表及三维模型/硬件工程状态。',
    inputSchema: {
      type: 'object',
      properties: {
        subdir: { type: 'string', description: '可选子目录路径。' },
      },
    },
  },
];


module.exports = TOOLS;
