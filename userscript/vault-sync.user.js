// ==UserScript==
// @name         Vault 一键备份助手 (原生 GitHub 风格版)
// @namespace    https://github.com/owwk-backup
// @version      1.4.0
// @description  在 GitHub 顶栏原生嵌入“备份到 Vault”按钮，秒级异步入库
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
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    console.log('%c[Vault Userscript] 🚀 脚本已激活！当前地址:', 'color: #1f6feb; font-weight: bold;', location.href);

    function getConfig() {
        return {
            workerUrl: GM_getValue('CF_WORKER_URL', 'https://your-worker-subdomain.workers.dev'),
            secretKey: GM_getValue('CF_SECRET_KEY', 'your-secret-key')
        };
    }

    GM_registerMenuCommand("⚙️ 配置 Cloudflare Worker 地址与密钥", () => {
        const current = getConfig();
        const url = prompt("请输入 Cloudflare Worker 完整地址：", current.workerUrl);
        if (url) GM_setValue('CF_WORKER_URL', url.trim());
        const key = prompt("请输入自设通信密钥 (X-Vault-Key)：", current.secretKey);
        if (key) GM_setValue('CF_SECRET_KEY', key.trim());
        alert("✅ 配置已保存！");
    });

    const ARCHIVE_ICON = `
    <svg aria-hidden="true" height="16" viewBox="0 0 16 16" version="1.1" width="16" class="octicon octicon-archive mr-1" style="vertical-align: text-bottom; fill: currentColor;">
        <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v1.5A1.75 1.75 0 0 1 13.25 6H13v6.25A2.75 2.75 0 0 1 10.25 15h-4.5A2.75 2.75 0 0 1 3 12.25V6h-.25A1.75 1.75 0 0 1 1 4.25v-1.5Zm1.75-.25a.25.25 0 0 0-.25.25v1.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-1.5a.25.25 0 0 0-.25-.25H2.75ZM4.5 6v6.25c0 .69.56 1.25 1.25 1.25h4.5c.69 0 1.25-.56 1.25-1.25V6H4.5ZM6.75 7.75a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5a.75.75 0 0 1 .75-.75Zm3.25.75a.75.75 0 0 0-1.5 0v1.5a.75.75 0 0 0 1.5 0v-1.5Z"></path>
    </svg>`;

    function triggerBackup(btn, textSpan) {
        const config = getConfig();
        if (!config.workerUrl || config.workerUrl.includes('your-worker-subdomain')) {
            const url = prompt("首次使用，请输入您的 Cloudflare Worker 完整地址：", "");
            if (!url) return;
            GM_setValue('CF_WORKER_URL', url.trim());
            const key = prompt("请输入通信密钥 (X-Vault-Key)：", "");
            if (key) GM_setValue('CF_SECRET_KEY', key.trim());
            return triggerBackup(btn, textSpan);
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
            timeout: 8000,
            onload: (res) => {
                if (res.status === 200) {
                    textSpan.innerText = '已在队列';
                    btn.style.color = '#2da44e';
                    btn.style.borderColor = '#2da44e';
                } else {
                    textSpan.innerText = '提交失败';
                    btn.style.color = '#cf222e';
                    console.error('[Vault Userscript]', res.responseText);
                }
                setTimeout(() => {
                    btn.disabled = false;
                    btn.style.opacity = '1';
                    textSpan.innerText = '备份';
                    btn.style.color = '';
                    btn.style.borderColor = '';
                }, 3500);
            },
            onerror: (err) => {
                textSpan.innerText = '网络错误';
                console.error('[Vault Userscript]', err);
                setTimeout(() => {
                    btn.disabled = false;
                    btn.style.opacity = '1';
                    textSpan.innerText = '备份';
                }, 3000);
            }
        });
    }

    // 核心注入函数
    function injectGitHub() {
        if (document.getElementById('vault-backup-action-item')) return true;

        // 万能多级定位：支持任意结构
        const container = document.querySelector('ul.pagehead-actions') ||
                          document.querySelector('.pagehead-actions') ||
                          document.querySelector('#repository-details-container ul') ||
                          document.querySelector('#star-button')?.closest('ul') ||
                          document.querySelector('#fork-button')?.closest('ul') ||
                          document.querySelector('#repository-details-watch-button')?.closest('ul');

        if (!container) {
            return false;
        }

        console.log('%c[Vault Userscript] 🎉 成功定位顶栏容器，开始注入按钮！', 'color: #2da44e; font-weight: bold;', container);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-sm';
        btn.title = '将当前项目无感镜像备份至 owwk-backup 组织';
        btn.style.display = 'inline-flex';
        btn.style.alignItems = 'center';
        btn.style.marginRight = '8px';
        btn.style.cursor = 'pointer';

        btn.innerHTML = `${ARCHIVE_ICON}<span class="vault-btn-text" style="font-weight: 600;">备份</span>`;
        const textSpan = btn.querySelector('.vault-btn-text');
        btn.onclick = () => triggerBackup(btn, textSpan);

        if (container.tagName === 'UL') {
            const li = document.createElement('li');
            li.id = 'vault-backup-action-item';
            li.appendChild(btn);
            container.insertBefore(li, container.firstChild);
        } else {
            btn.id = 'vault-backup-action-item';
            container.insertBefore(btn, container.firstChild);
        }

        return true;
    }

    function injectCratesIo() {
        if (document.getElementById('vault-backup-action-item')) return true;
        const installSection = document.querySelector('[data-test-install]');
        if (!installSection) return false;

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
        return true;
    }

    function checkAndInject() {
        const host = location.hostname;
        if (host.includes('github.com')) {
            return injectGitHub();
        } else if (host.includes('crates.io')) {
            return injectCratesIo();
        }
        return false;
    }

    // 1. 立即执行一次
    checkAndInject();

    // 2. 强力保底轮询（每 500ms 检查一次，一旦注入成功降低频率）
    let timer = setInterval(() => {
        const done = checkAndInject();
        if (done) {
            clearInterval(timer);
            // 之后以低频监听 SPA 路由变化
            setInterval(checkAndInject, 1500);
        }
    }, 500);

    // 3. 事件驱动
    document.addEventListener('DOMContentLoaded', checkAndInject);
    document.addEventListener('turbo:render', checkAndInject);
    document.addEventListener('turbo:load', checkAndInject);
    document.addEventListener('pjax:end', checkAndInject);
})();
