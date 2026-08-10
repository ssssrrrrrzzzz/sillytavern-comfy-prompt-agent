#!/usr/bin/env python3
"""Validate the one-line Anima prompt protocol."""

import argparse
import json
import re
import sys
from dataclasses import asdict

from _types import CheckResult


FORBIDDEN_EXACT = {
    "masterpiece", "best quality", "high quality", "highres", "absurdres",
    "very aesthetic", "newest", "year 2025",
}
def check(prompt: str) -> CheckResult:
    errors: list[str] = []
    if "\n" in prompt or "\r" in prompt:
        errors.append("必须只有一行")
    if "```" in prompt or prompt.lstrip().startswith(("{", "[")):
        errors.append("不能输出 Markdown 或 JSON")
    if "_" in prompt:
        errors.append("标签单词必须使用空格而不是下划线")
    if prompt != prompt.strip():
        errors.append("首尾不能有空白")

    raw_tags = prompt.split(",")
    tags = [tag.strip() for tag in raw_tags]
    if any(not tag for tag in tags):
        errors.append("存在空标签")
    if len(raw_tags) > 1 and ", ".join(tags) != prompt:
        errors.append("标签必须用逗号加一个空格分隔")

    lowered = [tag.lower() for tag in tags]
    forbidden = [tag for tag in tags if tag.lower() in FORBIDDEN_EXACT
                 or re.fullmatch(r"score\s*[1-9](?:\s*up)?", tag.lower())
                 or tag.startswith("@") or tag.lower().startswith("artist:")]
    if forbidden:
        errors.append(f"包含工作流负责的质量词或画师词: {', '.join(forbidden)}")

    bad_case = [tag for tag in tags if tag != "BREAK" and tag != tag.lower()]
    if bad_case:
        errors.append(f"除 BREAK 外必须小写: {', '.join(bad_case)}")

    passed = not errors
    return CheckResult(passed=passed, detail="; ".join(errors) if errors else "格式正确")


def main() -> None:
    parser = argparse.ArgumentParser(description="检查 Anima 一行提示词格式")
    parser.add_argument("prompt", help="prompt 字符串")
    parser.add_argument("--json", action="store_true", help="JSON 输出")
    args = parser.parse_args()
    result = check(args.prompt)
    if args.json:
        print(json.dumps(asdict(result), ensure_ascii=False, indent=2))
    else:
        print(f"{'✓' if result.passed else '✗'} 格式: {result.detail}")
    sys.exit(0 if result.passed else 1)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()
