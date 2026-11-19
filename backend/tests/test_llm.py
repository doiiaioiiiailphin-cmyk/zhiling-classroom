import json
import unittest

import httpx

from backend.app.errors import AppError
from backend.app.providers.llm import Turn, llm_adapter
from backend.app.schemas import Correction, LLMModelsRequest


def config(protocol: str, url: str) -> LLMModelsRequest:
    return LLMModelsRequest(provider_id="provider", protocol=protocol, base_url=url, api_key="test-key")


class LLMAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_openai_native_models_and_strict_schema(self):
        def handler(request: httpx.Request):
            self.assertEqual(request.headers["Authorization"], "Bearer test-key")
            if request.method == "GET":
                self.assertEqual(request.url.path, "/v1/models")
                return httpx.Response(200, json={"data": [{"id": "gpt-4.1"}, {"id": "gpt-4.1"}]})
            self.assertEqual(request.url.path, "/v1/chat/completions")
            body = json.loads(request.content)
            self.assertEqual(body["model"], "gpt-4.1")
            self.assertEqual(body["messages"][0]["role"], "system")
            schema = body["response_format"]["json_schema"]
            self.assertTrue(schema["strict"])
            self.assertIn("refinedText", schema["schema"]["properties"])
            return httpx.Response(200, json={"choices": [
                {"message": {"content": '{"refinedText":"校对结果"}'}}
            ]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            adapter = llm_adapter(http, config("openai", "https://openai.test/v1"))
            self.assertEqual(await adapter.list_models(), ["gpt-4.1"])
            result = await adapter.complete("gpt-4.1", "系统", [Turn("user", "原文")], Correction)
            self.assertEqual(result.refined_text, "校对结果")

    async def test_anthropic_native_pagination_and_top_level_system(self):
        def handler(request: httpx.Request):
            self.assertEqual(request.headers["x-api-key"], "test-key")
            self.assertEqual(request.headers["anthropic-version"], "2023-06-01")
            self.assertNotIn("Authorization", request.headers)
            if request.method == "GET":
                self.assertEqual(request.url.path, "/v1/models")
                if request.url.params.get("after_id") == "claude-1":
                    return httpx.Response(200, json={"data": [{"id": "claude-2"}], "has_more": False})
                return httpx.Response(200, json={
                    "data": [{"id": "claude-1"}], "has_more": True, "last_id": "claude-1",
                })
            self.assertEqual(request.url.path, "/v1/messages")
            body = json.loads(request.content)
            self.assertEqual(body["system"], "课文上下文")
            self.assertIn("max_tokens", body)
            self.assertEqual(body["messages"], [{"role": "user", "content": "问题"}])
            return httpx.Response(200, json={"content": [
                {"type": "thinking", "thinking": "private"}, {"type": "text", "text": "回答"},
            ]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            adapter = llm_adapter(http, config("anthropic", "https://anthropic.test/v1/"))
            self.assertEqual(await adapter.list_models(), ["claude-1", "claude-2"])
            self.assertEqual(await adapter.complete("claude-2", "课文上下文", [Turn("user", "问题")]), "回答")

    async def test_gemini_native_filter_pagination_and_structured_response(self):
        def handler(request: httpx.Request):
            self.assertEqual(request.headers["x-goog-api-key"], "test-key")
            if request.method == "GET":
                self.assertEqual(request.url.path, "/v1beta/models")
                if request.url.params.get("pageToken") == "next":
                    return httpx.Response(200, json={"models": [
                        {"name": "models/gemini-2", "supportedGenerationMethods": ["generateContent"]},
                    ]})
                return httpx.Response(200, json={"nextPageToken": "next", "models": [
                    {"name": "models/gemini-1", "supportedGenerationMethods": ["generateContent"]},
                    {"name": "models/embed", "supportedGenerationMethods": ["embedContent"]},
                ]})
            self.assertEqual(request.url.path, "/v1beta/models/gemini-1:generateContent")
            body = json.loads(request.content)
            self.assertIn("systemInstruction", body)
            self.assertEqual([turn["role"] for turn in body["contents"]], ["user", "model", "user"])
            schema = body["generationConfig"]["responseSchema"]
            self.assertEqual(body["generationConfig"]["responseMimeType"], "application/json")
            self.assertIn("refinedText", schema["properties"])
            return httpx.Response(200, json={"candidates": [{"content": {"parts": [
                {"text": "thought", "thought": True}, {"text": '{"refinedText":"Transformer"}'},
            ]}}]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            adapter = llm_adapter(http, config("gemini", "https://gemini.test"))
            self.assertEqual(await adapter.list_models(), ["gemini-1", "gemini-2"])
            result = await adapter.complete(
                "models/gemini-1", "系统", [Turn("user", "讲课"), Turn("assistant", "好的"), Turn("user", "术语")],
                Correction,
            )
            self.assertEqual(result.refined_text, "Transformer")

    async def test_compatible_schema_fallback_and_validation(self):
        formats = []

        def handler(request: httpx.Request):
            self.assertEqual(request.url.path, "/local/v1/chat/completions")
            response_format = json.loads(request.content)["response_format"]["type"]
            formats.append(response_format)
            if response_format == "json_schema":
                return httpx.Response(400, json={"error": {"message": "unsupported"}})
            return httpx.Response(200, json={"choices": [{"message": {"content": '{"wrong":"字段"}'}}]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            adapter = llm_adapter(http, config("openai-compatible", "https://gateway.test/local/v1"))
            with self.assertRaises(AppError) as failure:
                await adapter.complete("gateway-model", "系统", [Turn("user", "原文")], Correction)
            self.assertEqual(failure.exception.code, "PROVIDER_INVALID_OUTPUT")
            self.assertEqual(formats, ["json_schema", "json_object"])

    async def test_upstream_auth_failure_is_sanitized(self):
        def handler(_):
            return httpx.Response(401, json={"message": "bad secret: test-key"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            with self.assertRaises(AppError) as failure:
                await llm_adapter(http, config("openai", "https://openai.test/v1")).list_models()
            self.assertEqual((failure.exception.status, failure.exception.code), (401, "PROVIDER_AUTH_FAILED"))
            self.assertNotIn("test-key", failure.exception.message)

    async def test_opencode_go_sends_documented_session_and_user_agent_headers(self):
        captured_headers = {}
        seen_formats = []

        def handler(request: httpx.Request):
            captured_headers.update(request.headers)
            body = json.loads(request.content)
            if "response_format" in body:
                fmt = body["response_format"]["type"]
                seen_formats.append(fmt)
                if fmt == "json_object":
                    return httpx.Response(200, json={"choices": [{"message": {"content": '{"bad":1}'}}]})
                return httpx.Response(200, json={"choices": [{"message": {"content": '{"refinedText":"严格回退成功"}'}}]})
            return httpx.Response(200, json={"choices": [{"message": {"content": "测试通过"}}]})

        opencode_cfg = LLMModelsRequest(
            provider_id="custom",
            protocol="openai-compatible",
            base_url="https://opencode.ai/zen/go/v1",
            api_key="test-opencode-key",
        )
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            adapter = llm_adapter(http, opencode_cfg)
            reply = await adapter.complete(
                "deepseek-v4.1-flash", "系统提示", [Turn("user", "你好")], session_id="classroom123",
            )
            self.assertEqual(reply, "测试通过")
            self.assertEqual(captured_headers.get("user-agent"), "zhiling-classroom/1.0")
            self.assertEqual(captured_headers.get("x-opencode-session"), "ses_classroom123")
            structured = await adapter.complete(
                "deepseek-v4.1-flash", "系统提示", [Turn("user", "原文")], Correction, session_id="classroom123",
            )
            self.assertEqual(structured.refined_text, "严格回退成功")
            self.assertEqual(seen_formats, ["json_object", "json_schema"])

    async def test_thinking_levels_and_sse_streaming_across_protocols(self):
        efforts = []

        def compat_handler(request: httpx.Request):
            body = json.loads(request.content)
            efforts.append(body.get("reasoning_effort"))
            if body.get("reasoning_effort") == "max":
                return httpx.Response(400, json={"error": {"message": "invalid reasoning_effort"}})
            if body.get("model") == "tag-reasoner":
                sse = (
                    'data: {"choices":[{"delta":{"content":"<thi"}}]}\n\n'
                    'data: {"choices":[{"delta":{"content":"nk>分块思考</think>正文内容"}}]}\n\n'
                    'data: [DONE]\n\n'
                )
                return httpx.Response(200, content=sse.encode("utf-8"), headers={"content-type": "text/event-stream"})
            sse = (
                'data: {"choices":[{"delta":{"reasoning_content":"先推导公式"}}]}\n\n'
                'data: {"choices":[{"delta":{"content":"结论：$E=mc^2$"}}]}\n\n'
                'data: [DONE]\n\n'
            )
            return httpx.Response(200, content=sse.encode("utf-8"), headers={"content-type": "text/event-stream"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(compat_handler)) as http:
            adapter = llm_adapter(http, config("openai-compatible", "https://gateway.test/v1"))
            deltas = [
                (d.kind, d.text)
                async for d in adapter.stream("reasoner", "系统", [Turn("user", "问题")], thinking="max")
            ]
            self.assertEqual(efforts, ["max", "high"])
            self.assertEqual(
                deltas,
                [
                    ("thinking", "先推导公式"),
                    ("content", "结论：$E=mc^2$"),
                ],
            )
            tag_deltas = [
                (d.kind, d.text)
                async for d in adapter.stream("tag-reasoner", "系统", [Turn("user", "问题")], thinking="low")
            ]
            self.assertEqual(
                tag_deltas,
                [
                    ("thinking", "分块思考"),
                    ("content", "正文内容"),
                ],
            )

        anthropic_bodies = []

        def anthropic_handler(request: httpx.Request):
            anthropic_bodies.append(json.loads(request.content))
            sse = (
                'event: content_block_delta\n'
                'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"分析段落"}}\n\n'
                'event: content_block_delta\n'
                'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"核心摘要"}}\n\n'
            )
            return httpx.Response(200, content=sse.encode("utf-8"), headers={"content-type": "text/event-stream"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(anthropic_handler)) as http:
            adapter = llm_adapter(http, config("anthropic", "https://anthropic.test/v1"))
            deltas = [
                (d.kind, d.text)
                async for d in adapter.stream("claude-sonnet", "系统", [Turn("user", "段落")], thinking="medium")
            ]
            self.assertEqual(anthropic_bodies[0]["thinking"], {"type": "enabled", "budget_tokens": 4096})
            self.assertEqual(deltas, [("thinking", "分析段落"), ("content", "核心摘要")])

        gemini_bodies = []

        def gemini_handler(request: httpx.Request):
            gemini_bodies.append(json.loads(request.content))
            sse = (
                'data: {"candidates":[{"content":{"parts":[{"text":"简短结论"}]}}]}\n\n'
            )
            return httpx.Response(200, content=sse.encode("utf-8"), headers={"content-type": "text/event-stream"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(gemini_handler)) as http:
            adapter = llm_adapter(http, config("gemini", "https://gemini.test"))
            deltas = [
                (d.kind, d.text)
                async for d in adapter.stream("gemini-2.5-flash", "系统", [Turn("user", "术语")], thinking="none")
            ]
            self.assertEqual(
                gemini_bodies[0]["generationConfig"]["thinkingConfig"],
                {"thinkingBudget": 0, "includeThoughts": False},
            )
            self.assertEqual(deltas, [("content", "简短结论")])
