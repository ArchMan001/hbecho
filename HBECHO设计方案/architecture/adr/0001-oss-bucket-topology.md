# ADR-0001 · OSS 按保留期分四桶

- **状态**：accepted（2026-10-29 修订：新增第五个桶 `hbecho-course`）
- **日期**：2026-09-03
- **决策人**：刘学奎
- **替代**：runbook §7.2 中「建议（待确认）」的单桶 + 前缀方案

## 背景

数据底座同时承载三类保留期方向相反的对象：

| 类别 | 保留期 | 删除责任方 |
|---|---|---|
| `ods` 原始载荷 | 一年后必须删除 | 应用按 payload → call → task → object 顺序清理 |
| `media` 正式媒资 | 长期，永不自动过期 | 仅人工业务决定 |
| `temp` 下载中转 | 短期 | OSS 生命周期 |

如果放在同一个桶里靠前缀区分，「删除 ODS」就会变成一条按前缀匹配的生命周期规则或批量删除操作。前缀写错一次，删掉的是长期媒资，而且没有任何东西能挡住。

## 决定

分四个桶，均在 `cn-beijing`、私有、开启「阻止公共访问」：

- `hbecho-ods`：400 天兜底过期 + 7 天碎片清理
- `hbecho-media`：**无任何过期规则** + 7 天碎片清理
- `hbecho-temp`：3 天过期 + 1 天碎片清理
- `hbecho-backup`：`mysql/` 前缀 30 天 + 7 天碎片清理

服务器侧代码只准使用内网 endpoint `oss-cn-beijing-internal.aliyuncs.com`。

## 备选与不选原因

| 方案 | 不选原因 |
|---|---|
| 单桶 + 前缀 | 长期媒资与一年期 ODS 的删除规则只隔一个前缀字符串；误配不可恢复 |
| 单桶 + 版本控制 | 删除变成写删除标记，历史版本继续计费，破坏一年保留承诺 |

## 2026-10-29 修订：新增第五个桶 `hbecho-course`

域 G 的课程资料（PDF / JPG / PNG）需要在替换时**删除旧对象**，而 `hbecho-media` 的 RAM 策略刻意没有 `DeleteObject`。把课程资料放进 media 桶，等于让一条为「删除 ODS 时前缀写错也删不掉长期媒资」设计的物理保证，去承担一个「必须删除」的场景——这正是本 ADR 拆桶要防的错误。

新增 `hbecho-course`：

- 地域 `cn-beijing`、ACL 私有；桶级「阻止公共访问」已于 2026-10-30 开启；
- **无过期规则**（课程存续期保留）；
- 应用角色 `hbecho-ecs-role` 在该桶**额外授予** `DeleteObject`；
- 只放课程资料，不放采集媒资，也不与 `media` 桶互相引用；
- 课程对象不写入 A 域的 `media_assets` / `oss_objects`。

原「四个桶」的决定与理由不变；本修订只增加一个用途独立、删除语义与 media 相反的桶。

## 后果

- 四套 RAM 策略、四份配置；跨桶去重不可行（`media_assets` 本来就只在 media 桶内去重，不受影响）。
- 「media 桶永不自动删除」成为一条可验证的物理事实，而不是纪律。
- 桶名进入 `oss_objects.bucket/object_key` 后成为历史事实；再改拓扑要同时搬对象与改历史行。

## 现在谁在守

- RAM 策略 `hbecho-oss-rw`：`media` 与 `backup` 桶**没有 `oss:DeleteObject`**，已实测删除被拒。
- OSS 生命周期规则已实测：media 无过期规则。
- runbook §13.3 把「验证一个不存在」写成固定验收项。

## 原文

`HBECHO设计方案/runbooks/server-operations-runbook.md` §7.2–§7.7、§13.3；`CONTEXT.md` MediaAsset、FormalMediaRetention；`database-design-v2.md` §11。