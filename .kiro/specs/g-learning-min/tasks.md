# G Learning Min Implementation Plan

> **状态**：`draft`
> **执行状态**：本文件只规划；**未获 requirements 与 design 批准前不执行实现**
> **需求**：[`requirements.md`](requirements.md)
> **设计**：[`design.md`](design.md)
> **所属域**：G 学习平台 · **目录命名**：新名 `g-learning-min`，符合 `<代号>-<切片>`
> **最近核对**：2026-10-29
> **更新日期**：2026-10-29

## Planning rules

- 任务按纵向结果排序：每个任务结束时留下可运行、可观察的增量，不建空表或空接口。
- 默认验收离线：VOD 与 OSS 全部走 fake transport，禁用网络；真实 smoke 需人工批准并记预算。
- 不在任务中重新选型；技术栈沿用 ADR-0005，目录结构以首批应用代码落地时确定的约定为准（本文件只写模块名，不写死路径）。
- 所有内部 BIGINT 输出十进制字符串；时间 UTC `DATETIME(6)`；状态 `VARCHAR + CHECK`；无 `ON DELETE CASCADE`。
- 每完成一个任务运行它的离线验收，并在 `tasks.md` 勾选、写明尚未证明的部分。

## Tasks

- [ ] 1. 建表与数据约束
  - **Requirements:** G-1、G-2、G-15
  - **Design:** §3
  - 迁移新增 `courses`、`course_brand_scopes`、`tags`、`course_tags`、`learning_progress` 五张表，含 §3.1 的组合 CHECK、唯一键与 RESTRICT 外键。
  - **验证**：干净库连续执行两次迁移幂等；故意写错 `kind='video'` 但缺 `vod_video_id` 时数据库报错；删除被引用的课程被 RESTRICT 拒绝。

- [ ] 2. 标签集合管理
  - **Requirements:** G-3
  - **Design:** §3.3
  - 实现 `learning-tags` 模块：列表、创建、改名、删除；删除前检查引用，被引用返回 409 与引用数。只接受 `learning.tag.manage`。
  - **验证**：无 `learning.tag.manage` 调用全部 403；删除被引用标签返回 409；改名后课程引用不变。

- [ ] 3. 资料课程创建（OSS 直传）
  - **Requirements:** G-1、G-5、G-15
  - **Design:** §4.2、§3.6
  - 签名直传地址、HEAD 校验（size / content-type）、校验失败删除对象、创建课程行；格式白名单 PDF / JPG / PNG；上限取配置。
  - **验证**：fake OSS 下超限拒绝、格式错误拒绝、HEAD 不匹配时对象被删且不建行；成功后课程状态为 `published`。

- [ ] 4. 视频课程创建（VOD）
  - **Requirements:** G-1、G-4
  - **Design:** §4.1
  - 取上传凭证时显式传 `TemplateGroupId=3ca24a90956dbbfa16f1f6cf2fe6ad3a` 与 `cn-beijing` endpoint；上传完成后按状态建行（`transcoding` 或 `normal`）；转码完成后回填 `duration_sec`。
  - **验证**：fake VOD 覆盖凭证成功、失败、转码中、转码失败四种；凭证请求中断言模板组与 endpoint；转码中可建行但播放接口返回 202。

- [ ] 5. 课程列表、详情与可见范围
  - **Requirements:** G-1、G-2、G-8、G-12
  - **Design:** §5.1
  - 列表按「已发布 + 品牌范围交集」过滤，支持标题子串搜索、单标签筛选、`inProgress` 筛选；返回 `inProgress` 与 `lastLearnedAt`。
  - **验证**：`brand_scope='all'` 的课程在任何品牌可见；指定集合只对交集品牌可见；范围外返回 403 而非空页；多标签参数被拒绝。

- [ ] 6. 播放凭证与资料预览
  - **Requirements:** G-5、G-6
  - **Design:** §4.3、§6
  - 视频：校验范围与状态后调 `GetVideoPlayAuth`；资料：返回 OSS 短期签名 URL。
  - **验证**：响应不含原始文件 URL；撤销范围后下一次请求 403 且未调用 VOD；转码中 202、失败 409、凭证失败可重试。

- [ ] 7. 学习进度与续播
  - **Requirements:** G-7
  - **Design:** §4.4、§5.2
  - 心跳上报 upsert；位置回退保护（30 秒阈值可配）；`play_count` 在真正起播时 +1。
  - **验证**：同一用户同一课程只有一行；模拟拖动到 0 秒不清零；换设备后读到同一位置；并发上报不产生重复行。

- [ ] 8. 替换、下架与审计
  - **Requirements:** G-9、G-13
  - **Design:** §6
  - 替换覆盖并异步删除旧 VOD 视频；下架后 403；审计记录旧文件标识；删除失败进重试。
  - **验证**：替换后进度不清零；下架后列表与直链均拒绝；审计含旧 `VideoId`；删除失败被记录且重试成功。

- [ ] 9. 资料下载与下载审计
  - **Requirements:** G-10、G-13
  - **Design:** §4.3、§6
  - 下载走签名 URL，写审计；范围外拒且不产生下载审计（只记拒绝事件）。
  - **验证**：审计字段完整；下架课程不可下载；预览不产生下载审计。

- [ ] 10. 总部汇总
  - **Requirements:** G-11
  - **Design:** §5.3
  - 四个累计指标；`range` 参数只接受 `all`；`branch_manager` / `store_staff` 403。
  - **验证**：学习人数去重；响应无个人标识；同一「全部品牌」课程跨品牌不重复计人；口径与页面文案一致。

- [ ] 11. 权限接入、离线验收与文档回写
  - **Requirements:** G-12、G-14
  - **Design:** §7、§8
  - 接入四个 Capability；确认业务代码无角色判断；补 acceptance 全部自动项；回写 runbook 与 ADR 的实测值。
  - **验证**：全量离线测试通过且无网络调用；`./scripts/verify.sh` 通过；acceptance 清单逐项勾选。

## 对已有代码与测试的改动

当前仓库没有应用代码，本 spec 是首批落地之一。实施时若发现与 ADR-0005 的目录约定冲突，先改 ADR 或提出决策，不在任务里临时决定。

## 必须停下来问的条件

- 任何需要放宽 `database-design-v2.md` 类型或约束的决定；
- 任何要跳过品牌范围检查、或把 403 改成 404 的改动；
- VOD 模板组 ID、存储地址或 endpoint 需要变更；
- 发现 PRD 与实现矛盾（例如汇总口径）。

小的判断自己做：字段长度、索引命名、错误码文案、测试用例命名。