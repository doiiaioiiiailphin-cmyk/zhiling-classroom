import asyncio
import json
import sqlite3
import tempfile
import unittest
import wave
from contextlib import closing
from pathlib import Path

import anyio
import httpx
from fastapi.testclient import TestClient
from websockets.legacy.server import serve

from backend.app.main import create_app
from backend.app.schemas import AppSettings, Regrouping, Term

DETAIL = {
    "title": "注意力机制",
    "corePoints": ["权重来自查询和键之间的相关程度。"],
    "elaboration": "课堂先用查询向量和键向量的点积衡量相关性，再除以键向量维度的平方根来缩放分数。"
    "缩放后的分数经归一化得到注意力权重，最后对各个值向量做加权求和。这样可以聚合上下文信息。"
    "在解释实际模型时还要关注掩码规则，因为掩码决定当前查询可以使用哪些位置的信息。",
}
GLOSS = "它衡量当前查询向量与各个键向量之间的相关程度，并以归一化权重分配上下文信息。"
START = {"type": "recording.start", "payload": {"sampleRate": 16000, "channels": 1, "encoding": "pcm_s16le"}}


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def client(self, transport=None):
        return TestClient(create_app(self.root, http_transport=transport), base_url="http://localhost")

    @staticmethod
    def create_session(client, folder_id=None):
        response = client.post("/api/v1/sessions", json={"folderId": folder_id})
        assert response.status_code == 201, response.text
        return response.json()["data"]["session"]["id"]

    def test_folder_crud_and_session_workspace_contract(self):
        with self.client() as client:
            self.assertEqual(client.get("/api/v1/sessions").json(), {"data": []})
            root = client.post("/api/v1/folders", json={"name": " 核心课 ", "parentId": None}).json()["data"]
            self.assertEqual(root["name"], "核心课")
            self.assertIsNone(root["parentId"])
            child = client.post("/api/v1/folders", json={"name": "子文件夹", "parentId": root["id"]}).json()["data"]
            self.assertEqual(len(client.get("/api/v1/folders").json()["data"]), 2)
            self.assertEqual(client.patch(f"/api/v1/folders/{root['id']}", json={"name": "专业课"}).status_code, 200)
            sid = self.create_session(client, root["id"])
            route = f"/api/v1/sessions/{sid}"
            result = client.patch(route, json={
                "title": "线性代数", "status": "paused", "durationSeconds": 71, "folderId": child["id"],
            }).json()["data"]
            self.assertEqual(result["title"], "线性代数")
            self.assertEqual(result["speakerCount"], 0)
            self.assertEqual(result["segmentCount"], 0)
            self.assertTrue(result["createdAt"].endswith("Z"))
            self.assertEqual(result["folderId"], child["id"])
            self.assertEqual(client.patch(route, json={"durationSeconds": 50}).json()["data"]["durationSeconds"], 71)
            response = client.delete(f"/api/v1/folders/{root['id']}")
            self.assertEqual((response.status_code, response.content), (204, b""))
            self.assertIsNone(client.get("/api/v1/folders").json()["data"][0]["parentId"])
            self.assertEqual(client.delete(f"/api/v1/folders/{child['id']}").status_code, 204)
            workspace = client.get(route + "/workspace").json()["data"]
            self.assertIsNone(workspace["session"]["folderId"])
            self.assertEqual({key: workspace[key] for key in ("speakers", "segments", "messages")}, {
                "speakers": [], "segments": [], "messages": [],
            })
            self.assertEqual(client.delete(route).status_code, 204)
            self.assertEqual(client.get(route + "/workspace").json()["error"]["code"], "NOT_FOUND")

    def test_error_envelopes_and_cors(self):
        with self.client() as client:
            responses = [
                (client.get("/api/v1/unknown"), 404, "NOT_FOUND"),
                (client.post("/api/v1/folders", json={"name": " "}), 400, "INVALID_REQUEST"),
                (client.post("/api/v1/folders", content="{"), 400, "INVALID_REQUEST"),
                (client.patch("/api/v1/sessions/missing", json={"durationSeconds": -1}), 400, "INVALID_REQUEST"),
                (client.put("/api/v1/folders"), 405, "METHOD_NOT_ALLOWED"),
                (client.get("/api/v1/settings", headers={"Origin": "http://untrusted.test"}), 403, "ORIGIN_FORBIDDEN"),
                (client.get("/api/v1/settings", headers={"Host": "untrusted.test"}), 403, "ORIGIN_FORBIDDEN"),
            ]
            for response, status, code in responses:
                self.assertEqual(response.status_code, status)
                self.assertEqual(set(response.json()), {"error"})
                self.assertEqual(response.json()["error"]["code"], code)
                self.assertTrue(response.json()["error"]["message"])
            cors = client.options("/api/v1/settings", headers={
                "Origin": "http://localhost:5173", "Access-Control-Request-Method": "PUT",
                "Access-Control-Request-Headers": "Content-Type",
            })
            self.assertEqual(cors.headers.get("Access-Control-Allow-Origin"), "http://localhost:5173")

    def test_settings_are_encrypted_and_restored_after_restart(self):
        with self.client() as client:
            response = client.get("/api/v1/settings")
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            settings = response.json()["data"]
            self.assertEqual(len(settings["llmProviders"]), 13)
            self.assertEqual(settings["selectedLlmProviderId"], "opencode-free-bridge")
            self.assertEqual(settings["llmProviders"]["opencode-free-bridge"]["name"], "OpenCode 免费模型")
            self.assertTrue(all(route["providerId"] == "opencode-free-bridge" for route in settings["featureRouting"].values()))
            self.assertEqual(len(settings["asrProviders"]), 10)
            self.assertEqual(settings["selectedAsrProviderId"], "builtin-free-asr")
            self.assertEqual(settings["llmProviders"]["openai"]["apiKey"], "")
            self.assertNotIn("lastFetchedAt", settings["llmProviders"]["openai"])
            for family in ("llmProviders", "asrProviders"):
                self.assertTrue(all(not item["availableModels"] for item in settings[family].values()))
            self.assertTrue(all(not item["selectedModelId"] for item in settings["asrProviders"].values()))
            self.assertTrue(all(not route["modelId"] for route in settings["featureRouting"].values()))
            settings["llmProviders"]["openai"]["apiKey"] = "unit-test-encrypted-key"
            settings["featureRouting"]["chat"]["enabled"] = False
            self.assertEqual(client.put("/api/v1/settings", json=settings).json(), {"data": settings})
        with closing(sqlite3.connect(self.root / "classroom.sqlite3")) as db:
            stored = db.execute("SELECT settings_json FROM app_settings WHERE id=1").fetchone()[0]
            self.assertTrue(stored.startswith("aesgcm:v1:"))
            self.assertNotIn("unit-test-encrypted-key", stored)
        with self.client() as client:
            self.assertEqual(client.get("/api/v1/settings").json(), {"data": settings})
            sid = self.create_session(client)
            response = client.post(f"/api/v1/sessions/{sid}/chat", json={"content": "问题"})
            self.assertEqual(response.json()["error"]["code"], "FEATURE_DISABLED")

    def test_migrate_old_model_seeds_without_removing_fetched_catalogs_or_keys(self):
        with self.client() as client:
            settings = client.get("/api/v1/settings").json()["data"]
            settings["llmProviders"].pop("opencode-free-bridge")
            settings["selectedLlmProviderId"] = "openai"
            settings["featureRouting"]["chat"]["providerId"] = "anthropic"
            settings["llmProviders"]["openai"].update(
                apiKey="saved-llm-key",
                availableModels=["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "o4-mini"],
            )
            settings["featureRouting"]["resegmentation"].update(providerId="openai", modelId="gpt-4.1-mini")
            settings["featureRouting"]["bubbleExplanation"].update(providerId="openai", modelId="manually-configured")
            settings["llmProviders"]["gemini"].update(
                availableModels=["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
                lastFetchedAt="2026-11-15T10:00:00Z",
            )
            settings["asrProviders"]["elevenlabs"].update(
                apiKey="saved-speech-key", availableModels=["scribe_v1", "scribe_v1_experimental"],
                selectedModelId="scribe_v1",
            )
            settings["asrProviders"]["deepgram"].update(
                availableModels=["current-from-vendor"], selectedModelId="current-from-vendor",
            )
            previous_settings = client.app.state.settings.encode(AppSettings.model_validate(settings))
        with closing(sqlite3.connect(self.root / "classroom.sqlite3")) as db:
            with db:
                db.execute("UPDATE app_settings SET settings_json = ? WHERE id = 1", (previous_settings,))
                db.execute("PRAGMA user_version = 0")

        with self.client() as client:
            migrated = client.get("/api/v1/settings").json()["data"]
            self.assertEqual(migrated["selectedLlmProviderId"], "openai")
            self.assertEqual(migrated["featureRouting"]["chat"]["providerId"], "opencode-free-bridge")
            self.assertEqual(migrated["llmProviders"]["opencode-free-bridge"]["availableModels"], [])
            self.assertEqual(migrated["llmProviders"]["openai"]["availableModels"], [])
            self.assertEqual(migrated["llmProviders"]["openai"]["apiKey"], "saved-llm-key")
            self.assertEqual(migrated["featureRouting"]["resegmentation"]["modelId"], "")
            self.assertEqual(migrated["featureRouting"]["bubbleExplanation"]["modelId"], "manually-configured")
            self.assertEqual(migrated["llmProviders"]["gemini"], settings["llmProviders"]["gemini"])
            self.assertEqual(migrated["asrProviders"]["elevenlabs"]["availableModels"], [])
            self.assertEqual(migrated["asrProviders"]["elevenlabs"]["selectedModelId"], "")
            self.assertEqual(migrated["asrProviders"]["elevenlabs"]["apiKey"], "saved-speech-key")
            self.assertEqual(migrated["asrProviders"]["deepgram"], settings["asrProviders"]["deepgram"])
            restored = client.put("/api/v1/settings", json=settings).json()["data"]
            self.assertEqual(restored, migrated)
        with closing(sqlite3.connect(self.root / "classroom.sqlite3")) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 2)

    def test_asr_catalog_that_matches_previous_seed_is_preserved_after_real_fetch(self):
        model_ids = ["gpt-4o-transcribe-diarize", "gpt-4o-transcribe", "whisper-1"]

        def upstream(request: httpx.Request):
            self.assertEqual(request.url.path, "/v1/models")
            return httpx.Response(200, json={"data": [{"id": model_id} for model_id in model_ids]})

        with self.client(httpx.MockTransport(upstream)) as client:
            settings = client.get("/api/v1/settings").json()["data"]
            provider = settings["asrProviders"]["openai-audio"]
            provider["apiKey"] = "test-catalog-key"
            self.assertEqual(client.put("/api/v1/settings", json=settings).status_code, 200)
            config = {key: provider[key] for key in ("providerId", "protocol", "baseUrl", "apiKey")}
            reply = client.post("/api/v1/asr-providers/models", json=config)
            self.assertEqual(reply.json(), {"data": model_ids})
            provider["availableModels"] = model_ids
            provider["selectedModelId"] = model_ids[0]
            self.assertEqual(client.put("/api/v1/settings", json=settings).json()["data"], settings)

    def test_chat_context_explanation_cache_and_cascade_delete(self):
        calls = []

        def upstream(request: httpx.Request):
            self.assertEqual(request.url.path, "/v1/chat/completions")
            body = json.loads(request.content)
            calls.append(body)
            text = json.dumps(DETAIL, ensure_ascii=False) if body["model"] == "explanation-model" else "课堂先讲矩阵再讲注意力。"
            return httpx.Response(200, json={"choices": [{"message": {"content": text}}]})

        with self.client(httpx.MockTransport(upstream)) as client:
            repo = client.app.state.repo
            settings = client.get("/api/v1/settings").json()["data"]
            settings["llmProviders"]["openai"]["apiKey"] = "native-test"
            settings["featureRouting"]["bubbleExplanation"].update(providerId="openai", modelId="explanation-model")
            settings["featureRouting"]["chat"].update(providerId="openai", modelId="chat-model")
            self.assertEqual(client.put("/api/v1/settings", json=settings).status_code, 200)
            sid = self.create_session(client)
            other = self.create_session(client)
            final1, _ = client.portal.call(repo.save_final, sid, "0", "先讲矩阵分解", 10, 1000)
            final2, _ = client.portal.call(repo.save_final, sid, "1", "再讲注意力机制", 1100, 2100)
            second_id = client.portal.call(repo.regroup, final2.utterance.id, Regrouping(
                action="create_new_segment", updated_topic_title="注意力机制",
            ))
            client.portal.call(repo.save_highlights, second_id, [Term(term="注意力机制", explanation=GLOSS)])
            self.assertEqual(client.patch(
                f"/api/v1/sessions/{other}/speakers/{final1.utterance.speaker_id}", json={"label": "周老师"}
            ).status_code, 404)
            self.assertEqual(client.patch(
                f"/api/v1/sessions/{sid}/speakers/{final1.utterance.speaker_id}", json={"label": "周老师"}
            ).status_code, 204)
            explain = f"/api/v1/sessions/{sid}/segments/{second_id}/explain"
            self.assertEqual(client.post(explain).json()["data"], DETAIL)
            self.assertEqual(client.post(explain).json()["data"], DETAIL)
            self.assertEqual(len(calls), 1)
            self.assertEqual(client.post(f"/api/v1/sessions/{other}/segments/{second_id}/explain").status_code, 404)
            output = client.post(f"/api/v1/sessions/{sid}/chat", json={"content": "主要讲了什么？"}).json()["data"]
            self.assertEqual(output["role"], "assistant")
            self.assertEqual(output["referencedSegmentCount"], 2)
            self.assertIn("先讲矩阵分解", calls[1]["messages"][0]["content"])
            self.assertIn("再讲注意力机制", calls[1]["messages"][0]["content"])
            self.assertIn("周老师", calls[1]["messages"][0]["content"])
            self.assertEqual(calls[1]["model"], "chat-model")
            workspace = client.get(f"/api/v1/sessions/{sid}/workspace").json()["data"]
            self.assertEqual([msg["role"] for msg in workspace["messages"]], ["user", "assistant"])
            self.assertNotIn("referencedSegmentCount", workspace["messages"][0])
            self.assertNotIn("detailedExplanation", workspace["segments"][0])
            self.assertEqual(workspace["segments"][1]["detailedExplanation"], DETAIL)
            client.portal.call(repo.save_correction, final2.utterance.id, "更新后的注意力机制")
            self.assertEqual(client.post(explain).json()["data"], DETAIL)
            self.assertEqual(len(calls), 3)
            self.assertEqual(client.delete(f"/api/v1/sessions/{sid}").status_code, 204)
            with closing(sqlite3.connect(self.root / "classroom.sqlite3")) as db:
                for table in ("speakers", "utterances", "knowledge_segments", "segment_highlights", "chat_messages"):
                    self.assertEqual(db.execute(f"SELECT count(*) FROM {table}").fetchone()[0], 0)

    def test_streaming_chat_and_explanation_with_feature_thinking_levels(self):
        recorded: list[tuple[str, str | None, bool]] = []

        def parse_sse(raw_text: str) -> list[dict]:
            frames = []
            for block in raw_text.split("\n\n"):
                for line in block.splitlines():
                    if line.startswith("data: "):
                        frames.append(json.loads(line[6:]))
            return frames

        def upstream(request: httpx.Request):
            body = json.loads(request.content)
            model = body["model"]
            effort = body.get("reasoning_effort")
            is_stream = bool(body.get("stream"))
            recorded.append((model, effort, is_stream))
            if model == "highlight-model":
                res = {"highlights": [{"term": "注意力机制", "explanation": "权重由 $\\text{softmax}$ 计算。"}]}
                return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(res, ensure_ascii=False)}}]})
            if model == "explain-model":
                sse = (
                    'data: {"choices":[{"delta":{"reasoning_content":"梳理缩放点积公式与上下文关联。"}}]}\n\n'
                    f'data: {json.dumps({"choices": [{"delta": {"content": json.dumps(DETAIL, ensure_ascii=False)}}]}, ensure_ascii=False)}\n\n'
                    'data: [DONE]\n\n'
                )
                return httpx.Response(200, content=sse.encode("utf-8"), headers={"content-type": "text/event-stream"})
            sse = (
                'data: {"choices":[{"delta":{"reasoning_content":"第一步：检查课堂段落；"}}]}\n\n'
                'data: {"choices":[{"delta":{"reasoning_content":"第二步：推导注意力缩放项。"}}]}\n\n'
                'data: {"choices":[{"delta":{"content":"公式为 $$\\\\text{Attention}(Q,K,V)=\\\\text{softmax}\\\\left(\\\\frac{QK^T}{\\\\sqrt{d_k}}\\\\right)V$$"}}]}\n\n'
                'data: [DONE]\n\n'
            )
            return httpx.Response(200, content=sse.encode("utf-8"), headers={"content-type": "text/event-stream"})

        with self.client(httpx.MockTransport(upstream)) as client:
            repo = client.app.state.repo
            settings = client.get("/api/v1/settings").json()["data"]
            settings["llmProviders"]["custom"].update(
                baseUrl="https://opencode.ai/zen/go/v1",
                apiKey="stream-test-key",
            )
            settings["featureRouting"]["keyTermHighlight"].update(providerId="custom", modelId="highlight-model")
            settings["featureRouting"]["bubbleExplanation"].update(providerId="custom", modelId="explain-model")
            settings["featureRouting"]["chat"].update(providerId="custom", modelId="chat-model")
            self.assertEqual(client.put("/api/v1/settings", json=settings).status_code, 200)

            sid = self.create_session(client)
            final1, _ = client.portal.call(repo.save_final, sid, "0", "今天推导注意力机制的缩放公式", 0, 1200)
            client.portal.call(
                client.app.state.streams.pipeline.highlight,
                sid,
                final1.utterance.id,
                AppSettings.model_validate(settings),
            )
            seg_id = client.get(f"/api/v1/sessions/{sid}/workspace").json()["data"]["segments"][0]["id"]

            explain_res = client.post(f"/api/v1/sessions/{sid}/segments/{seg_id}/explain/stream")
            self.assertEqual(explain_res.status_code, 200)
            explain_frames = parse_sse(explain_res.text)
            self.assertEqual(
                [f["type"] for f in explain_frames],
                ["thinking", "status", "done"],
            )
            self.assertEqual(explain_frames[-1]["data"]["thinking"], "梳理缩放点积公式与上下文关联。")

            chat_res = client.post(
                f"/api/v1/sessions/{sid}/chat/stream",
                json={"content": "请写出注意力公式"},
            )
            self.assertEqual(chat_res.status_code, 200)
            chat_frames = parse_sse(chat_res.text)
            self.assertEqual(
                [f["type"] for f in chat_frames],
                ["thinking", "thinking", "content", "done"],
            )
            done_msg = chat_frames[-1]["data"]
            self.assertEqual(done_msg["thinking"], "第一步：检查课堂段落；第二步：推导注意力缩放项。")
            self.assertIn("\\sqrt{d_k}", done_msg["content"])

            self.assertEqual(
                recorded,
                [
                    ("highlight-model", "none", False),
                    ("explain-model", "medium", True),
                    ("chat-model", "max", True),
                ],
            )

            workspace = client.get(f"/api/v1/sessions/{sid}/workspace").json()["data"]
            self.assertEqual(
                workspace["messages"][-1]["thinking"],
                "第一步：检查课堂段落；第二步：推导注意力缩放项。",
            )
            self.assertEqual(
                workspace["segments"][0]["detailedExplanation"]["thinking"],
                "梳理缩放点积公式与上下文关联。",
            )

    def test_incremental_highlight_merge_and_backlog_batch_coalescing(self):
        calls_by_model: list[str] = []

        def upstream(request: httpx.Request):
            body = json.loads(request.content)
            model = body["model"]
            payload = json.loads(body["messages"][-1]["content"])
            calls_by_model.append(model)
            if model == "correct":
                if "utterances" in payload:
                    res = {
                        "items": [
                            {"utteranceId": item["utteranceId"], "refinedText": item["rawText"]}
                            for item in payload["utterances"]
                        ]
                    }
                else:
                    res = {"refinedText": payload["rawText"]}
            elif model == "segment":
                if "utterances" in payload:
                    res = {
                        "decisions": [
                            {
                                "utteranceId": item["utteranceId"],
                                "action": "append_to_last",
                                "updatedTopicTitle": "投入产出与线性方程组",
                            }
                            for item in payload["utterances"]
                        ]
                    }
                else:
                    res = {"action": "append_to_last", "updatedTopicTitle": "投入产出与线性方程组"}
            else:
                last_text = payload["utterances"][-1]
                term = "列昂惕夫模型" if "列昂惕夫模型" in last_text else "增广矩阵"
                res = {"highlights": [{"term": term, "explanation": GLOSS}]}
            return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(res, ensure_ascii=False)}}]})

        with self.client(httpx.MockTransport(upstream)) as client:
            repo = client.app.state.repo
            pipeline = client.app.state.streams.pipeline
            settings = client.get("/api/v1/settings").json()["data"]
            settings["llmProviders"]["openai"]["apiKey"] = "batch-test-key"
            for feature, model in [
                ("sentenceCorrection", "correct"),
                ("resegmentation", "segment"),
                ("keyTermHighlight", "highlight"),
            ]:
                settings["featureRouting"][feature].update(providerId="openai", modelId=model)
            self.assertEqual(client.put("/api/v1/settings", json=settings).status_code, 200)

            sid = self.create_session(client)
            u1, _ = client.portal.call(repo.save_final, sid, "0", "我们先学增广矩阵的初等行变换", 0, 1000)
            u2, _ = client.portal.call(repo.save_final, sid, "0", "嗯。", 1000, 1200)
            u3, _ = client.portal.call(repo.save_final, sid, "0", "对。", 1200, 1400)
            u4, _ = client.portal.call(repo.save_final, sid, "0", "再把增广矩阵用于列昂惕夫模型求解", 1400, 2400)
            u5, _ = client.portal.call(repo.save_final, sid, "0", "由此得到列昂惕夫模型的均衡产出解", 2400, 3400)

            parsed_settings = AppSettings.model_validate(settings)
            # 先对首句提取出「增广矩阵」
            client.portal.call(pipeline.highlight, sid, u1.utterance.id, parsed_settings)
            # 再对积压批次（含 2 条语气词 + 2 条实质句）执行批量处理
            substantive = client.portal.call(
                pipeline._filter_fillers,
                [u2.utterance.id, u3.utterance.id, u4.utterance.id, u5.utterance.id],
            )
            self.assertEqual(substantive, [u4.utterance.id, u5.utterance.id])
            client.portal.call(pipeline.process_batch, sid, substantive, parsed_settings)

            # 验证：2 条语气词零调用；2 条实质句合并为 1 次批量校对 + 并发执行的 1 次批量分段与 1 次增量重点词提取（共仅 3 次调用）
            self.assertEqual(calls_by_model[:2], ["highlight", "correct"])
            self.assertCountEqual(calls_by_model[2:], ["segment", "highlight"])
            ws = client.get(f"/api/v1/sessions/{sid}/workspace").json()["data"]
            terms = [h["term"] for h in ws["segments"][0]["highlights"]]
            # 验证增量合并：前句的「增广矩阵」与后句新增的「列昂惕夫模型」同时保留，不被覆盖清空
            self.assertEqual(terms, ["列昂惕夫模型", "增广矩阵"])

    def test_aggressive_sentence_correction_clears_fillers_and_skips_downstream(self):
        calls: list[tuple[str, dict]] = []

        def upstream(request: httpx.Request):
            body = json.loads(request.content)
            model = body["model"]
            payload = json.loads(body["messages"][-1]["content"])
            calls.append((model, payload))
            if model == "correct":
                if "就是说" in payload["rawText"] and "增广矩阵" not in payload["rawText"]:
                    res = {"refinedText": ""}
                else:
                    res = {"refinedText": "这个矩阵称为增广矩阵，把这一列劈开后左侧称为系数矩阵。"}
            elif model == "segment":
                res = {"action": "append_to_last", "updatedTopicTitle": "增广矩阵与系数矩阵"}
            else:
                res = {"highlights": [{"term": "增广矩阵", "explanation": GLOSS}]}
            return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(res, ensure_ascii=False)}}]})

        with self.client(httpx.MockTransport(upstream)) as client:
            repo = client.app.state.repo
            pipeline = client.app.state.streams.pipeline
            settings = client.get("/api/v1/settings").json()["data"]
            settings["llmProviders"]["openai"]["apiKey"] = "aggressive-test-key"
            for feature, model in [
                ("sentenceCorrection", "correct"),
                ("resegmentation", "segment"),
                ("keyTermHighlight", "highlight"),
                ("chat", "chat"),
            ]:
                settings["featureRouting"][feature].update(providerId="openai", modelId=model)
            self.assertEqual(client.put("/api/v1/settings", json=settings).status_code, 200)
            parsed_settings = AppSettings.model_validate(settings)

            sid = self.create_session(client)
            u_filler, _ = client.portal.call(repo.save_final, sid, "0", "看到了吗？", 0, 500)
            u_empty_tic, _ = client.portal.call(
                repo.save_final, sid, "0", "那个，就是说，你看听懂了没？对不对？", 500, 1500,
            )
            u_real, _ = client.portal.call(
                repo.save_final,
                sid,
                "0",
                "那么这个阵呢就叫正光矩阵，看见没？要把阵把这一列劈开，这个被称之为叫系数阵。",
                1500,
                3500,
            )

            published: list[tuple[str, dict]] = []

            async def capture_publish(_sid: str, event_type: str, data: dict):
                published.append((event_type, data))

            async def submit_and_drain(uid: str):
                pipeline.submit(sid, uid)
                await pipeline.shutdown()

            orig_publish = pipeline.publish
            pipeline.publish = capture_publish
            try:
                # 1. 短口头词通过真实队列快速清空并广播空 refinedText，不调用上游 LLM
                client.portal.call(submit_and_drain, u_filler.utterance.id)
                self.assertEqual(calls, [])
                self.assertEqual(published[-1][0], "utterance.corrected")
                self.assertEqual(published[-1][1]["refinedText"], "")

                # 2. 长废话句经校对清空为 "" 后，跳过无意义的分段与重点词调用
                client.portal.call(submit_and_drain, u_empty_tic.utterance.id)
                self.assertEqual([m for m, _ in calls], ["correct"])

                # 3. 含口头重复与同音别字的实质句正常精简，且前序已清空的废话句不污染上下文
                client.portal.call(submit_and_drain, u_real.utterance.id)
                self.assertEqual([m for m, _ in calls], ["correct", "correct", "segment", "highlight"])
                self.assertEqual(calls[1][1]["previousUtterances"], [])
                self.assertIn("topicTitle", calls[1][1])
            finally:
                pipeline.publish = orig_publish

            ws = client.get(f"/api/v1/sessions/{sid}/workspace").json()["data"]
            utts = ws["segments"][0]["utterances"]
            self.assertEqual([u["refinedText"] for u in utts], ["", "", "这个矩阵称为增广矩阵，把这一列劈开后左侧称为系数矩阵。"])
            self.assertTrue(all(u["isRefined"] for u in utts))

    def test_model_routes_dispatch_and_return_plain_id_arrays(self):
        def upstream(request: httpx.Request):
            if request.url.host == "native.test":
                self.assertEqual(request.headers["anthropic-version"], "2023-06-01")
                return httpx.Response(200, json={"data": [{"id": "claude-live"}]})
            self.assertEqual(request.url.path, "/v1/models")
            return httpx.Response(200, json={"stt": [
                {"name": "batch", "streaming": False},
                {"canonical_name": "nova-3-general", "streaming": True},
                {"canonical_name": "flux-general-en", "streaming": True},
            ]})

        with self.client(httpx.MockTransport(upstream)) as client:
            llm = client.post("/api/v1/providers/models", json={
                "providerId": "selected", "protocol": "anthropic", "baseUrl": "https://native.test", "apiKey": "key",
            })
            asr = client.post("/api/v1/asr-providers/models", json={
                "providerId": "deepgram", "protocol": "deepgram",
                "baseUrl": "wss://deepgram.test/v1/listen", "apiKey": "key",
            })
            self.assertEqual(llm.json(), {"data": ["claude-live"]})
            self.assertEqual(asr.json(), {"data": ["nova-3-general"]})

    def test_audio_to_websocket_pipeline_and_resume(self):
        calls = []
        frames = []

        async def upstream(request: httpx.Request):
            body = json.loads(request.content)
            model = body["model"]
            payload = json.loads(body["messages"][-1]["content"])
            calls.append(model)
            if model == "correct":
                await asyncio.sleep(0.02)
                result = {"refinedText": payload["rawText"].replace("举阵", "矩阵")}
            elif model == "segment":
                action = "append_to_last" if not payload["recentSegments"] else "create_new_segment"
                result = {"action": action, "updatedTopicTitle": payload["utterance"]}
            else:
                result = {"highlights": [
                    {"term": payload["utterances"][-1], "explanation": GLOSS},
                    {"term": "不存在的术语", "explanation": GLOSS},
                ]}
            return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(result)}}]})

        async def provider(socket):
            start = json.loads(await socket.recv())
            self.assertEqual(start["type"], "start")
            self.assertEqual(start["sampleRate"], 16000)
            self.assertTrue(start["enableSpeakerDiarization"])
            await socket.send('{"type":"ready"}')
            count = 0
            async for frame in socket:
                if isinstance(frame, str):
                    self.assertEqual(json.loads(frame), {"type": "stop"})
                    await socket.send('{"type":"done"}')
                    return
                frames.append(frame)
                count += 1
                if count <= 2:
                    text = "举阵" if count == 1 else "注意力机制"
                    label = "A" if count == 1 else "B"
                    start_ms = (count - 1) * 100
                    await socket.send(json.dumps({"type": "partial", "text": text[:1], "speakerId": label}))
                    await socket.send(json.dumps({
                        "type": "final", "text": text, "speakerId": label,
                        "startTimeMs": start_ms, "endTimeMs": start_ms + 100,
                    }))

        async def start_provider():
            server = await serve(provider, "127.0.0.1", 0)
            return server, server.sockets[0].getsockname()[1]

        async def stop_provider(server):
            server.close()
            await server.wait_closed()

        async def receive(socket):
            with anyio.fail_after(5):
                message = await socket._send_rx.receive()
            return json.loads(message["text"])

        with self.client(httpx.MockTransport(upstream)) as client:
            server, port = client.portal.call(start_provider)
            try:
                settings = client.get("/api/v1/settings").json()["data"]
                settings["selectedAsrProviderId"] = "custom-asr"
                settings["asrProviders"]["custom-asr"].update(
                    baseUrl=f"ws://127.0.0.1:{port}/stream", selectedModelId="test-stream",
                )
                settings["llmProviders"]["openai"]["apiKey"] = "sample-key"
                for feature, model in [
                    ("sentenceCorrection", "correct"), ("resegmentation", "segment"), ("keyTermHighlight", "highlight"),
                ]:
                    settings["featureRouting"][feature].update(providerId="openai", modelId=model)
                self.assertEqual(client.put("/api/v1/settings", json=settings).status_code, 200)
                sid = self.create_session(client)
                with client.websocket_connect(f"ws://localhost/ws/v1/sessions/{sid}/stream") as socket:
                    socket.send_json({"type": "invalid"})
                    self.assertEqual(
                        socket.portal.call(receive, socket)["payload"]["code"], "INVALID_RECORDING_COMMAND",
                    )
                    socket.send_json(START)
                    self.assertEqual(socket.portal.call(receive, socket)["type"], "session.duration")
                    for _ in range(11):
                        socket.send_bytes(b"\x00\x08" * 1600)
                    events = []
                    while sum(event["type"] == "highlights.updated" for event in events) < 2:
                        event = socket.portal.call(receive, socket)
                        self.assertNotEqual(event["type"], "error", event)
                        events.append(event)
                    grouped = [event for event in events if event["type"] == "segments.regrouped"]
                    self.assertEqual(grouped[0]["payload"]["segments"][0]["utterances"], [])
                    self.assertEqual(len(grouped[-1]["payload"]["segments"]), 2)
                    self.assertEqual(
                        [event["payload"]["highlights"][0]["term"] for event in events if event["type"] == "highlights.updated"],
                        ["矩阵", "注意力机制"],
                    )
                    self.assertEqual(sum(event["type"] == "utterance.partial" for event in events), 2)
                    self.assertEqual(sum(event["type"] == "utterance.final" for event in events), 2)
                    self.assertEqual(sum(event["type"] == "utterance.corrected" for event in events), 2)
                    socket.send_json({"type": "recording.pause"})
                    workspace_route = f"/api/v1/sessions/{sid}/workspace"
                    while client.get(workspace_route).json()["data"]["session"]["status"] != "paused":
                        socket.portal.call(receive, socket)
                    settings["featureRouting"]["sentenceCorrection"]["enabled"] = False
                    settings["featureRouting"]["resegmentation"]["enabled"] = False
                    settings["featureRouting"]["keyTermHighlight"]["enabled"] = False
                    self.assertEqual(client.put("/api/v1/settings", json=settings).status_code, 200)
                    socket.send_json({"type": "recording.resume"})
                    socket.send_bytes(b"\x00\x08" * 1600)
                    while True:
                        event = socket.portal.call(receive, socket)
                        self.assertNotEqual(event["type"], "error", event)
                        if event["type"] == "utterance.final":
                            self.assertEqual(event["payload"]["utterance"]["startTimeMs"], 1100)
                            break
                    socket.send_json({"type": "recording.stop"})
                    while client.get(workspace_route).json()["data"]["session"]["status"] != "paused":
                        event = socket.portal.call(receive, socket)
                        self.assertNotEqual(event["type"], "error", event)
                self.assertEqual(len(calls), 6)
                self.assertEqual(len(frames), 12)
                archive = self.root / "recordings" / f"{sid}.wav"
                self.assertEqual(client.get(workspace_route).json()["data"]["session"]["durationSeconds"], 1)
                self.assertEqual(client.get(workspace_route).json()["data"]["session"]["segmentCount"], 2)
                self.assertGreaterEqual(client.get(workspace_route).json()["data"]["session"]["speakerCount"], 2)
                with wave.open(str(archive), "rb") as wav:
                    self.assertEqual((wav.getframerate(), wav.getnchannels(), wav.getsampwidth()), (16000, 1, 2))
                    self.assertEqual(wav.getnframes(), 19200)
                self.assertEqual(client.delete(f"/api/v1/sessions/{sid}").status_code, 204)
                self.assertFalse(archive.exists())
            finally:
                client.portal.call(stop_provider, server)

    def test_audio_settings_hydration_and_native_devices(self):
        with self.client() as client:
            settings = client.get("/api/v1/settings").json()["data"]
            self.assertEqual(settings["systemAudioDeviceId"], "default")
            self.assertTrue(settings["micEnabled"])
            self.assertTrue(settings["systemAudioEnabled"])
            self.assertFalse(settings["enableWebrtcAec3"])
            self.assertFalse(settings["aec3PromptDismissed"])

            settings["enableWebrtcAec3"] = True
            settings["aec3PromptDismissed"] = True
            settings["micEnabled"] = False
            settings["audioInputSource"] = "system-only"
            settings["systemAudioDeviceId"] = "display-share"
            saved = client.put("/api/v1/settings", json=settings).json()["data"]
            self.assertTrue(saved["enableWebrtcAec3"])
            self.assertTrue(saved["aec3PromptDismissed"])
            self.assertFalse(saved["micEnabled"])
            self.assertEqual(saved["systemAudioDeviceId"], "display-share")

            devices = client.get("/api/v1/audio/devices").json()["data"]
            self.assertIn("wasapiSupported", devices)
            self.assertIsInstance(devices["inputs"], list)
            self.assertIsInstance(devices["loopbacks"], list)
            if devices["wasapiSupported"] and devices["loopbacks"]:
                with client.websocket_connect("ws://localhost/ws/v1/audio/loopback?deviceId=default") as ws:
                    frame = ws.receive_bytes()
                    self.assertEqual(len(frame), 640)

        # Simulate legacy un-migrated JSON row lacking new audio keys
        legacy_payload = {
            k: v for k, v in settings.items()
            if k not in ("systemAudioDeviceId", "micEnabled", "systemAudioEnabled", "enableWebrtcAec3", "aec3PromptDismissed")
        }
        legacy_payload["audioInputSource"] = "mic-only"
        with closing(sqlite3.connect(self.root / "classroom.sqlite3")) as conn:
            conn.execute("UPDATE app_settings SET settings_json = ? WHERE id = 1", (json.dumps(legacy_payload),))
            conn.commit()
        with self.client() as client:
            hydrated = client.get("/api/v1/settings").json()["data"]
            self.assertTrue(hydrated["micEnabled"])
            self.assertFalse(hydrated["systemAudioEnabled"])
            self.assertEqual(hydrated["systemAudioDeviceId"], "default")
            self.assertFalse(hydrated["enableWebrtcAec3"])

    def test_webrtc_aec3_addon_download_fallback_and_verification(self):
        import hashlib
        import io
        import tarfile
        from unittest.mock import patch
        from backend.app.services import addons as addons_mod

        fake_wasm = b"\x00asm\x01\x00\x00\x00" + (b"\x42" * 16_000)
        fake_js = (
            'WebRtcAec3Wasm="data:application/wasm;base64,AAAA";\n'
            "var WebRtcAec3 = function() { return Promise.resolve({}); };\n"
            + ("// padding\n" * 1200)
        ).encode("utf-8")

        def make_tgz(wasm_payload: bytes, js_payload: bytes) -> bytes:
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode="w:gz") as tf:
                for name, data in (
                    (f"package/dist/webrtcaec3-{addons_mod.AEC3_VERSION}.wasm", wasm_payload),
                    (f"package/dist/webrtcaec3-{addons_mod.AEC3_VERSION}.js", js_payload),
                    ("package/license.js", b"BSD-3-Clause"),
                ):
                    info = tarfile.TarInfo(name=name)
                    info.size = len(data)
                    tf.addfile(info, io.BytesIO(data))
            return buf.getvalue()

        good_tgz = make_tgz(fake_wasm, fake_js)
        bad_tgz = make_tgz(fake_wasm[:-1] + b"\x99", fake_js)
        serve_bad = True

        def transport_handler(request: httpx.Request) -> httpx.Response:
            if "huaweicloud" in str(request.url):
                return httpx.Response(503, text="mirror down")
            body = bad_tgz if serve_bad else good_tgz
            return httpx.Response(200, content=body, headers={"Content-Length": str(len(body))})

        with (
            patch.object(addons_mod, "EXPECTED_WASM_BYTES", len(fake_wasm)),
            patch.object(addons_mod, "EXPECTED_WASM_SHA256", hashlib.sha256(fake_wasm).hexdigest()),
            patch.object(addons_mod, "EXPECTED_JS_SHA256", hashlib.sha256(fake_js).hexdigest()),
            self.client(httpx.MockTransport(transport_handler)) as client,
        ):
            status0 = client.get("/api/v1/addons/webrtc-aec3").json()["data"]
            self.assertFalse(status0["installed"])
            self.assertEqual(client.get("/api/v1/addons/webrtc-aec3/module.wasm").status_code, 404)

            # Tampered archive must be rejected with ADDON_HASH_MISMATCH
            bad_sse = client.post("/api/v1/addons/webrtc-aec3/download").text
            self.assertIn("ADDON_HASH_MISMATCH", bad_sse)
            self.assertFalse(client.get("/api/v1/addons/webrtc-aec3/module.wasm").status_code == 200)

            # Valid archive via secondary mirror succeeds and streams progress -> done
            serve_bad = False
            good_sse = client.post("/api/v1/addons/webrtc-aec3/download").text
            frames = [
                json.loads(line[5:].strip())
                for line in good_sse.splitlines()
                if line.startswith("data:")
            ]
            self.assertTrue(any(f.get("type") == "progress" for f in frames))
            self.assertEqual(frames[-1]["type"], "done")
            self.assertTrue(frames[-1]["data"]["installed"])

            wasm_resp = client.get("/api/v1/addons/webrtc-aec3/module.wasm")
            self.assertEqual(wasm_resp.status_code, 200)
            self.assertEqual(wasm_resp.content, fake_wasm)

            js_resp = client.get("/api/v1/addons/webrtc-aec3/worklet-lib.js")
            self.assertEqual(js_resp.status_code, 200)
            js_text = js_resp.content.decode("utf-8")
            self.assertNotIn('WebRtcAec3Wasm="data:', js_text)
            self.assertIn("globalThis.WebRtcAec3 = WebRtcAec3;", js_text)
