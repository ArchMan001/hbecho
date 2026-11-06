"""标准化衍生图（JPEG q80、540 宽）的 Python 侧离线单测。

用真实的抖音封面样本（HEVC 编码的 HEIC，tests/fixtures/media/douyin-cover-540.heic）：
sharp 的预编译包解不了它，所以 ADR-0012 / D-57 修订把解码放在这里（ffmpeg >= 7.1）。
没有可用的 ffmpeg 时测试失败而不是跳过——跳过会让「Python 侧验过」变成假绿。
"""
import hashlib
import subprocess
from pathlib import Path

import pytest

from capability.image import ConversionError, ffmpeg_version, to_normalized_jpeg

REPO = Path(__file__).resolve().parents[3]
HEIC = REPO / "tests" / "fixtures" / "media" / "douyin-cover-540.heic"
HEIC_SHA256 = "7d109e54b2023f5240a1ff97d26f28ce0083f4882735e98eb563371a5eba44c2"

# IJG 标准亮度量化表（自然顺序）。用它把 JPEG 里的量化表换算回「质量」，验证确实是 q≈80。
STD_LUMA = [
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
]


def estimated_quality(jpeg: bytes) -> float:
    i = jpeg.index(b"\xff\xdb")  # 第一个 DQT：亮度表
    length = int.from_bytes(jpeg[i + 2 : i + 4], "big")
    body = jpeg[i + 4 : i + 2 + length]
    assert body[0] >> 4 == 0, "期望 8 位量化表"
    table = list(body[1:65])
    scale = 100 * sum(table) / sum(STD_LUMA)
    return (200 - scale) / 2 if scale <= 100 else 5000 / scale


def dimensions(jpeg: bytes) -> tuple[int, int]:
    i = 2
    while i < len(jpeg):
        assert jpeg[i] == 0xFF
        marker = jpeg[i + 1]
        length = int.from_bytes(jpeg[i + 2 : i + 4], "big")
        if marker in (0xC0, 0xC1, 0xC2):
            return int.from_bytes(jpeg[i + 7 : i + 9], "big"), int.from_bytes(jpeg[i + 5 : i + 7], "big")
        i += 2 + length
    raise AssertionError("没有 SOF")


def synthetic_png(width: int, height: int) -> bytes:
    return subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"testsrc=size={width}x{height}", "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"],
        check=True, capture_output=True,
    ).stdout


def test_ffmpeg_version_supports_heif():
    major, minor = ffmpeg_version()
    assert (major, minor) >= (7, 1), "HEIF 解码需要 ffmpeg >= 7.1（ADR-0012）"


def test_fixture_is_the_registered_sample():
    assert hashlib.sha256(HEIC.read_bytes()).hexdigest() == HEIC_SHA256


def test_real_heic_cover_becomes_540_wide_jpeg_q80():
    result = to_normalized_jpeg(HEIC.read_bytes())
    assert result.data[:3] == b"\xff\xd8\xff"
    assert (result.width, result.height) == (540, 960)
    assert dimensions(result.data) == (540, 960)
    assert 77 <= estimated_quality(result.data) <= 83
    assert result.mime_type == "image/jpeg"


def test_wider_input_is_scaled_down_to_540_keeping_aspect_ratio():
    result = to_normalized_jpeg(synthetic_png(1080, 1920))
    assert (result.width, result.height) == (540, 960)
    assert dimensions(result.data) == (540, 960)


def test_derivative_is_independent_bytes_not_the_original():
    original = HEIC.read_bytes()
    result = to_normalized_jpeg(original)
    assert result.data != original
    assert hashlib.sha256(result.data).hexdigest() != HEIC_SHA256


def test_garbage_input_is_a_conversion_error_not_an_empty_image():
    with pytest.raises(ConversionError):
        to_normalized_jpeg(b"not an image at all")
    with pytest.raises(ConversionError):
        to_normalized_jpeg(b"")


def test_truncated_heic_is_rejected():
    with pytest.raises(ConversionError):
        to_normalized_jpeg(HEIC.read_bytes()[:500])


SEEKABLE_HEIC = REPO / "tests" / "fixtures" / "media" / "douyin-cover-540-seekable.heic"


def test_heic_that_cannot_be_decoded_from_a_pipe_converts_from_a_file():
    """真实 smoke（2026-11-06）里约 13% 的抖音 HEIC 封面，ffmpeg 经 pipe:0 输入解不开、给文件路径就能解。
    这个样本就是其中之一；转换必须走可 seek 的文件输入。"""
    out = to_normalized_jpeg(SEEKABLE_HEIC.read_bytes())
    assert out.width == 540 and out.data.startswith(b"\xff\xd8\xff")
    piped = subprocess.run(["ffmpeg", "-v", "error", "-i", "pipe:0", "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "6", "-f", "mjpeg", "pipe:1"], input=SEEKABLE_HEIC.read_bytes(), capture_output=True)
    assert piped.returncode != 0, "样本不再复现管道输入失败：换一个能复现的样本，否则这个用例失去意义"
