export default {
  async fetch(request, env, ctx) {
    // 跨域处理
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Vault-Key'
        }
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // 校验通信口令
    const clientKey = request.headers.get('X-Vault-Key');
    if (env.VAULT_SECRET_KEY && clientKey !== env.VAULT_SECRET_KEY) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    const { url } = await request.json().catch(() => ({}));
    if (!url) {
      return new Response(JSON.stringify({ error: 'Missing url' }), { status: 400 });
    }

    // 利用 waitUntil 实现后台异步并发，极速响应前端
    ctx.waitUntil(processAddToBackup(url, env));

    return new Response(JSON.stringify({ success: true, message: 'Queued' }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
};

// 后台异步：读取私有 config 仓 -> 查重追加 -> 触发公开 hub 仓 Action
async function processAddToBackup(pageUrl, env) {
  const ORG = env.GITHUB_ORG || 'owwk-backup';
  const CONFIG_REPO = env.CONFIG_REPO || 'config';
  const HUB_REPO = env.HUB_REPO || 'hub';
  const PAT = env.GITHUB_PAT;

  const parsed = parsePageInfo(pageUrl);
  if (!parsed) return;

  const headers = {
    'Authorization': `Bearer ${PAT}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'Cloudflare-Worker-Vault-Bridge'
  };

  try {
    // 1. 获取私有仓 config/repos.json
    const getRes = await fetch(`https://api.github.com/repos/${ORG}/${CONFIG_REPO}/contents/repos.json`, { headers });
    if (!getRes.ok) throw new Error(`Fetch config failed: ${getRes.statusText}`);

    const fileData = await getRes.json();
    const list = JSON.parse(atob(fileData.content.replace(/\s/g, '')));

    // 2. 查重
    const isExisted = list.some(item =>
      (item.type === 'git' && item.upstream === parsed.upstream) ||
      (item.type === 'crate' && item.crate_name === parsed.crate_name)
    );
    if (isExisted) {
      console.log(`[Worker] Target already exists: ${parsed.target_repo}`);
      return;
    }

    // 3. 追加并写回私有仓
    list.push(parsed);
    const newContentBase64 = btoa(unescape(encodeURIComponent(JSON.stringify(list, null, 2))));

    const updateRes = await fetch(`https://api.github.com/repos/${ORG}/${CONFIG_REPO}/contents/repos.json`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `chore: add ${parsed.target_repo} to backup list`,
        content: newContentBase64,
        sha: fileData.sha
      })
    });
    if (!updateRes.ok) throw new Error(`Update config failed: ${updateRes.statusText}`);

    // 4. 触发公开 hub 调度仓库的 Action 同步
    await fetch(`https://api.github.com/repos/${ORG}/${HUB_REPO}/actions/workflows/sync.yml/dispatches`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ref: 'main' })
    });
    console.log(`[Worker] Successfully added & dispatched: ${parsed.target_repo}`);
  } catch (err) {
    console.error('[Worker Fatal]', err);
  }
}

// 智能 URL 解析器
function parsePageInfo(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.hostname === 'github.com') {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 2 && !['settings', 'pulls', 'issues', 'explore', 'orgs', 'notifications'].includes(parts[0])) {
        return {
          type: 'git',
          upstream: `https://github.com/${parts[0]}/${parts[1]}.git`,
          target_repo: parts[1],
          homepage: `https://github.com/${parts[0]}/${parts[1]}`,
          private: true
        };
      }
    } else if (u.hostname === 'crates.io') {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === 'crates' && parts[1]) {
        return {
          type: 'crate',
          crate_name: parts[1],
          target_repo: parts[1],
          homepage: `https://crates.io/crates/${parts[1]}`,
          private: true
        };
      }
    }
  } catch {}
  return null;
}
