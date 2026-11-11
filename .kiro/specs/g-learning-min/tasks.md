# G Learning Min Implementation Plan

> **状态**：`draft`
> **执行状态**：进行中（2026-11-11 刘学奎确认 spec 可实施；**首批任务 1、2、3、5、9 已完成**，分支 `g-learning-min`；视频相关 4、6、7 及 8、10、11、12 未做，等播放域名备案与页面排期）
> **需求**：[`requirements.md`](requirements.md)
> **设计**：[`design.md`](design.md)
> **所属域**：G 学习平台 · **目录命名**：新名 `g-learning-min`，符合 `<代号>-<切片>`
> **最近核对**：2026-10-29
> **更新日期**：2026-11-11

## Planning rules

**首批范围（2026-10-30 决定）**：先做不依赖 VOD 的那一半——任务 1、2、3、5、9；视频相关（4、6、7）等播放域名备案后再做。任务顺序不变，只是执行时跳过视频部分。

- 任务按纵向结果排序：每个任务结束时留下可运行、可观察的增量，不建空表或空接口。
- 默认验收离线：VOD 与 OSS 全部走 fake transport，禁用网络；真实 smoke 需人工批准并记预算。
- 不在任务中重新选型；技术栈沿用 ADR-0005，目录结构以首批应用代码落地时确定的约定为准（本文件只写模块名，不写死路径）。
- 所有内部 BIGINT 输出十进制字符串；时间 UTC `DATETIME(6)`；状态 `VARCHAR + CHECK`；无 `ON DELETE CASCADE`。
- 每完成一个任务运行它的离线验收，并在 `tasks.md` 勾选、写明尚未证明的部分。

## Tasks

- [x] 1. 建表与数据约束
  - **Requirements:** G-1、G-2、G-15
  - **Design:** §3
  - 迁移新增 `courses`、`course_brand_scopes`、`tags`、`course_tags`、`learning_progress` 五张表，含 §3.1 的组合 CHECK（`kind` × 文件字段、`audience_level` 枚举）、唯一键与 RESTRICT 外键。
  - **验证**：干净库连续执行两次迁移幂等；故意写错 `kind='video'` 但缺 `vod_video_id` 时数据库报错；删除被引用的课程被 RESTRICT 拒绝。
  - **完成（2026-11-11）**：迁移 `0009_learning_schema`，五张表 + `learning_progress` 的唯一键；`src/db/learning-schema.db.test.ts` 在 MySQL 8.4 上逐项验证 A1–A4、组合 CHECK、RESTRICT（7 条外键无 CASCADE / SET NULL）。与设计的差异见 design D25 / D26 / §3.1（封面对资料可选；主键列名 `course_id`；跨域外键已建）。**未证明**：`learning_progress` 的写入语义（任务 7）。

- [x] 2. 标签集合管理
  - **Requirements:** G-3
  - **Design:** §3.3
  - 实现 `learning-tags` 模块：列表、创建、改名、删除；删除前检查引用，被引用返回 409 与引用数。只接受 `learning.tag.manage`。
  - **验证**：无 `learning.tag.manage` 调用全部 403；删除被引用标签返回 409；改名后课程引用不变。
  - **完成（2026-11-11）**：`tags.ts`；`tags.db.test.ts` 覆盖 403 / 409（带引用数）/ 改名不动引用 / 审计 / 名称规则。**列表归 `learning.read`**（D29）。**未证明**：页面。

- [x] 3. 资料课程创建（OSS 直传）
  - **Requirements:** G-1、G-5、G-15
  - **Design:** §4.2、§3.6
  - 签名直传地址（`hbecho-course` 桶，前缀 `doc/`）、HEAD 校验（size / content-type）、校验失败删除对象、创建课程行；格式白名单 PDF / JPG / PNG；上限取配置。
  - **验证**：fake OSS 下超限拒绝、格式错误拒绝、HEAD 不匹配时对象被删且不建行；成功后课程状态为 `published`。
  - **完成（2026-11-11）**：`courses.ts`（`requestUpload`、`createDocumentCourse`）与 `oss-course-store.ts`；`courses.db.test.ts` 覆盖 B1–B3、C1、C5–C7、I6、魔数、key 形态、被占用对象不误删、审计失败整体回滚。上限取 `config.ts`（50 MiB / 5 MiB）。**未证明**：真实 `hbecho-course` 桶的直传、`HEAD` 与 Range 读取（只用假客户端测过适配器，E4 待首次真实 smoke，需人工批准）。

- [ ] 4. 视频课程创建（VOD）
  - **Requirements:** G-1、G-4
  - **Design:** §4.1
  - 取上传凭证时显式传 `TemplateGroupId=3ca24a90956dbbfa16f1f6cf2fe6ad3a` 与 `cn-beijing` endpoint；上传完成后按状态建行（`transcoding` 或 `normal`）；转码完成后回填 `duration_sec`；创建接口带 `Idempotency-Key`，重复提交返回同一课程。
  - **验证**：fake VOD 覆盖凭证成功、失败、转码中、转码失败四种；凭证请求中断言模板组与 endpoint；转码中可建行但播放接口返回 202。

- [x] 5. 课程列表、详情与可见范围
  - **Requirements:** G-1、G-2、G-8、G-12
  - **Design:** §5.1
  - 列表按「已发布 + 品牌范围交集 + 人员级别」过滤，支持标题子串搜索、单标签筛选、`inProgress` 筛选；返回 `inProgress` 与 `lastLearnedAt`。
  - **验证**：`brand_scope='all'` 的课程在任何品牌可见；指定集合只对交集品牌可见；`branch_and_above` 课程对 `store_staff` 不可见；`hq_and_above` 对 `branch_manager` 不可见；范围外返回 403 而非空页；多标签参数被拒绝；**越权测试**：A 品牌账号访问 B 品牌课程的详情、播放、下载、搜索、汇总全部拒绝。
  - **完成（2026-11-11）**：`read.ts`（`listCourses`、`getCourse`、`parseListQuery`）与 `visibility.ts`；`read.db.test.ts` 含 36 门课 × 7 种主体的「对象判断 ≡ 查询条件」对照、B4–B10、E4/E5 读侧、越权（详情 / 搜索 / 列表）。**未证明**：播放与汇总两个入口的越权（任务 6、10 才有）；`learning_progress` 由任务 7 写入，这里只读。**课程管理（维护者）列表**不在首批，等页面任务。

- [ ] 6. 播放凭证与资料预览
  - **Requirements:** G-5、G-6
  - **Design:** §4.3、§6
  - 视频：校验范围与状态后调 `GetVideoPlayAuth`；资料：返回 OSS 短期签名 URL。
  - **验证**：响应不含原始文件 URL；撤销范围后下一次请求 403 且未调用 VOD；转码中 202、失败 409、凭证失败可重试。

- [ ] 7. 学习进度与续播
  - **Requirements:** G-7
  - **Design:** §4.4、§5.2
  - 心跳上报 upsert；**不做位置回退保护**（G-D18）；单次增量超过 60 秒截断（G-D19）；`play_count` 在真正起播时 +1。
  - **验证**：同一用户同一课程只有一行；上报 0 秒后读到 0 秒（确认无隐藏保护）；单次上报 600 秒时 `watched_sec` 只增 60；换设备后读到同一位置；并发上报不产生重复行。

- [ ] 8. 替换、下架与审计
  - **Requirements:** G-9、G-13
  - **Design:** §6
  - 替换覆盖并异步删除旧 VOD 视频；下架后 403；审计记录旧文件标识；删除失败进重试。
  - **验证**：替换后进度不清零；下架后列表与直链均拒绝；审计含旧 `VideoId`；删除失败被记录且重试成功。

- [x] 9. 资料下载与下载审计
  - **Requirements:** G-10、G-13
  - **Design:** §4.3、§6
  - 下载走签名 URL，写审计；范围外拒且不产生下载审计（只记拒绝事件）。
  - **验证**：审计字段完整；下架课程不可下载；预览不产生下载审计。
  - **完成（2026-11-11）**：`download.ts`，走 B 的出口 10；`download.db.test.ts` 覆盖 F3、F5、F6、签发失败补 `failed` 审计、预览不产生下载审计。**未证明**：资料「预览」签名 URL（任务 6 的资料半边）；真实 OSS 的 `Content-Disposition` 覆盖是否生效（E4）。

- [ ] 10. 总部汇总
  - **Requirements:** G-11
  - **Design:** §5.3
  - 四个累计指标；人数/时长/次数含已下架课程（G-D20），课程数只算已发布；多品牌默认合计可切换；`range` 参数只接受 `all`；`branch_manager` / `store_staff` 403。
  - **验证**：学习人数去重；响应无个人标识；同一「全部品牌」课程跨品牌不重复计人；口径与页面文案一致。

- [ ] 11. 定时清理：残渣与归档
  - **Requirements:** G-4、G-9
  - **Design:** §6
  - 两个独立任务：① 扫描 VOD 中无 `courses.vod_video_id` 引用的视频，超过 24 小时删除（G-D23）；② 扫描下架满 30 天的课程，删除媒体并把 `status` 置 `archived`（G-D37）。
  - **验证**：孤儿视频 12 小时保留、30 小时删除；有课程引用的不删；下架 29 天的课程不动、31 天的归档且媒体已删；归档课程详情/播放/下载均 403；进度与汇总数字不下降。

- [ ] 12. 权限接入、离线验收与文档回写
  - **Requirements:** G-12、G-14
  - **Design:** §7、§8
  - 接入四个 Capability；确认业务代码无角色判断；补 acceptance 全部自动项；回写 runbook 与 ADR 的实测值。
  - **验证**：全量离线测试通过且无网络调用；`./scripts/verify.sh` 通过；acceptance 清单逐项勾选。

- [ ] 页面任务：**本轮不写**。界面设计已于 2026-11-10 确认（design §11.6），原型在 [`ui-lab/g-learning-min/`](../../../ui-lab/g-learning-min/README.md)；页面任务另行排期，按确认范围拆。

## 对已有代码与测试的改动

实施时（2026-11-11）仓库已有 A、B 域应用代码：本 spec 新增 `src/db/schema/learning.ts`、迁移 `0009_learning_schema`、`src/modules/learning/`、`tests/harness/{learning,fake-course-store}.ts`，不改 A / B 域既有文件。资源键 `learning_course` 与 Capability 在 B 的注册表里本来就有。装配处（把 `learningCourseStrategy` 注册进 `AccessRegistry`、构造 `LearningDeps`）留给页面任务。

**与 `a-activity-plan` 并行**：两者各自从 `main` 切分支，迁移序号都是 `0009`。后合并的一方在合并前把自己的迁移重命名为下一个序号并重新生成快照与 `_journal.json`（schema 本身无冲突，`src/db/schema/index.ts` 各加一行导出）。

## 必须停下来问的条件

- 任何需要放宽 `database-design-v2.md` 类型或约束的决定；
- 任何要跳过品牌范围检查、或把 403 改成 404 的改动；
- VOD 模板组 ID、存储地址或 endpoint 需要变更；
- 发现 PRD 与实现矛盾（例如汇总口径）。

小的判断自己做：字段长度、索引命名、错误码文案、测试用例命名。