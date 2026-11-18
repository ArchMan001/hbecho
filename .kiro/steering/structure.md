---
inclusion: always
---

# 项目结构与文档规则

- `CONTEXT.md` 固定留在仓库根目录，只定义领域词汇、语义边界和不变量；禁止加入表名、SQL、框架、接口或任务清单。
- `HBECHO设计方案/INDEX.md` 是唯一文档导航与权威状态索引。新增、移动或替代文档时必须同步更新。
- 产品需求文档集中在 `HBECHO设计方案/` 根：总 PRD 为 `prd-platform.md`，子 PRD 为 `prd-domain-<代号>-<slug>.md`。`HBECHO设计方案/domains/` 放领域实施基线；`HBECHO设计方案/architecture/adr/` 只记录难逆、令人意外且存在真实取舍的决定；`HBECHO设计方案/runbooks/` 放可执行运维步骤；`HBECHO设计方案/archive/` 放新产生或可安全迁移的 superseded/archived 文档；跨项目与早期沉淀的历史资料统一放 `HBECHO设计方案/archive/legacy/`，由 `HBECHO设计方案/INDEX.md` 登记，不得继续新增。
- 功能设计放 `.kiro/specs/<代号>-<切片>/`。完整 Feature Spec 使用 `requirements.md`、`design.md`、`tasks.md`；仅重构历史技术设计时允许先有 `design.md` 草案。
- Spec 要标明状态、权威来源、目标、非目标、依赖、失败语义、验收边界和未决项。引用权威文档，不复制 30 表 DDL 或整份外部 API 文档。
- `draft` 不等于实现合同；未决项不得在代码或示例中被默认冻结。历史文档只有被当前 Spec 明确吸收的结论才生效。
- 被替代文件不得删除：新归档或可安全迁移的文件移动到 `HBECHO设计方案/archive/`，并在文首写明 `superseded/archived`、替代文档和禁止用途；`archive/legacy/` 中的 hbecho 历史文档也必须有状态头并由 `HBECHO设计方案/INDEX.md` 登记。
- Markdown 使用工作区相对链接。移动文件后检查断链、旧路径、旧表名和过时组织假设。
- 跨域消费的统一入口是**活动计划**：采集只有一份、由全局监控状态驱动；常态采集账号/主页快照/列表/封面，详情/视频源/音频/评论由监控判定计划按需触发。三层对象是 A 活动计划 → **监控判定计划**（监控段归 C、判定段归 D，1:1 共用一个版本号，一个活动计划下 1..n 份）→ E 计划看板。详见 `HBECHO设计方案/prd-platform.md` §6.11。
- 代码与文档中的领域命名优先采用 `CONTEXT.md`：例如 `MediaStaff`、`ExternalAccount`、`AccountAssignment`、`ContentDiscovery`，不得退回平行的 `Staff` 或“Dealer 是 Branch 子节点”等旧模型。
- 推翻或修订一条已编号决策（如 `D-18`、`B-D07`）时，同一次改动里必须：① 原决策行保留，加删除线并写「由 X 于某日修订」；② 全仓库搜索该编号，逐处更新或标注；③ 被改文档补版本记录；④ 跑 `./scripts/verify.sh`。
- 带页面的 spec 必须先做界面设计，并**经刘学奎明确确认**后才能写页面相关的 tasks.md 条目或页面代码：① design.md 写「界面」一节（页面清单、流程、线框链接、状态矩阵、字段可见性），按 `HBECHO设计方案/ui/ui-foundation.md` §8 的模板；② 规则复杂的页面先在 `ui-lab/` 做可点击原型并请业务走一遍；③ 在界面一节末尾的「N.6 界面设计确认」写明确认人、日期、范围、原型链接。AI 不得把「用户没有反对」当作确认；界面改动超出已确认范围要重新确认。没有页面的 spec（只交付 CLI / Module）要在 design 里写明「本 spec 没有页面」及页面进入条件。
- 界面预览与协作：4175 原型、3202 完整应用、ECS 的关系，改动分类（新页面 / 小改 / 带迁移）与「原型 → 代码」单向流转，见 `.kiro/steering/ui-workflow.md`；本机启动与账号见 `ui-lab/LOCAL-UI.md`。
- **过程文档只在任务进行中存在**：对话交接说明、一次性审查 / 验收报告、批次改动说明、工作清单，任务完成并合并后**直接删除**（git 历史保留；刘学奎 2026-11-18 决定），在 `INDEX.md` §8.5 记一行删除记录；不要留在 spec 目录或文档根，更不要当作进度来源。已被替代的**设计 / 合同类**文档仍按上条归档，不删除。
