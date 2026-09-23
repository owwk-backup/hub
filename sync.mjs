import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import axios from 'axios';
import * as tar from 'tar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 读取组织名称与访问凭证
const ORG_NAME = process.env.GITHUB_REPOSITORY_OWNER || 'owwk-backup';
const PAT = process.env.ORG_ADMIN_PAT || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const CONFIG_REPO = process.env.CONFIG_REPO || 'config';

if (!PAT) {
  console.error('❌ [Fatal] 缺少访问凭据：请配置环境变量 ORG_ADMIN_PAT');
  process.exit(1);
}

// GitHub API 客户端
const client = axios.create({
  baseURL: 'https://api.github.com',
  headers: {
    Authorization: `Bearer ${PAT}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'VaultSyncBot'
  }
});

// Crates.io 客户端
const crateClient = axios.create({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
  }
});

// 内存日志收集器（用于回写私有仓保存完整明细）
const detailedLogs = [];
function logDetail(level, msg) {
  const time = new Date().toISOString();
  const line = `[${time}] [${level}] ${msg}`;
  detailedLogs.push(line);
}

// GitHub Actions 原生日志脱敏机制
function mask(val) {
  if (val && typeof val === 'string' && val.trim().length > 2) {
    console.log(`::add-mask::${val.trim()}`);
  }
}

function run(cmd, cwd = process.cwd()) {
  return execSync(cmd, { cwd, stdio: 'inherit' });
}

function runSilent(cmd, cwd = process.cwd()) {
  try {
    return execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim();
  } catch (error) {
    const stderr = error.stderr ? error.stderr.toString() : error.message;
    throw new Error(`Command failed: ${cmd}\n${stderr}`);
  }
}

// 动态从私有配置仓库拉取 repos.json
async function fetchConfig() {
  logDetail('INFO', `从私有配置仓 ${CONFIG_REPO} 读取 repos.json...`);
  console.log(`🔐 [Config Loader] 正在从私有配置仓 [${CONFIG_REPO}] 安全读取配置清单...`);
  try {
    const res = await client.get(`/repos/${ORG_NAME}/${CONFIG_REPO}/contents/repos.json`);
    const rawContent = Buffer.from(res.data.content, 'base64').toString('utf-8');
    const configs = JSON.parse(rawContent);
    console.log(`✅ [Config Loader] 成功加载 ${configs.length} 项配置（已从私有仓载入内存）。`);
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

// 检查仓库是否存在，不存在则自动在组织内创建独立仓库，并维护描述与原仓库链接
async function ensureRepo(item) {
  const repoName = item.target_repo || item.crate_name;
  const isPrivate = item.private ?? true;
  const homepage = item.homepage || (item.type === 'git' ? item.upstream : `https://crates.io/crates/${item.crate_name}`);
  const description = item.description || (item.type === 'git' ? `Upstream mirror for ${item.upstream}` : `Upstream mirror for ${item.crate_name} crate`);

  try {
    const res = await client.get(`/repos/${ORG_NAME}/${repoName}`);
    console.log(`✅ [Repo Ready] 目标仓库已就绪。`);
    logDetail('INFO', `仓库 ${ORG_NAME}/${repoName} 已就绪。Homepage: ${homepage}`);

    if (res.data.description !== description || res.data.homepage !== homepage) {
      console.log(`📝 [Repo Meta] 正在同步仓库元数据...`);
      await client.patch(`/repos/${ORG_NAME}/${repoName}`, {
        description,
        homepage
      });
      console.log(`✅ [Repo Meta] 元数据更新完成。`);
      logDetail('INFO', `仓库 ${repoName} 元数据已更新至最新。`);
    }
  } catch (err) {
    if (err.response?.status === 404) {
      console.log(`🚀 [Repo Init] 目标仓库不存在，正在自动创建独立仓库 (Private: ${isPrivate})...`);
      logDetail('INFO', `正在创建独立仓库 ${ORG_NAME}/${repoName}...`);
      await client.post(`/orgs/${ORG_NAME}/repos`, {
        name: repoName,
        private: isPrivate,
        description,
        homepage
      });
      console.log(`✅ [Repo Created] 独立仓库创建成功。`);
      logDetail('INFO', `独立仓库 ${ORG_NAME}/${repoName} 创建成功。`);
    } else {
      logDetail('ERROR', `检查/创建仓库失败: ${err.message}`);
      throw err;
    }
  }
}

// 模式 1：同步 Git 仓库全量镜像（防跑路防删模型）
async function syncGit(upstream, targetRepo, item = {}) {
  const targetUrl = `https://x-access-token:${PAT}@github.com/${ORG_NAME}/${targetRepo}.git`;
  console.log(`🔄 [Git Mirror] 正在执行镜像增量克隆与安全推送 (防跑路 Append-Only 模式)...`);
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

    // 3. 安全防跑路推送：
    // - 不带 --prune：上游哪怕删除分支或 Tag，备份仓绝对不删，永远留存
    // - 精确推送 heads 和 tags：跳过 GitHub 保留的只读 refs/pull/* 隐形引用
    // - 严格快进保护 (Fast-Forward Only)：默认禁止强制覆盖，防止上游恶意重写历史冲掉已有资产
    const forcePrefix = item.force ? '+' : '';
    run(`git push "${targetUrl}" "${forcePrefix}refs/heads/*:refs/heads/*" "refs/tags/*:refs/tags/*"`, tempDir);

    console.log(`✅ [Git Mirror] 镜像同步完成。`);
    logDetail('INFO', `[Git] 同步完成: ${targetRepo}`);
  } finally {
    await fs.remove(tempDir);
  }
}

// 模式 2：全量历史版本链式重放与增量同步（复原完整版本迭代演进与原作者/时间戳）
async function getAllCrateVersions(crateName) {
  console.log(`🔎 [Crate API] 正在拉取 ${crateName} 的历史版本元数据...`);
  const response = await crateClient.get(`https://crates.io/api/v1/crates/${crateName}/versions`);
  const versions = response.data?.versions || [];
  if (!versions.length) throw new Error(`未在 crates.io 找到 ${crateName} 的有效版本`);

  // 按时间正序排序（从最早版本到最新版本）
  versions.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  console.log(`📦 [Crate Versions] 成功解析 ${versions.length} 个版本 (最早: v${versions[0].num} @ ${versions[0].created_at.slice(0, 10)}, 最新: v${versions[versions.length - 1].num} @ ${versions[versions.length - 1].created_at.slice(0, 10)})`);
  logDetail('INFO', `[Crate] ${crateName} 获取到 ${versions.length} 个历史版本`);
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

  console.log(`🔄 [Crate Sync] 启动 Crate 专属全量版本与作者历史同步流...`);
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
      console.log(`⏩ [Crate Skipped] ${crateName} 全量 ${versions.length} 个版本历史已就绪，跳过。`);
      logDetail('INFO', `[Crate] ${crateName} 全量版本已最新 (最新: v${latestVer.num})，跳过`);
      await fs.remove(workDir);
      return;
    }

    console.log(`📦 [Crate Incremental] 检测到 ${pendingVersions.length} 个新版本待追加同步...`);
    for (const ver of pendingVersions) {
      console.log(`  ➕ 追加同步 v${ver.num} (${ver.created_at.slice(0, 10)})...`);
      await downloadAndExtractCrate(crateName, ver.num, targetRepoPath, workDir);
      commitAndTagCrate(targetRepoPath, crateName, ver);
    }

    console.log(`🚀 [Crate Push] 正在推送增量版本至 main...`);
    runSilent(`git push origin main --tags`, targetRepoPath);
    console.log(`✅ [Crate Synced] ${crateName} 增量同步完成。`);
    logDetail('INFO', `[Crate] ${crateName} 追加同步了 ${pendingVersions.length} 个新版本`);
  } else {
    // 全量历史重构模式：从最早版本重建完整链条并还原作者
    console.log(`🏗️ [Crate Rebuild] 目标仓尚未构建完整版本演进史，开始从 v${versions[0].num} 链式重构全部 ${versions.length} 个版本...`);
    logDetail('INFO', `[Crate] ${crateName} 开始全量链式重放 ${versions.length} 个版本历史`);

    // 重置为一个全新的本地 Git 仓库
    await fs.remove(path.join(targetRepoPath, '.git'));
    runSilent('git init -b main', targetRepoPath);
    runSilent(`git remote add origin "${cloneUrl}"`, targetRepoPath);

    for (let idx = 0; idx < versions.length; idx++) {
      const ver = versions[idx];
      const author = ver.published_by?.login || 'crates';
      const progress = `[${idx + 1}/${versions.length}]`;
      console.log(`  📦 ${progress} 重放 v${ver.num} | 发布者: ${author} | 日期: ${ver.created_at.slice(0, 10)}`);
      await downloadAndExtractCrate(crateName, ver.num, targetRepoPath, workDir);
      commitAndTagCrate(targetRepoPath, crateName, ver);
    }

    console.log(`🚀 [Crate Push] 历史链式构建完成，正在推送 main 分支与所有 ${versions.length} 个 Release Tags...`);
    runSilent(`git push -f origin main --tags`, targetRepoPath);
    console.log(`✅ [Crate Synced] ${crateName} 全量历史重构完成！`);
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
  console.log(`\n📝 [Audit] 正在将全量明文运行日志回写至私有仓库 [${CONFIG_REPO}]...`);
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
    
    console.log(`✅ [Audit] 明细日志回写成功！已在私有仓库 config/logs/ 下更新 latest.log 并完成历史归档。`);
  } catch (err) {
    console.error(`⚠️ [Audit Warning] 日志回写私有仓失败: ${err.message}`);
  }
}

async function main() {
  const configs = await fetchConfig();
  console.log(`📦 [Task Start] 组织: ${ORG_NAME}, 共有 ${configs.length} 个备份目标待处理`);
  logDetail('START', `组织: ${ORG_NAME}, 待处理任务数: ${configs.length}`);

  // 关键安全：精准日志掩码注入
  for (const item of configs) {
    mask(item.target_repo);
    mask(item.upstream);
    mask(item.crate_name);
    mask(item.homepage);
  }

  let failCount = 0;

  for (let i = 0; i < configs.length; i++) {
    const item = configs[i];
    console.log(`\n==============================================`);
    console.log(`执行任务 [${i + 1}/${configs.length}]: 类型 [${item.type}] 目标 [${item.target_repo}]`);
    console.log(`==============================================`);
    logDetail('TASK', `[${i + 1}/${configs.length}] ${item.type} -> ${item.target_repo || item.crate_name}`);

    try {
      await ensureRepo(item);

      if (item.type === 'git') {
        await syncGit(item.upstream, item.target_repo, item);
      } else if (item.type === 'crate') {
        await syncCrate(item);
      } else {
        console.warn(`⚠️ [Unknown Type] 未知类型: ${item.type}`);
        logDetail('WARN', `未知类型: ${item.type}`);
      }
    } catch (err) {
      failCount++;
      console.error(`❌ [Task Error] 任务执行失败: ${err.message}`);
      logDetail('ERROR', `任务失败: ${item.target_repo || item.crate_name}, 原因: ${err.message}`);
    }
  }

  console.log(`\n==============================================`);
  // 回写私有仓日志
  await saveDetailedLogsToPrivateConfig(failCount);

  if (failCount > 0) {
    console.error(`⚠️ 执行完毕，其中有 ${failCount} 个任务失败。`);
    process.exit(1);
  } else {
    console.log(`🎉 全部备份目标同步检查完成！`);
  }
}

main().catch(err => {
  console.error('❌ [Fatal Error]', err.message);
  process.exit(1);
});
