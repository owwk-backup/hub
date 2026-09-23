# Mirror & Backup Hub

本项目为自动化镜像备份与调度中心。
- 采用 **Public** 仓库配置，享受免费无上限的 GitHub Actions 运行时间。
- 自动根据 `repos.json` 检查并自动在组织下创建对应目标仓库，执行全量 Git 镜像同步。

---

## 快速配置指引 (使用 GitHub CLI)

### 1. 登录 GitHub CLI (若尚未认证或失效)
```bash
gh auth login -h github.com
```

### 2. 配置组织级全局 Secret
在组织中配置一次全局 Secret `ORG_ADMIN_PAT`（需包含 `repo`, `workflow`, `admin:org` 权限）：
```bash
gh secret set ORG_ADMIN_PAT --org "owwk-backup" --visibility all
```

### 3. 创建远端 hub 仓库并推送初始代码
在当前 `hub` 目录下执行：
```bash
git init
git add .
git commit -m "feat: initial commit for owwk-backup hub"
git branch -M main

# 使用 gh cli 直接在组织下创建公开仓库并关联远程源推送
gh repo create owwk-backup/hub --public --source=. --remote=origin --push
```

---

## 日常管理说明

### 添加新备份目标
直接编辑 [repos.json](file:///D:/download/hub/repos.json) 文件追加项目，提交并推送：
```json
[
  {
    "type": "git",
    "upstream": "https://github.com/astral-sh/uv.git",
    "target_repo": "uv-mirror",
    "private": true
  }
]
```

### 手动触发同步
使用 `gh cli` 随时在终端触发一次同步任务：
```bash
gh workflow run sync.yml --repo owwk-backup/hub
```

### 查看同步运行状态与日志
```bash
gh run list --repo owwk-backup/hub
gh run watch --repo owwk-backup/hub
```

---

## 生态扩展：一键加入备份 (One-Click Backup)

本项目提供开箱即用的前端扩展套件，位于仓库目录：
- **[userscript/vault-sync.user.js](file:///D:/Workspace/CodeSpace/hub/userscript/vault-sync.user.js)**：浏览器油猴脚本，完美融入 GitHub / Crates.io 原生 UI。
- **[worker/index.js](file:///D:/Workspace/CodeSpace/hub/worker/index.js)**：Cloudflare Worker 极速异步网关代码，毫秒级响应并安全更新私有配置仓。
