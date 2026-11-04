#!/usr/bin/env python3
"""检查所有已跟踪 Markdown 文件里的相对链接是否可达。

范围：只检查仓库内相对路径；http(s)、mailto、tel、纯锚点跳过。
说明见 HBECHO设计方案/INDEX.md §9.6 与 HBECHO设计方案/runbooks/dev-test-deploy-workflow.md §4。
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from urllib.parse import unquote

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LINK_RE = re.compile(r"\]\(([^)]+)\)")
SKIP_PREFIX = ("http://", "https://", "mailto:", "tel:", "data:", "#")


def tracked_markdown() -> list[str]:
    out = subprocess.run(
        ["git", "-c", "core.quotepath=false", "ls-files", "-z",
         "--cached", "--others", "--exclude-standard"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout
    return [p for p in out.split("\0") if p.endswith(".md")]


def parse_target(raw: str) -> str | None:
    raw = raw.strip()
    if raw.startswith("<"):
        end = raw.find(">")
        return raw[1:end] if end != -1 else raw[1:]
    # 去掉可选的 title：`path "title"`
    return raw.split()[0] if raw else None


def strip_fenced_blocks(text: str) -> str:
    lines, in_fence = [], False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            lines.append("")
            continue
        lines.append("" if in_fence else line)
    return "\n".join(lines)


def main() -> int:
    broken: list[tuple[str, int, str]] = []
    for rel in tracked_markdown():
        path = os.path.join(ROOT, rel)
        try:
            text = open(path, encoding="utf-8").read()
        except UnicodeDecodeError:
            continue
        for lineno, line in enumerate(strip_fenced_blocks(text).splitlines(), 1):
            for raw in LINK_RE.findall(line):
                target = parse_target(raw)
                if not target or target.startswith(SKIP_PREFIX):
                    continue
                target = unquote(target.split("#", 1)[0].split("?", 1)[0])
                if not target:
                    continue
                if target.startswith("/"):
                    resolved = os.path.join(ROOT, target.lstrip("/"))
                else:
                    resolved = os.path.normpath(os.path.join(os.path.dirname(path), target))
                if not os.path.exists(resolved):
                    broken.append((rel, lineno, target))

    if broken:
        print("✗ 发现断开的相对链接：")
        for rel, lineno, target in broken:
            print(f"    {rel}:{lineno} -> {target}")
        return 1

    print(f"✓ Markdown 相对链接通过（{len(tracked_markdown())} 个文件）")
    return 0


if __name__ == "__main__":
    sys.exit(main())