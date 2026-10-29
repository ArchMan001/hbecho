#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI Master 真实 smoke · raw4（2026-10-28）

按 aimaster接口文档/测试结果/raw4-2026-10-28/PLAN.md 执行：
- 串行，不并发
- 同步用例 + 视频详情 + 视频评论 + 异步提交/轮询
- 每次尝试单独落盘；重试仅限 transport / 429 / 5xx
- 预算上限 40 次调用；认证错误或连续 3 次失败立即停止

不打印任何密钥。
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from datetime import datetime, timezone

import urllib.error
import urllib.parse
import urllib.request

ROOT = "/Users/liuxuekui/Documents/hbecho"
ENV_PATH = os.path.join(ROOT, ".env")
OUT_DIR = os.path.join(ROOT, "aimaster接口文档", "测试结果", "raw5-2026-10-28")
os.makedirs(OUT_DIR, exist_ok=True)

BUDGET = 60
MAX_ATTEMPTS = 3
POLL_INTERVAL = 10
MAX_POLLS = 6


def load_env(path: str) -> dict:
    env = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip("'\"")
    return env


ENV = load_env(ENV_PATH)
API_KEY = ENV.get("AIMASTER_API_KEY", "")
if not API_KEY:
    raise SystemExit("缺少 AIMASTER_API_KEY")
if ENV.get("AIMASTER_ENABLED", "false").lower() != "true":
    raise SystemExit("AIMASTER_ENABLED 不是 true，已阻止付费调用")

BASE_URL = (ENV.get("AIMASTER_BASE_URL") or "https://openapi.fieldshortcut.com").rstrip("/")
HEADERS = {"Content-Type": "application/json", "X-Api-Key": API_KEY}
SAFE_HEADERS = {"Content-Type": "application/json"}

retryable = {"transport_error", "rate_limited", "server_error"}
calls = 0
consecutive_failures = 0
results: list[dict] = []


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe_json(resp: requests.Response):
    try:
        return resp.json()
    except Exception:
        return {"_unparsable_raw_text": resp.text[:4000]}


def classify(http_status, body, transport_error):
    if transport_error:
        return "transport_error"
    code = http_status or 0
    if code in (401, 403):
        return "auth_error"
    if code in (400, 422):
        return "input_error"
    if code == 404:
        return "not_found"
    if code == 429:
        return "rate_limited"
    if 500 <= code < 600:
        return "server_error"
    if not isinstance(body, dict):
        return "schema_error"
    data = body.get("data")
    if not isinstance(data, dict):
        return "schema_error"
    status = data.get("status")
    if status == "succeeded":
        return "success"
    if status == "failed":
        return "provider_failed"
    if status in ("pending", "running", "queued"):
        return "pending"
    return "schema_error"


def brief(body):
    """从响应里提取可读摘要，不包含大字段。"""
    if not isinstance(body, dict):
        return {}
    data = body.get("data")
    if not isinstance(data, dict):
        return {"code": body.get("code"), "message": str(body.get("message"))[:200]}
    out = {
        "code": body.get("code"),
        "action": data.get("action"),
        "status": data.get("status"),
        "task_id": data.get("task_id"),
    }
    result = data.get("result")
    if isinstance(result, dict):
        out["result_keys"] = len(result)
        inner = result.get("result")
        if isinstance(inner, list):
            out["items"] = len(inner)
            out["has_more"] = result.get("has_more")
        cur = result.get("max_cursor")
        if cur is not None:
            out["cursor_type"] = type(cur).__name__
            out["cursor_value"] = cur if isinstance(cur, (int, str)) and len(str(cur)) <= 64 else "<long>"
        for k in ("comments", "list", "items"):
            if isinstance(result.get(k), list):
                out[f"{k}_count"] = len(result[k])
    elif isinstance(result, list):
        out["items"] = len(result)
    err = data.get("error")
    if err is not None:
        out["error"] = str(err)[:300]
    return out


def http_call(method: str, url: str, params: dict | None = None, payload: dict | None = None, timeout: int = 300):
    """用标准库发请求，返回 (status, raw_bytes, parsed_json_or_None, error_str)。"""
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=HEADERS, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read()
        status = e.code
    except Exception as e:
        return None, b"", None, f"{type(e).__name__}: {e}"
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except Exception:
        parsed = None
    return status, raw, parsed, None


def save(record: dict, filename: str):
    path = os.path.join(OUT_DIR, filename)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2)
    return path


def post(case_id, platform, action, path, payload, mode, attempt):
    global calls
    if calls >= BUDGET:
        raise SystemExit(f"达到预算上限 {BUDGET} 次调用，停止")
    calls += 1
    record = {
        "case": case_id,
        "platform": platform,
        "action": action,
        "mode": mode,
        "attempt": attempt,
        "endpoint": path,
        "request": {
            "url": f"{BASE_URL}{path}",
            "params": {"async": "false" if mode == "sync" else "true"},
            "method": "POST",
            "headers": SAFE_HEADERS,
            "body": payload,
        },
        "started_at": now_iso(),
        "http_status": None,
        "response_body": None,
        "response_bytes": None,
        "response_sha256": None,
        "transport_error": None,
        "elapsed_seconds": None,
        "classification": None,
    }
    t0 = time.time()
    status, raw, parsed, err = http_call(
        "POST", f"{BASE_URL}{path}",
        params={"async": "false" if mode == "sync" else "true"},
        payload=payload, timeout=300,
    )
    if err:
        record["transport_error"] = err
    else:
        record["http_status"] = status
        record["response_body"] = parsed if parsed is not None else {"_unparsable_raw_text": raw.decode("utf-8", "replace")[:4000]}
        record["response_bytes"] = len(raw)
        record["response_sha256"] = hashlib.sha256(raw).hexdigest()
    record["elapsed_seconds"] = round(time.time() - t0, 2)
    record["classification"] = classify(record["http_status"], record["response_body"], record["transport_error"])
    save(record, f"{case_id}-{platform}-{action}-{mode}-attempt{attempt}.json")
    print(
        f"[{case_id}] {platform}/{action}/{mode} attempt={attempt} "
        f"{record['elapsed_seconds']}s -> {record['classification']} {brief(record['response_body'])}",
        flush=True,
    )
    return record


def poll_task(case_id, platform, task_id, index):
    global calls
    if calls >= BUDGET:
        raise SystemExit(f"达到预算上限 {BUDGET} 次调用，停止")
    calls += 1
    record = {
        "case": case_id,
        "platform": platform,
        "action": "tasks.get",
        "mode": "async-poll",
        "attempt": index,
        "endpoint": f"/openapi/v1/tasks/{task_id}",
        "request": {"method": "GET", "headers": SAFE_HEADERS},
        "started_at": now_iso(),
        "http_status": None,
        "response_body": None,
        "response_bytes": None,
        "response_sha256": None,
        "transport_error": None,
        "elapsed_seconds": None,
        "classification": None,
    }
    t0 = time.time()
    status, raw, parsed, err = http_call("GET", f"{BASE_URL}/openapi/v1/tasks/{task_id}", timeout=120)
    if err:
        record["transport_error"] = err
    else:
        record["http_status"] = status
        record["response_body"] = parsed if parsed is not None else {"_unparsable_raw_text": raw.decode("utf-8", "replace")[:4000]}
        record["response_bytes"] = len(raw)
        record["response_sha256"] = hashlib.sha256(raw).hexdigest()
    record["elapsed_seconds"] = round(time.time() - t0, 2)
    record["classification"] = classify(record["http_status"], record["response_body"], record["transport_error"])
    save(record, f"{case_id}-{platform}-poll{index}.json")
    print(f"[{case_id}] poll{index} {record['elapsed_seconds']}s -> {record['classification']} {brief(record['response_body'])}", flush=True)
    return record


def run_sync(case):
    case_id, platform, action, path, payload = case["id"], case["platform"], case["action"], case["path"], case["payload"]
    last = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        last = post(case_id, platform, action, path, payload, "sync", attempt)
        if last["classification"] == "success":
            return last
        if last["classification"] == "auth_error":
            raise SystemExit("认证失败（401/403），停止全部用例")
        if last["classification"] not in retryable:
            return last
        if attempt < MAX_ATTEMPTS:
            wait = 2 if attempt == 1 else 8
            print(f"[{case_id}] {last['classification']}，{wait}s 后重试", flush=True)
            time.sleep(wait)
    return last


def run_async(case):
    case_id, platform, action, path, payload = case["id"], case["platform"], case["action"], case["path"], case["payload"]
    submit = post(case_id, platform, action, path, payload, "async", 1)
    if submit["classification"] == "auth_error":
        raise SystemExit("认证失败（401/403），停止全部用例")
    body = submit["response_body"] if isinstance(submit["response_body"], dict) else {}
    data = body.get("data") if isinstance(body.get("data"), dict) else {}
    task_id = data.get("task_id")
    status = data.get("status")
    if status in ("succeeded", "failed"):
        submit["classification"] = "success" if status == "succeeded" else "provider_failed"
        return submit
    if not task_id:
        submit["classification"] = "schema_error"
        return submit
    for i in range(1, MAX_POLLS + 1):
        time.sleep(POLL_INTERVAL)
        rec = poll_task(case_id, platform, task_id, i)
        if rec["classification"] == "success" or rec["classification"] == "provider_failed":
            return rec
    last = {"case": case_id, "classification": "async_timeout", "task_id": task_id}
    print(f"[{case_id}] 轮询 {MAX_POLLS} 次仍未终态，记 async_timeout", flush=True)
    return last


XHS_PROFILE = "我在小红书收获了3397次赞与收藏，点击链接或复制口令来看我的主页>> https://xhslink.cn/o/2zMPN8P7pyN"
XHS_NOTE2 = "旧垣光“隐”—“天华杯一等奖”是什么体验 这算是我... https://xhslink.cn/o/4hMmW8UF4S9"

CASES = [
    {"id": "C01", "platform": "xiaohongshu", "action": "media_user_info", "path": "/openapi/v1/media_user_info", "payload": {"url": XHS_PROFILE}, "mode": "sync"},
    {"id": "C02", "platform": "xiaohongshu", "action": "media_user_info", "path": "/openapi/v1/media_user_info", "payload": {"url": XHS_PROFILE}, "mode": "async"},
    {"id": "C03", "platform": "xiaohongshu", "action": "user_video_list", "path": "/openapi/v1/user_video_list", "payload": {"url": XHS_PROFILE, "max_cursor": 0}, "mode": "sync"},
    {"id": "C04", "platform": "xiaohongshu", "action": "user_video_list", "path": "/openapi/v1/user_video_list", "payload": {"url": XHS_PROFILE, "max_cursor": 0}, "mode": "async"},
    {"id": "C05", "platform": "xiaohongshu", "action": "media_stats_number", "path": "/openapi/v1/media_stats_number", "payload": {"url": XHS_NOTE2}, "mode": "sync"},
    {"id": "C06", "platform": "xiaohongshu", "action": "media_stats_number", "path": "/openapi/v1/media_stats_number", "payload": {"url": XHS_NOTE2}, "mode": "async"},
    {"id": "C07", "platform": "xiaohongshu", "action": "post_comments_list", "path": "/openapi/v1/media/comments/list", "payload": {"url": XHS_NOTE2, "max_cursor": 0, "reply_pages": -1}, "mode": "sync"},
    {"id": "C08", "platform": "xiaohongshu", "action": "post_comments_list", "path": "/openapi/v1/media/comments/list", "payload": {"url": XHS_NOTE2, "max_cursor": 0, "reply_pages": -2}, "mode": "sync"},
]

def main():
    global consecutive_failures
    print(f"base={BASE_URL} budget={BUDGET} cases={len(CASES)}")
    for case in CASES:
        if case["mode"] == "sync":
            final = run_sync(case)
        else:
            final = run_async(case)
        cls = final.get("classification")
        results.append({"case": case["id"], "platform": case["platform"], "action": case["action"], "mode": case["mode"], "classification": cls})
        if cls == "success":
            consecutive_failures = 0
        else:
            consecutive_failures += 1
            if consecutive_failures >= 3:
                print("连续 3 个用例失败，停止", flush=True)
                break

    summary = {
        "date": "2026-10-28",
        "base_url": BASE_URL,
        "budget": BUDGET,
        "calls_used": calls,
        "results": results,
    }
    with open(os.path.join(OUT_DIR, "SUMMARY.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print(f"完成：调用 {calls} 次，结果 {len(results)} 条，SUMMARY.json 已写入")


if __name__ == "__main__":
    main()