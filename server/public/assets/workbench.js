(() => {
      // ============================================================================
      // 1. SVG Vector Icons Library (Zero Emojis)
      // ============================================================================
      const SVG_ICONS = window.TaktIcons;

      function fileIconSvg(ext, isDir, isCollapsedDir = false) {
        if (isDir) return isCollapsedDir ? SVG_ICONS.folderClosed : SVG_ICONS.folderOpen;
        if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp'].includes(ext)) return SVG_ICONS.fileImage;
        if (['.md', '.txt', '.log', '.pdf'].includes(ext)) return SVG_ICONS.fileDoc;
        if (['.py', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.sh', '.c', '.cpp', '.h', '.swift', '.rs', '.go', '.html', '.css'].includes(ext)) return SVG_ICONS.fileCode;
        if (['.json', '.yaml', '.yml', '.toml', '.ini', '.env'].includes(ext)) return SVG_ICONS.fileConfig;
        if (['.glb', '.gltf', '.stl', '.step', '.stp', '.fcstd', '.obj'].includes(ext)) return SVG_ICONS.fileCube;
        return SVG_ICONS.fileGeneric;
      }

      // ============================================================================
      // 2. Codex Obsidian Terminal Palette & App State
      // ============================================================================
      const CODEX_DARK_TERM_THEME = {
        background: '#0d0d0d',
        foreground: '#ececef',
        cursor: '#f4f4f5',
        cursorAccent: '#0d0d0d',
        selectionBackground: 'rgba(255, 255, 255, 0.18)',
        black: '#18181b',
        red: '#f87171',
        green: '#a1a1aa',
        yellow: '#fbbf24',
        blue: '#93c5fd',
        magenta: '#c4b5fd',
        cyan: '#7dd3fc',
        white: '#e4e4e7',
        brightBlack: '#71717a',
        brightRed: '#fca5a5',
        brightGreen: '#d4d4d8',
        brightYellow: '#fde68a',
        brightBlue: '#bfdbfe',
        brightMagenta: '#ddd6fe',
        brightCyan: '#bae6fd',
        brightWhite: '#ffffff',
      };

      const hasNativeHost = Boolean(
        window.__TAKT_NATIVE_TERM_AVAILABLE__ ||
        (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.taktNative)
      );

      let terminalEngine = hasNativeHost ? 'native' : 'web';
      let nodesData = [];
      const primaryNodeId = () => nodesData[0]?.id || 'node-1';
      let sshCandidatesData = [];
      let selectedNodeFilter = 'all'; // 'all' or node.id
      let foldersData = [];
      let activeTabId = null;
      let currentFilesCwd = '/root/work';
      let currentFilesNodeId = primaryNodeId();
      let currentFileTree = [];
      let selectedFilePath = '';
      let modalMode = 'project'; // 'project' | 'subfolder' | 'rename-session'
      let renamingSessionId = '';
      let renamingSessionNodeId = primaryNodeId();
      let isDraggingFile = false;

      // Persistent Collapsible States & Startup Non-Empty Project Filter
      const collapsedProjects = new Set(JSON.parse(localStorage.getItem('takt_collapsed_projects') || '[]'));
      const collapsedDirs = new Set(JSON.parse(localStorage.getItem('takt_collapsed_dirs') || '[]'));
      const visibleProjectKeys = new Set();
      let initialVisibilityResolved = false;
      const tabs = new Map();
      function sessionTabId(sessionId, nodeId) {
        return [...tabs.values()].find((tab) => tab.sessionId === sessionId && tab.nodeId === nodeId)?.tabId || null;
      }

      // Appearance settings → live-update every xterm instance (theme, font, size, cursor)
      window.TaktAppearance.onChange((_s, o) => {
        tabs.forEach((tab) => {
          const term = tab && tab.term;
          if (!term) return;
          try {
            term.options.theme = o.theme;
            term.options.fontFamily = o.fontFamily;
            term.options.fontSize = o.fontSize;
            term.options.lineHeight = o.lineHeight;
            term.options.cursorStyle = o.cursorStyle;
            term.options.cursorBlink = o.cursorBlink;
            if (tab.fitAddon) requestAnimationFrame(() => { try { tab.fitAddon.fit(); } catch (_) {} });
          } catch (_) {}
        });
      });
      // Per-tab view mode (terminal / chat) survives reloads
      let savedViewModes = {};
      try { savedViewModes = JSON.parse(localStorage.getItem('takt_view_modes') || '{}') || {}; } catch { savedViewModes = {}; }
      function persistViewModes() {
        try { localStorage.setItem('takt_view_modes', JSON.stringify(savedViewModes)); } catch {}
      }

      function getFolderKey(folder) {
        return folder.key || `${folder.nodeId || primaryNodeId()}::${folder.path}`;
      }

      function getNodeInfo(nodeId) { return window.TaktNodes.getNodeInfo(nodesData, nodeId); }

      function saveCollapsedProjects() {
        localStorage.setItem('takt_collapsed_projects', JSON.stringify(Array.from(collapsedProjects)));
      }
      function saveCollapsedDirs() {
        localStorage.setItem('takt_collapsed_dirs', JSON.stringify(Array.from(collapsedDirs)));
      }

      function showToast(msg, ms = 2200) {
        const el = document.getElementById('toastMsg');
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(showToast._timer);
        showToast._timer = setTimeout(() => el.classList.remove('show'), ms);
      }

      // ============================================================================
      // 3. Native macOS AppKit SwiftTerm Bridge (`window.webkit.messageHandlers.taktNative`)
      // ============================================================================
      function postNativeMessage(payload) {
        try {
          if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.taktNative) {
            window.webkit.messageHandlers.taktNative.postMessage(payload);
            return true;
          }
        } catch (err) {
          console.warn('Native bridge error:', err);
        }
        return false;
      }

      const newProjectDialog = document.getElementById('newProjectDialog');
      const nodeManagerDialog = document.getElementById('nodeManagerDialog');
      const remoteDesktopDialog = document.getElementById('remoteDesktopDialog');

      function popoverOverStage(rect) {
        const menu = document.getElementById('tagMenu');
        if (!menu || menu.hidden) return false;
        const r = menu.getBoundingClientRect();
        return r.right > rect.left && r.left < rect.right && r.bottom > rect.top && r.top < rect.bottom;
      }

      function syncNativeTerminalGeometry() {
        if (!hasNativeHost) return;
        const stage = document.getElementById('terminalStage');
        const rect = stage.getBoundingClientRect();
        const activeTab = activeTabId && tabs.has(activeTabId) ? tabs.get(activeTabId) : null;
        const inDocktermChat = Boolean(activeTab && activeTab.viewMode === 'chat');
        // The native terminal is an AppKit view above the page: HTML can never be drawn over it, so it
        // steps aside while any dialog (settings included) or a popover menu over the terminal is open.
        const isVisible = (
          terminalEngine === 'native' &&
          activeTab !== null &&
          !inDocktermChat &&
          !document.querySelector('dialog[open]') &&
          !popoverOverStage(rect) &&
          !isDraggingFile &&
          rect.width > 20 &&
          rect.height > 20
        );
        postNativeMessage({
          action: 'updateRect',
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          visible: isVisible,
        });
      }

      // The engine is fixed per host: native SwiftTerm inside the macOS app, xterm.js in a browser.

      const stageResizeObserver = new ResizeObserver(() => {
        syncNativeTerminalGeometry();
        if (terminalEngine === 'web' && activeTabId && tabs.has(activeTabId)) {
          try { tabs.get(activeTabId).fitAddon.fit(); } catch {}
        }
      });
      stageResizeObserver.observe(document.getElementById('terminalStage'));
      window.addEventListener('resize', syncNativeTerminalGeometry);

      // ============================================================================
      // 4. Dialog Light-Dismiss Fallback + Native Layer Sync
      // ============================================================================
      function bindLightDismissDialog(dlg) {
        dlg.addEventListener('close', () => syncNativeTerminalGeometry());
        if (!('closedBy' in HTMLDialogElement.prototype)) {
          dlg.addEventListener('click', (event) => {
            if (event.target !== dlg) return;
            const rect = dlg.getBoundingClientRect();
            const inContent = (
              rect.top <= event.clientY &&
              event.clientY <= rect.top + rect.height &&
              rect.left <= event.clientX &&
              event.clientX <= rect.left + rect.width
            );
            if (!inContent) dlg.close();
          });
        }
      }
      bindLightDismissDialog(newProjectDialog);
      bindLightDismissDialog(nodeManagerDialog);
      bindLightDismissDialog(remoteDesktopDialog);
      // showModal() fires no event: watch every dialog's [open] so the native terminal always steps aside
      const dialogOpenObserver = new MutationObserver(() => syncNativeTerminalGeometry());
      document.querySelectorAll('dialog').forEach((d) => dialogOpenObserver.observe(d, { attributes: true, attributeFilter: ['open'] }));

      // ============================================================================
      // 5. Resizable & Collapsible Sidebars and Splitters
      // ============================================================================
      const panelLeft = document.getElementById('panelLeft');
      const panelRight = document.getElementById('panelRight');
      const resizerLeft = document.getElementById('resizerLeft');
      const resizerRight = document.getElementById('resizerRight');
      const fileBrowserPane = document.getElementById('fileBrowserPane');
      const previewPane = document.getElementById('previewPane');
      const resizerRightSplit = document.getElementById('resizerRightSplit');

      document.getElementById('btnToggleLeftPanel').addEventListener('click', () => {
        const collapsed = panelLeft.classList.toggle('collapsed');
        resizerLeft.classList.toggle('hidden', collapsed);
        setTimeout(syncNativeTerminalGeometry, 180);
      });

      document.getElementById('btnToggleRightPanel').addEventListener('click', () => {
        const collapsed = panelRight.classList.toggle('collapsed');
        resizerRight.classList.toggle('hidden', collapsed);
        setTimeout(syncNativeTerminalGeometry, 180);
      });

      document.getElementById('toggleFileBrowserSection').addEventListener('click', (e) => {
        const trigger = e.currentTarget;
        const collapsed = fileBrowserPane.classList.toggle('collapsed');
        trigger.setAttribute('aria-expanded', String(!collapsed));
        document.getElementById('fileSectionChevron').style.transform = collapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
      });

      document.getElementById('togglePreviewSection').addEventListener('click', (e) => {
        const trigger = e.currentTarget;
        const collapsed = previewPane.classList.toggle('collapsed');
        trigger.setAttribute('aria-expanded', String(!collapsed));
        document.getElementById('previewSectionChevron').style.transform = collapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
      });

      // Left Column Drag Resize
      resizerLeft.addEventListener('mousedown', (e) => {
        e.preventDefault();
        resizerLeft.classList.add('dragging');
        panelLeft.classList.add('resizing');
        const onMove = (ev) => {
          const w = Math.max(190, Math.min(480, ev.clientX));
          document.documentElement.style.setProperty('--left-width', `${w}px`);
          syncNativeTerminalGeometry();
        };
        const onUp = () => {
          resizerLeft.classList.remove('dragging');
          panelLeft.classList.remove('resizing');
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          syncNativeTerminalGeometry();
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });

      // Right Column Drag Resize
      resizerRight.addEventListener('mousedown', (e) => {
        e.preventDefault();
        resizerRight.classList.add('dragging');
        panelRight.classList.add('resizing');
        const onMove = (ev) => {
          const w = Math.max(240, Math.min(640, window.innerWidth - ev.clientX));
          document.documentElement.style.setProperty('--right-width', `${w}px`);
          syncNativeTerminalGeometry();
        };
        const onUp = () => {
          resizerRight.classList.remove('dragging');
          panelRight.classList.remove('resizing');
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          syncNativeTerminalGeometry();
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });

      // Right Top/Bottom Split Drag Resize
      resizerRightSplit.addEventListener('mousedown', (e) => {
        e.preventDefault();
        resizerRightSplit.classList.add('dragging');
        fileBrowserPane.classList.add('resizing');
        const splitRect = document.getElementById('rightSplit').getBoundingClientRect();
        const onMove = (ev) => {
          const relY = ev.clientY - splitRect.top;
          const pct = Math.max(15, Math.min(85, (relY / splitRect.height) * 100));
          fileBrowserPane.classList.remove('collapsed');
          document.documentElement.style.setProperty('--right-top-ratio', `${pct}%`);
        };
        const onUp = () => {
          resizerRightSplit.classList.remove('dragging');
          fileBrowserPane.classList.remove('resizing');
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });

      // ============================================================================
      // 6. Left Panel: Multi-Linux Filter Bar + Collapsible Projects & Sessions Tree
      // ============================================================================
      function formatRelativeTime(ms) {
        if (!ms) return '';
        const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
        if (diffSec < 60) return '刚刚';
        if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
        if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
        return `${Math.floor(diffSec / 86400)}d`;
      }

      const collapsedNodeSections = new Set(JSON.parse(localStorage.getItem('takt_collapsed_nodes') || '[]'));

      function setNodeFilter(id) {
        selectedNodeFilter = id;
        renderProjectTree();
        if (id !== 'all') {
          const n = getNodeInfo(id);
          loadSessionFiles(n.remoteWorkDir || '/root/work', n.id);
        }
      }

      // Machines get a small server glyph with a status dot (green = online), so they never look like the
      // colour-dot project tags
      function nodeServerIcon(online) {
        return `<span class="node-srv${online ? ' online' : ''}" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><rect x="1.75" y="1.75" width="12.5" height="5.25" rx="1.4"/><rect x="1.75" y="9" width="12.5" height="5.25" rx="1.4"/><path d="M4.6 4.4h.01M4.6 11.6h.01" stroke-width="1.9"/></svg><i class="node-srv-dot"></i></span>`;
      }

      function renderNodeFilterBar() {
        const bar = document.getElementById('nodeFilterBar');
        if (!bar) return;
        bar.innerHTML = '';
        // A single machine has nothing to filter — keep the sidebar quiet.
        if (nodesData.length <= 1) {
          selectedNodeFilter = 'all';
          return;
        }
        const countByNode = {};
        for (const f of foldersData) countByNode[f.nodeId] = (countByNode[f.nodeId] || 0) + (f.sessions || []).length;

        const mk = (id, label, extraHtml = '', leadHtml = '') => {
          const pill = document.createElement('button');
          pill.type = 'button';
          pill.className = `node-pill${selectedNodeFilter === id ? ' active' : ''}`;
          pill.innerHTML = `${leadHtml}<span>${escapeHtml(label)}</span>${extraHtml}`;
          bar.appendChild(pill);
          return pill;
        };

        mk('all', '全部机器').addEventListener('click', () => setNodeFilter('all'));
        for (const n of nodesData) {
          const pill = mk(
            n.id,
            n.badge || n.name || n.id,
            `<span class="node-pill-count">${countByNode[n.id] || 0}</span>`,
            nodeServerIcon(n.online),
          );
          pill.title = `${n.name}${n.sshHost ? ` · ${n.sshHost}:${n.remoteWorkDir}` : ' · 未绑定 SSH'}\n${n.online ? '在线' : '离线'} · 右键编辑节点`;
          pill.addEventListener('click', () => setNodeFilter(selectedNodeFilter === n.id ? 'all' : n.id));
          pill.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            openNodeManagerModal(n.id);
          });
        }
      }

      async function loadProjectTree(forceSync = false) {
        try {
          const res = await fetch(forceSync ? '/api/tree?sync=1' : '/api/tree');
          const data = await res.json();
          if (data && Array.isArray(data.nodes)) {
            nodesData = data.nodes;
            renderNodeFilterBar();
          }
          applyTagPayload(data);
          if (data && data.folders) {
            foldersData = data.folders;
            // Additive-only visibility from local SQLite: any project with sessions or pinned_visible stays visible
            for (const f of foldersData) {
              if ((f.sessions || []).length > 0 || f.pinnedVisible) {
                visibleProjectKeys.add(getFolderKey(f));
              }
            }
            if (!initialVisibilityResolved) {
              initialVisibilityResolved = true;
              if (visibleProjectKeys.size === 0 && foldersData.length > 0) {
                visibleProjectKeys.add(getFolderKey(foldersData[0]));
              }
            }
            if (Array.isArray(data.openTabs)) {
              for (const ot of data.openTabs) {
                if (ot.cwd) {
                  visibleProjectKeys.add(`${ot.nodeId || primaryNodeId()}::${ot.cwd}`);
                }
                if (!tabs.has(ot.tabId)) {
                  openOrSwitchTerminalTab({
                    tabId: ot.tabId,
                    sessionId: ot.sessionId,
                    title: ot.title,
                    cwd: ot.cwd,
                    nodeId: ot.nodeId || primaryNodeId(),
                    nodeBadge: ot.nodeBadge || 'LX-1',
                    sshHost: ot.sshHost || '',
                    localWorkAlias: ot.localWorkAlias || 'work',
                    resume: true,
                    mode: ot.mode || 'claude',
                  });
                }
              }
            }
            renderProjectTree();
          }
        } catch (err) {
          console.error('Failed to load project tree:', err);
        }
      }

      let showEmptyFolders = false;

      // Strip internal XML-ish tags (<wake ...>, <relay ...>, <command-name> ...) from raw first-prompt titles
      // ============================================================================
      // Project Tags (stored in local SQLite via /api/tags + /api/project-tag)
      // ============================================================================
      const TAG_COLORS = {
        blue: '#60a5fa', pink: '#f472b6', orange: '#fb923c', purple: '#a78bfa',
        yellow: '#facc15', cyan: '#22d3ee', red: '#f87171', gray: '#a1a1aa',
      };
      let tagsData = [];
      let projectTags = {};
      let selectedTagFilter = localStorage.getItem('takt_tag_filter') || 'all'; // 'all' | 'none' | tagId
      const expandedSessionLists = new Set();
      const SESSION_PREVIEW_LIMIT = 5;

      function tagColor(tag) {
        return TAG_COLORS[tag && tag.color] || TAG_COLORS.gray;
      }
      function getTagById(id) {
        return tagsData.find((t) => t.id === id) || null;
      }
      function applyTagPayload(data) {
        if (data && Array.isArray(data.tags)) tagsData = data.tags;
        if (data && data.projectTags) projectTags = data.projectTags;
        if (selectedTagFilter !== 'all' && selectedTagFilter !== 'none' && !getTagById(selectedTagFilter)) {
          selectedTagFilter = 'all';
        }
      }
      async function tagApi(method, url, body) {
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '操作失败');
        applyTagPayload(data);
        renderProjectTree();
        return data;
      }

      const tagMenu = document.getElementById('tagMenu');
      // Top level of the page: nothing in the sidebar (clipping, stacking) can cover the menu
      document.body.appendChild(tagMenu);
      function openTagMenu(anchorEl, buildFn) {
        tagMenu.innerHTML = '';
        buildFn(tagMenu);
        tagMenu.hidden = false;
        const r = anchorEl.getBoundingClientRect();
        const mw = tagMenu.offsetWidth;
        const mh = tagMenu.offsetHeight;
        let minLeft = 8;
        let maxLeft = window.innerWidth - mw - 8;
        // A menu opened from a side panel stays inside that panel: in the macOS app the terminal next to
        // it is a native view that would be drawn over the menu
        const panel = anchorEl.closest('.panel-col');
        if (panel) {
          const pr = panel.getBoundingClientRect();
          if (pr.width >= mw + 12) {
            minLeft = Math.max(minLeft, pr.left + 6);
            maxLeft = Math.min(maxLeft, pr.right - mw - 6);
          }
        }
        let top = r.bottom + 4;
        if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
        tagMenu.style.left = `${Math.max(minLeft, Math.min(r.left, maxLeft))}px`;
        tagMenu.style.top = `${top}px`;
        syncNativeTerminalGeometry();
        const firstInput = tagMenu.querySelector('input');
        if (firstInput) setTimeout(() => firstInput.focus(), 10);
      }
      function closeTagMenu() {
        tagMenu.hidden = true;
        tagMenu.innerHTML = '';
        syncNativeTerminalGeometry();
      }
      // Light-dismiss: outside click, Esc, scroll or resize closes the menu
      document.addEventListener('mousedown', (e) => {
        if (!tagMenu.hidden && !tagMenu.contains(e.target)) closeTagMenu();
      }, true);
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !tagMenu.hidden) closeTagMenu();
      });
      window.addEventListener('resize', () => closeTagMenu());
      document.getElementById('projectList').addEventListener('scroll', () => closeTagMenu(), { passive: true });

      function menuItem(html, onClick, extraClass = '') {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `tag-menu-item ${extraClass}`;
        b.innerHTML = html;
        b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
        return b;
      }
      function menuSep() {
        const d = document.createElement('div');
        d.className = 'tag-menu-sep';
        return d;
      }
      function buildTagEditor(menu, { title, initialName = '', initialColor = 'blue', submitLabel, onSubmit }) {
        let color = initialColor;
        const t = document.createElement('div');
        t.className = 'tag-menu-title';
        t.textContent = title;
        menu.appendChild(t);
        const wrap = document.createElement('div');
        wrap.style.padding = '0 4px';
        const input = document.createElement('input');
        input.className = 'tag-menu-input';
        input.placeholder = '标签名，如：公司开发';
        input.value = initialName;
        input.maxLength = 24;
        wrap.appendChild(input);
        menu.appendChild(wrap);
        const sw = document.createElement('div');
        sw.className = 'tag-swatches';
        for (const [key, hex] of Object.entries(TAG_COLORS)) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = `tag-swatch${key === color ? ' selected' : ''}`;
          b.style.background = hex;
          b.title = key;
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            color = key;
            sw.querySelectorAll('.tag-swatch').forEach((x) => x.classList.toggle('selected', x === b));
          });
          sw.appendChild(b);
        }
        menu.appendChild(sw);
        const submit = async () => {
          const name = input.value.trim();
          if (!name) { input.focus(); return; }
          closeTagMenu();
          try {
            await onSubmit(name, color);
          } catch (err) {
            showToast(err.message);
          }
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
        });
        menu.appendChild(menuSep());
        menu.appendChild(menuItem(`<span>${escapeHtml(submitLabel)}</span>`, submit));
      }

      function openNewTagMenu(anchorEl, assignToProjectKey = '') {
        openTagMenu(anchorEl, (menu) => buildTagEditor(menu, {
          title: assignToProjectKey ? '新建标签并应用到此项目' : '新建标签',
          initialColor: Object.keys(TAG_COLORS)[tagsData.length % Object.keys(TAG_COLORS).length],
          submitLabel: '创建',
          onSubmit: async (name, color) => {
            const data = await tagApi('POST', '/api/tags', { name, color });
            if (assignToProjectKey && data.id) {
              await tagApi('PUT', '/api/project-tag', { projectKey: assignToProjectKey, tagId: data.id });
            }
          },
        }));
      }

      function openEditTagMenu(anchorEl, tag) {
        openTagMenu(anchorEl, (menu) => {
          buildTagEditor(menu, {
            title: '编辑标签',
            initialName: tag.name,
            initialColor: tag.color,
            submitLabel: '保存',
            onSubmit: (name, color) => tagApi('PATCH', '/api/tags', { id: tag.id, name, color }),
          });
          menu.appendChild(menuItem(`${SVG_ICONS.trash}<span>删除标签</span>`, async () => {
            if (!confirm(`删除标签「${tag.name}」？项目本身不会被删除。`)) return;
            closeTagMenu();
            await tagApi('DELETE', `/api/tags?id=${encodeURIComponent(tag.id)}`);
          }, 'danger'));
        });
      }

      function openAssignTagMenu(anchorEl, folder) {
        const key = getFolderKey(folder);
        const current = projectTags[key] || '';
        openTagMenu(anchorEl, (menu) => {
          const t = document.createElement('div');
          t.className = 'tag-menu-title';
          t.textContent = `为「${String(folder.name || '').replace(/\s*\(主工作区\)\s*/, '')}」设置标签`;
          menu.appendChild(t);
          for (const tag of tagsData) {
            menu.appendChild(menuItem(
              `<span class="tag-dot" style="background:${tagColor(tag)}"></span><span>${escapeHtml(tag.name)}</span>${tag.id === current ? `<span class="tag-check">${SVG_ICONS.check}</span>` : ''}`,
              async () => {
                closeTagMenu();
                await tagApi('PUT', '/api/project-tag', { projectKey: key, tagId: tag.id === current ? '' : tag.id });
              },
            ));
          }
          if (tagsData.length) menu.appendChild(menuSep());
          menu.appendChild(menuItem(`${SVG_ICONS.plus}<span>新建标签…</span>`, () => openNewTagMenu(anchorEl, key)));
          if (current) {
            menu.appendChild(menuItem(`${SVG_ICONS.close}<span>移除标签</span>`, async () => {
              closeTagMenu();
              await tagApi('PUT', '/api/project-tag', { projectKey: key, tagId: '' });
            }));
          }
        });
      }

      function renderTagBar(scopedFolders) {
        const bar = document.getElementById('tagBar');
        if (!bar) return;
        bar.innerHTML = '';
        const counts = { all: scopedFolders.length, none: 0 };
        for (const f of scopedFolders) {
          const tid = projectTags[getFolderKey(f)];
          if (tid && getTagById(tid)) counts[tid] = (counts[tid] || 0) + 1;
          else counts.none += 1;
        }
        const mkChip = (id, label, colorHex, extraClass = '') => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = `tag-chip${selectedTagFilter === id ? ' active' : ''} ${extraClass}`;
          if (colorHex) b.style.setProperty('--tag-c', colorHex);
          b.innerHTML = `${colorHex ? '<span class="tag-dot"></span>' : ''}<span>${escapeHtml(label)}</span><span class="tag-count">${counts[id] || 0}</span>`;
          b.addEventListener('click', () => {
            selectedTagFilter = selectedTagFilter === id && id !== 'all' ? 'all' : id;
            localStorage.setItem('takt_tag_filter', selectedTagFilter);
            renderProjectTree();
          });
          bar.appendChild(b);
          return b;
        };
        for (const tag of tagsData) {
          const chip = mkChip(tag.id, tag.name, tagColor(tag));
          chip.title = '右键编辑 / 删除';
          chip.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            openEditTagMenu(chip, tag);
          });
          chip.addEventListener('dblclick', (e) => {
            e.preventDefault();
            openEditTagMenu(chip, tag);
          });
        }
        if (tagsData.length) mkChip('none', '未分类', '');
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'tag-chip add';
        add.innerHTML = `${SVG_ICONS.plus}<span>标签</span>`;
        add.addEventListener('click', () => openNewTagMenu(add));
        bar.appendChild(add);
      }

      function cleanSessionTitle(title, id = '') {
        let t = String(title || '').replace(/<[^>]*>/g, ' ').replace(/<[^>]*$/, ' ').replace(/\s+/g, ' ').trim();
        if (!t) t = `对话 ${String(id).slice(0, 6)}`;
        return t;
      }

      function renderProjectTree() {
        const container = document.getElementById('projectList');
        const prevScroll = container.scrollTop;
        container.innerHTML = '';
        let totalSessions = 0;
        renderNodeFilterBar();

        const nodeScopedFolders = foldersData.filter((f) => {
          if (selectedNodeFilter !== 'all' && f.nodeId !== selectedNodeFilter) return false;
          return true;
        });

        // Primary visible folders: any folder with sessions > 0, pinnedVisible, or when showEmptyFolders is toggled on
        const displayedFolders = nodeScopedFolders.filter((f) => {
          if ((f.sessions || []).length > 0 || f.pinnedVisible) return true;
          if (showEmptyFolders) return true;
          if (selectedNodeFilter !== 'all' && f.path === (f.remoteWorkDir || '/root/work')) return true;
          return visibleProjectKeys.has(getFolderKey(f));
        });

        let hiddenEmptyFolders = nodeScopedFolders.filter((f) => !displayedFolders.includes(f));

        // Tag chips count over the node-scoped visible set (tagged projects always count as visible)
        const tagScopeFolders = nodeScopedFolders.filter((f) => displayedFolders.includes(f) || projectTags[getFolderKey(f)]);
        renderTagBar(tagScopeFolders);
        if (selectedTagFilter !== 'all') {
          const matchTag = (f) => {
            const tid = projectTags[getFolderKey(f)];
            const valid = tid && getTagById(tid);
            return selectedTagFilter === 'none' ? !valid : tid === selectedTagFilter;
          };
          const filtered = tagScopeFolders.filter(matchTag);
          displayedFolders.length = 0;
          displayedFolders.push(...filtered);
          hiddenEmptyFolders = [];
        }

        if (selectedNodeFilter !== 'all') {
          const activeNode = getNodeInfo(selectedNodeFilter);
          if (activeNode && !activeNode.sshHost) {
            const cfgBanner = document.createElement('div');
            cfgBanner.className = 'project-group';
            cfgBanner.style.padding = '10px';
            cfgBanner.style.display = 'flex';
            cfgBanner.style.flexDirection = 'column';
            cfgBanner.style.gap = '6px';
            cfgBanner.innerHTML = `
              <div style="font-size:11.5px; font-weight:600; color:var(--text-primary); display:flex; align-items:center; justify-content:space-between;">
                <span>${escapeHtml(activeNode.name)} (${escapeHtml(activeNode.localWorkAlias)})</span>
                <span class="machine-badge secondary">${escapeHtml(activeNode.badge)} · 待接入 SSH</span>
              </div>
              <div style="font-size:11px; color:var(--text-secondary); line-height:1.45;">
                本地同步目录 <code>${escapeHtml(activeNode.localWorkDir)}</code> 已就绪。点击下方按钮填入第二台 Linux 的 SSH Host 即可自动打通 Mac MCP 逆向隧道与 Syncthing。
              </div>
              <button class="btn btn-primary" id="btnBannerBindSsh" style="align-self:flex-start; margin-top:2px;">配置此节点 SSH 与同步</button>
            `;
            cfgBanner.querySelector('#btnBannerBindSsh').addEventListener('click', () => openNodeManagerModal(activeNode.id));
            container.appendChild(cfgBanner);
          }
        }

        // Group by machine when showing all nodes, so the machine badge is shown once instead of on every row
        const sectionCounts = {};
        for (const f of displayedFolders) {
          sectionCounts[f.nodeId] = (sectionCounts[f.nodeId] || 0) + (f.sessions || []).length;
        }
        const nodeOrder = nodesData.map((n) => n.id);
        displayedFolders.sort((a, b) => {
          const ia = nodeOrder.indexOf(a.nodeId);
          const ib = nodeOrder.indexOf(b.nodeId);
          return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        });
        let lastSectionNodeId = null;

        for (const folder of displayedFolders) {
          const folderKey = getFolderKey(folder);
          const sessCount = (folder.sessions || []).length;
          const isCollapsed = collapsedProjects.has(folderKey);
          const badgeText = `${folder.nodeBadge || 'LX-1'} · ${folder.localWorkAlias || 'work'}`;
          const mappingTitle = `${folder.nodeName || folder.nodeId} (${folder.sshHost || '未配SSH'}:${folder.path} <-> Mac ${folder.localPath || folder.localWorkDir})`;

          const showSections = selectedNodeFilter === 'all' && nodesData.length > 1;
          if (showSections && folder.nodeId !== lastSectionNodeId) {
            lastSectionNodeId = folder.nodeId;
            const nodeInfo = getNodeInfo(folder.nodeId) || {};
            const secCollapsed = collapsedNodeSections.has(folder.nodeId);
            const sec = document.createElement('div');
            sec.className = `node-section${secCollapsed ? ' collapsed' : ''}`;
            sec.setAttribute('role', 'button');
            sec.setAttribute('aria-expanded', String(!secCollapsed));
            sec.title = `${nodeInfo.name || folder.nodeId}${nodeInfo.sshHost ? ` · ${nodeInfo.sshHost}` : ''}
点击折叠 / 展开这台机器`;
            sec.innerHTML = `
              ${SVG_ICONS.chevronDown}
              ${nodeServerIcon(nodeInfo.online)}
              <span class="node-section-name">${escapeHtml(folder.nodeBadge || nodeInfo.badge || folder.nodeId)}</span>
              <span>${escapeHtml(folder.localWorkAlias || nodeInfo.localWorkAlias || '')}</span>
              <span class="node-section-meta">${nodeInfo.online ? '' : '离线 · '}${sectionCounts[folder.nodeId] || 0}</span>
            `;
            sec.addEventListener('click', () => {
              if (collapsedNodeSections.has(folder.nodeId)) collapsedNodeSections.delete(folder.nodeId);
              else collapsedNodeSections.add(folder.nodeId);
              localStorage.setItem('takt_collapsed_nodes', JSON.stringify(Array.from(collapsedNodeSections)));
              renderProjectTree();
            });
            container.appendChild(sec);
          }
          if (showSections && collapsedNodeSections.has(folder.nodeId)) {
            totalSessions += sessCount;
            continue;
          }

          totalSessions += sessCount;
          const rawName = String(folder.name || '');
          const isRootFolder = /\(主工作区\)/.test(rawName);
          const displayName = rawName.replace(/\s*\(主工作区\)\s*/, '');

          const group = document.createElement('div');
          group.className = `project-group${isCollapsed ? ' collapsed' : ''}`;

          const header = document.createElement('div');
          header.className = 'project-header';
          header.setAttribute('role', 'button');
          header.setAttribute('aria-expanded', String(!isCollapsed));
          header.title = mappingTitle;

          const nameWrap = document.createElement('div');
          nameWrap.className = 'project-name-wrap';
          const projTag = getTagById(projectTags[folderKey]);
          nameWrap.innerHTML = `
            ${SVG_ICONS.chevronDown}
            <span class="project-name">${escapeHtml(displayName)}</span>
            ${isRootFolder ? '<span class="project-name-sub">根目录</span>' : ''}
            ${projTag ? `<span class="tag-badge" style="--tag-c:${tagColor(projTag)}">${escapeHtml(projTag.name)}</span>` : ''}
          `;

          const tagBtn = document.createElement('button');
          tagBtn.type = 'button';
          tagBtn.className = 'project-tag-btn';
          tagBtn.innerHTML = SVG_ICONS.tag;
          tagBtn.title = '设置标签';
          tagBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openAssignTagMenu(tagBtn, folder);
          });

          const countEl = document.createElement('span');
          countEl.className = 'project-count-pill';
          countEl.textContent = sessCount > 0 ? String(sessCount) : '';

          const newBtn = document.createElement('button');
          newBtn.className = 'project-new-btn';
          newBtn.innerHTML = SVG_ICONS.plus;
          newBtn.title = `在 [${badgeText}] ${folder.path} 新建对话`;
          newBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!folder.sshHost) {
              openNodeManagerModal(folder.nodeId);
              showToast('请先为该 Linux 节点配置 SSH Host');
              return;
            }
            startNewConversationInProject(folder.path, folder.name, folder.nodeId);
          });

          header.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            openAssignTagMenu(tagBtn.offsetParent ? tagBtn : header, folder);
          });

          header.addEventListener('click', () => {
            if (collapsedProjects.has(folderKey)) {
              collapsedProjects.delete(folderKey);
            } else {
              collapsedProjects.add(folderKey);
            }
            saveCollapsedProjects();
            renderProjectTree();
            loadSessionFiles(folder.path, folder.nodeId);
          });

          header.appendChild(nameWrap);
          header.appendChild(countEl);
          header.appendChild(tagBtn);
          header.appendChild(newBtn);
          group.appendChild(header);

          const sessionList = document.createElement('div');
          sessionList.className = 'session-items';

          if (!folder.sessions || folder.sessions.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-sessions';
            empty.textContent = '暂无对话';
            sessionList.appendChild(empty);
          } else {
            const isListExpanded = expandedSessionLists.has(folderKey);
            const visibleSessions = isListExpanded
              ? folder.sessions
              : folder.sessions.filter((sess, idx) => idx < SESSION_PREVIEW_LIMIT || Boolean(sessionTabId(sess.id, sess.nodeId || folder.nodeId)));
            for (const sess of visibleSessions) {
              const openId = sessionTabId(sess.id, sess.nodeId || folder.nodeId);
              const isOpen = Boolean(openId);
              const isCurrent = Boolean(openId) && activeTabId === openId;

              const item = document.createElement('div');
              item.className = `session-item${isCurrent ? ' active' : ''}`;
              const displayTitle = cleanSessionTitle(sess.title, sess.id);
              item.title = `${displayTitle}\n${sess.turns || 1} turns · ${formatRelativeTime(sess.updatedAt)} · 双击重命名`;
              item.innerHTML = `
                <div class="session-info">
                  ${isOpen ? '<span class="session-live-dot"></span>' : ''}
                  <span class="session-title">${escapeHtml(displayTitle)}</span>
                </div>
                <span class="session-meta">${formatRelativeTime(sess.updatedAt)}</span>
                <div class="session-actions">
                  <button class="session-act-btn session-rename-btn" title="重命名">${SVG_ICONS.edit}</button>
                  <button class="session-act-btn danger session-del-btn" title="删除">${SVG_ICONS.trash}</button>
                </div>
              `;

              item.addEventListener('click', () => {
                openOrSwitchTerminalTab({
                  tabId: sess.id,
                  sessionId: sess.id,
                  title: sess.title,
                  cwd: sess.cwd || folder.path,
                  nodeId: sess.nodeId || folder.nodeId,
                  nodeBadge: sess.nodeBadge || folder.nodeBadge,
                  sshHost: sess.sshHost || folder.sshHost,
                  localWorkAlias: sess.localWorkAlias || folder.localWorkAlias,
                  resume: true,
                  mode: 'claude',
                });
              });

              item.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                openRenameSessionModal(sess.id, sess.title, sess.nodeId || folder.nodeId);
              });

              item.querySelector('.session-rename-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                openRenameSessionModal(sess.id, sess.title, sess.nodeId || folder.nodeId);
              });

              item.querySelector('.session-del-btn').addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm(`确定删除会话 "${sess.title}" 吗？`)) return;
                if (openId) {
                  await closeTerminalTab(openId);
                }
                await fetch(`/api/sessions?id=${encodeURIComponent(sess.id)}&nodeId=${encodeURIComponent(sess.nodeId || folder.nodeId || '')}`, { method: 'DELETE' });
                loadProjectTree();
              });

              sessionList.appendChild(item);
            }
            if (folder.sessions.length > SESSION_PREVIEW_LIMIT) {
              const more = document.createElement('button');
              more.type = 'button';
              more.className = 'see-more-link';
              more.textContent = isListExpanded ? '收起' : `查看全部 (${folder.sessions.length})`;
              more.addEventListener('click', (e) => {
                e.stopPropagation();
                if (isListExpanded) expandedSessionLists.delete(folderKey);
                else expandedSessionLists.add(folderKey);
                renderProjectTree();
              });
              sessionList.appendChild(more);
            }
          }

          group.appendChild(sessionList);
          container.appendChild(group);
        }

        if (hiddenEmptyFolders.length > 0 || showEmptyFolders) {
          const toggleEmptyBtn = document.createElement('button');
          toggleEmptyBtn.type = 'button';
          toggleEmptyBtn.className = 'toggle-empty-link';
          toggleEmptyBtn.textContent = showEmptyFolders
            ? '隐藏空项目'
            : `+ ${hiddenEmptyFolders.length} 个空项目`;
          toggleEmptyBtn.addEventListener('click', () => {
            showEmptyFolders = !showEmptyFolders;
            renderProjectTree();
          });
          container.appendChild(toggleEmptyBtn);
        }

        document.getElementById('sessionTotalBadge').textContent = `${displayedFolders.length} 个项目 · ${totalSessions} 个对话`;
        const clearBtn = document.getElementById('btnClearFilters');
        if (clearBtn) clearBtn.hidden = selectedNodeFilter === 'all' && selectedTagFilter === 'all';
        const startNode = getNodeInfo(selectedNodeFilter !== 'all' ? selectedNodeFilter : currentFilesNodeId);
        document.getElementById('btnStartDefaultSessionLabel').textContent =
          `在 ${startNode.badge || startNode.name || '默认机器'} 打开 ${startNode.remoteWorkDir || '/root/work'}`;

        if (displayedFolders.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'empty-sessions';
          empty.style.padding = '14px 8px';
          empty.textContent = selectedTagFilter !== 'all' || selectedNodeFilter !== 'all'
            ? '没有符合筛选条件的项目'
            : '还没有项目。点左上角的「新建项目」，或在项目上点 + 打开终端。';
          container.prepend(empty);
        }
        container.scrollTop = prevScroll;
      }

      document.getElementById('btnClearFilters').addEventListener('click', () => {
        selectedNodeFilter = 'all';
        selectedTagFilter = 'all';
        localStorage.setItem('takt_tag_filter', 'all');
        renderProjectTree();
      });

      // Collapse / Expand All Projects Button
      document.getElementById('btnToggleAllProjects').addEventListener('click', () => {
        const shown = foldersData.filter((f) => visibleProjectKeys.has(getFolderKey(f)));
        const allCollapsed = shown.every((f) => collapsedProjects.has(getFolderKey(f)));
        if (!allCollapsed) {
          for (const f of shown) collapsedProjects.add(getFolderKey(f));
        } else {
          for (const f of shown) collapsedProjects.delete(getFolderKey(f));
        }
        saveCollapsedProjects();
        renderProjectTree();
      });

      function generateUUID() {
        if (crypto.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          const v = c === 'x' ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        });
      }

      function startNewConversationInProject(projectPath = '/root/work', projectName = 'work', nodeId = primaryNodeId()) {
        const node = getNodeInfo(nodeId);
        if (!node.sshHost) {
          openNodeManagerModal(node.id);
          showToast('请先为该 Linux 节点配置 SSH Host');
          return;
        }
        const sid = generateUUID();
        const shortProj = projectName.replace(/\s*\(.*?\)\s*/, '');
        const title = `${shortProj} · 终端`;
        const key = `${node.id}::${projectPath}`;
        visibleProjectKeys.add(key);
        collapsedProjects.delete(key);
        saveCollapsedProjects();
        // Immediately persist new session & project visibility into local SQLite
        fetch('/api/sessions/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sid, nodeId: node.id, cwd: projectPath, title }),
        })
          .then(() => loadProjectTree())
          .catch(() => {});
        openOrSwitchTerminalTab({
          tabId: sid,
          sessionId: sid,
          title,
          cwd: projectPath,
          nodeId: node.id,
          nodeBadge: node.badge,
          sshHost: node.sshHost,
          localWorkAlias: node.localWorkAlias,
          resume: false,
          mode: 'claude',
        });
      }

      // ============================================================================
      // 7. Center Panel: Dual-Engine (Native SwiftTerm + Web xterm) Terminal Manager
      // ============================================================================
      function openOrSwitchTerminalTab({
        tabId,
        sessionId,
        title,
        cwd,
        nodeId = primaryNodeId(),
        nodeBadge = '',
        sshHost = '',
        localWorkAlias = '',
        resume = true,
        mode = 'claude',
      }) {
        const existingId = sessionTabId(sessionId || tabId, nodeId);
        if (existingId) { activateTerminalTab(existingId); return; }
        if (tabs.has(tabId) && tabs.get(tabId).nodeId !== nodeId) tabId = `${tabId}--${nodeId}`;
        if (tabs.has(tabId)) { activateTerminalTab(tabId); return; }

        const node = getNodeInfo(nodeId);
        const resolvedNodeId = node.id;
        const resolvedBadge = nodeBadge || node.badge || 'LX-1';
        const resolvedSshHost = sshHost || node.sshHost || '';
        const resolvedAlias = localWorkAlias || node.localWorkAlias || 'work';

        const stage = document.getElementById('terminalStage');
        document.getElementById('emptyTermPlaceholder').style.display = 'none';

        const wrapEl = document.createElement('div');
        wrapEl.className = 'term-instance-wrap';
        const mountEl = document.createElement('div');
        mountEl.className = 'term-mount';
        wrapEl.appendChild(mountEl);
        stage.appendChild(wrapEl);

        const term = new window.Terminal({
          ...window.TaktAppearance.termOptions(),
          allowProposedApi: true,
          scrollback: 10000,
        });

        const fitAddon = new window.FitAddon.FitAddon();
        term.loadAddon(fitAddon);

        if (window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon) {
          term.loadAddon(new window.WebLinksAddon.WebLinksAddon((event, uri) => {
            event.preventDefault();
            previewUrlInRightPane(uri);
          }));
        }

        term.open(mountEl);
        registerFilePathLinkProvider(term, cwd || '/root/work');

        const tabObj = {
          tabId,
          sessionId: sessionId || tabId,
          title: title || `终端 ${String(tabId).slice(0, 6)}`,
          cwd: cwd || '/root/work',
          nodeId: resolvedNodeId,
          nodeBadge: resolvedBadge,
          sshHost: resolvedSshHost,
          localWorkAlias: resolvedAlias,
          resume: Boolean(resume),
          mode,
          term,
          fitAddon,
          wrapEl,
          ws: null,
          wsEverOpened: false,
          exited: false,
          seenImages: new Set(),
          viewMode: savedViewModes[tabId] === 'chat' ? 'chat' : 'terminal',
          chat: null,
        };

        tabs.set(tabId, tabObj);
        activateTerminalTab(tabId);

        if (terminalEngine === 'web' || !hasNativeHost) {
          ensureWebTerminalConnected(tabObj);
        }

        renderTabBar();
        renderProjectTree();
        setTimeout(() => loadProjectTree(), 2500);
      }

      function ensureWebTerminalConnected(tabObj) {
        if (tabObj.ws && (tabObj.ws.readyState === WebSocket.OPEN || tabObj.ws.readyState === WebSocket.CONNECTING)) {
          return;
        }
        const dims = tabObj.fitAddon.proposeDimensions() || { cols: 120, rows: 34 };
        const qs = new URLSearchParams({
          tabId: tabObj.tabId,
          sessionId: tabObj.sessionId,
          cwd: tabObj.cwd,
          nodeId: tabObj.nodeId || primaryNodeId(),
          sshHost: tabObj.sshHost || '',
          title: tabObj.title,
          resume: tabObj.resume ? '1' : '0',
          mode: tabObj.mode,
          cols: String(dims.cols || 120),
          rows: String(dims.rows || 34),
        });

        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${location.host}/ws/term?${qs.toString()}`);
        tabObj.ws = ws;

        ws.addEventListener('open', () => {
          // The server replays its scrollback buffer to every new connection — clear first,
          // otherwise each reconnect duplicates the whole screen history.
          if (tabObj.wsEverOpened) {
            try { tabObj.term.reset(); } catch {}
          }
          tabObj.wsEverOpened = true;
          tabObj.exited = false;
          renderTabBar();
          setTimeout(() => {
            try {
              tabObj.fitAddon.fit();
              ws.send(JSON.stringify({ type: 'resize', cols: tabObj.term.cols, rows: tabObj.term.rows }));
            } catch {}
          }, 80);
        });

        ws.addEventListener('message', (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'output' && typeof msg.data === 'string') {
              tabObj.term.write(msg.data);
              detectAndRenderInlineMediaFromOutput(tabObj, msg.data);
            } else if (msg.type === 'exit') {
              tabObj.exited = true;
              tabObj.term.write('\r\n\x1b[38;5;244m[TAKT] 会话已结束，按任意键重新连接…\x1b[0m\r\n');
              try { ws.close(); } catch {}
              renderTabBar();
            }
          } catch {}
        });

        ws.addEventListener('close', () => {
          renderTabBar();
          if (tabObj.exited) return; // wait for a key press (see onData)
          if (tabs.has(tabObj.tabId) && terminalEngine === 'web') {
            setTimeout(() => {
              if (tabs.has(tabObj.tabId) && terminalEngine === 'web' && !tabObj.exited) {
                ensureWebTerminalConnected(tabObj);
              }
            }, 1200);
          }
        });

        if (!tabObj._listenersBound) {
          tabObj._listenersBound = true;
          tabObj.term.onData((data) => {
            if (tabObj.exited) {
              tabObj.exited = false;
              ensureWebTerminalConnected(tabObj);
              return;
            }
            if (tabObj.ws && tabObj.ws.readyState === WebSocket.OPEN) {
              tabObj.ws.send(JSON.stringify({ type: 'input', data }));
            }
          });
          tabObj.term.onResize(({ cols, rows }) => {
            if (tabObj.ws && tabObj.ws.readyState === WebSocket.OPEN) {
              tabObj.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
            }
          });
        }
      }

      function sendTextToActiveTerminal(text) {
        if (!activeTabId || !tabs.has(activeTabId)) {
          showToast('请先打开或选择一个终端标签页');
          return;
        }
        const t = tabs.get(activeTabId);
        if (t.viewMode === 'chat' && !/[\r\n]$/.test(text)) {
          insertIntoDocktermComposer(`@${text.trim()} `);
          return;
        }
        if (terminalEngine === 'native' && hasNativeHost) {
          postNativeMessage({ action: 'sendInput', tabId: t.tabId, text });
        } else {
          ensureWebTerminalConnected(t);
          if (t.ws && t.ws.readyState === WebSocket.OPEN) {
            t.ws.send(JSON.stringify({ type: 'input', data: text }));
            t.term.focus();
          }
        }
      }

      function activateTerminalTab(tabId) {
        if (!tabs.has(tabId)) return;
        activeTabId = tabId;

        for (const [id, t] of tabs.entries()) {
          if (id === tabId) {
            t.wrapEl.classList.add('active');
            if (terminalEngine === 'native' && hasNativeHost) {
              postNativeMessage({
                action: 'activateTab',
                tabId: t.tabId,
                sessionId: t.sessionId,
                cwd: t.cwd,
                sshHost: t.sshHost || '',
                title: t.title,
                resume: t.resume,
              });
              setTimeout(syncNativeTerminalGeometry, 20);
            } else {
              ensureWebTerminalConnected(t);
              setTimeout(() => {
                try {
                  t.fitAddon.fit();
                  if (t.viewMode !== 'chat') t.term.focus();
                } catch {}
              }, 20);
            }
            if (currentFilesCwd !== t.cwd || currentFilesNodeId !== t.nodeId) {
              loadSessionFiles(t.cwd, t.nodeId);
            }
          } else {
            t.wrapEl.classList.remove('active');
          }
        }

        renderTabBar();
        renderProjectTree();
        renderContextBar();
        if (typeof syncDocktermViewUI === 'function') {
          syncDocktermViewUI();
        }
        const tabEl = document.querySelector(`.term-tab[data-tab-id="${CSS.escape(tabId)}"]`);
        if (tabEl) tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }

      async function closeTerminalTab(tabId) {
        const tabObj = tabs.get(tabId);
        if (!tabObj) return;

        postNativeMessage({ action: 'closeTab', tabId });

        try {
          if (tabObj.ws && tabObj.ws.readyState === WebSocket.OPEN) {
            tabObj.ws.send(JSON.stringify({ type: 'kill' }));
            tabObj.ws.close();
          }
        } catch {}
        await fetch(`/api/tabs?tabId=${encodeURIComponent(tabId)}&nodeId=${encodeURIComponent(tabObj.nodeId || '')}`, { method: 'DELETE' }).catch(() => {});

        try { tabObj.term.dispose(); } catch {}
        try { tabObj.wrapEl.remove(); } catch {}
        tabs.delete(tabId);
        if (savedViewModes[tabId]) {
          delete savedViewModes[tabId];
          persistViewModes();
        }

        if (activeTabId === tabId) {
          const remaining = Array.from(tabs.keys());
          if (remaining.length > 0) {
            activateTerminalTab(remaining[remaining.length - 1]);
          } else {
            activeTabId = null;
            document.getElementById('emptyTermPlaceholder').style.display = 'flex';
            renderContextBar();
            if (typeof syncDocktermViewUI === 'function') syncDocktermViewUI();
            syncNativeTerminalGeometry();
          }
        }

        renderTabBar();
        renderProjectTree();
      }

      function tabProjectName(t) {
        const node = getNodeInfo(t.nodeId);
        const root = (node.remoteWorkDir || '/root/work').replace(/\/+$/, '');
        return t.cwd === root || t.cwd === '/root/work' ? (t.localWorkAlias || 'work') : t.cwd.split('/').pop();
      }

      function renderTabBar() {
        const bar = document.getElementById('tabBarList');
        bar.innerHTML = '';
        const multiNode = nodesData.length > 1;

        for (const [tabId, t] of tabs.entries()) {
          const btn = document.createElement('div');
          btn.className = `term-tab${tabId === activeTabId ? ' active' : ''}`;
          btn.dataset.tabId = tabId;
          const isChat = t.viewMode === 'chat';
          const connected = terminalEngine === 'native' || (t.ws && t.ws.readyState === WebSocket.OPEN);
          const chatStatus = t.chat && t.chat.status;
          const dotClass = !connected || t.exited ? ' off' : chatStatus === 'working' ? ' working' : chatStatus === 'asking' ? ' asking' : '';
          btn.title = `${t.title}\n[${t.nodeBadge || ''} · ${t.sshHost}] ${t.cwd}\n双击重命名 · 中键关闭`;
          btn.innerHTML = `
            <span class="term-tab-dot${dotClass}"></span>
            ${multiNode ? `<span class="term-tab-badge">${escapeHtml(t.nodeBadge || '')}</span>` : ''}
            <span class="term-tab-label">${escapeHtml(t.title || tabProjectName(t))}</span>
            ${isChat ? '<span class="term-tab-mode-icon" title="对话视图"><svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>' : ''}
            <button class="term-tab-close" title="关闭标签页（同时结束远端 tmux 会话）">${SVG_ICONS.close}</button>
          `;

          btn.addEventListener('click', () => activateTerminalTab(tabId));
          btn.addEventListener('auxclick', (e) => {
            if (e.button === 1) {
              e.preventDefault();
              closeTerminalTab(tabId);
            }
          });
          btn.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            openRenameSessionModal(tabId, t.title, t.nodeId);
          });
          btn.querySelector('.term-tab-close').addEventListener('click', (e) => {
            e.stopPropagation();
            closeTerminalTab(tabId);
          });

          bar.appendChild(btn);
        }
      }

      // Context bar under the tabs: location + status + the actions that make sense for the view
      function claudeLaunchCommand(t, { forShell = false } = {}) {
        const sid = String(t.sessionId || '');
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid);
        const known = t.chat && t.chat.resolvedSessionId && t.chat.jsonlPath ? t.chat.resolvedSessionId : '';
        if (known) return `claude -r ${known}`;
        if (!isUuid) return 'claude';
        // New tab: pin Claude's session id to the tab id so the sidebar and the conversation view match 1:1.
        if (!t.resume) return `claude --session-id ${sid}`;
        return forShell ? `claude -r ${sid} || claude --session-id ${sid}` : `claude -r ${sid}`;
      }

      function renderContextBar() {
        const bar = document.getElementById('contextBar');
        const t = activeTabId && tabs.has(activeTabId) ? tabs.get(activeTabId) : null;
        bar.hidden = !t;
        if (!t) return;
        const view = t.viewMode === 'chat' ? 'chat' : 'terminal';
        const badge = document.getElementById('ctxBadge');
        badge.textContent = t.nodeBadge || 'LX-1';
        badge.title = `${t.sshHost}`;
        const pathEl = document.getElementById('ctxPath');
        pathEl.textContent = t.cwd;
        pathEl.title = `${t.sshHost}:${t.cwd}`;
        const cmd = claudeLaunchCommand(t);
        const cmdEl = document.getElementById('ctxCmdText');
        cmdEl.textContent = cmd;
        cmdEl.title = cmd;
        bar.querySelectorAll('[data-view]').forEach((el) => {
          if (el.id === 'btnDocktermStartClaude') return; // managed by the chat view
          el.hidden = el.dataset.view !== view;
        });
        if (view !== 'chat') {
          document.getElementById('btnDocktermStartClaude').hidden = true;
          document.getElementById('ctxStatus').hidden = true;
        }
      }

      // ============================================================================
      // 8. Right Panel: Collapsible & Drag-and-Drop File Tree + Previewer (Mac Local Path Priority)
      // ============================================================================
      function toLocalMacPath(p, nodeId = currentFilesNodeId) {
        const node = getNodeInfo(nodeId);
        const localRoot = node.localWorkDir || '';
        const remoteRoot = (node.remoteWorkDir || '/root/work').replace(/\/+$/, '') || '/root/work';
        const clean = String(p || '').trim().replace(/\/+$/, '');
        if (!clean || clean === remoteRoot || clean === localRoot) {
          return localRoot;
        }
        if (clean.startsWith(remoteRoot + '/')) {
          return `${localRoot}/${clean.slice(remoteRoot.length + 1)}`;
        }
        if (clean.startsWith('/root/work/')) {
          return `${localRoot}/${clean.slice('/root/work/'.length)}`;
        }
        return clean;
      }

      async function loadSessionFiles(cwd = currentFilesCwd, nodeId = currentFilesNodeId, opts = {}) {
        const silent = !!(opts && opts.silent);
        currentFilesCwd = cwd || '/root/work';
        currentFilesNodeId = nodeId || currentFilesNodeId || primaryNodeId();
        const activeNode = getNodeInfo(currentFilesNodeId);
        document.getElementById('currentSessionCwdLabel').textContent = toLocalMacPath(currentFilesCwd, currentFilesNodeId);
        const badgeEl = document.getElementById('rightNodeBadge');
        if (badgeEl && activeNode) {
          badgeEl.textContent = `${activeNode.badge} · ${activeNode.localWorkAlias}`;
          badgeEl.className = activeNode.id === primaryNodeId() ? 'machine-badge' : 'machine-badge secondary';
        }
        try {
          const res = await fetch(`/api/files?cwd=${encodeURIComponent(currentFilesCwd)}&nodeId=${encodeURIComponent(currentFilesNodeId)}`);
          const data = await res.json();
          if (data && data.localRoot) {
            document.getElementById('currentSessionCwdLabel').textContent = data.localRoot;
          }
          if (data && data.nodeBadge && badgeEl) {
            badgeEl.textContent = `${data.nodeBadge} · ${data.localWorkAlias || 'work'}`;
          }
          const items = data.items || [];
          const sig = JSON.stringify(items);
          if (silent && sig === filesSig) return;          // nothing changed → no re-render, no flicker
          if (silent && filesUserBusy()) { filesPending = true; return; }  // don't disturb a drag / rename in progress
          filesSig = sig;
          filesPending = false;
          currentFileTree = items;
          const scroller = document.getElementById('fileTreeContainer');
          const keepTop = scroller ? scroller.scrollTop : 0;
          renderFileTree();
          if (scroller && silent) scroller.scrollTop = keepTop;
          ensureFilesLive();
        } catch (err) {
          if (!silent) console.error('Failed to load session files:', err);
        }
      }

      // ---- Live file tree: SSE push from the server (fs.watch) + polling fallback + refresh on focus ----
      let filesSig = '';
      let filesPending = false;
      let filesES = null;
      let filesESKey = '';
      let filesSSEOk = false;
      let filesReloadTimer = null;

      function filesUserBusy() {
        if (isDraggingFile) return true;
        const el = document.activeElement;
        const box = document.getElementById('fileTreeContainer');
        return !!(el && box && box.contains(el) && /^(INPUT|TEXTAREA)$/.test(el.tagName));
      }

      function scheduleFilesReload() {
        if (filesReloadTimer) return;
        filesReloadTimer = setTimeout(() => {
          filesReloadTimer = null;
          loadSessionFiles(currentFilesCwd, currentFilesNodeId, { silent: true });
        }, 120);
      }

      function ensureFilesLive() {
        if (typeof EventSource === 'undefined') return;
        const key = `${currentFilesCwd}|${currentFilesNodeId}`;
        if (filesES && filesESKey === key) return;
        if (filesES) { try { filesES.close(); } catch (_) {} filesES = null; }
        filesSSEOk = false;
        filesESKey = key;
        const es = new EventSource(`/api/files-events?cwd=${encodeURIComponent(currentFilesCwd)}&nodeId=${encodeURIComponent(currentFilesNodeId)}`);
        filesES = es;
        es.addEventListener('ready', () => { filesSSEOk = true; });
        es.addEventListener('nowatch', () => { filesSSEOk = false; });
        es.addEventListener('change', scheduleFilesReload);
        es.onerror = () => { filesSSEOk = false; };
      }

      // Fallback: when the push channel is down, poll every 4s; always retry a deferred reload.
      setInterval(() => {
        if (document.hidden) return;
        if (!filesSSEOk || filesPending) scheduleFilesReload();
      }, 4000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleFilesReload(); });
      window.addEventListener('focus', scheduleFilesReload);

      function formatBytes(bytes) {
        if (!bytes || bytes < 1024) return `${bytes || 0} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      }

      function collectAllDirPaths(nodes, out = []) {
        for (const n of nodes) {
          if (n.type === 'dir') {
            out.push(n.path);
            if (n.children) collectAllDirPaths(n.children, out);
          }
        }
        return out;
      }

      document.getElementById('btnToggleAllDirs').addEventListener('click', () => {
        const allDirs = collectAllDirPaths(currentFileTree);
        if (collapsedDirs.size < allDirs.length) {
          for (const p of allDirs) collapsedDirs.add(p);
        } else {
          collapsedDirs.clear();
        }
        saveCollapsedDirs();
        renderFileTree();
      });

      function shellEscapePath(p) {
        if (/^[a-zA-Z0-9_./-]+$/.test(p)) return p;
        return `'${String(p).replace(/'/g, `'\\''`)}'`;
      }

      function renderFileTree() {
        const container = document.getElementById('fileTreeContainer');
        const filter = (document.getElementById('fileSearchInput').value || '').trim().toLowerCase();
        container.innerHTML = '';
        let count = 0;

        function nodeMatchesFilter(node) {
          if (!filter) return true;
          if (node.name.toLowerCase().includes(filter) || (node.relPath || '').toLowerCase().includes(filter)) {
            return true;
          }
          if (node.type === 'dir' && Array.isArray(node.children)) {
            return node.children.some(nodeMatchesFilter);
          }
          return false;
        }

        function buildTreeDom(nodes, parentEl, depth) {
          for (const node of nodes) {
            if (!nodeMatchesFilter(node)) continue;
            count++;

            const isDir = node.type === 'dir';
            const isCollapsed = isDir && !filter && collapsedDirs.has(node.path);

            const groupEl = document.createElement('div');
            groupEl.className = `tree-node-group${isCollapsed ? ' collapsed' : ''}`;

            const row = document.createElement('div');
            row.className = `tree-row${selectedFilePath === node.path ? ' selected' : ''}`;
            row.style.paddingLeft = `${6 + depth * 14}px`;
            row.setAttribute('draggable', 'true');
            if (isDir) {
              row.setAttribute('aria-expanded', String(!isCollapsed));
            }

            row.innerHTML = `
              <div class="tree-row-left">
                ${isDir ? SVG_ICONS.dirChevron : '<span class="dir-spacer"></span>'}
                ${fileIconSvg(node.ext, isDir, isCollapsed)}
                <span class="tree-name" title="${escapeHtml(node.path)} (可拖拽到终端或其它目录)">${escapeHtml(node.name)}</span>
              </div>
              <div class="tree-row-right">
                <button class="tree-send-btn" title="将路径注入当前终端">&gt;_</button>
                <span class="tree-size">${isDir ? (node.children ? node.children.length : 0) : formatBytes(node.size)}</span>
              </div>
            `;

            // Quick button: send path into active terminal
            row.querySelector('.tree-send-btn').addEventListener('click', (e) => {
              e.stopPropagation();
              sendTextToActiveTerminal(`${shellEscapePath(node.path)} `);
              showToast(`已注入路径: ${node.name}`);
            });

            // Click row: toggle directory collapse OR preview file (with 0ms client-side filter for non-previewable / large files)
            row.addEventListener('click', () => {
              selectedFilePath = node.path;
              if (isDir) {
                if (collapsedDirs.has(node.path)) {
                  collapsedDirs.delete(node.path);
                } else {
                  collapsedDirs.add(node.path);
                }
                saveCollapsedDirs();
                renderFileTree();
              } else {
                renderFileTree();
                const check = checkClientPreviewEligibility(node);
                if (!check.allowed) {
                  renderUnsupportedPreviewCard({
                    name: node.name,
                    path: node.path,
                    ext: node.ext,
                    size: node.size,
                    reason: check.reason,
                  });
                  return;
                }
                previewFileInRightPane(node.path, currentFilesCwd, false);
              }
            });

            // Drag Start (from File Tree -> Terminal OR -> Another Directory)
            row.addEventListener('dragstart', (e) => {
              isDraggingFile = true;
              row.classList.add('dragging-source');
              syncNativeTerminalGeometry(); // Temporarily reveal HTML drop zone over native terminal
              e.dataTransfer.effectAllowed = 'copyMove';
              e.dataTransfer.setData('application/x-takt-path', node.path);
              e.dataTransfer.setData('text/plain', shellEscapePath(node.path));
            });

            row.addEventListener('dragend', () => {
              isDraggingFile = false;
              row.classList.remove('dragging-source');
              document.getElementById('terminalStage').classList.remove('drag-over');
              syncNativeTerminalGeometry();
            });

            // Directory row as Drop Target (Move internal file/folder OR Upload external OS file)
            if (isDir) {
              row.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
                row.classList.add('drop-target');
              });
              row.addEventListener('dragleave', (e) => {
                e.stopPropagation();
                row.classList.remove('drop-target');
              });
              row.addEventListener('drop', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                row.classList.remove('drop-target');
                await handleDropOntoDirectory(e, node.path);
              });
            }

            groupEl.appendChild(row);

            if (isDir && Array.isArray(node.children) && node.children.length > 0) {
              const childrenEl = document.createElement('div');
              childrenEl.className = 'tree-children';
              buildTreeDom(node.children, childrenEl, depth + 1);
              groupEl.appendChild(childrenEl);
            }

            parentEl.appendChild(groupEl);
          }
        }

        buildTreeDom(currentFileTree, container, 0);
        document.getElementById('fileCountLabel').textContent = `${count} 项`;

        if (count === 0) {
          container.innerHTML = '<div class="preview-empty">当前目录为空 (可从 Finder 拖拽文件至此上传)</div>';
        }
      }

      // Handle dropping internal node OR external OS files onto a target directory
      async function handleDropOntoDirectory(e, targetDirPath) {
        const internalSourcePath = e.dataTransfer.getData('application/x-takt-path');
        if (internalSourcePath) {
          if (internalSourcePath === targetDirPath) return;
          const res = await fetch('/api/files/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sourcePath: internalSourcePath,
              targetDirPath,
              cwd: currentFilesCwd,
              nodeId: currentFilesNodeId,
            }),
          });
          const data = await res.json();
          if (data.ok) {
            collapsedDirs.delete(targetDirPath);
            saveCollapsedDirs();
            showToast(`已移动至 ${targetDirPath.split('/').pop()}`);
            await loadSessionFiles(currentFilesCwd, currentFilesNodeId);
          } else {
            showToast(data.error || '移动失败');
          }
          return;
        }

        // External files dropped from macOS Finder
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          await uploadExternalFilesToDir(e.dataTransfer.files, targetDirPath);
        }
      }

      async function uploadExternalFilesToDir(fileList, targetDirPath) {
        let uploaded = 0;
        for (const file of fileList) {
          const base64 = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
              const res = String(reader.result || '');
              resolve(res.includes(',') ? res.split(',')[1] : '');
            };
            reader.onerror = () => resolve('');
            reader.readAsDataURL(file);
          });
          if (!base64) continue;
          const res = await fetch('/api/files/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fileName: file.name,
              targetDirPath,
              cwd: currentFilesCwd,
              nodeId: currentFilesNodeId,
              contentBase64: base64,
            }),
          });
          const data = await res.json();
          if (data.ok) uploaded++;
        }
        if (uploaded > 0) {
          showToast(`已上传 ${uploaded} 个文件至 ${targetDirPath}`);
          await loadSessionFiles(currentFilesCwd, currentFilesNodeId);
        }
      }

      // Root Path Bar & File Tree Container Drop Listeners
      const rootDropBar = document.getElementById('rootDropBar');
      rootDropBar.addEventListener('dragover', (e) => {
        e.preventDefault();
        rootDropBar.classList.add('drop-target');
      });
      rootDropBar.addEventListener('dragleave', () => rootDropBar.classList.remove('drop-target'));
      rootDropBar.addEventListener('drop', async (e) => {
        e.preventDefault();
        rootDropBar.classList.remove('drop-target');
        await handleDropOntoDirectory(e, currentFilesCwd);
      });

      const fileTreeContainer = document.getElementById('fileTreeContainer');
      fileTreeContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        fileTreeContainer.classList.add('external-drag-over');
      });
      fileTreeContainer.addEventListener('dragleave', () => {
        fileTreeContainer.classList.remove('external-drag-over');
      });
      fileTreeContainer.addEventListener('drop', async (e) => {
        e.preventDefault();
        fileTreeContainer.classList.remove('external-drag-over');
        await handleDropOntoDirectory(e, currentFilesCwd);
      });

      // Center Terminal Stage Drop Target (Drag file from right tree -> inject path into terminal!)
      const terminalStage = document.getElementById('terminalStage');
      terminalStage.addEventListener('dragover', (e) => {
        e.preventDefault();
        terminalStage.classList.add('drag-over');
        const at = activeTabId && tabs.has(activeTabId) ? tabs.get(activeTabId) : null;
        const label = document.querySelector('#termDropOverlay span');
        const external = Array.from(e.dataTransfer.types || []).includes('Files') && !Array.from(e.dataTransfer.types || []).includes('application/x-takt-path');
        if (label) label.textContent = at && at.viewMode === 'chat' && external ? '松开即可作为附件添加到消息' : '松开即可把路径插入当前会话';
      });
      terminalStage.addEventListener('dragleave', () => {
        terminalStage.classList.remove('drag-over');
      });
      terminalStage.addEventListener('drop', (e) => {
        e.preventDefault();
        isDraggingFile = false;
        terminalStage.classList.remove('drag-over');
        const taktPath = e.dataTransfer.getData('application/x-takt-path');
        const plain = e.dataTransfer.getData('text/plain');
        const pathToInject = taktPath ? shellEscapePath(taktPath) : plain;
        syncNativeTerminalGeometry();
        const chatTab = activeTabId && tabs.has(activeTabId) ? tabs.get(activeTabId) : null;
        const dropped = Array.from(e.dataTransfer.files || []);
        if (!taktPath && dropped.length && chatTab && chatTab.viewMode === 'chat') {
          // Files from Finder -> attachments (folders are skipped)
          const dirs = new Set();
          for (const it of Array.from(e.dataTransfer.items || [])) {
            const en = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
            if (en && en.isDirectory) dirs.add(en.name);
          }
          if (dirs.size) showToast('文件夹不能作为附件，已跳过');
          addDocktermAttachments(dropped.filter((f) => !dirs.has(f.name)));
          return;
        }
        if (pathToInject) {
          const activeTab = activeTabId && tabs.has(activeTabId) ? tabs.get(activeTabId) : null;
          if (activeTab && activeTab.viewMode === 'chat') {
            insertIntoDocktermComposer(`@${pathToInject} `);
            return;
          }
          sendTextToActiveTerminal(`${pathToInject} `);
          showToast(`已插入路径：${pathToInject}`);
        }
      });

      // ============================================================================
      // 9. Terminal Output Link Detection & Right-Pane Previewer (Strict Whitelist + Fast Size Guard)
      // ============================================================================
      const PREVIEW_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
      const PREVIEW_WEB_EXTS = new Set(['.html', '.htm']);
      const PREVIEW_CODE_EXTS = new Set([
        '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.bash', '.zsh',
        '.json', '.yaml', '.yml', '.toml', '.ini', '.conf', '.env', '.md', '.txt',
        '.css', '.scss', '.less', '.c', '.cpp', '.cc', '.h', '.hpp', '.swift', '.rs',
        '.go', '.java', '.kt', '.sql', '.xml', '.csv', '.vue', '.svelte', '.lua',
        '.rb', '.php', '.pl', '.r', '.m', '.mm', '.cmake', '.mk', '.dockerfile',
        '.gitignore', '.stignore', '.log',
      ]);
      const PREVIEW_CODE_NAMES = new Set(['dockerfile', 'makefile', 'claude.md', 'readme', 'license', '.gitignore', '.stignore', '.env']);

      const MAX_PREVIEW_CODE_BYTES = 200 * 1024;        // 200 KB
      const MAX_PREVIEW_WEB_BYTES = 2 * 1024 * 1024;    // 2 MB
      const MAX_PREVIEW_IMAGE_BYTES = 12 * 1024 * 1024; // 12 MB

      function checkClientPreviewEligibility(node) {
        const nameLower = String(node.name || '').toLowerCase();
        const ext = String(node.ext || '').toLowerCase();
        const size = Number(node.size || 0);

        const isImg = PREVIEW_IMAGE_EXTS.has(ext);
        const isWeb = PREVIEW_WEB_EXTS.has(ext);
        const isCode = PREVIEW_CODE_EXTS.has(ext) || PREVIEW_CODE_NAMES.has(nameLower);

        if (!isImg && !isWeb && !isCode) {
          return {
            allowed: false,
            reason: `该文件类型 (${ext || '无后缀'}) 不支持直接预览 · 仅预览图片、网页与代码文件`,
          };
        }
        if (isCode && size > MAX_PREVIEW_CODE_BYTES) {
          return {
            allowed: false,
            reason: `文件体积 (${formatBytes(size)}) 超过 200 KB 极速预览阈值 · 已跳过加载以防卡顿`,
          };
        }
        if (isWeb && size > MAX_PREVIEW_WEB_BYTES) {
          return {
            allowed: false,
            reason: `网页文件 (${formatBytes(size)}) 超过 2 MB 阈值 · 已跳过内嵌加载`,
          };
        }
        if (isImg && size > MAX_PREVIEW_IMAGE_BYTES) {
          return {
            allowed: false,
            reason: `图片体积 (${formatBytes(size)}) 超过 12 MB 阈值 · 已跳过直接渲染`,
          };
        }
        return { allowed: true };
      }

      function renderUnsupportedPreviewCard({ name, path: filePath, ext, size, reason, cwd = currentFilesCwd, nodeId = currentFilesNodeId }) {
        previewPane.classList.remove('collapsed');
        const titleEl = document.getElementById('previewTitle');
        const actionsEl = document.getElementById('previewActions');
        const bodyEl = document.getElementById('previewBody');
        const localDisplayPath = toLocalMacPath(filePath, nodeId);

        titleEl.textContent = name || (localDisplayPath ? localDisplayPath.split('/').pop() : '跳过预览');
        actionsEl.innerHTML = '';

        bodyEl.innerHTML = `
          <div class="preview-empty" style="gap:10px; max-width:320px; margin:0 auto;">
            ${fileIconSvg(ext || '', false, false)}
            <div style="font-weight:600; color:var(--text-primary); font-size:12.5px; word-break:break-all;">${escapeHtml(name || localDisplayPath)}</div>
            <div style="font-size:11px; color:var(--text-secondary); line-height:1.5;">${escapeHtml(reason || '此文件不支持直接预览')}</div>
            <div style="font-size:10.5px; font-family:var(--font-mono); color:var(--text-muted);">
              ${size != null ? `大小: ${formatBytes(size)} · ` : ''}Mac 本地路径: ${escapeHtml(localDisplayPath)}
            </div>
            <div style="display:flex; gap:8px; margin-top:4px; flex-wrap:wrap; justify-content:center;">
              <button class="btn" id="btnCardOpenMac">用 Mac 应用打开</button>
              <button class="btn" id="btnCardOpenFinder">在 Finder 中定位</button>
              <button class="btn btn-primary" id="btnCardInjectPath">&gt;_ 注入终端</button>
            </div>
          </div>
        `;

        const btnFinder = document.getElementById('btnCardOpenFinder');
        if (btnFinder) {
          btnFinder.addEventListener('click', () => {
            openDocktermFileOnMac({ cwd, nodeId }, { path: filePath, reveal: true, label: name });
          });
        }
        const btnOpenMac = document.getElementById('btnCardOpenMac');
        if (btnOpenMac) {
          btnOpenMac.addEventListener('click', () => {
            openDocktermFileOnMac({ cwd, nodeId }, { path: filePath, label: name });
          });
        }
        const btnInject = document.getElementById('btnCardInjectPath');
        if (btnInject) {
          btnInject.addEventListener('click', () => {
            sendTextToActiveTerminal(`${shellEscapePath(localDisplayPath)} `);
            showToast(`已注入路径: ${name || localDisplayPath}`);
          });
        }
      }

      const FILE_PATH_REGEX = /(?:\/root\/work\/[^\s"'<>()`]+|\/Users\/will\/[^\s"'<>()`]+|(?:\.\/|\.\.\/)?[a-zA-Z0-9_\-\u4e00-\u9fa5/]+\.(?:png|jpg|jpeg|gif|webp|svg|md|py|js|mjs|ts|tsx|json|html|htm|css|sh|c|cpp|h|swift|rs|go|yaml|yml|toml|txt|log)(?::\d+(?::\d+)?)?)/g;

      function registerFilePathLinkProvider(term, sessionCwd) {
        if (typeof term.registerLinkProvider !== 'function') return;
        term.registerLinkProvider({
          provideLinks(bufferLineNumber, callback) {
            const line = term.buffer.active.getLine(bufferLineNumber - 1);
            if (!line) return callback(undefined);
            const text = line.translateToString(true);
            const links = [];
            FILE_PATH_REGEX.lastIndex = 0;
            let match;
            while ((match = FILE_PATH_REGEX.exec(text)) !== null) {
              const matchedText = match[0];
              const startX = match.index + 1;
              const endX = startX + matchedText.length;
              links.push({
                range: {
                  start: { x: startX, y: bufferLineNumber },
                  end: { x: endX, y: bufferLineNumber },
                },
                text: matchedText,
                activate(_event, linkText) {
                  previewFileInRightPane(linkText, sessionCwd, true);
                },
              });
            }
            callback(links.length > 0 ? links : undefined);
          },
        });
      }

      function stripAnsi(str) {
        return String(str).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
      }

      const TERM_IMG_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg)(?![\w])/i;
      // directory names may contain dots (.takt/uploads, .cache …); a sentence-ending "." is not part of it
      const TERM_IMG_PATH_RE = /(?:~|\.{1,2})?\/?(?:[\w\-.\u4e00-\u9fa5]+\/)*[\w\-\u4e00-\u9fa5][\w\-.\u4e00-\u9fa5]*?\.(?:png|jpe?g|gif|webp|svg)(?![\w]|\.\w)/gi;

      function detectAndRenderInlineMediaFromOutput(tabObj, rawChunk) {
        // The conversation view shows images itself; terminal cards would cover its composer
        if (tabObj.viewMode === 'chat') return;
        const clean = stripAnsi(rawChunk);
        if (!TERM_IMG_EXT_RE.test(clean)) return;
        for (const line of clean.split(/[\r\n]+/)) {
          if (line.length > 2000 || !TERM_IMG_EXT_RE.test(line)) continue; // bounded work per chunk
          TERM_IMG_PATH_RE.lastIndex = 0;
          let m;
          while ((m = TERM_IMG_PATH_RE.exec(line)) !== null) {
            const imgPath = m[0];
            if (tabObj.seenImages.has(imgPath)) continue;
            tabObj.seenImages.add(imgPath);
            showInlineTerminalImageCard(imgPath, tabObj.cwd);
            previewFileInRightPane(imgPath, tabObj.cwd, false);
          }
        }
      }

      function showInlineTerminalImageCard(filePath, cwd) {
        const tray = document.getElementById('termInlineTray');
        const rawUrl = `/api/raw-file?path=${encodeURIComponent(filePath)}&cwd=${encodeURIComponent(cwd)}&nodeId=${encodeURIComponent(currentFilesNodeId)}&t=${Date.now()}`;
        const fileName = filePath.split('/').pop();

        const card = document.createElement('div');
        card.className = 'inline-preview-card';
        card.innerHTML = `
          <div class="inline-card-head">
            <span style="display:flex;align-items:center;gap:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(filePath)}">
              ${SVG_ICONS.fileImage}
              <span>${escapeHtml(fileName)}</span>
            </span>
            <button class="term-tab-close" title="关闭内联预览">${SVG_ICONS.close}</button>
          </div>
          <img class="inline-card-img" src="${rawUrl}" alt="${escapeHtml(fileName)}" />
        `;

        card.querySelector('.term-tab-close').addEventListener('click', () => card.remove());
        card.querySelector('.inline-card-img').addEventListener('click', () => {
          previewFileInRightPane(filePath, cwd, false);
        });

        tray.appendChild(card);
        while (tray.children.length > 3) {
          tray.firstElementChild.remove();
        }
      }

      let previewAbortCtrl = null;
      async function previewFileInRightPane(filePath, cwd = currentFilesCwd, alsoShowInlineIfImage = false, nodeId = currentFilesNodeId) {
        previewPane.classList.remove('collapsed');
        const titleEl = document.getElementById('previewTitle');
        const actionsEl = document.getElementById('previewActions');
        const bodyEl = document.getElementById('previewBody');

        const baseName = filePath.split('/').pop().replace(/:\d+(?::\d+)?$/, '');
        const extMatch = baseName.toLowerCase().match(/(\.[a-z0-9_-]+)$/);
        const ext = extMatch ? extMatch[1] : '';
        const preCheck = checkClientPreviewEligibility({ name: baseName, ext, size: 0 });
        if (!preCheck.allowed) {
          renderUnsupportedPreviewCard({ name: baseName, path: filePath, ext, size: null, reason: preCheck.reason, cwd, nodeId });
          return;
        }

        if (previewAbortCtrl) {
          try { previewAbortCtrl.abort(); } catch {}
        }
        previewAbortCtrl = new AbortController();

        titleEl.textContent = `加载 ${baseName}...`;
        actionsEl.innerHTML = '';

        try {
          const res = await fetch(
            `/api/file-content?path=${encodeURIComponent(filePath)}&cwd=${encodeURIComponent(cwd)}&nodeId=${encodeURIComponent(nodeId)}`,
            { signal: previewAbortCtrl.signal }
          );
          const data = await res.json();
          if (!data.ok) {
            titleEl.textContent = '无法预览';
            bodyEl.innerHTML = `<div class="preview-empty">${escapeHtml(data.error || '加载失败')}</div>`;
            return;
          }

          if (data.kind === 'unsupported' || data.kind === 'directory') {
            renderUnsupportedPreviewCard({
              name: data.name || baseName,
              path: data.localPath || data.path || filePath,
              ext: data.ext || ext,
              size: data.size,
              reason: data.reason || '该对象不支持直接内容预览',
              cwd,
              nodeId,
            });
            return;
          }

          const localDisplayPath = data.fromRemote ? (data.remotePath || data.path || filePath) : toLocalMacPath(data.localPath || data.path || filePath, nodeId);
          titleEl.textContent = data.name || localDisplayPath;
          titleEl.title = data.fromRemote ? `${localDisplayPath}\n不在本机同步目录里 · 已从节点拷贝到本机缓存` : localDisplayPath;

          const macBtn = document.createElement('button');
          macBtn.className = 'btn';
          macBtn.style.height = '20px';
          macBtn.style.fontSize = '10.5px';
          macBtn.title = '用 Mac 上的默认应用打开（⌥点击：在 Finder 中显示）';
          macBtn.innerHTML = `${SVG_ICONS.externalLink}<span>Mac 打开</span>`;
          macBtn.addEventListener('click', (ev) => {
            openDocktermFileOnMac({ cwd, nodeId }, { path: data.fromRemote ? (data.remotePath || filePath) : (data.localPath || filePath), reveal: ev.altKey, label: data.name || baseName });
          });
          actionsEl.appendChild(macBtn);

          if (data.rawUrl) {
            const openBtn = document.createElement('a');
            openBtn.className = 'btn';
            openBtn.style.height = '20px';
            openBtn.style.fontSize = '10.5px';
            openBtn.href = data.rawUrl;
            openBtn.target = '_blank';
            openBtn.innerHTML = `${SVG_ICONS.externalLink}<span>新窗口</span>`;
            actionsEl.appendChild(openBtn);
          }

          if (data.kind === 'image') {
            if (alsoShowInlineIfImage) {
              showInlineTerminalImageCard(localDisplayPath, cwd);
            }
            bodyEl.innerHTML = `
              <div class="preview-image-wrap">
                <img src="${data.rawUrl}" alt="${escapeHtml(data.name)}" />
                <div style="font-size:10.5px;color:var(--text-muted);font-family:var(--font-mono)">${escapeHtml(localDisplayPath)}</div>
              </div>
            `;
            return;
          }

          if (data.kind === 'html') {
            const sep = data.rawUrl.includes('?') ? '&' : '?';
            bodyEl.innerHTML = `<iframe class="preview-iframe" src="${data.rawUrl}${sep}theme=dark"></iframe>`;
            return;
          }

          const copyBtn = document.createElement('button');
          copyBtn.className = 'btn';
          copyBtn.style.height = '20px';
          copyBtn.style.fontSize = '10.5px';
          copyBtn.innerHTML = `${SVG_ICONS.copy}<span>复制</span>`;
          copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(data.content || '');
            showToast('文件内容已复制到剪贴板');
          });
          actionsEl.prepend(copyBtn);

          const pre = document.createElement('pre');
          pre.className = 'preview-code';
          pre.textContent = data.content || '';
          bodyEl.innerHTML = '';
          bodyEl.appendChild(pre);
        } catch (err) {
          if (err && err.name === 'AbortError') return;
          titleEl.textContent = '预览出错';
          bodyEl.innerHTML = `<div class="preview-empty">${escapeHtml(err.message)}</div>`;
        }
      }

      function previewUrlInRightPane(url) {
        previewPane.classList.remove('collapsed');
        const titleEl = document.getElementById('previewTitle');
        const actionsEl = document.getElementById('previewActions');
        const bodyEl = document.getElementById('previewBody');

        titleEl.textContent = url;
        actionsEl.innerHTML = `<a class="btn btn-primary" style="height:20px;font-size:10.5px;" href="${escapeHtml(url)}" target="_blank" rel="noopener">${SVG_ICONS.externalLink}<span>浏览器打开</span></a>`;

        if (/\.(png|jpg|jpeg|gif|webp|svg)(\?.*)?$/i.test(url)) {
          bodyEl.innerHTML = `<div class="preview-image-wrap"><img src="${escapeHtml(url)}" alt="Image link" /></div>`;
        } else {
          const sep = url.includes('?') ? '&' : '?';
          bodyEl.innerHTML = `<iframe class="preview-iframe" src="${escapeHtml(url)}${sep}theme=dark"></iframe>`;
        }
      }

      // ============================================================================
      // 10. Status Bar Polling & Controls
      // ============================================================================
      let lastAutoHealAt = 0;
      async function pollStatusBar() {
        const dotSsh = document.getElementById('dotSsh');
        const textSsh = document.getElementById('textSsh');
        const dotTs = document.getElementById('dotTailscale');
        const textTs = document.getElementById('textTailscale');
        const dotMcp = document.getElementById('dotMcp');
        const textMcp = document.getElementById('textMcp');
        const dotSync = document.getElementById('dotSyncthing');
        const textSync = document.getElementById('textSyncthing');

        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 3200);
          const res = await fetch('/api/status', { signal: ctrl.signal, cache: 'no-store' });
          clearTimeout(timer);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const st = await res.json();
          if (!st || !st.ok) throw new Error('Invalid status payload');

          const onlineN = Number(st.ssh.onlineNodesCount || 0);
          const totalN = Number(st.ssh.totalNodesCount || 1);
          dotSsh.className = `status-dot ${st.ssh.online ? (onlineN < totalN ? 'warn' : 'ok') : 'err'}`;
          textSsh.textContent = st.ssh.online
            ? `SSH ${totalN > 1 ? `${onlineN}/${totalN} 在线` : '在线'}${st.ssh.pingMs ? ` · ${st.ssh.pingMs}ms` : ''}`
            : 'SSH 断开 · 重连中';
          const nodeLines = Object.values(st.nodesStatus || {}).map((n) =>
            `${n.online ? '●' : '○'} ${n.sshHost || n.id || ''}${n.online ? `  ${n.pingMs || '--'}ms` : '  离线'}${n.mcpOk === false ? '  MCP 断开' : ''}`);
          document.getElementById('pillSsh').title = nodeLines.length
            ? `SSH 节点\n${nodeLines.join('\n')}${st.ssh.egressIp ? `\n出网 IP ${st.ssh.egressIp}` : ''}`
            : 'SSH 连接';

          dotTs.className = `status-dot ${st.tailscale.ok ? 'ok' : 'warn'}`;
          const tsIp = st.tailscale.remoteIp || st.tailscale.localIp;
          textTs.textContent = st.tailscale.ok ? 'Tailscale' : 'Tailscale 未连接';
          document.getElementById('pillTailscale').title = st.tailscale.ok ? `Tailscale 在线${tsIp ? ` · ${tsIp}` : ''}` : 'Tailscale 未连接';

          const failedMcpHosts = Array.isArray(st.mcp.failedHosts) ? st.mcp.failedHosts : [];
          dotMcp.className = `status-dot ${st.mcp.ok ? 'ok' : 'err'}`;
          textMcp.textContent = st.mcp.ok
            ? (failedMcpHosts.length ? `MCP ${failedMcpHosts.length} 个节点断开` : 'MCP')
            : st.mcp.localHttpOk ? 'MCP 隧道断开' : 'MCP 服务离线';
          document.getElementById('pillMcp').title = st.mcp.ok
            ? `本机 MCP 反向隧道正常 · ${st.mcp.tools} 个工具${failedMcpHosts.length ? `\n断开：${failedMcpHosts.join(', ')}` : ''}`
            : st.mcp.localHttpOk ? `隧道断开，正在自动重连${failedMcpHosts.length ? `\n${failedMcpHosts.join(', ')}` : ''}` : '本机 MCP 服务未运行，正在拉起';

          const needFiles = Number(st.syncthing.needFiles || 0);
          const needBytes = Number(st.syncthing.needBytes || 0);
          const fmtBytes = (n) => n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
          dotSync.className = `status-dot ${st.syncthing.ok && needFiles === 0 ? 'ok' : 'warn'}`;
          textSync.textContent = needFiles > 0
            ? `同步中 ${needFiles} 个文件${needBytes ? ` · ${fmtBytes(needBytes)}` : ''}`
            : st.syncthing.ok ? 'Syncthing' : 'Syncthing 未连接';
          document.getElementById('pillSyncthing').title = needFiles > 0
            ? `Syncthing 待同步 ${needFiles} 个文件`
            : st.syncthing.ok ? 'Syncthing 已同步' : 'Syncthing 未连接';

          // Automatically trigger self-heal if MCP tunnel or SSH is down
          if ((!st.mcp.ok || !st.ssh.online) && Date.now() - lastAutoHealAt > 8000) {
            lastAutoHealAt = Date.now();
            fetch('/api/heal', { method: 'POST' }).catch(() => {});
          }

          const enabledCount = nodesData.filter((n) => n.enabled !== false && n.sshHost).length || 1;
          const summary = document.getElementById('activePtySummary');
          summary.textContent = `标签 ${tabs.size} · Claude ${st.ssh.remoteCliProcesses || 0}`;
          summary.title = `已启用机器 ${enabledCount}/${nodesData.length || 1}\n打开的标签页 ${tabs.size}\n远端 Claude 进程 ${st.ssh.remoteCliProcesses || 0}\n终端引擎：${terminalEngine === 'native' ? 'SwiftTerm（原生）' : 'xterm.js（网页）'}`;
        } catch {
          // Never leave stale green lights when local workbench server (:3080) is unreachable!
          if (dotSsh) dotSsh.className = 'status-dot err';
          if (textSsh) textSsh.textContent = '后台服务离线 · 正在拉起';
          if (dotMcp) dotMcp.className = 'status-dot err';
          if (textMcp) textMcp.textContent = 'MCP 离线';
          if (dotSync) dotSync.className = 'status-dot warn';
          if (textSync) textSync.textContent = 'Syncthing';
          if (window.webkit?.messageHandlers?.taktNative) {
            try {
              window.webkit.messageHandlers.taktNative.postMessage({ action: 'ensureServices' });
            } catch {}
          }
        }
      }

      async function popCurrentSessionInSystemTerminal() {
        const t = (activeTabId && tabs.get(activeTabId)) || {
          tabId: 'main',
          cwd: currentFilesCwd,
          nodeId: currentFilesNodeId,
        };
        await fetch('/api/open-system-terminal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tabId: t.tabId, cwd: t.cwd, nodeId: t.nodeId || currentFilesNodeId }),
        });
      }

      // ============================================================================
      // 11. Event Bindings & Multi-Linux Node Manager
      // ============================================================================
      function escapeHtml(s) {
        return String(s || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      // "⋯" menu: rarely used actions that don't need a permanent button
      document.getElementById('btnMoreActions').addEventListener('click', (e) => {
        const anchor = e.currentTarget;
        openTagMenu(anchor, (menu) => {
          menu.appendChild(menuItem(
            `${SVG_ICONS.externalLink}<span>在 Terminal.app 中打开当前会话</span>`,
            () => { closeTagMenu(); popCurrentSessionInSystemTerminal(); },
          ));
          menu.appendChild(menuItem(
            `<svg class="icon icon-sm" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg><span>远程桌面</span>`,
            () => { closeTagMenu(); openRemoteDesktopModal(); },
          ));
          menu.appendChild(menuSep());
          menu.appendChild(menuItem(
            `${SVG_ICONS.edit}<span>重命名当前标签页</span>`,
            () => {
              closeTagMenu();
              if (activeTabId && tabs.has(activeTabId)) {
                const t = tabs.get(activeTabId);
                openRenameSessionModal(activeTabId, t.title, t.nodeId);
              }
            },
          ));
        });
      });

      document.getElementById('btnRefreshTree').addEventListener('click', () => loadProjectTree(true));
      document.getElementById('btnRefreshFiles').addEventListener('click', () => loadSessionFiles(currentFilesCwd, currentFilesNodeId));
      document.getElementById('fileSearchInput').addEventListener('input', () => renderFileTree());

      document.getElementById('btnOpenFinder').addEventListener('click', async () => {
        await fetch('/api/open-finder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: selectedFilePath || currentFilesCwd,
            cwd: currentFilesCwd,
            nodeId: currentFilesNodeId,
          }),
        });
      });

      document.getElementById('btnNewQuickSession').addEventListener('click', () => {
        const nodeObj = getNodeInfo(currentFilesNodeId);
        const projName = currentFilesCwd === '/root/work' ? nodeObj.localWorkAlias : currentFilesCwd.split('/').pop();
        startNewConversationInProject(currentFilesCwd, projName, nodeObj.id);
      });

      document.getElementById('btnStartDefaultSession').addEventListener('click', () => {
        const nodeObj = getNodeInfo(selectedNodeFilter !== 'all' ? selectedNodeFilter : currentFilesNodeId);
        startNewConversationInProject(nodeObj.remoteWorkDir || '/root/work', nodeObj.localWorkAlias, nodeObj.id);
      });

      document.getElementById('btnInjectManualCmd').addEventListener('click', () => {
        if (!activeTabId || !tabs.has(activeTabId)) return;
        sendTextToActiveTerminal(`${claudeLaunchCommand(tabs.get(activeTabId), { forShell: true })}\r`);
      });

      document.getElementById('btnCopyManualCmd').addEventListener('click', () => {
        if (!activeTabId || !tabs.has(activeTabId)) return;
        const cmd = claudeLaunchCommand(tabs.get(activeTabId));
        navigator.clipboard.writeText(cmd).then(() => showToast(`已复制：${cmd}`), () => showToast('复制失败'));
      });

      function populateNewProjectNodeSelect(preferredNodeId) {
        const sel = document.getElementById('newProjectNodeSelect');
        if (!sel) return;
        sel.innerHTML = '';
        for (const n of nodesData) {
          const opt = document.createElement('option');
          opt.value = n.id;
          opt.textContent = `${n.badge} · ${n.name} (${n.sshHost || '本地待绑定'} ↔ ~/.takt-ai/${n.localWorkAlias})`;
          if (n.id === preferredNodeId) opt.selected = true;
          sel.appendChild(opt);
        }
      }

      function openRenameSessionModal(sessionId, currentTitle, nodeId = currentFilesNodeId) {
        modalMode = 'rename-session';
        renamingSessionId = sessionId;
        renamingSessionNodeId = nodeId || currentFilesNodeId;
        document.getElementById('newProjectNodeRow').style.display = 'none';
        document.getElementById('modalTitleText').textContent = '重命名对话 (Session)';
        document.getElementById('btnSubmitModal').textContent = '保存名称';
        const inp = document.getElementById('newProjectNameInput');
        inp.placeholder = '输入新的会话名称...';
        inp.value = currentTitle || '';
        newProjectDialog.showModal();
        syncNativeTerminalGeometry();
        setTimeout(() => inp.select(), 20);
      }

      document.getElementById('btnNewProject').addEventListener('click', () => {
        modalMode = 'project';
        const defaultNodeId = selectedNodeFilter !== 'all' ? selectedNodeFilter : currentFilesNodeId;
        populateNewProjectNodeSelect(defaultNodeId);
        document.getElementById('newProjectNodeRow').style.display = 'flex';
        document.getElementById('modalTitleText').textContent = '新建项目文件夹 (指定 Linux 机器 & 本地 work)';
        document.getElementById('btnSubmitModal').textContent = '创建';
        document.getElementById('newProjectNameInput').placeholder = '例如: ESP32_Audio_Board';
        document.getElementById('newProjectNameInput').value = '';
        newProjectDialog.showModal();
        syncNativeTerminalGeometry();
      });

      document.getElementById('btnNewSubfolder').addEventListener('click', () => {
        modalMode = 'subfolder';
        document.getElementById('newProjectNodeRow').style.display = 'none';
        const nodeObj = getNodeInfo(currentFilesNodeId);
        document.getElementById('modalTitleText').textContent = `在 [${nodeObj.badge}] ${currentFilesCwd.split('/').pop()} 下新建子目录`;
        document.getElementById('btnSubmitModal').textContent = '创建';
        document.getElementById('newProjectNameInput').placeholder = '例如: firmware_v2';
        document.getElementById('newProjectNameInput').value = '';
        newProjectDialog.showModal();
        syncNativeTerminalGeometry();
      });

      document.getElementById('btnCancelNewProject').addEventListener('click', () => {
        newProjectDialog.close();
      });

      document.getElementById('newProjectForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('newProjectNameInput').value.trim();
        if (!name) return;

        if (modalMode === 'rename-session') {
          const res = await fetch('/api/sessions/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: renamingSessionId, title: name, nodeId: renamingSessionNodeId }),
          });
          const data = await res.json();
          newProjectDialog.close();
          if (data.ok) {
            if (tabs.has(sessionTabId(renamingSessionId, renamingSessionNodeId))) {
              tabs.get(sessionTabId(renamingSessionId, renamingSessionNodeId)).title = name;
              renderTabBar();
            }
            showToast(`会话已重命名为: ${name}`);
            await loadProjectTree();
          }
          return;
        }

        if (modalMode === 'subfolder') {
          const res = await fetch('/api/files/mkdir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name,
              parentDirPath: currentFilesCwd,
              cwd: currentFilesCwd,
              nodeId: currentFilesNodeId,
            }),
          });
          const data = await res.json();
          newProjectDialog.close();
          if (data.ok) {
            showToast(`已创建子目录: ${name}`);
            await loadSessionFiles(currentFilesCwd, currentFilesNodeId);
          }
          return;
        }

        const selectedNodeId = document.getElementById('newProjectNodeSelect').value || currentFilesNodeId;
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, nodeId: selectedNodeId }),
        });
        const data = await res.json();
        newProjectDialog.close();
        if (data.ok) {
          const targetNode = getNodeInfo(data.nodeId || selectedNodeId);
          visibleProjectKeys.add(`${targetNode.id}::${data.path}`);
          await loadProjectTree();
          startNewConversationInProject(data.path, data.name, targetNode.id);
        }
      });

      // --- Multi-Linux Node Manager Modal Logic ---
      let editingNodeId = 'linux-work2';

      function fillNodeEditorForm(node) {
        editingNodeId = node.id || '';
        const alias = node.localWorkAlias || node.workFolderName || 'work2';
        document.getElementById('nodeInputId').value = node.id || '';
        document.getElementById('nodeInputName').value = node.name || '';
        document.getElementById('nodeInputBadge').value = node.badge || '';
        document.getElementById('nodeInputSshHost').value = node.sshHost || '';
        document.getElementById('nodeInputAlias').value = alias;
        document.getElementById('nodeInputRemoteDir').value = node.remoteWorkDir || '/root/work';
        document.getElementById('nodeInputEnabled').checked = node.enabled !== false;
        document.getElementById('nodeEditSectionTitle').textContent = node.id
          ? `配置节点: ${node.badge} · ${node.name} (${alias})`
          : '新增 Linux 节点与本地 Work 目录';
      }

      function renderNodeManagerModalContent() {
        const listEl = document.getElementById('nodeManagerList');
        listEl.innerHTML = '';

        for (const n of nodesData) {
          const alias = n.localWorkAlias || 'work';
          const card = document.createElement('div');
          const isEditing = n.id === editingNodeId;
          const isOnline = n.enabled !== false && Boolean(n.sshHost);
          card.className = `node-card ${isEditing ? 'active' : ''}`;
          card.innerHTML = `
            <div class="node-card-info">
              <div class="node-card-title">
                <span class="status-dot ${isOnline ? 'ok' : 'warn'}"></span>
                <span class="machine-badge">${escapeHtml(n.badge)} · ${escapeHtml(alias)}</span>
                <span>${escapeHtml(n.name)}</span>
              </div>
              <div class="node-card-meta">
                SSH: ${escapeHtml(n.sshHost || '未绑定 (仅 Mac 本地目录已就绪)')} · 本地: ~/.takt-ai/${escapeHtml(alias)} · Syncthing: ${escapeHtml(n.syncthingFolderId)}
              </div>
            </div>
            <div style="display:flex; gap:6px; align-items:center;">
              <button type="button" class="btn btn-edit-node" style="height:22px; font-size:11px;">编辑 / 绑定</button>
            </div>
          `;
          card.addEventListener('click', () => {
            fillNodeEditorForm(n);
            renderNodeManagerModalContent();
          });
          listEl.appendChild(card);
        }

        const chipsEl = document.getElementById('sshCandidateChips');
        chipsEl.innerHTML = '';
        if (sshCandidatesData.length > 0) {
          const hint = document.createElement('span');
          hint.style.cssText = 'font-size:10px; color:var(--text-muted); display:inline-flex; align-items:center;';
          hint.textContent = '检测到 ~/.ssh/config 主机 (点击填入):';
          chipsEl.appendChild(hint);

          for (const h of sshCandidatesData) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'ssh-chip';
            chip.textContent = `${h.alias}${h.hostName ? ' (' + h.hostName + ')' : ''}`;
            chip.addEventListener('click', () => {
              document.getElementById('nodeInputSshHost').value = h.alias;
              document.getElementById('nodeInputEnabled').checked = true;
              const nameInp = document.getElementById('nodeInputName');
              if (!nameInp.value || nameInp.value.includes('节点 2')) {
                nameInp.value = `${h.alias} Server`;
              }
            });
            chipsEl.appendChild(chip);
          }
        }
      }

      async function openNodeManagerModal(preferredNodeId) {
        try {
          const res = await fetch('/api/nodes');
          const data = await res.json();
          if (data.ok) {
            nodesData = data.nodes || nodesData;
            sshCandidatesData = data.sshCandidates || [];
          }
        } catch {}

        const targetNode =
          nodesData.find((n) => n.id === preferredNodeId) ||
          nodesData.find((n) => n.id === 'linux-work2') ||
          nodesData[0];

        if (targetNode) {
          fillNodeEditorForm(targetNode);
        }
        renderNodeManagerModalContent();
        nodeManagerDialog.showModal();
        syncNativeTerminalGeometry();
      }

      document.getElementById('btnOpenNodeManager').addEventListener('click', () => {
        openNodeManagerModal('linux-work2');
      });

      document.getElementById('btnResetNewNodeForm').addEventListener('click', () => {
        const nextIdx = nodesData.length + 1;
        fillNodeEditorForm({
          id: `linux-work${nextIdx}`,
          name: `Linux 节点 ${nextIdx}`,
          badge: `LX-${nextIdx}`,
          sshHost: '',
          localWorkAlias: `work${nextIdx}`,
          remoteWorkDir: '/root/work',
          syncthingFolderId: `takt-work${nextIdx}`,
          enabled: true,
        });
        renderNodeManagerModalContent();
      });

      document.getElementById('btnCloseNodeManager').addEventListener('click', () => {
        nodeManagerDialog.close();
      });

      document.getElementById('nodeManagerForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('btnSaveNodeConfig');
        const origText = btn.textContent;
        btn.textContent = '正在配置隧道 & Syncthing...';
        btn.disabled = true;

        try {
          const localWorkAlias = document.getElementById('nodeInputAlias').value.trim();
          const sshHost = document.getElementById('nodeInputSshHost').value.trim();
          const enabledChecked = document.getElementById('nodeInputEnabled').checked;
          const payload = {
            id: document.getElementById('nodeInputId').value.trim() || `linux-${localWorkAlias}`,
            name: document.getElementById('nodeInputName').value.trim(),
            badge: document.getElementById('nodeInputBadge').value.trim().toUpperCase(),
            sshHost,
            localWorkAlias,
            remoteWorkDir: document.getElementById('nodeInputRemoteDir').value.trim() || '/root/work',
            syncthingFolderId: `takt-${localWorkAlias}`,
            enabled: Boolean(sshHost) && enabledChecked,
            provisionNow: true,
          };

          const res = await fetch('/api/nodes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const data = await res.json();
          if (data.ok) {
            nodesData = data.nodes || nodesData;
            editingNodeId = data.node.id;
            renderNodeManagerModalContent();
            renderNodeFilterBar();
            await loadProjectTree();
            if (data.logs && data.logs.length > 0) {
              showToast(`已保存 ${data.node.badge} · ${data.node.localWorkAlias}: ${data.logs.join(' / ')}`);
            } else {
              showToast(`已保存节点 ${data.node.badge} · 本地目录 ~/.takt-ai/${data.node.localWorkAlias} 已就绪`);
            }
            nodeManagerDialog.close();
          } else {
            showToast(data.error || '保存节点失败');
          }
        } catch (err) {
          showToast(`保存失败: ${err.message}`);
        } finally {
          btn.textContent = origText;
          btn.disabled = false;
        }
      });

      document.getElementById('btnHealLinks').addEventListener('click', async () => {
        const btn = document.getElementById('btnHealLinks');
        const txt = document.getElementById('healBtnText');
        if (btn.disabled) return;
        btn.disabled = true;
        txt.textContent = '自愈重连中...';
        if (window.webkit?.messageHandlers?.taktNative) {
          try {
            window.webkit.messageHandlers.taktNative.postMessage({ action: 'ensureServices' });
          } catch {}
        }
        try {
          const res = await fetch('/api/heal', { method: 'POST', signal: AbortSignal.timeout(20000) });
          const st = res.ok ? await res.json() : null;
          await pollStatusBar();
          if (st && st.mcp && st.mcp.ok) {
            const hosts = (st.mcp.healthyHosts && st.mcp.healthyHosts.length)
              ? st.mcp.healthyHosts.join(', ')
              : (st.ssh?.host || '全节点');
            showToast(`✅ 隧道自愈成功：${hosts} (MCP ${st.mcp.tools || 23} tools 握手通过)`);
          } else {
            const failed = (st?.mcp?.failedHosts && st.mcp.failedHosts.length)
              ? st.mcp.failedHosts.join(', ')
              : '远端节点';
            showToast(`⚠️ 隧道自愈未完全恢复 (${failed} MCP 仍未连通)，后台将继续重试`);
          }
        } catch (err) {
          await pollStatusBar();
          showToast(`⚠️ 自愈请求超时或本地服务正在重启: ${err.message || '请稍候再试'}`);
        } finally {
          txt.textContent = '隧道自愈';
          btn.disabled = false;
        }
      });

      // ============================================================================
      // 11. Instabox Remote Desktop Plugin (noVNC / Xvnc :1 / Takeover & Dock)
      // ============================================================================
      let rdCurrentUrl = 'http://127.0.0.1:16080/vnc.html?autoconnect=true&resize=scale&reconnect=true&reconnect_delay=1000';
      let rdCurrentVncUrl = 'vnc://:instabox@127.0.0.1:15901';
      let rdControlMode = 'agent';

      async function callRemoteDesktopApi(action, nodeId = '') {
        try {
          const res = await fetch('/api/remote-desktop', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, nodeId }),
          });
          return await res.json();
        } catch (error) { return { ok: false, error: error.message }; }
      }

      function updateRdControlBadge(mode) {
        rdControlMode = (mode === 'human' || mode === 'user') ? 'user' : 'agent';
        const badge = document.getElementById('rdControlBadge') || document.getElementById('rdControlModeBadge');
        const btn = document.getElementById('btnRdToggleControl');
        if (!badge || !btn) return;
        if (rdControlMode === 'user') {
          badge.textContent = '控制权: 人工接管 (User Control)';
          badge.style.color = '#f4f4f5';
          badge.style.background = 'rgba(255,255,255,0.08)';
          badge.style.borderColor = 'rgba(255,255,255,0.22)';
          btn.textContent = '交还给 Agent (Handback)';
        } else {
          badge.textContent = '控制权: Agent (Claude)';
          badge.style.color = '#a1a1aa';
          badge.style.background = 'rgba(255,255,255,0.04)';
          badge.style.borderColor = 'rgba(255,255,255,0.12)';
          btn.textContent = '接管鼠标键盘 (Takeover)';
        }
      }

      async function ensureInstaboxDesktopReady() {
        const statusBadge = document.getElementById('rdStatusBadge');
        if (statusBadge) statusBadge.textContent = '连接 SSH 隧道中...';
        const data = await callRemoteDesktopApi('start', '');
        if (data && data.ok) {
          if (data.webUrl || data.url) rdCurrentUrl = data.webUrl || data.url;
          if (data.vncUrl) rdCurrentVncUrl = data.vncUrl;
          updateRdControlBadge(data.controller || data.controlMode || 'agent');
          if (statusBadge) {
            statusBadge.textContent = `ONLINE · ${data.sshHost || '远程节点'} (127.0.0.1:${data.webPort || 16080})`;
            statusBadge.style.color = '#f4f4f5';
          }
          return true;
        } else {
          if (statusBadge) {
            statusBadge.textContent = '连接异常 (尝试直连 16080)';
            statusBadge.style.color = '#a1a1aa';
          }
          return false;
        }
      }

      async function openRemoteDesktopModal() {
        remoteDesktopDialog.showModal();
        syncNativeTerminalGeometry();
        await ensureInstaboxDesktopReady();
        const iframe = document.getElementById('rdIframe') || document.getElementById('remoteDesktopIframe');
        if (iframe && (!iframe.src || iframe.src === 'about:blank' || iframe.src.endsWith('about:blank'))) {
          iframe.src = rdCurrentUrl;
        }
      }

      async function dockRemoteDesktopToPreview() {
        if (remoteDesktopDialog.open) {
          remoteDesktopDialog.close();
        }
        syncNativeTerminalGeometry();
        if (panelRight.classList.contains('collapsed')) {
          panelRight.classList.remove('collapsed');
          resizerRight.classList.remove('hidden');
        }
        if (previewPane && previewPane.classList.contains('collapsed')) {
          previewPane.classList.remove('collapsed');
        }
        syncNativeTerminalGeometry();
        showToast('正在将东京节点远程桌面嵌入右侧预览栏...');
        await ensureInstaboxDesktopReady();
        document.getElementById('previewTitle').textContent = '远程桌面 (VNC :1)';
        const body = document.getElementById('previewBody');
        body.innerHTML = `
          <div style="position:absolute; inset:0; display:flex; flex-direction:column; width:100%; height:100%; background:#050608;">
            <div style="display:flex; align-items:center; justify-content:space-between; padding:6px 10px; background:#0d1017; border-bottom:1px solid var(--border); gap:6px; flex-wrap:wrap;">
              <div style="display:flex; align-items:center; gap:6px;">
                <button class="btn" id="btnDockRdTakeover" style="height:22px; font-size:11px; padding:0 8px;">${rdControlMode === 'user' ? '交还 Agent' : '接管鼠键'}</button>
                <button class="btn" id="btnDockRdBrowser" style="height:22px; font-size:11px; padding:0 8px;">启动 Chrome</button>
              </div>
              <div style="display:flex; align-items:center; gap:6px;">
                <button class="btn" id="btnDockRdFullscreen" style="height:22px; font-size:11px; padding:0 8px;">弹窗全屏</button>
                <button class="btn" id="btnDockRdNativeVnc" style="height:22px; font-size:11px; padding:0 8px;">macOS 屏幕共享</button>
              </div>
            </div>
            <iframe src="${rdCurrentUrl}" style="flex:1; width:100%; height:100%; border:none; background:#050608;" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
          </div>
        `;
        const btnTakeover = document.getElementById('btnDockRdTakeover');
        if (btnTakeover) {
          btnTakeover.addEventListener('click', async () => {
            const nextAction = rdControlMode === 'user' ? 'handback' : 'takeover';
            const res = await callRemoteDesktopApi(nextAction, '');
            if (res && res.ok) {
              updateRdControlBadge(res.controller || res.controlMode);
              btnTakeover.textContent = rdControlMode === 'user' ? '交还 Agent' : '接管鼠键';
              showToast(rdControlMode === 'user' ? '已切换为人工接管模式' : '已将桌面控制权交还给 Claude Agent');
            }
          });
        }
        const btnBrowser = document.getElementById('btnDockRdBrowser');
        if (btnBrowser) {
          btnBrowser.addEventListener('click', async () => {
            await callRemoteDesktopApi('open-browser', '');
            showToast('已在东京远程桌面启动 Chrome 浏览器');
          });
        }
        const btnFs = document.getElementById('btnDockRdFullscreen');
        if (btnFs) {
          btnFs.addEventListener('click', () => openRemoteDesktopModal());
        }
        const btnVnc = document.getElementById('btnDockRdNativeVnc');
        if (btnVnc) {
          btnVnc.addEventListener('click', async () => {
            await callRemoteDesktopApi('open-native-vnc', '');
            showToast(`已唤起 macOS 原生屏幕共享 (${rdCurrentVncUrl})`);
          });
        }
      }

      document.getElementById('btnDockRemoteDesktop').addEventListener('click', () => {
        dockRemoteDesktopToPreview();
      });

      document.getElementById('btnRdToggleControl').addEventListener('click', async () => {
        const nextAction = rdControlMode === 'user' ? 'handback' : 'takeover';
        const res = await callRemoteDesktopApi(nextAction, '');
        if (res && res.ok) {
          updateRdControlBadge(res.controller || res.controlMode);
          showToast(rdControlMode === 'user'
            ? '已切换为【人工接管】模式：您可直接在桌面中登录账号或完成验证码'
            : '已切换为【Agent 控制】模式：Claude 可继续自动化操作');
        }
      });

      document.getElementById('btnRdLaunchBrowser').addEventListener('click', async () => {
        const res = await callRemoteDesktopApi('open-browser', '');
        if (res && res.ok) {
          showToast('已在东京桌面 (:1) 启动 Chrome 浏览器');
        }
      });

      document.getElementById('btnRdDockRight').addEventListener('click', () => {
        dockRemoteDesktopToPreview();
      });

      document.getElementById('btnRdNativeVnc').addEventListener('click', async () => {
        await callRemoteDesktopApi('open-native-vnc', '');
        showToast(`已唤起 macOS 原生屏幕共享 (${rdCurrentVncUrl})`);
      });

      document.getElementById('btnRdPopWindow').addEventListener('click', () => {
        window.open(rdCurrentUrl, '_blank', 'noopener,noreferrer');
      });

      document.getElementById('btnRdReload').addEventListener('click', async () => {
        await ensureInstaboxDesktopReady();
        const iframe = document.getElementById('rdIframe') || document.getElementById('remoteDesktopIframe');
        if (iframe) {
          iframe.src = `${rdCurrentUrl}&_t=${Date.now()}`;
        }
        showToast('已重连 Instabox 远程桌面隧道');
      });

      document.getElementById('btnRdClose').addEventListener('click', () => {
        remoteDesktopDialog.close();
      });

      // ============================================================================
      // 12. DockTerm — conversation view of the Claude session in the active tab
      //
      //  * /api/chat-view returns deltas (epoch + ver); each tab keeps its own message
      //    list, so switching tabs renders instantly from memory.
      //  * Messages are rendered once and updated by id — no full re-render per poll,
      //    so selection, scroll position and expanded blocks survive updates.
      //  * Scrolling up stops auto-follow; older history pages in at the top.
      // ============================================================================
      const DOCKTERM_SLASH_COMMANDS = [
        { name: '/clear', desc: '清空当前对话上下文（开始新会话）' },
        { name: '/compact', desc: '压缩对话上下文，节省 Token' },
        { name: '/resume', desc: '恢复历史会话（会切回终端选择）' },
        { name: '/model', desc: '切换模型（会切回终端选择）' },
        { name: '/status', desc: '查看会话与账户状态' },
        { name: '/cost', desc: '查看本次会话的 Token 与费用' },
        { name: '/context', desc: '查看上下文占用' },
        { name: '/diff', desc: '查看未提交的 Git 变更' },
        { name: '/review', desc: '审查当前代码变更' },
        { name: '/init', desc: '为项目生成 / 更新 CLAUDE.md' },
        { name: '/memory', desc: '编辑 CLAUDE.md 记忆' },
        { name: '/permissions', desc: '查看或修改工具权限（会切回终端）' },
        { name: '/mcp', desc: '管理 MCP 服务（会切回终端）' },
        { name: '/doctor', desc: '诊断 Claude Code 环境' },
        { name: '/help', desc: '显示内置命令帮助' },
      ];
      const DOCKTERM_PICKER_SLASH_RE = /^\/(resume|model|permissions|theme|config|mcp|agents|hooks|vim|login|logout|rewind|export)\b/i;

      const dtStage = document.getElementById('docktermChatStage');
      const dtScroll = document.getElementById('docktermScroll');
      const dtMessagesEl = document.getElementById('docktermMessages');
      const dtPendingEl = document.createElement('div');
      dtPendingEl.className = 'reading__messages';
      dtMessagesEl.after(dtPendingEl);
      const dtEmptyEl = document.getElementById('docktermEmpty');
      const dtLiveEl = document.getElementById('docktermLive');
      const dtLiveText = document.getElementById('docktermLiveText');
      const dtLiveTail = document.getElementById('docktermLiveTail');
      const dtAskEl = document.getElementById('docktermAsk');
      const dtJumpBtn = document.getElementById('docktermJumpBtn');
      const dtOlderBtn = document.getElementById('docktermOlderBtn');
      const dtBeginEl = document.getElementById('docktermBegin');
      const dtInput = document.getElementById('docktermComposerInput');
      const dtSlashMenu = document.getElementById('docktermSlashMenu');
      const dtSendBtn = document.getElementById('btnDocktermSend');
      const dtInterruptBtn = document.getElementById('btnDocktermInterrupt');
      const dtStartBtn = document.getElementById('btnDocktermStartClaude');
      const dtStartBtnLabel = document.getElementById('btnDocktermStartClaudeLabel');
      const dtStatusChip = document.getElementById('ctxStatus');
      const dtStatusText = document.getElementById('ctxStatusText');
      const btnViewTerminal = document.getElementById('btnViewTerminal');
      const btnViewChat = document.getElementById('btnViewChat');

      let dtPinned = true; // follow new output while the reader is at the bottom
      let dtUnseen = 0;
      let dtRenderedTabId = null;
      let dtRenderedEpoch = null;
      const dtElById = new Map();
      let dtPollTimer = null;
      let dtPollBusy = false;
      let dtPollAgain = false;
      let dtAskSig = '';
      let dtAskCoreSig = '';
      let dtAskLocalChecks = [];
      let dtLastToggleAt = 0;
      let dtSlashIndex = 0;
      let dtSlashItems = [];
      const dtDrafts = new Map();
      const dtHistory = new Map();
      const dtHistCursor = new Map();
      const DT_PLACEHOLDER = dtInput.placeholder;
      // Attachments are sent as "[附件] <path>" lines. A bare image path on a line of its own makes Claude Code
      // inline the image (clipboard lookup + resize) and throw away the Enter that follows; older messages
      // still have bare paths.
      const DT_ATTACH_LABEL = '[附件] ';
      const DT_PENDING_IDLE_MS = 8000; // a sent message not in the transcript after Claude was idle this long is gone
      const DT_UPLOAD_LINE_RE = /^(?:\[附件\]\s*)?((?:\/|~\/)\S*\/\.takt\/uploads\/\S+)$/;
      const dtAttachEl = document.getElementById('docktermAttachments');
      const dtAttachments = new Map(); // tabId -> [{ id, name, size, isImage, url, file, status, remotePath, error, promise }]
      let dtSubmitting = false;

      function activeChatTab() {
        const t = activeTabId && tabs.has(activeTabId) ? tabs.get(activeTabId) : null;
        return t && t.viewMode === 'chat' ? t : null;
      }

      function ensureChatState(t) {
        if (!t.chat) {
          t.chat = {
            epoch: '',
            ver: 0,
            messages: [],
            byId: new Map(),
            pending: [],
            hasOlder: false,
            loadingOlder: false,
            loaded: false,
            status: 'idle',
            ask: null,
            tail: '',
            claudeRunning: false,
            resolvedSessionId: '',
            jsonlPath: '',
            stale: false,
            model: null, // { model, effort, ts } of the latest reply
            launch: null, // --model / --effort of the running claude process
            modelOverride: null, // what the user just switched to (until a reply confirms it)
            settings: null, // model / effortLevel / modelSettings from the node's settings files
            settingsLoaded: false,
            modelNote: '',
          };
        }
        return t.chat;
      }

      // ---------------------------------------------------------------- input to the remote TUI
      function docktermMoveKeys(delta) {
        if (delta === 0) return '';
        return (delta > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(delta));
      }
      function docktermPickKeys(ask, i) {
        if (!ask || ask.numbered !== false) return String(i + 1);
        return `${docktermMoveKeys(i - (ask.cursorRow || 0))}\r`;
      }
      function docktermSubmitKeys(ask, desiredChecked) {
        if (!ask) return '\r';
        let pos = ask.cursorRow || 0;
        let out = '';
        for (let i = 0; i < ask.options.length; i++) {
          if (!ask.checkable[i]) continue;
          if (Boolean(desiredChecked[i]) !== Boolean(ask.checked[i])) {
            out += `${docktermMoveKeys(i - pos)} `;
            pos = i;
          }
        }
        if (ask.submitIndex !== null && ask.submitIndex !== undefined) {
          out += `${docktermMoveKeys(ask.submitIndex - pos)}\r`;
        } else {
          out += '\r';
        }
        return out;
      }
      function docktermTextKeys(ask, i, text) {
        const clean = String(text || '').replace(/[\r\n]+/g, ' ').trim();
        if (!clean) return '';
        if (!ask || ask.numbered !== false) return `${i + 1}${clean}\r`;
        return `${docktermMoveKeys(i - (ask.cursorRow || 0))}${clean}\r`;
      }

      async function sendDocktermRawInput(tabObj, rawText, submitEnter = false) {
        if (!tabObj) return;
        const text = String(rawText || '');
        // Long or multi-line text goes in as one bracketed paste; Enter follows once Claude Code
        // has ingested it (too early and the Enter becomes part of the paste = never submitted).
        const usePaste = text.includes('\n') || text.length > 400;
        const payload = usePaste ? `\x1b[200~${text}\x1b[201~` : text;
        const enterDelayMs = Math.min(1500, 90 + Math.ceil(text.length / 20));

        // In the conversation view the native SwiftTerm view is hidden; feeding it would also make it
        // the first responder and the composer would stop receiving keystrokes -> go through tmux instead
        if (terminalEngine === 'native' && hasNativeHost && tabObj.viewMode !== 'chat') {
          if (payload) postNativeMessage({ action: 'sendInput', tabId: tabObj.tabId, text: payload });
          if (submitEnter) setTimeout(() => postNativeMessage({ action: 'sendInput', tabId: tabObj.tabId, text: '\r' }), enterDelayMs);
          return { ok: true };
        }
        // An ended local pty (ssh dropped) would swallow the input: go through tmux on the node instead.
        // A submitted paste always goes through the node, which holds Enter back until Claude Code is done pasting.
        if (!(usePaste && submitEnter) && tabObj.ws && tabObj.ws.readyState === WebSocket.OPEN && !tabObj.exited) {
          if (payload) tabObj.ws.send(JSON.stringify({ type: 'input', data: payload }));
          if (submitEnter) {
            setTimeout(() => {
              if (tabObj.ws && tabObj.ws.readyState === WebSocket.OPEN) tabObj.ws.send(JSON.stringify({ type: 'input', data: '\r' }));
            }, enterDelayMs);
          }
          return { ok: true };
        }
        try {
          const res = await fetch('/api/chat-input', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tabId: tabObj.tabId, nodeId: tabObj.nodeId, sshHost: tabObj.sshHost, text: payload, submitEnter, enterDelayMs }),
          });
          return await res.json();
        } catch {
          return { ok: false };
        }
      }

      function sendDocktermInterrupt() {
        const t = activeChatTab() || (activeTabId && tabs.get(activeTabId));
        if (!t) return;
        sendDocktermRawInput(t, '\x1b', false);
        showToast('已发送 Esc 中断');
        kickDocktermPoll(300);
      }

      // ---------------------------------------------------------------- markdown
      const MD_LIST_RE = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/;
      const MD_FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
      const MD_TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

      // ---------------------------------------------------------------- files & images in messages
      // Paths in the conversation become links: click previews on the right (from the Mac's disk),
      // ⌘-click opens with the Mac app, ⌥-click reveals in Finder. Images also get thumbnails.
      const DT_FILE_EXTS = 'py|js|mjs|cjs|ts|tsx|jsx|md|markdown|json|jsonl|ya?ml|toml|sh|bash|zsh|html?|css|scss|less|swift|rs|go|c|cc|cpp|h|hpp|m|mm|java|kt|rb|php|lua|vue|svelte|txt|log|ini|cfg|conf|env|sql|lock|xml|csv|ipynb|png|jpe?g|gif|webp|svg|bmp|ico|pdf|glb|gltf|stl|obj|fbx|3mf|ply|usdz|step|stp|iges|igs|fcstd|blend|dxf|dwg|epro2?|kicad_pcb|kicad_sch|kicad_pro|bin|hex|elf|uf2|docx?|xlsx?|pptx?|key|pages|numbers|mp4|mov|webm|mp3|wav|m4a|zip|tgz|gz';
      const DT_SEG = '[\\w.@+\\-\\u4e00-\\u9fa5]';
      const DT_LINE_SUFFIX = '(?::\\d+(?::\\d+)?)?';
      const DT_REL_FILE_RE = new RegExp(`^${DT_SEG}+(?:\\/${DT_SEG}+)*\\.(?:${DT_FILE_EXTS})${DT_LINE_SUFFIX}$`, 'i');
      const DT_ABS_FILE_RE = new RegExp(`^(?:~|\\.{1,2})?(?:\\/${DT_SEG}+)+\\.[a-zA-Z0-9_]{1,10}${DT_LINE_SUFFIX}$`);
      // Paths in running text need a directory part ("a/b.png", "/x/y.py:12") to avoid false hits
      const DT_BARE_PATH_RE = new RegExp(`(^|[\\s(（\\[「“'：:，,;*])((?:~|\\.{1,2})?\\/?(?:${DT_SEG}+\\/)+[\\w@+\\-\\u4e00-\\u9fa5]${DT_SEG}*\\.(?:${DT_FILE_EXTS})${DT_LINE_SUFFIX})(?=$|[\\s)）\\]」”'，。、,;；:：!?！？*&])`, 'gi');
      const DT_IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp)$/i;
      let mdImageSink = null; // collects image paths while one message renders (gallery below it)

      function dtUnescape(s) {
        return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      }
      function dtStripLine(p) {
        return p.replace(/(?::\d+){1,2}$/, '');
      }
      function dtFileLinkHtml(rawPath, labelHtml) {
        const clean = dtStripLine(rawPath);
        if (mdImageSink && DT_IMAGE_EXT_RE.test(clean)) mdImageSink.push(clean);
        return `<a href="#" class="md-file-link" data-file-path="${escapeHtml(rawPath)}" title="${escapeHtml(clean)}\n点击预览 · ⌘点击用 Mac 应用打开 · ⌥点击在 Finder 中显示">${labelHtml}</a>`;
      }
      function dtThumbHtml({ path: p, ref, name }) {
        const attr = p ? `data-thumb-path="${escapeHtml(p)}"` : `data-thumb-ref="${escapeHtml(ref)}"`;
        return `<button type="button" class="reading__thumb is-loading" ${attr} title="${escapeHtml(name || p || '图片')}"><img alt="${escapeHtml(name || '')}" loading="lazy" data-src-pending="1"><span class="reading__thumb-name">${escapeHtml(name || '')}</span></button>`;
      }
      function dtLinkifyBarePaths(escaped) {
        return escaped.replace(DT_BARE_PATH_RE, (m, pre, p) => `${pre}${dtFileLinkHtml(dtUnescape(p), p)}`);
      }

      function mdInline(raw) {
        const tokens = [];
        const stash = (html) => `\x00${tokens.push(html) - 1}\x00`;
        let s = escapeHtml(raw);
        // code spans (file paths become preview links)
        s = s.replace(/`([^`\n]+)`/g, (_, code) => {
          const rawCode = dtUnescape(code);
          if (DT_ABS_FILE_RE.test(rawCode) || DT_REL_FILE_RE.test(rawCode)) return stash(dtFileLinkHtml(rawCode, code));
          return stash(`<code class="md-inline-code">${code}</code>`);
        });
        // ![alt](local/image.png) — local images render inline; remote ones stay links
        s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (m, alt, src) => {
          const p = dtUnescape(src);
          if (/^https?:\/\//i.test(p)) return stash(`<a class="md-link" href="${src}" target="_blank" rel="noopener noreferrer">${alt || src}</a>`);
          if (!DT_IMAGE_EXT_RE.test(p)) return m;
          return stash(`<span class="reading__images md-img">${dtThumbHtml({ path: p, name: dtUnescape(alt) || p.split('/').pop() })}</span>`);
        });
        // [text](url) and [text](path/to/file)
        s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
          if (/^https?:\/\//i.test(url)) return stash(`<a class="md-link" href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
          const p = dtUnescape(url).replace(/^file:\/\//, '');
          if (DT_ABS_FILE_RE.test(p) || DT_REL_FILE_RE.test(p)) return stash(dtFileLinkHtml(p, label));
          return m;
        });
        // bare URLs
        s = s.replace(/\bhttps?:\/\/[^\s<\x00]+[^\s<\x00.,;:!?)\]'"]/g, (url) => stash(`<a class="md-link" href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`));
        // bare file paths
        s = s.replace(DT_BARE_PATH_RE, (m, pre, p) => `${pre}${stash(dtFileLinkHtml(dtUnescape(p), p))}`);
        s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/(^|[\s(（])\*([^*\s][^*\n]*?)\*(?=[\s.,!?:;)）。，]|$)/g, '$1<em>$2</em>');
        s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
        return s.replace(/\x00(\d+)\x00/g, (_, i) => tokens[Number(i)]);
      }

      function mdCodeBlock(code, lang) {
        return `<div class="md-code"><div class="md-code-head"><span>${escapeHtml(lang || 'text')}</span><button type="button" class="md-code-copy">复制</button></div><pre><code>${escapeHtml(code)}</code></pre></div>`;
      }

      function mdTable(head, rows) {
        const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => mdInline(c.trim()));
        const h = cells(head);
        return `<div class="md-table-wrap"><table><thead><tr>${h.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      }

      function mdList(lines) {
        const items = [];
        for (const l of lines) {
          const m = l.match(MD_LIST_RE);
          if (m) {
            items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10) || 1, text: m[3] });
          } else if (items.length && l.trim()) {
            items[items.length - 1].text += `\n${l.trim()}`;
          }
        }
        let pos = 0;
        const build = (level) => {
          const first = items[pos];
          let html = first.ordered ? `<ol${first.start > 1 ? ` start="${first.start}"` : ''}>` : '<ul>';
          while (pos < items.length && items[pos].indent >= level) {
            const it = items[pos++];
            let text = it.text;
            let cls = '';
            const task = text.match(/^\[( |x|X)\]\s+/);
            if (task) {
              cls = ' class="task"';
              text = text.slice(task[0].length);
            }
            let inner = (task ? `<span class="task-box">${task[1] === ' ' ? '☐' : '☑'}</span>` : '') + text.split('\n').map(mdInline).join('<br>');
            if (pos < items.length && items[pos].indent > it.indent) inner += build(items[pos].indent);
            html += `<li${cls}>${inner}</li>`;
          }
          return html + (first.ordered ? '</ol>' : '</ul>');
        };
        let out = '';
        while (pos < items.length) out += build(items[pos].indent);
        return out;
      }

      function mdIsBlockStart(line, next) {
        return MD_FENCE_RE.test(line) || /^\s{0,3}#{1,6}\s/.test(line) || /^\s{0,3}>/.test(line) ||
          MD_LIST_RE.test(line) || /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) ||
          (line.includes('|') && next !== undefined && MD_TABLE_SEP_RE.test(next));
      }

      function renderMarkdownBlocks(src) {
        const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
        const out = [];
        let i = 0;
        while (i < lines.length) {
          const line = lines[i];
          let m = line.match(MD_FENCE_RE);
          if (m) {
            const fenceCh = m[2][0];
            const fenceLen = m[2].length;
            const indent = m[1].length;
            const closeRe = new RegExp(`^\\s*\\${fenceCh}{${fenceLen},}\\s*$`);
            const buf = [];
            i++;
            while (i < lines.length && !closeRe.test(lines[i])) {
              buf.push(indent ? lines[i].replace(new RegExp(`^ {0,${indent}}`), '') : lines[i]);
              i++;
            }
            i++;
            out.push(mdCodeBlock(buf.join('\n'), m[3]));
            continue;
          }
          if (!line.trim()) { i++; continue; }
          m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/);
          if (m) {
            out.push(`<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>`);
            i++;
            continue;
          }
          if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
            out.push('<hr>');
            i++;
            continue;
          }
          if (line.includes('|') && i + 1 < lines.length && MD_TABLE_SEP_RE.test(lines[i + 1])) {
            const head = line;
            const rows = [];
            i += 2;
            while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(lines[i++]);
            out.push(mdTable(head, rows));
            continue;
          }
          if (/^\s{0,3}>/.test(line)) {
            const buf = [];
            while (i < lines.length && /^\s{0,3}>/.test(lines[i])) buf.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
            out.push(`<blockquote>${renderMarkdownBlocks(buf.join('\n'))}</blockquote>`);
            continue;
          }
          if (MD_LIST_RE.test(line)) {
            const buf = [];
            while (i < lines.length) {
              const l = lines[i];
              if (MD_LIST_RE.test(l) || (buf.length && /^\s{2,}\S/.test(l) && !MD_FENCE_RE.test(l))) {
                buf.push(l);
                i++;
                continue;
              }
              if (!l.trim() && i + 1 < lines.length && (MD_LIST_RE.test(lines[i + 1]) || /^\s{2,}\S/.test(lines[i + 1]))) {
                i++;
                continue;
              }
              break;
            }
            out.push(mdList(buf));
            continue;
          }
          const buf = [line];
          i++;
          while (i < lines.length && lines[i].trim() && !mdIsBlockStart(lines[i], lines[i + 1])) buf.push(lines[i++]);
          out.push(`<p>${buf.map((l) => mdInline(l.trim())).join('<br>')}</p>`);
        }
        return out.join('');
      }

      function renderDocktermMarkdown(mdText) {
        const sink = [];
        mdImageSink = sink;
        let html;
        try {
          html = renderMarkdownBlocks(mdText);
        } finally {
          mdImageSink = null;
        }
        // Images mentioned in the text get a thumbnail strip (inline ![]() images are already shown)
        const inline = new Set();
        html.replace(/data-thumb-path="([^"]+)"/g, (_, p) => inline.add(dtUnescape(p)));
        const gallery = [...new Set(sink)].filter((p) => !inline.has(p)).slice(0, 8);
        const strip = gallery.length
          ? `<div class="reading__images">${gallery.map((p) => dtThumbHtml({ path: p, name: p.split('/').pop() })).join('')}</div>`
          : '';
        return `<div class="reading__md">${html}</div>${strip}`;
      }

      // ---------------------------------------------------------------- message elements
      function formatClock(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        return d.toLocaleString('zh-CN', { hour12: false });
      }

      function dtChatImageThumbs(images, label) {
        if (!Array.isArray(images) || !images.length) return '';
        return `<div class="reading__images">${images.map((im, i) => dtThumbHtml({
          ref: `${im.off}:${im.idx}:${im.u || ''}`,
          name: images.length > 1 ? `${label} ${i + 1}` : label,
        })).join('')}</div>`;
      }

      function dtRawFileUrl(t, p) {
        return `/api/raw-file?path=${encodeURIComponent(p)}&cwd=${encodeURIComponent((t && t.cwd) || currentFilesCwd)}&nodeId=${encodeURIComponent((t && t.nodeId) || currentFilesNodeId)}`;
      }
      function dtChatImageRef(t, ref) {
        const [off, idx, ...rest] = String(ref || '').split(':');
        return { nodeId: t.nodeId, path: (t.chat && t.chat.jsonlPath) || '', off: Number(off), idx: Number(idx), u: rest.join(':') };
      }
      function dtChatImageUrl(t, ref) {
        const r = dtChatImageRef(t, ref);
        return `/api/chat-image?nodeId=${encodeURIComponent(r.nodeId)}&path=${encodeURIComponent(r.path)}&off=${r.off}&idx=${r.idx}&u=${encodeURIComponent(r.u)}`;
      }

      // Thumbnails get their URL at render time (they depend on the tab's node / cwd / transcript)
      function hydrateDocktermThumbs(root, t) {
        if (!t) return;
        for (const img of root.querySelectorAll('img[data-src-pending]')) {
          const btn = img.closest('.reading__thumb');
          img.removeAttribute('data-src-pending');
          if (!btn) continue;
          img.addEventListener('load', () => {
            btn.classList.remove('is-loading');
            if (dtPinned && !dtStage.hidden) dtScroll.scrollTop = dtScroll.scrollHeight;
          }, { once: true });
          img.addEventListener('error', () => {
            btn.classList.remove('is-loading');
            btn.classList.add('is-broken');
          }, { once: true });
          img.src = btn.dataset.thumbPath ? dtRawFileUrl(t, btn.dataset.thumbPath) : dtChatImageUrl(t, btn.dataset.thumbRef);
        }
      }

      function createDocktermMessageEl(m) {
        const el = document.createElement('div');
        el.dataset.id = m.id;
        el.dataset.seq = String(m.seq);
        if (m.role === 'user') {
          el.className = 'reading__user';
          const split = dtSplitAttachmentLines(m.text || '');
          const text = split.text;
          const long = text.length > 1400 || text.split('\n').length > 18;
          const bubble = text
            ? `<div class="reading__user-bubble${long ? ' is-clamped' : ''}" title="${escapeHtml(formatClock(m.ts))}">${dtLinkifyBarePaths(escapeHtml(text))}</div>${long ? '<button type="button" class="link-btn reading__expand">展开全部</button>' : ''}`
            : '';
          const upImgs = split.files.filter((p) => DT_IMAGE_EXT_RE.test(p));
          const upFiles = split.files.filter((p) => !DT_IMAGE_EXT_RE.test(p));
          const uploads = (upImgs.length ? `<div class="reading__images">${upImgs.map((p) => dtThumbHtml({ path: p, name: dtUploadDisplayName(p) })).join('')}</div>` : '')
            + (upFiles.length ? `<div class="reading__files">${upFiles.map((p) => `<a href="#" class="reading__file md-file-link" data-file-path="${escapeHtml(p)}" title="${escapeHtml(p)}"><b>${escapeHtml(dtExtLabel(p))}</b>${escapeHtml(dtUploadDisplayName(p))}</a>`).join('')}</div>` : '');
          el.innerHTML = `<div class="reading__user-wrap">${dtChatImageThumbs(m.images, '图片')}${uploads}${bubble}</div>`;
        } else if (m.role === 'assistant') {
          el.className = 'reading__assistant';
          if (!m._html) m._html = renderDocktermMarkdown(m.text || '');
          el.innerHTML = m._html;
        } else if (m.role === 'tool' && m.tool) {
          const ok = m.tool.ok;
          el.className = `reading__tool${ok === false ? ' reading__tool--err' : ok === true ? ' reading__tool--ok' : ' reading__tool--pending'}`;
          el.title = `${m.tool.name}${m.tool.path ? `: ${m.tool.path}` : m.tool.summary ? `: ${m.tool.summary}` : ''}`;
          const summary = !m.tool.summary ? ''
            : m.tool.path
              ? `<a href="#" class="reading__tool-summary md-file-link" data-file-path="${escapeHtml(m.tool.path)}" title="${escapeHtml(m.tool.path)}\n点击预览 · ⌘点击用 Mac 应用打开 · ⌥点击在 Finder 中显示">${escapeHtml(m.tool.summary)}</a>`
              : `<span class="reading__tool-summary">${escapeHtml(m.tool.summary)}</span>`;
          el.innerHTML = `
            <span class="reading__tool-icon">${ok === false ? '✕' : ok === true ? '✓' : '●'}</span>
            <span class="reading__tool-name">${escapeHtml(m.tool.name)}</span>
            ${summary}
            ${dtChatImageThumbs(m.tool.images, m.tool.path ? m.tool.path.split('/').pop() : `${m.tool.name} 图片`)}
          `;
        } else {
          el.hidden = true;
        }
        hydrateDocktermThumbs(el, activeChatTab() || tabs.get(dtRenderedTabId));
        return el;
      }

      function insertDocktermElBySeq(el, seq) {
        // Walk back from the end (new messages are almost always appended)
        let ref = dtMessagesEl.lastElementChild;
        while (ref && Number(ref.dataset.seq) > seq) ref = ref.previousElementSibling;
        if (ref) ref.after(el);
        else dtMessagesEl.prepend(el);
      }

      function mergeDocktermMessages(c, incoming) {
        const added = [];
        const updated = [];
        for (const m of incoming) {
          const existing = c.byId.get(m.id);
          if (existing) {
            Object.assign(existing, m);
            existing._html = undefined;
            updated.push(existing);
            continue;
          }
          const msgs = c.messages;
          if (!msgs.length || msgs[msgs.length - 1].seq < m.seq) msgs.push(m);
          else if (msgs[0].seq > m.seq) msgs.unshift(m);
          else {
            let lo = 0;
            let hi = msgs.length;
            while (lo < hi) {
              const mid = (lo + hi) >> 1;
              if (msgs[mid].seq < m.seq) lo = mid + 1;
              else hi = mid;
            }
            msgs.splice(lo, 0, m);
          }
          c.byId.set(m.id, m);
          added.push(m);
        }
        return { added, updated };
      }

      // ---------------------------------------------------------------- rendering
      function scrollDocktermToBottom() {
        dtScroll.scrollTop = dtScroll.scrollHeight;
        dtPinned = true;
        dtUnseen = 0;
        updateDocktermJump();
      }

      function updateDocktermJump() {
        dtJumpBtn.hidden = dtPinned;
        dtJumpBtn.textContent = dtUnseen > 0 ? `↓ ${dtUnseen} 条新消息` : '↓ 回到最新';
      }

      function renderDocktermFull(t) {
        const c = t.chat;
        dtMessagesEl.innerHTML = '';
        dtElById.clear();
        const frag = document.createDocumentFragment();
        for (const m of c.messages) {
          const el = createDocktermMessageEl(m);
          dtElById.set(m.id, el);
          frag.appendChild(el);
        }
        dtMessagesEl.appendChild(frag);
        dtRenderedTabId = t.tabId;
        dtRenderedEpoch = c.epoch;
        dtAskSig = '';
      }

      function renderDocktermPending(t) {
        const c = t.chat;
        dtPendingEl.innerHTML = c.pending.map((p) => {
          const atts = p.atts || [];
          const imgs = atts.filter((a) => a.isImage && a.url);
          const files = atts.filter((a) => !(a.isImage && a.url));
          return `
          <div class="reading__user reading__user--pending${p.failed ? ' reading__user--failed' : ''}">
            <div class="reading__user-wrap">
              ${imgs.length ? `<div class="reading__images">${imgs.map((a) => `<span class="reading__thumb"><img class="is-local" src="${escapeHtml(a.url)}" alt=""></span>`).join('')}</div>` : ''}
              ${files.length ? `<div class="reading__files">${files.map((a) => `<span class="reading__file"><b>${escapeHtml(dtExtLabel(a.name))}</b>${escapeHtml(a.name)}</span>`).join('')}</div>` : ''}
              ${(p.display ?? p.text) ? `<div class="reading__user-bubble">${escapeHtml(p.display ?? p.text)}</div>` : ''}
              <span class="reading__meta">${p.failed ? '没有提交 · Claude Code 停在「Pasting…」，切到终端看看输入框'
                : p.queued ? '排队中 · Claude 完成当前步骤后处理' : '发送中…'}</span>
            </div>
          </div>`;
        }).join('');
      }

      function renderDocktermChrome(t) {
        const c = t.chat;
        const busy = c.status === 'working' || c.status === 'asking';
        dtStage.classList.toggle('is-working', c.status === 'working');
        dtInput.placeholder = c.status === 'working' ? 'Claude 正在执行… 可以继续输入，消息会排队发送'
          : c.status === 'asking' ? 'Claude 在等你确认上面的操作'
            : DT_PLACEHOLDER;

        // load-earlier / beginning marker
        dtOlderBtn.hidden = !(c.hasOlder && c.messages.length > 0);
        dtBeginEl.hidden = !(c.loaded && !c.hasOlder && c.messages.length > 0);

        // empty state
        if (c.messages.length === 0 && c.pending.length === 0 && !busy) {
          let title;
          let body;
          let cta = '';
          if (!c.loaded) {
            title = '正在读取对话记录…';
            body = `${escapeHtml(t.sshHost)}:${escapeHtml(t.cwd)}`;
          } else if (c.stale) {
            title = `暂时连不上 ${escapeHtml(t.sshHost)}`;
            body = '会自动重试。也可以切回终端查看连接情况。';
          } else if (c.claudeRunning) {
            title = 'Claude 已就绪';
            body = '在下方输入消息开始对话。回复、工具调用和权限确认都会显示在这里。';
          } else {
            title = '这个标签页还没有运行 Claude';
            body = '点击下面的按钮在远端 tmux 会话里启动 Claude Code，或按 ⌘E 切回终端手动操作。';
            cta = `<button type="button" class="btn btn-primary" data-dt-action="launch">${c.messages.length ? '恢复 Claude' : '启动 Claude'}</button>`;
          }
          dtEmptyEl.innerHTML = `
            <div class="reading__empty-title">${title}</div>
            <div>${body}</div>
            ${cta}
            ${c.loaded && !c.claudeRunning && c.tail ? `<pre class="reading__live-tail" style="width:100%; text-align:left;">${escapeHtml(c.tail)}</pre>` : ''}
          `;
          dtEmptyEl.hidden = false;
        } else {
          dtEmptyEl.hidden = true;
        }

        // live working card
        if (c.status === 'working') {
          dtLiveEl.hidden = false;
          const spinner = (c.tail || '').split('\n').reverse().find((l) => /…/.test(l) && /^\s*[·✢✳✶✻✽∗*]/.test(l));
          dtLiveText.textContent = spinner ? spinner.replace(/^\s*[·✢✳✶✻✽∗*]\s*/, '') : 'Claude 正在执行…';
          dtLiveTail.textContent = (c.tail || '').split('\n').filter((l) => l !== spinner).join('\n');
        } else {
          dtLiveEl.hidden = true;
        }

        // permission / question card
        if (c.status === 'asking' && c.ask) {
          const sig = JSON.stringify(c.ask);
          if (sig !== dtAskSig || dtAskEl.hidden) {
            buildDocktermAskCard(t, c.ask);
            dtAskSig = sig;
          }
          dtAskEl.hidden = false;
        } else {
          dtAskEl.hidden = true;
          dtAskEl.innerHTML = '';
          dtAskSig = '';
        }

        // context bar status + actions
        if (t.tabId === activeTabId) {
          let cls = '';
          let text;
          if (c.stale) { cls = 'stale'; text = '连接中断 · 显示缓存'; }
          else if (!c.loaded) text = '读取中…';
          else if (c.status === 'working') { cls = 'working'; text = '执行中'; }
          else if (c.status === 'asking') { cls = 'asking'; text = '等待你确认'; }
          else if (c.claudeRunning) { cls = 'ready'; text = 'Claude 就绪'; }
          else if (c.messages.length) text = 'Claude 未运行';
          else text = 'Shell';
          dtStatusChip.hidden = false;
          dtStatusChip.className = `status-chip ${cls}`;
          dtStatusText.textContent = text;
          dtStatusChip.title = c.resolvedSessionId && c.jsonlPath ? `会话 ${c.resolvedSessionId}\n${c.jsonlPath}` : '';
          dtStartBtn.hidden = !c.loaded || c.claudeRunning || c.stale;
          dtStartBtnLabel.textContent = c.messages.length ? '恢复 Claude' : '启动 Claude';
          dtInterruptBtn.hidden = !busy;
        }
      }

      function renderDocktermView(t, { full = false, added = [], updated = [] } = {}) {
        const c = t.chat;
        const wasPinned = dtPinned;
        if (full || dtRenderedTabId !== t.tabId || dtRenderedEpoch !== c.epoch) {
          renderDocktermFull(t);
        } else {
          for (const m of updated) {
            const old = dtElById.get(m.id);
            const el = createDocktermMessageEl(m);
            if (old) old.replaceWith(el);
            else insertDocktermElBySeq(el, m.seq);
            dtElById.set(m.id, el);
          }
          let appended = 0;
          for (const m of added) {
            const el = createDocktermMessageEl(m);
            insertDocktermElBySeq(el, m.seq);
            dtElById.set(m.id, el);
            if (m.role !== 'tool') appended += 1;
          }
          if (!wasPinned && appended) {
            dtUnseen += appended;
            updateDocktermJump();
          }
        }
        renderDocktermPending(t);
        renderDocktermChrome(t);
        if (wasPinned) requestAnimationFrame(scrollDocktermToBottom);
      }

      function buildDocktermAskCard(t, ask) {
        const coreSig = JSON.stringify([ask.title, ask.options]);
        if (coreSig !== dtAskCoreSig) {
          dtAskCoreSig = coreSig;
          dtAskLocalChecks = ask.checked.slice();
        }
        const send = (keys) => {
          if (!keys) return;
          sendDocktermRawInput(t, keys, false);
          kickDocktermPoll(250);
        };
        const optionHtml = (opt, idx, { checkbox = false } = {}) => {
          const desc = ask.descriptions && ask.descriptions[idx] ? `<span class="askcard__desc">${escapeHtml(ask.descriptions[idx])}</span>` : '';
          const isAllow = ask.binary && idx === 0;
          const isDeny = ask.binary && idx === ask.options.length - 1;
          const cls = `${isAllow ? ' askcard__btn--allow' : isDeny ? ' askcard__btn--deny' : ''}${idx === ask.cursorRow ? ' is-cursor' : ''}`;
          const lead = checkbox
            ? `<input type="checkbox" tabindex="-1" ${dtAskLocalChecks[idx] ? 'checked' : ''}>`
            : `<span class="askcard__key">${ask.numbered === false ? '›' : idx + 1}</span>`;
          return `<button type="button" class="askcard__btn${cls}" data-ask-idx="${idx}"${checkbox ? ' data-ask-check="1"' : ''}>${lead}<span class="askcard__label"><b>${escapeHtml(opt)}</b>${desc}</span></button>`;
        };

        const rows = [];
        ask.options.forEach((opt, idx) => {
          if (ask.multiSelect && idx === ask.submitIndex) return;
          if (idx === ask.freeTextIndex) {
            rows.push(`<div class="askcard__free"><input type="text" data-ask-free="${idx}" placeholder="${escapeHtml(opt.replace(/\.$/, ''))}…"><button type="button" class="btn" data-ask-free-send="${idx}">发送</button></div>`);
            return;
          }
          rows.push(optionHtml(opt, idx, { checkbox: ask.multiSelect && ask.checkable[idx] }));
        });
        if (ask.multiSelect) rows.push('<button type="button" class="btn btn-primary" data-ask-submit="1" style="align-self:flex-start;">提交选择</button>');
        rows.push('<button type="button" class="askcard__btn askcard__btn--cancel" data-ask-cancel="1"><span class="askcard__key">Esc</span><span class="askcard__label"><b>取消</b></span></button>');

        dtAskEl.innerHTML = `
          <div class="askcard__head">
            <span class="askcard__dot"></span>
            <span>${ask.binary ? '需要你的许可' : 'Claude 在等你回答'}</span>
            <button type="button" class="btn" data-ask-term="1">在终端中处理</button>
          </div>
          ${ask.steps && ask.steps.length ? `<div class="askcard__steps">${ask.steps.map((st) => `<span class="askcard__step${st.done ? ' done' : ''}">${st.done ? '✓ ' : ''}${escapeHtml(st.label)}</span>`).join('')}</div>` : ''}
          <pre class="askcard__title">${escapeHtml(ask.title)}</pre>
          <div class="askcard__actions">${rows.join('')}</div>
        `;

        dtAskEl.querySelectorAll('[data-ask-idx]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const idx = Number(btn.dataset.askIdx);
            if (btn.dataset.askCheck) {
              dtAskLocalChecks[idx] = !dtAskLocalChecks[idx];
              const cb = btn.querySelector('input[type="checkbox"]');
              if (cb) cb.checked = dtAskLocalChecks[idx];
              return;
            }
            send(docktermPickKeys(ask, idx));
          });
        });
        dtAskEl.querySelectorAll('[data-ask-free]').forEach((inp) => {
          const idx = Number(inp.dataset.askFree);
          const go = () => {
            const v = inp.value.trim();
            if (!v) { inp.focus(); return; }
            send(docktermTextKeys(ask, idx, v));
            inp.value = '';
          };
          inp.addEventListener('keydown', (e) => {
            if (e.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') { e.preventDefault(); go(); }
          });
          const btn = dtAskEl.querySelector(`[data-ask-free-send="${idx}"]`);
          if (btn) btn.addEventListener('click', go);
        });
        const submit = dtAskEl.querySelector('[data-ask-submit]');
        if (submit) submit.addEventListener('click', () => send(docktermSubmitKeys(ask, dtAskLocalChecks)));
        dtAskEl.querySelector('[data-ask-cancel]').addEventListener('click', () => send('\x1b'));
        dtAskEl.querySelector('[data-ask-term]').addEventListener('click', () => toggleDocktermChatMode(t.tabId, 'terminal'));
      }

      // ---------------------------------------------------------------- data flow
      function chatQuery(t, extra = {}) {
        return new URLSearchParams({
          tabId: t.tabId,
          sessionId: t.sessionId || t.tabId,
          cwd: t.cwd || '/root/work',
          nodeId: t.nodeId || '',
          sshHost: t.sshHost || '',
          ...extra,
        }).toString();
      }

      function applyDocktermData(t, data) {
        const c = ensureChatState(t);
        const prevStatus = c.status;
        const prevCmd = claudeLaunchCommand(t);
        let added = [];
        let updated = [];
        let full = false;
        if (data.reset || data.epoch !== c.epoch) {
          c.epoch = data.epoch;
          c.messages = [];
          c.byId = new Map();
          ({ added } = mergeDocktermMessages(c, data.messages || []));
          c.ver = Number(data.ver) || 0;
          full = true;
        } else {
          ({ added, updated } = mergeDocktermMessages(c, data.messages || []));
          c.ver = Math.max(c.ver, Number(data.ver) || 0);
        }
        c.hasOlder = Boolean(data.hasOlder);
        c.status = data.status || 'idle';
        c.ask = data.ask || null;
        c.tail = data.tail || '';
        c.claudeRunning = Boolean(data.claudeRunning);
        c.resolvedSessionId = data.resolvedSessionId || '';
        c.jsonlPath = data.jsonlPath || '';
        c.stale = Boolean(data.stale);
        c.loaded = true;
        c.model = data.model || null;
        c.launch = data.launch || null;
        c.claudeCwd = data.claudeCwd || '';
        if (c.modelOverride && c.model && c.model.ts > c.modelOverride.at) c.modelOverride = null;

        // Optimistic bubbles disappear once the transcript has the real message (a message typed while
        // Claude works shows up when Claude picks it up mid-turn, as a queued_command record)
        const now = Date.now();
        if (c.status === 'working' || c.status === 'asking') c.lastBusyAt = now;
        if (c.pending.length) {
          const newUsers = added.filter((m) => m.role === 'user');
          const norm = (x) => String(x || '').replace(/\s+/g, ' ').trim();
          for (const u of newUsers) {
            const i = c.pending.findIndex((p) => norm(p.text) === norm(u.text) || (u.ts && u.ts >= p.at - 3000));
            if (i >= 0) c.pending.splice(i, 1);
          }
          // Claude takes queued messages as soon as it is idle: one that is still missing from the transcript
          // after Claude has been idle for a while never arrived (or is still sitting in Claude's input box)
          let lost = 0;
          c.pending = c.pending.filter((p) => {
            if (p.failed) return now - p.failedAt < 120000;
            if (p.inflight) return true; // the node is still waiting for Claude Code to finish the paste
            if (!c.stale && now - Math.max(p.sentAt || p.at, c.lastBusyAt || 0) > DT_PENDING_IDLE_MS) {
              if (c.claudeRunning) lost += 1;
              return false;
            }
            return now - p.at < (p.queued ? 15 * 60000 : 60000);
          });
          if (lost && activeChatTab() === t) showToast(lost === 1 ? '有一条消息没有出现在对话记录里，可能还停在 Claude 的输入框（切到终端看看）'
            : `有 ${lost} 条消息没有出现在对话记录里，可能还停在 Claude 的输入框（切到终端看看）`, 6000);
        }
        // Once Claude has written this tab's own session, later launches must resume it
        if (c.jsonlPath && c.resolvedSessionId === t.sessionId) t.resume = true;

        if (activeChatTab() === t) {
          renderDocktermView(t, { full, added, updated });
          renderDocktermModelBar(t);
        }
        if (prevStatus !== c.status) renderTabBar();
        if (prevCmd !== claudeLaunchCommand(t) && t.tabId === activeTabId) renderContextBar();
      }

      async function pollDockterm() {
        const t = activeChatTab();
        if (!t) return;
        if (dtPollBusy) {
          dtPollAgain = true;
          return;
        }
        dtPollBusy = true;
        clearTimeout(dtPollTimer);
        const c = ensureChatState(t);
        try {
          const res = await fetch(`/api/chat-view?${chatQuery(t, { epoch: c.epoch, ver: String(c.ver) })}`, { cache: 'no-store' });
          const data = await res.json();
          if (data && data.ok && tabs.has(t.tabId)) applyDocktermData(t, data);
        } catch {
          c.stale = true;
          if (activeChatTab() === t) renderDocktermChrome(t);
        } finally {
          dtPollBusy = false;
          if (dtPollAgain) {
            dtPollAgain = false;
            kickDocktermPoll(0);
          } else {
            scheduleDocktermPoll();
          }
        }
      }

      function scheduleDocktermPoll(delay) {
        clearTimeout(dtPollTimer);
        const t = activeChatTab();
        if (!t) return;
        const c = t.chat;
        const busy = c && (c.status === 'working' || c.status === 'asking' || c.pending.length > 0);
        const d = delay !== undefined ? delay
          : document.hidden ? 8000
          : busy ? 1000
          : c && c.stale ? 4000
          : 2000;
        dtPollTimer = setTimeout(pollDockterm, d);
      }

      function kickDocktermPoll(ms = 0) {
        if (dtPollBusy) {
          dtPollAgain = true;
          return;
        }
        scheduleDocktermPoll(ms);
      }

      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) kickDocktermPoll(0);
      });

      async function loadOlderDockterm() {
        const t = activeChatTab();
        if (!t || !t.chat) return;
        const c = t.chat;
        if (c.loadingOlder || !c.hasOlder) return;
        c.loadingOlder = true;
        dtOlderBtn.disabled = true;
        dtOlderBtn.textContent = '加载中…';
        try {
          const res = await fetch(`/api/chat-history?${chatQuery(t, { epoch: c.epoch })}`, { cache: 'no-store' });
          const data = await res.json();
          if (data && data.ok && data.epoch === c.epoch) {
            const { added } = mergeDocktermMessages(c, data.messages || []);
            c.hasOlder = Boolean(data.hasOlder);
            if (activeChatTab() === t && dtRenderedTabId === t.tabId && added.length) {
              // keep the reader's position while content grows above them
              const prevHeight = dtScroll.scrollHeight;
              const prevTop = dtScroll.scrollTop;
              const frag = document.createDocumentFragment();
              for (const m of added.sort((a, b) => a.seq - b.seq)) {
                const el = createDocktermMessageEl(m);
                dtElById.set(m.id, el);
                frag.appendChild(el);
              }
              dtMessagesEl.prepend(frag);
              dtScroll.scrollTop = prevTop + (dtScroll.scrollHeight - prevHeight);
            }
          } else if (data && data.error === 'epoch-mismatch') {
            kickDocktermPoll(0);
          } else if (data && data.error) {
            showToast(data.error);
          }
        } catch {
          showToast('加载更早的消息失败');
        } finally {
          c.loadingOlder = false;
          dtOlderBtn.disabled = false;
          dtOlderBtn.textContent = '加载更早的消息';
          if (activeChatTab() === t) renderDocktermChrome(t);
        }
      }

      // ---------------------------------------------------------------- view switching
      function syncDocktermViewUI() {
        const t = activeTabId && tabs.has(activeTabId) ? tabs.get(activeTabId) : null;
        const inChat = Boolean(t && t.viewMode === 'chat');
        dtStage.hidden = !inChat;
        btnViewTerminal.classList.toggle('active', !inChat);
        btnViewChat.classList.toggle('active', inChat);
        btnViewTerminal.disabled = !t;
        btnViewChat.disabled = !t;
        syncNativeTerminalGeometry();
        renderContextBar();

        if (inChat) {
          ensureChatState(t);
          dtInput.value = dtDrafts.get(t.tabId) || '';
          renderDocktermAttachments(t);
          autoGrowDocktermComposer();
          updateDocktermSendState();
          dtPinned = true;
          dtUnseen = 0;
          renderDocktermView(t, { full: true });
          kickDocktermPoll(0);
          renderDocktermUsage(t);
          renderDocktermModelBar(t, true);
          ensureDocktermMeta(t);
          setTimeout(() => dtInput.focus(), 30);
        } else {
          clearTimeout(dtPollTimer);
          dtSlashMenu.classList.remove('open');
          if (t && terminalEngine === 'web') {
            setTimeout(() => {
              try {
                t.fitAddon.fit();
                t.term.focus();
              } catch {}
            }, 30);
          }
        }
      }

      function toggleDocktermChatMode(targetTabId = activeTabId, explicitMode = null) {
        if (!targetTabId || !tabs.has(targetTabId)) {
          showToast('请先打开一个终端标签页');
          return;
        }
        // The macOS menu shortcut and the page's own ⌘E handler can both fire for one key press
        const now = Date.now();
        if (!explicitMode && now - dtLastToggleAt < 300) return;
        dtLastToggleAt = now;
        const t = tabs.get(targetTabId);
        const next = explicitMode || (t.viewMode === 'chat' ? 'terminal' : 'chat');
        t.viewMode = next;
        if (next === 'chat') savedViewModes[t.tabId] = 'chat';
        else delete savedViewModes[t.tabId];
        persistViewModes();
        if (targetTabId !== activeTabId) {
          activateTerminalTab(targetTabId);
        } else {
          syncDocktermViewUI();
          renderTabBar();
        }
      }

      // ---------------------------------------------------------------- usage + model / effort
      // Usage: fetched by the node from Anthropic's usage endpoint (what /usage shows) when the
      // conversation view opens and every 10 minutes while it is open — nothing is typed into
      // the terminal. Models: listed once per node. /model and /effort only run when you switch.
      const DT_USAGE_EVERY_MS = 10 * 60 * 1000;
      const DT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
      const DT_LINE_ORDER = ['fable', 'opus', 'sonnet', 'haiku'];
      const dtUsageEl = document.getElementById('docktermUsage');
      const dtPicks = {
        model: { wrap: document.getElementById('docktermModelPick'), btn: document.getElementById('docktermModelBtn'), label: document.getElementById('docktermModelLabel'), menu: document.getElementById('docktermModelMenu'), title: '模型', cmd: '/model' },
        effort: { wrap: document.getElementById('docktermEffortPick'), btn: document.getElementById('docktermEffortBtn'), label: document.getElementById('docktermEffortLabel'), menu: document.getElementById('docktermEffortMenu'), title: 'Effort', cmd: '/effort' },
      };
      let dtOpenPick = ''; // 'model' | 'effort' | ''
      const dtModelNote = document.getElementById('docktermModelNote');
      const dtNodeMeta = new Map(); // nodeId -> { usage, usageError, plan, usageAt, models, extraModels, modelsLoaded }
      let dtModelBarSig = '';

      function dtMetaFor(t) {
        const id = (t && t.nodeId) || '';
        if (!dtNodeMeta.has(id)) dtNodeMeta.set(id, { usage: null, usageAt: 0, models: [], extraModels: [], modelsLoaded: false, inflight: null });
        return dtNodeMeta.get(id);
      }

      async function loadDocktermMeta(t, parts, { force = false } = {}) {
        const meta = dtMetaFor(t);
        const c = ensureChatState(t);
        try {
          const q = new URLSearchParams({ nodeId: t.nodeId || '', cwd: t.cwd || '', parts: parts.join(',') });
          if (force) q.set('force', '1');
          const res = await fetch(`/api/claude-meta?${q}`, { cache: 'no-store' });
          const data = await res.json();
          if (parts.includes('usage')) {
            meta.usageAt = Date.now();
            if (data.usage) meta.usage = data.usage;
            meta.usageError = data.usageError || data.error || '';
            meta.plan = data.plan || meta.plan || '';
          }
          if (parts.includes('models') && Array.isArray(data.models)) {
            meta.models = data.models;
            meta.extraModels = Array.isArray(data.extraModels) ? data.extraModels : [];
            meta.modelsLoaded = data.models.length > 0 || meta.extraModels.length > 0;
          }
          if (parts.includes('current') && data.settings) {
            c.settings = data.settings;
            c.settingsLoaded = true;
          }
        } catch {
          if (parts.includes('usage')) meta.usageAt = Date.now() - DT_USAGE_EVERY_MS + 60 * 1000; // retry in a minute
        }
        if (activeChatTab() === t) {
          renderDocktermUsage(t);
          renderDocktermModelBar(t, true);
        }
      }

      function ensureDocktermMeta(t) {
        const meta = dtMetaFor(t);
        const parts = [];
        if (!meta.modelsLoaded) parts.push('models');
        if (!t.chat.settingsLoaded) parts.push('current');
        if (Date.now() - meta.usageAt >= DT_USAGE_EVERY_MS) parts.push('usage');
        if (parts.length) loadDocktermMeta(t, parts);
      }

      setInterval(() => {
        const t = activeChatTab();
        if (!t || document.hidden) return;
        if (Date.now() - dtMetaFor(t).usageAt >= DT_USAGE_EVERY_MS) loadDocktermMeta(t, ['usage']);
      }, 30 * 1000);

      function dtResetText(iso) {
        const at = Date.parse(iso || '');
        if (!Number.isFinite(at)) return '';
        const d = new Date(at);
        const left = at - Date.now();
        const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
        if (left <= 0) return '即将重置';
        if (left < 24 * 3600 * 1000) {
          const h = Math.floor(left / 3600000);
          const m = Math.round((left % 3600000) / 60000);
          return `${hm} 重置（${h ? `${h} 小时 ` : ''}${m} 分钟后）`;
        }
        return `${d.getMonth() + 1}月${d.getDate()}日 ${hm} 重置`;
      }

      function renderDocktermUsage(t) {
        const meta = t ? dtMetaFor(t) : null;
        const u = meta && meta.usage;
        if (!u || (!u.fiveHour && !u.week)) {
          dtUsageEl.hidden = true;
          return;
        }
        const meter = (label, x) => {
          if (!x) return '';
          const pct = Math.max(0, Math.min(100, Math.round(Number(x.pct) || 0)));
          const cls = pct >= 90 ? ' is-crit' : pct >= 75 ? ' is-warn' : '';
          const r = 9;
          const len = 2 * Math.PI * r;
          const arc = pct > 0 ? Math.max(1.5, (len * pct) / 100) : 0;
          return `<span class="usage-meter${cls}"><span>${label}</span><span class="usage-ring"><svg viewBox="0 0 22 22" aria-hidden="true"><circle class="usage-ring__track" cx="11" cy="11" r="${r}"/>${arc ? `<circle class="usage-ring__value" cx="11" cy="11" r="${r}" stroke-dasharray="${arc.toFixed(2)} ${len.toFixed(2)}"/>` : ''}</svg><span class="usage-ring__num${pct >= 100 ? ' is-full' : ''}">${pct}</span></span></span>`;
        };
        dtUsageEl.innerHTML = meter('5h', u.fiveHour) + meter('周', u.week);
        const lines = [];
        const withReset = (text, iso) => {
          const r = dtResetText(iso);
          return r ? `${text} · ${r}` : text;
        };
        if (u.fiveHour) lines.push(withReset(`5 小时用量 ${Math.round(u.fiveHour.pct)}%`, u.fiveHour.resetsAt));
        if (u.week) lines.push(withReset(`本周用量 ${Math.round(u.week.pct)}%`, u.week.resetsAt));
        if (u.weekOpus) lines.push(`本周 Opus ${Math.round(u.weekOpus.pct)}%`);
        if (u.weekSonnet) lines.push(`本周 Sonnet ${Math.round(u.weekSonnet.pct)}%`);
        const when = u.fetchedAt ? new Date(u.fetchedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
        lines.push(u.source === 'cache'
          ? `来自 Claude Code 的缓存（${when}）· 实时查询失败：${meta.usageError || '未知原因'}`
          : `更新于 ${when} · 每 10 分钟刷新${meta.plan ? ` · ${meta.plan}` : ''}`);
        dtUsageEl.title = lines.join('\n');
        dtUsageEl.classList.toggle('is-stale', u.source === 'cache');
        dtUsageEl.hidden = false;
      }

      function dtModelLabel(m) {
        return String((m && m.name) || '').replace(/^Claude\s+/i, '') || (m && m.id) || '';
      }

      function dtModelOptions(t) {
        const meta = dtMetaFor(t);
        const models = (meta.models || []).filter((m) => !m.deprecated);
        const latest = new Map();
        for (const m of models) if (m.line && !latest.has(m.line)) latest.set(m.line, m); // API lists newest first
        const lines = [...DT_LINE_ORDER.filter((l) => latest.has(l)), ...[...latest.keys()].filter((l) => !DT_LINE_ORDER.includes(l))];
        const primary = lines.map((l) => latest.get(l));
        const ids = new Set(primary.map((m) => m.id));
        const extra = (meta.extraModels || []).filter((m) => m.id && !ids.has(m.id));
        extra.forEach((m) => ids.add(m.id));
        const others = models.filter((m) => !ids.has(m.id));
        return { models, primary, extra, others };
      }

      // Aliases (opus / sonnet / default …) map to the newest model of that line
      function dtResolveModelId(name, models) {
        const v = String(name || '').trim();
        if (!v) return '';
        if (models.some((m) => m.id === v)) return v;
        const base = v.replace(/\[.*\]$/, '');
        if (models.some((m) => m.id === base)) return base;
        const alias = base.toLowerCase();
        const hit = models.find((m) => m.line === alias && !m.deprecated);
        return hit ? hit.id : v;
      }

      function dtCurrentModel(t) {
        const c = t.chat;
        const o = c.modelOverride;
        const tr = c.model;
        const st = c.settings || {};
        const launch = c.launch || {};
        const models = dtMetaFor(t).models || [];
        let model = (o && o.model) || (tr && tr.model) || launch.model || st.model || '';
        let source = o && o.model ? 'pending' : tr && tr.model ? 'reply' : launch.model ? 'launch' : st.model ? 'settings' : '';
        const id = dtResolveModelId(model, models);
        const perModel = (st.modelSettings && (st.modelSettings[id] || st.modelSettings[model])) || {};
        const effort = (o && o.effort) || (!(o && o.model) && tr && tr.effort) || launch.effort || perModel.effortLevel || st.effortLevel || '';
        if (!model) source = '';
        return { model: id || model, raw: model, effort, source };
      }

      function renderDocktermModelBar(t, force = false) {
        if (!t || !t.chat) return;
        const c = t.chat;
        const cur = dtCurrentModel(t);
        const opts = dtModelOptions(t);
        const busy = c.status === 'working' || c.status === 'asking';
        const sig = JSON.stringify([t.tabId, cur, opts.models.length, opts.extra.length, c.claudeRunning, busy, c.modelNote]);
        if (!force && sig === dtModelBarSig) return;
        dtModelBarSig = sig;

        const m = opts.models.find((x) => x.id === cur.model) || opts.extra.find((x) => x.id === cur.model);
        const modelName = !cur.model ? (opts.models.length ? '模型' : '模型（载入中…）') : m ? (m.name ? dtModelLabel(m) : m.id) : cur.model;
        dtPicks.model.label.textContent = modelName;
        dtPicks.effort.label.textContent = cur.effort || 'effort';

        const disabled = !c.claudeRunning;
        dtPicks.model.btn.disabled = disabled;
        dtPicks.effort.btn.disabled = disabled;
        if (disabled && dtOpenPick) closeDocktermPick();
        const srcText = { reply: '当前对话正在使用', pending: '刚切换，等下一条回复确认', launch: '启动参数', settings: '来自 Claude 设置' }[cur.source] || '';
        dtPicks.model.btn.title = disabled ? 'Claude 未运行' : `模型${srcText ? ` · ${srcText}` : ''}\n切换时会在这个会话里执行 /model`;
        dtPicks.effort.btn.title = disabled ? 'Claude 未运行' : `Effort${srcText ? ` · ${srcText}` : ''}\n切换时会在这个会话里执行 /effort`;
        dtModelNote.textContent = c.modelNote || (disabled ? 'Claude 未运行' : busy ? 'Claude 正在执行，空闲后可切换' : '');
        if (dtOpenPick) buildDocktermPickMenu(dtOpenPick, t);
      }

      // ---- Codex-style option menus for model / effort (open upward from the buttons)
      const DT_CHECK_SVG = '<svg class="dt-pick__check" viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

      function dtPickGroups(kind, t) {
        const cur = dtCurrentModel(t);
        if (kind === 'effort') {
          const m = dtModelOptions(t).models.find((x) => x.id === cur.model);
          const levels = m && m.efforts && m.efforts.length ? m.efforts : DT_EFFORTS;
          const items = levels.map((lv) => ({ value: lv, label: lv }));
          items.push({ value: 'auto', label: 'auto', sub: '自动' });
          if (cur.effort && !items.some((i) => i.value === cur.effort)) items.unshift({ value: cur.effort, label: cur.effort });
          return { current: cur.effort, groups: [{ title: '', items }] };
        }
        const opts = dtModelOptions(t);
        const groups = [{ title: '', items: [{ value: 'default', label: '默认（账号推荐）' }] }];
        const latest = [
          ...opts.primary.map((m) => ({ value: m.id, label: dtModelLabel(m), sub: m.id })),
          ...opts.extra.map((m) => ({ value: m.id, label: m.name || m.id, sub: m.description ? '' : m.id })),
        ];
        if (latest.length) groups.push({ title: '最新', items: latest });
        if (opts.others.length) groups.push({ title: '其他版本', items: opts.others.map((m) => ({ value: m.id, label: dtModelLabel(m), sub: m.id })) });
        const known = new Set(groups.flatMap((g) => g.items.map((i) => i.value)));
        if (cur.model && !known.has(cur.model)) groups[0].items.unshift({ value: cur.model, label: cur.model });
        return { current: cur.model, groups };
      }

      function buildDocktermPickMenu(kind, t) {
        const { current, groups } = dtPickGroups(kind, t);
        const pick = dtPicks[kind];
        let html = `<div class="dt-pick__title">${escapeHtml(pick.title)}</div>`;
        for (const g of groups) {
          if (g.title) html += `<div class="dt-pick__title">${escapeHtml(g.title)}</div>`;
          for (const it of g.items) {
            html += `<button type="button" class="dt-pick__item${it.value === current ? ' is-current' : ''}" role="option" aria-selected="${it.value === current}" data-value="${escapeHtml(it.value)}"><span class="dt-pick__name">${escapeHtml(it.label)}</span>${it.sub ? `<span class="dt-pick__sub">${escapeHtml(it.sub)}</span>` : ''}${DT_CHECK_SVG}</button>`;
          }
        }
        pick.menu.innerHTML = html;
      }

      function openDocktermPick(kind) {
        const t = activeChatTab();
        if (!t || !t.chat || !t.chat.claudeRunning) return;
        closeDocktermPick();
        dtOpenPick = kind;
        const pick = dtPicks[kind];
        buildDocktermPickMenu(kind, t);
        pick.menu.hidden = false;
        pick.wrap.classList.add('is-open');
        pick.btn.setAttribute('aria-expanded', 'true');
        const cur = pick.menu.querySelector('.is-current');
        if (cur) cur.scrollIntoView({ block: 'nearest' });
      }

      function closeDocktermPick() {
        if (!dtOpenPick) return;
        const pick = dtPicks[dtOpenPick];
        pick.menu.hidden = true;
        pick.wrap.classList.remove('is-open');
        pick.btn.setAttribute('aria-expanded', 'false');
        dtOpenPick = '';
      }

      function switchDocktermModel(kind, value) {
        const t = activeChatTab();
        if (!t || !value) return;
        const c = t.chat;
        const cur = dtCurrentModel(t);
        if (!c.claudeRunning) {
          showToast('Claude 未运行，无法切换');
          renderDocktermModelBar(t, true);
          return;
        }
        if (c.status === 'working' || c.status === 'asking') {
          showToast(`Claude 正在执行，等它空闲后再切换${kind === 'model' ? '模型' : ' effort'}`);
          renderDocktermModelBar(t, true);
          return;
        }
        if ((kind === 'model' && value === cur.model) || (kind === 'effort' && value === cur.effort)) return;
        const cmd = kind === 'model' ? `/model ${value}` : `/effort ${value}`;
        sendDocktermRawInput(t, cmd, true);
        const o = { ...(c.modelOverride || {}), at: Date.now() };
        if (kind === 'model') {
          o.model = value;
          // Claude Code keeps an effort per model; show that one until the next reply confirms
          const st = c.settings || {};
          const id = dtResolveModelId(value, dtMetaFor(t).models || []);
          const per = st.modelSettings && st.modelSettings[id];
          o.effort = (per && per.effortLevel) || o.effort || '';
        } else {
          o.effort = value;
          if (!o.model) o.model = cur.raw || cur.model;
        }
        c.modelOverride = o;
        c.modelNote = `已执行 ${cmd}`;
        renderDocktermModelBar(t, true);
        setTimeout(() => {
          if (c.modelNote === `已执行 ${cmd}`) c.modelNote = '';
          if (activeChatTab() === t) renderDocktermModelBar(t, true);
        }, 4000);
        // settings may have changed (Claude Code saves /model as the default)
        setTimeout(() => loadDocktermMeta(t, ['current']), 2500);
        kickDocktermPoll(800);
      }

      for (const kind of Object.keys(dtPicks)) {
        const pick = dtPicks[kind];
        pick.btn.addEventListener('click', () => (dtOpenPick === kind ? closeDocktermPick() : openDocktermPick(kind)));
        pick.menu.addEventListener('click', (e) => {
          const item = e.target.closest('.dt-pick__item');
          if (!item) return;
          const v = item.dataset.value;
          closeDocktermPick();
          switchDocktermModel(kind, v);
        });
        pick.menu.addEventListener('mousemove', (e) => {
          const item = e.target.closest('.dt-pick__item');
          if (item) pick.menu.querySelectorAll('.is-focus').forEach((x) => x !== item && x.classList.remove('is-focus'));
        });
      }
      document.addEventListener('mousedown', (e) => {
        if (dtOpenPick && !dtPicks[dtOpenPick].wrap.contains(e.target)) closeDocktermPick();
      });
      document.addEventListener('keydown', (e) => {
        if (!dtOpenPick) return;
        const menu = dtPicks[dtOpenPick].menu;
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          const btn = dtPicks[dtOpenPick].btn;
          closeDocktermPick();
          btn.focus();
          return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
          const items = [...menu.querySelectorAll('.dt-pick__item')];
          if (!items.length) return;
          let i = items.findIndex((x) => x.classList.contains('is-focus'));
          if (e.key === 'Enter') {
            if (i < 0) return;
            e.preventDefault();
            e.stopPropagation();
            items[i].click();
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          if (i < 0) i = items.findIndex((x) => x.classList.contains('is-current'));
          i = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
          items.forEach((x) => x.classList.remove('is-focus'));
          items[i].classList.add('is-focus');
          items[i].scrollIntoView({ block: 'nearest' });
        }
      }, true);

      function launchClaudeInActiveTab() {
        if (!activeTabId || !tabs.has(activeTabId)) return;
        const t = tabs.get(activeTabId);
        const cmd = claudeLaunchCommand(t, { forShell: true });
        sendDocktermRawInput(t, cmd, true);
        showToast(`已在远端运行：${cmd}`);
        kickDocktermPoll(1200);
      }

      // ---------------------------------------------------------------- composer
      function autoGrowDocktermComposer() {
        dtInput.style.height = 'auto';
        dtInput.style.height = `${Math.min(240, Math.max(38, dtInput.scrollHeight))}px`;
      }

      function updateDocktermSendState() {
        const t = activeChatTab();
        const atts = t ? dtAttachList(t) : [];
        dtSendBtn.disabled = dtSubmitting || (!dtInput.value.trim() && !atts.length);
        const label = dtSendBtn.querySelector('span');
        if (label) label.textContent = dtSubmitting ? '上传中…' : '发送';
      }

      function insertIntoDocktermComposer(text) {
        const start = dtInput.selectionStart ?? dtInput.value.length;
        const end = dtInput.selectionEnd ?? dtInput.value.length;
        const prefix = start > 0 && !/\s$/.test(dtInput.value.slice(0, start)) ? ' ' : '';
        dtInput.value = dtInput.value.slice(0, start) + prefix + text + dtInput.value.slice(end);
        dtInput.focus();
        const caret = start + prefix.length + text.length;
        dtInput.setSelectionRange(caret, caret);
        dtInput.dispatchEvent(new Event('input'));
      }

      function updateDocktermSlashMenu() {
        const m = dtInput.value.match(/^(\/[a-zA-Z0-9_-]*)$/);
        if (!m) {
          dtSlashMenu.classList.remove('open');
          dtSlashItems = [];
          return;
        }
        const q = m[1].toLowerCase();
        dtSlashItems = DOCKTERM_SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
        if (dtSlashItems.length === 0) {
          dtSlashMenu.classList.remove('open');
          return;
        }
        dtSlashIndex = Math.min(dtSlashIndex, dtSlashItems.length - 1);
        dtSlashMenu.innerHTML = dtSlashItems.map((item, idx) => `
          <div class="composer__menu-item${idx === dtSlashIndex ? ' active' : ''}" data-slash-idx="${idx}">
            <span class="composer__menu-cmd">${escapeHtml(item.name)}</span>
            <span>${escapeHtml(item.desc)}</span>
          </div>
        `).join('');
        dtSlashMenu.classList.add('open');
        const activeItem = dtSlashMenu.querySelector('.composer__menu-item.active');
        if (activeItem) activeItem.scrollIntoView({ block: 'nearest' });
      }

      function chooseDocktermSlash(i) {
        const chosen = dtSlashItems[i];
        if (!chosen) return;
        dtInput.value = `${chosen.name} `;
        dtDrafts.set(activeTabId, dtInput.value);
        dtSlashMenu.classList.remove('open');
        updateDocktermSendState();
        dtInput.focus();
      }

      dtSlashMenu.addEventListener('mousedown', (ev) => {
        const item = ev.target.closest('[data-slash-idx]');
        if (!item) return;
        ev.preventDefault();
        chooseDocktermSlash(Number(item.dataset.slashIdx));
      });

      // ---------------------------------------------------------------- attachments (paste / drop)
      // Files go straight to the node (<cwd>/.takt/uploads) as soon as they are added; sending appends
      // their paths to the prompt so Claude reads them (images included).
      const DT_ATTACH_MAX = 10;
      const DT_ATTACH_MAX_BYTES = 50 * 1024 * 1024;

      function dtExtLabel(name) {
        const m = String(name || '').match(/\.([a-z0-9]{1,6})$/i);
        return m ? m[1] : 'file';
      }
      function dtUploadDisplayName(p) {
        return String(p).split('/').pop().replace(/^\d{8}-\d{6}-[0-9a-f]{4}-/, '');
      }
      function dtSplitAttachmentLines(text) {
        const files = [];
        const kept = [];
        for (const line of String(text || '').split('\n')) {
          const m = DT_UPLOAD_LINE_RE.exec(line.trim());
          if (m) files.push(m[1]);
          else kept.push(line);
        }
        return { text: files.length ? kept.join('\n').replace(/\s+$/, '') : text, files };
      }
      function dtAttachList(t) {
        if (!dtAttachments.has(t.tabId)) dtAttachments.set(t.tabId, []);
        return dtAttachments.get(t.tabId);
      }
      function dtFormatSize(n) {
        return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
      }

      function renderDocktermAttachments(t) {
        const list = t ? dtAttachList(t) : [];
        dtAttachEl.hidden = list.length === 0;
        dtAttachEl.innerHTML = list.map((a) => {
          const state = a.status === 'uploading' ? ' is-uploading' : a.status === 'error' ? ' is-error' : '';
          const tip = `${a.name} · ${dtFormatSize(a.size)}${a.status === 'uploading' ? ' · 上传中…' : a.status === 'error' ? ` · 上传失败：${a.error}（点击重试）` : ` · 已上传到 ${a.remotePath}`}`;
          const x = '<button type="button" class="attach-chip__x" data-attach-remove aria-label="移除">×</button>';
          if (a.isImage) {
            return `<div class="attach-chip attach-chip--image${state}" data-attach-id="${a.id}" title="${escapeHtml(tip)}"><img src="${escapeHtml(a.url)}" alt="">${x}</div>`;
          }
          return `<div class="attach-chip${state}" data-attach-id="${a.id}" title="${escapeHtml(tip)}"><span class="attach-chip__ext">${escapeHtml(dtExtLabel(a.name))}</span><span class="attach-chip__meta"><span class="attach-chip__name">${escapeHtml(a.name)}</span><span class="attach-chip__size">${a.status === 'error' ? '上传失败 · 点击重试' : dtFormatSize(a.size)}</span></span>${x}</div>`;
        }).join('');
      }

      async function uploadDocktermAttachment(t, a) {
        a.status = 'uploading';
        a.error = '';
        try {
          // into the folder Claude actually runs in, so it can read the file without a permission prompt
          const cwd = (t.chat && t.chat.claudeRunning && t.chat.claudeCwd) || t.cwd || '';
          const q = new URLSearchParams({ nodeId: t.nodeId || '', cwd, name: a.name });
          const res = await fetch(`/api/chat-upload?${q}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: a.file });
          const data = await res.json().catch(() => ({}));
          if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
          a.status = 'done';
          a.remotePath = data.remotePath;
        } catch (err) {
          a.status = 'error';
          a.error = (err && err.message) || '上传失败';
        }
        if (activeChatTab() === t) {
          renderDocktermAttachments(t);
          updateDocktermSendState();
        }
      }

      function addDocktermAttachments(files) {
        const t = activeChatTab();
        if (!t || !files || !files.length) return;
        const list = dtAttachList(t);
        for (const f of files) {
          if (list.length >= DT_ATTACH_MAX) {
            showToast(`一条消息最多附加 ${DT_ATTACH_MAX} 个文件`);
            break;
          }
          if (f.size > DT_ATTACH_MAX_BYTES) {
            showToast(`${f.name} 超过 50 MB，未添加`);
            continue;
          }
          if (!f.size) {
            showToast(`${f.name || '该项'} 是空文件或文件夹，未添加`);
            continue;
          }
          const isImage = /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/i.test(f.type);
          const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
          const generic = !f.name || /^image\.\w+$/i.test(f.name);
          const a = {
            id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            name: generic && isImage ? `pasted-image.${ext}` : f.name,
            size: f.size,
            isImage,
            url: isImage ? URL.createObjectURL(f) : '',
            file: f,
            status: 'uploading',
            remotePath: '',
            error: '',
          };
          a.promise = uploadDocktermAttachment(t, a);
          list.push(a);
        }
        renderDocktermAttachments(t);
        updateDocktermSendState();
        dtInput.focus();
      }

      dtAttachEl.addEventListener('click', (e) => {
        const t = activeChatTab();
        const chip = e.target.closest('[data-attach-id]');
        if (!t || !chip) return;
        const list = dtAttachList(t);
        const i = list.findIndex((a) => a.id === chip.dataset.attachId);
        if (i < 0) return;
        if (e.target.closest('[data-attach-remove]')) {
          const [a] = list.splice(i, 1);
          if (a.url) URL.revokeObjectURL(a.url);
        } else if (list[i].status === 'error') {
          list[i].promise = uploadDocktermAttachment(t, list[i]);
        }
        renderDocktermAttachments(t);
        updateDocktermSendState();
      });

      // Paste: images / files from the clipboard become attachments. Rich text that merely carries a
      // rendered picture (Excel, Word …) still pastes as text.
      dtInput.addEventListener('paste', (e) => {
        const cd = e.clipboardData;
        const files = cd ? Array.from(cd.files || []) : [];
        if (!files.length) return;
        const text = (cd.getData('text/plain') || '').trim();
        const names = new Set(files.map((f) => f.name));
        const textIsNames = !text || /^(https?|file):\/\//i.test(text) || text.split(/\r?\n/).every((l) => !l.trim() || names.has(l.trim()) || names.has(l.trim().split('/').pop()));
        if (!textIsNames && files.every((f) => /^image\//.test(f.type))) return;
        e.preventDefault();
        addDocktermAttachments(files);
      });

      async function submitDocktermComposerPrompt() {
        const t = activeChatTab();
        if (!t || dtSubmitting) return;
        const c = ensureChatState(t);
        const typed = dtInput.value.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
        const isCommand = typed.startsWith('/');
        const atts = isCommand ? [] : dtAttachList(t).slice();
        if (!typed.trim() && !atts.length) return;
        if (c.status === 'asking' && !isCommand) {
          // keystrokes would land in Claude's permission dialog
          showToast('Claude 在等你确认上面的操作，先在确认卡片里选择');
          return;
        }
        if (atts.some((a) => a.status === 'uploading')) {
          dtSubmitting = true;
          updateDocktermSendState();
          await Promise.all(atts.map((a) => a.promise));
          dtSubmitting = false;
          updateDocktermSendState();
          if (activeChatTab() !== t) return;
        }
        const failed = atts.filter((a) => a.status !== 'done');
        if (failed.length) {
          showToast(`${failed.length} 个附件上传失败：点击它重试，或移除后再发送`);
          renderDocktermAttachments(t);
          return;
        }
        const paths = atts.map((a) => a.remotePath);
        const text = paths.length ? `${typed}${typed ? '\n\n' : ''}${paths.map((p) => DT_ATTACH_LABEL + p).join('\n')}` : typed;
        if (c.loaded && !c.claudeRunning && !c.stale) {
          // Without Claude the text would be executed by the shell
          if (!confirm('这个标签页里似乎没有运行 Claude，消息会直接输入到 shell。\n\n仍然发送吗？（建议先点「启动 Claude」）')) return;
        }

        if (typed.trim()) {
          const hist = dtHistory.get(t.tabId) || [];
          if (hist[hist.length - 1] !== typed) hist.push(typed);
          if (hist.length > 100) hist.shift();
          dtHistory.set(t.tabId, hist);
        }
        dtHistCursor.delete(t.tabId);

        dtInput.value = '';
        dtDrafts.set(t.tabId, '');
        if (atts.length) dtAttachments.set(t.tabId, dtAttachList(t).filter((a) => !atts.includes(a)));
        renderDocktermAttachments(t);
        dtSlashMenu.classList.remove('open');
        autoGrowDocktermComposer();
        updateDocktermSendState();

        const isPicker = DOCKTERM_PICKER_SLASH_RE.test(text);
        const pendingId = `p${Date.now()}`;
        if (!isCommand) {
          c.pending.push({
            id: pendingId,
            text,
            display: typed,
            atts: atts.map((a) => ({ name: a.name, isImage: a.isImage, url: a.url })),
            queued: c.status === 'working',
            inflight: true,
            at: Date.now(),
          });
          renderDocktermPending(t);
          renderDocktermChrome(t);
        }
        dtPinned = true;
        requestAnimationFrame(scrollDocktermToBottom);

        const sent = await sendDocktermRawInput(t, text, true);
        const sentEntry = c.pending.find((x) => x.id === pendingId);
        if (sentEntry) Object.assign(sentEntry, { inflight: false, sentAt: Date.now() });
        if (sent && sent.stuck) {
          if (sentEntry) Object.assign(sentEntry, { failed: 'pasting', failedAt: Date.now() });
          if (activeChatTab() === t) renderDocktermPending(t);
          showToast('Claude Code 一直显示「Pasting…」，消息没有提交。切到终端看看它的输入框', 6000);
        }

        if (isPicker) {
          // interactive TUI pickers (/model, /resume …) only work in the terminal
          toggleDocktermChatMode(t.tabId, 'terminal');
          return;
        }
        kickDocktermPoll(350);
      }

      dtInput.addEventListener('input', () => {
        if (activeTabId) dtDrafts.set(activeTabId, dtInput.value);
        if (activeTabId && dtHistCursor.has(activeTabId)) {
          const hist = dtHistory.get(activeTabId) || [];
          if (dtInput.value !== hist[dtHistCursor.get(activeTabId)]) dtHistCursor.delete(activeTabId);
        }
        autoGrowDocktermComposer();
        updateDocktermSendState();
        updateDocktermSlashMenu();
      });

      dtInput.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        const t = activeChatTab();

        if (dtSlashMenu.classList.contains('open') && dtSlashItems.length > 0) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const d = e.key === 'ArrowDown' ? 1 : -1;
            dtSlashIndex = (dtSlashIndex + d + dtSlashItems.length) % dtSlashItems.length;
            updateDocktermSlashMenu();
            return;
          }
          if (e.key === 'Tab') {
            e.preventDefault();
            chooseDocktermSlash(dtSlashIndex);
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            dtSlashMenu.classList.remove('open');
            return;
          }
        }

        // Answer a permission prompt with its number key while the composer is empty
        if (t && t.chat && t.chat.status === 'asking' && t.chat.ask && !dtInput.value && /^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const idx = Number(e.key) - 1;
          const ask = t.chat.ask;
          if (idx < ask.options.length && !ask.multiSelect && idx !== ask.freeTextIndex) {
            e.preventDefault();
            sendDocktermRawInput(t, docktermPickKeys(ask, idx), false);
            kickDocktermPoll(250);
            return;
          }
        }

        if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          submitDocktermComposerPrompt();
          return;
        }

        if (e.key === 'Escape') {
          e.preventDefault();
          // Only interrupt when something is running — a stray double Esc on an idle Claude opens its rewind menu
          if (t && t.chat && (t.chat.status === 'working' || t.chat.status === 'asking')) sendDocktermInterrupt();
          return;
        }

        // ↑ / ↓ recall earlier prompts — only from an empty box (or while browsing), never over a draft
        if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && t && !e.shiftKey && !e.metaKey && !e.altKey) {
          const hist = dtHistory.get(t.tabId) || [];
          if (!hist.length) return;
          const browsing = dtHistCursor.has(t.tabId);
          if (!browsing && dtInput.value !== '') return;
          let cur = browsing ? dtHistCursor.get(t.tabId) : hist.length;
          if (e.key === 'ArrowUp' && cur > 0) cur -= 1;
          else if (e.key === 'ArrowDown' && browsing) cur += 1;
          else return;
          e.preventDefault();
          if (cur >= hist.length) {
            dtHistCursor.delete(t.tabId);
            dtInput.value = '';
          } else {
            dtHistCursor.set(t.tabId, cur);
            dtInput.value = hist[cur];
          }
          dtDrafts.set(t.tabId, dtInput.value);
          autoGrowDocktermComposer();
          updateDocktermSendState();
        }
      });

      // ---------------------------------------------------------------- events
      dtScroll.addEventListener('scroll', () => {
        const gap = dtScroll.scrollHeight - dtScroll.scrollTop - dtScroll.clientHeight;
        dtPinned = gap < 40;
        if (dtPinned) dtUnseen = 0;
        updateDocktermJump();
        const t = activeChatTab();
        if (t && t.chat && t.chat.hasOlder && !t.chat.loadingOlder && dtScroll.scrollTop < 120 && t.chat.messages.length > 0) {
          loadOlderDockterm();
        }
      }, { passive: true });

      // Keep following the bottom when the viewport changes size (composer grows, window resizes)
      new ResizeObserver(() => {
        if (dtPinned && !dtStage.hidden) dtScroll.scrollTop = dtScroll.scrollHeight;
      }).observe(dtScroll);

      dtJumpBtn.addEventListener('click', scrollDocktermToBottom);
      dtOlderBtn.addEventListener('click', loadOlderDockterm);

      // ---------------------------------------------------------------- files & images: open on the Mac
      async function openDocktermFileOnMac(t, { path: p, chatImage, reveal = false, label = '' } = {}) {
        const name = label || (p ? dtStripLine(p).split('/').pop() : '图片');
        try {
          const res = await fetch('/api/open-local', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(chatImage
              ? { chatImage, reveal }
              : { path: dtStripLine(p), cwd: (t && t.cwd) || currentFilesCwd, nodeId: (t && t.nodeId) || currentFilesNodeId, reveal }),
          });
          const data = await res.json();
          if (!data.ok) {
            showToast(data.error || `无法打开 ${name}`);
            return;
          }
          const how = data.mode === 'reveal' ? '已在 Finder 中显示' : data.mode === 'text' ? '已在文本编辑器中打开' : '已用 Mac 应用打开';
          showToast(`${how}：${name}${data.fromRemote && !chatImage ? '（已从节点拷贝到本机）' : ''}`);
        } catch {
          showToast(`无法打开 ${name}`);
        }
      }

      function previewOrOpenDocktermFile(t, p) {
        const clean = dtStripLine(p);
        const base = clean.split('/').pop();
        const extMatch = base.toLowerCase().match(/(\.[a-z0-9_-]+)$/);
        const ext = extMatch ? extMatch[1] : '';
        // Previewable (code, images, web) -> right pane; CAD / EDA / office / media -> its Mac app
        if (checkClientPreviewEligibility({ name: base, ext, size: 0 }).allowed) {
          previewFileInRightPane(p, (t && t.cwd) || currentFilesCwd, false, (t && t.nodeId) || currentFilesNodeId);
        } else {
          openDocktermFileOnMac(t, { path: p });
        }
      }

      const dtLightbox = document.getElementById('docktermLightbox');
      const dtLightboxImg = document.getElementById('docktermLightboxImg');
      const dtLightboxName = document.getElementById('docktermLightboxName');
      let dtLightboxItem = null;
      document.body.appendChild(dtLightbox); // fixed overlay above everything

      function openDocktermLightbox(t, thumb) {
        const img = thumb.querySelector('img');
        if (!img || !img.src) return;
        const p = thumb.dataset.thumbPath || '';
        dtLightboxItem = p ? { t, path: p } : { t, chatImage: dtChatImageRef(t, thumb.dataset.thumbRef) };
        dtLightboxImg.src = img.src;
        dtLightboxName.textContent = p || thumb.title || '图片';
        dtLightboxName.title = p || '';
        dtLightbox.hidden = false;
      }
      function closeDocktermLightbox() {
        dtLightbox.hidden = true;
        dtLightboxImg.removeAttribute('src');
        dtLightboxItem = null;
      }
      dtLightbox.addEventListener('click', (e) => {
        if (e.target === dtLightbox) closeDocktermLightbox();
      });
      document.getElementById('btnLightboxClose').addEventListener('click', closeDocktermLightbox);
      document.getElementById('btnLightboxOpen').addEventListener('click', () => {
        if (dtLightboxItem) openDocktermFileOnMac(dtLightboxItem.t, { ...dtLightboxItem, label: dtLightboxName.textContent.split('/').pop() });
      });
      document.getElementById('btnLightboxReveal').addEventListener('click', () => {
        if (dtLightboxItem) openDocktermFileOnMac(dtLightboxItem.t, { ...dtLightboxItem, reveal: true, label: dtLightboxName.textContent.split('/').pop() });
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !dtLightbox.hidden) {
          e.preventDefault();
          e.stopPropagation();
          closeDocktermLightbox();
        }
      }, true);

      dtStage.addEventListener('click', (e) => {
        const thumb = e.target.closest('.reading__thumb');
        if (thumb) {
          e.preventDefault();
          const t = activeChatTab();
          if (!t) return;
          if (thumb.dataset.thumbPath && (e.metaKey || e.ctrlKey || e.altKey)) {
            openDocktermFileOnMac(t, { path: thumb.dataset.thumbPath, reveal: e.altKey });
          } else {
            openDocktermLightbox(t, thumb);
          }
          return;
        }
        const fileLink = e.target.closest('.md-file-link');
        if (fileLink) {
          e.preventDefault();
          const fp = fileLink.getAttribute('data-file-path');
          const t = activeChatTab();
          if (!fp) return;
          if (e.metaKey || e.ctrlKey || e.altKey) openDocktermFileOnMac(t, { path: fp, reveal: e.altKey });
          else previewOrOpenDocktermFile(t, fp);
          return;
        }
        const copyBtn = e.target.closest('.md-code-copy');
        if (copyBtn) {
          const code = copyBtn.closest('.md-code').querySelector('pre').textContent;
          navigator.clipboard.writeText(code).then(() => {
            copyBtn.textContent = '已复制';
            setTimeout(() => { copyBtn.textContent = '复制'; }, 1200);
          }, () => showToast('复制失败'));
          return;
        }
        const expand = e.target.closest('.reading__expand');
        if (expand) {
          const bubble = expand.parentElement.querySelector('.reading__user-bubble');
          const clamped = bubble.classList.toggle('is-clamped');
          expand.textContent = clamped ? '展开全部' : '收起';
          return;
        }
        if (e.target.closest('[data-dt-action="launch"]')) launchClaudeInActiveTab();
      });

      btnViewTerminal.addEventListener('click', () => toggleDocktermChatMode(activeTabId, 'terminal'));
      btnViewChat.addEventListener('click', () => toggleDocktermChatMode(activeTabId, 'chat'));
      dtStartBtn.addEventListener('click', () => launchClaudeInActiveTab());
      document.getElementById('btnDocktermRefreshNow').addEventListener('click', () => {
        const t = activeChatTab();
        if (!t) return;
        t.chat = null; // drop local state: next poll does a full reload
        dtRenderedTabId = null;
        ensureChatState(t);
        renderDocktermView(t, { full: true });
        kickDocktermPoll(0);
      });
      dtSendBtn.addEventListener('click', () => submitDocktermComposerPrompt());
      dtInterruptBtn.addEventListener('click', sendDocktermInterrupt);
      document.getElementById('btnLiveInterrupt').addEventListener('click', sendDocktermInterrupt);

      // ⌘E (or Ctrl+Shift+E) toggles the active tab between terminal and conversation view
      window.toggleDocktermChatMode = toggleDocktermChatMode;
      window.addEventListener('keydown', (e) => {
        if ((e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') ||
            (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'e')) {
          if (activeTabId && tabs.has(activeTabId)) {
            e.preventDefault();
            toggleDocktermChatMode(activeTabId);
          }
        }
      });

      syncDocktermViewUI();

      // Initial Boot
      loadProjectTree().then(() => {
        const node = getNodeInfo(primaryNodeId());
        return loadSessionFiles(node.remoteWorkDir, node.id);
      });
      pollStatusBar();
      setInterval(pollStatusBar, 4000);
      setInterval(loadProjectTree, 12000);
    })();
