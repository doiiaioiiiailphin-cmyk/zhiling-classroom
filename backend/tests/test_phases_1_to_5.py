import base64
import io
import json
from pathlib import Path
import tempfile
import unittest
import wave
import zipfile

import httpx
from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.providers.llm import AnthropicMessages, GeminiContent, ImageInput, OpenAIChat, Turn
from backend.app.schemas import LLMModelsRequest, Regrouping, Term
from backend.app.services.attachments import encode_rgb_to_png, parse_image_dimensions
from backend.app.services.win_desktop import MOD_ALT, MOD_NOREPEAT, MOD_SHIFT, parse_hotkey_combo


def make_test_wav(duration_ms: int = 2400, sample_rate: int = 16000) -> bytes:
    frames_count = sample_rate * duration_ms // 1000
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setparams((1, 2, sample_rate, 0, "NONE", "not compressed"))
        # Non-silent PCM pattern so VAD detects speech cleanly
        pattern = (b"\x20\x08\xe0\xf7" * (frames_count // 2 + 1))[: frames_count * 2]
        wf.writeframes(pattern)
    return buf.getvalue()


class Phases1To5BackendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def make_client(self, transport=None, screen_capturer=None):
        app = create_app(
            self.root,
            http_transport=transport,
            enable_os_hotkeys=False,
            screen_capturer=screen_capturer,
        )
        return TestClient(app, base_url="http://localhost")

    def test_phase1_study_notes_flashcards_and_exports(self):
        def upstream(request: httpx.Request):
            body = json.loads(request.content)
            if body.get("stream"):
                sse = (
                    'data: {"choices":[{"delta":{"reasoning_content":"梳理动态规划状态转移结构。"}}]}\n\n'
                    'data: {"choices":[{"delta":{"content":"## 一、课程核心导览\\n本节推导背包状态转移 `$dp[i][j]$`。\\n\\n```cpp\\ndp[j] = max(dp[j], dp[j-w] + v);\\n```"}}]}\n\n'
                    'data: [DONE]\n\n'
                )
                return httpx.Response(200, content=sse.encode("utf-8"), headers={"content-type": "text/event-stream"})
            cards = {
                "cards": [
                    {
                        "front": "0-1 背包一维滚动数组为何逆序枚举容量？",
                        "back": "防止同一件物品在当前层被重复选取，保证引用上一层状态 `$dp[i-1][j-w]$`。",
                        "tag": "动态规划",
                    }
                ]
            }
            return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(cards, ensure_ascii=False)}}]})

        with self.make_client(httpx.MockTransport(upstream)) as client:
            repo = client.app.state.repo
            settings = client.get("/api/v1/settings").json()["data"]
            settings["llmProviders"]["openai"]["apiKey"] = "p1-key"
            settings["featureRouting"]["chat"].update(providerId="openai", modelId="gpt-4.1")
            settings["featureRouting"]["bubbleExplanation"].update(providerId="openai", modelId="gpt-4.1")
            self.assertEqual(client.put("/api/v1/settings", json=settings).status_code, 200)

            sid = client.post("/api/v1/sessions", json={"folderId": None}).json()["data"]["session"]["id"]
            client.patch(f"/api/v1/sessions/{sid}", json={"title": "信竞：动态规划背包精讲", "durationSeconds": 1800})
            u1, _ = client.portal.call(
                repo.save_final, sid, "phys:sys", "今天讲 0-1 背包滚动数组一维空间优化与逆序循环。", 0, 5000,
            )
            seg_id = u1.segment_id
            client.portal.call(
                repo.save_highlights, seg_id, [Term(term="滚动数组", explanation="复用一维数组压缩状态空间的技巧。")],
            )

            # 1) Stream full-class study note
            note_res = client.post(f"/api/v1/sessions/{sid}/notes/stream")
            self.assertEqual(note_res.status_code, 200)
            self.assertIn("课程核心导览", note_res.text)

            # 2) Generate flashcards
            fc_res = client.post(f"/api/v1/sessions/{sid}/flashcards")
            self.assertEqual(fc_res.status_code, 200)
            cards = fc_res.json()["data"]
            self.assertEqual(len(cards), 1)
            self.assertEqual(cards[0]["tag"], "动态规划")

            # 3) Verify workspace persists studyNote and flashcards
            ws = client.get(f"/api/v1/sessions/{sid}/workspace").json()["data"]
            self.assertIn("dp[i][j]", ws["studyNote"]["contentMarkdown"])
            self.assertEqual(len(ws["flashcards"]), 1)

            # 4) Export Markdown, DOCX, TXT, Anki TSV
            md_res = client.post(f"/api/v1/sessions/{sid}/export", json={"format": "markdown"})
            self.assertEqual(md_res.status_code, 200)
            self.assertIn("滚动数组", md_res.text)
            self.assertIn("全课精编笔记", md_res.text)

            docx_res = client.post(f"/api/v1/sessions/{sid}/export", json={"format": "docx"})
            self.assertEqual(docx_res.status_code, 200)
            with zipfile.ZipFile(io.BytesIO(docx_res.content), "r") as zf:
                names = set(zf.namelist())
                self.assertIn("word/document.xml", names)
                doc_xml = zf.read("word/document.xml").decode("utf-8")
                self.assertIn("信竞：动态规划背包精讲", doc_xml)
                self.assertIn("滚动数组", doc_xml)

            txt_res = client.post(f"/api/v1/sessions/{sid}/export", json={"format": "txt"})
            self.assertEqual(txt_res.status_code, 200)
            self.assertIn("【一、全课精编笔记】", txt_res.text)

            anki_res = client.post(f"/api/v1/sessions/{sid}/export", json={"format": "anki"})
            self.assertEqual(anki_res.status_code, 200)
            self.assertIn("#deck:知聆课堂::信竞：动态规划背包精讲", anki_res.text)
            self.assertIn("逆序枚举容量", anki_res.text)

    def test_phase2_audio_range_playback_and_wav_resampling(self):
        with self.make_client() as client:
            sid = client.post("/api/v1/sessions", json={"folderId": None}).json()["data"]["session"]["id"]
            # Write 2.4s WAV archive via AudioStorage
            wav_path = client.app.state.audio.path(sid)
            wav_data = make_test_wav(2400, 16000)
            wav_path.write_bytes(wav_data)
            client.portal.call(client.app.state.repo.checkpoint, sid, 2400, "paused", str(wav_path))

            ws = client.get(f"/api/v1/sessions/{sid}/workspace").json()["data"]
            self.assertTrue(ws["hasAudio"])
            self.assertGreaterEqual(ws["audioDurationMs"], 2300)

            full_res = client.get(f"/api/v1/sessions/{sid}/audio")
            self.assertEqual(full_res.status_code, 200)
            self.assertEqual(full_res.headers.get("accept-ranges"), "bytes")
            self.assertEqual(full_res.content[:4], b"RIFF")

            part_res = client.get(f"/api/v1/sessions/{sid}/audio", headers={"Range": "bytes=0-127"})
            self.assertEqual(part_res.status_code, 206)
            self.assertEqual(len(part_res.content), 128)
            self.assertTrue(part_res.headers["content-range"].startswith("bytes 0-127/"))

    def test_phase3_manual_edit_protection_bookmarks_hotwords_and_dual_speaker(self):
        with self.make_client() as client:
            repo = client.app.state.repo
            folder = client.post(
                "/api/v1/folders",
                json={"name": "算法竞赛", "parentId": None, "hotwords": ["Tarjan", "线段树懒标记"]},
            ).json()["data"]
            self.assertEqual(folder["hotwords"], ["Tarjan", "线段树懒标记"])

            patched_folder = client.patch(
                f"/api/v1/folders/{folder['id']}",
                json={"hotwords": ["Tarjan", "树状数组", "斜率优化"]},
            ).json()["data"]
            self.assertEqual(patched_folder["hotwords"], ["Tarjan", "树状数组", "斜率优化"])

            sid = client.post("/api/v1/sessions", json={"folderId": folder["id"]}).json()["data"]["session"]["id"]
            merged = client.portal.call(repo.folder_hotwords_for_session, sid)
            self.assertEqual(merged, ["Tarjan", "树状数组", "斜率优化"])

            # Dual-channel speaker default labels
            f_mic, _ = client.portal.call(repo.save_final, sid, "phys:mic", "老师，斜率优化的单调队列怎么维护凸包？", 1000, 3000)
            f_sys, _ = client.portal.call(repo.save_final, sid, "phys:sys", "我们把状态点放到二维平面上看截距最小化。", 3100, 6200)
            self.assertEqual(f_mic.utterance.speaker_label, "我（麦克风）")
            self.assertEqual(f_sys.utterance.speaker_label, "课堂老师（内录）")

            # Manual text edit + bookmark + user_note
            uid = f_sys.utterance.id
            updated = client.patch(
                f"/api/v1/sessions/{sid}/utterances/{uid}",
                json={
                    "refinedText": "将决策点映射到二维平面，利用下凸壳维护截距最小化。",
                    "isBookmarked": True,
                    "bookmarkKind": "confused",
                    "userNote": "下凸壳斜率单调性课后再推一遍",
                },
            ).json()["data"]
            self.assertTrue(updated["isManualEdited"])
            self.assertTrue(updated["isBookmarked"])
            self.assertEqual(updated["bookmarkKind"], "confused")
            self.assertEqual(updated["userNote"], "下凸壳斜率单调性课后再推一遍")

            # Ensure late async LLM correction NEVER overwrites user's manual edit
            client.portal.call(repo.save_correction, uid, "被异步模型覆盖的错误句子")
            ws = client.get(f"/api/v1/sessions/{sid}/workspace").json()["data"]
            saved_utt = [u for u in ws["segments"][0]["utterances"] if u["id"] == uid][0]
            self.assertEqual(saved_utt["refinedText"], "将决策点映射到二维平面，利用下凸壳维护截距最小化。")

            # One-click bookmark_now marks latest utterance
            bm_now = client.post(
                f"/api/v1/sessions/{sid}/bookmarks/now",
                json={"kind": "confused", "note": "此处推导太快"},
            ).json()["data"]
            self.assertEqual(bm_now["utterance"]["id"], uid)
            self.assertEqual(bm_now["utterance"]["userNote"], "此处推导太快")

    def test_phase4_attachments_screen_capture_multimodal_llm_and_global_search(self):
        fake_png = encode_rgb_to_png(b"\x14\x56\xf0" * (4 * 3), 4, 3)
        self.assertEqual(parse_image_dimensions(fake_png, "image/png"), (4, 3))

        captured_bodies: list[dict] = []

        def upstream(request: httpx.Request):
            body = json.loads(request.content)
            captured_bodies.append(body)
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": "根据截图 `[01:20]`，状态转移正确。"}}]},
            )

        with self.make_client(
            httpx.MockTransport(upstream),
            screen_capturer=lambda: (fake_png, 4, 3),
        ) as client:
            repo = client.app.state.repo
            settings = client.get("/api/v1/settings").json()["data"]
            settings["llmProviders"]["openai"]["apiKey"] = "mm-key"
            settings["featureRouting"]["chat"].update(providerId="openai", modelId="gpt-4.1")
            client.put("/api/v1/settings", json=settings)

            sid = client.post("/api/v1/sessions", json={"folderId": None}).json()["data"]["session"]["id"]
            client.patch(f"/api/v1/sessions/{sid}", json={"title": "图论：强连通分量"})
            client.portal.call(repo.save_final, sid, "phys:sys", "Tarjan 算法通过 dfn 与 low 数组判定强连通分量。", 80000, 86000)

            # 1) Native screen capture endpoint
            cap = client.post(
                f"/api/v1/sessions/{sid}/capture-screen",
                json={"timestampMs": 82000, "caption": "板书 dfn/low 示意"},
            )
            self.assertEqual(cap.status_code, 201)
            cap_item = cap.json()["data"]
            self.assertEqual((cap_item["width"], cap_item["height"]), (4, 3))
            self.assertEqual(cap_item["timestampText"], "01:22")

            raw_img = client.get(cap_item["url"])
            self.assertEqual(raw_img.status_code, 200)
            self.assertEqual(raw_img.content, fake_png)

            # 2) Courseware markdown upload
            mat = client.post(
                f"/api/v1/sessions/{sid}/attachments?fileName=lecture_notes.md&mimeType=text/markdown",
                content="# 讲义补充\n缩点后得到有向无环图（DAG）。".encode("utf-8"),
                headers={"Content-Type": "text/markdown"},
            )
            self.assertEqual(mat.status_code, 201)
            self.assertEqual(mat.json()["data"]["kind"], "material")

            # 3) Multimodal chat with image attachment + courseware context
            chat_res = client.post(
                f"/api/v1/sessions/{sid}/chat",
                json={"content": "请结合截图和讲义解释缩点", "attachmentIds": [cap_item["id"]]},
            )
            self.assertEqual(chat_res.status_code, 200)
            sent_messages = captured_bodies[-1]["messages"]
            self.assertIn("有向无环图", sent_messages[0]["content"])
            user_content = sent_messages[-1]["content"]
            self.assertIsInstance(user_content, list)
            self.assertEqual(user_content[1]["type"], "image_url")
            self.assertTrue(user_content[1]["image_url"]["url"].startswith("data:image/png;base64,"))

            # 4) Verify Anthropic & Gemini multimodal encoders as well
            img_in = (ImageInput("image/png", base64.b64encode(fake_png).decode("ascii")),)
            turn = Turn("user", "解释图例", images=img_in)
            anth_msg = AnthropicMessages._encode_anthropic_turn(turn)
            self.assertEqual(anth_msg["content"][0]["type"], "image")
            gem_adapter = GeminiContent(
                httpx.AsyncClient(),
                LLMModelsRequest(providerId="gemini", protocol="gemini", baseUrl="https://generativelanguage.googleapis.com", apiKey="k"),
            )
            gem_body = gem_adapter._build_gemini_body("sys", [turn], None, None, 1024)
            self.assertIn("inlineData", gem_body["contents"][0]["parts"][1])

            # 5) Cross-session global search
            hits = client.get("/api/v1/search?q=dfn").json()["data"]
            self.assertGreaterEqual(len(hits), 1)
            self.assertEqual(hits[0]["sessionId"], sid)
            self.assertEqual(hits[0]["kind"], "utterance")
            self.assertEqual(hits[0]["timestampText"], "01:20")

    def test_phase5_hotkey_parser_and_desktop_events_websocket(self):
        self.assertEqual(parse_hotkey_combo("Alt+Shift+S"), (MOD_NOREPEAT | MOD_ALT | MOD_SHIFT, ord("S")))
        self.assertIsNone(parse_hotkey_combo("S"))  # Reject bare key without modifier

        with self.make_client() as client:
            with client.websocket_connect("ws://localhost/ws/v1/desktop/events") as ws:
                ready = ws.receive_json()
                self.assertEqual(ready["type"], "desktop.ready")
                client.portal.call(client.app.state.desktop.broadcast_action, "bookmarkConfused")
                evt = ws.receive_json()
                self.assertEqual(evt, {"type": "hotkey.triggered", "payload": {"action": "bookmarkConfused"}})

    def test_phase6_builtin_free_asr_provider_contract(self):
        import asyncio
        from backend.app.providers.asr import build_adapter
        from backend.app.providers.asr.base import Recognition
        from backend.app.providers.asr.builtin_shell import BuiltinFreeAsrAdapter
        from backend.app.schemas import ASRProvider

        with self.make_client() as client:
            settings = client.get("/api/v1/settings").json()["data"]
            self.assertEqual(settings["selectedAsrProviderId"], "builtin-free-asr")
            provider = ASRProvider.model_validate(settings["asrProviders"]["builtin-free-asr"])
            models = client.post(
                "/api/v1/asr-providers/models",
                json={
                    "providerId": "builtin-free-asr",
                    "protocol": "builtin-free-asr",
                    "baseUrl": "builtin://default",
                    "apiKey": "",
                },
            ).json()["data"]
            self.assertEqual(models, ["default"])

        async def check_provider():
            async with httpx.AsyncClient() as http:
                adapter = build_adapter(http, provider, Recognition("zh-en", False, "auto", True))
                self.assertIsInstance(adapter, BuiltinFreeAsrAdapter)
                await adapter.close()
                self.assertEqual([result async for result in adapter.results()], [])

        asyncio.run(check_provider())

    def test_phase6_opencode_download_stream_and_diarization_suppression(self):
        import asyncio
        from unittest.mock import AsyncMock, patch
        from backend.app.providers.asr.base import ASRStreamAdapter

        with self.make_client() as client:
            bridge = client.app.state.opencode

            async def fake_install(http_client, target, artifact, *, on_progress=None):
                if on_progress is not None:
                    total = artifact.archive_bytes
                    await on_progress("connecting", 0, total, 0)
                    await on_progress("downloading", (total + 1) // 2, total, 50)
                    await on_progress("verifying", total, total, 100)

            with (
                patch.object(bridge, "needs_download", return_value=True),
                patch.object(bridge, "start", new=AsyncMock()),
                patch("backend.app.providers.opencode_bridge.install_cli", new=fake_install),
            ):
                path = "/api/v1/addons/opencode/download/stream"
                self.assertEqual(client.post(path).status_code, 400)
                self.assertEqual(client.post(path, json={"confirmed": False}).status_code, 400)
                bridge.start.assert_not_awaited()
                resp = client.post(path, json={"confirmed": True})
                self.assertEqual(resp.status_code, 200)
                frames = [
                    json.loads(line[5:].strip())
                    for line in resp.text.splitlines()
                    if line.startswith("data:")
                ]
                stages = [f["stage"] for f in frames if f.get("type") == "progress"]
                self.assertEqual(stages, ["connecting", "downloading", "verifying", "starting", "ready"])
                self.assertEqual(frames[-1], {"type": "done", "data": True})
                self.assertTrue(bridge.automatic_download_decision.is_set())

            # Verify builtin-free-asr does not spam ASR_DIARIZATION_UNAVAILABLE on recording start
            class SilentSingleChannelAdapter(ASRStreamAdapter):
                supports_diarization = False

                def __init__(self):
                    self.finished = asyncio.Event()

                async def start(self):
                    pass

                async def send_audio(self, pcm: bytes):
                    pass

                async def finish(self):
                    self.finished.set()

                async def results(self):
                    await self.finished.wait()
                    if False:
                        yield None

                async def close(self):
                    pass

            async def receive(socket):
                async with asyncio.timeout(5):
                    message = await socket._send_rx.receive()
                return json.loads(message["text"])

            settings = client.get("/api/v1/settings").json()["data"]
            settings["enableSpeakerDiarization"] = True
            settings["enableDualChannelSpeakerSplit"] = False
            self.assertEqual(client.put("/api/v1/settings", json=settings).status_code, 200)
            sid = client.post("/api/v1/sessions", json={}).json()["data"]["session"]["id"]
            with (
                patch.object(client.app.state.builtin_asr, "ready", return_value=True),
                patch("backend.app.services.stream.build_adapter", return_value=SilentSingleChannelAdapter()),
            ):
                with client.websocket_connect(f"ws://localhost/ws/v1/sessions/{sid}/stream") as ws:
                    ws.send_json({
                        "type": "recording.start",
                        "payload": {"sampleRate": 16000, "channels": 1, "encoding": "pcm_s16le"},
                    })
                    started = ws.portal.call(receive, ws)
                    self.assertEqual(started["type"], "session.duration", started)
                    ws.send_bytes(b"\x00" * 3200)
                    ws.send_json({"type": "recording.stop"})
                    stopped = ws.portal.call(receive, ws)
                    self.assertEqual(stopped["type"], "session.duration", stopped)
                    workspace = client.get(f"/api/v1/sessions/{sid}/workspace").json()["data"]
                    self.assertEqual(workspace["session"]["status"], "paused")


if __name__ == "__main__":
    unittest.main()
