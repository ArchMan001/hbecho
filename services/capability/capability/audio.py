"""音频抽取：已入库视频的短期签名 URL → m4a / AAC 原样（不重编码）。
Python 不持有任何 OSS 凭证（ADR-0012 补记 1）：Node 传来的签名 URL 自带授权，这里只读。
本模块不写业务库、不存状态；唯一的副作用是在临时目录里写输出文件，函数返回前删除。
"""
from __future__ import annotations

import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

PROBE_TIMEOUT_SECONDS = 30
EXTRACT_TIMEOUT_SECONDS = 120
# ffmpeg / ffprobe 读 HTTP 的单次 IO 超时（微秒）；超时当作来源不可读
RW_TIMEOUT_US = "20000000"
# 只允许直连 http(s)：挡住 file:、concat:、data: 以及清单里嵌套的其它协议
PROTOCOL_WHITELIST = "http,https,tcp,tls,crypto"
# stderr 里表示「读不到来源」而不是「读到了但解不开」的特征
_UNREADABLE = re.compile(r"Server returned|Connection (refused|reset|timed out)|timed out|Input/output error|Name or service not known|nodename nor servname|Network is unreachable|HTTP error", re.I)


class SourceUnavailable(Exception):
    """读不到来源（网络、签名过期、对象不存在）。可重试。"""


class NoAudioTrack(Exception):
    """视频没有音轨。这是事实，不是故障：调用方记终态，不重试。"""


class ExtractionError(Exception):
    """读到了来源，但无法抽取（不是媒体、音轨编码不能原样放进 m4a、输出超限）。不可重试。"""


@dataclass(frozen=True)
class Extracted:
    data: bytes
    duration_ms: int
    mime_type: str = "audio/mp4"


def _check_url(source_url: str) -> None:
    u = urlparse(source_url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ExtractionError("source_url 必须是 http(s) 地址")


def _run(cmd: list[str], timeout: int) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(cmd, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        raise SourceUnavailable("读取来源超时") from e


def _fail(proc: subprocess.CompletedProcess[bytes], what: str) -> Exception:
    err = proc.stderr.decode("utf-8", "replace")[-300:]
    return SourceUnavailable(f"{what}：{err}") if _UNREADABLE.search(err) else ExtractionError(f"{what}：{err}")


def _has_audio(source_url: str) -> bool:
    proc = _run(
        ["ffprobe", "-v", "error", "-protocol_whitelist", PROTOCOL_WHITELIST, "-rw_timeout", RW_TIMEOUT_US, "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", source_url],
        PROBE_TIMEOUT_SECONDS,
    )
    if proc.returncode != 0:
        raise _fail(proc, "ffprobe 读取失败")
    return proc.stdout.strip() != b""


def _duration_ms(path: Path) -> int:
    proc = _run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], PROBE_TIMEOUT_SECONDS)
    try:
        return round(float(proc.stdout.decode().strip()) * 1000)
    except ValueError as e:
        raise ExtractionError("读不到输出时长") from e


def extract_audio(source_url: str, max_bytes: int) -> Extracted:
    _check_url(source_url)
    if max_bytes < 1:
        raise ExtractionError("max_bytes 必须为正")
    if not _has_audio(source_url):
        raise NoAudioTrack()
    with tempfile.TemporaryDirectory(prefix="cap-audio-") as d:
        out = Path(d) / "out.m4a"
        # -fs 在输出到达上限时截断：下面按长度判断，超限当作失败而不是返回被截断的音频
        proc = _run(
            ["ffmpeg", "-v", "error", "-protocol_whitelist", PROTOCOL_WHITELIST, "-rw_timeout", RW_TIMEOUT_US, "-i", source_url, "-vn", "-map", "0:a:0", "-c:a", "copy", "-fs", str(max_bytes + 1), "-f", "ipod", str(out)],
            EXTRACT_TIMEOUT_SECONDS,
        )
        if proc.returncode != 0 or not out.exists():
            raise _fail(proc, "ffmpeg 抽取失败")
        size = out.stat().st_size
        if size > max_bytes:
            raise ExtractionError(f"输出 {size} 字节超过上限 {max_bytes}")
        if size == 0:
            raise ExtractionError("输出为空")
        return Extracted(data=out.read_bytes(), duration_ms=_duration_ms(out))
