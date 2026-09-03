# -*- coding: utf-8 -*-
"""
单次异步查询：抖音主页 media_user_info
复用 api_client.py 里的 call_api()（async=true，提交任务 + 轮询）
"""
import json

from api_client import call_api, save_record

LABEL = "抖音主页_MS4wLjABAAAAaQ"
URL = (
    "https://www.douyin.com/user/"
    "MS4wLjABAAAAaQNZi_ulE1SgF5-WN-toezy3GtHsCmdlZjrc1wkHcLA"
    "?from_tab_name=main"
)


def main():
    record = call_api(
        action="media_user_info",
        path="/openapi/v1/media_user_info",
        payload={"url": URL},
        poll_interval=5,
        max_wait=300,
    )
    filename = f"V1.2_raw异步_{LABEL}_media_user_info.json"
    saved_path = save_record(filename, record)
    print(json.dumps(record, ensure_ascii=False, indent=2))
    print(f"\n已落盘：{saved_path}")


if __name__ == "__main__":
    main()
