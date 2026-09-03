# -*- coding: utf-8 -*-
"""
FieldShortcut Master API 通用调用工具
- 从 .env 读取 API Key
- 提供异步提交 + 轮询查询的封装
- 每次调用都会把「请求」和「完整原始响应」写入磁盘，方便逐条核对
"""
import json
import os
import re
import time
from datetime import datetime, timezone

import requests

WORKSPACE_ROOT = "/Users/liuxuekui/Documents/hbecho"
ENV_PATH = os.path.join(WORKSPACE_ROOT, ".env")
BASE_URL = "https://openapi.fieldshortcut.com"
RAW_DIR = os.path.join(WORKSPACE_ROOT, "aimaster接口文档", "测试结果", "raw")

os.makedirs(RAW_DIR, exist_ok=True)


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
HEADERS = {
    "Content-Type": "application/json",
    "X-Api-Key": API_KEY,
}


def extract_url(raw: str) -> str:
    """从可能夹杂口令文本、emoji、换行的字符串里提取第一个 http(s) 链接，并去除尾部标点/空白"""
    if raw is None:
        return ""
    m = re.search(r"https?://\S+", raw)
    if not m:
        return raw.strip()
    url = m.group(0)
    # 去掉可能粘连的中文/尾随说明文字及标点
    url = re.split(r"[\s\u4e00-\u9fff]", url)[0]
    url = url.rstrip(",.。，、\\\"'）)】]")
    return url


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def call_api(action: str, path: str, payload: dict, poll_interval: int = 5, max_wait: int = 300) -> dict:
    """
    异步调用一个接口：
    1. POST {path}?async=true 提交任务
    2. 每 poll_interval 秒轮询一次 GET /openapi/v1/tasks/{task_id}
    3. 直到 status 为 succeeded / failed，或超过 max_wait 秒
    返回记录了完整过程的 dict（请求、提交响应、每次轮询响应、最终结果、耗时）
    """
    record = {
        "action": action,
        "endpoint": path,
        "request": {
            "url": f"{BASE_URL}{path}?async=true",
            "method": "POST",
            "headers": {k: v for k, v in HEADERS.items() if k != "X-Api-Key"},
            "body": payload,
        },
        "submit_response": None,
        "poll_responses": [],
        "final_status": None,
        "final_result": None,
        "error": None,
        "started_at": now_iso(),
        "finished_at": None,
        "elapsed_seconds": None,
    }

    t0 = time.time()
    try:
        resp = requests.post(
            f"{BASE_URL}{path}",
            params={"async": "true"},
            headers=HEADERS,
            json=payload,
            timeout=30,
        )
        record["submit_response"] = {
            "http_status": resp.status_code,
            "body": safe_json(resp),
        }
    except Exception as e:
        record["error"] = f"提交请求异常: {e}"
        record["finished_at"] = now_iso()
        record["elapsed_seconds"] = round(time.time() - t0, 2)
        return record

    body = record["submit_response"]["body"]
    if not isinstance(body, dict) or "data" not in body or not body.get("data"):
        # 提交阶段直接失败（比如认证错误、参数错误），没有 task_id 可轮询
        record["final_status"] = "submit_error"
        record["error"] = body
        record["finished_at"] = now_iso()
        record["elapsed_seconds"] = round(time.time() - t0, 2)
        return record

    task_id = body["data"].get("task_id")
    status = body["data"].get("status")

    # 如果提交响应已经是终态（同步返回或极快完成），直接使用
    if status in ("succeeded", "failed"):
        record["final_status"] = status
        record["final_result"] = body["data"].get("result")
        record["error"] = body["data"].get("error")
        record["finished_at"] = now_iso()
        record["elapsed_seconds"] = round(time.time() - t0, 2)
        return record

    if not task_id:
        record["final_status"] = "no_task_id"
        record["error"] = body
        record["finished_at"] = now_iso()
        record["elapsed_seconds"] = round(time.time() - t0, 2)
        return record

    # 轮询
    waited = 0
    while waited <= max_wait:
        time.sleep(poll_interval)
        waited += poll_interval
        try:
            poll_resp = requests.get(
                f"{BASE_URL}/openapi/v1/tasks/{task_id}",
                headers=HEADERS,
                timeout=30,
            )
            poll_body = safe_json(poll_resp)
        except Exception as e:
            record["poll_responses"].append({"error": f"轮询异常: {e}", "waited": waited})
            continue

        record["poll_responses"].append({
            "http_status": poll_resp.status_code,
            "waited_seconds": waited,
            "body": poll_body,
        })

        data = poll_body.get("data") if isinstance(poll_body, dict) else None
        if data and data.get("status") in ("succeeded", "failed"):
            record["final_status"] = data.get("status")
            record["final_result"] = data.get("result")
            record["error"] = data.get("error")
            break

    if record["final_status"] is None:
        record["final_status"] = "timeout"

    record["finished_at"] = now_iso()
    record["elapsed_seconds"] = round(time.time() - t0, 2)
    return record


def safe_json(resp: requests.Response):
    try:
        return resp.json()
    except Exception:
        return {"_raw_text": resp.text}


def save_record(filename: str, record: dict):
    path = os.path.join(RAW_DIR, filename)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2)
    return path
