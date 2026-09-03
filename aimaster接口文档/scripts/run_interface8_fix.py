# -*- coding: utf-8 -*-
"""
补跑：正确的接口8 —— 获取媒体评论摘要 media_comments
路径：/openapi/v1/media/comments
（此前误将该编号对应到了接口9 media_hot_comments，本脚本补齐真正的接口8）

19 条商家记录全部测试一次，URL 选取规则与主批次一致：
优先使用「主页链接」，没有则使用「视频链接」
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from api_client import call_api, extract_url, save_record, WORKSPACE_ROOT  # noqa: E402

MERCHANT_JSON = os.path.join(WORKSPACE_ROOT, "aimaster接口文档", "示例商家.json")
SUMMARY_PATH = os.path.join(WORKSPACE_ROOT, "aimaster接口文档", "测试结果", "接口8_补跑清单.json")

ACTION = "media_comments"
PATH = "/openapi/v1/media/comments"


def load_merchants():
    with open(MERCHANT_JSON, "r", encoding="utf-8") as f:
        return json.load(f)


def safe_filename_part(s: str) -> str:
    if not s:
        return "unknown"
    keep = "".join(c for c in s if c not in '\\/:*?"<>|')
    return keep.strip()[:30] or "unknown"


def main():
    merchants = load_merchants()
    summary = []

    for idx, m in enumerate(merchants, start=1):
        platform = m.get("平台", "")
        name = m.get("账号名称（专员名）", "")
        homepage_raw = m.get("主页链接")
        video_raw = m.get("视频链接")

        homepage_url = extract_url(homepage_raw) if homepage_raw else ""
        video_url = extract_url(video_raw) if video_raw else ""
        primary_url = homepage_url or video_url
        source_field = "主页链接" if homepage_url else "视频链接"

        print(f"\n=== [{idx}/{len(merchants)}] {platform} - {name} ({source_field}: {primary_url}) ===")

        if not primary_url:
            print("  !! 无可用 URL，跳过")
            summary.append({"index": idx, "platform": platform, "name": name, "skipped": True})
            continue

        payload = {"url": primary_url}
        fname = f"{idx:02d}_{safe_filename_part(platform)}_{safe_filename_part(name)}_08_media_comments.json"
        print(f"  -> 调用接口8 {ACTION} ...", end="", flush=True)

        result = call_api(ACTION, PATH, payload, poll_interval=5, max_wait=300)
        saved_path = save_record(fname, result)

        status = result.get("final_status")
        print(f" 状态={status} 耗时={result.get('elapsed_seconds')}s")

        summary.append({
            "index": idx,
            "platform": platform,
            "name": name,
            "url_used": primary_url,
            "source_field": source_field,
            "final_status": status,
            "raw_file": os.path.relpath(saved_path, WORKSPACE_ROOT),
            "error": result.get("error") if status != "succeeded" else None,
        })

        with open(SUMMARY_PATH, "w", encoding="utf-8") as f:
            json.dump(summary, f, ensure_ascii=False, indent=2)

    print(f"\n补跑完成，共 {len(merchants)} 条商家记录。清单：{SUMMARY_PATH}")


if __name__ == "__main__":
    main()
