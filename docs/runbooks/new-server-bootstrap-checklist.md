# 新云服务器从 0 配置清单

> **状态**：`current`
> **文档类型**：Runbook（可复用操作清单）
> **适用范围**：阿里云 ECS + OSS 从零到可交付开发的通用配置顺序，适用于 hbdam 或任何新项目
> **不承载**：具体项目的资产值（那些进各项目自己的运维手册）、应用层部署拓扑
> **首次编写**：2026-09-03
> **来源**：hbecho 实测（2026-09-03 一次跑通），逐条都是实际执行并验证过的，不是理论清单
> **配套**：[hbecho 服务器与部署运维手册](server-operations-runbook.md)（同一套做法的完整版，含每个决定的理由）

---

## 0. 这份文件怎么用

它是**顺序**和**验证点**的清单，不是复制粘贴脚本。每一步都给出：做什么、为什么这个顺序、怎么验证做成了。

三个使用约定：

1. **按序执行。** 顺序不是风格问题，其中三处颠倒会把自己锁在门外（§2 会标出来）。
2. **每步都要看到验证输出。** 命令退出码 0 不等于配置生效——这份清单里有四处是"配了但没生效"的高发点。
3. **把实际值记进该项目自己的运维手册。** 这份文件不存任何项目的 IP、实例 ID、桶名。

先替换的变量。整份文档里的 `<PROJ>` / `<INSTANCE>` / `<REGION>` / `<ACCOUNT>` 都要换成实际值：

```bash
PROJ=hbdam                                   # 项目名，用于桶名前缀与资源命名
INSTANCE=i-xxxxxxxxxxxxxxxxx                 # 实例 ID
REGION=cn-beijing                            # 地域，与 OSS 必须一致
ACCOUNT=xxxxxxxxxxxxxxxx                     # 阿里云账号 ID（本项目所属账号，见 §0.2）
```

### 0.1 多项目 / 多阿里云账号共存

**前提事实**：不同项目可能位于**不同的阿里云账号**，ECS、RAM、OSS 完全独立。已知的情况是 hbecho 与 hbdam 各用一个账号。

这意味着：

| 项 | 是否共享 | 说明 |
|---|---|---|
| RAM 用户、策略、AccessKey | ❌ **不共享** | 每个账号都要重新建一遍 §3.3 的两个身份 |
| 策略里的账号 ID 与实例 ARN | ❌ **不共享** | ARN 含账号 ID，照抄另一个项目的策略会全部失效 |
| OSS 桶名前缀 | ❌ **不共享** | 各账号一套 `<PROJ>-*`，且被各自策略限定 |
| 实例 RAM 角色 | ❌ **不共享** | 角色是账号级资源 |
| 本机的 CLI 工具二进制 | ✅ 共享 | `workbench` / `aliyun` 装一次即可 |
| 本机的凭证配置 | ✅ 共存（靠 profile 区分） | 见下 |

**本机凭证按 profile 并存，互不覆盖：**

```bash
# aliyun CLI：每个项目一个 profile
aliyun configure set --profile <PROJ>-setup --mode AK \
  --access-key-id "..." --access-key-secret "..." --region <REGION>
aliyun configure list                        # * 标记当前激活的
aliyun ecs DescribeInstances --profile <PROJ>-setup ...   # 每条命令显式带 --profile

# workbench CLI：config.json 里多个 profile
workbench config list
workbench exec -P <PROJ> -i <INSTANCE> -c '...'
```

⚠️ **每条命令都显式带 `--profile` / `-P`，不要依赖"当前激活的 profile"。** 忘记切 profile 会让命令打到另一个项目的账号上——只读命令只是报找不到实例，写命令可能真的改错资源。

**这些本机资源必须按项目区分命名，否则会互相覆盖或串号：**

| 资源 | 命名约定 | 撞车后果 |
|---|---|---|
| SSH 私钥 | `~/.ssh/<PROJ>_ed25519` | 覆盖掉另一个项目的密钥 |
| SSH 别名 | `Host <PROJ>` | 连错机器 |
| **SSH 隧道本地端口** | 每个项目错开 | ⚠️ **最危险的一个**，见下 |
| 系统钥匙串条目 | `-s <PROJ>-ecs-root` | 覆盖另一个项目的密码 |
| aliyun / workbench profile | `<PROJ>-setup` / `<PROJ>` | 打到错误账号 |

⚠️ **本地转发端口撞车是最危险的一项。** 两个项目的 SSH 隧道同时开着、`LocalForward` 用了同一个本地端口时，你的数据库客户端会连到**另一个项目的数据库**上，而且**不会有任何报错**。参考分配：

| 项目 | Web | MySQL |
|---|---|---|
| hbdam | 8080 | 13306 |
| hbecho | 8081 | 13307 |
| 下一个项目 | 8082 | 13308 |

### 0.2 怎么拿到本账号的账号 ID

策略 ARN 里要用它。三种方式：

```bash
# ① 已有 RAM 用户时，登录名后缀就是账号 ID：<user>@<账号ID>.onaliyun.com
# ② CLI（需要凭证已配好）
aliyun sts GetCallerIdentity --profile <PROJ>-setup
# ③ 控制台右上角头像 → 账号管理 → 安全设置
```

### 0.3 这份清单与项目运维手册的分工

| 文档 | 内容 | 是否跨项目复用 |
|---|---|---|
| 本清单 | 顺序、验证点、坑、策略模板 | ✅ 复用，只替换变量 |
| `server-operations-runbook.md` | 某个项目的实际资产值、已完成配置、待办、变更记录 | ❌ 每个项目一份 |

复制到新项目时：本清单基本照用；运维手册要按新项目重写资产清单（§1）、清空变更记录，并**逐条检查是否还残留上一个项目的 IP、实例 ID、桶名和账号 ID**。

---

## 1. 买之前先定的四件事

买错要重建，已传数据要跨区复制。

| # | 决定什么 | 为什么必须在买之前 |
|---|---|---|
| 1 | **地域** | ECS 与 OSS 必须同地域，内网流量才免费。国内用户面向的项目选内地地域 |
| 2 | **登录凭证选「密钥对」而非密码** | 选密码就等于开局给自己制造一个必须紧急处理的安全问题（见 §4.3） |
| 3 | **系统盘 / 数据盘分开** | 数据与系统解耦；重装系统、系统盘扩容、快照回滚都不牵连数据 |
| 4 | **域名后缀能否备案** | 工信部只批复部分顶级域。`.com` / `.cn` 稳妥，冷门后缀（如 `.click`）可能根本无法备案，会让整个域名访问方案作废 |

**hbecho 的实际情况**：第 2 项没做到（用了密码，而且是弱密码），第 3 项买了数据盘但没初始化。这份清单的 §4.3（换弱密码）和 §5.1（初始化数据盘）就是补救这两件事的流程。

---

## 2. 执行顺序总览

```
阶段 A · 打通通道（不依赖任何入方向端口）
  A1  装 workbench CLI
  A2  装 aliyun CLI
  A3  建两个 RAM 用户 + 策略 + 授权          ← 人工，控制台
  A4  配置两套凭证并实测

阶段 B · 安全加固（顺序不能颠倒）
  B1  装 SSH 公钥
  B2  验证密钥登录                            ← 必须成功才能做 B3
  B3  关闭 SSH 密码认证
  B4  重置弱密码，存系统钥匙串
  B5  清理无用的开放端口
  B6  收紧 22 端口来源

阶段 C · 系统层
  C1  初始化数据盘（UUID + nofail + noatime）
  C2  目录规划
  C3  文件句柄上限（两处）
  C4  内核参数
  C5  时间同步核验
  C6  容器运行时

阶段 D · 云资源
  D1  建 OSS 桶（同地域 + 私有 + 加密）
  D2  生命周期规则
  D3  实例 RAM 角色（免 AccessKey）
  D4  云监控 Agent
  D5  自动快照策略
  D6  告警规则

阶段 E · 可并行
  E1  ICP 备案（1–3 周，只阻塞域名对外访问）
  E2  Git 仓库（.gitignore 必须先于 git init）
  E3  数据库部署
```

### 三处顺序颠倒会出事

| 顺序 | 颠倒的后果 |
|---|---|
| A 必须在 B 之前 | B3/B6 都是"可能锁死自己"的操作。没有带外通道时出错只能靠控制台 VNC + root 密码救，密码也坏掉就只能重装。Workbench 的价值在于**它有权限自己修好自己的路**（§4.5），SSH 没有 |
| B2 必须在 B3 之前 | 新机器的 `authorized_keys` 通常是空的。先关密码认证 = SSH 彻底进不去 |
| D1 必须在写入第一个对象之前定好拓扑 | 桶名会进数据库成为历史事实，改拓扑要同时搬对象和改历史行 |

### 四处"配了但没生效"的高发点

| 位置 | 表现 | 怎么验证 |
|---|---|---|
| RAM 策略改版 | 建了 v2 但当前版本仍是 v1，编辑等于没做 | 策略详情页看「当前版本」 |
| RAM 策略 ARN 写错 | 控制台标「无效授权」，调用时 `ImplicitDeny` | 用一次真实调用验证，见 §3.4 |
| 安全组旧规则未删 | 规则是**并集**，`0.0.0.0/0` 还在就等于没收紧 | 重新列规则确认 |
| `limits.conf` 只改一处 | systemd 拉起的服务 fd 上限没变 | `cat /proc/<pid>/limits` |

---

## 3. 阶段 A · 打通通道

目标：拿到一条**不依赖任何入方向端口**的通道。有了它，后面所有加固动作才是安全的。

### 3.1 装 workbench CLI

阿里云的 ECS 本地连接工具，走内部链路，不需要你手动开放任何端口（准确机制见 §4.5——它会自己往安全组写规则）。

```bash
curl -fsSL -o /tmp/wb.sh https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.sh
less /tmp/wb.sh                       # 想谨慎就看一眼；脚本自带 SHA256 校验
bash /tmp/wb.sh -d /opt/homebrew/bin  # 指定目录可免 sudo；默认 /usr/local/bin 需 sudo
workbench version
```

能力（v1.0.1 实测）：`exec` 执行远程命令（透传退出码、`--output json`）、`upload`/`download`（1 GB 上限）、`connect` 交互登录、`list ecs`、`session`、`daemon`、`config`。

⚠️ **v1.0.1 没有端口转发子命令**，尽管官方描述里写了"TCP 端口转发"。所以 MySQL 图形客户端仍需 SSH 隧道。

⚠️ `exec` 每次调用是独立 shell，`cd` / `export` 不跨调用保留。需要共享上下文的命令用 `&&` 串在一次调用里。

### 3.2 装 aliyun CLI

控制台层面的操作（建桶、改安全组、配快照、装监控）都要靠它。

```bash
curl -fsSL -o /tmp/aliyun-cli.tgz \
  https://aliyuncli.alicdn.com/aliyun-cli-macosx-latest-arm64.tgz   # Intel 换 amd64
tar xzf /tmp/aliyun-cli.tgz -C /tmp
install -m 755 /tmp/aliyun /opt/homebrew/bin/aliyun
xattr -d com.apple.quarantine /opt/homebrew/bin/aliyun 2>/dev/null || true
aliyun version
```

**`ossutil` 不用单独装，是 `aliyun` 的内置子命令**（`aliyun ossutil`）。`aliyun oss` 已废弃。同时内置 `cms2`（云监控）。

### 3.3 建两个 RAM 用户

分两个身份，生命周期不同。这是唯一必须在控制台手工做的一步。

| 身份 | 权限 | 生命周期 |
|---|---|---|
| `<PROJ>-ops` | 仅 Workbench + 只读 | 长期 |
| `<PROJ>-setup` | 建设期写权限 | **搭完删 AK** |

创建页面逐字段（RAM → 身份管理 → 用户 → 创建用户）：

| 字段 | 填什么 |
|---|---|
| 登录名称 | `<PROJ>-ops` / `<PROJ>-setup` |
| 显示名称 | 随意，写清用途 |
| 安全手机 / 安全邮箱 | **留空**（那是控制台登录的二次验证，这两个身份不登录控制台） |
| ☐ 使用控制台密码访问 | **不勾**（不勾等于永远无法登录控制台，AK 泄露也拿不到控制台会话） |
| ☑ 使用永久 AccessKey 访问 | **勾上** |

AccessKey Secret **只显示一次**，当场保存。

**策略一** `<PROJ>-workbench-ops`（把 `<ACCOUNT>` `<REGION>` `<INSTANCE>` 换成实际值）：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ecs-workbench:LoginECSInstance", "ecs-workbench:ChatMessages"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["ecs:DescribeInstances", "ecs:DescribeCloudAssistantStatus"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "ecs:StartTerminalSession",
      "Resource": "acs:ecs:<REGION>:<ACCOUNT>:instance/<INSTANCE>"
    },
    {
      "Effect": "Allow",
      "Action": "ram:CreateServiceLinkedRole",
      "Resource": "*",
      "Condition": {
        "StringEquals": { "ram:ServiceName": "workbench.ecs.aliyuncs.com" }
      }
    }
  ]
}
```

⚠️ **`ecs-workbench` 不支持资源级授权**（hbecho 实测）。把它的 `Resource` 写成实例 ARN 会导致控制台标「无效授权」、调用返回 `ImplicitDeny`。收紧点必须放在 `ecs:StartTerminalSession`——ECS 产品支持资源级授权，而终端会话是实际执行命令的入口。

**策略二** `<PROJ>-setup-buildout`（把 `<ACCOUNT>` `<REGION>` `<INSTANCE>` `<PROJ>` 换成实际值）：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Sid": "EcsReadOnly",
      "Effect": "Allow",
      "Action": [
        "ecs:DescribeRegions",
        "ecs:DescribeZones",
        "ecs:DescribeInstances",
        "ecs:DescribeInstanceAttribute",
        "ecs:DescribeDisks",
        "ecs:DescribeAvailableResource",
        "ecs:DescribeSecurityGroups",
        "ecs:DescribeSecurityGroupAttribute",
        "ecs:DescribeSnapshots",
        "ecs:DescribeAutoSnapshotPolicyEx",
        "ecs:DescribeInstanceRamRole",
        "ecs:DescribeCloudAssistantStatus",
        "ecs:DescribeInvocations",
        "ecs:DescribeInvocationResults"
      ],
      "Resource": "*"
    },
    {
      "Sid": "SecurityGroupRules",
      "Effect": "Allow",
      "Action": [
        "ecs:AuthorizeSecurityGroup",
        "ecs:RevokeSecurityGroup",
        "ecs:ModifySecurityGroupRule"
      ],
      "Resource": "*"
    },
    {
      "Sid": "DiskAndSnapshot",
      "Effect": "Allow",
      "Action": [
        "ecs:CreateDisk",
        "ecs:AttachDisk",
        "ecs:ResizeDisk",
        "ecs:CreateSnapshot",
        "ecs:CreateAutoSnapshotPolicy",
        "ecs:ApplyAutoSnapshotPolicy",
        "ecs:ModifyAutoSnapshotPolicyEx"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CloudAssistantOnTargetInstance",
      "Effect": "Allow",
      "Action": ["ecs:InstallCloudAssistant", "ecs:RunCommand"],
      "Resource": "acs:ecs:<REGION>:<ACCOUNT>:instance/<INSTANCE>"
    },
    {
      "Sid": "AttachRamRoleToTargetInstance",
      "Effect": "Allow",
      "Action": ["ecs:AttachInstanceRamRole"],
      "Resource": "acs:ecs:<REGION>:<ACCOUNT>:instance/<INSTANCE>"
    },
    {
      "Sid": "OssListAll",
      "Effect": "Allow",
      "Action": ["oss:ListBuckets"],
      "Resource": "acs:oss:*:<ACCOUNT>:*"
    },
    {
      "Sid": "OssManageProjectBuckets",
      "Effect": "Allow",
      "Action": [
        "oss:PutBucket",
        "oss:GetBucketInfo",
        "oss:GetBucketLocation",
        "oss:GetBucketAcl",
        "oss:PutBucketAcl",
        "oss:PutBucketLifecycle",
        "oss:GetBucketLifecycle",
        "oss:DeleteBucketLifecycle",
        "oss:PutBucketCors",
        "oss:GetBucketCors",
        "oss:PutBucketEncryption",
        "oss:GetBucketEncryption",
        "oss:GetBucketPublicAccessBlock",
        "oss:PutBucketPublicAccessBlock",
        "oss:PutBucketVersioning",
        "oss:GetBucketVersioning",
        "oss:ListObjects",
        "oss:GetObject",
        "oss:PutObject",
        "oss:GetObjectMeta",
        "oss:DeleteObject",
        "oss:AbortMultipartUpload",
        "oss:ListParts"
      ],
      "Resource": [
        "acs:oss:*:<ACCOUNT>:<PROJ>-*",
        "acs:oss:*:<ACCOUNT>:<PROJ>-*/*"
      ]
    },
    {
      "Sid": "CloudMonitor",
      "Effect": "Allow",
      "Action": "cms:*",
      "Resource": "*"
    },
    {
      "Sid": "RamForInstanceRole",
      "Effect": "Allow",
      "Action": [
        "ram:CreatePolicy",
        "ram:GetPolicy",
        "ram:ListPolicies",
        "ram:CreatePolicyVersion",
        "ram:ListPolicyVersions",
        "ram:CreateRole",
        "ram:GetRole",
        "ram:ListRoles",
        "ram:AttachPolicyToRole",
        "ram:ListPoliciesForRole"
      ],
      "Resource": "*"
    }
  ]
}
```

刻意的取舍：

| 决定 | 原因 |
|---|---|
| **没有** `DeleteInstance` / `StopInstance` / `RebootInstance` / `DeleteDisk` / `DetachDisk` / `DeleteSnapshot` | 建设期用不到，误用不可逆 |
| **没有** `ecs:ModifyInstanceAttribute` | 它能改实例密码。重置密码在控制台做 |
| OSS 资源限定 `<PROJ>-*` 前缀 | 碰不到账号下其他 bucket。桶名必须与之一致 |
| 给了 `oss:DeleteObject`，**没给** `oss:DeleteBucket` | 验证时要清理测试对象；删桶不该由脚本完成 |
| `RunCommand` / `AttachInstanceRamRole` 限定到单实例 ARN | 这两个影响面最大 |
| `cms:*` 用通配 | 云监控 action 命名未逐个实测，写错会在配告警时失败且难定位；破坏面小（最坏删掉告警规则）。等价于 `AliyunCloudMonitorFullAccess`，偏保守可先不给，做到 D6 时再加 |

⚠️ **`RamForInstanceRole` 这一段让这个身份的实际权限等级接近账号管理员。** `ram:CreateRole` + `ram:CreatePolicy` + `ram:AttachPolicyToRole` 配上同策略里的 `ecs:AttachInstanceRamRole` 和 `ecs:RunCommand`，构成完整提权链：造一个高权限角色、绑到实例、在实例里用它做任何事。

这不是反对给它，而是要明白**控制手段是生命周期而不是 action 列表**：

| 手段 | 做法 |
|---|---|
| 时间 | 建设期结束**立即删除 AccessKey**（§8 第 1 项） |
| 可审计 | 用它做的动作记进项目手册变更记录；ActionTrail 可按 UserPrincipalName 回溯 |
| 可吊销 | 怀疑泄露时 RAM 控制台禁用用户，立即生效 |
| 隔离 | 与长期使用的 `<PROJ>-ops` 是两个身份，删它不影响日常运维通道 |

不想给 RAM 权限的话，删掉 `RamForInstanceRole` 整段，把 §6.3（实例 RAM 角色）留在控制台手工做，其余步骤不受影响。

**授权**：用户 → 权限管理 → 新增授权 → 资源范围选「账号级别」→ 策略类型切到「**自定义策略**」（列表默认只显示系统策略，找不到就是这个原因）→ 勾对应策略。

> 系统策略一个都不要勾，尤其标了「高风险」的 `AdministratorAccess` 和 `AliyunRAMFullAccess`。

### 3.4 配置凭证并实测

```bash
# workbench（ops 身份）
mkdir -p ~/.workbench
cat > ~/.workbench/config.json <<EOF
{"current":"$PROJ","profiles":{"$PROJ":{"mode":"AK","access_key_id":"LTAI...","access_key_secret":"..."}}}
EOF
chmod 600 ~/.workbench/config.json      # 不是 600 会报 insecure permissions 并拒绝运行

# aliyun（setup 身份）
aliyun configure set --profile ${PROJ}-setup --mode AK \
  --access-key-id "LTAI..." --access-key-secret "..." --region $REGION
chmod 600 ~/.aliyun/config.json
```

**三条验证，必须全过：**

```bash
workbench exec -i $INSTANCE -c 'hostname; uptime'
aliyun ecs DescribeInstances --RegionId $REGION --InstanceIds "[\"$INSTANCE\"]" --profile ${PROJ}-setup
aliyun ossutil ls --profile ${PROJ}-setup
```

失败时按退出码定位：`4` 认证或授权失败；`1` 实例找不到；`5` 网络；`2` 参数或配置文件权限；`6` 本地 daemon。

> 报 `Forbidden.RAM` 或 `ImplicitDeny` 时，第一个要查的是**策略有没有授权给用户**——建策略和授权是两步，只做前一步是最常见的卡点。

### 3.5 采集机器现状

通道打通后第一件事，把事实记进项目手册：

```bash
workbench exec -i $INSTANCE --timeout 60 -c '
echo "===OS==="; head -2 /etc/os-release; uname -r
echo "===CPU/MEM==="; nproc; free -h | head -2
echo "===DISK==="; lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT; df -hT | grep -vE "tmpfs|devtmpfs"
echo "===PORTS==="; ss -tlnp
echo "===TIME==="; timedatectl | head -4; chronyc tracking | grep -E "Reference ID|System time"
echo "===AGENT==="; systemctl is-active aliyun.service; systemctl is-active argusagent
echo "===SSHD==="; grep -rhE "^(PasswordAuthentication|PermitRootLogin)" /etc/ssh/sshd_config /etc/ssh/sshd_config.d/ 2>/dev/null
echo "===AUTHKEYS==="; wc -l < /root/.ssh/authorized_keys 2>/dev/null || echo 0
echo "===INSTALLED==="; command -v docker mysql || echo "docker/mysql 未装"
'
```

⚠️ **判断磁盘必须用 `lsblk`，不能只看实例详情页。** 实例概览面板不显示未初始化的数据盘——hbecho 因此被误判为"没买数据盘"。

---

## 4. 阶段 B · 安全加固

### 4.1 装公钥并验证（B1–B2）

```bash
ssh-keygen -t ed25519 -f ~/.ssh/${PROJ}_ed25519 -N "" -C "${PROJ}-$(date +%Y%m%d)"
PUB=$(cat ~/.ssh/${PROJ}_ed25519.pub)
workbench exec -i $INSTANCE -c "
mkdir -p /root/.ssh && chmod 700 /root/.ssh
grep -qF '$PUB' /root/.ssh/authorized_keys 2>/dev/null || echo '$PUB' >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
ssh-keygen -lf /root/.ssh/authorized_keys
"
```

比对指纹与本地 `ssh-keygen -lf ~/.ssh/${PROJ}_ed25519.pub` 一致。

写 `~/.ssh/config`（本地端口要**与其他项目错开**，两台机器隧道同时开着时端口撞车会让你连到别的项目数据库上，而且不报错）：

```ssh-config
Host <PROJ>
    HostName <公网IP>
    User root
    IdentityFile ~/.ssh/<PROJ>_ed25519
    IdentitiesOnly yes
    ServerAliveInterval 30
    ServerAliveCountMax 6
    LocalForward 80xx 127.0.0.1:80
    LocalForward 133xx 127.0.0.1:3306
```

**验证（不通过就不要往下走）：**

```bash
ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new $PROJ 'echo OK: $(hostname)'
```

### 4.2 关闭密码认证（B3）

用 workbench 执行，而不是用 SSH——避免改坏配置时把自己当前会话切断。

```bash
workbench exec -i $INSTANCE --timeout 45 -c '
cat > /etc/ssh/sshd_config.d/90-hardening.conf <<EOF
PasswordAuthentication no
PermitRootLogin prohibit-password
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
MaxAuthTries 4
ClientAliveInterval 300
ClientAliveCountMax 2
EOF
sshd -t && echo "语法OK" || { rm -f /etc/ssh/sshd_config.d/90-hardening.conf; exit 1; }
systemctl reload sshd
sshd -T | grep -E "^(passwordauthentication|permitrootlogin|maxauthtries)"
'
```

**先 `sshd -t` 再 reload** 是铁律：语法错误直接 reload 会让 sshd 起不来。上面的写法在语法失败时自动回滚。

**三条验证：**

```bash
ssh -o BatchMode=yes $PROJ 'echo OK'                                    # ① 密钥仍可用
sshpass -p '<旧密码>' ssh -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no root@<IP> true                             # ② 应被拒绝
workbench exec -i $INSTANCE -c 'echo OK'                                # ③ 带外通道不受影响
```

### 4.3 处理弱密码（B4）

新机器如果用密码开局，初始密码往往是 `品牌名+123.` / `项目名+年份.` 这类模式——属于暴力破解字典高频项。

关闭密码认证后它不再是远程攻击面（只剩控制台 VNC），但仍应换成真随机串：

```bash
# 生成 24 位随机密码并存入系统钥匙串
PW=$(LC_ALL=C tr -dc 'A-Za-z0-9!@#%^*_+=-' < /dev/urandom | head -c 24)
security add-generic-password -a "root@$PROJ" -s "${PROJ}-ecs-root" -w "$PW" -U
security find-generic-password -s "${PROJ}-ecs-root" -w      # 取回，粘贴到控制台重置密码
unset PW
```

控制台「重置实例密码」需重启实例生效——**趁还没部署任何东西时做，成本为零**。

> 密码**不要存在工作区的文本文件里**。工作区文件会被编辑器、云备份和 AI 工具读到，而且 `git init` 时一旦忽略规则没覆盖就进仓库。系统钥匙串（macOS Keychain）是现成的密码管理器。

### 4.4 清理无用开放端口（B5）

阿里云默认安全组常带几条系统创建的规则，其中有些对 Linux 毫无意义。

```bash
SG=$(aliyun ecs DescribeSecurityGroups --RegionId $REGION --profile ${PROJ}-setup \
     | python3 -c "import json,sys;print(json.load(sys.stdin)['SecurityGroups']['SecurityGroup'][0]['SecurityGroupId'])")
aliyun ecs DescribeSecurityGroupAttribute --RegionId $REGION --SecurityGroupId $SG \
  --Direction ingress --profile ${PROJ}-setup
```

**hbecho 实测发现的默认规则**：`22/22`、`ICMP`、**`3389/3389` 全部来自 `0.0.0.0/0`**。3389 是 Windows 远程桌面端口，Linux 机器上没有任何进程监听它——纯暴露面，零收益，直接删：

```bash
aliyun ecs RevokeSecurityGroup --RegionId $REGION --SecurityGroupId $SG \
  --IpProtocol tcp --PortRange 3389/3389 --SourceCidrIp 0.0.0.0/0 --profile ${PROJ}-setup
```

ICMP 可以留（便于连通性诊断，风险很低）。

### 4.5 收紧 22 端口（B6）

**先加后验再删**，顺序错了会锁死自己：

```bash
# 1) 先加窄规则
aliyun ecs AuthorizeSecurityGroup --RegionId $REGION --SecurityGroupId $SG \
  --IpProtocol tcp --PortRange 22/22 --SourceCidrIp <你的网段> \
  --Priority 1 --Description "SSH-<who>-<YYYYMMDD>" --profile ${PROJ}-setup

# 2) 验证仍能连
ssh -o BatchMode=yes $PROJ 'echo OK'

# 3) 验证通过后才删宽规则
aliyun ecs RevokeSecurityGroup --RegionId $REGION --SecurityGroupId $SG \
  --IpProtocol tcp --PortRange 22/22 --SourceCidrIp 0.0.0.0/0 --profile ${PROJ}-setup

# 4) 复核 + 再验证一次
aliyun ecs DescribeSecurityGroupAttribute --RegionId $REGION --SecurityGroupId $SG \
  --Direction ingress --profile ${PROJ}-setup
ssh -o BatchMode=yes $PROJ 'echo OK'
workbench exec -P $PROJ -i $INSTANCE -c 'echo OK'      # 带外通道也要复验
```

**动手前先确认自己当前的出口 IP 在不在要放行的网段里**，否则第 2 步验证必然失败：

```bash
curl -s https://api.ipify.org
```

> 安全组规则是**并集**生效。只要 `0.0.0.0/0` 那条还在，新加的窄规则毫无作用——这是很多人以为收紧了但其实没有的原因。

**选什么网段：**

| 情况 | 建议 |
|---|---|
| 固定公网 IP | `<IP>/32` |
| 家宽/移动网络（IP 会变） | 运营商网段如 `223.78.0.0/16`，牺牲精度换稳定 |
| **挂 VPN** | **不要把 VPN 出口 IP 加进白名单** |

VPN 那条要解释：VPN 出口通常是机房共享 IP（例如某个 `50.7.152.0/21` 属于某美国主机商）。把它加进白名单等于**允许该主机商所有其他租户访问你的 22 端口**——比允许一个中国移动网段更危险。挂 VPN 时用 workbench 通道，它不需要任何入方向端口。

IP 变了进不去时：用 workbench 或控制台网页版远程连接进机器，也可以直接用 `aliyun` CLI 改规则——它不需要先能 SSH。

#### 收紧后规则会多出两条，那是正常的

收紧完再列一次规则，你会看到自己没加过的条目：

| 协议 | 端口 | 来源 | 描述 |
|---|---|---|---|
| TCP | 22/22 | `<你放行的网段>` | 你写的描述 |
| TCP | 22/22 | `100.104.x.x/26` | **`createdByEcsWorkbench`** |
| TCP | 22/22 | `100.104.y.y/26` | **`createdByEcsWorkbench`** |

**这是阿里云 Workbench 自动写入的，不要删。** 删掉就切断了带外通道。看到陌生的 `100.104.x.x` 不要误判成入侵痕迹——`100.64.0.0/10` 是运营商级 NAT 空间，属于阿里云内部地址，不在公网可达范围内。

#### ⚠️ 「免开端口」的准确含义

Workbench 常被描述成"无需开放任何入方向端口"。**这个说法不准确。**

hbecho 实测的时间线：

```
T+0s    添加窄规则
        删除 22 ← 0.0.0.0/0
        第一次 workbench exec → "unknown error"        ← 路径被切断
T+68s   阿里云自动创建两条 createdByEcsWorkbench 规则
        重试 workbench exec → OK                       ← 自愈完成
```

真实机制是：Workbench 从阿里云内部网段发起 SSH 连接，**并且自己维护对应的安全组规则**。所以"免开端口"指的是**不需要你手动开**，不是不使用入方向端口。

三个实践后果：

| 后果 | 说明 |
|---|---|
| 收紧 22 后第一次 Workbench 调用可能失败 | 约 1 分钟内自愈，重试即可。**不要因此回滚安全组变更** |
| `createdByEcsWorkbench` 规则不能删 | 删了就没有带外通道 |
| 如果有"22 完全不允许任何入方向规则"的硬要求 | Workbench 不满足，那种场景只能靠控制台 VNC |

> 这也说明 §2「阶段 A 必须在 B 之前」的理由要说得更准确：不是因为 Workbench 完全绕开安全组，而是因为**它有权限自己修好自己的路**，而 SSH 没有这个能力。先把 Workbench 打通，才有一条会自愈的通道。

#### 排查 Workbench 报错的顺序

它的错误信息不区分原因，按这个顺序试：

```bash
# ① 安全组里 createdByEcsWorkbench 规则还在吗
aliyun ecs DescribeSecurityGroupAttribute --RegionId $REGION --SecurityGroupId $SG \
  --Direction ingress --profile ${PROJ}-setup | grep -i workbench
# ② 等 1 分钟重试（给它自愈时间）
# ③ 关掉陈旧 session
workbench session list -P $PROJ && workbench session close --all -P $PROJ
# ④ 查云助手 Agent 状态
aliyun ecs DescribeCloudAssistantStatus --RegionId $REGION \
  --InstanceId.1 $INSTANCE --profile ${PROJ}-setup
# ⑤ 最后才怀疑权限（退出码 4）与网络（退出码 5）
```

---

## 5. 阶段 C · 系统层

### 5.1 初始化数据盘（C1）

设备名先实测。NVMe 规格族（如 g9i）是 `/dev/nvme*`，不是 `/dev/vd*`——照抄网上 `/dev/vdb` 的教程会找不到盘。

```bash
workbench exec -i $INSTANCE --timeout 120 -c '
DEV=/dev/nvme1n1                      # 按 lsblk 实测结果替换
parted -s $DEV mklabel gpt
parted -s -a optimal $DEV mkpart primary ext4 0% 100%
sleep 2
mkfs.ext4 -F -L data ${DEV}p1
UUID=$(blkid -s UUID -o value ${DEV}p1)
mkdir -p /data
grep -q "$UUID" /etc/fstab || echo "UUID=$UUID /data ext4 defaults,noatime,nofail 0 2" >> /etc/fstab
mount -a
df -hT /data
echo "UUID=$UUID"
'
```

三个挂载选项的理由：

| 选项 | 为什么 |
|---|---|
| **UUID 而非设备名** | NVMe 设备名可能重启后漂移，写死设备名有风险 |
| **`nofail`** | 盘挂不上时系统仍能启动，保住 SSH 这条救援通道 |
| **`noatime`** | 不记录访问时间，减少大量小文件读取时的无谓写入 |

把 UUID 记进项目手册。

### 5.2 目录规划（C2）

按项目实际需要裁剪，别照抄别的项目。数据库数据目录和备份目录设 `700`。

```bash
workbench exec -i $INSTANCE -c '
mkdir -p /data/{mysql,docker,app,logs,backup,tmp}
chmod 700 /data/mysql /data/backup
ls -la /data
'
```

### 5.3 文件句柄上限（C3）

**两个文件都要写**，否则 systemd 拉起的服务（数据库、容器）上限不变：

```bash
workbench exec -P $PROJ -i $INSTANCE -c '
cat > /etc/security/limits.d/90-app.conf <<EOF
* soft nofile 65535
* hard nofile 65535
* soft nproc  65535
* hard nproc  65535
root soft nofile 65535
root hard nofile 65535
EOF
mkdir -p /etc/systemd/system.conf.d
cat > /etc/systemd/system.conf.d/90-app-limits.conf <<EOF
[Manager]
DefaultLimitNOFILE=65535:524288
EOF
systemctl daemon-reexec
'
```

⚠️ **不要写成 `65535:65535`**（大量教程都这么写）。先查原始值：

```bash
workbench exec -P $PROJ -i $INSTANCE -c 'systemctl show -p DefaultLimitNOFILE'
```

hbecho 实测原值是 `soft=1024 / hard=524288`。写 `65535:65535` 会抬软限（对）同时**把硬限从 524288 压到 65535**（错）。硬限是程序调 `setrlimit` 能自行抬到的上限，压低没有收益。正确写法 `65535:<原硬限>`。

`limits.conf` 只作用于登录会话，systemd 服务读的是 `system.conf`。

**验证有两个陷阱：**

1. **别查 PID 1。** systemd 自己的 nofile 是内置高值（实测 1073741816），跟 `DefaultLimitNOFILE` 无关，查它只会误导。
2. **`DefaultLimitNOFILE` 只影响改动之后启动的服务。** 改完立刻查已运行服务会看到旧值。

正确做法是重启一个无害服务再查：

```bash
workbench exec -P $PROJ -i $INSTANCE -c '
systemctl restart chronyd
awk "/open files/ {print \$4, \$5}" /proc/$(systemctl show -p MainPID --value chronyd)/limits
'
# 期望：65535 <原硬限>
```

### 5.4 内核参数（C4）

按负载结构调，不要照抄。判断依据是**出方向还是入方向密集**：

| 负载类型 | 调参重点 |
|---|---|
| 大量调用外部 API、下载资源（数据采集类） | 本地端口范围、连接回收 |
| 大量用户请求进来（Web 服务类） | accept 队列、syn backlog |

数据采集类项目的参考值：

```bash
workbench exec -P $PROJ -i $INSTANCE -c '
cat > /etc/sysctl.d/90-app.conf <<EOF
# 出方向密集：本地端口耗尽是首个瓶颈
net.ipv4.ip_local_port_range = 10240 65000
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
# 入方向较轻
net.core.somaxconn = 1024
net.ipv4.tcp_max_syn_backlog = 1024
fs.file-max = 1000000
EOF
sysctl --system >/dev/null && for k in net.ipv4.ip_local_port_range net.ipv4.tcp_tw_reuse fs.file-max; do
  printf "  %s = %s\n" "$k" "$(sysctl -n $k)"
done
'
```

⚠️ **加参数前先查有没有更高序号的文件在覆盖你：**

```bash
workbench exec -P $PROJ -i $INSTANCE -c 'grep -rn <参数名> /etc/sysctl.conf /etc/sysctl.d/; ls -1 /etc/sysctl.d/'
```

`sysctl.d` 按文件名字典序加载，**后者胜**。云厂商镜像通常带 `99-` 开头的自有配置，你的 `90-` 会被它覆盖。hbecho 实测有三个文件都设 `vm.swappiness`，最终生效的是 `99-apsara-sysctl.conf` 的值，写在 `90-` 里的那个白写了——现象是"配了读出来还是旧值"，容易误判成配置失败。

⚠️ **`vm.swappiness` 通常不必设。** 先确认有没有 swap：

```bash
workbench exec -P $PROJ -i $INSTANCE -c 'swapon --show; free -h | grep -i swap'
```

没有 swap 分区时（阿里云 ECS 默认没有），swappiness 不起任何作用，设它只会让下一个人以为配置没生效去排查。

> 启用了 firewalld/conntrack 且出方向连接多时，还要看 `net.netfilter.nf_conntrack_max`。表满的表现是**偶发连接失败但没有明确报错**，很容易误判成对方限流。用 `conntrack -C` 看用量。

### 5.5 时间同步核验（C5）

如果应用用了**租约（lease）或 fencing token** 做幂等，时钟准确性是**正确性依赖**，不是运维洁癖——漂移会让两个 worker 同时认为自己持有租约。

```bash
workbench exec -i $INSTANCE -c '
timedatectl | head -4
systemctl enable --now chronyd 2>/dev/null
chronyc tracking | grep -E "Reference ID|System time|Last offset"
'
```

阿里云 ECS 默认已配好内网 NTP（`100.100.61.88`），通常无需改动，但要**确认 offset 在毫秒级**。hbecho 实测为微秒级。

时区选 `Asia/Shanghai` 只影响日志可读性；业务时间应统一存 UTC，应用不得依赖系统时区解释业务时间。

### 5.6 容器运行时（C6）

```bash
workbench exec -i $INSTANCE --timeout 300 -c '
dnf install -y moby docker-compose-plugin      # Alibaba Cloud Linux
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<EOF
{
  "data-root": "/data/docker",
  "log-driver": "json-file",
  "log-opts": { "max-size": "100m", "max-file": "3" },
  "live-restore": true,
  "default-ulimits": { "nofile": { "Name": "nofile", "Hard": 65535, "Soft": 65535 } },
  "registry-mirrors": ["<当天验证可用的加速地址>"]
}
EOF
systemctl enable --now docker
docker info | grep -E "Docker Root Dir|Server Version"
'
```

四项配置的理由：

| 配置 | 为什么 |
|---|---|
| `data-root` 指向数据盘 | 镜像和容器层持续长大，不能占系统盘 |
| `log-opts` 轮转 | 不配这项，容器日志能把磁盘写满。**自建 Compose 部署最常见的事故** |
| `live-restore` | 守护进程重启时容器不停 |
| `registry-mirrors` | Docker Hub 在国内 ECS 上不可达 |

> Alibaba Cloud Linux 上阿里云推荐 `moby`（命令、服务名、API 与标准 Docker 一致），但**它不含 compose 插件**，要另装 `docker-compose-plugin`。
> 镜像加速地址写进文档前先实测能拉通——第三方加速源经常失效。

---

## 6. 阶段 D · 云资源

### 6.1 建 OSS 桶（D1）

**桶名前缀要与 RAM 策略里的限定一致**（例如策略限定 `acs:oss:*:<ACCOUNT>:<PROJ>-*`，桶名就必须 `<PROJ>-` 开头）。

按**保留期不同就分桶**的原则划分。hbecho 的四桶为例：

| 桶 | 用途 | 保留策略 |
|---|---|---|
| `<PROJ>-ods` | 供应商原始字节 | 一年，应用删除为准 |
| `<PROJ>-media` | 正式媒资 | **长期，无过期规则** |
| `<PROJ>-temp` | 下载中转 | 短期 |
| `<PROJ>-backup` | 数据库备份 | 与备份周期一致 |

```bash
EP=oss-$REGION.aliyuncs.com
for b in ods media temp backup; do
  aliyun ossutil mb "oss://${PROJ}-$b" --acl=private --storage-class Standard \
    --redundancy-type LRS -e $EP --region $REGION --profile ${PROJ}-setup
done
aliyun ossutil ls -e $EP --region $REGION --profile ${PROJ}-setup
```

关键选项的理由：

| 选项 | 值 | 为什么 |
|---|---|---|
| **地域** | 与 ECS 完全一致 | 最关键的一项。选错要重建，已上传数据得跨区复制 |
| 读写权限 | **私有** | 全部访问走签名 URL |
| 冗余类型 | LRS | ZRS 加价换可用区级冗余，按预算定 |
| 版本控制 | **不开启** | 见下 |

⚠️ **不要开启版本控制。** 开了以后"删除"只是写删除标记，历史版本继续存在并继续计费。两个后果：保留期承诺被静默破坏（字节还能取回），账单出现查不到来源的存储量。

> **「地域：中国内地通用」是资源包的适用范围，不是 Bucket 的位置。** Bucket 建在哪是创建时单独选的。误建在别的地域，资源包照样抵扣存储费，但 ECS 读写它就变成跨地域公网流量，全额计费且无任何提示。

> 2025-10-13 起，通过 API/SDK/ossutil 新建的桶默认开启「阻止公共访问」。这对私有桶方案是好事，多一层默认保护。

### 6.2 生命周期规则（D2）

⚠️ **同一前缀不能有两条规则**，OSS 会返回 400。要把过期删除和碎片清理**合并进同一条规则**（hbecho 踩过这个）。

```xml
<!-- ods 桶：兜底过期 + 碎片清理，合并成一条 -->
<?xml version="1.0" encoding="UTF-8"?>
<LifecycleConfiguration>
  <Rule>
    <ID>ods-backstop-expire-400d-and-abort-7d</ID>
    <Prefix></Prefix>
    <Status>Enabled</Status>
    <Expiration><Days>400</Days></Expiration>
    <AbortMultipartUpload><Days>7</Days></AbortMultipartUpload>
  </Rule>
</LifecycleConfiguration>
```

```bash
aliyun ossutil api put-bucket-lifecycle --bucket ${PROJ}-ods \
  --lifecycle-configuration file:///tmp/lc-ods.xml \
  -e $EP --region $REGION --profile ${PROJ}-setup
```

两条必须理解的规则：

**碎片清理是刚需不是可选项。** 中断的分片上传会留下未完成分片，它们**在控制台文件列表里看不到但照常计费**。不配这条会出现账单莫名增长且找不到原因。

**兜底过期天数要明显长于应用清理窗口。** 如果应用是权威删除方（按业务顺序清理），OSS 生命周期规则抢在前面会造成"数据库说证据在、字节已经没了"。hbecho 的做法是应用管 365 天、OSS 兜底 400 天。

**长期保留的桶不配任何过期规则**，并且要**验证这个否定条件**：

```bash
aliyun ossutil api get-bucket-lifecycle --bucket ${PROJ}-media \
  -e $EP --region $REGION --profile ${PROJ}-setup
# 期望：只有 AbortMultipartUpload，没有任何 Expiration
```

这是最容易被将来某次"顺手加个清理规则"破坏的一条，所以要显式验证，而不是假定没人会加。

### 6.3 实例 RAM 角色（D3）

目的：机器上**不存长期 AccessKey**。代码向本机元数据地址取临时凭证，SDK 自动刷新。

权限策略按桶和动作分开，**不要用 `AliyunOSSFullAccess`**（那是账号下所有桶的全部权限，包括删桶）。长期保留的桶**不给 `oss:DeleteObject`**——这样"代码 bug 删掉长期资产"这条故障路径被物理堵死。

```bash
# 建角色（信任 ECS 服务）
TRUST='{"Statement":[{"Action":"sts:AssumeRole","Effect":"Allow","Principal":{"Service":["ecs.aliyuncs.com"]}}],"Version":"1"}'
aliyun ram CreateRole --RoleName ${PROJ}-ecs-role --AssumeRolePolicyDocument "$TRUST" --profile ${PROJ}-setup
aliyun ram AttachPolicyToRole --PolicyType Custom --PolicyName ${PROJ}-oss-rw \
  --RoleName ${PROJ}-ecs-role --profile ${PROJ}-setup
aliyun ecs AttachInstanceRamRole --RegionId $REGION --RamRoleName ${PROJ}-ecs-role \
  --InstanceIds "[\"$INSTANCE\"]" --profile ${PROJ}-setup

# 验证
workbench exec -P $PROJ -i $INSTANCE -c \
  "curl -s http://100.100.100.200/latest/meta-data/ram/security-credentials/${PROJ}-ecs-role"
```

返回 JSON 含 `AccessKeyId`（`STS.` 前缀）、`SecurityToken`、**`Expiration`**。看到 `Expiration` 才说明是临时凭证。

#### ⚠️ 绑定角色需要 `ram:PassRole`，且两处都不支持资源级 ARN

hbecho 实测连续失败两次，都是**隐式拒绝**：

| 策略写法 | 报错 | 真相 |
|---|---|---|
| `ecs:AttachInstanceRamRole` 限定实例 ARN | `Forbidden.RAM` / `ImplicitDeny` | 该 action **不支持资源级授权**，必须 `Resource: "*"` |
| 加 `ram:PassRole` 并限定角色 ARN | `InvalidUser.PassRoleForbidden` | `PassRole` 的资源级 ARN 同样不匹配 |

可用的写法是把收紧点放在 Condition 上：

```json
{
  "Sid": "PassRoleToEcs",
  "Effect": "Allow",
  "Action": "ram:PassRole",
  "Resource": "*",
  "Condition": { "StringEquals": { "acs:Service": "ecs.aliyuncs.com" } }
}
```

**这是本清单里第三次遇到同一类问题**（`ecs-workbench`、`AttachInstanceRamRole`、`PassRole`）。规律值得记住：

> 阿里云有相当一部分 action 不支持资源级授权，写了 ARN 得到的是**隐式拒绝而非明确报错**。遇到 `ImplicitDeny` 时，先把 `Resource` 放开到 `*` 验证权限链是否通，再找可用的 `Condition` 来收紧。控制台策略详情页会把这类 statement 标为「无效授权」，可以先在那里发现。

#### 服务器侧用 ossutil 验证权限边界

```bash
workbench exec -P $PROJ -i $INSTANCE -c '
dnf install -y -q unzip
curl -fsSL -o /tmp/o.zip https://gosspublic.alicdn.com/ossutil/v2/2.1.2/ossutil-2.1.2-linux-amd64.zip
cd /tmp && unzip -oq o.zip && install -m755 ossutil-*/ossutil /usr/local/bin/ossutil
ossutil version
'
```

⚠️ **`--mode EcsRamRole` 不接受 `--ecs-role-name`**（会报 `unknown flag`），它自己从元数据服务发现绑定的角色。写了那个参数会让所有操作失败，看起来像权限问题：

```bash
# 正确写法：不配任何 AccessKey
ossutil --endpoint oss-$REGION-internal.aliyuncs.com --region $REGION --mode EcsRamRole \
  cp /tmp/probe.txt oss://${PROJ}-ods/probe.txt
```

逐桶实测读/写/删，确认**长期保留桶的删除是被拒绝的**——这是不对称权限设计有没有真正生效的唯一证据。

### 6.4 endpoint 的账单陷阱

**这是最贵的一个坑。** 同地域下从 ECS 访问 OSS **公网** endpoint 也只有几毫秒，因为物理上仍走内部骨干。也就是说 **`-internal` 漏写不会有任何报错、任何变慢**，只会在月底账单上按公网流出全额计费。

对策不是"code review 注意"，而是**启动期断言**：

```
应用启动时：若检测到运行在 ECS 上（能访问 100.100.100.200）
且 OSS endpoint 不含 "-internal" → 直接启动失败并输出原因
```

人工 review 会漏，断言不会。

流量方向对照：

| 路径 | 计费 |
|---|---|
| 外部源站 → ECS | 公网**入**流量，免费 |
| ECS → OSS（`-internal`） | 内网，免费 |
| ECS → OSS（公网 endpoint） | **公网流出，全额计费** ← 就是这个坑 |
| OSS → 最终用户（签名 URL 直连） | OSS 公网流出，计费。正常路径，可避免占用 ECS 带宽 |

### 6.5 云监控 Agent（D4）

**不装的话只有 CPU 和网络指标，看不到磁盘和内存**——而磁盘水位往往是最需要盯的指标。新机器默认不装。

```bash
workbench exec -P $PROJ -i $INSTANCE -c 'systemctl is-active argusagent'   # 先看装没装
```

⚠️ **第一次装建议直接在控制台点，不要走 API。** hbecho 实测 API 安装失败：

```bash
aliyun cms InstallMonitoringAgent --RegionId $REGION --Force true \
  --InstanceIds.1 $INSTANCE --profile ${PROJ}-setup
# → API 返回 Success: true，但状态查询是 install_faild / YUNDUN.Execute
```

根因是**缺服务关联角色 `AliyunServiceRoleForCloudMonitor`**。控制台的确认弹窗把作用写得很清楚：「允许云监控使用云助手执行命令，以完成自动安装主机监控插件的功能」。没有它，云监控下发不了安装命令，所以卡在"执行"环节——这就是 `YUNDUN.Execute`。

**可靠路径**：控制台 → 云监控 → 主机监控 → 选实例 → 「安装插件」→ 确认创建服务关联角色。它会一次性把角色和插件都搞定。

```bash
# 装完确认
aliyun cms DescribeMonitoringAgentStatuses --InstanceIds $INSTANCE \
  --RegionId $REGION --profile ${PROJ}-setup | grep -E 'Status|Version'
# 期望 Status: running
```

角色建好后 CLI 才可用（后续机器可以纯 CLI 装）。若要让 `<PROJ>-setup` 自己创建这个角色，策略里加：

```json
{
  "Effect": "Allow",
  "Action": "ram:CreateServiceLinkedRole",
  "Resource": "*",
  "Condition": { "StringEquals": { "ram:ServiceName": "cloudmonitor.aliyuncs.com" } }
}
```

⚠️ **服务关联角色的服务名不能猜。** hbecho 这里试过 `cms.aliyuncs.com` 和 `monitor.aliyuncs.com`，都不对，真实值是 **`cloudmonitor.aliyuncs.com`**。产品简称、API endpoint、RamCode（`cms`）、SLR 服务名（`cloudmonitor.aliyuncs.com`）这四者经常互不相同。正确做法是先在控制台触发一次（弹窗会显式写出角色名），再读它的信任策略拿服务名：

```bash
aliyun ram GetRole --RoleName AliyunServiceRoleForCloudMonitor --profile ${PROJ}-setup
```

> 另外：`argusagent` 服务在 4.x 版显示 `inactive` 是**正常的**，新版走 LoongCollector。判断是否正常要看 API 的 `Status: running`，不要看那个服务名。

### 6.6 自动快照（D5）

```bash
# ⚠️ 这个接口的参数名是小写 --regionId，不是其他 ECS 接口常用的 --RegionId
# ⚠️ timePoints 是 UTC 小时。北京 03:00 = UTC 19:00 → 填 "19"
aliyun ecs CreateAutoSnapshotPolicy --regionId $REGION \
  --autoSnapshotPolicyName ${PROJ}-daily \
  --timePoints '["19"]' \
  --repeatWeekdays '["1","2","3","4","5","6","7"]' \
  --retentionDays 7 --profile ${PROJ}-setup

# 取两块盘的 ID
aliyun ecs DescribeDisks --RegionId $REGION --InstanceId $INSTANCE --profile ${PROJ}-setup

# 应用到两块盘
aliyun ecs ApplyAutoSnapshotPolicy --regionId $REGION \
  --autoSnapshotPolicyId sp-xxxx --diskIds '["d-系统盘","d-数据盘"]' --profile ${PROJ}-setup
```

两个坑：

| 坑 | 后果 |
|---|---|
| `timePoints` 按本地时间填 `3` | 快照在北京 11:00 执行，正好撞业务时间 |
| 用 `--RegionId`（大写 R） | 报 `required parameters not assigned: --regionId` |

复核时**两块盘都要有 `AutoSnapshotPolicyId`**：

```bash
aliyun ecs DescribeDisks --RegionId $REGION --InstanceId $INSTANCE --profile ${PROJ}-setup \
  | grep -E 'DiskId|AutoSnapshotPolicyId|"Type"'
```

只配系统盘是常见遗漏，而数据库数据在数据盘，那才是最需要备份的。

**快照不能替代逻辑备份**：快照是块级的，恢复粒度是整盘，误删一张表时你不会想把整盘回滚到昨天。两者都要有。

### 6.7 告警规则（D6）

只报"会导致错误事实或错误账单"的信号。基础四条：

| 指标 | 阈值 | 为什么 |
|---|---|---|
| 数据盘使用率 | 连续 2 次 > 80% | 盘满 = 数据库和容器一起挂 |
| 内存可用率 | 连续 2 次 < 15% | buffer pool 配大了或应用泄漏 |
| 公网流出带宽 | > 带宽 80% | 有流量在穿 ECS，说明架构被绕开 |
| 实例宕机 | 立即 | — |

如果用了租约/fencing，再加一条**时钟偏移 > 1 秒**；如果要求"网络请求期间不持有数据库事务"，再加一条**最长活动事务 > 30 秒**——它是那条设计约束被违反的直接信号。

### 6.7 告警联系人与规则

**告警规则必须绑定联系人组才有意义**，没有组的规则等于只在控制台留个记录。所以先建联系人再建规则。

```bash
aliyun cms PutContact --ContactName <用户名> --Describe "<项目> 负责人" \
  --Channels.SMS <手机号> --Channels.Mail <邮箱> --Lang zh-CN --profile ${PROJ}-setup
aliyun cms PutContactGroup --ContactGroupName ${PROJ}-ops \
  --ContactNames.1 <用户名> --Describe "..." --profile ${PROJ}-setup
```

⚠️ **邮箱通道创建后是 `PENDING`，必须去邮箱点确认链接才生效。** 确认前 `Channels.Mail` 显示为空、`ChannelsState.Mail` 为 `PENDING`，**邮件告警不会送达**。短信通道创建即 `OK`，不需要确认。

```bash
aliyun cms DescribeContactList --ContactName <用户名> --profile ${PROJ}-setup
# 期望 ChannelsState.Mail 从 PENDING 变 OK
```

两条通道都要有：短信能半夜叫醒人，邮件能承载细节。只配邮件的话磁盘满了不会有人知道。

规则创建示例（磁盘那条是最关键的）：

```bash
aliyun cms PutResourceMetricRule --RuleId ${PROJ}-disk-usage --RuleName "${PROJ}-磁盘使用率" \
  --Namespace acs_ecs_dashboard --MetricName diskusage_utilization \
  --ContactGroups ${PROJ}-ops \
  --Escalations.Critical.ComparisonOperator GreaterThanThreshold \
  --Escalations.Critical.Threshold 80 --Escalations.Critical.Statistics Average \
  --Escalations.Critical.Times 2 --Interval 60 \
  --Resources "[{\"instanceId\":\"$INSTANCE\"}]" --profile ${PROJ}-setup
```

常用 MetricName：`diskusage_utilization`（磁盘）、`memory_usedutilization`（内存）、`CPUUtilization`、`VPC_PublicIP_InternetOutRate`（公网流出，单位 bit/s）。前两个**依赖云监控 Agent**（§6.5）。

```bash
# 复核
aliyun cms DescribeMetricRuleList --PageSize 30 --profile ${PROJ}-setup
```

---

## 7. 阶段 E · 可并行的事

### 7.1 ICP 备案（E1）

要 1–3 周，但**只阻塞两件事**：域名解析到内地服务器对外提供服务、CDN 加速域名。以下全部不受阻塞，应并行推进：OSS 使用（走默认域名）、全部后端开发（走 SSH 隧道访问）、数据库部署。

三条最容易踩的：

- **域名 whois 实名信息必须与备案主体一致**，这是最高频驳回原因。过户有几天延迟，越早查越好。
- 短信核验链接**收到后 24 小时内必须点**，过期作废重来。
- 备案期间**不要把域名解析到 ECS 公网 IP**，会被拦截并影响审核。

通过后：加 A 记录 → 安全组开 80/443 → **网站底部挂备案号并链接到 `beian.miit.gov.cn`**（管局会复查，不挂会被撤销备案）。

### 7.2 Git 仓库（E2）

**`.gitignore` 必须先于 `git init`。** 密钥一旦进任何一次 commit，后续删除都无法撤回，唯一有效补救是轮换密钥。

顺序：写 `.gitignore` → 检查工作区里还有没有未被忽略的密钥 → `git init` → 首次提交前 `git status --short` 逐行看一遍 → 建**私有**远端。

必须忽略：`.env` 及变体、`settings.local.json`、`*.pem` / `*.key` / `id_*` / `*_ed25519*`、密码文本文件、`node_modules`、`__pycache__`、构建产物。

必须**进**仓库（别误加进忽略规则）：测试 fixture 与实测证据、设计文档、数据库迁移脚本、`.env.example`。

远端**必须私有**。含甲方身份、组织结构、手机号语义、接口合同的仓库，公开等于一次性交出去。

### 7.3 数据库（E3）

按项目基线选版本，并**用破坏性测试验证关键特性真的生效**。以 MySQL 为例：

```sql
-- CHECK 约束是否真的强制（8.0.16 之前会解析后忽略，建表成功、约束失效、无警告）
CREATE TABLE _probe (v INT, CONSTRAINT ck CHECK (v > 0));
INSERT INTO _probe VALUES (-1);   -- 必须报错 3819
DROP TABLE _probe;

-- 严格模式是否开启（关掉的话非法值被静默截断）
CREATE TABLE _probe2 (n TINYINT);
INSERT INTO _probe2 VALUES (99999);  -- 必须报错 1264
DROP TABLE _probe2;
```

"命令没报错"不等于验证通过。这两条都是**接受了配置但不执行**的失败模式，是最坏的一类——不会有任何提示。

端口只绑 `127.0.0.1`，安全组**永不开放** 3306。

---

## 8. 收尾

| # | 事项 |
|---|---|
| 1 | **删除 `<PROJ>-setup` 的 AccessKey**。它的有效权限等级接近账号管理员，没有理由长期留在笔记本上。下次要改基础设施再签一把 |
| 2 | 把所有实际值（实例 ID、IP、UUID、桶名、角色名、版本号）记进该项目自己的运维手册 |
| 3 | 跑一遍完整验收清单，每项都要看到期望输出 |
| 4 | 做一次备份恢复演练并记录耗时——**没演练过的备份不算备份**，那个耗时是唯一可信的 RTO 估计 |

---

## 9. 验收清单

每项都要看到**期望输出**，退出码 0 不算通过。

| # | 验证 | 期望 |
|---|---|---|
| 1 | `workbench exec` 执行命令 | 返回主机名 |
| 2 | `ssh -o BatchMode=yes <PROJ>` | 密钥登录成功 |
| 3 | 密码认证 | `Permission denied (publickey...)` |
| 4 | `ss -tlnp` 排除 127.0.0.1 | 只有 22 |
| 5 | 安全组入方向规则 | 无 `0.0.0.0/0` 的 22，无 3389 |
| 6 | `df -hT /data` | 数据盘已挂载 |
| 7 | `grep "open files" /proc/1/limits` | 65535 |
| 8 | `chronyc tracking` | offset 毫秒级 |
| 9 | 匿名访问桶 `curl -o /dev/null -w '%{http_code}'` | **403**（403=桶存在且私有；404=桶名错；200=公共读，立即改） |
| 10 | 服务器侧内网 endpoint | 403 且毫秒级 |
| 11 | 长期保留桶的生命周期 | **只有碎片清理，无任何 Expiration** |
| 12 | 实例 RAM 角色元数据 | JSON 含 `Expiration` |
| 13 | 数据库 CHECK 与严格模式 | 两条破坏性插入都报错 |
| 14 | `git grep` 密钥特征 + 历史 | 均为空 |

---

## 10. 已知坑速查

按"会不会静默出错"排序。**前五条的共同特征是不报错**，只能靠制度和定期核对发现。

| # | 坑 | 后果 |
|---|---|---|
| 1 | OSS endpoint 漏写 `-internal` | 无报错、无变慢，只在账单上体现 |
| 2 | 数据库版本不够，约束被接受但不执行 | 建表成功、约束全失效、无警告 |
| 3 | 严格模式被关 | 非法值静默截断，语义丢失 |
| 4 | 时钟漂移 | 租约与 fencing 静默失效 |
| 5 | 长期保留桶被加了过期规则 | 资产被删且无法重建 |
| 6 | 生命周期同前缀两条规则 | 直接 400，配不上去（这个至少会报错） |
| 7 | 不清理 OSS 未完成分片 | 控制台看不见但照常计费 |
| 8 | 容器日志不轮转 | 磁盘被写满，服务全挂 |
| 9 | 安全组留着 `0.0.0.0/0` 又加窄规则 | 并集语义，等于没收紧 |
| 10 | RAM 策略改了但当前版本还是 v1 | 编辑等于没做 |
| 11 | RAM 策略建了但没授权给用户 | 调用报 `Forbidden.RAM` / `ImplicitDeny` |
| 12 | 策略 ARN 用了不支持资源级授权的产品 | 控制台标「无效授权」，调用被隐式拒绝 |
| 13 | `limits` 只改一处 | systemd 服务 fd 上限没变 |
| 14 | 只给系统盘配自动快照 | 最需要备份的数据盘没备 |
| 15 | 密钥进 git | 删文件改历史都无效，只能轮换 |
| 16 | 把 VPN 出口 IP 加进安全组白名单 | 等于放行该主机商所有租户 |
| 17 | 只看实例详情页判断磁盘 | 漏掉未初始化的数据盘 |
| 18 | 照抄别的项目的设备名/版本号/实测值 | 手册第一章就是错的 |
| 19 | 照抄另一个账号的策略 ARN | ARN 含账号 ID，跨账号全部失效（§0.1） |
| 20 | 忘记带 `--profile` / `-P` | 命令打到另一个项目的账号上；只读时只是找不到实例，写操作可能改错资源 |
| 21 | 两个项目 SSH 隧道用同一本地端口 | **数据库客户端连到另一个项目的库，且无任何报错**（§0.1） |
| 22 | 删掉 `createdByEcsWorkbench` 安全组规则 | 切断带外通道（§4.5） |
| 23 | 收紧 22 后 Workbench 首次失败就回滚安全组 | 它 1 分钟内自愈，回滚等于白做（§4.5） |
| 24 | `DefaultLimitNOFILE=65535:65535` | 抬了软限，同时把硬限从 524288 **压低**（§5.3） |
| 25 | 查 PID 1 的 limits 来验证 | systemd 自身是内置高值，与配置无关（§5.3） |
| 26 | 在 `90-` 文件里设 `vm.swappiness` 等参数 | 被云厂商 `99-` 文件覆盖，且无 swap 时本就无作用（§5.4） |
| 27 | 拿 `DescribeDisks` 返回的 `/dev/xvdb` 去 `mkfs` | 系统内是 NVMe 命名，那个路径不存在（§5.1） |
| 28 | 快照 `timePoints` 按本地时间填 | 它是 **UTC 小时**。想要北京 03:00 要填 `19`（§6.6） |
| 29 | `ossutil --mode EcsRamRole` 加 `--ecs-role-name` | 不存在该参数，所有操作失败，看起来像权限问题（§6.3） |
| 30 | 只看成功/失败不看真实报错 | 参数错误、权限不足、网络不通在包装后长得一样 |
| 31 | 猜服务关联角色的服务名 | 与产品简称/RamCode 都不同，猜错就静默失败（§6.5） |
| 32 | 看 `argusagent` 服务状态判断云监控是否正常 | 4.x 版走 LoongCollector，该服务本就 inactive（§6.5） |
| 33 | 建了告警联系人就以为通道可用 | 邮箱是 `PENDING`，**必须去邮箱点确认链接**才送达；短信才是建完即用（§6.7） |
| 34 | 按文件名匹配的脚本没关 `core.quotepath` | 含中文的路径被 git 转义成八进制并加引号，`$` 锚点全部失效（§7.2） |

---

## 11. 变更记录

| 日期 | 变更 | 操作人 |
|---|---|---|
| 2026-09-03 | 本清单创建。内容全部来自 hbecho 的一次实际执行，每条都经过验证 | Kiro |
| 2026-09-03 | 补 §0.1 多项目/多阿里云账号共存约定、§0.2 取账号 ID、§0.3 与项目手册的分工。起因：确认 hbdam 位于独立的阿里云账号，ECS 与 RAM 完全独立 | Kiro |
| 2026-09-03 | `<PROJ>-setup-buildout` 策略完整 JSON 内联，清单改为**自包含**，不再依赖某个项目的运维手册 | Kiro |
| 2026-09-03 | 补 §4.5 收紧 22 的实测结果；修正 `RevokeSecurityGroup` 参数笔误 | Kiro |
| 2026-09-03 | 按 hbecho 阶段 C/D 的实际执行回填：limits 硬限不可压低、sysctl 被 `99-` 覆盖、NVMe 与 API 设备名不同、快照 `timePoints` 用 UTC、`--regionId` 小写、`PassRole` 不支持资源级 ARN、`ossutil EcsRamRole` 无 `--ecs-role-name`、云监控 API 安装失败需走控制台。已知坑扩到 30 条 | Kiro |
| 2026-09-03 | ⚠️ **更正**：Workbench 并非不使用入方向 22，而是从阿里云内网段发起并**自动写入 `createdByEcsWorkbench` 安全组规则**。先前判成「陈旧 session」是错的。§3.1、§2、§4.5 已按真实机制改写 | Kiro |
| 2026-09-03 | 再回填一轮：云监控 SLR 服务名 `cloudmonitor.aliyuncs.com` 不可猜、`argusagent` inactive 是正常的、邮箱通道 `PENDING` 需确认、`core.quotepath` 影响文件名匹配。新增 §6.7 告警联系人与规则。已知坑扩到 34 条 | Kiro |
