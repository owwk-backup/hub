export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 跨域预检处理
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Vault-Key'
        }
      });
    }

    const corsHeaders = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    };

    // 鉴权中间件
    const clientKey = request.headers.get('X-Vault-Key');
    if (env.VAULT_SECRET_KEY && clientKey !== env.VAULT_SECRET_KEY) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized: 通信密钥错误' }), {
        status: 401,
        headers: corsHeaders
      });
    }

    const ORG = env.GITHUB_ORG || 'owwk-backup';
    const CONFIG_REPO = env.CONFIG_REPO || 'config';
    const HUB_REPO = env.HUB_REPO || 'hub';
    const PAT = env.GITHUB_PAT;

    const ghHeaders = {
      'Authorization': `Bearer ${PAT}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'Cloudflare-Worker-Vault-Bridge'
    };

    try {
      // 1. [PING] 服务健康检查与凭据测试
      if (url.pathname === '/api/ping' || url.pathname === '/api/status') {
        return new Response(JSON.stringify({
          success: true,
          message: 'Pong',
          org: ORG,
          timestamp: new Date().toISOString()
        }), { headers: corsHeaders });
      }

      // 2. [GET] 查询当前配置清单
      if (request.method === 'GET' && (url.pathname === '/api/repos' || url.pathname === '/api/list')) {
        const { list } = await getRemoteConfig(ORG, CONFIG_REPO, ghHeaders);
        return new Response(JSON.stringify({ success: true, count: list.length, data: list }), { headers: corsHeaders });
      }

      // 3. [POST] 添加备份项目 (支持传入 url 自动解析，或直接传入完整 item)
      if (request.method === 'POST' && url.pathname === '/api/repos') {
        const body = await request.json().catch(() => ({}));
        let itemToAdd = body.item;

        if (!itemToAdd && body.url) {
          itemToAdd = parsePageInfo(body.url);
        }

        if (!itemToAdd || !itemToAdd.target_repo) {
          return new Response(JSON.stringify({ success: false, error: '未能解析出有效目标' }), { status: 400, headers: corsHeaders });
        }

        const { list, sha } = await getRemoteConfig(ORG, CONFIG_REPO, ghHeaders);
        const exists = list.some(x => x.target_repo === itemToAdd.target_repo);

        if (exists) {
          return new Response(JSON.stringify({ success: true, message: '已存在于清单中，无需重复添加', data: itemToAdd }), { headers: corsHeaders });
        }

        list.push(itemToAdd);
        await saveRemoteConfig(ORG, CONFIG_REPO, list, sha, `chore: add ${itemToAdd.target_repo} via worker`, ghHeaders);

        // 异步触发 Action
        if (body.triggerSync !== false) {
          ctx.waitUntil(triggerDispatch(ORG, HUB_REPO, ghHeaders));
        }

        return new Response(JSON.stringify({ success: true, message: '添加成功并已排入同步队列', data: itemToAdd }), { headers: corsHeaders });
      }

      // 4. [DELETE] 删除指定备份项目
      if (request.method === 'DELETE' && url.pathname === '/api/repos') {
        const body = await request.json().catch(() => ({}));
        const targetRepo = body.target_repo;

        if (!targetRepo) {
          return new Response(JSON.stringify({ success: false, error: '缺少 target_repo' }), { status: 400, headers: corsHeaders });
        }

        const { list, sha } = await getRemoteConfig(ORG, CONFIG_REPO, ghHeaders);
        const filtered = list.filter(x => x.target_repo !== targetRepo);

        if (filtered.length === list.length) {
          return new Response(JSON.stringify({ success: false, error: '未找到指定项目' }), { status: 404, headers: corsHeaders });
        }

        await saveRemoteConfig(ORG, CONFIG_REPO, filtered, sha, `chore: remove ${targetRepo} via worker`, ghHeaders);
        return new Response(JSON.stringify({ success: true, message: `已从清单移除 ${targetRepo}` }), { headers: corsHeaders });
      }

      // 5. [PUT] 修改更新指定项目属性
      if (request.method === 'PUT' && url.pathname === '/api/repos') {
        const body = await request.json().catch(() => ({}));
        const { target_repo, updateData } = body;

        if (!target_repo || !updateData) {
          return new Response(JSON.stringify({ success: false, error: '参数不完整' }), { status: 400, headers: corsHeaders });
        }

        const { list, sha } = await getRemoteConfig(ORG, CONFIG_REPO, ghHeaders);
        const index = list.findIndex(x => x.target_repo === target_repo);

        if (index === -1) {
          return new Response(JSON.stringify({ success: false, error: '未找到指定项目' }), { status: 404, headers: corsHeaders });
        }

        list[index] = { ...list[index], ...updateData };
        await saveRemoteConfig(ORG, CONFIG_REPO, list, sha, `chore: update ${target_repo} via worker`, ghHeaders);
        return new Response(JSON.stringify({ success: true, message: `已更新 ${target_repo}`, data: list[index] }), { headers: corsHeaders });
      }

      // 6. [POST /api/sync] 手动触发一次全局同步 Action
      if (request.method === 'POST' && url.pathname === '/api/sync') {
        await triggerDispatch(ORG, HUB_REPO, ghHeaders);
        return new Response(JSON.stringify({ success: true, message: '全局同步任务已触发启动' }), { headers: corsHeaders });
      }

      return new Response(JSON.stringify({ error: 'Endpoint Not Found' }), { status: 404, headers: corsHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: corsHeaders });
    }
  }
};

// 帮助函数：从私有仓读取 repos.json
async function getRemoteConfig(org, repo, headers) {
  const res = await fetch(`https://api.github.com/repos/${org}/${repo}/contents/repos.json`, { headers });
  if (!res.ok) throw new Error(`读取配置仓失败: ${res.statusText}`);
  const data = await res.json();
  const list = JSON.parse(atob(data.content.replace(/\s/g, '')));
  return { list, sha: data.sha };
}

// 帮助函数：写回私有仓
async function saveRemoteConfig(org, repo, list, sha, message, headers) {
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(list, null, 2))));
  const res = await fetch(`https://api.github.com/repos/${org}/${repo}/contents/repos.json`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ message, content, sha })
  });
  if (!res.ok) throw new Error(`写回配置仓失败: ${res.statusText}`);
}

// 帮助函数：触发 Action 并严格检查响应
async function triggerDispatch(org, repo, headers) {
  const url = `https://api.github.com/repos/${org}/${repo}/actions/workflows/sync.yml/dispatches`;
  console.log(`[Dispatch] 发起触发请求: ${url}`);
  
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ref: 'main' })
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error(`❌ [Dispatch Failed HTTP ${res.status}]`, errorText);
    throw new Error(`触发 GitHub Action 失败 [HTTP ${res.status}]: ${errorText}`);
  }

  console.log(`✅ [Dispatch Success] Action 同步工作流已成功触发！(HTTP ${res.status})`);
}

// 智能页面 URL 解析
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
