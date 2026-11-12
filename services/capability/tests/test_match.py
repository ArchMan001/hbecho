"""POST /v1/image/match：算法的排序与区间（合成纹理图，固定种子，程序生成，无二进制 fixture）+ HTTP 契约（错误码与 side）。
断言排序与区间，**不断言具体分值**，所以标定参数（R_FULL / I_FULL 等）变化不会让测试失效；真实样本标定是独立的人工产物。
"""
import functools
import http.server
import json
import threading
import time
import urllib.error
import urllib.request

import cv2
import numpy as np
import pytest
import uvicorn

from capability import match
from capability.app import VERSION, app


def scene(seed: int, w: int = 900, h: int = 600) -> np.ndarray:
    """纹理丰富的合成图：模糊噪声底 + 随机矩形 / 圆 / 文字，SIFT 能找到大量稳定特征点。"""
    rng = np.random.default_rng(seed)
    base = cv2.GaussianBlur(rng.random((h, w)).astype(np.float32), (0, 0), 6)
    img = ((base - base.min()) / (base.max() - base.min()) * 160 + 40).astype(np.uint8)
    for _ in range(60):
        x, y, c = int(rng.integers(0, w)), int(rng.integers(0, h)), int(rng.integers(0, 255))
        if rng.random() < 0.5:
            cv2.rectangle(img, (x, y), (x + int(rng.integers(10, 80)), y + int(rng.integers(10, 80))), c, -1)
        else:
            cv2.circle(img, (x, y), int(rng.integers(5, 40)), c, -1)
    for _ in range(30):
        cv2.putText(img, f"HB{int(rng.integers(0, 99)):02d}", (int(rng.integers(0, w - 80)), int(rng.integers(20, h - 10))), cv2.FONT_HERSHEY_SIMPLEX, float(rng.uniform(0.5, 1.4)), int(rng.integers(0, 255)), 2)
    return img


def warp(img: np.ndarray, angle: float = 5, scale: float = 0.85, bright: int = 20) -> np.ndarray:
    h, w = img.shape
    out = cv2.warpAffine(img, cv2.getRotationMatrix2D((w / 2, h / 2), angle, scale), (w, h), borderValue=128)
    return np.clip(out.astype(int) + bright, 0, 255).astype(np.uint8)


def png(img: np.ndarray) -> bytes:
    return cv2.imencode(".png", img)[1].tobytes()


def jpeg(img: np.ndarray, q: int) -> bytes:
    return cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, q])[1].tobytes()


def score(ref: np.ndarray, cand: np.ndarray, mode: match.Mode = "template") -> match.MatchResult:
    pre = lambda i: cv2.resize(i, (match.TARGET_WIDTH, round(i.shape[0] * match.TARGET_WIDTH / i.shape[1])), interpolation=cv2.INTER_AREA)  # noqa: E731
    return match.match_images(pre(ref), pre(cand), mode)


A, B = scene(1), scene(2)
ELEMENT = A[150:350, 200:500]  # 场景 A 里的一块，当作「元素图」


def test_same_image_scores_near_full():
    assert score(A, A).score >= 9.5


def test_scaled_rotated_brighter_still_matches():
    assert score(A, warp(A)).score >= 7


def test_recompressed_and_blurred_still_matches():
    degraded = cv2.GaussianBlur(cv2.imdecode(np.frombuffer(jpeg(A, 35), np.uint8), cv2.IMREAD_GRAYSCALE), (0, 0), 1.2)
    assert score(A, degraded).score >= 7


def test_unrelated_image_scores_low():
    assert score(A, B).score < 2


def test_ordering_is_monotonic():
    same, moved, other = score(A, A).score, score(A, warp(A, 12, 0.7, 30)).score, score(A, B).score
    assert same >= moved > other


def test_element_embedded_in_scene_scores_high_and_absent_scores_low():
    assert score(ELEMENT, warp(A, 3, 0.9, 10), "element").score >= 6
    assert score(ELEMENT, B, "element").score < 2


def test_low_feature_image_scores_zero_and_is_flagged():
    flat = np.full((600, 900), 128, np.uint8)
    r = score(flat, A)
    assert r.score == 0.0 and r.evidence["low_features"] is True
    assert score(A, flat).evidence["low_features"] is True


def test_evidence_carries_measurements():
    ev = score(A, warp(A)).evidence
    for k in ("keypoints_reference", "keypoints_candidate", "good_matches", "inliers", "inlier_ratio", "low_features", "preprocess", "elapsed_ms"):
        assert k in ev
    assert ev["preprocess"] == {"width": 540}


# ───────────────────────── HTTP 契约 ─────────────────────────
@pytest.fixture(scope="module")
def base():
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning"))
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    while not server.started:
        time.sleep(0.01)
    yield f"http://127.0.0.1:{server.servers[0].sockets[0].getsockname()[1]}"
    server.should_exit = True
    t.join(timeout=5)


@pytest.fixture(scope="module")
def files(tmp_path_factory):
    d = tmp_path_factory.mktemp("imgs")
    (d / "a.png").write_bytes(png(A))
    (d / "a_warp.png").write_bytes(png(warp(A)))
    (d / "b.png").write_bytes(png(B))
    (d / "page.html").write_text("<html>signature expired</html>")
    (d / "broken.png").write_bytes(png(A)[:200])  # 有 PNG 魔数但被截断：嗅探通过、解码失败

    class H(http.server.SimpleHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if self.path.startswith("/boom"):
                self.send_error(500)
            else:
                super().do_GET()

        def log_message(self, *a, **k):  # noqa: D401
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(H, directory=str(d)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def post(base: str, body: object):
    req = urllib.request.Request(base + "/v1/image/match", json.dumps(body).encode(), {"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, dict(r.headers), json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), json.loads(e.read())


def req(files: str, ref: str, cand: str, mode: str = "template", max_bytes: int = 20 * 1024 * 1024) -> dict:
    return {"reference_url": f"{files}/{ref}", "candidate_url": f"{files}/{cand}", "mode": mode, "max_bytes": max_bytes}


def test_success_response_shape(base, files):
    status, headers, body = post(base, req(files, "a.png", "a_warp.png"))
    assert status == 200
    assert headers["X-Capability-Version"] == VERSION  # 服务版本；能力版本在 JSON 里
    assert body["capability"] == {"id": "image.template", "version": 1}
    assert 7 <= body["score"] <= 10
    assert body["evidence"]["inliers"] > 0
    status, _, body = post(base, req(files, "a.png", "b.png", "element"))
    assert status == 200 and body["capability"]["id"] == "image.element" and body["score"] < 2


@pytest.mark.parametrize(
    ("ref", "cand", "status", "code", "side"),
    [
        ("a.png", "missing.png", 422, "source_missing", "candidate"),
        ("missing.png", "a.png", 422, "source_missing", "reference"),
        ("a.png", "page.html", 415, "unsupported_media_type", "candidate"),
        ("page.html", "a.png", 415, "unsupported_media_type", "reference"),
        ("a.png", "broken.png", 422, "convert_failed", "candidate"),
        ("a.png", "boom", 502, "source_unavailable", "candidate"),
    ],
)
def test_error_codes_carry_side(base, files, ref, cand, status, code, side):
    s, headers, body = post(base, req(files, ref, cand))
    assert (s, body["code"], body["side"]) == (status, code, side)
    assert headers["X-Capability-Version"] == VERSION


def test_input_too_large_names_the_side(base, files):
    s, _, body = post(base, req(files, "a.png", "a_warp.png", max_bytes=1000))
    assert (s, body["code"], body["side"]) == (413, "input_too_large", "reference")


def test_connection_refused_is_source_unavailable(base):
    s, _, body = post(base, {"reference_url": "http://127.0.0.1:1/x.png", "candidate_url": "http://127.0.0.1:1/y.png", "mode": "template", "max_bytes": 1000})
    assert (s, body["code"], body["side"]) == (502, "source_unavailable", "reference")


def test_invalid_requests(base, files):
    assert post(base, {**req(files, "a.png", "b.png"), "mode": "bogus"})[0] == 400
    s, _, body = post(base, {**req(files, "a.png", "b.png"), "reference_url": "file:///etc/passwd"})
    assert (s, body["code"]) == (400, "invalid_request")  # 只接受 http / https
    assert post(base, {"mode": "template"})[0] == 400
