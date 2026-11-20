import asyncio
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

from backend.app.errors import AppError
from backend.app.providers.platform_hooks import (
    platform_arch_tag,
    resolve_opencode_platform_spec,
    resolve_opus_library_path,
)
from backend.app.services.attachments import capture_macos_desktop_png, encode_rgb_to_png
from backend.app.services.mac_audio import (
    MacAudioBackend,
    find_mac_audio_helper,
    parse_helper_devices_json,
)
from backend.app.services.win_desktop import (
    MAC_CMD_KEY,
    MAC_OPTION_KEY,
    MAC_SHIFT_KEY,
    parse_macos_hotkey_combo,
)


class MacOSPortTests(unittest.TestCase):
    def test_platform_hooks_resolution(self):
        self.assertEqual(platform_arch_tag(plat="win32", machine="AMD64"), "win-amd64")
        self.assertEqual(platform_arch_tag(plat="darwin", machine="arm64"), "macosx-arm64")
        self.assertEqual(platform_arch_tag(plat="darwin", machine="x86_64"), "macosx-x86_64")

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dylib = root / "assets" / "opus" / "macosx-arm64" / "libopus.dylib"
            dylib.parent.mkdir(parents=True)
            dylib.write_bytes(b"fake-dylib")

            spec = resolve_opus_library_path(plat="darwin", machine="arm64", repo_root=root)
            self.assertEqual(spec.platform_tag, "macosx-arm64")
            self.assertEqual(spec.opus_library_name, "libopus.dylib")
            self.assertEqual(spec.resolved_opus_file, dylib)

            oc_arm = resolve_opencode_platform_spec(root / "oc", "2.3.2", plat="darwin", machine="arm64")
            self.assertEqual(oc_arm.npm_package_hint, "@opencode/cli-darwin-arm64")
            self.assertEqual(oc_arm.managed_binary_path, root / "oc" / "2.3.2-darwin-arm64" / "opencode")

            oc_x64 = resolve_opencode_platform_spec(root / "oc", "2.3.2", plat="darwin", machine="x86_64")
            self.assertEqual(oc_x64.npm_package_hint, "@opencode/cli-darwin-x64-baseline")
            self.assertEqual(oc_x64.managed_binary_path, root / "oc" / "2.3.2-darwin-x64" / "opencode")

    def test_macos_hotkey_combo_parser(self):
        self.assertEqual(
            parse_macos_hotkey_combo("Alt+Shift+R"),
            (MAC_OPTION_KEY | MAC_SHIFT_KEY, 0x0F),
        )
        self.assertEqual(
            parse_macos_hotkey_combo("Cmd+Shift+S"),
            (MAC_CMD_KEY | MAC_SHIFT_KEY, 0x01),
        )
        self.assertIsNone(parse_macos_hotkey_combo("R"))
        self.assertIsNone(parse_macos_hotkey_combo(""))

    def test_mac_audio_backend_device_parsing_and_fallback(self):
        sample = json.dumps({
            "platform": "darwin",
            "wasapiSupported": True,
            "inputs": [{"id": "mic-1", "rawId": "mic-1", "name": "MacBook Pro 麦克风", "isDefault": True, "isCommunicationsDefault": True}],
            "loopbacks": [{"id": "out-1", "rawId": "out-1", "name": "MacBook Pro 扬声器", "isDefault": True, "isCommunicationsDefault": True}],
        }).encode("utf-8")
        parsed = parse_helper_devices_json(sample)
        self.assertEqual(parsed.platform, "darwin")
        self.assertTrue(parsed.wasapi_supported)
        self.assertEqual(parsed.inputs[0].name, "MacBook Pro 麦克风")
        self.assertEqual(parsed.loopbacks[0].name, "MacBook Pro 扬声器")

        # Missing helper gracefully falls back to wasapi_supported=False
        backend_missing = MacAudioBackend(helper_path=None)
        with patch("backend.app.services.mac_audio.find_mac_audio_helper", return_value=None):
            res = asyncio.run(backend_missing.list_devices())
            self.assertFalse(res.wasapi_supported)
            self.assertEqual(res.platform, "darwin")

    def test_macos_app_bundle_resource_lookup(self):
        import sys
        import backend.desktop_shell as desktop_shell

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            exe = root / "ZhilingClassroom.app" / "Contents" / "MacOS" / "ZhilingClassroom"
            exe.parent.mkdir(parents=True)
            exe.write_bytes(b"bin")
            helper = root / "ZhilingClassroom.app" / "Contents" / "Resources" / "bin" / "ZhilingAudioCapture"
            helper.parent.mkdir(parents=True)
            helper.write_bytes(b"helper")
            dist_index = root / "ZhilingClassroom.app" / "Contents" / "Resources" / "dist" / "index.html"
            dist_index.parent.mkdir(parents=True)
            dist_index.write_text("<html></html>", encoding="utf-8")

            with (
                patch.object(sys, "frozen", True, create=True),
                patch.object(sys, "executable", str(exe)),
                patch.object(sys, "_MEIPASS", str(root / "ZhilingClassroom.app" / "Contents" / "Frameworks"), create=True),
            ):
                self.assertEqual(find_mac_audio_helper(repo_root=root), helper.resolve())
                dist_dir, _, _ = desktop_shell._resolve_runtime_paths(root / "home")
                self.assertEqual(dist_dir, dist_index.parent.resolve())

    def test_capture_macos_desktop_png_success_and_permission_error(self):
        sample_png = encode_rgb_to_png(b"\x10\x20\x30" * (4 * 3), 4, 3)

        class FakeCompleted:
            def __init__(self, rc: int, stderr: bytes = b""):
                self.returncode = rc
                self.stderr = stderr

        def fake_run_ok(cmd, **_kwargs):
            Path(cmd[-1]).write_bytes(sample_png)
            return FakeCompleted(0)

        with patch("backend.app.services.attachments.subprocess.run", side_effect=fake_run_ok):
            data, w, h = capture_macos_desktop_png()
            self.assertEqual((w, h), (4, 3))
            self.assertEqual(data, sample_png)

        with patch(
            "backend.app.services.attachments.subprocess.run",
            return_value=FakeCompleted(1, b"could not create image from display"),
        ):
            with self.assertRaises(AppError) as ctx:
                capture_macos_desktop_png()
            self.assertEqual(ctx.exception.code, "MACOS_SCREEN_PERMISSION_REQUIRED")

    def test_icns_icon_generator_produces_valid_apple_container(self):
        import importlib.util

        script = Path(__file__).resolve().parents[2] / "scripts" / "generate_icon.py"
        spec = importlib.util.spec_from_file_location("generate_icon", script)
        assert spec and spec.loader
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        # Verify container header & PNG chunk structure using small synthetic render
        with patch.object(mod, "render_icon_rgba", side_effect=lambda s: b"\x14\x56\xf0\xff" * (s * s)):
            icns = mod.build_icns()
        self.assertEqual(icns[:4], b"icns")
        total_len = struct.unpack(">I", icns[4:8])[0]
        self.assertEqual(total_len, len(icns))
        self.assertIn(b"ic07", icns)
        self.assertIn(b"ic10", icns)


if __name__ == "__main__":
    unittest.main()
