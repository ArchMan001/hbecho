# -*- coding: utf-8 -*-
"""
单次同步查询：抖音主页 media_user_info
复用 run_sync_raw_test.py 里的调用方式（async=false，同步模式）
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


def main():
    label = "抖音主页_MS4wLjABAAAAaQ"
    url = (
        "https://www.douyin.com/user/"
        "MS4wLjABAAAAaQNZi_ulE1SgF5-WN-toezy3GtHsCmdlZjrc1wkHcLA"
        "?from_tab_name=main"
    )
    record = call_sync("media_user_info", "/openapi/v1/media_user_info", {"url": url}, label)
    filename = f"V1.2_raw直传_{label}_media_user_info.json"
    save_record(filename, record)
    print(json.dumps(record, ensure_ascii=False, indent=2))
    print(f"\n已落盘：{os.path.join(RAW_DIR, filename)}")


if __name__ == "__main__":
    main()
