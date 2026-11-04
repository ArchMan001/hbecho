# ADR-0009 · 账号监控对象分两型，外部账号复用采集链路

- **状态**：accepted
- **日期**：2026-11-02
- **决策人**：刘学奎
- **推翻**：v2 §8.3 的 `staff_id NOT NULL`；「每个平台账号都必须挂在门店 → 专员链上」

## 背景

系统需要长期监控两类没有门店、没有专员的账号：竞品账号与品牌官方账号。

原模型里，主页快照与列表发现都要求 `assignment_id` 非空，而归属要求 `staff_id` 非空、专员又必须挂在门店上。结果是：**这两类账号今天建不出来，也采不了**。

有两种处理思路：

- 建一条绕开组织的独立采集链路；
- 把「归属」泛化成「监控对象」。

独立链路看似简单，实际要复制 ODS 原始证据、ProviderCall 状态机、capability gate、重试与调度——这些是采集链路里最贵的部分。复制一份意味着证据出现两份、口径出现两套，且接第二家供应商时要改两个地方。

## 决定

### 1. 归属表扩展为监控对象

`staff_account_assignments` 表名不变，语义扩展为「谁在关注这个账号」：

```sql
watch_type VARCHAR(16) NOT NULL DEFAULT 'staff'   -- staff | external
staff_id   BIGINT NULL
CHECK ((watch_type='staff'    AND staff_id IS NOT NULL)
    OR (watch_type='external' AND staff_id IS NULL))
```

- `staff` 型即原有的专员归属，行为完全不变；
- `external` 型没有门店与专员，只有账号、主页入口与开关。

### 2. 唯一约束不变

`UQ(active_account_guard)` 对所有类型生效：一个账号当前只有一条监控记录。竞品清单是**全局一份**，由超管维护，不需要按品牌各存一条。

### 3. 采集链路一行不改

`account_profile_snapshots` 与 `content_discoveries` 仍指向这条记录，仍为 NOT NULL。外部账号同样留 ODS 原始证据、同样走 ProviderCall 状态机、同样受 capability gate 约束。

### 4. 外部账号的三条例外

| 规则 | 归属型 | 外部型 |
|---|---|---|
| 五级监控开关 | 参与 | 不参与，没有上级链 |
| 15 天无计划引用自动停采 | 适用 | **不适用**，纯开关控制 |
| 数据范围 | 组织子树 × 品牌 | 默认只有平台级可见 |

### 5. 不区分官方号与竞品号

对业务而言两者使用方式相同（看主页数据作参照）。不设第三型 `brand`，也不加 `owner_brand_id`。

## 备选方案与不选原因

| 方案 | 不选原因 |
|---|---|
| 建虚拟门店挂竞品账号 | 污染组织主档与所有按组织上卷的报表；每个查询都要记得排除它，漏掉不报错只算错数；还要为竞品编假手机号占 `UQ(phone)` |
| 另建独立采集链路 | 复制 ODS、ProviderCall、重试与调度——最贵的部分被复制两份，收益只是省掉一个可空字段 |
| 增加第三型 `brand` | 业务不需要区分归属主体；一个可空列换不来当前任何能力 |
| 用 `staff_id IS NULL` 代替 `watch_type` | 每个报表、每次查询都要显式排除，最容易漏写；显式类型是给自己的提醒 |

## 后果

- `staff_account_assignments.staff_id` 改为可空，并加 `watch_type` 与 CHECK 约束；
- `CONTEXT.md` 新增 `AccountWatch`，`AccountAssignment` 收窄为归属型的含义；
- 监控状态计算补一个分支：无专员时只取账号状态与自身开关；
- 组织类报表使用内连接自然排除外部账号；「账号总数」这类统计必须显式限定 `watch_type='staff'`；
- 外部账号清单的创建入口只有超管，Capability 为 `monitor.external.manage`；
- 1.0 只采主页快照，不进活动计划、不进监控判定计划、不进看板。

## 现在谁在守

- DDL：`CHECK` 约束（MySQL ≥ 8.0.16 强制生效；项目基线 8.4 LTS）；
- 写入路径：普通导入恒写 `watch_type='staff'`，外部账号只能由超管入口写入；
- 查询：组织相关查询用内连接；计数类查询显式过滤；
- 验收：A 域 A2「外部监控账号没有专员归属，不参与五级开关与 15 天规则」「外部监控账号只能由超管创建，分公司不可见」。