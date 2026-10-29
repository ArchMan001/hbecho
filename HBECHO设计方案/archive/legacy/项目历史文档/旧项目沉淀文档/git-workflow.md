# Git 版本管理工作流

## 远端仓库配置

本项目同时维护两个远端仓库：

| 别名 | 平台 | 地址 |
|------|------|------|
| `github` | GitHub | `git@github.com:ArchMan001/lxk-BigSpard.git` |
| `codeup` | 阿里云 Codeup | `liuxuekui@liuxuekui-cn-hangzhou.devops.aliyuncs.com:codeup/lxk-BigSpard.git` |
| `all` | 两个平台（一次推送） | 上面两个的合集 |

---

## 日常提交推送流程（每次改完代码后执行）

```bash
# 第一步：查看改动了哪些文件
git status

# 第二步：暂存改动
git add .                  # 暂存全部改动
# 或者只暂存特定文件：
# git add scraper/src/scraper.js web/src/routes/accounts.js

# 第三步：提交（写清楚改了什么）
git commit -m "类型: 简短描述"

# 第四步：一条命令同时推送到 GitHub 和 Codeup
git push all main
```

### 提交信息规范

```
feat: 新增功能
fix:  修复 bug
docs: 文档更新
refactor: 代码重构（功能不变）
chore: 配置/依赖调整
```

示例：
```
feat: 新增小红书账号爬虫
fix: 修复背景图比对阈值计算错误
docs: 更新数据库设计文档
```

---

## 哪些文件会被推送，哪些不会

### ✅ 会推送的（代码和配置，安全）

| 类型 | 示例 |
|------|------|
| 核心源代码 | `scraper/src/*.js`、`web/src/**` |
| 数据库初始化脚本 | `mysql/init.sql` |
| 数据库迁移脚本 | `scripts/migrate_*.sql` |
| Docker 配置 | `docker-compose.yml`、`Dockerfile` |
| 环境变量模板 | `.env.example`（不含真实密码） |
| 项目文档 | `README.md`、`HBECHO设计方案/` |
| Cookie 说明 | `cookies/HOW_TO_EXPORT_COOKIES.md` |
| 报告 TSV | `reports/*.tsv` |

### ❌ 不会推送的（敏感或体积过大）

| 类型 | 原因 | .gitignore 规则 |
|------|------|-----------------|
| `.env` | 含数据库密码、OSS Key、API Key 等 | `.env` |
| `cookies/douyin_cookies.json` | 含抖音登录态，泄露即账号被盗 | `cookies/douyin_cookies.json` |
| `scraper/cookies/douyin_cookies.json` | 同上 | `scraper/cookies/douyin_cookies.json` |
| `node_modules/` | 依赖包体积庞大，可通过 `npm install` 还原 | `node_modules/` |
| `images/` | 本地图片缓存，动辄 GB 级 | `images/` |
| `*.xlsx`、`*.csv` | 业务数据文件，不属于代码 | `*.xlsx`、`*.csv` |
| `scraper/probe_profile_raw.json` | 含真实账号爬取数据 | `scraper/probe_profile_raw.json` |

---

## 拉取到新机器后的完整启动步骤

在新机器（或服务器）上 clone 项目后，需要手动补充被忽略的文件：

```bash
# 1. 拉取代码
git clone git@github.com:ArchMan001/lxk-BigSpard.git
cd lxk-BigSpard

# 2. 创建 .env（从模板复制，填入真实值）
cp .env.example .env
# 然后编辑 .env，填写：
#   MYSQL_ROOT_PASSWORD=
#   MYSQL_PASSWORD=
#   OSS_ACCESS_KEY_ID=
#   OSS_ACCESS_KEY_SECRET=
#   DASHSCOPE_API_KEY=
#   WEB_AUTH_USER=
#   WEB_AUTH_PASS=

# 3. 放入抖音 Cookie 文件（从已登录的浏览器导出）
# 参考 cookies/HOW_TO_EXPORT_COOKIES.md
# 将导出的 JSON 放到：
#   cookies/douyin_cookies.json

# 4. 安装依赖（本地开发时需要）
cd scraper && npm install
cd ../web && npm install

# 5. 启动服务
docker compose up -d --build

# 6. 导入门店数据（首次部署才需要）
docker exec douyin-scraper node src/importDealers.js '/app/全部字段.csv'
```

---

## 常用 git 命令速查

```bash
# 查看当前状态（改了哪些文件）
git status

# 查看提交历史
git log --oneline

# 查看某次提交的改动内容
git show <commit-hash>

# 撤销还没 commit 的改动（危险！不可恢复）
git checkout -- <文件名>

# 只推单个平台（调试用）
git push github main
git push codeup main
```
