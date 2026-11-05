# ADR-0012 · Python 能力服务

- **状态**：accepted
- **日期**：2026-11-04
- **决策人**：刘学奎
- **关闭**：总 PRD §9.4 T-01 的部署形态（D-35 与 C 域 §13.4 已定「常驻小服务」）

## 背景

C2 档 1 的模板匹配与元素匹配需要本地图像计算（pHash 预筛 + SIFT / ORB）；音频轨抽取需要 ffmpeg。旧系统用 `spawn python3` + 正则解析 stderr，契约脆弱（总 PRD §2.2 教训 8）。D-35 定为常驻小服务（单 worker，空闲近 0 CPU）；ADR-0005 规定 Python 不承载业务状态、不直连业务库、不实现权限。

## 决定

| 项 | 决定 |
|---|---|
| HTTP 框架 | FastAPI（MIT） |
| 图像 | OpenCV（`opencv-python-headless`） |
| 音视频与 HEIC | ffmpeg（容器内二进制，**≥ 7.1**，该版本起支持 HEIF 解码；Debian bookworm 自带 5.1 不够，镜像用 trixie 或官方静态构建）。抖音封面是 HEVC 编码的 HEIC，sharp 预编译包无法解码（[sharp #1105](https://github.com/lovell/sharp/issues/1105)），由本服务转 JPEG 后交回 Node 侧（2026-11-04 实测） |
| 运行 | docker compose 中的一个服务，`restart: unless-stopped`；单进程 |
| 网络 | 只在 compose 内网暴露，**不映射宿主端口**，不经 Nginx |
| 凭证 | **不持有数据库凭证**；只读需要的 OSS 对象（只读 RAM 子账号或由 Node Worker 传入短期签名 URL，二选一在 `c-signals` spec 定） |
| 调用方 | 只有 Node Worker；Web 进程不直接调用 |
| 契约 | JSON 请求 / 响应，带能力标识与版本；失败返回结构化错误码，不靠日志文本 |

采用：FastAPI（⭐ 80k+，MIT）、OpenCV（⭐ 80k+，Apache-2.0）

采用：pytest（⭐ 13k+，MIT）（2026-11-04 刘学奎批准，tracer 任务 7 引入）
用途：Python 能力服务的开发依赖，只用于离线单测（例如带真实 HEIC 样本的 ffmpeg 解码测试）
不用它做什么：不进生产镜像；不替代 Node 侧 vitest 的契约测试；不发起真实网络或付费调用

不用它做什么：

- 不写业务库、不存业务状态、不做权限判断；结果由 Node Worker 写入 C 的特征表；
- 不调用供应商 API、不调用大模型（模型调用经 H1，在 Node 侧）；
- 不生成报表（ADR-0011）。

## 补记（2026-11-05，`a-full-sync` 任务 0；决策人：刘学奎）

1. **音频抽取的 OSS 访问方式**：「只读 RAM 子账号」与「Node 传短期签名 URL」二选一，A 域音频抽取先按**后者**实现：Node Worker 为已入库视频生成短期签名 GET URL，Python 经 `ffmpeg -i <url>` 读取并返回 m4a 字节。Python 因此**不持有任何 OSS 凭证**。`c-signals` 沿用这一做法；若 C 域需要不同方式，另修订本 ADR，不在局部实现里各选各的。
2. **图片标准化接口的传输格式**：`POST /v1/image/normalize` 使用**二进制 body + `Content-Type`**，不用 JSON。原因：JSON 需要 base64，体积膨胀约 33%，而封面是 1.0 里最频繁的调用。这是上表「契约：JSON 请求 / 响应」的例外，**只限输入输出为二进制字节的接口**；错误响应仍是 JSON `{code}`，不靠日志文本。`POST /v1/audio/extract` 的请求是 JSON（只含签名 URL 与上限），响应为二进制字节。
3. **登记 uvicorn**（FastAPI 的 ASGI 运行服务器，随 FastAPI 一起使用）：

   采用：uvicorn（⭐ 11k+，BSD-3-Clause；2026-11-01 仍有提交，2026-11-05 核对）
   用途：运行 FastAPI 应用的 HTTP 服务进程，单 worker
   不用它做什么：不对外暴露端口（只在 compose 内网），不经 Nginx；不承载业务状态；不用来做进程管理（重启靠 compose 的 `restart: unless-stopped`）

   Python 侧除 FastAPI、uvicorn、OpenCV、pytest 外，新依赖仍须先登记。

## 后果

- 计量：每次调用返回耗时与能力版本，由 Node Worker 记录，供 I 域观测（C §11）；
- 资源：在测试 ECS 上实测 CPU / 内存后，在 compose 里设上限；
- 默认测试用 fake 服务，不依赖 Python 容器；Python 侧有自己的离线单测（pytest，开发依赖）。

## 现在谁在守

- compose 文件：该服务没有 `ports:`、没有数据库环境变量；
- `c-signals` spec 的契约测试。
