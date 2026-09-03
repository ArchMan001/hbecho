# -*- coding: utf-8 -*-
"""
按照用户要求批量测试 FieldShortcut Master API：
- 19 条商家记录全部测试接口 1(media_user_info) / 3(media_stats) / 4(user_video_list) / 5(user_series_list) / 8(media_hot_comments)
  使用「主页链接」，若无主页链接则使用「视频链接」
- 仅有视频链接（无主页链接）的记录，额外测试接口 2(media_stats_number) / 6(user_latest_video) / 7(post_comments_list) / 11(media_billboard_plugin)

所有请求均为异步模式（async=true），每 5 秒轮询一次任务状态。
每次调用的完整请求与响应都会保存为独立 JSON 文件，供逐条核对。
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from api_client import call_api, extract_url, save_record, RAW_DIR, WORKSPACE_ROOT  # noqa: E402

MERCHANT_JSON = os.path.join(WORKSPACE_ROOT, "aimaster接口文档", "示例商家.json")
SUMMARY_PATH = os.path.join(WORKSPACE_ROOT, "aimaster接口文档", "测试结果", "调用清单与状态.json")

# 接口编号 -> (action标识, 请求路径, 构造payload的方式)
INTERFACES = {
    1: ("media_user_info", "/openapi/v1/media_user_info", lambda url: {"url": url}),
    2: ("media_stats_number", "/openapi/v1/media_stats_number", lambda url: {"url": url}),
    3: ("media_stats", "/openapi/v1/media_stats", lambda url: {"url": url}),
    4: ("user_video_list", "/openapi/v1/user_video_list", lambda url: {"url": url}),
    5: ("user_series_list", "/openapi/v1/user_series_list", lambda url: {"url": url}),
    6: ("user_latest_video", "/openapi/v1/user_latest_video", lambda url: {"url": url}),
    7: ("post_comments_list", "/openapi/v1/media/comments/list", lambda url: {"url": url}),
    8: ("media_hot_comments", "/openapi/v1/media/hot_comments", lambda url: {"url": url}),
    11: ("media_billboard_plugin", "/openapi/v1/media_billboard/plugin", lambda url: {"url": url}),
}

BASE_INTERFACES = [1, 3, 4, 5, 8]
EXTRA_INTERFACES_FOR_VIDEO_ONLY = [2, 6, 7, 11]


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

        only_video = (not homepage_url) and bool(video_url)
        primary_url = homepage_url or video_url
        source_field = "主页链接" if homepage_url else "视频链接"

        interfaces_to_run = list(BASE_INTERFACES)
        if only_video:
            interfaces_to_run += EXTRA_INTERFACES_FOR_VIDEO_ONLY

        record_entry = {
            "index": idx,
            "platform": platform,
            "name": name,
            "homepage_raw": homepage_raw,
            "video_raw": video_raw,
            "homepage_url_extracted": homepage_url,
            "video_url_extracted": video_url,
            "only_video_link": only_video,
            "url_used": primary_url,
            "source_field": source_field,
            "calls": [],
        }

        print(f"\n=== [{idx}/{len(merchants)}] {platform} - {name} ({source_field}: {primary_url}) ===")

        if not primary_url:
            print("  !! 无可用 URL，跳过")
            record_entry["skipped"] = True
            summary.append(record_entry)
            continue

        for iface_no in interfaces_to_run:
            action, path, build_payload = INTERFACES[iface_no]
            payload = build_payload(primary_url)
            fname = f"{idx:02d}_{safe_filename_part(platform)}_{safe_filename_part(name)}_{iface_no:02d}_{action}.json"
            print(f"  -> 调用接口{iface_no} {action} ...", end="", flush=True)

            result = call_api(action, path, payload, poll_interval=5, max_wait=300)
            saved_path = save_record(fname, result)

            status = result.get("final_status")
            print(f" 状态={status} 耗时={result.get('elapsed_seconds')}s")

            record_entry["calls"].append({
                "interface_no": iface_no,
                "action": action,
                "path": path,
                "payload": payload,
                "final_status": status,
                "elapsed_seconds": result.get("elapsed_seconds"),
                "raw_file": os.path.relpath(saved_path, WORKSPACE_ROOT),
                "error": result.get("error") if status != "succeeded" else None,
            })

        summary.append(record_entry)

        # 保存一次中间进度，防止中途中断丢失记录
        with open(SUMMARY_PATH, "w", encoding="utf-8") as f:
            json.dump(summary, f, ensure_ascii=False, indent=2)

    print(f"\n全部完成，共 {len(merchants)} 条商家记录。汇总文件：{SUMMARY_PATH}")


if __name__ == "__main__":
    main()
