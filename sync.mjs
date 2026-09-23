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

// 模式 1：同步 Git 仓库全量镜像
async function syncGit(upstream, targetRepo) {
  const targetUrl = `https://x-access-token:${PAT}@github.com/${ORG_NAME}/${targetRepo}.git`;
  console.log(`🔄 [Git Mirror] 正在执行镜像全量克隆与推送...`);
  logDetail('INFO', `[Git] 开始同步 ${upstream} -> ${ORG_NAME}/${targetRepo}`);

  const tempDir = path.join(__dirname, `temp_${targetRepo}.git`);
  await fs.remove(tempDir);

  try {
    run(`git clone --mirror "${upstream}" "${tempDir}"`);
    run(`git push --mirror "${targetUrl}"`, tempDir);
    console.log(`✅ [Git Mirror] 镜像同步完成。`);
    logDetail('INFO', `[Git] 同步完成: ${targetRepo}`);
  } finally {
    await fs.remove(tempDir);
  }
}

// 模式 2：同步 Crates.io 包至独立仓库的 main 分支
async function getLatestCrateVersion(crateName) {
  console.log(`🔎 [Crate API] 正在查询 crates.io 最新发布版本...`);
  const response = await crateClient.get(`https://crates.io/api/v1/crates/${crateName}`);
  const version = response.data?.crate?.max_stable_version || response.data?.crate?.max_version;
  if (!version) throw new Error(`未在 crates.io 找到 ${crateName} 的有效版本`);
  console.log(`📦 [Crate Version] 探测到最新版本: v${version}`);
  logDetail('INFO', `[Crate] ${crateName} 最新版本为 v${version}`);
  return version;
}

async function prepareRepo(targetRepoPath, targetRepo) {
  await fs.remove(targetRepoPath);
  await fs.ensureDir(targetRepoPath);

  const cloneUrl = `https://x-access-token:${PAT}@github.com/${ORG_NAME}/${targetRepo}.git`;

  try {
    console.log(`📥 正在拉取目标仓库 main 分支...`);
    runSilent(`git clone --branch main "${cloneUrl}" "${targetRepoPath}"`);
  } catch (error) {
    console.log(`ℹ️ 目标仓库尚为空，初始化本地仓库并绑定 main 分支...`);
    runSilent('git init -b main', targetRepoPath);
    runSilent(`git remote add origin "${cloneUrl}"`, targetRepoPath);
  }

  runSilent(`git config user.name "github-actions[bot]"`, targetRepoPath);
  runSilent(`git config user.email "41898282+github-actions[bot]@users.noreply.github.com"`, targetRepoPath);
}

function checkCrateVersionExists(targetRepoPath, crateName, version) {
  try {
    const tags = runSilent('git tag', targetRepoPath).split('\n');
    if (tags.includes(`${crateName}-v${version}`) || tags.includes(`v${version}`)) {
      return true;
    }
  } catch {
    // 忽略未产生 tag 的初始状态
  }
  return false;
}

async function downloadAndExtractCrate(crateName, version, targetRepoPath, workDir) {
  console.log(`⬇️ 正在下载 .crate 包文件 (v${version}) 并执行解压校验...`);
  const downloadUrl = `https://static.crates.io/crates/${crateName}/${crateName}-${version}.crate`;
  const tarballPath = path.join(workDir, `${crateName}-${version}.crate`);
  const extractDir = path.join(workDir, 'extracted');

  await fs.remove(extractDir);
  await fs.ensureDir(extractDir);

  const startTime = Date.now();
  const response = await crateClient.get(downloadUrl, { responseType: 'arraybuffer' });
  await fs.writeFile(tarballPath, response.data);

  await tar.x({
    file: tarballPath,
    cwd: extractDir
  });
  const cost = Date.now() - startTime;
  console.log(`📦 包解压缩成功 (耗时: ${cost}ms)，整理工作树...`);
  logDetail('INFO', `[Crate] 下载并解压 ${crateName} v${version} 成功，耗时 ${cost}ms`);

  const items = await fs.readdir(targetRepoPath);
  for (const item of items) {
    if (item !== '.git') {
      await fs.remove(path.join(targetRepoPath, item));
    }
  }

  const extractedSubDir = path.join(extractDir, `${crateName}-${version}`);
  await fs.copy(extractedSubDir, targetRepoPath);

  await fs.remove(tarballPath);
  await fs.remove(extractDir);
}

function commitAndPushCrate(targetRepoPath, crateName, version) {
  console.log(`📤 提交代码变动、打 Tag 并推送至独立仓库...`);
  runSilent('git add .', targetRepoPath);

  const status = runSilent('git status --porcelain', targetRepoPath);
  if (!status) {
    console.log('ℹ️ 文件内容无更新，跳过提交。');
    logDetail('INFO', `[Crate] ${crateName} 代码内容无变动`);
  } else {
    runSilent(`git commit -m "chore(sync): update to v${version}"`, targetRepoPath);
  }

  const tagName = `v${version}`;
  runSilent(`git tag -a "${tagName}" -m "Release ${tagName}"`, targetRepoPath);
  runSilent(`git push origin main --tags`, targetRepoPath);
  console.log(`✅ [Crate Synced] 推送完成，Release Tag: ${tagName}`);
  logDetail('INFO', `[Crate] ${crateName} 成功推送到 main，Tag: ${tagName}`);
}

async function syncCrate(item) {
  const crateName = item.crate_name;
  const targetRepo = item.target_repo || crateName;

  console.log(`🔄 [Crate Sync] 启动 Crate 专属同步流...`);
  logDetail('INFO', `开始处理 Crate: ${crateName} -> 目标仓: ${targetRepo}`);

  const workDir = path.join(__dirname, 'work', crateName);
  const targetRepoPath = path.join(workDir, 'repo');

  const version = await getLatestCrateVersion(crateName);
  await prepareRepo(targetRepoPath, targetRepo);

  if (checkCrateVersionExists(targetRepoPath, crateName, version)) {
    console.log(`⏩ [Crate Skipped] 目标版本 v${version} 已经备份同步，跳过本次任务。`);
    logDetail('INFO', `[Crate] ${crateName} v${version} 已备份同步，跳过`);
    await fs.remove(workDir);
    return;
  }

  await downloadAndExtractCrate(crateName, version, targetRepoPath, workDir);
  commitAndPushCrate(targetRepoPath, crateName, version);
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
        await syncGit(item.upstream, item.target_repo);
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
