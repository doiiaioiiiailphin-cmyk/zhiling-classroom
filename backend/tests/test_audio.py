import asyncio
import shutil
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from backend.app.services.audio import AudioArchive, WebmDecoder
from backend.app.services.stream import ClassroomConnection


class AudioTests(unittest.IsolatedAsyncioTestCase):
    async def test_wav_append_recovers_an_uncheckpointed_header(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "recording.wav"
            archive = AudioArchive(path)
            archive.append(b"\x01\x08" * 1600)
            archive.file.close()
            recovered = AudioArchive(path)
            recovered.append(b"\x01\x08" * 1600)
            recovered.close()
            with wave.open(str(path), "rb") as recording:
                self.assertEqual(
                    (recording.getframerate(), recording.getnchannels(), recording.getsampwidth()), (16000, 1, 2),
                )
                self.assertEqual(recording.getnframes(), 3200)

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg is optional for PCM clients")
    async def test_webm_opus_decodes_to_16k_pcm(self):
        encoded = await asyncio.to_thread(subprocess.check_output, [
            "ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i",
            "sine=frequency=440:sample_rate=48000:duration=0.32", "-c:a", "libopus", "-f", "webm", "pipe:1",
        ])
        frames = []

        async def receive(frame):
            frames.append(frame)

        decoder = WebmDecoder(receive)
        await decoder.start()
        try:
            for index in range(0, len(encoded), 650):
                await decoder.send(encoded[index:index + 650])
            await decoder.finish()
        finally:
            await decoder.close()
        pcm = b"".join(frames)
        self.assertGreaterEqual(len(pcm), 10_200)
        self.assertLessEqual(len(pcm), 10_280)
        self.assertTrue(any(pcm))

    async def test_long_silence_drains_asr_and_voice_resumes_with_preroll(self):
        connection = ClassroomConnection(SimpleNamespace(), "session", AsyncMock(), 0, False)
        run = SimpleNamespace(
            options=SimpleNamespace(vad=True), settings=object(), end_ms=400, finish=AsyncMock(),
        )
        next_run = SimpleNamespace()
        connection.recognition = run
        connection.store_pcm = AsyncMock()
        voiced, silent = b"\x00\x08" * 1600, bytes(3200)

        with patch("backend.app.services.stream.SILENCE_PAUSE_MS", 300), patch(
            "backend.app.services.stream.RecognitionRun", return_value=next_run,
        ) as restart:
            await connection.accept_pcm(voiced)
            for _ in range(8):
                await connection.accept_pcm(silent)
            self.assertTrue(connection.auto_paused)
            run.finish.assert_awaited_once()
            self.assertEqual(connection.store_pcm.await_count, 4)
            await connection.accept_pcm(voiced)
            restart.assert_called_once_with(connection, run.settings, 400)
            self.assertFalse(connection.auto_paused)
            self.assertIs(connection.recognition, next_run)
            self.assertEqual(
                [call.args for call in connection.store_pcm.await_args_list[-3:]],
                [(next_run, silent), (next_run, silent), (next_run, voiced)],
            )
