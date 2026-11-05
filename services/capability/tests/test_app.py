"""HTTP 外壳的契约测试：真实 uvicorn 监听回环端口，用标准库 urllib 请求（不引入 httpx，ADR-0012 未登记）。
音频用 ffmpeg 现场生成的小样本，经本机 http.server 提供；没有 ffmpeg 时失败而不是跳过。
"""
import functools
import http.client
import http.server
import json
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest
import uvicorn

from capability.app import VERSION, app

REPO = Path(__file__).resolve().parents[3]
HEIC = REPO / "tests" / "fixtures" / "media" / "douyin-cover-540.heic"


@pytest.fixture(scope="module")
def base():
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning"))
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    while not server.started:
        time.sleep(0.01)
    port = server.servers[0].sockets[0].getsockname()[1]
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    t.join(timeout=5)


@pytest.fixture(scope="module")
def media(tmp_path_factory):
    d = tmp_path_factory.mktemp("media")
    def ff(*args: str) -> None:
        subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)
    # moov 放在文件头（faststart），顺序读取的简单 HTTP 服务器也能被 ffprobe / ffmpeg 读
    ff("-f", "lavfi", "-i", "testsrc=size=160x120:rate=5", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-t", "2", "-c:v", "mpeg4", "-c:a", "aac", "-movflags", "+faststart", str(d / "with_audio.mp4"))
    ff("-f", "lavfi", "-i", "testsrc=size=160x120:rate=5", "-t", "2", "-c:v", "mpeg4", "-movflags", "+faststart", str(d / "video_only.mp4"))
    (d / "page.html").write_text("<html>signature expired</html>")
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(d))
    handler.log_message = lambda *a, **k: None  # type: ignore[attr-defined]
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def call(url: str, data: bytes | None = None, headers: dict[str, str] | None = None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def post_json(base: str, path: str, body: object):
    return call(base + path, json.dumps(body).encode(), {"Content-Type": "application/json"})


def code_of(body: bytes) -> str:
    return json.loads(body)["code"]


def test_healthz(base):
    status, _, body = call(base + "/healthz")
    assert status == 200
    assert json.loads(body)["status"] == "ok"


def test_image_normalize_success_returns_jpeg_with_dimensions(base):
    status, h, body = call(base + "/v1/image/normalize", HEIC.read_bytes(), {"Content-Type": "image/heic"})
    assert status == 200
    assert h["Content-Type"] == "image/jpeg"
    assert body.startswith(b"\xff\xd8\xff")
    assert h["X-Width"] == "540"
    assert int(h["X-Height"]) > 0
    assert h["X-Capability-Version"] == VERSION


def test_image_errors_are_structured_json(base):
    status, _, body = call(base + "/v1/image/normalize", b"x", {"Content-Type": "application/json"})
    assert (status, code_of(body)) == (415, "unsupported_media_type")
    status, _, body = call(base + "/v1/image/normalize", b"not an image at all", {"Content-Type": "image/jpeg"})
    assert (status, code_of(body)) == (422, "convert_failed")
    status, _, body = call(base + "/v1/image/normalize", b"", {"Content-Type": "image/jpeg"})
    assert (status, code_of(body)) == (422, "convert_failed")  # 空输入不是「空图」，是失败


def test_image_body_over_limit_is_rejected_before_conversion(base):
    # 声明长度超限：服务端读完请求头就回 413，不等请求体（所以只发请求头）
    host, port = base.removeprefix("http://").split(":")
    conn = http.client.HTTPConnection(host, int(port), timeout=30)
    conn.putrequest("POST", "/v1/image/normalize")
    conn.putheader("Content-Type", "image/jpeg")
    conn.putheader("Content-Length", str(20 * 1024 * 1024 + 1))
    conn.endheaders()
    r = conn.getresponse()
    assert (r.status, code_of(r.read())) == (413, "input_too_large")
    conn.close()


def test_audio_extract_returns_m4a_with_duration(base, media):
    status, h, body = post_json(base, "/v1/audio/extract", {"source_url": f"{media}/with_audio.mp4", "max_bytes": 10_000_000})
    assert status == 200, body
    assert h["Content-Type"] == "audio/mp4"
    assert b"ftyp" in body[:16]
    assert 1500 <= int(h["X-Duration-Ms"]) <= 2500
    assert h["X-Capability-Version"] == VERSION


def test_audio_no_audio_track_is_a_structured_fact(base, media):
    status, _, body = post_json(base, "/v1/audio/extract", {"source_url": f"{media}/video_only.mp4", "max_bytes": 10_000_000})
    assert (status, code_of(body)) == (422, "no_audio_track")


def test_audio_output_over_max_bytes_fails_instead_of_truncating(base, media):
    status, _, body = post_json(base, "/v1/audio/extract", {"source_url": f"{media}/with_audio.mp4", "max_bytes": 100})
    assert (status, code_of(body)) == (422, "convert_failed")


def test_audio_unreadable_source_is_retryable_but_non_media_is_not(base, media):
    status, _, body = post_json(base, "/v1/audio/extract", {"source_url": f"{media}/missing.mp4", "max_bytes": 1_000_000})
    assert (status, code_of(body)) == (502, "source_unavailable")  # 404 / 签名过期：来源读不到
    status, _, body = post_json(base, "/v1/audio/extract", {"source_url": f"{media}/page.html", "max_bytes": 1_000_000})
    assert (status, code_of(body)) == (422, "convert_failed")  # 读到了但不是媒体


def test_audio_only_http_urls_are_accepted(base):
    for url in ("file:///etc/passwd", "concat:a|b", "ftp://example.com/x.mp4"):
        status, _, body = post_json(base, "/v1/audio/extract", {"source_url": url, "max_bytes": 1000})
        assert (status, code_of(body)) == (422, "convert_failed"), url


def test_audio_invalid_request_is_400_with_code(base):
    for bad in ({}, {"source_url": "http://x/y"}, {"source_url": "http://x/y", "max_bytes": 0}, {"source_url": "", "max_bytes": 5}):
        status, _, body = post_json(base, "/v1/audio/extract", bad)
        assert (status, code_of(body)) == (400, "invalid_request"), bad
