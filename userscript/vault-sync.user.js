// ==UserScript==
// @name         Vault 一键备份助手 (原生 GitHub 风格 + 高级筛选排序面板版)
// @namespace    https://github.com/owwk-backup
// @version      2.1.0
// @description  左键一键备份，右键开启高级面板：多维筛选(名称/类型/权限)、智能排序、查看清单、删除项目、触发同步与 Worker 配置
// @author       owwk-backup
// @match        *://github.com/*
// @match        *://*.github.com/*
// @include      *://github.com/*
// @include      *://*.github.com/*
// @match        *://crates.io/*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    // 默认配置
    function getConfig() {
        return {
            workerUrl: GM_getValue('CF_WORKER_URL', 'https://your-worker-subdomain.workers.dev'),
            secretKey: GM_getValue('CF_SECRET_KEY', '')
        };
    }

    function setConfig(url, key) {
        GM_setValue('CF_WORKER_URL', (url || '').trim().replace(/\/+$/, ''));
        GM_setValue('CF_SECRET_KEY', (key || '').trim());
    }

    // 官方 Octicon 归档与搜索图标
    const ARCHIVE_ICON = `
    <svg data-component="Octicon" aria-hidden="true" focusable="false" class="octicon octicon-archive" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" display="inline-block" overflow="visible" style="vertical-align: text-bottom;">
        <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v1.5A1.75 1.75 0 0 1 13.25 6H13v6.25A2.75 2.75 0 0 1 10.25 15h-4.5A2.75 2.75 0 0 1 3 12.25V6h-.25A1.75 1.75 0 0 1 1 4.25v-1.5Zm1.75-.25a.25.25 0 0 0-.25.25v1.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-1.5a.25.25 0 0 0-.25-.25H2.75ZM4.5 6v6.25c0 .69.56 1.25 1.25 1.25h4.5c.69 0 1.25-.56 1.25-1.25V6H4.5ZM6.75 7.75a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5a.75.75 0 0 1 .75-.75Zm3.25.75a.75.75 0 0 0-1.5 0v1.5a.75.75 0 0 0 1.5 0v-1.5Z"></path>
    </svg>`;

    const SEARCH_ICON = `
    <svg aria-hidden="true" height="14" viewBox="0 0 16 16" version="1.1" width="14" fill="currentColor" style="position: absolute; left: 10px; top: 9px; opacity: 0.5;">
        <path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"></path>
    </svg>`;

    // --- 注入面板原生高质感 CSS ---
    const MODAL_CSS = `
    .vault-modal-overlay {
        position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
        background: rgba(0, 0, 0, 0.65); backdrop-filter: blur(4px);
        display: flex; align-items: center; justify-content: center;
        z-index: 9999999; animation: vaultFadeIn 0.15s ease-out;
    }
    .vault-modal-card {
        width: 720px; max-width: 94vw; max-height: 88vh;
        background: var(--bgColor-default, #0d1117);
        color: var(--fgColor-default, #e6edf3);
        border: 1px solid var(--borderColor-default, #30363d);
        border-radius: 12px; box-shadow: 0 16px 36px rgba(0,0,0,0.5);
        display: flex; flex-direction: column; overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    }
    .vault-modal-header {
        padding: 14px 20px; border-bottom: 1px solid var(--borderColor-default, #30363d);
        display: flex; align-items: center; justify-content: space-between;
        background: var(--bgColor-muted, #161b22);
    }
    .vault-modal-header h3 {
        margin: 0; font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px;
    }
    .vault-close-btn {
        background: transparent; border: none; color: var(--fgColor-muted, #8b949e);
        font-size: 18px; cursor: pointer; border-radius: 6px; padding: 2px 8px;
    }
    .vault-close-btn:hover { background: rgba(255,255,255,0.1); color: var(--fgColor-default, #fff); }
    .vault-nav-tabs {
        display: flex; gap: 4px; padding: 10px 20px 0; border-bottom: 1px solid var(--borderColor-default, #30363d);
        background: var(--bgColor-muted, #161b22);
    }
    .vault-tab {
        padding: 8px 16px; font-size: 13px; font-weight: 500; cursor: pointer;
        border-bottom: 2px solid transparent; color: var(--fgColor-muted, #8b949e);
    }
    .vault-tab.active {
        color: var(--fgColor-default, #fff); border-bottom-color: #f78166; font-weight: 600;
    }
    .vault-modal-body {
        padding: 18px 20px; overflow-y: auto; flex: 1; min-height: 320px;
    }

    /* 过滤与排序工具条样式 */
    .vault-toolbar {
        display: flex; flex-direction: column; gap: 10px; margin-bottom: 14px;
        background: var(--bgColor-muted, #161b22); border: 1px solid var(--borderColor-default, #30363d);
        border-radius: 8px; padding: 12px;
    }
    .vault-filter-row {
        display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    }
    .vault-search-wrap {
        position: relative; flex: 1; min-width: 180px;
    }
    .vault-search-input {
        width: 100%; padding: 6px 12px 6px 30px; border-radius: 6px;
        border: 1px solid var(--borderColor-default, #30363d);
        background: var(--bgColor-default, #0d1117); color: var(--fgColor-default, #e6edf3);
        box-sizing: border-box; font-size: 12px;
    }
    .vault-search-input:focus { outline: none; border-color: #58a6ff; }
    .vault-select {
        padding: 6px 10px; border-radius: 6px; font-size: 12px;
        border: 1px solid var(--borderColor-default, #30363d);
        background: var(--bgColor-default, #0d1117); color: var(--fgColor-default, #e6edf3);
        cursor: pointer; outline: none;
    }
    .vault-select:focus { border-color: #58a6ff; }

    .vault-item-card {
        background: var(--bgColor-muted, #161b22); border: 1px solid var(--borderColor-default, #30363d);
        border-radius: 8px; padding: 12px 14px; margin-bottom: 8px;
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        transition: border-color 0.15s ease;
    }
    .vault-item-card:hover { border-color: #58a6ff; }
    .vault-tag {
        font-size: 11px; padding: 2px 6px; border-radius: 4px; font-weight: 600; text-transform: uppercase;
    }
    .vault-tag-git { background: rgba(56, 139, 253, 0.15); color: #58a6ff; border: 1px solid rgba(56, 139, 253, 0.4); }
    .vault-tag-crate { background: rgba(219, 109, 40, 0.15); color: #f0883e; border: 1px solid rgba(219, 109, 40, 0.4); }
    .vault-input {
        width: 100%; padding: 8px 12px; border-radius: 6px; margin-bottom: 14px;
        border: 1px solid var(--borderColor-default, #30363d);
        background: var(--bgColor-default, #0d1117); color: var(--fgColor-default, #e6edf3);
        box-sizing: border-box; font-size: 13px;
    }
    .vault-input:focus { outline: none; border-color: #58a6ff; box-shadow: 0 0 0 3px rgba(88,166,255,0.3); }
    .vault-btn {
        padding: 5px 12px; border-radius: 6px; font-size: 12px; font-weight: 500;
        cursor: pointer; border: 1px solid var(--borderColor-default, #30363d);
        background: var(--bgColor-muted, #21262d); color: var(--fgColor-default, #c9d1d9);
        display: inline-flex; align-items: center; gap: 6px;
    }
    .vault-btn:hover { background: #30363d; }
    .vault-btn-primary { background: #238636; border-color: rgba(240,246,252,0.1); color: #fff; }
    .vault-btn-primary:hover { background: #2ea043; }
    .vault-btn-danger { background: transparent; border-color: rgba(248,81,73,0.4); color: #f85149; }
    .vault-btn-danger:hover { background: rgba(248,81,73,0.15); border-color: #f85149; }
    .vault-toast {
        position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
        padding: 8px 18px; border-radius: 20px; font-size: 12px; font-weight: 500;
        background: #1f6feb; color: #fff; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
        pointer-events: none; opacity: 0; transition: opacity 0.2s ease;
    }
    .vault-toast.show { opacity: 1; }
    @keyframes vaultFadeIn { from { opacity: 0; transform: scale(0.97); } to { opacity: 1; transform: scale(1); } }
    `;

    // 注入样式
    const styleEl = document.createElement('style');
    styleEl.textContent = MODAL_CSS;
    document.head.appendChild(styleEl);

    // 发起 Worker API 请求封装
    function callApi(endpoint, method = 'GET', body = null) {
        const config = getConfig();
        if (!config.workerUrl || config.workerUrl.includes('your-worker-subdomain')) {
            return Promise.reject(new Error('请先在设置页配置您的 Cloudflare Worker 完整地址！'));
        }

        const url = `${config.workerUrl}${endpoint}`;
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url,
                headers: {
                    'Content-Type': 'application/json',
                    'X-Vault-Key': config.secretKey
                },
                data: body ? JSON.stringify(body) : null,
                timeout: 10000,
                onload: (res) => {
                    let json = {};
                    try { json = JSON.parse(res.responseText || '{}'); } catch {}
                    if (res.status >= 200 && res.status < 300 && json.success !== false) {
                        resolve(json);
                    } else {
                        reject(new Error(json.error || `请求失败 [HTTP ${res.status}]`));
                    }
                },
                onerror: (e) => reject(new Error('网络连接超时或无法触达 Worker')),
                ontimeout: () => reject(new Error('连接超时，请检查网络或 Worker 地址'))
            });
        });
    }

    // 弹出右键控制台面板
    function openDashboardModal() {
        if (document.getElementById('vault-modal-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'vault-modal-overlay';
        overlay.className = 'vault-modal-overlay';

        overlay.innerHTML = `
        <div class="vault-modal-card">
            <div class="vault-modal-header">
                <h3>${ARCHIVE_ICON} <span>Vault 备份中枢控制台</span></h3>
                <button type="button" class="vault-close-btn" id="vault-close-btn">✕</button>
            </div>
            <div class="vault-nav-tabs">
                <div class="vault-tab active" id="vault-tab-repos">📋 备份清单管理</div>
                <div class="vault-tab" id="vault-tab-settings">⚙️ Worker 网关配置</div>
            </div>
            <div class="vault-modal-body" id="vault-modal-body">
                <!-- 动态内容渲染区 -->
            </div>
            <div id="vault-modal-toast" class="vault-toast">提示信息</div>
        </div>
        `;

        document.body.appendChild(overlay);

        function showToast(text, duration = 2500) {
            const toast = document.getElementById('vault-modal-toast');
            if (!toast) return;
            toast.innerText = text;
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), duration);
        }

        function closeModal() {
            overlay.remove();
        }

        overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
        document.getElementById('vault-close-btn').onclick = closeModal;

        // 全局状态缓存，用于即时 filter 和 sort
        let rawReposList = [];
        let filterState = {
            search: '',
            type: 'all',
            access: 'all',
            sort: 'default'
        };

        // Tab 1: 渲染清单列表 (含 Filter & Sort)
        async function renderReposTab() {
            const body = document.getElementById('vault-modal-body');
            body.innerHTML = `<div style="text-align:center; padding: 50px; color: var(--fgColor-muted, #8b949e);">⏳ 正在从私有配置仓读取清单...</div>`;

            try {
                const res = await callApi('/api/repos');
                rawReposList = res.data || [];
                drawReposView();
            } catch (err) {
                body.innerHTML = `
                <div style="text-align:center; padding: 40px; color: #f85149;">
                    <div style="font-size: 16px; margin-bottom: 8px;">⚠️ 读取清单失败</div>
                    <div style="font-size: 13px; opacity: 0.8; margin-bottom: 16px;">${err.message}</div>
                    <button type="button" class="vault-btn" id="vault-goto-settings-btn">👉 前往配置 Worker 凭证</button>
                </div>
                `;
                const gotoBtn = document.getElementById('vault-goto-settings-btn');
                if (gotoBtn) gotoBtn.onclick = () => switchTab('settings');
            }
        }

        // 执行过滤与排序算法并刷新 DOM
        function drawReposView() {
            const body = document.getElementById('vault-modal-body');

            // 1. 过滤 (Filter)
            let filtered = rawReposList.filter(item => {
                const targetName = (item.target_repo || item.crate_name || '').toLowerCase();
                const upstream = (item.upstream || item.homepage || '').toLowerCase();
                const keyword = filterState.search.toLowerCase().trim();

                // 关键字匹配
                if (keyword && !targetName.includes(keyword) && !upstream.includes(keyword)) {
                    return false;
                }
                // 类型筛选
                if (filterState.type !== 'all' && item.type !== filterState.type) {
                    return false;
                }
                // 权限筛选
                if (filterState.access === 'private' && !item.private) return false;
                if (filterState.access === 'public' && item.private) return false;

                return true;
            });

            // 2. 排序 (Sort)
            let sorted = [...filtered];
            switch (filterState.sort) {
                case 'name-asc':
                    sorted.sort((a, b) => (a.target_repo || '').localeCompare(b.target_repo || ''));
                    break;
                case 'name-desc':
                    sorted.sort((a, b) => (b.target_repo || '').localeCompare(a.target_repo || ''));
                    break;
                case 'type-git':
                    sorted.sort((a, b) => (a.type === 'git' ? -1 : 1));
                    break;
                case 'type-crate':
                    sorted.sort((a, b) => (a.type === 'crate' ? -1 : 1));
                    break;
                default:
                    // default 保持原样
                    break;
            }

            // 3. 构建整个页面结构
            let html = `
            <div class="vault-toolbar">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div style="font-size: 13px; color: var(--fgColor-muted, #8b949e);">
                        组织共有 <strong>${rawReposList.length}</strong> 个仓库 (当前显示 <strong>${sorted.length}</strong> 项)
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <button type="button" class="vault-btn" id="vault-refresh-btn">🔄 刷新</button>
                        <button type="button" class="vault-btn vault-btn-primary" id="vault-sync-btn">🚀 立即触发全局同步</button>
                    </div>
                </div>

                <!-- 🌟 过滤与排序控件排 -->
                <div class="vault-filter-row">
                    <div class="vault-search-wrap">
                        ${SEARCH_ICON}
                        <input type="text" id="vault-filter-search" class="vault-search-input" 
                               placeholder="搜索仓库名、上游地址..." value="${escapeHtml(filterState.search)}" />
                    </div>

                    <select id="vault-filter-type" class="vault-select">
                        <option value="all" ${filterState.type === 'all' ? 'selected' : ''}>类型: 全部</option>
                        <option value="git" ${filterState.type === 'git' ? 'selected' : ''}>类型: Git 镜像</option>
                        <option value="crate" ${filterState.type === 'crate' ? 'selected' : ''}>类型: Crate 包</option>
                    </select>

                    <select id="vault-filter-access" class="vault-select">
                        <option value="all" ${filterState.access === 'all' ? 'selected' : ''}>权限: 全部</option>
                        <option value="private" ${filterState.access === 'private' ? 'selected' : ''}>权限: 🔒 私有 (Private)</option>
                        <option value="public" ${filterState.access === 'public' ? 'selected' : ''}>权限: 🌐 公开 (Public)</option>
                    </select>

                    <select id="vault-filter-sort" class="vault-select">
                        <option value="default" ${filterState.sort === 'default' ? 'selected' : ''}>排序: 默认顺序</option>
                        <option value="name-asc" ${filterState.sort === 'name-asc' ? 'selected' : ''}>排序: 名称 A-Z</option>
                        <option value="name-desc" ${filterState.sort === 'name-desc' ? 'selected' : ''}>排序: 名称 Z-A</option>
                        <option value="type-git" ${filterState.sort === 'type-git' ? 'selected' : ''}>排序: Git 镜像优先</option>
                        <option value="type-crate" ${filterState.sort === 'type-crate' ? 'selected' : ''}>排序: Crate 包优先</option>
                    </select>
                </div>
            </div>

            <div id="vault-list-container">
            `;

            if (sorted.length === 0) {
                html += `
                <div style="text-align:center; padding: 40px 0; color: #8b949e;">
                    ${rawReposList.length === 0 ? '暂无任何备份项目，可点击页面顶栏的 [备份] 按钮快速添加！' : '未找到匹配筛选条件的仓库'}
                </div>`;
            } else {
                sorted.forEach(item => {
                    const isGit = item.type === 'git';
                    const tagClass = isGit ? 'vault-tag-git' : 'vault-tag-crate';
                    const targetName = item.target_repo || item.crate_name;
                    const subUrl = item.upstream || item.homepage || '';

                    html += `
                    <div class="vault-item-card" data-repo="${escapeHtml(targetName)}">
                        <div style="min-width: 0; flex: 1;">
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                                <span class="vault-tag ${tagClass}">${item.type}</span>
                                <strong style="font-size: 14px;">${escapeHtml(targetName)}</strong>
                                ${item.private ? '<span style="font-size: 11px; opacity: 0.6;">🔒 Private</span>' : '<span style="font-size: 11px; opacity: 0.6;">🌐 Public</span>'}
                            </div>
                            <div style="font-size: 12px; color: var(--fgColor-muted, #8b949e); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
                                ${escapeHtml(subUrl)}
                            </div>
                        </div>
                        <div>
                            <button type="button" class="vault-btn vault-btn-danger vault-delete-item-btn" data-target="${escapeHtml(targetName)}">
                                🗑️ 移除
                            </button>
                        </div>
                    </div>
                    `;
                });
            }

            html += `</div>`;
            body.innerHTML = html;

            // 绑定工具栏交互事件
            const searchInput = document.getElementById('vault-filter-search');
            searchInput.oninput = (e) => {
                filterState.search = e.target.value;
                drawReposView();
                // 保持焦点在输入框末尾
                const newInput = document.getElementById('vault-filter-search');
                newInput.focus();
                newInput.setSelectionRange(newInput.value.length, newInput.value.length);
            };

            document.getElementById('vault-filter-type').onchange = (e) => {
                filterState.type = e.target.value;
                drawReposView();
            };

            document.getElementById('vault-filter-access').onchange = (e) => {
                filterState.access = e.target.value;
                drawReposView();
            };

            document.getElementById('vault-filter-sort').onchange = (e) => {
                filterState.sort = e.target.value;
                drawReposView();
            };

            // 绑定刷新
            document.getElementById('vault-refresh-btn').onclick = renderReposTab;

            // 绑定手动触发同步
            document.getElementById('vault-sync-btn').onclick = async function () {
                this.disabled = true;
                this.innerText = '⏳ 触发中...';
                try {
                    await callApi('/api/sync', 'POST');
                    showToast('🎉 全局同步任务已成功派发！');
                    this.innerText = '✅ 已派发';
                } catch (e) {
                    showToast(`❌ 派发失败: ${e.message}`);
                    this.innerText = '🚀 立即触发全局同步';
                } finally {
                    setTimeout(() => { this.disabled = false; this.innerText = '🚀 立即触发全局同步'; }, 3000);
                }
            };

            // 绑定单个删除
            body.querySelectorAll('.vault-delete-item-btn').forEach(btn => {
                btn.onclick = async function () {
                    const target = this.getAttribute('data-target');
                    if (!confirm(`确定要从备份清单中移除 [${target}] 吗？\n(注意：不会删除实际仓库)`)) return;

                    this.disabled = true;
                    this.innerText = '移除中...';
                    try {
                        await callApi('/api/repos', 'DELETE', { target_repo: target });
                        showToast(`✅ 已成功移除 ${target}`);
                        renderReposTab();
                    } catch (err) {
                        showToast(`❌ 移除失败: ${err.message}`);
                        this.disabled = false;
                        this.innerText = '🗑️ 移除';
                    }
                };
            });
        }

        // Tab 2: 渲染配置页
        function renderSettingsTab() {
            const config = getConfig();
            const body = document.getElementById('vault-modal-body');

            body.innerHTML = `
            <div style="max-width: 520px; margin: 0 auto; padding: 10px 0;">
                <label style="display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px;">
                    Cloudflare Worker 网关地址:
                </label>
                <input type="text" id="vault-cfg-url" class="vault-input" 
                       placeholder="https://owwk-backup-bridge.yourname.workers.dev" 
                       value="${config.workerUrl.includes('your-worker-subdomain') ? '' : escapeHtml(config.workerUrl)}" />

                <label style="display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px;">
                    通信口令密钥 (X-Vault-Key):
                </label>
                <input type="password" id="vault-cfg-key" class="vault-input" 
                       placeholder="输入在 Worker Secrets 中配置的 VAULT_SECRET_KEY" 
                       value="${escapeHtml(config.secretKey)}" />

                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 10px;">
                    <button type="button" class="vault-btn" id="vault-test-btn">⚡ 测试连接</button>
                    <button type="button" class="vault-btn vault-btn-primary" id="vault-save-btn">💾 保存配置</button>
                </div>
                <div id="vault-ping-result" style="margin-top: 14px; font-size: 12px;"></div>
            </div>
            `;

            // 保存配置
            document.getElementById('vault-save-btn').onclick = () => {
                const url = document.getElementById('vault-cfg-url').value;
                const key = document.getElementById('vault-cfg-key').value;
                setConfig(url, key);
                showToast('✅ 配置保存成功！');
            };

            // 测试连接
            document.getElementById('vault-test-btn').onclick = async function () {
                const url = document.getElementById('vault-cfg-url').value;
                const key = document.getElementById('vault-cfg-key').value;
                setConfig(url, key);

                const resDiv = document.getElementById('vault-ping-result');
                resDiv.innerHTML = `<span style="color:#8b949e;">⏳ 正在测试连接 Cloudflare Worker...</span>`;

                try {
                    const res = await callApi('/api/ping');
                    resDiv.innerHTML = `<span style="color:#2da44e;">✅ 连接成功！Worker 正常运转 (组织: ${res.org || 'ok'})</span>`;
                    showToast('🎉 连接测试通过！');
                } catch (e) {
                    resDiv.innerHTML = `<span style="color:#f85149;">❌ 连接失败: ${e.message}</span>`;
                }
            };
        }

        // 标签切换逻辑
        function switchTab(tabName) {
            const tabRepos = document.getElementById('vault-tab-repos');
            const tabSettings = document.getElementById('vault-tab-settings');

            if (tabName === 'repos') {
                tabRepos.classList.add('active');
                tabSettings.classList.remove('active');
                renderReposTab();
            } else {
                tabSettings.classList.add('active');
                tabRepos.classList.remove('active');
                renderSettingsTab();
            }
        }

        document.getElementById('vault-tab-repos').onclick = () => switchTab('repos');
        document.getElementById('vault-tab-settings').onclick = () => switchTab('settings');

        // 初始打开清单页
        renderReposTab();
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // 左键点击一键备份当前页面
    function triggerQuickBackup(btn, textSpan) {
        const config = getConfig();
        if (!config.workerUrl || config.workerUrl.includes('your-worker-subdomain')) {
            openDashboardModal();
            return;
        }

        btn.disabled = true;
        btn.style.opacity = '0.7';
        textSpan.innerText = '提交中...';

        callApi('/api/repos', 'POST', { url: window.location.href })
            .then(() => {
                textSpan.innerText = '已在队列';
                btn.style.color = '#2da44e';
                btn.style.borderColor = '#2da44e';
                setTimeout(() => {
                    btn.disabled = false;
                    btn.style.opacity = '1';
                    textSpan.innerText = '备份';
                    btn.style.color = '';
                    btn.style.borderColor = '';
                }, 3500);
            })
            .catch((err) => {
                textSpan.innerText = '提交失败';
                btn.style.color = '#cf222e';
                console.error('[Vault Quick Backup Error]', err);
                setTimeout(() => {
                    btn.disabled = false;
                    btn.style.opacity = '1';
                    textSpan.innerText = '备份';
                    btn.style.color = '';
                    btn.style.borderColor = '';
                }, 3000);
            });
    }

    // 核心注入函数
    function injectGitHub() {
        if (document.getElementById('vault-backup-action-item')) return true;

        const container = document.querySelector('[data-testid="repo-header-actions"]') ||
                          document.querySelector('[data-testid="notifications-subscriptions-menu-button"]')?.closest('ul') ||
                          document.querySelector('[data-testid="fork-button"]')?.closest('ul') ||
                          document.querySelector('[data-testid="star-button"]')?.closest('ul') ||
                          document.querySelector('ul.pagehead-actions');

        if (!container) return false;

        const li = document.createElement('li');
        li.id = 'vault-backup-action-item';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-component', 'Button');
        btn.setAttribute('data-size', 'small');
        btn.setAttribute('data-variant', 'default');
        btn.className = 'prc-Button-ButtonBase-9n-Xk btn-sm btn';
        btn.title = '左键：一键备份到 Vault\n右键：打开管理控制台（多维筛选、排序、配置）';
        btn.style.cursor = 'pointer';

        btn.innerHTML = `
            <span data-component="buttonContent" data-align="center" class="prc-Button-ButtonContent-Iohp5">
                <span data-component="leadingVisual" class="prc-Button-Visual-YNt2F prc-Button-LeadingVisual-UySKu prc-Button-VisualWrap-E4cnq" style="margin-right: 4px;">
                    ${ARCHIVE_ICON}
                </span>
                <span data-component="text" class="prc-Button-Label-FWkx3 vault-btn-text" style="font-weight: 600;">备份</span>
            </span>
        `;

        const textSpan = btn.querySelector('.vault-btn-text');

        // 左键：一键快速加入备份
        btn.onclick = (e) => {
            e.preventDefault();
            triggerQuickBackup(btn, textSpan);
        };

        // 右键：唤出高级控制台 (含筛选与排序)
        btn.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            openDashboardModal();
        };

        li.appendChild(btn);
        container.insertBefore(li, container.firstChild);
        return true;
    }

    function checkAndInject() {
        const host = location.hostname;
        if (host.includes('github.com')) {
            return injectGitHub();
        }
        return false;
    }

    // 监听与保底
    checkAndInject();
    const timer = setInterval(() => {
        if (checkAndInject()) clearInterval(timer);
    }, 300);

    document.addEventListener('turbo:render', checkAndInject);
    document.addEventListener('turbo:load', checkAndInject);
    document.addEventListener('pjax:end', checkAndInject);

    // 注册油猴原生菜单作为兜底入口
    GM_registerMenuCommand("⚡ 打开 Vault 备份控制台", openDashboardModal);
})();
