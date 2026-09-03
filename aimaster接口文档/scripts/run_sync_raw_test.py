# -*- coding: utf-8 -*-
"""
FieldShortcut A Master API — 同步模式（async=false）原始链接直传实测

设计要点：
1. **不做任何 URL 预处理**：用户提供的整段口令文本（含数字、字母、汉字、@、:、/ 等噪声）
   原样作为 `url` 入参提交，用于验证供应商侧是否自带链接抽取/短链解析能力。
2. 统一使用 `async=false`（同步模式），不走任务轮询。
3. 每次调用都把「完整请求」与「完整原始响应」落盘为独立 JSON，API Key 不落盘。
4. 有限并发（bounded concurrency），不做无界压测。
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
RAW_DIR = os.path.join(WORKSPACE_ROOT, "aimaster接口文档", "测试结果", "raw")

os.makedirs(RAW_DIR, exist_ok=True)

# 并发上限：供应商未给出 QPS 承诺，保守取小值
MAX_WORKERS = 4
CONNECT_TIMEOUT = 10.0
READ_TIMEOUT = 300.0


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
SAFE_HEADERS = {"Content-Type": "application/json"}  # 落盘用，不含 Key


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# 原始输入（严格不预处理，整段文本直传）
# ---------------------------------------------------------------------------
RAW_PROFILES = [
    ("抖音主页01", "0- 长按复制此条消息，打开抖音搜索，查看TA的更多作品。 https://v.douyin.com/rculchE1fmQ/ 1@5.com :9pm"),
    ("抖音主页02", "0- 长按复制此条消息，打开抖音搜索，查看TA的更多作品。 https://v.douyin.com/M8nTVBa9BYg/ 0@8.com :7pm"),
    ("抖音主页03", "8- 长按复制此条消息，打开抖音搜索，查看TA的更多作品。 https://v.douyin.com/ENc9FMEIEXo/ 3@5.com :7pm"),
    ("抖音主页04", "7- 长按复制此条消息，打开抖音搜索，查看TA的更多作品。 https://v.douyin.com/Eeu_zZ6j-FQ/ 1@0.com :5pm"),
    ("抖音主页05", "2- 长按复制此条消息，打开抖音搜索，查看TA的更多作品。 https://v.douyin.com/RNYRVGbacQM/ 9@0.com :2pm"),
]

RAW_VIDEOS = [
    ("抖音视频01", "2.05 :6pm RXz:/ 07/27 P@k.cA 历朝历代费尽心思避暑｜终于被日立中央空调拿捏夏日舒适~~ # 日立全屋全感3 .0 # 中央空调选购 # 日立中央空调 # 三伏天  https://v.douyin.com/eYNMDEiRFMY/ 复制此链接，打开Dou音搜索，直接观看视频！"),
    ("抖音视频02", "4.64 :5pm Q@x.fb wsE:/ 01/04 中国人能飞｜装日立，居家感受舒适到起飞！ # 中国人能飞 # 日立中央空调 # 装修 # 中央空调 # 日立尊睿全效Ⅱ  https://v.douyin.com/OYHWxvH9tgc/ 复制此链接，打开Dou音搜索，直接观看视频！"),
]

PROFILE_ENDPOINTS = [
    ("media_user_info", "/openapi/v1/media_user_info", {}),
    ("user_video_list", "/openapi/v1/user_video_list", {"max_cursor": 0}),
]

VIDEO_ENDPOINTS = [
    ("media_stats_number", "/openapi/v1/media_stats_number", {}),
    ("media_stats", "/openapi/v1/media_stats", {}),
    ("post_comments_list", "/openapi/v1/media/comments/list", {"max_cursor": 0, "reply_pages": -1}),
    ("media_hot_comments", "/openapi/v1/media/hot_comments", {}),
]


def safe_json(resp: requests.Response):
    try:
        return resp.json()
    except Exception:
        return {"_unparsable_raw_text": resp.text}


def call_sync(action: str, path: str, payload: dict, label: str) -> dict:
    """同步调用一次接口，返回完整审计记录"""
    session_headers = {**SAFE_HEADERS, "X-Api-Key": API_KEY}
    record = {
        "label": label,
        "action": action,
        "mode": "sync (async=false)",
        "endpoint": path,
        "request": {
            "url": f"{BASE_URL}{path}?async=false",
            "method": "POST",
            "headers": SAFE_HEADERS,  # 故意不保存 X-Api-Key
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


def build_jobs():
    jobs = []
    for name, raw_text in RAW_PROFILES:
        for action, path, extra in PROFILE_ENDPOINTS:
            payload = {"url": raw_text, **extra}
            jobs.append((f"{name}_{action}", action, path, payload))
    for name, raw_text in RAW_VIDEOS:
        for action, path, extra in VIDEO_ENDPOINTS:
            payload = {"url": raw_text, **extra}
            jobs.append((f"{name}_{action}", action, path, payload))
    return jobs


def summarize(record: dict) -> str:
    body = record.get("response_body")
    if record.get("transport_error"):
        return f"TRANSPORT_ERROR {record['transport_error']}"
    if not isinstance(body, dict):
        return f"HTTP {record['http_status']} 非 JSON"
    data = body.get("data")
    if not isinstance(data, dict):
        return f"HTTP {record['http_status']} code={body.get('code')} data异常={str(data)[:120]}"
    status = data.get("status")
    err = data.get("error")
    result = data.get("result")
    rtype = type(result).__name__
    rlen = ""
    if isinstance(result, dict):
        rlen = f" keys={len(result)}"
        if isinstance(result.get("result"), list):
            rlen += f" items={len(result['result'])} has_more={result.get('has_more')!r}"
    return (
        f"HTTP {record['http_status']} code={body.get('code')} status={status} "
        f"action={data.get('action')} result={rtype}{rlen} error={str(err)[:120]}"
    )


def main():
    jobs = build_jobs()
    print(f"共 {len(jobs)} 个同步调用，并发 {MAX_WORKERS}\n", flush=True)

    results = {}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {
            pool.submit(call_sync, action, path, payload, label): label
            for label, action, path, payload in jobs
        }
        for fut in as_completed(futures):
            label = futures[fut]
            record = fut.result()
            filename = f"V1.2_raw直传_{label}.json"
            save_record(filename, record)
            results[label] = record
            print(f"[{label}] {record['elapsed_seconds']}s -> {summarize(record)}", flush=True)

    # 汇总
    summary = {
        "generated_at": now_iso(),
        "mode": "sync (async=false)",
        "no_url_preprocessing": True,
        "total_calls": len(jobs),
        "items": [
            {
                "label": label,
                "action": rec["action"],
                "endpoint": rec["endpoint"],
                "http_status": rec["http_status"],
                "elapsed_seconds": rec["elapsed_seconds"],
                "summary": summarize(rec),
            }
            for label, rec in sorted(results.items())
        ],
    }
    save_record("V1.2_raw直传_汇总.json", summary)
    print("\n=== 完成，原始记录目录 ===")
    print(RAW_DIR, flush=True)


if __name__ == "__main__":
    main()
