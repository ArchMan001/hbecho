---
title: "数据底座六条编码纪律"
inclusion: always
---

# 数据底座六条编码纪律

> 来源：`CONTEXT.md` 不变量、`database-design-v2.md` §5/§12、`data-foundation-tracer` R2/R5/R9/R10/R13/R18。完整条款见 `HBECHO设计方案/governance/constitution.md` C6–C15。

## 这份文件是预防，不是验证

它在代码被写出来**之前**生效，比事后扫描早一步。但它挡不住三件事：

- **它不会让构建失败。** 写错了照样能跑、能部署
- **它不覆盖手工编辑**，也不覆盖另一个会话、另一个模型、或上下文被压缩之后的生成
- **它对已经存在的代码无效**

当前的自动化守护只有密钥扫描与文档检查。下表列出的纪律**全部没有机器守护**，直到 tracer 任务 1–8 落地：

| 将来自动化的位置 | 现在 |
|---|---|
| fixture 跨实现断言、fake OSS 故障注入、fake clock、fence 测试 | 不存在 |
| MySQL CHECK / 唯一键 / 复合外键 | DDL 尚未编写 |
| 长事务告警 | 未配置 |

---

## 纪律 1 · 先落 ODS，再解析

**顺序不能变**：生成 request bytes → 上传私有 ODS 并验证 → 短事务写 `prepared` intent → 短事务切 `in_flight` → 网络 IO → 完整 response bytes 或传输错误原文落 ODS 并验证 → 短事务写终态 → 适配器解析。

```text
❌  const res = await http.post(url, body)
    const data = JSON.parse(res.body)        // 先解析，原始字节只在内存里
    await db.insert(snapshot, data)

✅  await ods.put(requestRef, body)          // 失败则停止
    await db.tx(t => t.insert(call, {status:'prepared', requestRef}))
    await db.tx(t => t.update(call, {status:'in_flight'}))
    const res = await http.post(url, body)
    await ods.put(responseRef, res.bytes)    // 失败则不解析
    await db.tx(t => t.update(call, {status:'terminal', responseRef}))
    const data = adapter.decode(responseRef)
```

**为什么**：解析器改版、合同漂移、供应商纠纷时，唯一可信的证据是原始字节。先解析后落盘等于把证据丢了，而且不会报错。

## 纪律 2 · 网络 IO 期间不持有数据库事务

```text
❌  await db.transaction(async t => {
      const call = await t.insert(call, {status:'in_flight'})
      const res = await http.post(url, body)   // 事务开着等网络
      await t.update(call, {status:'terminal'})
    })

✅  await db.tx(t => t.insert(call, {status:'in_flight'}))
    const res = await http.post(url, body)
    await db.tx(t => t.update(call, {status:'terminal'}))
```

**为什么**：事务里等网络会造成锁堆积；进程崩溃时既丢意图记录，又可能已经付了费。长事务通常不报错，只表现为偶发超时和锁等待。

## 纪律 3 · 外部 ID 是文本；四种值状态不能合并

```text
❌  const userId = Number(raw.user_id)          // 19 位抖音 ID 被截断
❌  const value = raw.count || 0                // 缺失/null/0 变成同一个值
❌  if (!raw.like_count) return null            // 真实 0 被当成缺失

✅  const userId = String(raw.user_id)          // 原文保留
✅  valueState = raw.count === undefined ? 'missing'
              : raw.count === null      ? 'explicit_null'
              : isValid(raw.count)      ? 'valid'
              :                           'invalid'
```

**为什么**：`Number` 超过 `2^53` 会丢精度，两个不同账号会变成同一个；把 0 当缺失会静默改变指标分母。查找外部 ID 时必须同时带 `platform_id` 与 `identifier_namespace`，哈希命中后还要复核原文。

## 纪律 4 · 已返回的页必须整页处理

```text
❌  for (const item of page.items.slice(0, limit)) { ... }   // 截断已返回页
❌  if (processed >= limit) break                            // 页内 break

✅  for (const item of page.items) { await project(item) }
    if (processed < limit && page.has_more) await fetchNextPage()
    await advanceCheckpointOnlyIfAllEntriesTerminal()
```

**为什么**：供应商已经返回的每一条都是事实。本地 limit 只能决定**是否请求下一页**，不能决定丢弃当前页的第 N+1 条。截断后检查点会越过缺失数据，永久无法恢复。

## 纪律 5 · current 只接受 finalized；旧批次不让它倒退

```text
❌  await db.update(content, {current_snapshot_id: newSnapshot.id})   // 未检查状态

✅  await db.tx(async t => {
      await t.finalizeSnapshot(snapshot.id)                 // 全部依赖已终止
      await t.compareAndSwapCurrent(                         // (logical_at, batch_id) 严格更新
        content.id, currentSnapshotId, snapshot.id)
    })
```

**为什么**：旧批次迟到、重试、并发 worker 都会写出「看起来更新」的快照。必须先终态化、再按逻辑批次比较，并由 lease/fencing 拒绝陈旧 worker。

## 纪律 6 · 付费调用前先过 capability gate

```text
❌  if (platform === 'douyin') await callMediaUserInfo(...)
❌  async: false   // 写死为生产总策略

✅  const cap = capabilities.require({platform, action, mode, env})
    if (cap.evidence !== 'production_approved') throw new UnsupportedCapability()
    await callMediaUserInfo(...)
```

**为什么**：`raw3` 只证明「样本中观察到的行为」，不能外推为供应商长期合同；所有已保存的探针都用 `async=false`，异步正确性从未验证。把未验证的 tuple 放行，失败时会被误判成账号问题或网络问题。

---

## 一条相关的既有纪律

**媒体临时 URL 不是资产身份。** 正式媒资按完整下载字节的 SHA-256 判同；本轮下载失败可以续用旧资产，但必须记录本轮失败。见 `CONTEXT.md` MediaAsset 与 constitution C12。