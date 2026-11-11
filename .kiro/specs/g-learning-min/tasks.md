# G Learning Min Implementation Plan

> **状态**：`draft`
> **执行状态**：任务 1–12 与页面任务 P1–P4 已实现并经真实环境验证（2026-11-11，见各任务「复核」）；仍未解决的只剩 Aliplayer 线上 License、真实手机 / 微信渲染、首次部署。分支 `g-learning-min`，已推送；CI run 42990449510（verify + image）全绿，本机 `verify.sh` 通过（单元 760、数据库 1052）
> **需求**：[`requirements.md`](requirements.md)
> **设计**：[`design.md`](design.md)
> **所属域**：G 学习平台 · **目录命名**：新名 `g-learning-min`，符合 `<代号>-<切片>`
> **最近核对**：2026-11-11
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
  - **完成（2026-11-11）**：迁移 `0009_learning_schema`，六张表（含待删除队列 `course_media_deletions`）；`src/db/learning-schema.db.test.ts` 在 MySQL 8.4 上逐项验证 A1–A4、组合 CHECK、封面必填（G-D48）、下架时刻与状态的绑定、创建幂等键、RESTRICT（7 条外键无 CASCADE / SET NULL）。与设计的差异见 design D25–D35。迁移尚未推送，所以直接重生成了 0009，没有追加 0010。

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
  - **完成（2026-11-11）**：`courses.ts`（`requestUpload`、`createDocumentCourse`）、`course-common.ts`、`oss-course-store.ts`；`courses.db.test.ts` 覆盖 B1–B3、C1、C5–C7、I6、魔数、key 形态、被占用对象不误删、封面必填、审计失败整体回滚。上限取 `config.ts`（50 MiB / 5 MiB）。**真实桶 smoke 已通过**（2026-11-11 刘学奎批准；`pnpm learning-smoke`）：签名 PUT、Content-Type 绑定（不符 403）、HEAD、Range、流式读取、附件名、List、Delete 全部成功，见 ADR-0017。**复核**：`hbecho-course` 已配 CORS；真实 Chrome 浏览器直传（OPTIONS 200 + PUT 200）通过；运行期角色 `hbecho-ecs-role` 在测试 ECS 的 app 容器里实测 PUT / HEAD / Range / getStream / 签名 GET / List / Delete 全部放行。

- [x] 4. 视频课程创建（VOD）
  - **Requirements:** G-1、G-4
  - **Design:** §4.1
  - 取上传凭证时显式传 `TemplateGroupId=3ca24a90956dbbfa16f1f6cf2fe6ad3a` 与 `cn-beijing` endpoint；上传完成后按状态建行（`transcoding` 或 `normal`）；转码完成后回填 `duration_sec`；创建接口带 `Idempotency-Key`，重复提交返回同一课程。
  - **验证**：fake VOD 覆盖凭证成功、失败、转码中、转码失败四种；凭证请求中断言模板组与 endpoint；转码中可建行但播放接口返回 202。
  - **完成（2026-11-11）**：`courses.ts`（`requestVideoUpload`、`createVideoCourse`）、`vod.ts` 端口、`vod-aliyun.ts`（官方 SDK，ADR-0017）、`jobs.ts` 的 `refreshVideoStatuses`；`video.db.test.ts` 覆盖 D1–D3、D7、超限删除、封面必填；模板组与 cn-beijing 常量在 `learning.test.ts` 里对适配器请求断言。**复核**：真实 VOD（`pnpm learning-smoke-vod`）+ 真实 Chrome 浏览器分片上传通过：凭证、转码（`uploading→transcoding→normal`）、时长回填、标题同步、删除、列表；真实运行暴露并修复了两处：上传后 VOD 状态滞后（页面自动重试 ≤90 秒）、`GetVideoList` 无视频时报 NotFound（适配器转为空列表）。**仍未验证**：转码是否真出 720p / 480p（测试源只有 320×240，只出了一档）；MP4/H.264/AAC 的编码只在前端检查扩展名，服务端不解析（G-D33 的编码部分未验证）。

- [x] 5. 课程列表、详情与可见范围
  - **Requirements:** G-1、G-2、G-8、G-12
  - **Design:** §5.1
  - 列表按「已发布 + 品牌范围交集 + 人员级别」过滤，支持标题子串搜索、单标签筛选、`inProgress` 筛选；返回 `inProgress` 与 `lastLearnedAt`。
  - **验证**：`brand_scope='all'` 的课程在任何品牌可见；指定集合只对交集品牌可见；`branch_and_above` 课程对 `store_staff` 不可见；`hq_and_above` 对 `branch_manager` 不可见；范围外返回 403 而非空页；多标签参数被拒绝；**越权测试**：A 品牌账号访问 B 品牌课程的详情、播放、下载、搜索、汇总全部拒绝。
  - **完成（2026-11-11）**：`read.ts`（`listCourses`、`getCourse`、`parseListQuery`）与 `visibility.ts`；`read.db.test.ts` 含 36 门课 × 7 种主体的「对象判断 ≡ 查询条件」对照、B4–B10、E4/E5 读侧、越权（详情 / 搜索 / 列表）。**未证明**：播放与汇总两个入口的越权（任务 6、10 才有）；`learning_progress` 由任务 7 写入，这里只读。**课程管理（维护者）列表**不在首批，等页面任务。

- [x] 6. 播放凭证与资料预览
  - **Requirements:** G-5、G-6
  - **Design:** §4.3、§6
  - 视频：校验范围与状态后调 `GetVideoPlayAuth`；资料：返回 OSS 短期签名 URL。
  - **验证**：响应不含原始文件 URL；撤销范围后下一次请求 403 且未调用 VOD；转码中 202、失败 409、凭证失败可重试。
  - **完成（2026-11-11）**：`playback.ts`（`getPlayback`、`openDocumentPreview`）；`playback.db.test.ts` 覆盖 D4–D6、F7。**资料预览改为服务端转发**（真实桶实测默认域名强制下载，D32 / ADR-0017）。**复核**：真实 `GetVideoPlayAuth` 通过；真实 Chrome（localhost）里 Aliplayer 2.25.1 加载并播放到片尾（播放地址是 VOD 存储桶的 OSS 默认域名，**不需要自有播放域名**，ADR-0017）；资料内联预览在桌面 Chrome 的 iframe 里加载成功。**仍未验证**：`echo.hbmarketer.com` 上的 Aliplayer License（控制台申请）；PDF 在真实手机浏览器 / 微信里的表现。

- [x] 7. 学习进度与续播
  - **Requirements:** G-7
  - **Design:** §4.4、§5.2
  - 心跳上报 upsert；**不做位置回退保护**（G-D18）；单次增量超过 60 秒截断（G-D19）；`play_count` 在真正起播时 +1。
  - **验证**：同一用户同一课程只有一行；上报 0 秒后读到 0 秒（确认无隐藏保护）；单次上报 600 秒时 `watched_sec` 只增 60；换设备后读到同一位置；并发上报不产生重复行。
  - **完成（2026-11-11）**：`progress.ts` + `http.ts`（`POST /api/learning/progress`，Origin 校验）；`progress.db.test.ts` 覆盖 E1–E6、资料只记首末时间与打开次数、Route Handler 状态映射。本机用 `next dev` + 真实 MySQL + 真实登录会话 + 真实桶走通了预览与上报路由。**复核**：真实 Chrome 里起播上报、结束上报、离开页面的补报 POST 均 200（测试视频只有 3 秒，**15 秒定时心跳本身没跑到**）；换设备 / 续播位置由数据库测试覆盖。**仍未验证**：手机上的暂停 / 切后台 / 锁屏表现（M1、M2）。

- [x] 8. 替换、下架与审计
  - **Requirements:** G-9、G-13
  - **Design:** §6
  - 替换覆盖并异步删除旧 VOD 视频；下架后 403；审计记录旧文件标识；删除失败进重试。
  - **验证**：替换后进度不清零；下架后列表与直链均拒绝；审计含旧 `VideoId`；删除失败被记录且重试成功。
  - **完成（2026-11-11）**：`manage.ts`（管理列表、编辑、下架 / 上架、替换文档 / 视频）、`media-deletions.ts`（待删除队列，新表 `course_media_deletions`）；`manage.db.test.ts` 覆盖 F1–F4、I4、维护范围、标题同步 VOD、旧文件删除失败重试。**复核**：真实 VOD 的 `DeleteVideo`（最终一致：删除后几秒内仍可查到）/ `UpdateVideoInfo` / `GetVideoList` 通过。

- [x] 9. 资料下载与下载审计
  - **Requirements:** G-10、G-13
  - **Design:** §4.3、§6
  - 下载走签名 URL，写审计；范围外拒且不产生下载审计（只记拒绝事件）。
  - **验证**：审计字段完整；下架课程不可下载；预览不产生下载审计。
  - **完成（2026-11-11）**：`download.ts`，走 B 的出口 10；`download.db.test.ts` 覆盖 F3、F5、F6、签发失败补 `failed` 审计、预览不产生下载审计。**未证明**：资料「预览」签名 URL（任务 6 的资料半边）；真实 OSS 的 `Content-Disposition` 覆盖是否生效（E4）。

- [x] 10. 总部汇总
  - **Requirements:** G-11
  - **Design:** §5.3
  - 四个累计指标；人数/时长/次数含已下架课程（G-D20），课程数只算已发布；多品牌默认合计可切换；`range` 参数只接受 `all`；`branch_manager` / `store_staff` 403。
  - **验证**：学习人数去重；响应无个人标识；同一「全部品牌」课程跨品牌不重复计人；口径与页面文案一致。
  - **完成（2026-11-11）**：`summary.ts`；`summary.db.test.ts` 覆盖 G1–G7、I5、品牌切换、503 不返回部分数字。

- [x] 11. 定时清理：残渣与归档
  - **Requirements:** G-4、G-9
  - **Design:** §6
  - 两个独立任务：① 扫描 VOD 中无 `courses.vod_video_id` 引用的视频，超过 24 小时删除（G-D23）；② 扫描下架满 30 天的课程，删除媒体并把 `status` 置 `archived`（G-D37）。
  - **验证**：孤儿视频 12 小时保留、30 小时删除；有课程引用的不删；下架 29 天的课程不动、31 天的归档且媒体已删；归档课程详情/播放/下载均 403；进度与汇总数字不下降。
  - **完成（2026-11-11）**：`jobs.ts`（转码回填、归档、残渣清理、一轮维护）与 `worker/learning-main.ts`（`pnpm learning-worker`）；`jobs.db.test.ts` 覆盖 I1、I2、I4、I5、退避与告警。**复核**：真实 VOD 列表接口通过，清理只认带 `hbecho-course` 标签的视频。镜像里已有 `src/` 与 `tsx`，worker 不需要改 Dockerfile；compose 服务定义写进 runbook §10.3，**随首次部署启用**。

- [x] 12. 权限接入、离线验收与文档回写
  - **Requirements:** G-12、G-14
  - **Design:** §7、§8
  - 接入四个 Capability；确认业务代码无角色判断；补 acceptance 全部自动项；回写 runbook 与 ADR 的实测值。
  - **验证**：全量离线测试通过且无网络调用；`./scripts/verify.sh` 通过；acceptance 清单逐项勾选。
  - **完成（2026-11-11）**：`runtime.ts` 装配（注册 `learning_course` 策略、授权器 + 出口 + 审计）；业务代码无角色判断由现有静态护栏覆盖；`./scripts/verify.sh` 通过；ADR-0017、`.env.example`、runbook 回写。**复核**：审查发现并修正：① 审计误用高风险同事务写入，违反 G-D24 / I3，已改为提交后低风险写入并加告警；② 定时任务失败被静默吞掉，已进报告 + 告警 + 错误级日志。运行期凭证新增 ECS 实例角色路径（`credentials.ts`），已在测试 ECS 容器内实测。**仍未做**：首次部署到测试 ECS（迁移序号待与 `a-activity-plan` 排定；runbook §7.9 第 4–8 项）。

- [x] 页面任务 P1–P4（界面设计已于 2026-11-10 确认，design §11.6；范围与原型一致，没有超出）
  - **P1 学习中心**：`/learning`（列表、搜索、单标签、只看在学、分页）与 `/learning/[id]`（视频点击起播 / 续播、资料内联预览与下载、本人进度）。
  - **P2 课程管理**：`/learning/manage`（状态 / 类型筛选、下架 / 上架确认弹窗）、`/learning/manage/new`、`/learning/manage/[id]`（编辑、换封面、替换文件）。
  - **P3 学习汇总**：`/learning/summary`（四个累计指标、品牌切换、口径说明与「观看时长不可作为考核依据」）。
  - **P4 标签管理**：`/learning/tags`（新建、改名、删除确认，引用数）。
  - **完成（2026-11-11）**：页面、服务端动作（`_actions/learning.ts`）、Route Handler、导航与面包屑、样式（从原型移植）。`next build` 通过；本机 `next dev` + 真实 MySQL + 真实登录会话逐页请求：超管全部 200，门店专员访问管理 / 汇总 / 标签页得到「无权访问」，预览路由返回内联 PDF（头 `inline`、`nosniff`、`no-store`、`SAMEORIGIN`），未登录 401，缺 Origin 403。**没有页面自动化测试**（仓库无 jsdom / testing-library，新增需先登记 ADR），页面行为靠模块测试 + 上述手工请求。**复核（真实 Chrome 端到端，见 ADR-0017）**：资料课 / 视频课创建（含直传）、列表与封面、内联预览、下载附件、微信 UA 提示、视频播放、标签新建全部通过；CORS 已配。**仍未验证**：真实手机 / 微信、Aliplayer 线上 License、15 秒心跳的长视频。

## 对已有代码与测试的改动

实施时（2026-11-11）仓库已有 A、B 域应用代码：本 spec 新增 `src/db/schema/learning.ts`、迁移 `0009_learning_schema`、`src/modules/learning/`、`src/app/(app)/learning/`、`src/app/_actions/learning.ts`、`src/app/api/learning/`、`src/worker/learning-{main,smoke}.ts`、`tests/harness/{learning,fake-course-store,fake-vod}.ts`。对已有文件的改动只有：`app/_lib/action.ts`（识别 `LearningError`）、`(app)/layout.tsx` 与 `(app)/page.tsx`（导航、落点）、`_components/{shell,icon}.tsx`（面包屑、图标）、`globals.css`（学习域样式）、`next.config.ts`（`serverExternalPackages`、预览路径 `SAMEORIGIN`）、两个表计数测试（把本域表排除出 v2 的 29 张）。资源键 `learning_course` 与四个 Capability 在 B 的注册表里本来就有，B 域代码不改。

**与 `a-activity-plan` 并行**：两者各自从 `main` 切分支，迁移序号都是 `0009`。后合并的一方在合并前把自己的迁移重命名为下一个序号并重新生成快照与 `_journal.json`（schema 本身无冲突，`src/db/schema/index.ts` 各加一行导出）。

## 必须停下来问的条件

- 任何需要放宽 `database-design-v2.md` 类型或约束的决定；
- 任何要跳过品牌范围检查、或把 403 改成 404 的改动；
- VOD 模板组 ID、存储地址或 endpoint 需要变更；
- 发现 PRD 与实现矛盾（例如汇总口径）。

小的判断自己做：字段长度、索引命名、错误码文案、测试用例命名。