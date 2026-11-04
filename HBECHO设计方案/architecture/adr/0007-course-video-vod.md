# ADR-0007 · 课程视频用阿里云 VOD 承载

- **状态**：accepted
- **日期**：2026-10-29
- **决策人**：刘学奎
- **替代**：无（首个课程视频存储决定）；与 ADR-0001 的 OSS 四桶并行，不替代它

## 背景

域 G 的 1.0 范围包含视频课程与图文资料（`prd-domain-g-learning.md` G-D01、G-D09）。课程视频不是采集媒资：它由总部人工上传，不进 A 域的 `MediaAsset`，不参与 SHA-256 判同与采集保留规则。

需要决定的是：课程视频存在哪里、怎么转码、怎么播放、备案未通过时怎么联调。

2026-10-29 实测（账号 `1241086349153033`，`hbecho-setup` + `hbecho-vod-manage`）：

| 项 | 实测结果 |
|---|---|
| 开通状态 | 已开通；控制台入口可用，计费项齐全 |
| 媒资地域 | 控制台为**华北2（北京）** |
| OpenAPI endpoint | **只接受 `cn-shanghai`**；北京 endpoint 调域名接口返回 `InvalidOperation.NotSupportedEndpoint`（"Please use cn-shanghai endpoint"） |
| 播放域名 | `DescribeVodUserDomains` → `TotalCount: 0`；域名入口只有 `AddVodDomain`（需自有域名 + 回源地址）→ **没有系统默认播放域名** |
| 转码模板组 | `ListTranscodeTemplateGroup` → 空列表 → 当前不会自动转码；默认模板组是 `NoTranscode`，不指定模板组就不转 |
| 点播系统存储 | 2026-10-29 13:50 启用，地址 `outin-9d24271dd35c11f1844c4a1eea8f07d7.oss-cn-beijing.aliyuncs.com`，区域华北2（北京），私有 |
| 模板组 endpoint | 用 `cn-shanghai` 建模板组报 `InvalidStorage.NotFound`；改 `cn-beijing` 成功 → **endpoint 必须按操作分地域** |
| 媒资 | 0 条；存储用量 0 |
| 计费方式 | 加速按流量、存储按容量、转码按输出时长、智能审核按审核时长 |

## 决定

1. **课程视频存阿里云 VOD**，媒资地域保持**华北2（北京）**，不迁往上海。
2. **OpenAPI 按操作分地域，不是固定一个 endpoint**（2026-10-29 实测修正）：
   - 转码模板组、媒资、存储相关调用用 `cn-beijing`（与媒资存储同地域）；用上海 endpoint 建模板组会报 `InvalidStorage.NotFound`；
   - 域名管理用 `cn-shanghai`（北京 endpoint 报 `InvalidOperation.NotSupportedEndpoint`）。

   应用必须**逐调用显式指定地域**，不能依赖 SDK 默认 region，否则某些操作会静默失败。
3. **转码模板组已创建**：`hbecho-course` = `3ca24a90956dbbfa16f1f6cf2fe6ad3a`，含 720p（1280×720 / 2000 kbps）与 480p（854×480 / 1000 kbps），HLS 切片 10 秒，H.264 + AAC。上传时必须显式传 `TemplateGroupId`；VOD 的默认模板组是 `NoTranscode`，不传就不转码。
   **自动截图暂缓**：`AddVodTemplate`（Snapshot）连续返回 `InternalError`，且 1.0 要求视频封面人工上传（G-D11），截图不是必需。留作待办，届时用工作流把转码与截图串起来。
4. **播放域名用自有域名 + ICP 备案**。备案通过前不对外播放；备案通过后在控制台添加域名并配置 CNAME。
5. **备案前的播放联调用 OSS 签名 URL 做脚手架**，只验证播放器集成、进度上报与续播；**它不是 1.0 的交付形态**。备案后切 VOD 播放器 SDK，并重新跑一遍播放相关验收。
6. **RAM 分两个身份**：
   - `hbecho-setup` 用 `hbecho-vod-manage`（`vod:*`）做管理与核对，按 runbook「删除类先提案」执行；
   - 运行期给 `hbecho-ecs-role` 单独的最小策略：`CreateUploadVideo`、`RefreshUploadVideo`、`CreateUploadImage`、`GetVideoPlayAuth`、`GetPlayInfo`、`DeleteVideo`、`DeleteStream`，**不挂 `vod:*`**。
7. **1.0 不开启 VOD 智能审核**：内容是总部自传，审核是额外付费能力，且未验证。
8. **课程素材与 A 域媒资互不引用**：课程不写 `media_assets`，A 域也不读 VOD。

## 备选与不选原因

| 方案 | 不选原因 |
|---|---|
| OSS 直存 + 自建转码 + 开源播放器 | 转码链路、多码率切片、播放器适配全部自建；runbook 已明确 hbecho 不做打包与转码，ECS 也不该为此扩容。1.0 课程量小但转码错误排查成本高 |
| 只做图文资料，不做视频 | 已被 G-D01 否决（业务要求视频+图文） |
| 控制台手工上传 | 无审计、无法自动化，也无法在应用内签发播放凭证 |
| 把 VOD 媒资迁到上海与 API 同地域 | 现在零媒资，成本为零，但会让媒资远离 ECS 与用户，且失去潜在的同地域优势；控制面调用量小，跨地域延迟无实际影响 |
| 备案前就添加加速域名 | 域名未备案不可用，只会留下一个看似配置完成的假象 |

## 后果

- **备案是硬前置**：备案未通过前，视频只能测上传、转码与取凭证，不能真的播放。这一条直接影响 `g-learning-min` 的验收排期。
- **转码模板组必须先建**：不建模板组时上传不会按业务档位转码，G 域 PRD 里「按模板组自动转码」不成立。VOD 默认模板组是 `NoTranscode`，这个默认值会让「以为配了其实没转」成为最可能的故障。
- **endpoint 按操作分地域**：模板与媒资在北京、域名在上海，这是两组 endpoint，不是配置错误。写代码时每个调用都要显式 region。
- **跨地域调用要写进代码常量**，不能依赖 SDK 默认 region，否则部署到北京环境时会失败。
- **VOD 计费是三个维度**（存储、转码、播放流量），I 域成本看板需要分别计量，不能只算一个数。
- **删除不可逆**：`DeleteVideo` 会同时删除该视频的所有转码输出与截图。替换课程文件时删旧视频是必要动作，但必须由业务确认后执行。
- **播放域名有备案依赖**，未备案时任何「能不能先播」的临时方案都只能是脚手架，不能进交付。

## 现在谁在守

- `hbecho-vod-manage` 策略（runbook §3.6「VOD 权限」）：`hbecho-setup` 无 VOD 权限时调用会返回 `NoPermission / ImplicitDeny`，已在 2026-10-29 验证。
- runbook §1.7 外部服务：登记 VOD 资产、状态与备案进度。
- runbook 待办 34：核对默认播放域名、转码模板组与 RAM 授权。
- 模板组为空这一事实，会在 `g-learning-min` spec 开工时作为前置检查项复验。

## 原文

- `HBECHO设计方案/prd-domain-g-learning.md` G-D09、§3.8、§10.1
- `HBECHO设计方案/runbooks/server-operations-runbook.md` §1.7、§3.6
- `HBECHO设计方案/architecture/adr/0001-oss-bucket-topology.md`（OSS 四桶，课程素材不在其中）
- 2026-10-29 实测命令：`aliyun vod DescribeVodUserDomains|ListTranscodeTemplateGroup|DescribeVodStorageData --region cn-shanghai --profile hbecho-setup`