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
    DesktopEventBus,
    MAC_CMD_KEY,
    MAC_CONTROL_KEY,
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
            parse_macos_hotkey_combo("Option+Shift+M"),
            (MAC_OPTION_KEY | MAC_SHIFT_KEY, 0x2E),
        )
        self.assertEqual(
            parse_macos_hotkey_combo("⌥⇧R"),
            (MAC_OPTION_KEY | MAC_SHIFT_KEY, 0x0F),
        )
        self.assertEqual(
            parse_macos_hotkey_combo("⌘⇧S"),
            (MAC_CMD_KEY | MAC_SHIFT_KEY, 0x01),
        )
        self.assertEqual(
            parse_macos_hotkey_combo("⌃⌥O"),
            (MAC_CONTROL_KEY | MAC_OPTION_KEY, 0x1F),
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
            "inputs": [{"id": "macos-in:BuiltInMic", "rawId": "BuiltInMic", "name": "MacBook Pro 麦克风", "isDefault": True, "isCommunicationsDefault": True}],
            "loopbacks": [{"id": "macos-loop:BuiltInSpk", "rawId": "BuiltInSpk", "name": "MacBook Pro 扬声器", "isDefault": True, "isCommunicationsDefault": True}],
        }).encode("utf-8")
        parsed = parse_helper_devices_json(sample)
        self.assertEqual(parsed.platform, "darwin")
        self.assertTrue(parsed.wasapi_supported)
        self.assertEqual(parsed.inputs[0].id, "macos-in:BuiltInMic")
        self.assertEqual(parsed.inputs[0].name, "MacBook Pro 麦克风")
        self.assertEqual(parsed.loopbacks[0].id, "macos-loop:BuiltInSpk")
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

    def test_wss_ssl_context_loads_ca_bundle(self):
        from backend.app.providers.asr.base import _wss_ssl_context

        ctx = _wss_ssl_context()
        stats = ctx.cert_store_stats()
        self.assertGreater(stats.get("x509_ca", 0), 0)

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

    def test_desktop_event_bus_overlay_relay(self):
        from fastapi import WebSocketDisconnect

        class FakeWebSocket:
            def __init__(self, incoming: list[str]):
                self._incoming = list(incoming)
                self.sent: list[dict] = []
                self.accepted = False
                self._done = asyncio.Event()

            async def accept(self):
                self.accepted = True

            async def send_json(self, payload: dict):
                self.sent.append(payload)

            async def receive(self) -> dict:
                if self._incoming:
                    return {"type": "websocket.receive", "text": self._incoming.pop(0)}
                await self._done.wait()
                return {"type": "websocket.disconnect"}

            def close_rx(self):
                self._done.set()

        async def scenario():
            bus = DesktopEventBus()
            ws_main = FakeWebSocket([
                json.dumps({"type": "overlay.snapshot", "payload": {"sessionTitle": "高等数学", "isRecording": True}}),
            ])
            ws_mini = FakeWebSocket([])

            t_mini = asyncio.create_task(bus.serve(ws_mini))
            await asyncio.sleep(0.01)
            t_main = asyncio.create_task(bus.serve(ws_main))
            await asyncio.sleep(0.05)

            # Mini should receive main's snapshot
            self.assertTrue(any(m.get("type") == "overlay.snapshot" and m["payload"]["sessionTitle"] == "高等数学" for m in ws_mini.sent))
            # Main should NOT receive echo of its own snapshot
            self.assertFalse(any(m.get("type") == "overlay.snapshot" for m in ws_main.sent))

            # Newly connected client receives cached latest snapshot immediately
            ws_late = FakeWebSocket([
                json.dumps({"type": "overlay.command", "payload": {"type": "toggle-recording", "cmdId": "c1"}}),
            ])
            t_late = asyncio.create_task(bus.serve(ws_late))
            await asyncio.sleep(0.05)

            self.assertTrue(any(m.get("type") == "overlay.snapshot" and m["payload"]["sessionTitle"] == "高等数学" for m in ws_late.sent))
            self.assertTrue(any(m.get("type") == "overlay.command" and m["payload"]["cmdId"] == "c1" for m in ws_main.sent))
            self.assertFalse(any(m.get("type") == "overlay.command" for m in ws_late.sent))

            ws_main.close_rx()
            ws_mini.close_rx()
            ws_late.close_rx()
            await asyncio.gather(t_main, t_mini, t_late)

        asyncio.run(scenario())

    def test_local_sensevoice_adapter_non_blocking_under_slow_cpu(self):
        import time
        from backend.app.providers.asr.base import Recognition
        from backend.app.providers.asr.builtin_shell import BuiltinFreeAsrAdapter

        class SlowFakeRuntime:
            def require(self):
                pass

            def get_recognizer(self, language: str):
                return object()

            def decode_pcm(self, pcm: bytes, language: str) -> str:
                time.sleep(0.18)
                return f"decoded-{len(pcm)}"

        async def scenario():
            adapter = BuiltinFreeAsrAdapter(
                Recognition(language="zh", diarization=False, speaker_mode="auto", vad=True),
                runtime=SlowFakeRuntime(),
            )
            await adapter.start()
            voiced_chunk = struct.pack("<h", 4500) * 320  # 20ms @ 16kHz loud tone
            silent_chunk = b"\x00\x00" * 320

            t0 = time.monotonic()
            for _ in range(45):  # 900ms speech
                await adapter.send_audio(voiced_chunk)
            for _ in range(40):  # 800ms silence -> triggers endpoint final enqueue
                await adapter.send_audio(silent_chunk)
            send_elapsed = time.monotonic() - t0
            # send_audio must NEVER block on the 180ms decode_pcm call
            self.assertLess(send_elapsed, 0.12)

            await adapter.finish()
            items = [item async for item in adapter.results()]
            self.assertTrue(any(item.final and item.text.startswith("decoded-") for item in items))
            self.assertEqual(adapter._final_jobs.maxlen, 24)
            await adapter.close()

        asyncio.run(scenario())

    def test_pcm16le_to_floats_precision_and_zero_list_bloat(self):
        from backend.app.services.builtin_asr import pcm16le_to_floats

        raw = struct.pack("<4h", -32768, -16384, 0, 32767)
        samples = pcm16le_to_floats(raw)
        self.assertEqual(len(samples), 4)
        self.assertAlmostEqual(float(samples[0]), -1.0, places=4)
        self.assertAlmostEqual(float(samples[1]), -0.5, places=4)
        self.assertAlmostEqual(float(samples[2]), 0.0, places=5)
        self.assertAlmostEqual(float(samples[3]), 32767 / 32768.0, places=4)

    def test_mac_audio_stderr_drain_prevents_pipe_deadlock(self):
        import sys

        script = (
            "import sys\n"
            "sys.stderr.buffer.write(b'WARN_LINE\\n' * 12000)\n"
            "sys.stderr.buffer.flush()\n"
            "sys.stdout.buffer.write(b'\\x01\\x00' * 1600)\n"
            "sys.stdout.buffer.flush()\n"
        )

        class FakeLoopbackWS:
            def __init__(self):
                self.frames: list[bytes] = []
                self.json_msgs: list[dict] = []
                self.closed = False
                self._done = asyncio.Event()

            async def accept(self):
                pass

            async def send_bytes(self, data: bytes):
                self.frames.append(data)

            async def send_json(self, payload: dict):
                self.json_msgs.append(payload)

            async def receive(self) -> dict:
                await self._done.wait()
                return {"type": "websocket.disconnect"}

            async def close(self, code: int = 1000):
                self.closed = True
                self._done.set()

        with tempfile.TemporaryDirectory() as tmp:
            fake_helper = Path(tmp) / "fake_helper.py"
            fake_helper.write_text(script, encoding="utf-8")

            async def scenario():
                backend = MacAudioBackend(helper_path=fake_helper)
                orig_exec = asyncio.create_subprocess_exec

                async def _wrapped_exec(exe, *args, **kwargs):
                    return await orig_exec(sys.executable, str(fake_helper), **kwargs)

                ws = FakeLoopbackWS()
                with patch("backend.app.services.mac_audio.asyncio.create_subprocess_exec", side_effect=_wrapped_exec):
                    await backend.serve_loopback(ws, "default")
                self.assertEqual(sum(len(f) for f in ws.frames), 3200)
                self.assertEqual(ws.json_msgs, [])
                self.assertTrue(ws.closed)

            asyncio.run(asyncio.wait_for(scenario(), timeout=8.0))


if __name__ == "__main__":
    unittest.main()
