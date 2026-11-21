import asyncio
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
import httpx

from backend.app.errors import AppError
from backend.app.main import create_app
from backend.app.services.updater import (
    AppUpdaterService,
    build_macos_update_script,
    build_windows_update_script,
    select_platform_asset,
)
from backend.app.version import is_newer_version, normalize_version, parse_semver


SAMPLE_CNB_WEB_RELEASE = {
    "id": "2123408892079632384",
    "tag_ref": "refs/tags/v0.2.0",
    "title": "知聆课堂 v0.2.0",
    "body": "- 新增 CNB 全自动热更新\n- 修复 macOS 权限与音频体验",
    "published_at": "2026-11-21T14:00:00Z",
    "is_prerelease": False,
    "is_draft": False,
    "is_latest": True,
    "assets": [
        {
            "name": "ZhilingClassroom-Windows-x86_64.zip",
            "path": "/demo/zhiling-classroom/-/releases/download/v0.2.0/ZhilingClassroom-Windows-x86_64.zip",
            "size_in_byte": 128,
            "hash_algo": "sha256",
            "hash_value": "",
        },
        {
            "name": "ZhilingClassroom-macOS-arm64.dmg",
            "path": "/demo/zhiling-classroom/-/releases/download/v0.2.0/ZhilingClassroom-macOS-arm64.dmg",
            "size_in_byte": 256,
            "hash_algo": "sha256",
            "hash_value": "a" * 64,
        },
        {
            "name": "ZhilingClassroom-macOS-x86_64.dmg",
            "path": "/demo/zhiling-classroom/-/releases/download/v0.2.0/ZhilingClassroom-macOS-x86_64.dmg",
            "size_in_byte": 512,
            "hash_algo": "sha256",
            "hash_value": "b" * 64,
        },
    ],
}


class CnbAutoUpdaterTests(unittest.TestCase):
    def test_semver_parsing_and_comparison(self):
        self.assertEqual(normalize_version("refs/tags/v0.1.2"), "0.1.2")
        self.assertEqual(normalize_version("v1.2.3"), "1.2.3")
        self.assertEqual(parse_semver("v0.2.0"), (0, 2, 0, ()))
        self.assertTrue(is_newer_version("v0.2.0", "0.1.2"))
        self.assertTrue(is_newer_version("0.1.2", "0.1.2-rc.1"))
        self.assertFalse(is_newer_version("0.1.2-beta.1", "0.1.2"))
        self.assertFalse(is_newer_version("v0.1.2", "0.1.2"))
        self.assertFalse(is_newer_version("0.1.1", "0.1.2"))
        self.assertFalse(is_newer_version("invalid", "0.1.2"))

    def test_select_platform_asset_matches_win_and_dual_mac_arch(self):
        assets = SAMPLE_CNB_WEB_RELEASE["assets"]
        win_asset = select_platform_asset(assets, platform_name="win32", arch_name="x86_64")
        self.assertIsNotNone(win_asset)
        assert win_asset is not None
        self.assertEqual(win_asset.name, "ZhilingClassroom-Windows-x86_64.zip")
        self.assertTrue(win_asset.download_url.startswith("https://cnb.cool/demo/zhiling-classroom/"))

        mac_arm = select_platform_asset(assets, platform_name="darwin", arch_name="arm64")
        self.assertIsNotNone(mac_arm)
        assert mac_arm is not None
        self.assertEqual(mac_arm.name, "ZhilingClassroom-macOS-arm64.dmg")
        self.assertEqual(mac_arm.sha256, "a" * 64)

        mac_x64 = select_platform_asset(assets, platform_name="darwin", arch_name="x86_64")
        self.assertIsNotNone(mac_x64)
        assert mac_x64 is not None
        self.assertEqual(mac_x64.name, "ZhilingClassroom-macOS-x86_64.dmg")
        self.assertEqual(mac_x64.sha256, "b" * 64)

    def test_check_download_sha256_verify_and_tamper_rejection(self):
        payload_bytes = b"PK\x03\x04fake-zhiling-zip-payload" * 40
        good_sha = hashlib.sha256(payload_bytes).hexdigest()

        release_ok = json.loads(json.dumps(SAMPLE_CNB_WEB_RELEASE))
        release_ok["assets"][0]["size_in_byte"] = len(payload_bytes)
        release_ok["assets"][0]["hash_value"] = good_sha

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/-/releases/latest"):
                self.assertEqual(request.headers.get("accept"), "application/vnd.cnb.web+json")
                return httpx.Response(200, json=release_ok)
            if request.url.path.endswith("ZhilingClassroom-Windows-x86_64.zip"):
                return httpx.Response(
                    200,
                    content=payload_bytes,
                    headers={"Content-Length": str(len(payload_bytes))},
                )
            return httpx.Response(404)

        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                    svc = AppUpdaterService(
                        Path(tmp),
                        client,
                        cnb_repo="demo/zhiling-classroom",
                        current_version="0.1.2",
                        platform_name="win32",
                        arch_name="x86_64",
                        frozen_override=False,
                    )
                    res = await svc.check_update(force=True)
                    self.assertTrue(res.has_update)
                    self.assertEqual(res.latest_version, "0.2.0")
                    self.assertIsNotNone(res.asset)
                    assert res.asset is not None
                    self.assertEqual(res.asset.sha256, good_sha)

                    events = [evt async for evt in svc.download_update_stream()]
                    stages = [e["stage"] for e in events if e.get("type") == "progress"]
                    self.assertIn("connecting", stages)
                    self.assertIn("downloading", stages)
                    self.assertIn("verifying", stages)
                    self.assertEqual(stages[-1], "ready")
                    done_evt = events[-1]
                    self.assertEqual(done_evt["type"], "done")
                    self.assertEqual(done_evt["data"]["sha256"], good_sha)
                    self.assertTrue(Path(done_evt["data"]["filePath"]).is_file())

                    # Dev mode apply returns dev-manual safely without touching repo
                    apply_res = await svc.apply_staged_update()
                    self.assertFalse(apply_res.scheduled)
                    self.assertEqual(apply_res.mode, "dev-manual")

                # Tampered SHA-256 must be rejected and partial file cleaned up
                release_bad = json.loads(json.dumps(release_ok))
                release_bad["assets"][0]["hash_value"] = "0" * 64

                def bad_handler(request: httpx.Request) -> httpx.Response:
                    if request.url.path.endswith("/-/releases/latest"):
                        return httpx.Response(200, json=release_bad)
                    return httpx.Response(200, content=payload_bytes)

                with tempfile.TemporaryDirectory() as tmp2:
                    async with httpx.AsyncClient(transport=httpx.MockTransport(bad_handler)) as client2:
                        svc2 = AppUpdaterService(
                            Path(tmp2),
                            client2,
                            cnb_repo="demo/zhiling-classroom",
                            current_version="0.1.2",
                            platform_name="win32",
                            arch_name="x86_64",
                            frozen_override=False,
                        )
                        with self.assertRaises(AppError) as ctx:
                            async for _ in svc2.download_update_stream():
                                pass
                        self.assertEqual(ctx.exception.code, "UPDATE_CHECKSUM_MISMATCH")

        asyncio.run(scenario())

    def test_update_helper_scripts_generation_and_quoting(self):
        ps1 = build_windows_update_script(
            old_pid=4321,
            zip_path=Path(r"C:\Users\O'Brien\updates\0.2.0\app.zip"),
            install_dir=Path(r"C:\Apps\Zhiling Classroom"),
            exe_name="ZhilingClassroom.exe",
            log_path=Path(r"C:\Users\O'Brien\logs\updater.log"),
        )
        self.assertIn("$OldPid = 4321", ps1)
        self.assertIn("O''Brien", ps1)
        self.assertIn("ExtractToDirectory", ps1)
        self.assertIn("Rolling back previous version", ps1)

        sh = build_macos_update_script(
            old_pid=9876,
            dmg_path=Path("/Users/test user/Library/Application Support/ZhilingClassroom/updates/0.2.0/app.dmg"),
            target_app=Path("/Applications/ZhilingClassroom.app"),
            log_path=Path("/Users/test user/Library/Application Support/ZhilingClassroom/logs/updater.log"),
        )
        self.assertIn("OLD_PID=9876", sh)
        self.assertIn("hdiutil attach -nobrowse -readonly", sh)
        self.assertIn("ditto", sh)
        self.assertIn("xattr -dr com.apple.quarantine", sh)
        self.assertIn("open -n", sh)

    def test_fastapi_update_routes_contract(self):
        payload_bytes = b"PK\x03\x04route-test-zip" * 20
        good_sha = hashlib.sha256(payload_bytes).hexdigest()
        release_ok = json.loads(json.dumps(SAMPLE_CNB_WEB_RELEASE))
        release_ok["assets"][0]["size_in_byte"] = len(payload_bytes)
        release_ok["assets"][0]["hash_value"] = good_sha
        release_ok["assets"][1]["size_in_byte"] = len(payload_bytes)
        release_ok["assets"][1]["hash_value"] = good_sha
        release_ok["assets"][2]["size_in_byte"] = len(payload_bytes)
        release_ok["assets"][2]["hash_value"] = good_sha

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/-/releases/latest"):
                return httpx.Response(200, json=release_ok)
            return httpx.Response(200, content=payload_bytes, headers={"Content-Length": str(len(payload_bytes))})

        with tempfile.TemporaryDirectory() as tmp:
            app = create_app(
                data_dir=Path(tmp),
                http_transport=httpx.MockTransport(handler),
                enable_os_hotkeys=False,
                serve_dist=False,
            )
            with TestClient(app, base_url="http://localhost") as client:
                client.app.state.updater._cnb_repo_override = "demo/zhiling-classroom"
                client.app.state.updater.current_version = "0.1.2"

                resp = client.get("/api/v1/updates/check?force=true")
                self.assertEqual(resp.status_code, 200)
                data = resp.json()["data"]
                self.assertTrue(data["hasUpdate"])
                self.assertEqual(data["latestVersion"], "0.2.0")

                dl = client.post("/api/v1/updates/download/stream")
                self.assertEqual(dl.status_code, 200)
                frames = [
                    json.loads(line[5:].strip())
                    for line in dl.text.splitlines()
                    if line.startswith("data:")
                ]
                self.assertEqual(frames[-1]["type"], "done")
                self.assertEqual(frames[-1]["data"]["sha256"], good_sha)

                applied = client.post("/api/v1/updates/apply")
                self.assertEqual(applied.status_code, 200)
                self.assertEqual(applied.json()["data"]["mode"], "dev-manual")

    def test_publish_cnb_release_script_three_step_upload(self):
        script_path = Path(__file__).resolve().parents[2] / "scripts" / "publish_cnb_release.py"
        spec = importlib.util.spec_from_file_location("publish_cnb_release", script_path)
        assert spec and spec.loader
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        calls: list[tuple[str, str]] = []

        def fake_json_req(method, url, token, *, payload=None, accept="application/vnd.cnb.api+json", timeout=30.0):
            calls.append((method, url))
            if method == "POST" and url.endswith("/asset-upload-url"):
                return 201, {
                    "upload_url": "https://cos.example.com/presigned-put",
                    "verify_url": "/demo/zhiling/-/releases/rel-1/asset-upload-confirmation/tok123/pkg.zip",
                    "expires_in_sec": 300,
                }
            if method == "POST" and "asset-upload-confirmation" in url:
                return 200, {}
            return 200, {}

        put_calls: list[tuple[str, int]] = []
        with tempfile.TemporaryDirectory() as tmp:
            pkg = Path(tmp) / "ZhilingClassroom-Windows-x86_64.zip"
            pkg.write_bytes(b"hello-cnb-release-asset")
            with (
                patch.object(mod, "_cnb_json_request", side_effect=fake_json_req),
                patch.object(mod, "_stream_put_file", side_effect=lambda u, p, s: put_calls.append((u, s))),
            ):
                res = mod.upload_release_asset("tok", "demo/zhiling", "rel-1", pkg, overwrite=True, ttl_days=0)
                self.assertEqual(res["name"], pkg.name)
                self.assertEqual(res["size"], len(b"hello-cnb-release-asset"))
                self.assertEqual(len(put_calls), 1)
                self.assertEqual(put_calls[0][0], "https://cos.example.com/presigned-put")
                self.assertTrue(any("ttl=0" in url for _, url in calls))

    def test_windows_detached_powershell_launch_actually_executes_script(self):
        import sys
        import time
        import zipfile
        from backend.app.services.updater import (
            _launch_windows_update_script,
            build_windows_update_script,
        )

        if sys.platform != "win32":
            return

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            install_dir = root / "install"
            (install_dir / "_internal").mkdir(parents=True)
            (install_dir / "_internal" / "old.txt").write_text("old-v0.1.2", encoding="utf-8")
            # 用轻量 .cmd 假装可启动可执行体，验证替换后确实拉起新版
            (install_dir / "FakeApp.cmd").write_text("@echo old\r\n", encoding="utf-8")

            marker = root / "restarted.txt"
            zip_path = root / "updates" / "0.1.4" / "ZhilingClassroom-Windows-x86_64.zip"
            zip_path.parent.mkdir(parents=True)
            with zipfile.ZipFile(zip_path, "w") as zf:
                zf.writestr("ZhilingClassroom/_internal/new.txt", "new-v0.1.4")
                zf.writestr("ZhilingClassroom/FakeApp.cmd", f"@echo NEW_OK>\"{marker}\"\r\n")

            staged = root / "updates" / "staged.json"
            staged.write_text('{"version":"0.1.4"}', encoding="utf-8")
            log_path = root / "logs" / "updater.log"
            script_path = zip_path.parent / "apply_update.ps1"
            script_path.write_text(
                build_windows_update_script(
                    old_pid=999999,
                    zip_path=zip_path,
                    install_dir=install_dir,
                    exe_name="FakeApp.cmd",
                    log_path=log_path,
                    version="0.1.4",
                    staged_meta_path=staged,
                ),
                encoding="utf-8-sig",
            )

            proc = _launch_windows_update_script(script_path, require_elevation=False)
            rc = proc.wait(timeout=15)
            self.assertEqual(rc, 0)

            deadline = time.monotonic() + 5.0
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.1)

            self.assertTrue(log_path.is_file(), "updater.log must be written by background PowerShell")
            log_text = log_path.read_text(encoding="utf-8")
            self.assertIn("Update installed successfully", log_text)
            self.assertEqual((install_dir / "_internal" / "new.txt").read_text(encoding="utf-8"), "new-v0.1.4")
            self.assertFalse((install_dir / "_internal" / "old.txt").exists())
            self.assertTrue(marker.is_file(), "Replaced executable must be relaunched")
            self.assertFalse(staged.exists(), "staged.json must be cleaned up after success")
            self.assertFalse(zip_path.exists(), "zip archive must be cleaned up after success")


if __name__ == "__main__":
    unittest.main()
