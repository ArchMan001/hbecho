"""能力服务的 HTTP 外壳（ADR-0012）。
契约：错误一律是 JSON `{code, message}`，调用方靠 `code` 分类，不靠日志文本；成功响应的二进制字节带 `X-Capability-Version`。
  GET  /healthz
  POST /v1/image/normalize   body：原始图片字节，Content-Type 为图片 MIME → JPEG q80 / 540 宽，X-Width / X-Height
  POST /v1/audio/extract     JSON {source_url, max_bytes} → m4a 字节，X-Duration-Ms；无音轨 → 422 no_audio_track
  POST /v1/image/match       JSON {reference_url, candidate_url, mode, max_bytes} → JSON {score, capability, evidence}；错误体带 side
只在 compose 内网暴露，无数据库 / OSS 凭证。ponytail: 不限并发，靠 Node 侧 mediaConcurrency 约束；上限与升级路径：ffmpeg 子进程多了拖慢同机其它服务时，加 Semaphore。
"""
from __future__ import annotations

from typing import Literal

from fastapi import FastAPI, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import audio, image, match

VERSION = "0.1.0"
HEADERS = {"X-Capability-Version": VERSION}

app = FastAPI(title="hbecho-capability", version=VERSION, docs_url=None, redoc_url=None, openapi_url=None)


def _error(status: int, code: str, message: str = "", side: str | None = None) -> JSONResponse:
    body: dict[str, object] = {"code": code, "message": message[:300]}
    if side is not None:
        body["side"] = side  # 图片匹配：出问题的是 reference 还是 candidate（调用方据此区分「候选图坏了」与「配置错误」）
    return JSONResponse(status_code=status, content=body, headers=HEADERS)


@app.exception_handler(RequestValidationError)
async def _invalid(_: Request, e: RequestValidationError) -> JSONResponse:
    return _error(400, "invalid_request", str(e.errors()[:1]))


@app.get("/healthz")
async def healthz() -> dict[str, object]:
    # 只报 ffmpeg 能否运行；不连任何外部系统
    try:
        major, minor = image.ffmpeg_version()
        return {"status": "ok", "version": VERSION, "ffmpeg": f"{major}.{minor}"}
    except Exception:  # noqa: BLE001 - 健康检查不抛异常，只报告
        return {"status": "degraded", "version": VERSION, "ffmpeg": None}


async def _read_limited(request: Request, limit: int) -> bytes | None:
    """读请求体，超过 limit 立即放弃（不把超限的字节攒进内存）。"""
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > limit:
        return None
    buf = bytearray()
    async for chunk in request.stream():
        buf += chunk
        if len(buf) > limit:
            return None
    return bytes(buf)


@app.post("/v1/image/normalize")
async def normalize_image(request: Request) -> Response:
    ctype = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if not ctype.startswith("image/"):
        return _error(415, "unsupported_media_type", "Content-Type 必须是 image/*")
    data = await _read_limited(request, image.MAX_INPUT_BYTES)
    if data is None:
        return _error(413, "input_too_large", f"输入超过 {image.MAX_INPUT_BYTES} 字节")
    try:
        out = await run_in_threadpool(image.to_normalized_jpeg, data)
    except image.ConversionError as e:
        return _error(422, "convert_failed", str(e))
    return Response(content=out.data, media_type=out.mime_type, headers={**HEADERS, "X-Width": str(out.width), "X-Height": str(out.height)})


class AudioRequest(BaseModel):
    source_url: str = Field(min_length=1, max_length=4096)
    max_bytes: int = Field(ge=1, le=2**31 - 1)


@app.post("/v1/audio/extract")
async def extract_audio(req: AudioRequest) -> Response:
    try:
        out = await run_in_threadpool(audio.extract_audio, req.source_url, req.max_bytes)
    except audio.NoAudioTrack:
        return _error(422, "no_audio_track", "视频没有音轨")
    except audio.SourceUnavailable as e:
        return _error(502, "source_unavailable", str(e))
    except audio.ExtractionError as e:
        return _error(422, "convert_failed", str(e))
    return Response(content=out.data, media_type=out.mime_type, headers={**HEADERS, "X-Duration-Ms": str(out.duration_ms)})


class MatchRequest(BaseModel):
    reference_url: str = Field(min_length=1, max_length=4096)
    candidate_url: str = Field(min_length=1, max_length=4096)
    mode: Literal["template", "element"]
    max_bytes: int = Field(ge=1, le=2**31 - 1)


_MATCH_STATUS = {
    "invalid_request": 400,
    "input_too_large": 413,
    "unsupported_media_type": 415,
    "convert_failed": 422,
    "source_missing": 422,
    "source_unavailable": 502,
}


@app.post("/v1/image/match")
async def match_image(req: MatchRequest) -> Response:
    try:
        out = await run_in_threadpool(match.run_match, req.reference_url, req.candidate_url, req.mode, req.max_bytes)
    except match.MatchError as e:
        return _error(_MATCH_STATUS[e.code], e.code, str(e), e.side)
    return JSONResponse(content=out, headers=HEADERS)
