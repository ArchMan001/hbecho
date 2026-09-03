# -*- coding: utf-8 -*-
"""
FieldShortcut A Master API —— 第三轮实测（raw3）

覆盖范围（均为 async=false 同步模式，原始文本不做预处理，直传 url 参数）：
1. 小红书主页 x2：media_user_info、user_video_list
2. 小红书笔记链接 x2：media_stats_number、post_comments_list
3. 抖音主页 x1：media_user_info、user_video_list
4. 抖音视频链接 x1：media_stats_number、post_comments_list
5. 视频号视频链接 x1：media_stats_number、post_comments_list
6. 小红书「主页 -> user_video_list 拿到 post_id -> 拼接 explore URL -> 批量查详情」：
   对上面两个小红书主页各取前 3 个 post_id，派生 https://www.xiaohongshu.com/explore/{post_id}，
   分别调用 media_stats_number 和 post_comments_list，验证批量拼接详情页的可行性。

所有请求/响应完整落盘到 raw3 目录，API Key 不落盘。
"""
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import requests

WORKSPACE_ROOT = "/Users/liuxuekui/Documents/hbecho"
ENV_PATH = os.path.join(WORKSPACE_ROOT, ".env")
BASE_URL = "https://openapi.fieldshortcut.com"
RAW_DIR = os.path.join(WORKSPACE_ROOT, "aimaster接口文档", "测试结果", "raw3")

os.makedirs(RAW_DIR, exist_ok=True)

MAX_WORKERS = 4
CONNECT_TIMEOUT = 10.0
READ_TIMEOUT = 300.0

XHS_POST_ID_RE = re.compile(r"^[0-9a-fA-F]{24}$")


def load_env(path: str) -> dict:
    """解析 .env：按 KEY=VALUE 读取，忽略注释与空行。"""
    env = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip("'\"")
    return env


def load_api_key() -> str:
    """从 .env 读取 AIMASTER_API_KEY，并检查真实付费调用开关。"""
    env = load_env(ENV_PATH)
    key = env.get("AIMASTER_API_KEY", "")
    if not key:
        raise RuntimeError(".env 中缺少 AIMASTER_API_KEY")
    if env.get("AIMASTER_ENABLED", "false").lower() != "true":
        raise RuntimeError(
            "AIMASTER_ENABLED 不是 true，已阻止真实付费调用。"
            "本脚本会对 AI Master 发起计费请求。确认要跑真实 smoke 时，"
            "在 .env 里临时改成 AIMASTER_ENABLED=true，跑完改回 false。"
        )
    return key


API_KEY = load_api_key()
SAFE_HEADERS = {"Content-Type": "application/json"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe_json(resp: requests.Response):
    try:
        return resp.json()
    except Exception:
        return {"_unparsable_raw_text": resp.text}


def call_sync(action: str, path: str, payload: dict, label: str) -> dict:
    session_headers = {**SAFE_HEADERS, "X-Api-Key": API_KEY}
    record = {
        "label": label,
        "action": action,
        "mode": "sync (async=false)",
        "endpoint": path,
        "request": {
            "url": f"{BASE_URL}{path}?async=false",
            "method": "POST",
            "headers": SAFE_HEADERS,
            "body": payload,
        },
        "http_status": None,
        "response_body": None,
        "transport_error": None,
        "started_at": now_iso(),
        "finished_at": None,
        "elapsed_seconds": None,
    }
    t0 = time.time()
    try:
        resp = requests.post(
            f"{BASE_URL}{path}",
            params={"async": "false"},
            headers=session_headers,
            json=payload,
            timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
        )
        record["http_status"] = resp.status_code
        record["response_body"] = safe_json(resp)
    except Exception as e:
        record["transport_error"] = f"{type(e).__name__}: {e}"
    record["finished_at"] = now_iso()
    record["elapsed_seconds"] = round(time.time() - t0, 2)
    return record


def save_record(filename: str, record: dict) -> str:
    path = os.path.join(RAW_DIR, filename)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2)
    return path


def summarize(record: dict) -> str:
    body = record.get("response_body")
    if record.get("transport_error"):
        return f"TRANSPORT_ERROR {record['transport_error']}"
    if not isinstance(body, dict):
        return f"HTTP {record['http_status']} 非 JSON"
    data = body.get("data")
    if not isinstance(data, dict):
        return f"HTTP {record['http_status']} code={body.get('code')} data异常={str(data)[:150]}"
    status = data.get("status")
    err = data.get("error")
    result = data.get("result")
    rtype = type(result).__name__
    extra = ""
    if isinstance(result, dict):
        extra = f" keys={len(result)}"
        if isinstance(result.get("result"), list):
            extra += f" items={len(result['result'])} has_more={result.get('has_more')!r}"
    return (
        f"HTTP {record['http_status']} code={body.get('code')} status={status} "
        f"action={data.get('action')} result={rtype}{extra} error={str(err)[:150]}"
    )


def run_one(label, action, path, payload):
    record = call_sync(action, path, payload, label)
    filename = f"V1.2_raw3_{label}_{action}.json"
    save_record(filename, record)
    print(f"[{label}][{action}] {record['elapsed_seconds']}s -> {summarize(record)}", flush=True)
    return label, action, record


# ---------------------------------------------------------------------------
# 第一批：主页 / 笔记 / 视频链接（严格按用户提供文本，不做任何预处理）
# ---------------------------------------------------------------------------
XHS_HOMEPAGES = [
    ("小红书主页_日立中央空调", "@日立中央空调 在小红书已经有7.8万个粉丝，点击链接或复制口令查看Ta的主页>> https://xhslink.cn/o/E2W9yK1ctR"),
    ("小红书主页_海信中央空调", "@海信中央空调 在小红书已经有7.2万个粉丝，点击链接或复制口令查看Ta的主页>> https://xhslink.cn/o/3xU19S04cbk"),
]

XHS_NOTES = [
    ("小红书笔记_出伏倒计时", "出伏倒计时｜换季空调这样开，舒服又省电！ 好消息，8... https://xhslink.cn/o/3FgtGUlhO8s \n复制这段话，打开【小红书】就能找到对应笔记。"),
    ("小红书笔记_末伏状态检查", "末伏不是关机倒计时，空调该做“状态检查” 从入夏一... https://xhslink.cn/o/7qoWFwzhKvy \n先复制文字，然后进入【小红书】查看笔记。"),
]

DOUYIN_HOMEPAGE = ("抖音主页_MPOAlEqWpec", "9- 长按复制此条消息，打开抖音搜索，查看TA的更多作品。 https://v.douyin.com/MPOAlEqWpec/ 1@3.com :1pm")

DOUYIN_VIDEO = ("抖音视频_中国人能飞", "8.79 复制打开抖音，看看【日立中央空调的作品】中国人能飞｜装日立，居家感受舒适到起飞！ # 中国... https://v.douyin.com/f2BYSAk82l8/ YZm:/ 12/28 W@m.Du :5pm")

WECHAT_VIDEO = ("视频号视频_A9XfQZInhb", "https://weixin.qq.com/sph/A9XfQZInhb")


def main():
    jobs = []

    # 1. 小红书主页 x2 -> media_user_info + user_video_list
    for name, raw_text in XHS_HOMEPAGES:
        jobs.append((f"{name}", "media_user_info", "/openapi/v1/media_user_info", {"url": raw_text}))
        jobs.append((f"{name}", "user_video_list", "/openapi/v1/user_video_list", {"url": raw_text, "max_cursor": 0}))

    # 2. 小红书笔记链接 x2 -> media_stats_number + post_comments_list
    for name, raw_text in XHS_NOTES:
        jobs.append((f"{name}", "media_stats_number", "/openapi/v1/media_stats_number", {"url": raw_text}))
        jobs.append((f"{name}", "post_comments_list", "/openapi/v1/media/comments/list",
                      {"url": raw_text, "max_cursor": 0, "reply_pages": -1}))

    # 3. 抖音主页 x1 -> media_user_info + user_video_list
    name, raw_text = DOUYIN_HOMEPAGE
    jobs.append((name, "media_user_info", "/openapi/v1/media_user_info", {"url": raw_text}))
    jobs.append((name, "user_video_list", "/openapi/v1/user_video_list", {"url": raw_text, "max_cursor": 0}))

    # 4. 抖音视频链接 x1 -> media_stats_number + post_comments_list
    name, raw_text = DOUYIN_VIDEO
    jobs.append((name, "media_stats_number", "/openapi/v1/media_stats_number", {"url": raw_text}))
    jobs.append((name, "post_comments_list", "/openapi/v1/media/comments/list",
                  {"url": raw_text, "max_cursor": 0, "reply_pages": -1}))

    # 5. 视频号视频链接 x1 -> media_stats_number + post_comments_list
    name, raw_text = WECHAT_VIDEO
    jobs.append((name, "media_stats_number", "/openapi/v1/media_stats_number", {"url": raw_text}))
    jobs.append((name, "post_comments_list", "/openapi/v1/media/comments/list",
                  {"url": raw_text, "max_cursor": 0, "reply_pages": -1}))

    print(f"=== 第一批：共 {len(jobs)} 个调用，并发 {MAX_WORKERS} ===\n", flush=True)
    first_batch_results = {}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(run_one, label, action, path, payload): (label, action)
                   for label, action, path, payload in jobs}
        for fut in as_completed(futures):
            label, action, record = fut.result()
            first_batch_results[(label, action)] = record

    # ------------------------------------------------------------------
    # 第二批：小红书主页 -> user_video_list 拿到 post_id -> 拼接 explore URL
    # -> 批量调用 media_stats_number / post_comments_list
    # ------------------------------------------------------------------
    print("\n=== 第二批：小红书 主页->post_id 拼接详情页 批量测试 ===\n", flush=True)
    derive_jobs = []
    for name, _raw_text in XHS_HOMEPAGES:
        list_record = first_batch_results.get((name, "user_video_list"))
        post_ids = []
        if list_record:
            body = list_record.get("response_body")
            if isinstance(body, dict):
                data = body.get("data")
                if isinstance(data, dict) and data.get("status") == "succeeded":
                    result = data.get("result")
                    if isinstance(result, dict) and isinstance(result.get("result"), list):
                        for item in result["result"][:3]:
                            pid = item.get("post_id")
                            if pid and XHS_POST_ID_RE.fullmatch(str(pid)):
                                post_ids.append(str(pid))

        print(f"{name}: 派生 post_id 数量 = {len(post_ids)} -> {post_ids}", flush=True)

        for idx, pid in enumerate(post_ids, start=1):
            derived_url = f"https://www.xiaohongshu.com/explore/{pid}"
            derive_label = f"{name}_派生详情{idx}_{pid[:8]}"
            derive_jobs.append((derive_label, "media_stats_number", "/openapi/v1/media_stats_number",
                                 {"url": derived_url}))
            derive_jobs.append((derive_label, "post_comments_list", "/openapi/v1/media/comments/list",
                                 {"url": derived_url, "max_cursor": 0, "reply_pages": -1}))

    if derive_jobs:
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            futures = [pool.submit(run_one, label, action, path, payload)
                       for label, action, path, payload in derive_jobs]
            for fut in as_completed(futures):
                fut.result()
    else:
        print("!! 两个小红书主页均未拿到可用 post_id，无法测试拼接详情页", flush=True)

    print(f"\n=== 全部完成，原始记录目录：{RAW_DIR} ===", flush=True)


if __name__ == "__main__":
    main()
