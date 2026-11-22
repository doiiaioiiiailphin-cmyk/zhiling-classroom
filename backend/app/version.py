"""应用版本号与 CNB 更新源单一事实来源。"""
from __future__ import annotations

import os
import re

APP_VERSION = "0.1.7"
DEFAULT_CNB_REPO = "dolphin114/zhiling-classroom"
CNB_WEB_BASE = "https://cnb.cool"
CNB_API_BASE = "https://api.cnb.cool"

_SEMVER_RE = re.compile(
    r"^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$"
)


def get_cnb_repo(override: str | None = None) -> str:
    raw = override if override is not None else os.getenv("ZHILING_CNB_REPO", "")
    repo = raw.strip().strip("/")
    if repo.endswith(".git"):
        repo = repo[:-4]
    if repo:
        return repo
    return DEFAULT_CNB_REPO.strip().strip("/")


def get_cnb_token(override: str | None = None) -> str:
    raw = override if override is not None else os.getenv("ZHILING_CNB_TOKEN", "")
    return raw.strip()


def normalize_version(tag: str) -> str:
    text = (tag or "").strip()
    if text.startswith("refs/tags/"):
        text = text[len("refs/tags/"):]
    if text.lower().startswith("v") and len(text) > 1 and text[1].isdigit():
        text = text[1:]
    return text


def parse_semver(tag: str) -> tuple[int, int, int, tuple[str, ...]] | None:
    cleaned = normalize_version(tag)
    match = _SEMVER_RE.match(cleaned)
    if not match:
        return None
    major, minor, patch = int(match.group(1)), int(match.group(2)), int(match.group(3))
    pre = tuple(match.group(4).split(".")) if match.group(4) else ()
    return (major, minor, patch, pre)


def _compare_prerelease(a: tuple[str, ...], b: tuple[str, ...]) -> int:
    if not a and not b:
        return 0
    if not a:
        return 1  # 正式版 > 预发布版
    if not b:
        return -1
    for left, right in zip(a, b):
        if left == right:
            continue
        left_num = left.isdigit()
        right_num = right.isdigit()
        if left_num and right_num:
            return 1 if int(left) > int(right) else -1
        if left_num != right_num:
            return -1 if left_num else 1
        return 1 if left > right else -1
    if len(a) == len(b):
        return 0
    return 1 if len(a) > len(b) else -1


def is_newer_version(latest: str, current: str) -> bool:
    parsed_latest = parse_semver(latest)
    parsed_current = parse_semver(current)
    if parsed_latest is None or parsed_current is None:
        return False
    if parsed_latest[:3] != parsed_current[:3]:
        return parsed_latest[:3] > parsed_current[:3]
    return _compare_prerelease(parsed_latest[3], parsed_current[3]) > 0
