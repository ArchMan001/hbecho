"""标定工具（c-signals design §14 第 7 项）：对业务提供的脱敏样本对跑 match_images，打印每对的度量与按标签汇总的分布，
供人工选定 R_FULL / I_FULL / 特征点上限 / 比率阈值并写进标定报告。**只读本地文件，不发网络请求，不改任何参数。**

用法：.venv/bin/python calibrate.py pairs.json
pairs.json：[{"reference": "路径", "candidate": "路径", "mode": "template" | "element",
              "label": "same" | "altered" | "unrelated" | "present" | "absent", "kind": "cover" | "background" | "avatar"}, ...]
样本由业务提供，仓库只存脱敏后的样本清单与标定报告，不存业务原图。
"""
from __future__ import annotations

import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

from capability import match


def main(manifest: Path) -> None:
    pairs = json.loads(manifest.read_text())
    by_label: dict[str, list[dict[str, object]]] = defaultdict(list)
    print(f"R_FULL={match.R_FULL} I_FULL={match.I_FULL} MAX_KEYPOINTS={match.MAX_KEYPOINTS} RATIO={match.RATIO}")
    for i, p in enumerate(pairs):
        ref = match.load_gray(Path(p["reference"]).read_bytes(), "reference")
        cand = match.load_gray(Path(p["candidate"]).read_bytes(), "candidate")
        r = match.match_images(ref, cand, p["mode"])
        row = {"i": i, "label": p["label"], "kind": p.get("kind", ""), "mode": p["mode"], "score": r.score, **{k: r.evidence[k] for k in ("keypoints_reference", "keypoints_candidate", "good_matches", "inliers", "inlier_ratio", "low_features")}}
        by_label[p["label"]].append(row)
        print(json.dumps(row, ensure_ascii=False))
    print("\n按标签汇总（分数 min / median / max；内点比率 median；内点数 median）")
    for label, rows in sorted(by_label.items()):
        sc = [float(r["score"]) for r in rows]  # type: ignore[arg-type]
        print(f"  {label:10s} n={len(rows):3d} score {min(sc):5.2f} / {statistics.median(sc):5.2f} / {max(sc):5.2f}  ratio {statistics.median(float(r['inlier_ratio']) for r in rows):.3f}  inliers {statistics.median(int(r['inliers']) for r in rows)}")  # type: ignore[arg-type]


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(Path(sys.argv[1]))
