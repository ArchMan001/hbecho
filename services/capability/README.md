# hbecho 能力服务（Python）

图片标准化与音频抽取的 HTTP 外壳。权威决定见 [ADR-0012](../../HBECHO设计方案/architecture/adr/0012-python-capability-service.md)；A 域的调用约定见 [a-full-sync design §7.10](../../.kiro/specs/a-full-sync/design.md)。

## 接口

| 方法与路径 | 请求 | 成功响应 |
|---|---|---|
| `GET /healthz` | 无 | `{status, version, ffmpeg}` |
| `POST /v1/image/normalize` | body 为原始图片字节，`Content-Type: image/*` | JPEG（q≈80、540 宽）；`X-Width`、`X-Height` |
| `POST /v1/audio/extract` | JSON `{source_url, max_bytes}` | m4a 字节（`-c:a copy`，不重编码）；`X-Duration-Ms` |

所有响应带 `X-Capability-Version`。错误一律是 JSON `{code, message}`：

| HTTP | `code` | 含义 | Node 侧处理 |
|---|---|---|---|
| 400 | `invalid_request` | 请求体不合法 | 不可重试 |
| 413 | `input_too_large` | 图片超过 20 MB | 不可重试 |
| 415 | `unsupported_media_type` | 图片接口的 `Content-Type` 不是 `image/*` | 不可重试 |
| 422 | `convert_failed` | 读到了来源但无法转换 / 抽取（含输出超过 `max_bytes`） | 终态 |
| 422 | `no_audio_track` | 视频没有音轨 | 终态事实，不计失败 |
| 502 | `source_unavailable` | 读不到来源（签名过期、网络、对象不存在） | 可重试 |

## 部署约束

- 只在 compose 内网暴露：**没有 `ports:`**，不经 Nginx。
- **不持有数据库或 OSS 凭证。** 音频的来源是 Node 生成的短期签名 GET URL；`ffmpeg` 只允许 `http,https,tcp,tls,crypto` 协议。
- 单 worker（`python -m capability`）；重启靠 compose 的 `restart: unless-stopped`。环境变量：`CAPABILITY_HOST`（默认 `0.0.0.0`）、`CAPABILITY_PORT`（默认 `8080`）。
- 需要 ffmpeg ≥ 7.1（HEIC 解码）。镜像与 compose 文件属 I 域，不在本目录。

## 本地测试

```sh
cd services/capability
python3 -m venv .venv && .venv/bin/python -m pip install -e '.[dev]'
.venv/bin/python -m pytest -q -p no:cacheprovider
```

测试用真实 uvicorn 监听回环端口、用标准库 `urllib` 请求，不引入 `httpx`。没有 ffmpeg 时测试失败而不是跳过。
