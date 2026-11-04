"""标准化衍生图：任意输入图（含 HEVC 编码的 HEIC）→ JPEG、540 宽。

为什么在这里：抖音封面是 HEVC 编码的 HEIC，Node 侧 sharp 的预编译包无法解码（sharp #1105），
所以 ADR-0012 / D-57 修订把解码交给 ffmpeg（>= 7.1 才支持 HEIF 解码）。
本模块不写业务库、不存状态、不发网络请求，只做一次纯计算。
"""
from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass

TARGET_WIDTH = 540
# ffmpeg 的 mjpeg 编码器只有整数 qscale：实测 5 → 约 q82、6 → 约 q79（用 IJG 量化表换算），取更接近 80 的 6。
QSCALE = 6
TIMEOUT_SECONDS = 30
MAX_INPUT_BYTES = 20 * 1024 * 1024  # 与 Node 侧下载上限一致


class ConversionError(Exception):
    """输入无法解码为图片（不是「空图」，调用方必须当作失败处理）。"""


@dataclass(frozen=True)
class Normalized:
    data: bytes
    width: int
    height: int
    mime_type: str = "image/jpeg"


def ffmpeg_version() -> tuple[int, int]:
    out = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True, check=True).stdout.splitlines()[0]
    m = re.search(r"version\s+n?(\d+)\.(\d+)", out)
    if not m:
        raise RuntimeError(f"无法解析 ffmpeg 版本：{out!r}")
    return int(m.group(1)), int(m.group(2))


def _jpeg_size(jpeg: bytes) -> tuple[int, int]:
    i = 2
    while i + 9 < len(jpeg):
        if jpeg[i] != 0xFF:
            break
        marker = jpeg[i + 1]
        length = int.from_bytes(jpeg[i + 2 : i + 4], "big")
        if marker in (0xC0, 0xC1, 0xC2):
            return int.from_bytes(jpeg[i + 7 : i + 9], "big"), int.from_bytes(jpeg[i + 5 : i + 7], "big")
        i += 2 + length
    raise ConversionError("输出不是有效的 JPEG（没有 SOF）")


def to_normalized_jpeg(data: bytes, width: int = TARGET_WIDTH) -> Normalized:
    if not data:
        raise ConversionError("空输入")
    if len(data) > MAX_INPUT_BYTES:
        raise ConversionError("输入超过大小上限")
    try:
        proc = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", "pipe:0", "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", str(QSCALE), "-f", "mjpeg", "pipe:1"],
            input=data,
            capture_output=True,
            timeout=TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as e:
        raise ConversionError("转换超时") from e
    if proc.returncode != 0 or not proc.stdout.startswith(b"\xff\xd8\xff"):
        raise ConversionError(f"ffmpeg 无法解码输入：{proc.stderr.decode('utf-8', 'replace')[:200]}")
    w, h = _jpeg_size(proc.stdout)
    return Normalized(data=proc.stdout, width=w, height=h)
