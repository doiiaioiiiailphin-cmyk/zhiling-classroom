"""Exercise both desktop add-ons with real downloads in an isolated directory."""

import argparse
import ctypes
import ctypes.util
import json
import os
import sys
from multiprocessing import get_context
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.main import create_app
from app.providers.platform_hooks import resolve_opus_library_path

ASR = "/api/v1/addons/builtin-free-asr"
OPENCODE = "/api/v1/addons/opencode/download/stream"


def start_opencode(client: TestClient) -> list[dict]:
    response = client.post(OPENCODE, json={"confirmed": True})
    assert response.is_success, response.text
    events = [json.loads(line.removeprefix("data:")) for line in response.text.splitlines() if line.startswith("data:")]
    assert events and events[-1] == {"type": "done", "data": True}, events[-1:]
    progress = [event for event in events if event["type"] == "progress"]
    assert [event["stage"] for event in progress[-2:]] == ["starting", "ready"], progress[-2:]
    for event in progress:
        if event["stage"] == "downloading":
            assert event["percent"] == event["downloadedBytes"] * 100 // event["totalBytes"], event
    bridge = client.app.state.opencode
    info = client.portal.call(bridge.native, "/api/info")
    assert info.get("pid") == bridge.process.pid, info
    return progress


def verify(bundle: Path, root: Path, reuse: bool) -> None:
    if sys.platform == "darwin":
        contents = bundle.resolve() / "Contents"
        sys._MEIPASS = str(contents / "Frameworks")
        library = resolve_opus_library_path().resolved_opus_file
        assert library and library.resolve().is_relative_to(contents), f"Opus is missing from {bundle}"
        assert (contents / "Resources" / "licenses" / "opus" / "COPYING").is_file(), "Missing Opus COPYING"
    elif sys.platform != "win32":
        raise SystemExit("Run this check on macOS or Windows x64.")
    os.environ.pop("ZHILING_OPENCODE_EXECUTABLE", None)

    asr_root, cli_root = root / "asr", root / "opencode"
    application = create_app(root / "data", builtin_asr_dir=asr_root, opencode_cli_dir=cli_root)
    with TestClient(application, base_url="http://localhost") as client:
        bridge = application.state.opencode
        executable = bridge.managed_executable
        assert executable, "This platform has no managed OpenCode release"
        if reuse:
            mark, = asr_root.glob("*/site-*/.ready")
            asr_mtime = mark.stat().st_mtime_ns
            cli_mtime = executable.stat().st_mtime_ns
            assert client.get(ASR).json()["data"] is True
            stages = start_opencode(client)
            assert [event["stage"] for event in stages] == ["starting", "ready"]
            assert all(event["totalBytes"] == 0 for event in stages)
            assert mark.stat().st_mtime_ns == asr_mtime
            assert executable.stat().st_mtime_ns == cli_mtime
            print("A new backend process reused both add-on caches", flush=True)
            return

        assert client.get(ASR).json()["data"] is False, "Use a clean venv without an existing ASR SDK"
        for path in (ASR + "/download", OPENCODE):
            response = client.post(path, json={"confirmed": False})
            assert response.status_code == 400, response.text
        assert not asr_root.exists() and not cli_root.exists()

        response = client.post(ASR + "/download", json={"confirmed": True})
        assert response.status_code == 204, response.text
        assert client.get(ASR).json()["data"] is True
        library = ctypes.util.find_library("opus")
        assert library, "Could not resolve Opus after SDK install"
        opus = ctypes.CDLL(library)
        opus.opus_get_version_string.restype = ctypes.c_char_p

        from doubaoime_asr import ASRConfig
        from doubaoime_asr.audio import AudioEncoder

        encoder = AudioEncoder(ASRConfig(sample_rate=16_000, channels=1))
        assert encoder.pcm_to_opus_frames(bytes(640)), "Opus did not produce an encoded frame"
        print(f"ASR SDK installed and a PCM frame encoded with {opus.opus_get_version_string().decode()}", flush=True)

        progress = start_opencode(client)
        downloaded = progress[-1]["downloadedBytes"]
        assert downloaded == bridge.cli_artifact.archive_bytes
        print(f"OpenCode authenticated server started after downloading {downloaded} bytes", flush=True)


if __name__ == "__main__":
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("--bundle", type=Path, default=ROOT / "release" / "ZhilingClassroom.app")
    bundle = args.parse_args().bundle
    with TemporaryDirectory(prefix="zhiling-addon-check-") as temporary:
        # A new interpreter proves each cache loads from disk and releases Windows DLLs before cleanup.
        for reuse in (False, True):
            process = get_context("spawn").Process(target=verify, args=(bundle, Path(temporary), reuse))
            process.start()
            process.join()
            if process.exitcode:
                raise SystemExit(process.exitcode)
