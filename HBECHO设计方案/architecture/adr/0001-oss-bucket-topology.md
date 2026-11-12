# ADR-0001 · OSS 按保留期分四桶

- **状态**：accepted（2026-10-29 修订：新增第五个桶 `hbecho-course`；2026-11-12 修订：新增第六个桶 `hbecho-signals`，**尚未创建**）
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

## 2026-11-12 修订：新增第六个桶 `hbecho-signals`

- **决策人**：刘学奎（2026-11-12，[`c-signals` design §14](../../../.kiro/specs/c-signals/design.md) 第 1 项）
- **关闭**：`c-signals` 监控段的标准图 / 元素图存放位置

域 C 的标准图与元素图随监控判定计划存放，计划删除期满后要**物理删除**对象（PRD C §5.5、D PRD §2.0）。`hbecho-media` 的 RAM 策略刻意没有 `DeleteObject`，把它们放进去会让「media 桶永不删除」的物理保证去承担一个「必须删除」的场景——与第五个桶 `hbecho-course` 的理由相同。

新增 `hbecho-signals`，做法同 `hbecho-course`：

- 地域 `cn-beijing`、ACL 私有、开启「阻止公共访问」；
- **无过期规则** + 碎片 7 天（保留期由应用按监控判定计划的生命周期删除）；
- 应用角色 `hbecho-ecs-role` 在该桶额外授予 `DeleteObject`；
- 只放标准图与元素图，不放采集媒资，不与 `media` 桶互相引用；
- 标准图对象**不**写入 A 域的 `media_assets` / `oss_objects`；C 的 `segment_images` 自带 `bucket` / `object_key`；
- 对象键含「监控判定计划 ID + 版本 + 图像对象 + 图片 SHA-256」。

**本修订只是登记决定，不含创建动作。** 创建桶、增加 RAM 授权需要单独说明并逐步得到同意（`server-access.md`）；创建前运维手册里该桶标「未创建」，`c-signals` 的离线测试用 fake OSS，不受影响。

## 后果

- 四套 RAM 策略、四份配置（`course`、`signals` 另计）；跨桶去重不可行（`media_assets` 本来就只在 media 桶内去重，不受影响）。
- 「media 桶永不自动删除」成为一条可验证的物理事实，而不是纪律。
- 桶名进入 `oss_objects.bucket/object_key` 后成为历史事实；再改拓扑要同时搬对象与改历史行。

## 现在谁在守

- RAM 策略 `hbecho-oss-rw`：`media` 与 `backup` 桶**没有 `oss:DeleteObject`**，已实测删除被拒。
- OSS 生命周期规则已实测：media 无过期规则。
- runbook §13.3 把「验证一个不存在」写成固定验收项。

## 2026-11-11 补记：`hbecho-course` 的实测（g-learning-min）
- 运行期身份 `hbecho-ecs-role`（策略 `hbecho-oss-rw` 的 `CourseDocReadWriteDelete`）在测试 ECS 的 `hbecho-web` 容器里实测：`PutObject`、`HEAD`、`Range`、`getStream`、签名 GET、`ListObjects`、`DeleteObject` 全部成功（见 ADR-0017「运行期身份」）；`DeleteObject` 在该桶是预期行为，与 media 桶相反。
- 该桶原本没有 CORS 配置（`NoSuchCORSConfiguration`）；2026-11-11 已配置：来源 `https://echo.hbmarketer.com`，方法 PUT / GET / HEAD，头 `Content-Type`，暴露 `ETag`。真实 Chrome 的直传预检（OPTIONS）与 PUT 均 200。
- 默认域名对该桶所有对象的签名 GET 都返回 `Content-Disposition: attachment`、`x-oss-force-download: true`：不能用来做浏览器内联预览，预览改由应用转发（ADR-0017）。
- 桶内前缀：资料 `doc/`、封面 `cover/`；对象 key 由应用生成（`<前缀>/<uuid>.<扩展名>`）。无引用超过 24 小时的对象由 `learning-worker` 清理。

## 原文

`HBECHO设计方案/runbooks/server-operations-runbook.md` §7.2–§7.7、§13.3；`CONTEXT.md` MediaAsset、FormalMediaRetention；`database-design-v2.md` §11。