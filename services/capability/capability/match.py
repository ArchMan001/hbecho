"""模板 / 元素匹配（c-signals design §7.8，ADR-0012 补记）：两张图 → 0.00–10.00 的连续分数 + 证据。

流程：下载两张图（Node 签发的短期 GET URL，Python 不持有任何凭证）→ 解码为 540 宽灰度图（HEIC 经 ffmpeg）→
SIFT → kNN 比率检验 → RANSAC 单应矩阵 → 内点数映射为分数。分数映射在这里，随 Python 升版（能力版本由本模块回报）。
不做 pHash 预筛（design SG-D07）。不写业务库、不存状态。

R_FULL / I_FULL / 特征点上限 / 比率阈值是**标定参数**：初值只为让合成图测试的排序成立，真实样本标定后改并说明依据；
已上线后改任何一个都要升 CAPABILITIES 里的版本（design §14 第 7 项；标定报告签字前 image.* 不进生产启用集）。
"""
from __future__ import annotations

import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Literal

import cv2
import numpy as np

from . import image

Mode = Literal["template", "element"]
CAPABILITIES: dict[str, tuple[str, int]] = {"template": ("image.template", 1), "element": ("image.element", 1)}

TARGET_WIDTH = 540
MAX_KEYPOINTS = 1500
MIN_KEYPOINTS = 8
MIN_GOOD_MATCHES = 4
RATIO = 0.75
RANSAC_PX = 5.0
R_FULL = 0.30  # template：内点数 / min(两图特征点数) 达到它即满分
I_FULL = 25  # element：内点数达到它即满分
DOWNLOAD_TIMEOUT_SECONDS = 30


class MatchError(Exception):
    """带 code / side 的可分类错误；HTTP 层把它映射成 JSON 错误体。"""

    def __init__(self, code: str, message: str, side: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.side = side


def looks_like_image(b: bytes) -> bool:
    """按字节嗅探（Content-Type 与扩展名都可能说谎；过期的签名 URL 常返回 200 + HTML）。"""
    return (
        b[:3] == b"\xff\xd8\xff"
        or b[:8].startswith(b"\x89PNG")
        or b[:4] == b"GIF8"
        or (b[:4] == b"RIFF" and b[8:12] == b"WEBP")
        or (b[4:8] == b"ftyp" and b[8:12] in (b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"mif1", b"msf1", b"avif"))
    )


def download(url: str, max_bytes: int, side: str) -> bytes:
    """读来源字节。来源 404 → source_missing（对象不在）；其余读不到 → source_unavailable（可重试）；超限 → input_too_large。"""
    if urllib.parse.urlparse(url).scheme not in ("http", "https"):
        raise MatchError("invalid_request", "只接受 http / https 地址", side)
    try:
        with urllib.request.urlopen(url, timeout=DOWNLOAD_TIMEOUT_SECONDS) as r:  # noqa: S310 - 上面已限制协议
            declared = r.headers.get("Content-Length")
            if declared is not None and declared.isdigit() and int(declared) > max_bytes:
                raise MatchError("input_too_large", f"{side} 图超过 {max_bytes} 字节", side)
            buf = bytearray()
            while chunk := r.read(64 * 1024):
                buf += chunk
                if len(buf) > max_bytes:
                    raise MatchError("input_too_large", f"{side} 图超过 {max_bytes} 字节", side)
            return bytes(buf)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise MatchError("source_missing", f"{side} 图对象不存在（404）", side) from e
        raise MatchError("source_unavailable", f"{side} 图读取失败（HTTP {e.code}）", side) from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise MatchError("source_unavailable", f"{side} 图读取失败：{type(e).__name__}", side) from e


def load_gray(data: bytes, side: str) -> np.ndarray:
    """解码为 540 宽灰度图。先走 OpenCV（jpeg / png / webp 够快），解不开再走 ffmpeg（HEIC）。"""
    if not looks_like_image(data):
        raise MatchError("unsupported_media_type", f"{side} 图不是支持的图片格式", side)
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_GRAYSCALE)
    if img is None:
        try:
            jpeg = image.to_normalized_jpeg(data).data
        except image.ConversionError as e:
            raise MatchError("convert_failed", f"{side} 图无法解码：{e}", side) from e
        img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_GRAYSCALE)
        if img is None:
            raise MatchError("convert_failed", f"{side} 图无法解码", side)
    h, w = img.shape[:2]
    if w != TARGET_WIDTH:
        img = cv2.resize(img, (TARGET_WIDTH, max(1, round(h * TARGET_WIDTH / w))), interpolation=cv2.INTER_AREA)
    return img


@dataclass(frozen=True)
class MatchResult:
    score: float
    evidence: dict[str, object]


def _convex_quad_ratio(h: np.ndarray, ref_shape: tuple[int, int], cand_shape: tuple[int, int]) -> float | None:
    """把参考图四角经单应矩阵投到候选图：必须是凸四边形，返回其面积 / 候选图面积；退化返回 None。"""
    rh, rw = ref_shape
    corners = np.float32([[0, 0], [rw, 0], [rw, rh], [0, rh]]).reshape(-1, 1, 2)
    quad = cv2.perspectiveTransform(corners, h).reshape(-1, 2)
    if not np.all(np.isfinite(quad)) or not cv2.isContourConvex(quad.astype(np.float32).reshape(-1, 1, 2)):
        return None
    area = abs(cv2.contourArea(quad.astype(np.float32)))
    return area / float(cand_shape[0] * cand_shape[1])


def match_images(reference: np.ndarray, candidate: np.ndarray, mode: Mode) -> MatchResult:
    t0 = time.perf_counter()
    sift = cv2.SIFT_create(nfeatures=MAX_KEYPOINTS)
    kp_r, des_r = sift.detectAndCompute(reference, None)
    kp_c, des_c = sift.detectAndCompute(candidate, None)
    ev: dict[str, object] = {
        "keypoints_reference": len(kp_r),
        "keypoints_candidate": len(kp_c),
        "good_matches": 0,
        "inliers": 0,
        "inlier_ratio": 0.0,
        "low_features": False,
        "preprocess": {"width": TARGET_WIDTH},
    }

    def done(score: float) -> MatchResult:
        ev["elapsed_ms"] = round((time.perf_counter() - t0) * 1000)
        return MatchResult(round(max(0.0, min(10.0, score)), 2), ev)

    if len(kp_r) < MIN_KEYPOINTS or len(kp_c) < MIN_KEYPOINTS or des_r is None or des_c is None:
        ev["low_features"] = True  # 纯色 / 低纹理图：没有可比对的特征，0 分并如实标注，不当作「不匹配」之外的别的东西
        return done(0.0)
    knn = cv2.BFMatcher(cv2.NORM_L2).knnMatch(des_r, des_c, k=2)
    good = [m for pair in knn if len(pair) == 2 for m, n in [pair] if m.distance < RATIO * n.distance]
    ev["good_matches"] = len(good)
    if len(good) < MIN_GOOD_MATCHES:
        return done(0.0)
    src = np.float32([kp_r[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([kp_c[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    h, mask = cv2.findHomography(src, dst, cv2.RANSAC, RANSAC_PX)
    inliers = int(mask.sum()) if h is not None and mask is not None else 0
    ev["inliers"] = inliers
    ev["inlier_ratio"] = round(inliers / min(len(kp_r), len(kp_c)), 4)
    if h is None or inliers == 0:
        return done(0.0)
    if mode == "template":
        return done(10.0 * min(1.0, (inliers / min(len(kp_r), len(kp_c))) / R_FULL))
    ratio = _convex_quad_ratio(h, reference.shape[:2], candidate.shape[:2])
    ev["quad_area_ratio"] = None if ratio is None else round(ratio, 4)
    if ratio is None or not (0.02 <= ratio <= 1.5):
        ev["degenerate_homography"] = True  # 单应矩阵退化（非凸 / 面积离谱）：内点是巧合，不算命中
        return done(0.0)
    return done(10.0 * max(0.0, min(1.0, (inliers - MIN_GOOD_MATCHES) / (I_FULL - MIN_GOOD_MATCHES))))


def run_match(reference_url: str, candidate_url: str, mode: Mode, max_bytes: int) -> dict[str, object]:
    ref_bytes = download(reference_url, max_bytes, "reference")
    cand_bytes = download(candidate_url, max_bytes, "candidate")
    ref = load_gray(ref_bytes, "reference")
    cand = load_gray(cand_bytes, "candidate")
    res = match_images(ref, cand, mode)
    cap_id, cap_version = CAPABILITIES[mode]
    return {"score": res.score, "capability": {"id": cap_id, "version": cap_version}, "evidence": res.evidence}
