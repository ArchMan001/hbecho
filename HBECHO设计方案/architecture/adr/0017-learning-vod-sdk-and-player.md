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

### 3. 播放器用阿里云 Aliplayer Web SDK 2.25.1，**CDN 脚本加载，不进 npm**
- **用途**：`vid` + `playauth` 播放；页面里点击后才加载脚本。
- **不用它做什么**：不自研 HLS；不做自动播放（G-D38）。
- **License**：该 SDK 要求在控制台申请与**播放页面域名**绑定的 License（key + domain）；没有 License 只能本地调试。域名与备案（ADR-0007 §4、G-D47）未就绪前，**生产播放不能验收**。页面从 `HBECHO_PLAYER_LICENSE_DOMAIN` / `HBECHO_PLAYER_LICENSE_KEY` 读取，缺省不传。
- **风险**：CDN 脚本没有做 SRI 固定；版本号固定在 `course-player.tsx`。

## 实测事实（2026-11-11，真实 `hbecho-course` 桶，4 次请求 + 若干 SDK 调用，33 字节，用完即删）
| 项 | 结果 |
|---|---|
| 签名 PUT 直传；签名里绑定的 Content-Type 与实际不符 | 200；换类型 **403**（防换类型上传成立） |
| `HEAD`、`Range: bytes=0-7` 读文件头、`getStream` 流式读取、List、Delete（含幂等） | 全部成功；应用使用的 AccessKey 对该桶有读写删与列表权限 |
| 带 `response-content-disposition` 的签名 GET | `attachment; filename="..."; filename*=UTF-8''...` 生效，中文文件名正确 |
| 不带附件名的签名 GET（想用来内联预览） | **仍返回 `Content-Disposition: attachment` 且 `x-oss-force-download: true`** |
| 桶的 CORS 配置 | **不存在**（`NoSuchCORSConfiguration`）：浏览器直传在配置前会被拦 |

## 由实测得出的两条实现约束
1. **资料预览不能用 OSS 默认域名的签名链接**：默认域名对所有对象强制下载，PDF 放进 `<iframe>` 会变成下载。预览改为**本服务鉴权后流式转发**（`GET /api/learning/courses/:id/preview`，同源 iframe；该路径的 `X-Frame-Options` 放宽为 `SAMEORIGIN`，其余路径仍是 `DENY`）。要改回直连，需要自有域名（与视频同一个备案前置）。代价：资料字节经过 ECS，上限 50 MiB。
2. **浏览器直传前，必须给 `hbecho-course` 桶配置 CORS**（允许生产来源、`PUT`、`Content-Type` 头）；视频直传还要给 VOD 存储桶配置同样的 CORS。这是云端配置变更，**需要先确认生产域名后由人批准再做**；未配置前，新建课程的上传步骤会失败。

## 备选与不选原因
| 方案 | 不选原因 |
|---|---|
| 阿里云官方 `aliyun-upload-sdk`（浏览器） | 再引一个上传库；底层就是 ali-oss 分片上传 |
| npm 安装 `aliyun-aliplayer` | 2.25.1 官方文档同时给了 CDN 与 npm；包体较大且要进客户端打包。CDN 按需加载更轻，缺点是无 SRI |
| 预览用签名链接 + 自有域名 | 依赖尚未完成的备案，且视频已经卡在同一个前置 |
| 预览改成「只提供下载」 | 违背 G-5（浏览器内预览） |

## 现在谁在守
- `src/modules/learning/learning.test.ts`：模板组 / 地域常量、状态映射、错误不带原文。
- `src/worker/learning-smoke.ts`（`pnpm learning-smoke`，需 `HBECHO_LEARNING_SMOKE=approved`）：上表的真实桶检查，可重复运行。
- 单元 / 数据库测试里 VOD 一律用 `tests/harness/fake-vod.ts`；**VOD 的真实调用尚未被任何测试验证**（未获批准，见 g-learning-min tasks.md）。

## 原文
`.kiro/specs/g-learning-min/design.md` §3.6、§4、§6；ADR-0001（`hbecho-course` 桶）；ADR-0007。
