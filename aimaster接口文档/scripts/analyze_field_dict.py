# -*- coding: utf-8 -*-
"""
遍历 测试结果/raw 和 raw1 下的所有 json 文件，提取:
- 每个 action 的成功样本 result 字段并集 (含类型、平台分布、样例值)
- 失败原因分布
- 顶层任务包络字段
- 稳定性证据（同一文件名前缀/目标多次出现且状态不同）
输出一个中间 JSON 供人工/后续脚本生成 markdown。
"""
import json
import os
import re
from collections import defaultdict

ROOT = "/Users/liuxuekui/Documents/hbecho/aimaster接口文档/测试结果"
DIRS = ["raw", "raw1"]

def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def guess_platform(filename, request_body):
    name = filename
    url = ""
    if isinstance(request_body, dict):
        url = str(request_body.get("url", ""))
    text = name + " " + url
    if "weixin.qq.com" in text or "视频号" in text or "sph/" in text:
        return "视频号(微信)"
    if "xiaohongshu.com" in text or "xhslink" in text or "小红书" in text:
        return "小红书"
    if "kuaishou" in text or "快手" in text or "v.kuaishou" in text or "chenzhongkexue" in text:
        return "快手"
    if "douyin.com" in text or "抖音" in text or "iesdouyin" in text:
        return "抖音"
    return "未知"

def type_name(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, int):
        return "int"
    if isinstance(v, float):
        return "float"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    if isinstance(v, dict):
        return "object"
    return type(v).__name__

def trunc(v, n=80):
    s = v
    if isinstance(v, str):
        if len(v) > n:
            return s[:n] + "..."
        return s
    return v

def sample_repr(v):
    if isinstance(v, str):
        return trunc(v, 80)
    if isinstance(v, (dict, list)):
        s = json.dumps(v, ensure_ascii=False)
        return trunc(s, 120)
    return v

# field_info[action][field_name] = {
#   "types": set(),
#   "platforms": set(),
#   "samples": [],  # list of (platform, value)
#   "files": set(),
# }
field_info = defaultdict(lambda: defaultdict(lambda: {"types": set(), "platforms": set(), "samples": [], "files": set()}))
action_platforms = defaultdict(set)  # action -> set of platforms seen in successful samples
action_success_files = defaultdict(list)
action_fail_reasons = defaultdict(lambda: defaultdict(int))  # action -> reason -> count
action_fail_files = defaultdict(lambda: defaultdict(list))  # action -> reason -> [files]
all_files = []
parse_errors = []

# for envelope fields
envelope_fields = defaultdict(lambda: {"types": set(), "samples": []})

# track per-target stability: key = (action, platform, url) -> list of (file, status)
stability = defaultdict(list)

def record_field(d, action, platform, filename, prefix=""):
    for k, v in d.items():
        fname = f"{prefix}{k}"
        info = field_info[action][fname]
        info["types"].add(type_name(v))
        info["platforms"].add(platform)
        info["files"].add(filename)
        if len(info["samples"]) < 4:
            info["samples"].append((platform, sample_repr(v)))

def flatten_result_fields(result, action, platform, filename):
    """Record top-level fields of result dict. For nested dict/list of dict fields commonly seen
    (e.g. result.result list, stats nested obj), also peek one level in for documentation purposes
    but store under dotted name with [] for arrays."""
    if not isinstance(result, dict):
        field_info[action]["<result_is_not_dict>"]["types"].add(type_name(result))
        field_info[action]["<result_is_not_dict>"]["platforms"].add(platform)
        field_info[action]["<result_is_not_dict>"]["files"].add(filename)
        return
    record_field(result, action, platform, filename)
    # peek into list-of-dict fields (like result.result, comments, videos)
    for k, v in result.items():
        if isinstance(v, list) and len(v) > 0 and isinstance(v[0], dict):
            # union of item fields
            for item in v[:5]:
                if isinstance(item, dict):
                    record_field(item, action, platform, filename, prefix=f"{k}[].")
        elif isinstance(v, dict):
            record_field(v, action, platform, filename, prefix=f"{k}.")
            for k2, v2 in v.items():
                if isinstance(v2, list) and len(v2) > 0 and isinstance(v2[0], dict):
                    for item in v2[:5]:
                        if isinstance(item, dict):
                            record_field(item, action, platform, filename, prefix=f"{k}.{k2}[].")

def process_sync(obj, filename):
    action = obj.get("action")
    body = obj.get("response_body")
    if not isinstance(body, dict):
        return
    data = body.get("data")
    if not isinstance(data, dict):
        return
    # envelope fields
    for k, v in data.items():
        if k not in ("result",):
            envelope_fields[k]["types"].add(type_name(v))
            if len(envelope_fields[k]["samples"]) < 3:
                envelope_fields[k]["samples"].append(sample_repr(v))
    for k in ("code", "request_id"):
        if k in body:
            envelope_fields[k]["types"].add(type_name(body[k]))
            if len(envelope_fields[k]["samples"]) < 3:
                envelope_fields[k]["samples"].append(sample_repr(body[k]))

    status = data.get("status")
    platform = guess_platform(filename, obj.get("request", {}).get("body"))
    url = ""
    req = obj.get("request", {})
    if isinstance(req, dict):
        rb = req.get("body")
        if isinstance(rb, dict):
            url = str(rb.get("url", ""))

    stability[(action, platform, url)].append((filename, status))

    if status == "succeeded":
        result = data.get("result")
        flatten_result_fields(result, action, platform, filename)
        action_platforms[action].add(platform)
        action_success_files[action].append(filename)
    elif status == "failed" or status is None:
        err = data.get("error")
        reason = None
        if isinstance(err, dict):
            reason = err.get("code") or err.get("message")
        elif err:
            reason = str(err)
        else:
            reason = f"status={status} no_error_field http={obj.get('http_status')}"
        reason = str(reason)[:150] if reason else "unknown"
        action_fail_reasons[action][reason] += 1
        action_fail_files[action][reason].append(filename)

def process_async(obj, filename):
    action = obj.get("action")
    platform = guess_platform(filename, obj.get("request", {}).get("body"))
    url = ""
    req = obj.get("request", {})
    if isinstance(req, dict):
        rb = req.get("body")
        if isinstance(rb, dict):
            url = str(rb.get("url", ""))

    final_status = obj.get("final_status")
    stability[(action, platform, url)].append((filename, final_status))

    # envelope from submit_response / poll_responses
    submit = obj.get("submit_response")
    if isinstance(submit, dict):
        body = submit.get("body")
        if isinstance(body, dict):
            data = body.get("data")
            if isinstance(data, dict):
                for k, v in data.items():
                    if k != "result":
                        envelope_fields[k]["types"].add(type_name(v))
            if "code" in body:
                envelope_fields["code"]["types"].add(type_name(body["code"]))
            if "request_id" in body:
                envelope_fields["request_id"]["types"].add(type_name(body["request_id"]))

    if final_status == "succeeded":
        result = obj.get("final_result")
        flatten_result_fields(result, action, platform, filename)
        action_platforms[action].add(platform)
        action_success_files[action].append(filename)
    elif final_status in ("failed", "timeout", "submit_error", "no_task_id") or final_status is None:
        err = obj.get("error")
        reason = None
        if isinstance(err, dict):
            reason = err.get("code") or err.get("message")
        elif err:
            reason = str(err)
        else:
            reason = f"final_status={final_status}"
        reason = str(reason)[:150] if reason else "unknown"
        action_fail_reasons[action][reason] += 1
        action_fail_files[action][reason].append(filename)

def process_file(path):
    filename = os.path.basename(path)
    try:
        obj = load_json(path)
    except Exception as e:
        parse_errors.append((filename, str(e)))
        return
    all_files.append(filename)

    if filename.endswith("汇总.json") or "generated_at" in obj and "items" in obj and "action" not in obj:
        # summary file, skip field extraction, but note existence
        return

    if "poll_responses" in obj or "submit_response" in obj:
        process_async(obj, filename)
    elif "response_body" in obj:
        process_sync(obj, filename)
    else:
        parse_errors.append((filename, "unrecognized structure"))

def main():
    total = 0
    for d in DIRS:
        dirpath = os.path.join(ROOT, d)
        for fn in sorted(os.listdir(dirpath)):
            if fn.endswith(".json"):
                total += 1
                process_file(os.path.join(dirpath, fn))

    print(f"Total json files scanned: {total}")
    print(f"Parse errors: {len(parse_errors)}")
    for fn, err in parse_errors:
        print(f"  {fn}: {err}")

    print("\n=== Actions with success samples ===")
    for action in sorted(action_success_files):
        print(f"{action}: {len(action_success_files[action])} success files, platforms={action_platforms[action]}")

    print("\n=== Actions with ONLY failures (no success) ===")
    all_actions = set(action_fail_reasons) | set(action_success_files)
    for action in sorted(all_actions):
        if action not in action_success_files or len(action_success_files[action]) == 0:
            print(f"{action}: fail reasons={dict(action_fail_reasons[action])}")

    # Output detailed dump to json for markdown generation
    out = {
        "field_info": {
            action: {
                fname: {
                    "types": sorted(info["types"]),
                    "platforms": sorted(info["platforms"]),
                    "samples": info["samples"],
                    "n_files": len(info["files"]),
                }
                for fname, info in fields.items()
            }
            for action, fields in field_info.items()
        },
        "action_platforms": {a: sorted(p) for a, p in action_platforms.items()},
        "action_success_count": {a: len(f) for a, f in action_success_files.items()},
        "action_success_files": {a: sorted(f) for a, f in action_success_files.items()},
        "action_fail_reasons": {a: dict(r) for a, r in action_fail_reasons.items()},
        "action_fail_files": {a: {r: f for r, f in reasons.items()} for a, reasons in action_fail_files.items()},
        "envelope_fields": {
            k: {"types": sorted(v["types"]), "samples": v["samples"]}
            for k, v in envelope_fields.items()
        },
        "stability_conflicts": {},
    }

    # detect stability conflicts: same (action, platform, url) with differing statuses across files
    for key, entries in stability.items():
        statuses = set(s for _, s in entries)
        if len(entries) > 1 and len(statuses) > 1:
            out["stability_conflicts"][f"{key[0]}|{key[1]}|{key[2][:60]}"] = entries

    with open("/Users/liuxuekui/Documents/hbecho/aimaster接口文档/scripts/field_dict_dump.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print("\nDumped detail to field_dict_dump.json")

if __name__ == "__main__":
    main()
