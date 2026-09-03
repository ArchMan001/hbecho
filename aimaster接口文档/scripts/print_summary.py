# -*- coding: utf-8 -*-
import json

with open("/Users/liuxuekui/Documents/hbecho/aimaster接口文档/scripts/field_dict_dump.json", "r", encoding="utf-8") as f:
    d = json.load(f)

fi = d["field_info"]
for action in sorted(fi):
    fields = fi[action]
    print(f"\n\n##### ACTION: {action} (success_count={d['action_success_count'].get(action)}, platforms={d['action_platforms'].get(action)}) #####")
    for fname in fields:
        info = fields[fname]
        print(f"- {fname} | types={info['types']} | platforms={info['platforms']} | n_files={info['n_files']}")
        for p, s in info["samples"][:2]:
            print(f"    e.g. [{p}] {s}")

print("\n\n===== FAIL REASONS =====")
for action, reasons in d["action_fail_reasons"].items():
    print(f"{action}: {reasons}")

print("\n\n===== ENVELOPE FIELDS =====")
for k, v in d["envelope_fields"].items():
    print(f"- {k} | types={v['types']} | samples={v['samples'][:3]}")

print("\n\n===== STABILITY CONFLICTS =====")
for key, entries in d["stability_conflicts"].items():
    print(f"{key}:")
    for fn, st in entries:
        print(f"    {fn} -> {st}")
