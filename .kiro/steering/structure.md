---
inclusion: always
---

# 项目结构与文档规则

- `CONTEXT.md` 固定留在仓库根目录，只定义领域词汇、语义边界和不变量；禁止加入表名、SQL、框架、接口或任务清单。
- `docs/INDEX.md` 是唯一文档导航与权威状态索引。新增、移动或替代文档时必须同步更新。
- `docs/product/` 放产品目标、模块地图和阶段；`docs/domains/` 放领域实施基线；`docs/architecture/adr/` 只记录难逆、令人意外且存在真实取舍的决定；`docs/runbooks/` 放可执行运维步骤；`docs/archive/` 放新产生或可安全迁移的 superseded/archived 文档。`项目历史文档/` 与根目录域 E 文件仅是 `docs/INDEX.md` 登记的 legacy 历史位置例外，不得继续新增。
- 功能设计放 `.kiro/specs/<feature>/`。完整 Feature Spec 使用 `requirements.md`、`design.md`、`tasks.md`；仅重构历史技术设计时允许先有 `design.md` 草案。
- Spec 要标明状态、权威来源、目标、非目标、依赖、失败语义、验收边界和未决项。引用权威文档，不复制 28 表 DDL 或整份外部 API 文档。
- `draft` 不等于实现合同；未决项不得在代码或示例中被默认冻结。历史文档只有被当前 Spec 明确吸收的结论才生效。
- 被替代文件不得删除：新归档或可安全迁移的文件移动到 `docs/archive/`，并在文首写明 `superseded/archived`、替代文档和禁止用途；legacy 位置例外也必须有状态头并由 `docs/INDEX.md` 登记。
- Markdown 使用工作区相对链接。移动文件后检查断链、旧路径、旧表名和过时组织假设。
- 代码与文档中的领域命名优先采用 `CONTEXT.md`：例如 `MediaStaff`、`ExternalAccount`、`AccountAssignment`、`ContentDiscovery`，不得退回平行的 `Staff` 或“Dealer 是 Branch 子节点”等旧模型。
