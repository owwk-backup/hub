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

    let ghHeaders;
    try {
      ghHeaders = await getGitHubHeaders(env);
    } catch (e) {
      const rawKey = env.GITHUB_APP_PRIVATE_KEY || '';
      return new Response(JSON.stringify({
        success: false,
        error: `GitHub 凭据初始化失败: ${e.message}`,
        debug: {
          hasAppId: !!env.GITHUB_APP_ID,
          hasInstId: !!env.GITHUB_APP_INSTALLATION_ID,
          hasKey: !!env.GITHUB_APP_PRIVATE_KEY,
          keyLength: rawKey.length,
          keyStart: rawKey.slice(0, 35),
          keyEnd: rawKey.slice(-35),
          hasRsaHeader: rawKey.includes('BEGIN RSA PRIVATE KEY'),
          hasPkcs8Header: rawKey.includes('BEGIN PRIVATE KEY'),
          errorDetails: e.stack || e.message
        }
      }), {
        status: 500,
        headers: corsHeaders
      });
    }

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

// 统一凭据解析器：优先使用 GitHub App，回退使用个人 PAT
async function getGitHubHeaders(env) {
  let token = env.GITHUB_PAT;

  if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_INSTALLATION_ID) {
    token = await getAppInstallationToken(
      env.GITHUB_APP_ID,
      env.GITHUB_APP_PRIVATE_KEY,
      env.GITHUB_APP_INSTALLATION_ID
    );
  }

  if (!token) {
    throw new Error('未配置有效的 GitHub App 凭据或 GITHUB_PAT');
  }

  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'Cloudflare-Worker-Vault-Bridge'
  };
}

// 通过 WebCrypto 签署 JWT 并换取 GitHub App 临时安装令牌 (Installation Token)
async function getAppInstallationToken(appId, privateKeyPem, installationId) {
  const jwt = await generateAppJWT(appId, privateKeyPem);
  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'Cloudflare-Worker-Vault-Bridge'
    }
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`获取 GitHub App Installation Token 失败 [HTTP ${res.status}]: ${errText}`);
  }

  const data = await res.json();
  return data.token;
}

// 基于纯原生 WebCrypto (0 第三方依赖) 生成 RS256 JWT
async function generateAppJWT(appId, rawPemStr) {
  // 1. 标准化换行：兼容 Cloudflare Dashboard 自动转义的字面量 \n 与各类回车符
  const normalizedPem = rawPemStr.replace(/\\n/g, '\n').replace(/\\r/g, '').trim();
  let derBytes = pemToDer(normalizedPem);

  if (!derBytes || derBytes.length === 0) {
    throw new Error('解密后的 DER 字节序列为空，请检查私钥 Secret 格式');
  }

  // 智能结构侦测：如果头部是 PKCS#1 (RSA 裸私钥结构)，自动转封装为标准 PKCS#8
  // PKCS#8 在 version 之后是 AlgorithmIdentifier (以 0x30 开头)
  // PKCS#1 在 version 之后是 Modulus INTEGER (以 0x02 开头)
  const isPkcs1 = (derBytes[0] === 0x30 && derBytes[4] === 0x02 && derBytes[7] === 0x02) 
               || normalizedPem.includes('BEGIN RSA PRIVATE KEY');

  if (isPkcs1) {
    derBytes = pkcs1ToPkcs8(derBytes);
  }

  // 直接将 Uint8Array 传给 importKey，完全避免 ArrayBuffer 底层 byteOffset 错位问题
  let key;
  try {
    key = await crypto.subtle.importKey(
      'pkcs8',
      derBytes,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );
  } catch (importErr) {
    throw new Error(`importKey 失败: ${importErr.message} (derLen=${derBytes.length}, isPkcs1=${isPkcs1}, byte0=${derBytes[0]?.toString(16)}, byte7=${derBytes[7]?.toString(16)})`);
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: now - 60, exp: now + 600, iss: appId.toString() };

  const signInput = `${b64Url(JSON.stringify(header))}.${b64Url(JSON.stringify(payload))}`;
  const sigBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signInput)
  );

  return `${signInput}.${b64UrlBytes(new Uint8Array(sigBuffer))}`;
}

function pkcs1ToPkcs8(pkcs1Der) {
  const prefix = new Uint8Array([
    0x30, 0x82, 0x00, 0x00,
    0x02, 0x01, 0x00,
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
    0x04, 0x82, 0x00, 0x00
  ]);

  const totalLen = prefix.length + pkcs1Der.length - 4;
  prefix[2] = (totalLen >> 8) & 0xff;
  prefix[3] = totalLen & 0xff;

  const octetLen = pkcs1Der.length;
  prefix[prefix.length - 2] = (octetLen >> 8) & 0xff;
  prefix[prefix.length - 1] = octetLen & 0xff;

  const res = new Uint8Array(prefix.length + pkcs1Der.length);
  res.set(prefix, 0);
  res.set(pkcs1Der, prefix.length);
  return res;
}

function pemToDer(pemStr) {
  const normalized = pemStr.replace(/\\n/g, '\n').replace(/\\r/g, '');
  const lines = normalized.split('\n');
  const b64Lines = lines.filter(line => !line.startsWith('-----') && line.trim().length > 0);
  const b64 = b64Lines.join('').trim();
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function b64Url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64UrlBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return b64Url(binary);
}
