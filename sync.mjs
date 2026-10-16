import { execSync } from 'child_process';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import axios from 'axios';
import * as tar from 'tar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 读取组织名称与访问凭证
const ORG_NAME = process.env.GITHUB_REPOSITORY_OWNER || 'owwk-backup';
const CONFIG_REPO = process.env.CONFIG_REPO || 'config';

// 运行时凭据：由 initAuth() 在启动时填充（App 优先，PAT 兜底）
let PAT = null;
let client = null;

// 将可能以字面量 \n 存储的私钥还原为真实换行（CI Secret 常见形态）
function normalizePrivateKey(raw) {
  return String(raw).replace(/\\n/g, '\n').replace(/\\r/g, '').trim();
}

// 用 App 私钥签出 RS256 JWT（iss = App ID；GitHub 要求 exp 距 iat 不超过 10 分钟）
function signAppJWT(appId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const head = b64u({ alg: 'RS256', typ: 'JWT' });
  const payload = b64u({ iat: now - 60, exp: now + 540, iss: String(appId) });
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${head}.${payload}`)
    .sign(privateKeyPem)
    .toString('base64url');
  return `${head}.${payload}.${signature}`;
}

// 用 JWT 换取 GitHub App 的 Installation Token（有效期 1 小时，供本次任务使用）
async function getAppInstallationToken(appId, privateKeyPem, installationId) {
  const jwt = signAppJWT(appId, privateKeyPem);
  const res = await axios.post(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    null,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'VaultSyncBot'
      }
    }
  );
  return res.data.token;
}

// 凭据解析：优先 GitHub App（发布行为归属 <app>[bot]），否则回退个人 PAT
// 注意：GitHub 禁止 Actions 的 Secret / Variable 使用 GITHUB_ 前缀，故此处统一使用 VAULT_APP_ 命名
async function initAuth() {
  const appId = process.env.VAULT_APP_ID;
  const rawKey = process.env.VAULT_APP_PRIVATE_KEY;
  const installationId = process.env.VAULT_APP_INSTALLATION_ID;

  if (appId && rawKey && installationId) {
    publicLog('🔑 [Auth] 凭据已就绪，正在签发访问令牌...');
    try {
      PAT = await getAppInstallationToken(appId, normalizePrivateKey(rawKey), installationId);
      // 安全红线：App ID / Installation ID 属敏感标识，不得出现在公开日志中
      logDetail('INFO', `GitHub App 身份认证成功 (App ID: ${appId}, Installation ID: ${installationId})`);
    } catch (err) {
      const detail = err.response
        ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
        : err.message;
      throw new Error(`GitHub App 凭据签发失败：${detail}`);
    }
  } else {
    PAT = process.env.ORG_ADMIN_PAT || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (PAT) {
      publicLog('⚠️ [Auth] 已回退至令牌认证模式。');
      logDetail('WARN', '未检测到完整 App 凭据，回退使用 PAT（发布行为将归属该令牌所有者）');
    }
  }

  if (!PAT) {
    throw new Error(
      '缺少访问凭据：请配置 VAULT_APP_ID / VAULT_APP_PRIVATE_KEY / VAULT_APP_INSTALLATION_ID，或 ORG_ADMIN_PAT'
    );
  }

  // GitHub API 客户端
  client = axios.create({
    baseURL: 'https://api.github.com',
    headers: {
      Authorization: `Bearer ${PAT}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'VaultSyncBot'
    }
  });
}

// Crates.io 客户端
const crateClient = axios.create({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
  }
});

// 内存日志收集器（用于回写私有仓保存完整明细）
const detailedLogs = [];
// 明细日志仍可能携带令牌（如 remote URL 内的 x-access-token），落盘前统一抹除
function redact(text) {
  let out = String(text);
  if (PAT) out = out.split(PAT).join('***');
  out = out.replace(/x-access-token:[^@\s"]+/gi, 'x-access-token:***');
  out = out.replace(/gh[opsu]_[A-Za-z0-9]{20,}/g, '***');
  return out;
}
function logDetail(level, msg) {
  const time = new Date().toISOString();
  const line = `[${time}] [${level}] ${redact(msg)}`;
  detailedLogs.push(line);
}

// 公开控制台捕获原始写入器：本仓库为 Public，Action 日志对外完全可见，
// 故除通用状态行外，任何业务明细一律不得落到公开控制台，只写私有明细日志。
const rawConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

// 唯一允许公开输出的通道：只放与备份目标、上游、版本无关的通用状态行
function publicLog(msg) {
  rawConsole.log(msg);
}

// 安装输出闸门：接管所有 console 输出并转入私有明细日志。
// 放行 ::add-mask:: 一类 Actions 工作流指令，避免脱敏与注释机制失效。
function installOutputGuard() {
  const LEVEL = { log: 'INFO', info: 'INFO', debug: 'DEBUG', warn: 'WARN', error: 'ERROR' };
  for (const name of Object.keys(LEVEL)) {
    console[name] = (...args) => {
      const text = args
        .map(a => (typeof a === 'string' ? a : a instanceof Error ? a.message : String(a)))
        .join(' ');
      if (/^\s*::/.test(text)) return rawConsole[name](text);
      logDetail(LEVEL[name], text);
    };
  }
}

// 汇总子进程失败明细（stdout + stderr），仅用于写入私有日志
function describeProcFailure(error, cmd) {
  const parts = [];
  if (error.stdout) parts.push(error.stdout.toString().trim());
  if (error.stderr) parts.push(error.stderr.toString().trim());
  const out = parts.filter(Boolean).join('\n');
  return out ? `${cmd}\n${out}` : cmd;
}

// 子进程统一使用 pipe：命令原文与 git 回显（上游 owner、分支名、tag 名、commit SHA）
// 全部只进私有明细日志，杜绝经 stdio inherit 直通公开控制台
function run(cmd, cwd = process.cwd()) {
  try {
    const out = execSync(cmd, { cwd, stdio: 'pipe' });
    const text = out ? out.toString().trim() : '';
    if (text) logDetail('EXEC', `${cmd}\n${text}`);
  } catch (error) {
    logDetail('ERROR', describeProcFailure(error, cmd));
    throw new Error('子进程执行失败，明细见私有配置仓 logs/latest.log');
  }
}

// expectedFailure: true 用于「失败即正常」的探测类命令（如分支存在性判定），
// 这类失败不写入错误日志，避免污染私有日志的可读性
function runSilent(cmd, cwd = process.cwd(), opts = {}) {
  try {
    return execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim();
  } catch (error) {
    if (!opts.expectedFailure) {
      logDetail('ERROR', describeProcFailure(error, cmd));
    }
    throw new Error('子进程执行失败，明细见私有配置仓 logs/latest.log');
  }
}

// 动态从私有配置仓库拉取 repos.json
async function fetchConfig() {
  logDetail('INFO', `从私有配置仓 ${CONFIG_REPO} 读取 repos.json...`);
  publicLog('🔐 [Config Loader] 正在安全读取备份配置清单...');
  try {
    const res = await client.get(`/repos/${ORG_NAME}/${CONFIG_REPO}/contents/repos.json`);
    const rawContent = Buffer.from(res.data.content, 'base64').toString('utf-8');
    const configs = JSON.parse(rawContent);
    logDetail('INFO', `成功加载 ${configs.length} 项配置`);
    return configs;
  } catch (err) {
    logDetail('WARN', `私有配置仓读取失败: ${err.message}`);
    const localFile = path.join(__dirname, 'repos.json');
    if (await fs.pathExists(localFile)) {
      return await fs.readJson(localFile);
    }
    throw new Error(`未能获取到任何备份配置，请检查私有仓 ${ORG_NAME}/${CONFIG_REPO} 中的 repos.json`);
  }
}

// 解析 upstream 是否为 GitHub 仓库
function parseGitHubRepo(upstream) {
  if (!upstream || typeof upstream !== 'string') return null;
  const match = upstream.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

// 自动拉取上游项目的真实简介 (About 原文)，不再添加任何模板前缀
async function fetchUpstreamDescription(item) {
  if (item.description !== undefined && item.description !== null) {
    return item.description;
  }

  try {
    if (item.type === 'git') {
      const gh = parseGitHubRepo(item.upstream);
      if (gh) {
        const res = await client.get(`/repos/${gh.owner}/${gh.repo}`);
        if (res.data && res.data.description) {
          return res.data.description.trim();
        }
      }
    } else if (item.type === 'crate') {
      const crateName = item.crate_name || item.target_repo;
      const res = await crateClient.get(`https://crates.io/api/v1/crates/${crateName}`);
      if (res.data?.crate?.description) {
        return res.data.crate.description.trim();
      }
    }
  } catch (err) {
    logDetail('WARN', `上游 About 简介拉取失败（将留空），原因: ${err.message}`);
  }

  return '';
}

// 检查仓库是否存在，不存在则自动在组织内创建独立仓库，并维护描述与原仓库链接
async function ensureRepo(item) {
  const repoName = item.target_repo || item.crate_name;
  const isPrivate = item.private ?? true;
  const homepage = item.homepage || (item.type === 'git' ? (item.upstream ? item.upstream.replace(/\.git$/, '') : '') : `https://crates.io/crates/${item.crate_name}`);
  const description = await fetchUpstreamDescription(item);

  try {
    const res = await client.get(`/repos/${ORG_NAME}/${repoName}`);
    logDetail('INFO', `仓库 ${ORG_NAME}/${repoName} 已就绪。Homepage: ${homepage}`);

    const currentDesc = res.data.description || '';
    const currentHomepage = res.data.homepage || '';

    if (currentDesc !== description || currentHomepage !== homepage) {
      await client.patch(`/repos/${ORG_NAME}/${repoName}`, {
        description,
        homepage
      });
      logDetail('INFO', `仓库 ${repoName} 元数据已更新至最新。Description: "${description}"`);
    }
  } catch (err) {
    if (err.response?.status === 404) {
      logDetail('INFO', `正在创建独立仓库 ${ORG_NAME}/${repoName}...`);
      await client.post(`/orgs/${ORG_NAME}/repos`, {
        name: repoName,
        private: isPrivate,
        description,
        homepage
      });
      logDetail('INFO', `独立仓库 ${ORG_NAME}/${repoName} 创建成功。Description: "${description}"`);
    } else {
      logDetail('ERROR', `检查/创建仓库失败: ${err.message}`);
      throw err;
    }
  }
}

// 元信息块哨兵：用于幂等重建，避免重复同步时层层叠加
const META_BEGIN = '<!-- vault-sync:meta:begin -->';
const META_END = '<!-- vault-sync:meta:end -->';
const SYNC_ID_RE = /vault-sync:upstream-id=(\d+)/;
const SUPERSEDED_SUFFIX = ' ｜ ⚠️ 已被上游重新发布取代';

// ISO 时间转为可读的 UTC 文本
function fmtUtc(iso) {
  if (!iso) return '（未知）';
  return iso.replace('T', ' ').replace('Z', ' UTC');
}

// 读取 body 中登记的同步来源 Release ID（作为「是否已同步」的权威指纹）
function extractSyncId(body) {
  const m = SYNC_ID_RE.exec(body || '');
  return m ? m[1] : null;
}

// 构建置于 body 开头的原始发布元信息块（尾部附机器锚点，供下次比对上游 id）
function buildMetaBlock(owner, repo, rel) {
  const author = rel.author?.login;
  const authorText = author ? `[@${author}](https://github.com/${author})` : '（未知）';
  const releaseUrl = `https://github.com/${owner}/${repo}/releases/tag/${rel.tag_name}`;
  const anchor = `<!-- vault-sync:upstream-id=${rel.id} upstream-published=${rel.published_at || ''} -->`;
  return [
    META_BEGIN,
    '> **📌 原始发布信息（镜像自上游）**',
    '>',
    `> - 发布者：${authorText}`,
    `> - 创建时间：${fmtUtc(rel.created_at)}`,
    `> - 发布时间：${fmtUtc(rel.published_at)}`,
    `> - 上游发布页：${releaseUrl}`,
    anchor,
    META_END
  ].join('\n');
}

// 剥离可能存在的历史元信息块后重新拼接，保证重复同步不会重复叠加
function composeBody(owner, repo, rel) {
  let original = rel.body || '';
  const begin = original.indexOf(META_BEGIN);
  if (begin !== -1) {
    const end = original.indexOf(META_END, begin);
    if (end !== -1) {
      original = original.slice(end + META_END.length).replace(/^\s*\n/, '');
    }
  }
  const meta = buildMetaBlock(owner, repo, rel);
  return original.trim() ? `${meta}\n\n${original}` : `${meta}\n`;
}

// 增量同步 GitHub Releases 与附件 Assets
async function syncReleasesIfGitHub(upstream, targetRepo) {
  const gh = parseGitHubRepo(upstream);
  if (!gh) return;

  logDetail('INFO', `[Release] 开始检查 Releases: ${gh.owner}/${gh.repo} -> ${targetRepo}`);

  try {
    // 1. 获取上游所有 releases
    let upstreamReleases = [];
    try {
      const res = await client.get(`/repos/${gh.owner}/${gh.repo}/releases?per_page=100`);
      upstreamReleases = res.data || [];
    } catch (e) {
      if (e.response?.status === 404) {
        logDetail('INFO', `[Release] 上游仓库无公开 releases`);
        return;
      }
      throw e;
    }

    if (!upstreamReleases.length) {
      logDetail('INFO', `[Release] 上游仓库无公开 releases，跳过`);
      return;
    }

    // 2. 获取目标仓已有 releases（按 tag 归组，同名 tag 可能并存多个对象）
    let targetReleases = [];
    try {
      const res = await client.get(`/repos/${ORG_NAME}/${targetRepo}/releases?per_page=100`);
      targetReleases = res.data || [];
    } catch (e) {
      targetReleases = [];
    }

    const targetByTag = new Map();
    for (const r of targetReleases) {
      if (!targetByTag.has(r.tag_name)) targetByTag.set(r.tag_name, []);
      targetByTag.get(r.tag_name).push(r);
    }

    // 从最早的 release 到最新的 release 顺序处理
    const ordered = [...upstreamReleases].reverse();

    let createdCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const rel of ordered) {
      const sameTag = targetByTag.get(rel.tag_name) || [];
      const upstreamId = String(rel.id);

      // 已同步判定：同名 tag 的 Release 中，存在锚点记录且上游 id 一致
      const alreadySynced = sameTag.find(t => extractSyncId(t.body) === upstreamId);
      if (alreadySynced) {
        skippedCount++;
        continue;
      }

      if (sameTag.length > 1) {
        logDetail('WARN', `[Release] tag ${rel.tag_name} 在目标仓存在 ${sameTag.length} 个重复对象`);
      }

      // 上游对同一 tag 重新发布（或首次接管无锚点的历史 Release）：
      // 老 Release 的内容与资产完整保留，仅在其 name 上追加取代标记，绝不覆盖或删除
      for (const old of sameTag) {
        const oldName = old.name || old.tag_name;
        if (oldName.includes(SUPERSEDED_SUFFIX)) continue;
        try {
          await client.patch(`/repos/${ORG_NAME}/${targetRepo}/releases/${old.id}`, {
            name: `${oldName}${SUPERSEDED_SUFFIX}`
          });
          logDetail('INFO', `[Release] 旧 Release ${rel.tag_name} (id=${old.id}) 已标记为被上游重新发布取代`);
        } catch (markErr) {
          logDetail('WARN', `[Release] 标记旧 Release ${rel.tag_name} 失败: ${markErr.message}`);
        }
      }

      logDetail('INFO', `[Release] 开始同步 ${rel.tag_name}`);
      failedCount++;

      // 在目标仓创建对应的 Release（body 开头写入原始发布元信息）
      // 关键：绝不透传上游 target_commitish。实测判定（复现见 logs 归档）：
      // 该字段只接受目标仓可达的分支名；传入上游 commit SHA 或 tag 名在 GitHub 会直接 422，
      // 且目标仓已存在该 tag 时即使传 'main' 也可能被判非法。故统一省略，由 GitHub 按
      // 目标仓现存 ref 解析，tag 不存在时自动基于默认分支创建，从根本上消除 422。
      let createdRelease;
      try {
        const createRes = await client.post(`/repos/${ORG_NAME}/${targetRepo}/releases`, {
          tag_name: rel.tag_name,
          name: rel.name || rel.tag_name,
          body: composeBody(gh.owner, gh.repo, rel),
          draft: false,
          prerelease: rel.prerelease || false
        });
        createdRelease = createRes.data;
        createdCount++;
        failedCount--;
      } catch (err) {
        const detail = err.response?.data ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
        logDetail('WARN', `[Release] 创建 ${rel.tag_name} 失败: ${detail}`);
        continue;
      }

      // 同步附件 Assets
      const assets = rel.assets || [];
      if (assets.length > 0) {
        for (const asset of assets) {
          try {
            const downloadRes = await axios.get(asset.browser_download_url, {
              responseType: 'arraybuffer',
              headers: { 'User-Agent': 'VaultSyncBot' }
            });

            const uploadUrl = createdRelease.upload_url.split('{')[0] + `?name=${encodeURIComponent(asset.name)}`;
            await axios.post(uploadUrl, downloadRes.data, {
              headers: {
                Authorization: `Bearer ${PAT}`,
                'Content-Type': asset.content_type || 'application/octet-stream',
                'User-Agent': 'VaultSyncBot'
              },
              maxBodyLength: Infinity,
              maxContentLength: Infinity
            });
            logDetail('INFO', `[Release] 附件转存成功: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(2)} MB)`);
          } catch (assetErr) {
            logDetail('WARN', `[Release] 转存附件 ${asset.name} 失败: ${assetErr.message}`);
          }
        }
      }
      logDetail('INFO', `[Release] 成功同步 ${rel.tag_name} 及 ${assets.length} 个附件`);
    }

    // 统计必须如实反映结果：此前「全部同步完成」会在 22 项全部失败时误报为无需变更
    logDetail(
      'INFO',
      `[Release] 上游共 ${upstreamReleases.length} 个 Release：新建 ${createdCount}，已同步跳过 ${skippedCount}，失败 ${failedCount}`
    );
  } catch (err) {
    logDetail('WARN', `[Release] 同步异常: ${err.message}`);
  }
}

// 模式 1：同步 Git 仓库全量镜像（防跑路 + 分叉自动归档保护模型）
async function syncGit(upstream, targetRepo, item = {}) {
  const targetUrl = `https://x-access-token:${PAT}@github.com/${ORG_NAME}/${targetRepo}.git`;
  logDetail('INFO', `[Git] 开始同步 ${upstream} -> ${ORG_NAME}/${targetRepo}`);

  const tempDir = path.join(__dirname, `temp_${targetRepo}.git`);
  await fs.remove(tempDir);

  try {
    // 1. 克隆上游裸仓
    run(`git clone --mirror "${upstream}" "${tempDir}"`);

    // 2. 防跑路熔断检查：验证上游是否有有效提交，防止清空跑路
    const commitCountStr = runSilent('git rev-list --count --all', tempDir);
    const commitCount = parseInt(commitCountStr, 10);
    if (isNaN(commitCount) || commitCount === 0) {
      throw new Error(`熔断触发：上游仓库没有任何有效提交 (commits: 0)，疑似空仓或清空跑路，已阻断同步！`);
    }

    // 3. 配置备份仓远端，拉取备份仓分支指针进行分叉分析
    runSilent(`git remote add backup "${targetUrl}"`, tempDir);

    let hasTargetHeads = false;
    try {
      const remoteHeads = runSilent('git ls-remote --heads backup', tempDir);
      if (remoteHeads && remoteHeads.trim().length > 0) {
        hasTargetHeads = true;
      }
    } catch {
      hasTargetHeads = false;
    }

    if (hasTargetHeads) {
      try {
        // 拉取备份仓的现有 heads 到本地镜像的 refs/backup-heads/*
        runSilent(`git fetch backup "refs/heads/*:refs/backup-heads/*"`, tempDir);

        const backupHeadsOutput = runSilent(`git for-each-ref --format="%(refname:short)" refs/backup-heads/`, tempDir);
        const backupBranches = backupHeadsOutput
          .split('\n')
          .map(b => b.trim().replace(/^backup-heads\//, ''))
          .filter(Boolean);

        for (const branch of backupBranches) {
          // 跳过此前已归档的历史分支，避免递归套娃归档
          if (branch.startsWith('archive/')) continue;

          // 检查上游裸仓是否存在同名分支
          let upstreamHasBranch = false;
          try {
            runSilent(`git rev-parse --verify "refs/heads/${branch}"`, tempDir, { expectedFailure: true });
            upstreamHasBranch = true;
          } catch {
            upstreamHasBranch = false;
          }

          if (upstreamHasBranch) {
            // 判定：备份仓的 commit 是否为上游当前分支 commit 的直系祖先 (Fast-Forward 判定)
            let isFastForward = false;
            try {
              runSilent(`git merge-base --is-ancestor "refs/backup-heads/${branch}" "refs/heads/${branch}"`, tempDir, { expectedFailure: true });
              isFastForward = true;
            } catch {
              isFastForward = false;
            }

            if (!isFastForward) {
              // 🚨 捕获分叉：上游发生了 Force Push / 偷删 Commit / 历史重写！
              const nowStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
              const archiveBranch = `archive/${branch}-diverged-${nowStr}`;
              logDetail('WARN', `[Anti-ForcePush] 分支 [${branch}] 历史分叉 (上游 Force Push 或删减 Commit)，原历史归档至 [${archiveBranch}]`);

              // 将备份仓原分支指针推送到归档分支进行封存
              runSilent(`git push backup "refs/backup-heads/${branch}:refs/heads/${archiveBranch}"`, tempDir);
            }
          } else {
            logDetail('INFO', `上游已移除分支 [${branch}]，备份仓予以保留`);
          }
        }
      } catch (checkErr) {
        logDetail('WARN', `分叉检测警告: ${checkErr.message}`);
      }
    }

    // 4. 安全推送：
    // - 不带 --prune：上游删除的分支/Tag 在备份仓中永久保留
    // - 带 + 强制覆盖 refs/heads/*：因为发生分叉的分支已经全量归档封存至 archive/*，此时推进 heads 可以安全平滑追踪上游最新，杜绝 CI 管道死锁！
    // - 标签 refs/tags/*:refs/tags/* 正常快进追加推送（防恶意覆写 Tag）
    run(`git push backup "+refs/heads/*:refs/heads/*" "refs/tags/*:refs/tags/*"`, tempDir);

    logDetail('INFO', `[Git] 同步完成: ${targetRepo}`);
  } finally {
    await fs.remove(tempDir);
  }

  // 5. 增量同步 GitHub Releases 与附件 Assets
  if (item.sync_releases !== false) {
    await syncReleasesIfGitHub(upstream, targetRepo);
  }
}


// 模式 2：全量历史版本链式重放与增量同步（复原完整版本迭代演进与原作者/时间戳）
async function getAllCrateVersions(crateName) {
  logDetail('INFO', `[Crate] 正在拉取 ${crateName} 的历史版本元数据...`);
  const response = await crateClient.get(`https://crates.io/api/v1/crates/${crateName}/versions`);
  const versions = response.data?.versions || [];
  if (!versions.length) throw new Error(`未在 crates.io 找到 ${crateName} 的有效版本`);

  // 按时间正序排序（从最早版本到最新版本）
  versions.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  logDetail('INFO', `[Crate] ${crateName} 获取到 ${versions.length} 个历史版本 (最早: v${versions[0].num}, 最新: v${versions[versions.length - 1].num})`);
  return versions;
}

async function downloadAndExtractCrate(crateName, version, targetRepoPath, workDir) {
  const downloadUrl = `https://static.crates.io/crates/${crateName}/${crateName}-${version}.crate`;
  const tarballPath = path.join(workDir, `${crateName}-${version}.crate`);
  const extractDir = path.join(workDir, `extracted_${version}`);

  await fs.remove(extractDir);
  await fs.ensureDir(extractDir);

  const response = await crateClient.get(downloadUrl, { responseType: 'arraybuffer' });
  await fs.writeFile(tarballPath, response.data);

  await tar.x({
    file: tarballPath,
    cwd: extractDir
  });

  // 清空目标仓已有工作区文件（保留 .git）
  const items = await fs.readdir(targetRepoPath);
  for (const item of items) {
    if (item !== '.git') {
      await fs.remove(path.join(targetRepoPath, item));
    }
  }

  // 复制解压内容到目标仓根目录
  const subDirs = await fs.readdir(extractDir);
  const sourceDir = subDirs.length === 1 ? path.join(extractDir, subDirs[0]) : extractDir;
  await fs.copy(sourceDir, targetRepoPath);

  await fs.remove(tarballPath);
  await fs.remove(extractDir);
}

function commitAndTagCrate(targetRepoPath, crateName, ver) {
  const version = ver.num;
  const authorName = ver.published_by?.name || ver.published_by?.login || 'Crates.io';
  const authorLogin = ver.published_by?.login || 'crates';
  const authorEmail = `${authorLogin}@users.noreply.github.com`;
  const dateStr = ver.created_at;

  runSilent('git add -A', targetRepoPath);

  const commitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_AUTHOR_DATE: dateStr,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
    GIT_COMMITTER_DATE: dateStr
  };

  const msg = `release: ${crateName} v${version}`;
  try {
    execSync(`git commit --allow-empty -m "${msg}"`, { cwd: targetRepoPath, env: commitEnv, stdio: 'pipe' });
  } catch (err) {
    // 忽略空提交异常
  }

  const tagName = `v${version}`;
  try {
    execSync(`git tag -a "${tagName}" -m "Release ${crateName} ${tagName}"`, { cwd: targetRepoPath, env: commitEnv, stdio: 'pipe' });
  } catch (err) {
    // 忽略 tag 已存在异常
  }
}

async function syncCrate(item) {
  const crateName = item.crate_name;
  const targetRepo = item.target_repo || crateName;

  logDetail('INFO', `开始处理 Crate: ${crateName} -> 目标仓: ${targetRepo}`);

  const workDir = path.join(__dirname, 'work', crateName);
  await fs.remove(workDir);
  await fs.ensureDir(workDir);

  const targetRepoPath = path.join(workDir, 'repo');
  const cloneUrl = `https://x-access-token:${PAT}@github.com/${ORG_NAME}/${targetRepo}.git`;

  const versions = await getAllCrateVersions(crateName);
  const latestVer = versions[versions.length - 1];

  // 1. 克隆或准备本地仓库
  await fs.ensureDir(targetRepoPath);
  let isRepoEmpty = false;
  try {
    runSilent(`git clone --branch main "${cloneUrl}" "${targetRepoPath}"`);
  } catch {
    isRepoEmpty = true;
    runSilent('git init -b main', targetRepoPath);
    runSilent(`git remote add origin "${cloneUrl}"`, targetRepoPath);
  }

  // 2. 检查现有 tags 与历史完整度
  let existingTags = [];
  try {
    existingTags = runSilent('git tag', targetRepoPath).split('\n').map(t => t.trim()).filter(Boolean);
  } catch {}

  const earliestTag = `v${versions[0].num}`;
  // 若缺失最早的版本 tag，说明之前仅同步过单次快照，自动开启全量历史重放
  const needRebuild = isRepoEmpty || (!existingTags.includes(earliestTag) && versions.length > 1);

  if (!needRebuild) {
    // 增量模式：检查未同步的新版本
    const pendingVersions = versions.filter(v => !existingTags.includes(`v${v.num}`));
    if (pendingVersions.length === 0) {
      logDetail('INFO', `[Crate] ${crateName} 全量版本已最新 (最新: v${latestVer.num})，跳过`);
      await fs.remove(workDir);
      return;
    }

    logDetail('INFO', `[Crate] ${crateName} 检测到 ${pendingVersions.length} 个新版本待追加同步`);
    for (const ver of pendingVersions) {
      logDetail('INFO', `[Crate] 追加同步 v${ver.num} (${ver.created_at.slice(0, 10)})`);
      await downloadAndExtractCrate(crateName, ver.num, targetRepoPath, workDir);
      commitAndTagCrate(targetRepoPath, crateName, ver);
    }

    runSilent(`git push origin main --tags`, targetRepoPath);
    logDetail('INFO', `[Crate] ${crateName} 追加同步了 ${pendingVersions.length} 个新版本`);
  } else {
    // 全量历史重构模式：从最早版本重建完整链条并还原作者
    logDetail('INFO', `[Crate] ${crateName} 开始全量链式重放 ${versions.length} 个版本历史`);

    // 重置为一个全新的本地 Git 仓库
    await fs.remove(path.join(targetRepoPath, '.git'));
    runSilent('git init -b main', targetRepoPath);
    runSilent(`git remote add origin "${cloneUrl}"`, targetRepoPath);

    for (let idx = 0; idx < versions.length; idx++) {
      const ver = versions[idx];
      const author = ver.published_by?.login || 'crates';
      const progress = `[${idx + 1}/${versions.length}]`;
      logDetail('INFO', `[Crate] ${progress} 重放 v${ver.num} | 发布者: ${author} | 日期: ${ver.created_at.slice(0, 10)}`);
      await downloadAndExtractCrate(crateName, ver.num, targetRepoPath, workDir);
      commitAndTagCrate(targetRepoPath, crateName, ver);
    }

    runSilent(`git push -f origin main --tags`, targetRepoPath);
    logDetail('INFO', `[Crate] ${crateName} 全量 ${versions.length} 个版本历史重构完成并推送`);
  }

  await fs.remove(workDir);
}

// 将明细日志安全回写至私有配置仓库 config 的 logs 目录下
async function writeLogFile(filePath, content, message) {
  let sha;
  try {
    const res = await client.get(`/repos/${ORG_NAME}/${CONFIG_REPO}/contents/${filePath}`);
    sha = res.data.sha;
  } catch (e) {
    // 首次创建，无 sha
  }

  await client.put(`/repos/${ORG_NAME}/${CONFIG_REPO}/contents/${filePath}`, {
    message,
    content: Buffer.from(content).toString('base64'),
    sha
  });
}

async function saveDetailedLogsToPrivateConfig(failCount) {
  const statusSummary = failCount > 0 ? `FAILED (${failCount} errors)` : 'SUCCESS';
  logDetail('SUMMARY', `任务执行完毕，最终状态: ${statusSummary}`);

  const logText = detailedLogs.join('\n');
  const now = new Date();
  const dateStr = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);

  try {
    // 1. 写入/覆盖最新日志 latest.log（方便在私有仓一键查阅）
    await writeLogFile('logs/latest.log', logText, `chore: update latest sync log [${statusSummary}]`);
    
    // 2. 写入历史归档文件 logs/history/YYYY-MM-DD_HH-mm-ss.log
    await writeLogFile(`logs/history/${dateStr}.log`, logText, `chore: archive sync log ${dateStr}`);
    
    publicLog('🗂️ [Audit] 运行明细已归档至私有审计仓。');
  } catch (err) {
    publicLog(`⚠️ [Audit] 运行明细归档失败：${err.message}`);
  }
}

async function main() {
  // 关键安全：接管全部 console 输出，公开控制台自此只允许 publicLog 输出通用状态行
  installOutputGuard();

  // 先完成凭据解析，后续所有 API 调用均依赖由此构建的 client
  await initAuth();

  const configs = await fetchConfig();
  publicLog('📦 [Task Start] 备份同步已启动。');
  logDetail('START', `组织: ${ORG_NAME}, 待处理任务数: ${configs.length}`);

  let failCount = 0;

  for (let i = 0; i < configs.length; i++) {
    const item = configs[i];
    // 关键安全：公开控制台每日志行都不得携带目标名、类型与序号等可推断清单结构的信息
    logDetail('TASK', `[${i + 1}/${configs.length}] ${item.type} -> ${item.target_repo || item.crate_name}`);

    try {
      await ensureRepo(item);

      if (item.type === 'git') {
        await syncGit(item.upstream, item.target_repo, item);
      } else if (item.type === 'crate') {
        await syncCrate(item);
      } else {
        logDetail('WARN', `未知类型: ${item.type}`);
      }
    } catch (err) {
      failCount++;
      logDetail('ERROR', `任务失败: ${item.target_repo || item.crate_name}, 原因: ${err.message}`);
    }
  }

  // 回写私有仓日志
  await saveDetailedLogsToPrivateConfig(failCount);

  if (failCount > 0) {
    publicLog(`⚠️ 同步检查完成，存在 ${failCount} 个失败任务。`);
    process.exit(1);
  } else {
    publicLog('🎉 全部备份目标同步检查完成。');
  }
}

main().catch(err => {
  // 致命错误只回写私有日志，公开控制台不暴露任何上下文
  logDetail('ERROR', `[Fatal Error] ${err.message}`);
  publicLog('❌ 同步流程异常终止，详见私有审计仓。');
  process.exit(1);
});
