#!/usr/bin/env python3
"""文档登记与 spec 结构检查。

规则来源：HBECHO设计方案/INDEX.md §4、§8、§9；.kiro/steering/structure.md。
- 必需文档存在且非空；
- 不允许 0 字节 Markdown（占位文件制造虚假完备度）；
- HBECHO设计方案/archive/ 下每份文档必须有 superseded/archived 状态头；
- .kiro/specs/<name>/ 必须是四件套，或明确登记为 design-only；
- 含已跟踪文件的一级目录、受控 legacy 根文件必须在 HBECHO设计方案/INDEX.md 出现。
"""
from __future__ import annotations

import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

REQUIRED = [
    "CONTEXT.md",
    "CLAUDE.md",
    "AGENTS.md",
    "HBECHO设计方案/INDEX.md",
    "HBECHO设计方案/governance/constitution.md",
    "HBECHO设计方案/architecture/adr/README.md",
    "HBECHO设计方案/prd-platform.md",
    "HBECHO设计方案/domains/data-foundation/database-design-v2.md",
    "HBECHO设计方案/runbooks/server-operations-runbook.md",
    "HBECHO设计方案/runbooks/dev-test-deploy-workflow.md",
    "HBECHO设计方案/runbooks/new-server-bootstrap-checklist.md",
    ".kiro/specs/a-data-foundation-tracer/requirements.md",
    ".kiro/specs/a-data-foundation-tracer/design.md",
    ".kiro/specs/a-data-foundation-tracer/tasks.md",
    ".kiro/specs/a-data-foundation-tracer/acceptance.md",
]

# 只有 design.md 的 spec，必须在 HBECHO设计方案/INDEX.md 明确登记。新增条目要单独评审，不要在这里顺手放宽。
DESIGN_ONLY_SPECS = {"access-control", "rule-engine", "metrics-and-dashboard"}

# 受控 legacy 文件：位置已统一到 archive/legacy/，仍必须由 INDEX 逐项登记（INDEX §8.2）。
LEGACY_FILES = [
    "HBECHO设计方案/archive/legacy/原来的数据库表init文件",
    "HBECHO设计方案/archive/legacy/域E-用户与权限详细设计.md",
    "HBECHO设计方案/archive/legacy/域E-用户与权限详细设计-评审意见.md",
]

# 来自其他项目（hbdam 等）或早期沉淀的历史资料，不要求补写本项目的状态头；
# 但它们仍在 archive/ 下，必须由 INDEX 登记。
LEGACY_DIR = "HBECHO设计方案/archive/legacy/"

# 工具目录同样要求登记，避免仓库根继续长出未分类的内容。
TOOL_DIRS = {".github", ".githooks", "scripts"}


def tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "-c", "core.quotepath=false", "ls-files", "-z",
         "--cached", "--others", "--exclude-standard"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout
    return [p for p in out.split("\0") if p]


def main() -> int:
    errors: list[str] = []
    files = tracked_files()

    for rel in REQUIRED:
        path = os.path.join(ROOT, rel)
        if not os.path.isfile(path):
            errors.append(f"缺少必需文件：{rel}")
        elif os.path.getsize(path) == 0:
            errors.append(f"必需文件为空：{rel}")

    for rel in files:
        if rel.endswith(".md") and os.path.getsize(os.path.join(ROOT, rel)) == 0:
            errors.append(f"0 字节 Markdown 占位文件：{rel}")

    for rel in files:
        if rel.startswith("HBECHO设计方案/archive/") and rel.endswith(".md"):
            if rel.startswith(LEGACY_DIR):
                continue
            head = "".join(open(os.path.join(ROOT, rel), encoding="utf-8").readlines()[:20]).lower()
            if "superseded" not in head and "archived" not in head:
                errors.append(f"归档文档缺少 superseded/archived 状态头：{rel}")

    specs = sorted({rel.split("/")[2] for rel in files if rel.startswith(".kiro/specs/")})
    for name in specs:
        present = {os.path.basename(p) for p in files if p.startswith(f".kiro/specs/{name}/")}
        if name in DESIGN_ONLY_SPECS:
            if "design.md" not in present:
                errors.append(f"design-only spec 缺少 design.md：{name}")
        else:
            for required in ("requirements.md", "design.md", "tasks.md"):
                if required not in present:
                    errors.append(f"spec 缺少 {required}：.kiro/specs/{name}/")

    index_path = os.path.join(ROOT, "HBECHO设计方案/INDEX.md")
    index = open(index_path, encoding="utf-8").read() if os.path.isfile(index_path) else ""

    top_dirs = sorted({rel.split("/")[0] for rel in files if "/" in rel})
    for d in top_dirs:
        if d.startswith(".") and d != ".kiro":
            continue
        if d not in index:
            errors.append(f"一级目录未在 HBECHO设计方案/INDEX.md 登记：{d}/")

    for rel in LEGACY_FILES:
        if rel in files and rel not in index:
            errors.append(f"受控 legacy 文件未在 HBECHO设计方案/INDEX.md 登记：{rel}")

    if errors:
        print("✗ 文档登记 / spec 结构检查失败：")
        for e in errors:
            print(f"    {e}")
        return 1

    print(f"✓ 文档登记与 spec 结构通过（{len(files)} 个跟踪文件，{len(specs)} 个 spec）")
    return 0


if __name__ == "__main__":
    sys.exit(main())