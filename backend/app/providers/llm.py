from collections.abc import AsyncIterator
import json
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Literal, TypeVar
from urllib.parse import quote, urlsplit
from uuid import uuid4

import httpx
from pydantic import ValidationError

from ..errors import AppError
from ..schemas import LLMModelsRequest, ThinkingLevel, WireModel
from ..settings import OPENCODE_FREE_PROVIDER_ID
from .http import (
    UpstreamRejected,
    endpoint,
    extract_error_detail,
    invalid_response,
    request_json,
    require_key,
    route,
    with_params,
)
from .opencode_bridge import OpenCodeBridge

Output = TypeVar("Output", bound=WireModel)


@dataclass(frozen=True)
class ImageInput:
    mime_type: str
    data_b64: str


@dataclass(frozen=True)
class Turn:
    role: Literal["user", "assistant"]
    content: str
    images: tuple[ImageInput, ...] = ()


@dataclass(frozen=True)
class StreamDelta:
    kind: Literal["thinking", "content"]
    text: str


@dataclass(frozen=True)
class CompletionResult:
    content: str
    thinking: str = ""


def output_schema(model: type[WireModel], *, gemini: bool = False) -> dict:
    schema = model.model_json_schema(by_alias=True)
    definitions = schema.get("$defs", {})

    def simplify(node: dict) -> dict:
        if "$ref" in node:
            return simplify(definitions[node["$ref"].rsplit("/", 1)[-1]])
        output = {key: node[key] for key in ("type", "enum", "required") if key in node}
        if "const" in node:
            output["enum"] = [node["const"]]
        if "properties" in node:
            output["properties"] = {key: simplify(value) for key, value in node["properties"].items()}
            if not gemini:
                output["additionalProperties"] = False
        if "items" in node:
            output["items"] = simplify(node["items"])
        return output

    return simplify(schema)


def unique_ids(values) -> list[str]:
    return list(dict.fromkeys(item for item in values if isinstance(item, str) and item.strip()))


def text_parts(parts: list[dict], *, text_type: str | None = None) -> str:
    return "".join(
        part["text"] for part in parts
        if isinstance(part.get("text"), str)
        and (text_type is None or part.get("type") == text_type)
        and not part.get("thought", False)
    ).strip()


def thought_parts(parts: list[dict], *, anthropic: bool = False) -> str:
    if anthropic:
        return "".join(
            part["thinking"] for part in parts
            if part.get("type") == "thinking" and isinstance(part.get("thinking"), str)
        ).strip()
    return "".join(
        part["text"] for part in parts
        if part.get("thought", False) and isinstance(part.get("text"), str)
    ).strip()


def split_inline_think(text: str) -> tuple[str, str]:
    stripped = text.lstrip()
    if stripped.startswith("<think>") and "</think>" in stripped:
        thought, rest = stripped[len("<think>"):].split("</think>", 1)
        return rest.strip(), thought.strip()
    return text, ""


def strip_json_fence(text: str) -> str:
    cleaned, _ = split_inline_think(text.strip())
    cleaned = cleaned.strip()
    if cleaned.startswith("```") and cleaned.endswith("```") and "\n" in cleaned:
        cleaned = cleaned.split("\n", 1)[1][:-3].strip()
    return cleaned


class ThinkTagSplitter:
    """Splits leading <think>...</think> blocks in streaming content deltas."""

    def __init__(self):
        self.state: Literal["detect", "thinking", "content"] = "detect"
        self.buffer = ""

    def disable(self):
        if self.state == "detect" and not self.buffer:
            self.state = "content"

    def feed(self, chunk: str) -> list[StreamDelta]:
        if not chunk:
            return []
        if self.state == "content":
            return [StreamDelta("content", chunk)]

        self.buffer += chunk
        out: list[StreamDelta] = []

        if self.state == "detect":
            trimmed = self.buffer.lstrip()
            if not trimmed:
                return []
            if "<think>".startswith(trimmed):
                return []
            if trimmed.startswith("<think>"):
                self.state = "thinking"
                self.buffer = trimmed[len("<think>"):]
            else:
                self.state = "content"
                text, self.buffer = self.buffer, ""
                return [StreamDelta("content", text)]

        if self.state == "thinking":
            close_idx = self.buffer.find("</think>")
            if close_idx != -1:
                thought = self.buffer[:close_idx]
                rest = self.buffer[close_idx + len("</think>"):].lstrip("\r\n")
                self.buffer = ""
                self.state = "content"
                if thought:
                    out.append(StreamDelta("thinking", thought))
                if rest:
                    out.append(StreamDelta("content", rest))
                return out
            # Keep up to 7 trailing chars in case '</think>' spans chunks
            safe_len = max(0, len(self.buffer) - 7)
            if safe_len > 0:
                thought, self.buffer = self.buffer[:safe_len], self.buffer[safe_len:]
                out.append(StreamDelta("thinking", thought))
        return out

    def flush(self) -> list[StreamDelta]:
        if not self.buffer:
            return []
        kind: Literal["thinking", "content"] = "thinking" if self.state == "thinking" else "content"
        text, self.buffer = self.buffer, ""
        return [StreamDelta(kind, text)]


async def iter_sse_json(response: httpx.Response) -> AsyncIterator[dict]:
    data_lines: list[str] = []
    async for raw_line in response.aiter_lines():
        line = raw_line.rstrip("\r")
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip(" "))
        elif not line and data_lines:
            payload = "\n".join(data_lines)
            data_lines.clear()
            if payload == "[DONE]":
                return
            try:
                parsed = json.loads(payload)
            except ValueError:
                raise invalid_response() from None
            if isinstance(parsed, dict):
                yield parsed
    if data_lines:
        payload = "\n".join(data_lines)
        if payload != "[DONE]":
            try:
                parsed = json.loads(payload)
            except ValueError:
                raise invalid_response() from None
            if isinstance(parsed, dict):
                yield parsed


def is_opencode_host(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    return host == "opencode.ai" or host.endswith(".opencode.ai")


def normalize_opencode_session(session_id: str | None) -> str:
    raw = re.sub(r"[^A-Za-z0-9_-]", "", (session_id or "").strip())
    if not raw:
        raw = uuid4().hex
    return raw if raw.startswith("ses_") else f"ses_{raw}"


def is_openai_reasoning_model(model_id: str) -> bool:
    lowered = model_id.lower()
    return lowered.startswith(("o1", "o3", "o4", "gpt-5"))


class LLMClientAdapter(ABC):
    def __init__(self, client: httpx.AsyncClient, config: LLMModelsRequest):
        self.client = client
        self.base_url = endpoint(config.base_url, {"http", "https"})
        self.key = require_key(config.api_key, optional=config.provider_id == "custom")
        self.opencode = is_opencode_host(self.base_url)

    @property
    def headers(self) -> dict[str, str]:
        return {}

    def request_headers(self, *, session_id: str | None = None, include_session: bool = True) -> dict[str, str]:
        merged = dict(self.headers)
        if self.opencode:
            merged["User-Agent"] = "zhiling-classroom/1.0"
            if include_session:
                merged["x-opencode-session"] = normalize_opencode_session(session_id)
        return merged

    @abstractmethod
    async def list_models(self) -> list[str]:
        ...

    @abstractmethod
    async def generate_full(
        self, model_id: str, system: str, turns: list[Turn], schema: type[WireModel] | None,
        *, session_id: str | None = None, thinking: ThinkingLevel | None = None,
        max_output_tokens: int | None = None,
    ) -> CompletionResult:
        ...

    @abstractmethod
    def stream_raw(
        self, model_id: str, system: str, turns: list[Turn], schema: type[WireModel] | None,
        *, session_id: str | None = None, thinking: ThinkingLevel | None = None,
        max_output_tokens: int | None = None,
    ) -> AsyncIterator[StreamDelta]:
        ...

    async def generate(
        self, model_id: str, system: str, turns: list[Turn], schema: type[WireModel] | None,
        *, session_id: str | None = None, thinking: ThinkingLevel | None = None,
        max_output_tokens: int | None = None,
    ) -> str:
        result = await self.generate_full(
            model_id, system, turns, schema,
            session_id=session_id, thinking=thinking, max_output_tokens=max_output_tokens,
        )
        return result.content

    def _prepare_system(self, system: str, schema: type[WireModel] | None) -> str:
        if schema is None:
            return system
        expected = json.dumps(output_schema(schema), ensure_ascii=False, separators=(",", ":"))
        return f"{system}\n只输出一个 JSON 对象，字段遵照此 schema。{expected}"

    def _parse_output(self, text: str, schema: type[Output] | None) -> str | Output:
        if not isinstance(text, str) or not text.strip():
            raise invalid_response()
        if schema is None:
            return text.strip()
        cleaned = strip_json_fence(text)
        try:
            return schema.model_validate_json(cleaned)
        except ValidationError:
            raise AppError(502, "PROVIDER_INVALID_OUTPUT", "模型输出不符合课堂结构化格式") from None

    async def complete_with_thinking(
        self, model_id: str, system: str, turns: list[Turn], schema: type[Output] | None = None,
        *, session_id: str | None = None, thinking: ThinkingLevel | None = None,
        max_output_tokens: int | None = None,
    ) -> tuple[str | Output, str]:
        prepared = self._prepare_system(system, schema)
        try:
            result = await self.generate_full(
                model_id, prepared, turns, schema,
                session_id=session_id, thinking=thinking, max_output_tokens=max_output_tokens,
            )
        except (KeyError, IndexError, TypeError, AttributeError):
            raise invalid_response() from None
        try:
            parsed = self._parse_output(result.content, schema)
        except AppError as err:
            if (
                err.code == "PROVIDER_INVALID_OUTPUT"
                and schema is not None
                and getattr(self, "opencode", False)
                and hasattr(self, "generate_full_strict")
            ):
                result = await getattr(self, "generate_full_strict")(
                    model_id, prepared, turns, schema,
                    session_id=session_id, thinking=thinking, max_output_tokens=max_output_tokens,
                )
                parsed = self._parse_output(result.content, schema)
            else:
                raise
        return parsed, result.thinking.strip()

    async def complete(
        self, model_id: str, system: str, turns: list[Turn], schema: type[Output] | None = None,
        *, session_id: str | None = None, thinking: ThinkingLevel | None = None,
        max_output_tokens: int | None = None,
    ) -> str | Output:
        parsed, _ = await self.complete_with_thinking(
            model_id, system, turns, schema,
            session_id=session_id, thinking=thinking, max_output_tokens=max_output_tokens,
        )
        return parsed

    async def stream(
        self, model_id: str, system: str, turns: list[Turn], schema: type[WireModel] | None = None,
        *, session_id: str | None = None, thinking: ThinkingLevel | None = None,
        max_output_tokens: int | None = None,
    ) -> AsyncIterator[StreamDelta]:
        prepared = self._prepare_system(system, schema)
        try:
            async for delta in self.stream_raw(
                model_id, prepared, turns, schema,
                session_id=session_id, thinking=thinking, max_output_tokens=max_output_tokens,
            ):
                if delta.text:
                    yield delta
        except (KeyError, IndexError, TypeError, AttributeError):
            raise invalid_response() from None


class OpenAIChat(LLMClientAdapter):
    compatible = False

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.key}"} if self.key else {}

    async def list_models(self) -> list[str]:
        headers = self.request_headers(include_session=False)
        body = await request_json(self.client, "GET", route(self.base_url, "models"), headers=headers)
        try:
            return unique_ids(row["id"] for row in body["data"])
        except (KeyError, TypeError):
            raise invalid_response() from None

    def _effort_candidates(self, model_id: str, thinking: ThinkingLevel | None) -> list[str | None]:
        if thinking is None:
            return [None]
        if not self.compatible and not is_openai_reasoning_model(model_id):
            return [None]
        match thinking:
            case "none":
                return ["none", "low", None] if self.compatible else ["low", None]
            case "low":
                return ["low", None]
            case "medium":
                return ["medium", None]
            case "max":
                return ["max", "high", None] if self.compatible else ["high", None]
        return [None]

    def _format_candidates(self, schema: type[WireModel] | None, *, prefer_strict: bool = False) -> list[dict | None]:
        if schema is None:
            return [None]
        strict_schema = {
            "type": "json_schema",
            "json_schema": {"name": schema.__name__, "strict": True, "schema": output_schema(schema)},
        }
        if not self.compatible:
            return [strict_schema]
        if self.opencode and not prefer_strict:
            return [{"type": "json_object"}, strict_schema, None]
        return [strict_schema, {"type": "json_object"}, None]

    @staticmethod
    def _encode_turn(turn: Turn) -> dict:
        if not turn.images:
            return {"role": turn.role, "content": turn.content}
        parts: list[dict] = [{"type": "text", "text": turn.content}]
        for img in turn.images:
            parts.append({
                "type": "image_url",
                "image_url": {"url": f"data:{img.mime_type};base64,{img.data_b64}"},
            })
        return {"role": turn.role, "content": parts}

    def _build_payload(
        self, model_id: str, system: str, turns: list[Turn],
        *, effort: str | None, resp_format: dict | None, max_out: int, stream: bool = False,
    ) -> dict:
        limit_key = "max_tokens" if self.compatible else "max_completion_tokens"
        payload: dict = {
            "model": model_id,
            limit_key: max_out,
            "messages": [
                {"role": "system", "content": system},
                *(self._encode_turn(turn) for turn in turns),
            ],
        }
        if effort is not None:
            payload["reasoning_effort"] = effort
        if resp_format is not None:
            payload["response_format"] = resp_format
        if stream:
            payload["stream"] = True
        return payload

    def _attempt_configs(
        self,
        model_id: str,
        schema: type[WireModel] | None,
        thinking: ThinkingLevel | None,
        *,
        prefer_strict: bool = False,
        max_output_tokens: int | None = None,
    ) -> list[tuple[str | None, dict | None, int]]:
        efforts = self._effort_candidates(model_id, thinking)
        formats = self._format_candidates(schema, prefer_strict=prefer_strict)
        default_primary = 32768 if thinking == "max" else 16384
        primary_tokens = max(4096, max_output_tokens or default_primary)
        token_fallbacks = [t for t in (16384, 8192, 4096) if t < primary_tokens]

        attempts: list[tuple[str | None, dict | None, int]] = []
        if schema is not None and self.compatible:
            for fmt in formats:
                attempts.append((efforts[0], fmt, primary_tokens))
            for eff in efforts[1:]:
                attempts.append((eff, formats[-1], min(primary_tokens, 16384)))
            for fb_tok in token_fallbacks:
                attempts.append((efforts[-1], formats[-1], fb_tok))
        else:
            for idx, eff in enumerate(efforts):
                tokens = primary_tokens if idx == 0 else min(primary_tokens, 16384)
                attempts.append((eff, formats[0], tokens))
            for fb_tok in token_fallbacks:
                attempts.append((efforts[-1], formats[0], fb_tok))

        seen: set[str] = set()
        unique_attempts = []
        for item in attempts:
            key = json.dumps(item, sort_keys=True)
            if key not in seen:
                seen.add(key)
                unique_attempts.append(item)
        return unique_attempts

    async def generate_full_strict(
        self, model_id, system, turns, schema, *, session_id: str | None = None, thinking: ThinkingLevel | None = None,
        max_output_tokens: int | None = None,
    ) -> CompletionResult:
        return await self._generate_full_impl(
            model_id, system, turns, schema,
            session_id=session_id, thinking=thinking, prefer_strict=True, max_output_tokens=max_output_tokens,
        )

    async def generate_full(
        self, model_id, system, turns, schema, *, session_id: str | None = None, thinking: ThinkingLevel | None = None,
        max_output_tokens: int | None = None,
    ) -> CompletionResult:
        return await self._generate_full_impl(
            model_id, system, turns, schema,
            session_id=session_id, thinking=thinking, prefer_strict=False, max_output_tokens=max_output_tokens,
        )

    async def _generate_full_impl(
        self,
        model_id,
        system,
        turns,
        schema,
        *,
        session_id: str | None = None,
        thinking: ThinkingLevel | None = None,
        prefer_strict: bool = False,
        max_output_tokens: int | None = None,
    ) -> CompletionResult:
        url = route(self.base_url, "chat/completions")
        headers = self.request_headers(session_id=session_id)
        attempts = self._attempt_configs(
            model_id, schema, thinking, prefer_strict=prefer_strict, max_output_tokens=max_output_tokens,
        )
        body = None
        for idx, (effort, resp_format, max_out) in enumerate(attempts):
            request = self._build_payload(
                model_id, system, turns, effort=effort, resp_format=resp_format, max_out=max_out,
            )
            try:
                body = await request_json(self.client, "POST", url, headers=headers, json=request)
                break
            except UpstreamRejected as error:
                if idx + 1 >= len(attempts) or error.upstream_status not in (400, 422):
                    raise
        assert body is not None
        choice = body["choices"][0]
        if choice.get("finish_reason") == "length":
            raise AppError(502, "PROVIDER_TRUNCATED_OUTPUT", "模型输出超过长度限制")
        message = choice["message"]
        raw_content = message.get("content") or ""
        content = text_parts(raw_content, text_type="text") if isinstance(raw_content, list) else raw_content
        reasoning = message.get("reasoning_content") or message.get("reasoning") or ""
        if not isinstance(reasoning, str):
            reasoning = ""
        if not reasoning and isinstance(content, str):
            content, inline_thought = split_inline_think(content)
            reasoning = inline_thought
        return CompletionResult(content=content, thinking=reasoning)

    async def stream_raw(
        self, model_id, system, turns, schema, *, session_id: str | None = None, thinking: ThinkingLevel | None = None,
        max_output_tokens: int | None = None,
    ) -> AsyncIterator[StreamDelta]:
        url = route(self.base_url, "chat/completions")
        headers = self.request_headers(session_id=session_id)
        attempts = self._attempt_configs(model_id, schema, thinking, max_output_tokens=max_output_tokens)
        for idx, (effort, resp_format, max_out) in enumerate(attempts):
            request = self._build_payload(
                model_id, system, turns, effort=effort, resp_format=resp_format, max_out=max_out, stream=True,
            )
            try:
                async with self.client.stream("POST", url, headers=headers, json=request) as response:
                    if not response.is_success:
                        await response.aread()
                        raise UpstreamRejected(response.status_code, extract_error_detail(response, headers))
                    splitter = ThinkTagSplitter()
                    async for event in iter_sse_json(response):
                        if "error" in event and event["error"]:
                            err = event["error"]
                            msg = err.get("message") if isinstance(err, dict) else str(err)
                            raise AppError(502, "PROVIDER_REQUEST_FAILED", f"供应商流式响应异常：{msg or '未知错误'}")
                        choices = event.get("choices") or []
                        if not choices:
                            continue
                        choice = choices[0]
                        delta = choice.get("delta") or {}
                        r_chunk = delta.get("reasoning_content") or delta.get("reasoning")
                        if isinstance(r_chunk, str) and r_chunk:
                            splitter.disable()
                            yield StreamDelta("thinking", r_chunk)
                        c_chunk = delta.get("content")
                        if isinstance(c_chunk, list):
                            c_chunk = text_parts(c_chunk, text_type="text")
                        if isinstance(c_chunk, str) and c_chunk:
                            for piece in splitter.feed(c_chunk):
                                yield piece
                        if choice.get("finish_reason") == "length":
                            raise AppError(502, "PROVIDER_TRUNCATED_OUTPUT", "模型输出超过长度限制")
                    for piece in splitter.flush():
                        yield piece
                    return
            except UpstreamRejected as error:
                if idx + 1 >= len(attempts) or error.upstream_status not in (400, 422):
                    raise
            except httpx.TimeoutException:
                raise AppError(502, "PROVIDER_TIMEOUT", "供应商流式响应超时") from None
            except (httpx.HTTPError, ValueError):
                raise AppError(502, "PROVIDER_UNREACHABLE", "无法连接供应商接口") from None


class OpenAICompatible(OpenAIChat):
    compatible = True


class OpenCodeFree(LLMClientAdapter):
    def __init__(self, bridge: OpenCodeBridge):
        self.bridge = bridge

    async def list_models(self) -> list[str]:
        return await self.bridge.models(refresh=True)

    async def generate_full(
        self, model_id: str, system: str, turns: list[Turn], schema: type[WireModel] | None,
        *, session_id: str | None = None, thinking: ThinkingLevel | None = None,
        max_output_tokens: int | None = None,
    ) -> CompletionResult:
        if any(turn.images for turn in turns):
            raise AppError(400, "OPENCODE_TEXT_ONLY", "OpenCode 免费桥接支持文字，请为图片问答选择支持视觉的供应商")
        messages = [{"role": "system", "content": system}]
        messages.extend({"role": turn.role, "content": turn.content} for turn in turns)
        return CompletionResult(await self.bridge.complete(model_id, messages))

    async def stream_raw(
        self, model_id: str, system: str, turns: list[Turn], schema: type[WireModel] | None,
        *, session_id: str | None = None, thinking: ThinkingLevel | None = None,
        max_output_tokens: int | None = None,
    ) -> AsyncIterator[StreamDelta]:
        result = await self.generate_full(
            model_id, system, turns, schema,
            session_id=session_id, thinking=thinking, max_output_tokens=max_output_tokens,
        )
        yield StreamDelta("content", result.content)


class AnthropicMessages(LLMClientAdapter):
    @property
    def headers(self) -> dict[str, str]:
        return {"x-api-key": self.key, "anthropic-version": "2023-06-01"}

    async def list_models(self) -> list[str]:
        url = route(self.base_url, "models", "v1")
        headers = self.request_headers(include_session=False)
        models = []
        seen = set()
        try:
            for _ in range(50):
                body = await request_json(self.client, "GET", url, headers=headers)
                models.extend(row["id"] for row in body["data"])
                if not body.get("has_more"):
                    return unique_ids(models)
                cursor = body["last_id"]
                if not cursor or cursor in seen:
                    break
                seen.add(cursor)
                url = with_params(url, {"after_id": cursor})
        except (KeyError, TypeError, AttributeError):
            raise invalid_response() from None
        raise invalid_response()

    @staticmethod
    def _thinking_attempts(
        schema: type[WireModel] | None,
        thinking: ThinkingLevel | None,
        max_output_tokens: int | None = None,
    ) -> list[tuple[dict | None, bool, int]]:
        has_schema = schema is not None
        if thinking in (None, "none"):
            top = max(8192, max_output_tokens or 16384)
            base: list[tuple[dict | None, bool, int]] = [(None, has_schema, top)]
            if has_schema:
                base.append((None, False, top))
            if top > 8192:
                base.append((None, False, 8192))
            return base
        budgets = {"low": (1024, 16384), "medium": (4096, 16384), "max": (10000, 32000)}
        budget, default_toks = budgets[thinking]
        max_toks = max(default_toks, (max_output_tokens or default_toks), budget + 4096)
        cfg = {"type": "enabled", "budget_tokens": budget}
        attempts: list[tuple[dict | None, bool, int]] = []
        if has_schema:
            attempts.append((cfg, True, max_toks))
        attempts.append((cfg, False, max_toks))
        if max_toks > 16384:
            attempts.append((cfg, False, max(16384, budget + 4096)))
        if has_schema:
            attempts.append((None, True, 8192))
        attempts.append((None, False, 8192))
        return attempts

    @staticmethod
    def _encode_anthropic_turn(turn: Turn) -> dict:
        if not turn.images:
            return {"role": turn.role, "content": turn.content}
        blocks: list[dict] = [
            {
                "type": "image",
                "source": {"type": "base64", "media_type": img.mime_type, "data": img.data_b64},
            }
            for img in turn.images
        ]
        blocks.append({"type": "text", "text": turn.content})
        return {"role": turn.role, "content": blocks}

    async def generate_full(
        self, model_id, system, turns, schema, *, session_id: str | None = None, thinking: ThinkingLevel | None = None,
        max_output_tokens: int | None = None,
    ) -> CompletionResult:
        url = route(self.base_url, "messages", "v1")
        headers = self.request_headers(session_id=session_id)
        attempts = self._thinking_attempts(schema, thinking, max_output_tokens)
        body = None
        for idx, (think_cfg, use_schema, max_toks) in enumerate(attempts):
            request: dict = {
                "model": model_id,
                "max_tokens": max_toks,
                "system": system,
                "messages": [self._encode_anthropic_turn(turn) for turn in turns],
            }
            if think_cfg is not None:
                request["thinking"] = think_cfg
            if use_schema and schema is not None:
                request["output_config"] = {
                    "format": {"type": "json_schema", "schema": output_schema(schema)}
                }
            try:
                body = await request_json(self.client, "POST", url, headers=headers, json=request)
                break
            except UpstreamRejected as error:
                if idx + 1 >= len(attempts) or error.upstream_status not in (400, 422):
                    raise
        assert body is not None
        if body.get("stop_reason") == "max_tokens":
            raise AppError(502, "PROVIDER_TRUNCATED_OUTPUT", "模型输出超过长度限制")
        parts = body["content"]
        return CompletionResult(
            content=text_parts(parts, text_type="text"),
            thinking=thought_parts(parts, anthropic=True),
        )

    async def stream_raw(
        self, model_id, system, turns, schema, *, session_id: str | None = None, thinking: ThinkingLevel | None = None,
        max_output_tokens: int | None = None,
    ) -> AsyncIterator[StreamDelta]:
        url = route(self.base_url, "messages", "v1")
        headers = self.request_headers(session_id=session_id)
        attempts = self._thinking_attempts(schema, thinking, max_output_tokens)
        for idx, (think_cfg, use_schema, max_toks) in enumerate(attempts):
            request: dict = {
                "model": model_id,
                "max_tokens": max_toks,
                "stream": True,
                "system": system,
                "messages": [self._encode_anthropic_turn(turn) for turn in turns],
            }
            if think_cfg is not None:
                request["thinking"] = think_cfg
            if use_schema and schema is not None:
                request["output_config"] = {
                    "format": {"type": "json_schema", "schema": output_schema(schema)}
                }
            try:
                async with self.client.stream("POST", url, headers=headers, json=request) as response:
                    if not response.is_success:
                        await response.aread()
                        raise UpstreamRejected(response.status_code, extract_error_detail(response, headers))
                    async for event in iter_sse_json(response):
                        kind = event.get("type")
                        if kind == "error":
                            err = event.get("error") or {}
                            raise AppError(502, "PROVIDER_REQUEST_FAILED", err.get("message") or "Anthropic 流式响应错误")
                        if kind == "content_block_delta":
                            delta = event.get("delta") or {}
                            d_type = delta.get("type")
                            if d_type == "thinking_delta" and isinstance(delta.get("thinking"), str):
                                yield StreamDelta("thinking", delta["thinking"])
                            elif d_type == "text_delta" and isinstance(delta.get("text"), str):
                                yield StreamDelta("content", delta["text"])
                        elif kind == "message_delta":
                            if (event.get("delta") or {}).get("stop_reason") == "max_tokens":
                                raise AppError(502, "PROVIDER_TRUNCATED_OUTPUT", "模型输出超过长度限制")
                    return
            except UpstreamRejected as error:
                if idx + 1 >= len(attempts) or error.upstream_status not in (400, 422):
                    raise
            except httpx.TimeoutException:
                raise AppError(502, "PROVIDER_TIMEOUT", "供应商流式响应超时") from None
            except (httpx.HTTPError, ValueError):
                raise AppError(502, "PROVIDER_UNREACHABLE", "无法连接供应商接口") from None


class GeminiContent(LLMClientAdapter):
    @property
    def headers(self) -> dict[str, str]:
        return {"x-goog-api-key": self.key}

    async def list_models(self) -> list[str]:
        url = route(self.base_url, "models", "v1beta")
        headers = self.request_headers(include_session=False)
        models = []
        seen = set()
        try:
            for _ in range(50):
                body = await request_json(self.client, "GET", url, headers=headers)
                models.extend(
                    row["name"].removeprefix("models/") for row in body.get("models", [])
                    if "generateContent" in row.get("supportedGenerationMethods", [])
                )
                cursor = body.get("nextPageToken")
                if not cursor:
                    return unique_ids(models)
                if cursor in seen:
                    break
                seen.add(cursor)
                url = with_params(url, {"pageToken": cursor})
        except (KeyError, TypeError, AttributeError):
            raise invalid_response() from None
        raise invalid_response()

    @staticmethod
    def _thinking_attempts(
        thinking: ThinkingLevel | None,
        max_output_tokens: int | None = None,
    ) -> list[tuple[dict | None, int]]:
        top = max(8192, max_output_tokens or 16384)
        max_top = max(32768, max_output_tokens or 32768)
        match thinking:
            case None:
                return [(None, top), (None, 8192)] if top > 8192 else [(None, top)]
            case "none":
                return [
                    ({"thinkingBudget": 0, "includeThoughts": False}, top),
                    ({"thinkingBudget": 128, "includeThoughts": False}, top),
                    (None, 8192),
                ]
            case "low":
                return [({"thinkingBudget": 1024, "includeThoughts": True}, top), (None, 8192)]
            case "medium":
                return [({"thinkingBudget": 4096, "includeThoughts": True}, max(top, 16384)), (None, 8192)]
            case "max":
                return [({"thinkingBudget": 16384, "includeThoughts": True}, max_top), (None, 16384)]
        return [(None, top)]

    def _build_gemini_body(
        self, system: str, turns: list[Turn], schema: type[WireModel] | None,
        think_cfg: dict | None, max_toks: int,
    ) -> dict:
        config: dict = {"maxOutputTokens": max_toks}
        if think_cfg is not None:
            config["thinkingConfig"] = think_cfg
        if schema is not None:
            config["responseMimeType"] = "application/json"
            config["responseSchema"] = output_schema(schema, gemini=True)
        def encode_gemini_parts(turn: Turn) -> list[dict]:
            parts: list[dict] = [{"text": turn.content}]
            for img in turn.images:
                parts.append({"inlineData": {"mimeType": img.mime_type, "data": img.data_b64}})
            return parts

        return {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [
                {"role": "model" if turn.role == "assistant" else "user", "parts": encode_gemini_parts(turn)}
                for turn in turns
            ],
            "generationConfig": config,
        }

    async def generate_full(
        self, model_id, system, turns, schema, *, session_id: str | None = None, thinking: ThinkingLevel | None = None,
        max_output_tokens: int | None = None,
    ) -> CompletionResult:
        model = quote(model_id.removeprefix("models/"), safe="")
        url = route(self.base_url, f"models/{model}:generateContent", "v1beta")
        headers = self.request_headers(session_id=session_id)
        attempts = self._thinking_attempts(thinking, max_output_tokens)
        body = None
        for idx, (think_cfg, max_toks) in enumerate(attempts):
            payload = self._build_gemini_body(system, turns, schema, think_cfg, max_toks)
            try:
                body = await request_json(self.client, "POST", url, headers=headers, json=payload)
                break
            except UpstreamRejected as error:
                if idx + 1 >= len(attempts) or error.upstream_status not in (400, 422):
                    raise
        assert body is not None
        candidate = body["candidates"][0]
        if candidate.get("finishReason") == "MAX_TOKENS":
            raise AppError(502, "PROVIDER_TRUNCATED_OUTPUT", "模型输出超过长度限制")
        parts = candidate["content"]["parts"]
        return CompletionResult(
            content=text_parts(parts),
            thinking=thought_parts(parts),
        )

    async def stream_raw(
        self, model_id, system, turns, schema, *, session_id: str | None = None, thinking: ThinkingLevel | None = None,
        max_output_tokens: int | None = None,
    ) -> AsyncIterator[StreamDelta]:
        model = quote(model_id.removeprefix("models/"), safe="")
        url = with_params(route(self.base_url, f"models/{model}:streamGenerateContent", "v1beta"), {"alt": "sse"})
        headers = self.request_headers(session_id=session_id)
        attempts = self._thinking_attempts(thinking, max_output_tokens)
        for idx, (think_cfg, max_toks) in enumerate(attempts):
            payload = self._build_gemini_body(system, turns, schema, think_cfg, max_toks)
            try:
                async with self.client.stream("POST", url, headers=headers, json=payload) as response:
                    if not response.is_success:
                        await response.aread()
                        raise UpstreamRejected(response.status_code, extract_error_detail(response, headers))
                    async for event in iter_sse_json(response):
                        candidates = event.get("candidates") or []
                        if not candidates:
                            continue
                        candidate = candidates[0]
                        parts = (candidate.get("content") or {}).get("parts") or []
                        for part in parts:
                            txt = part.get("text")
                            if isinstance(txt, str) and txt:
                                if part.get("thought", False):
                                    yield StreamDelta("thinking", txt)
                                else:
                                    yield StreamDelta("content", txt)
                        if candidate.get("finishReason") == "MAX_TOKENS":
                            raise AppError(502, "PROVIDER_TRUNCATED_OUTPUT", "模型输出超过长度限制")
                    return
            except UpstreamRejected as error:
                if idx + 1 >= len(attempts) or error.upstream_status not in (400, 422):
                    raise
            except httpx.TimeoutException:
                raise AppError(502, "PROVIDER_TIMEOUT", "供应商流式响应超时") from None
            except (httpx.HTTPError, ValueError):
                raise AppError(502, "PROVIDER_UNREACHABLE", "无法连接供应商接口") from None


ADAPTERS: dict[str, type[LLMClientAdapter]] = {
    "openai": OpenAIChat,
    "anthropic": AnthropicMessages,
    "gemini": GeminiContent,
    "openai-compatible": OpenAICompatible,
}


def llm_adapter(
    client: httpx.AsyncClient, config: LLMModelsRequest, *, opencode: OpenCodeBridge | None = None,
) -> LLMClientAdapter:
    if config.provider_id == OPENCODE_FREE_PROVIDER_ID:
        if opencode is None:
            raise AppError(503, "OPENCODE_UNAVAILABLE", "本机 OpenCode 桥接服务尚未就绪")
        return OpenCodeFree(opencode)
    return ADAPTERS[config.protocol](client, config)
