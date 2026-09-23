// ==UserScript==
// @name         Vault 一键备份助手 (原生 GitHub 风格版)
// @namespace    https://github.com/owwk-backup
// @version      1.1.0
// @description  在 GitHub 顶栏原生嵌入“备份到 Vault”按钮，秒级异步入库
// @author       owwk-backup
// @match        https://github.com/*/*
// @match        https://crates.io/crates/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    // 默认配置（可在油猴扩展菜单中随时修改）
    function getConfig() {
        return {
            workerUrl: GM_getValue('CF_WORKER_URL', 'https://your-worker-subdomain.workers.dev'),
            secretKey: GM_getValue('CF_SECRET_KEY', 'your-secret-key')
        };
    }

    // 注册右键菜单供随时修改配置
    GM_registerMenuCommand("⚙️ 配置 Cloudflare Worker 地址与密钥", () => {
        const current = getConfig();
        const url = prompt("请输入 Cloudflare Worker 完整地址：", current.workerUrl);
        if (url) GM_setValue('CF_WORKER_URL', url.trim());
        const key = prompt("请输入自设通信密钥 (X-Vault-Key)：", current.secretKey);
        if (key) GM_setValue('CF_SECRET_KEY', key.trim());
        alert("✅ 配置已保存！");
    });

    // 官方 Octicon 归档/备份 SVG 图标
    const ARCHIVE_ICON = `
    <svg aria-hidden="true" height="16" viewBox="0 0 16 16" version="1.1" width="16" class="octicon octicon-archive" style="margin-right: 5px; vertical-align: text-bottom; fill: currentColor;">
        <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v1.5A1.75 1.75 0 0 1 13.25 6H13v6.25A2.75 2.75 0 0 1 10.25 15h-4.5A2.75 2.75 0 0 1 3 12.25V6h-.25A1.75 1.75 0 0 1 1 4.25v-1.5Zm1.75-.25a.25.25 0 0 0-.25.25v1.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-1.5a.25.25 0 0 0-.25-.25H2.75ZM4.5 6v6.25c0 .69.56 1.25 1.25 1.25h4.5c.69 0 1.25-.56 1.25-1.25V6H4.5ZM6.75 7.75a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5a.75.75 0 0 1 .75-.75Zm3.25.75a.75.75 0 0 0-1.5 0v1.5a.75.75 0 0 0 1.5 0v-1.5Z"></path>
    </svg>`;

    // 触发提交任务
    function triggerBackup(btn, textSpan) {
        const config = getConfig();
        if (!config.workerUrl || config.workerUrl.includes('your-worker-subdomain')) {
            alert("⚠️ 请先在扩展菜单中配置您的 Cloudflare Worker 地址！");
            return;
        }

        btn.disabled = true;
        btn.style.opacity = '0.7';
        textSpan.innerText = '提交中...';

        GM_xmlhttpRequest({
            method: 'POST',
            url: config.workerUrl,
            headers: {
                'Content-Type': 'application/json',
                'X-Vault-Key': config.secretKey
            },
            data: JSON.stringify({ url: window.location.href }),
            timeout: 5000,
            onload: (res) => {
                if (res.status === 200) {
                    textSpan.innerText = '已在队列';
                    btn.classList.add('color-fg-success');
                    btn.style.borderColor = 'var(--button-success-borderColor-rest, #238636)';
                } else {
                    textSpan.innerText = '提交失败';
                    btn.classList.add('color-fg-danger');
                }
                setTimeout(() => {
                    btn.disabled = false;
                    btn.style.opacity = '1';
                    textSpan.innerText = '备份';
                    btn.classList.remove('color-fg-success', 'color-fg-danger');
                    btn.style.borderColor = '';
                }, 3500);
            },
            onerror: () => {
                textSpan.innerText = '网络错误';
                setTimeout(() => {
                    btn.disabled = false;
                    btn.style.opacity = '1';
                    textSpan.innerText = '备份';
                }, 3000);
            }
        });
    }

    // 注入到 GitHub 页面指定位置（Watch 按钮左侧）
    function injectGitHub() {
        if (document.getElementById('vault-backup-action-item')) return;

        // 定位 GitHub 顶栏按钮容器
        const actionsContainer = document.querySelector('ul.pagehead-actions') || 
                                 document.querySelector('#repository-details-container ul') ||
                                 document.querySelector('[data-view-component="true"].pagehead-actions');
        if (!actionsContainer) return;

        const li = document.createElement('li');
        li.id = 'vault-backup-action-item';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-sm';
        btn.title = '将当前项目无感镜像备份至 owwk-backup 组织';

        btn.innerHTML = `${ARCHIVE_ICON}<span class="vault-btn-text" style="font-weight: 600;">备份</span>`;
        const textSpan = btn.querySelector('.vault-btn-text');

        btn.onclick = () => triggerBackup(btn, textSpan);

        li.appendChild(btn);
        actionsContainer.insertBefore(li, actionsContainer.firstChild);
    }

    // 注入到 Crates.io 页面
    function injectCratesIo() {
        if (document.getElementById('vault-backup-action-item')) return;
        const installSection = document.querySelector('[data-test-install]');
        if (!installSection) return;

        const btn = document.createElement('button');
        btn.id = 'vault-backup-action-item';
        btn.innerHTML = `${ARCHIVE_ICON} <span class="vault-btn-text">备份到 Vault</span>`;
        Object.assign(btn.style, {
            display: 'inline-flex', alignItems: 'center', marginTop: '12px',
            padding: '6px 12px', backgroundColor: '#e25d22', color: '#fff',
            border: 'none', borderRadius: '4px', fontWeight: 'bold', fontSize: '13px', cursor: 'pointer'
        });

        const textSpan = btn.querySelector('.vault-btn-text');
        btn.onclick = () => triggerBackup(btn, textSpan);
        installSection.parentElement.insertBefore(btn, installSection.nextSibling);
    }

    function checkAndInject() {
        if (location.host === 'github.com') {
            injectGitHub();
        } else if (location.host === 'crates.io') {
            injectCratesIo();
        }
    }

    // 兼容 GitHub SPA (Turbo / PJAX) 无刷新页面切换
    document.addEventListener('turbo:render', checkAndInject);
    document.addEventListener('pjax:end', checkAndInject);
    setInterval(checkAndInject, 1200);
})();
