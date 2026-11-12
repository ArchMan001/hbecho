# ADR-0017 · 学习域的云 SDK 与播放器：VOD 官方 SDK、浏览器端 ali-oss、Aliplayer（CDN 脚本）

- **状态**：accepted
- **日期**：2026-11-11
- **决策人**：刘学奎（2026-11-11 要求把 g-learning-min 做完整；依赖由实现按 no-reinventing-wheels 登记，待复核）
- **与 ADR-0005 / ADR-0007 的关系**：ADR-0005 禁止未登记的新依赖；ADR-0007 决定了「用 VOD」但没有登记 npm 包。本 ADR 只补依赖登记与两个由实测得出的实现约束。

## 背景

`g-learning-min` 要创建视频课程、签发播放凭证、删除旧视频、清理残渣，以及让浏览器直传文件和播放。2026-11-11 对真实 `hbecho-course` 桶做了人工批准的 smoke（见下），得到两条会改变设计的事实。

## 决定

### 1. 采用 `@alicloud/vod20170321` 3.12.1（阿里云官方 SDK，Apache-2.0，2026-08 发布）
- **用途**：服务端调用 `CreateUploadVideo`、`GetVideoInfo`、`GetVideoPlayAuth`、`DeleteVideo`、`UpdateVideoInfo`、`GetVideoList`。
- **不用它做什么**：不让业务代码直接依赖它——只有 `src/modules/learning/vod-aliyun.ts` 导入；业务只见 `VodClient` 端口。模板组 ID、`cn-beijing` 地域与 endpoint 是写进 `vod.ts` 的常量，**不读环境变量**（ADR-0007：默认模板组是 `NoTranscode`，不传就不转码）。错误只保留错误码，不转发 SDK 的 message。
- 按「云服务官方 SDK 不受星标限制」登记；精确版本，不加 `^`。

### 2. 浏览器端用已有依赖 `ali-oss`（6.23.0）上传
- **用途**：资料 / 封面用签名 URL 的 `PUT`（不需要 SDK）；视频按 VOD 返回的 `UploadAddress` / `UploadAuth`（临时凭证）做 OSS 分片上传——官方上传 SDK 也是这样实现的，不再引入第二个上传库。
- **不用它做什么**：不在浏览器里持有任何长期 AccessKey；服务端不中转文件字节。
- **已知上限**：不处理上传中途临时凭证过期（`RefreshUploadVideo` 未接）；2 GB 视频在慢上行下可能超过凭证有效期。
- `next.config.ts` 把 `ali-oss`、两个阿里云 SDK 放进 `serverExternalPackages`（它们是 CommonJS 且有运行期 `require`，被打包器内联会构建失败）。


> **2026-11-12 版本订正**：播放器 SDK 从 2.25.1 升到 **2.29.1**。阿里云控制台的「播放器 Web端标准版」License 明确要求 Web 播放器 SDK **2.29.1 及以上**；CDN 的 2.29.1 JS/CSS 已核验返回 200。这是版本订正，不改变本 ADR 的其他决定。

### 3. 播放器用阿里云 Aliplayer Web SDK 2.29.1，**CDN 脚本加载，不进 npm**
- **用途**：`vid` + `playauth` 播放；页面里点击后才加载脚本。
- **不用它做什么**：不自研 HLS；不做自动播放（G-D38）。
- **License**：该 SDK 要求在控制台申请与**播放页面域名**绑定的 License（key + domain）；没有 License 只能本地调试。域名与备案（ADR-0007 §4、G-D47）未就绪前，**生产播放不能验收**。页面从 `HBECHO_PLAYER_LICENSE_DOMAIN` / `HBECHO_PLAYER_LICENSE_KEY` 读取，缺省不传。
- **风险**：CDN 脚本没有做 SRI 固定；版本号固定在 `course-player.tsx`。
- 播放地址是 VOD 存储桶的 OSS 默认域名（见「VOD 实测」）；视频的 `<video>` 播放不受默认域名强制下载影响。

## 实测事实（2026-11-11，真实 `hbecho-course` 桶，4 次请求 + 若干 SDK 调用，33 字节，用完即删）
| 项 | 结果 |
|---|---|
| 签名 PUT 直传；签名里绑定的 Content-Type 与实际不符 | 200；换类型 **403**（防换类型上传成立） |
| `HEAD`、`Range: bytes=0-7` 读文件头、`getStream` 流式读取、List、Delete（含幂等） | 全部成功（本机用 `hbecho-setup` 身份跑；**运行期身份**的权限见下面「运行期身份」一节） |
| 带 `response-content-disposition` 的签名 GET | `attachment; filename="..."; filename*=UTF-8''...` 生效，中文文件名正确 |
| 不带附件名的签名 GET（想用来内联预览） | **仍返回 `Content-Disposition: attachment` 且 `x-oss-force-download: true`** |
| 桶的 CORS 配置 | **不存在**（`NoSuchCORSConfiguration`）：浏览器直传在配置前会被拦 |

## VOD 实测（2026-11-11，真实 VOD，约 15 个 3 秒 MP4，用完即删；`pnpm learning-smoke-vod`）
| 项 | 结果 |
|---|---|
| `CreateUploadVideo`（带模板组、`cn-beijing`、标签 `hbecho-course`）→ 用 UploadAddress / UploadAuth 分片上传 → 轮询状态 | 成功；状态序列 `uploading → transcoding → normal`（有时直接 `uploading → normal`）；时长、大小回填正确 |
| 上传完成后的状态滞后 | 上传请求返回后，VOD 仍会在 `Uploading` 停留数秒到十几秒。所以「保存」遇到 `video_uploading` 不是失败：页面自动重试到约 90 秒（真实浏览器流程中暴露） |
| `GetVideoPlayAuth` / `UpdateVideoInfo` / `GetVideoList` / `DeleteVideo`（含幂等） | 成功 |
| `DeleteVideo` 之后 | 几秒内 `GetVideoInfo` 仍可能返回该视频，最终消失（最终一致） |
| **`GetVideoList` 在账号 / 时间范围内没有视频时** | **报 `InvalidVideo.NotFound`，不是空列表**。适配器已转换为空列表（否则残渣清理在 VOD 为空时每轮报错） |
| `GetPlayInfo` | **没有配置播放域名也返回播放地址**：主机是 VOD 存储桶的 OSS 默认域名（`outin-….oss-cn-beijing.aliyuncs.com`）。真实 Chrome 里 Aliplayer 用它播放成功（HTTP 206 分段读取，播到片尾，进度心跳上报）。**这改变了 ADR-0007 §4 / G-D47 的前提**：播放不依赖备案域名；自有域名只剩「CDN 加速 / 防盗链 / 域名统一」的价值 |

## 真实浏览器端到端（2026-11-11，Chrome 157 headless，本机 `next dev` + 真实 MySQL + 真实 `hbecho-course` 桶 + 真实 VOD）
- 超管：资料课（封面 + PDF）浏览器直传 `hbecho-course`（预检 OPTIONS 200 + PUT 200）→ 保存成功；视频课（封面 + MP4）浏览器分片上传 VOD 存储桶（OPTIONS 200 + PUT 200，**VOD 存储桶的跨域放行不需要额外配置**）→ 保存成功；标签新建。
- 门店专员：列表出现资料课与（转码完成后的）视频课；私有桶封面在 `<img>` 里显示；资料详情 `<iframe>` 内联预览（`Content-Disposition: inline`）；打开即上报；「下载原件」得到 OSS 附件链接（`attachment; filename=…`）；微信 UA 下下载按钮变成「复制链接，在浏览器打开」；视频点击后加载 Aliplayer 2.29.1（CDN）并播放到片尾，进度心跳 / 补报 POST 200。
- **未覆盖**：真实手机 / 微信内的渲染（PDF 在手机浏览器 iframe 里的表现、微信 WebView 的视频）；Aliplayer License（见下）。

## 运行期身份（生产路径）
- 本机 `.env` 里的 `OSS_ACCESS_KEY_*` 是 **`hbecho-setup`**（建设期管理员身份），**不是**运行期身份；本 ADR 早先的 smoke 因此对「运行期权限」说明不了什么，已在这里更正。
- 运行期 = ECS 实例角色 `hbecho-ecs-role`（runbook §7.7）。`hbecho-oss-rw` 早已含 `CourseDocReadWriteDelete`（`hbecho-course` 的 Get / Put / Delete / GetObjectMeta / ListObjects / 分片动作）。2026-11-11 新建并挂上 **`hbecho-vod-runtime`**：`CreateUploadVideo`、`RefreshUploadVideo`、`GetVideoInfo`、`GetVideoPlayAuth`、`GetPlayInfo`、`UpdateVideoInfo`、`GetVideoList`、`DeleteVideo`、`DeleteStream`（Resource `*`，不含 `vod:*`；`CreateUploadImage` 不再需要——封面不走 VOD）。
- **在测试 ECS 上、用该角色的临时凭证实测**：VOD 的创建 / 查询 / 改标题 / 取播放凭证（对未上传的视频返回 `Forbidden.IllegalStatus`，说明权限已通过）/ 删除全部放行；在 `hbecho-web` 容器里用 ali-oss + 元数据服务 STS：`put`、`head`、`Range`、`getStream`、签名 GET、`list`、`delete` 全部成功。`ecsRoleCredentials`（`credentials.ts`）在该容器里取到 `STS.` 凭证并缓存。
- 代码支持两种凭证：`HBECHO_LEARNING_CREDENTIALS=ecs_role`（生产首选，凭证到期前 5 分钟自动刷新、客户端随之重建）与固定 AccessKey（缺省回退 `OSS_*`——**生产不要依赖这个回退**）。
- 残渣清理只认带标签 `hbecho-course` 的视频；账号里别的来源的视频不会被碰。

## Aliplayer License（未解决）
官方文档：License 与页面域名绑定，没有正式 License 只能本地调试。localhost 上没有 License 能播。**`echo.hbmarketer.com` 上是否需要 / 是否能免费申请，我没有找到可用 API，也不能从本机验证**：需要在阿里云控制台为该域名申请，再填入 `HBECHO_PLAYER_LICENSE_DOMAIN` / `_KEY`。

## 由实测得出的两条实现约束
1. **资料预览不能用 OSS 默认域名的签名链接**：默认域名对所有对象强制下载，PDF 放进 `<iframe>` 会变成下载。预览改为**本服务鉴权后流式转发**（`GET /api/learning/courses/:id/preview`，同源 iframe；该路径的 `X-Frame-Options` 放宽为 `SAMEORIGIN`，其余路径仍是 `DENY`）。要改回直连，需要自有域名（与视频同一个备案前置）。代价：资料字节经过 ECS，上限 50 MiB。
2. **浏览器直传前，必须给 `hbecho-course` 桶配置 CORS**。2026-11-11 已配置：允许 `https://echo.hbmarketer.com`，方法 PUT / GET / HEAD，头 `Content-Type`，暴露 `ETag`，MaxAge 3600（验证用的 `http://localhost:3999` 已移除）。VOD 存储桶归 VOD 服务所有（`aliyun oss` 报「不属于你」），实测它已放行浏览器分片上传，无需配置。

## 备选与不选原因
| 方案 | 不选原因 |
|---|---|
| 阿里云官方 `aliyun-upload-sdk`（浏览器） | 再引一个上传库；底层就是 ali-oss 分片上传 |
| npm 安装 `aliyun-aliplayer` | 2.29.1 官方文档同时给了 CDN 与 npm；包体较大且要进客户端打包。CDN 按需加载更轻，缺点是无 SRI |
| 预览用签名链接 + 自有域名 | 依赖尚未完成的备案，且视频已经卡在同一个前置 |
| 预览改成「只提供下载」 | 违背 G-5（浏览器内预览） |

## 现在谁在守
- `src/modules/learning/learning.test.ts`：模板组 / 地域常量、状态映射、错误不带原文。
- `src/worker/learning-smoke.ts`（`pnpm learning-smoke`，需 `HBECHO_LEARNING_SMOKE=approved`）：上表的真实桶检查，可重复运行。
- `src/worker/learning-smoke-vod.ts`（`pnpm learning-smoke-vod`，需 `HBECHO_LEARNING_SMOKE_VOD=approved` 与本机 ffmpeg）：上面「VOD 实测」的真实检查，可重复运行。
- 单元 / 数据库测试里 VOD 一律用 `tests/harness/fake-vod.ts`；两个 smoke 与浏览器端到端是人工 / 手动入口，**不在 CI 里跑**（CI 不持有云凭证）。

## 原文
`.kiro/specs/g-learning-min/design.md` §3.6、§4、§6；ADR-0001（`hbecho-course` 桶）；ADR-0007。
