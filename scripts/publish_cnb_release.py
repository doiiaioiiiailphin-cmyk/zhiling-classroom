#!/usr/bin/env python3
"""知聆课堂 CNB（cnb.cool）仓库初始化与 Release 附件一键发布脚本（零第三方依赖）。

用法示例：
  1. 在 CNB 组织下创建公开仓库（需环境变量 CNB_TOKEN）：
     python scripts/publish_cnb_release.py --init-repo --repo-name zhiling-classroom [--group <group_slug>]

  2. 创建/复用 CNB Release 并上传 Windows ZIP 与 macOS 双架构 DMG（永久保留 ttl=0）：
     python scripts/publish_cnb_release.py --repo <org>/zhiling-classroom --tag v0.1.2 \\
       --title "知聆课堂 v0.1.2" --notes "新增 CNB 自动更新与 macOS 全面适配" \\
       release/ZhilingClassroom-Windows-x86_64.zip \\
       release/ZhilingClassroom-macOS-arm64.dmg \\
       release/ZhilingClassroom-macOS-x86_64.dmg
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request

CNB_API_BASE = "https://api.cnb.cool"
CNB_WEB_BASE = "https://cnb.cool"
LOCAL_CRED_PATH = Path.home() / ".config" / "zhiling-classroom" / "cnb_credentials.json"


def _load_local_credentials() -> dict:
    if not LOCAL_CRED_PATH.is_file():
        return {}
    try:
        data = json.loads(LOCAL_CRED_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_local_repo(repo_slug: str) -> None:
    try:
        data = _load_local_credentials()
        data["repo"] = repo_slug
        LOCAL_CRED_PATH.parent.mkdir(parents=True, exist_ok=True)
        LOCAL_CRED_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass


class CnbApiError(RuntimeError):
    def __init__(self, status: int, body: str, url: str):
        super().__init__(f"CNB API HTTP {status} on {url}: {body[:400]}")
        self.status = status
        self.body = body
        self.url = url


def _cnb_json_request(
    method: str,
    url: str,
    token: str,
    *,
    payload: dict | None = None,
    accept: str = "application/vnd.cnb.api+json",
    timeout: float = 30.0,
) -> tuple[int, dict | list | None]:
    headers = {
        "Accept": accept,
        "User-Agent": "zhiling-classroom-publisher/1.0",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data: bytes | None = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace").strip()
            return resp.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")
        raise CnbApiError(exc.code, err_body, url) from exc


def _stream_put_file(upload_url: str, file_path: Path, size: int) -> None:
    """流式分块 PUT 上传大文件到 CNB 预签名对象存储地址，避免一次性读入内存。"""
    parsed = urllib.parse.urlsplit(upload_url)
    if parsed.scheme != "https":
        raise RuntimeError(f"Refusing non-HTTPS upload_url: {upload_url}")

    port = parsed.port or 443
    path_and_query = parsed.path + (f"?{parsed.query}" if parsed.query else "")
    conn = http.client.HTTPSConnection(parsed.hostname, port, timeout=600)
    try:
        conn.putrequest("PUT", path_and_query)
        conn.putheader("Content-Type", "application/octet-stream")
        conn.putheader("Content-Length", str(size))
        conn.endheaders()

        sent = 0
        chunk_size = 512 * 1024
        with file_path.open("rb") as fh:
            while True:
                buf = fh.read(chunk_size)
                if not buf:
                    break
                conn.send(buf)
                sent += len(buf)
                pct = int(round(sent * 100 / max(1, size)))
                print(f"\r  -> 上传 {file_path.name}: {pct}% ({sent / 1048576:.1f} / {size / 1048576:.1f} MB)", end="", flush=True)
        print()

        resp = conn.getresponse()
        resp_body = resp.read().decode("utf-8", errors="replace")
        if resp.status not in (200, 201, 204):
            raise CnbApiError(resp.status, resp_body, upload_url)
    finally:
        conn.close()


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            buf = fh.read(512 * 1024)
            if not buf:
                break
            h.update(buf)
    return h.hexdigest().lower()


def init_cnb_repo(
    token: str,
    repo_name: str,
    *,
    group_slug: str = "",
    description: str = "知聆课堂跨平台桌面端安装包与自动更新发布仓库",
    visibility: str = "public",
) -> str:
    target_group = group_slug.strip().strip("/")
    if not target_group:
        _, groups = _cnb_json_request("GET", f"{CNB_API_BASE}/user/groups?page=1&page_size=20", token)
        if not isinstance(groups, list) or not groups:
            raise RuntimeError("当前 CNB 账号下未找到可用组织（Group），请先在 cnb.cool 创建一个组织并通过 --group 指定")
        first = groups[0]
        target_group = str(first.get("path") or first.get("name") or "").strip("/")
        if not target_group:
            raise RuntimeError(f"无法从 CNB 组织响应解析路径：{first}")
        print(f"[CNB] 自动选择首个组织：{target_group}")

    repo_slug = f"{target_group}/{repo_name.strip('/')}"
    try:
        status, _ = _cnb_json_request(
            "POST",
            f"{CNB_API_BASE}/{target_group}/-/repos",
            token,
            payload={
                "name": repo_name.strip("/"),
                "description": description,
                "visibility": visibility,
            },
        )
        print(f"[CNB] 创建公开仓库成功（HTTP {status}）：{CNB_WEB_BASE}/{repo_slug}")
    except CnbApiError as exc:
        if exc.status == 409 or "already exist" in exc.body.lower() or "已存在" in exc.body:
            print(f"[CNB] 仓库已存在，直接复用：{CNB_WEB_BASE}/{repo_slug}")
        else:
            raise
    return repo_slug


def ensure_release(
    token: str,
    repo: str,
    tag: str,
    *,
    title: str,
    body: str,
    target_commitish: str = "main",
    prerelease: bool = False,
    draft: bool = False,
) -> dict:
    encoded_tag = urllib.parse.quote(tag, safe="")
    try:
        _, existing = _cnb_json_request(
            "GET",
            f"{CNB_API_BASE}/{repo}/-/releases/tags/{encoded_tag}",
            token,
        )
        if isinstance(existing, dict) and existing.get("id"):
            print(f"[CNB] 复用已有 Release：{tag} (id={existing['id']})")
            return existing
    except CnbApiError as exc:
        if exc.status != 404:
            raise

    _, created = _cnb_json_request(
        "POST",
        f"{CNB_API_BASE}/{repo}/-/releases",
        token,
        payload={
            "tag_name": tag,
            "target_commitish": target_commitish,
            "name": title or tag,
            "body": body,
            "draft": draft,
            "prerelease": prerelease,
            "make_latest": "false" if (draft or prerelease) else "true",
        },
    )
    if not isinstance(created, dict) or not created.get("id"):
        raise RuntimeError(f"创建 Release 返回异常：{created}")
    print(f"[CNB] 已创建 Release：{tag} (id={created['id']})")
    return created


def upload_release_asset(
    token: str,
    repo: str,
    release_id: str,
    file_path: Path,
    *,
    overwrite: bool = True,
    ttl_days: int = 0,
) -> dict:
    if not file_path.is_file():
        raise FileNotFoundError(f"待上传文件不存在：{file_path}")
    size = file_path.stat().st_size
    local_sha = _sha256_file(file_path)
    print(f"[CNB] 准备上传附件：{file_path.name} ({size / 1048576:.2f} MB, sha256={local_sha[:16]}...)")

    # 1. 申请预签名上传 URL
    _, upload_info = _cnb_json_request(
        "POST",
        f"{CNB_API_BASE}/{repo}/-/releases/{release_id}/asset-upload-url",
        token,
        payload={
            "asset_name": file_path.name,
            "size": size,
            "overwrite": overwrite,
            "ttl": ttl_days,
        },
    )
    if not isinstance(upload_info, dict) or not upload_info.get("upload_url") or not upload_info.get("verify_url"):
        raise RuntimeError(f"获取 CNB 上传预签名 URL 失败：{upload_info}")

    upload_url = str(upload_info["upload_url"])
    verify_url = str(upload_info["verify_url"])
    if verify_url.startswith("/"):
        verify_url = f"{CNB_API_BASE}{verify_url}"

    # 2. 流式 PUT 上传文件主体到对象存储
    _stream_put_file(upload_url, file_path, size)

    # 3. 确认上传并标记保留时长（ttl=0 永久保留）
    sep = "&" if "?" in verify_url else "?"
    confirm_url = f"{verify_url}{sep}ttl={ttl_days}"
    status, _ = _cnb_json_request("POST", confirm_url, token)
    print(f"[CNB] 附件确认生效（HTTP {status}）：{file_path.name}")
    return {"name": file_path.name, "size": size, "sha256": local_sha}


def verify_public_latest_release(repo: str, expected_tag: str, expected_names: list[str]) -> dict:
    """使用匿名公开 web+json 接口端到端校验普通客户端能否无 Token 检测到新版本与附件。"""
    url = f"{CNB_WEB_BASE}/{repo}/-/releases/latest"
    _, payload = _cnb_json_request("GET", url, token="", accept="application/vnd.cnb.web+json")
    if not isinstance(payload, dict):
        raise RuntimeError(f"公开更新检查返回异常：{payload}")
    tag_ref = str(payload.get("tag_ref") or "")
    assets = payload.get("assets") if isinstance(payload.get("assets"), list) else []
    found_names = {str(a.get("name") or "") for a in assets if isinstance(a, dict)}
    missing = [name for name in expected_names if name not in found_names]
    print(f"[CNB 公开校验] tag_ref={tag_ref}, 附件数={len(assets)}, 命中={sorted(found_names)}")
    if expected_tag and not tag_ref.endswith(expected_tag):
        print(f"[CNB 公开校验警告] 最新标签 {tag_ref} 与预期 {expected_tag} 不一致")
    if missing:
        raise RuntimeError(f"公开 Release 缺少以下预期附件：{missing}")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="CNB 仓库初始化与 Release 附件发布工具")
    parser.add_argument("--token", default="", help="CNB 访问令牌（默认读取环境变量 CNB_TOKEN）")
    parser.add_argument("--init-repo", action="store_true", help="创建公开 CNB 仓库模式")
    parser.add_argument("--group", default="", help="目标 CNB 组织路径（留空则自动选用首个可用组织）")
    parser.add_argument("--repo-name", default="zhiling-classroom", help="--init-repo 时创建的仓库名称")
    parser.add_argument("--repo", default=os.getenv("CNB_REPO", ""), help="目标仓库完整路径，例如 org/zhiling-classroom")
    parser.add_argument("--tag", default="", help="发布标签，例如 v0.1.2")
    parser.add_argument("--title", default="", help="Release 标题")
    parser.add_argument("--notes", default="", help="Release 更新说明文本")
    parser.add_argument("--notes-file", default="", help="从文件读取 Release 更新说明")
    parser.add_argument("--commitish", default="main", help="Tag 目标分支或提交哈希")
    parser.add_argument("--prerelease", action="store_true", help="标记为预发布版")
    parser.add_argument("--draft", action="store_true", help="标记为草稿")
    parser.add_argument("--verify-public", action="store_true", help="上传后校验匿名公开 web+json 接口")
    parser.add_argument("files", nargs="*", help="待上传的安装包文件路径列表")
    args = parser.parse_args()

    creds = _load_local_credentials()
    token = (args.token or os.getenv("CNB_TOKEN") or str(creds.get("token") or "")).strip()
    if not token:
        print("错误：缺少 CNB 访问令牌，请先设置环境变量 CNB_TOKEN、传入 --token 或保存到 ~/.config/zhiling-classroom/cnb_credentials.json。", file=sys.stderr)
        return 2

    if args.init_repo:
        slug = init_cnb_repo(token, args.repo_name, group_slug=args.group)
        _save_local_repo(slug)
        print(f"CNB_REPO={slug}")
        return 0

    repo = (args.repo or str(creds.get("repo") or "")).strip().strip("/")
    if not repo or "/" not in repo:
        print("错误：请通过 --repo 或环境变量 CNB_REPO 指定完整仓库路径（格式：组织名/仓库名）。", file=sys.stderr)
        return 2
    if not args.tag.strip():
        print("错误：请通过 --tag 指定发布版本号（如 v0.1.2）。", file=sys.stderr)
        return 2

    notes = args.notes
    if args.notes_file:
        notes = Path(args.notes_file).read_text(encoding="utf-8")

    rel = ensure_release(
        token,
        repo,
        args.tag.strip(),
        title=args.title.strip() or f"知聆课堂 {args.tag.strip()}",
        body=notes,
        target_commitish=args.commitish.strip() or "main",
        prerelease=args.prerelease,
        draft=args.draft,
    )
    release_id = str(rel["id"])

    uploaded_names: list[str] = []
    for raw_file in args.files:
        fp = Path(raw_file).resolve()
        upload_release_asset(token, repo, release_id, fp, overwrite=True, ttl_days=0)
        uploaded_names.append(fp.name)

    if args.verify_public and not args.draft and not args.prerelease:
        verify_public_latest_release(repo, args.tag.strip(), uploaded_names)

    print(f"[CNB] 全部发布完成：{CNB_WEB_BASE}/{repo}/-/releases/tag/{args.tag.strip()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
