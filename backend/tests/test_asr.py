import asyncio
import base64
import gzip
import json
import struct
import unittest
from urllib.parse import parse_qs, urlsplit

import httpx
from websockets.legacy.server import serve

from backend.app.errors import AppError
from backend.app.providers.asr import list_asr_models
from backend.app.providers.asr.base import Recognition
from backend.app.providers.asr.china import volc_event, volc_frame
from backend.app.providers.asr.openai import OpenAIDiarized, OpenAIRealtime
from backend.app.providers.asr.streaming import DashScope, Deepgram
from backend.app.schemas import ASRModelsRequest

VOICE = b"\x00\x08" * 1600
CONFIG = Recognition("zh-en", True, "dual", True)


class ASRAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def exchange(self, provider, create, frames):
        async with serve(provider, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            adapter = create(f"ws://127.0.0.1:{port}")
            try:
                async with asyncio.timeout(5):
                    await adapter.start()
                    for frame in frames:
                        await adapter.send_audio(frame)
                    await adapter.finish()
                    return [result async for result in adapter.results()]
            finally:
                await adapter.close()

    async def test_dashscope_task_lifecycle_and_timestamps(self):
        async def provider(socket):
            self.assertEqual(socket.request_headers["Authorization"], "Bearer test-key")
            run = json.loads(await socket.recv())
            header = run["header"]
            self.assertEqual(header["action"], "run-task")
            self.assertEqual(run["payload"]["parameters"]["format"], "pcm")
            self.assertEqual(run["payload"]["parameters"]["language_hints"], ["zh", "en"])
            await socket.send(json.dumps({"header": {"event": "task-started"}}))
            self.assertEqual(await socket.recv(), VOICE)
            for final, text in [(False, "逐"), (True, "逐句识别")]:
                await socket.send(json.dumps({
                    "header": {"event": "result-generated"},
                    "payload": {"output": {"sentence": {
                        "text": text, "sentence_end": final, "begin_time": 5, "end_time": 95, "speaker_id": 0,
                    }}},
                }))
            finish = json.loads(await socket.recv())
            self.assertEqual(finish["header"]["action"], "finish-task")
            self.assertEqual(finish["header"]["task_id"], header["task_id"])
            await socket.send(json.dumps({"header": {"event": "task-finished"}}))

        results = await self.exchange(
            provider, lambda url: DashScope(url, "test-key", "paraformer-realtime-v2", CONFIG), [VOICE],
        )
        self.assertEqual([result.final for result in results], [False, True])
        self.assertEqual((results[1].speaker, results[1].start_ms, results[1].end_ms), ("0", 5, 95))

    async def test_deepgram_merges_interims_and_splits_speakers(self):
        async def provider(socket):
            self.assertEqual(socket.request_headers["Authorization"], "Token test-key")
            query = parse_qs(urlsplit(socket.path).query)
            self.assertEqual(query["sample_rate"], ["16000"])
            self.assertEqual(query["language"], ["multi"])
            self.assertEqual(query["diarize_model"], ["latest"])
            self.assertEqual(await socket.recv(), VOICE)
            frames = [
                (False, False, "Linear", [{"word": "Linear", "speaker": 0, "start": 0.01, "end": 0.02}]),
                (True, True, "Linear algebra. 请继续", [
                    {"punctuated_word": "Linear", "speaker": 0, "start": 0.01, "end": 0.02},
                    {"punctuated_word": "algebra.", "speaker": 0, "start": 0.02, "end": 0.04},
                    {"punctuated_word": "请继续", "speaker": 1, "start": 0.05, "end": 0.09},
                ]),
            ]
            for final, speech_final, text, words in frames:
                await socket.send(json.dumps({
                    "type": "Results", "is_final": final, "speech_final": speech_final,
                    "start": 0, "duration": 0.1, "channel": {"alternatives": [{"transcript": text, "words": words}]},
                }))
            self.assertEqual(json.loads(await socket.recv()), {"type": "CloseStream"})
            await socket.send('{"type":"Metadata"}')

        results = await self.exchange(
            provider, lambda url: Deepgram(url, "test-key", "nova-3-general", CONFIG), [VOICE],
        )
        self.assertEqual([(result.text, result.final, result.speaker) for result in results], [
            ("Linear", False, "0"), ("Linear algebra.", True, "0"), ("请继续", True, "1"),
        ])
        self.assertEqual((results[-1].start_ms, results[-1].end_ms), (50, 90))

    async def test_openai_realtime_uses_24k_pcm_and_orders_completion(self):
        packets = []

        async def provider(socket):
            self.assertEqual(socket.request_headers["Authorization"], "Bearer test-key")
            self.assertEqual(parse_qs(urlsplit(socket.path).query)["intent"], ["transcription"])
            config = json.loads(await socket.recv())
            self.assertEqual(config["type"], "session.update")
            audio = config["session"]["audio"]["input"]
            self.assertEqual(audio["format"], {"type": "audio/pcm", "rate": 24000})
            self.assertEqual(audio["transcription"]["model"], "gpt-4o-transcribe")
            await socket.send('{"type":"session.updated"}')
            order = 0
            async for frame in socket:
                event = json.loads(frame)
                if event["type"] == "input_audio_buffer.append":
                    packets.append(base64.b64decode(event["audio"]))
                if event["type"] == "input_audio_buffer.commit":
                    order += 1
                    await socket.send(json.dumps({"type": "input_audio_buffer.committed", "item_id": f"turn{order}"}))
                    if order == 2:
                        await socket.send(json.dumps({
                            "type": "conversation.item.input_audio_transcription.delta", "item_id": "turn1", "delta": "线",
                        }))
                        for number, text in [(2, "第二句"), (1, "线性代数")]:
                            await socket.send(json.dumps({
                                "type": "conversation.item.input_audio_transcription.completed",
                                "item_id": f"turn{number}", "transcript": text,
                            }))

        silent = bytes(3200)
        results = await self.exchange(
            provider,
            lambda url: OpenAIRealtime(url + "/v1", "test-key", "gpt-4o-transcribe", CONFIG),
            [VOICE, *([silent] * 7), VOICE, *([silent] * 7)],
        )
        self.assertEqual(len(packets), 16)
        self.assertTrue(all(4796 <= len(chunk) <= 4802 for chunk in packets))
        self.assertEqual([(result.text, result.final, result.start_ms) for result in results], [
            ("线", False, None), ("线性代数", True, 0), ("第二句", True, 800),
        ])

    async def test_openai_diarized_real_sse_shape(self):
        async def handler(request: httpx.Request):
            self.assertEqual(request.url.path, "/v1/audio/transcriptions")
            body = await request.aread()
            self.assertIn(b"diarized_json", body)
            self.assertIn(b"gpt-4o-transcribe-diarize", body)
            self.assertIn(b"RIFF", body)
            rows = [
                {"type": "transcript.text.delta", "segment_id": "a", "delta": "线"},
                {"type": "transcript.text.segment", "id": "a", "text": "线性", "speaker": "A", "start": 0.01, "end": 0.05},
                {"type": "transcript.text.segment", "id": "b", "text": "代数", "speaker": "B", "start": 0.05, "end": 0.09},
                {"type": "transcript.text.done", "text": "线性代数"},
            ]
            return httpx.Response(200, content="".join(f"data: {json.dumps(row)}\n\n" for row in rows).encode())

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            adapter = OpenAIDiarized(http, "https://openai.test/v1", "test-key", CONFIG)
            await adapter.start()
            await adapter.send_audio(VOICE)
            await adapter.finish()
            results = [result async for result in adapter.results()]
            self.assertEqual([item.final for item in results], [False, True, True])
            self.assertNotEqual(results[1].speaker, results[2].speaker)
            self.assertEqual((results[1].start_ms, results[2].end_ms), (10, 90))

    def test_volcengine_binary_serialization(self):
        pcm_frame = volc_frame(2, 2, 0, VOICE)
        self.assertEqual(pcm_frame[:4], bytes((0x11, 0x22, 0x01, 0)))
        self.assertEqual(gzip.decompress(pcm_frame[8:]), VOICE)
        payload = gzip.compress(b'{"result":{"text":"speech"}}')
        incoming = bytes((0x11, 0x93, 0x11, 0)) + struct.pack(">iI", -1, len(payload)) + payload
        self.assertEqual(volc_event(incoming), ({"result": {"text": "speech"}}, True))

    async def test_model_catalog_uses_live_response_and_discards_tts_and_batch_models(self):
        def provider(request):
            self.assertEqual(request.url.path, "/v1/models")
            self.assertEqual(request.headers["xi-api-key"], "catalog-test-key")
            return httpx.Response(200, json=[
                {"model_id": "scribe_v9_live"},
                {"model_id": "scribe_v10_realtime"},
                {"model_id": "scribe_v8"},
                {"model_id": "eleven_tts"},
            ])

        async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as http:
            config = ASRModelsRequest(
                provider_id="elevenlabs", protocol="elevenlabs-scribe",
                base_url="https://models.test/v1", api_key="catalog-test-key",
            )
            self.assertEqual(await list_asr_models(http, config), ["scribe_v9_live", "scribe_v10_realtime"])

    async def test_streaming_only_vendor_requires_key_and_returns_handshake_verified_models(self):
        requested = []

        async def provider(socket):
            if socket.request_headers.get("Authorization") != "test-key":
                await socket.send('{"type":"Error","code":401,"error":"unauthorized"}')
                await socket.close()
                return
            query = parse_qs(urlsplit(socket.path).query)
            model = query["speech_model"][0]
            requested.append(model)
            if model == "whisper-rt":
                await socket.send('{"type":"Begin","id":"catalog-test"}')
            else:
                await socket.send('{"type":"Error","code":400,"error":"not enabled"}')
            await socket.wait_closed()

        async with serve(provider, "127.0.0.1", 0) as server, httpx.AsyncClient() as http:
            port = server.sockets[0].getsockname()[1]
            empty_key = ASRModelsRequest(
                provider_id="assemblyai", protocol="assemblyai", base_url=f"ws://127.0.0.1:{port}/v3/ws",
                api_key="",
            )
            with self.assertRaises(AppError) as missing:
                await list_asr_models(http, empty_key)
            self.assertEqual(missing.exception.code, "PROVIDER_NOT_CONFIGURED")
            self.assertEqual(requested, [])

            bad_key = ASRModelsRequest(
                provider_id="assemblyai", protocol="assemblyai", base_url=f"ws://127.0.0.1:{port}/v3/ws",
                api_key="wrong-key",
            )
            with self.assertRaises(AppError) as rejected:
                await list_asr_models(http, bad_key)
            self.assertEqual(rejected.exception.code, "PROVIDER_AUTH_FAILED")

            valid = ASRModelsRequest(
                provider_id="assemblyai", protocol="assemblyai", base_url=f"ws://127.0.0.1:{port}/v3/ws",
                api_key="test-key",
            )
            self.assertEqual(await list_asr_models(http, valid), ["whisper-rt"])
            self.assertEqual(set(requested), {"whisper-rt", "u3-rt-pro"})
