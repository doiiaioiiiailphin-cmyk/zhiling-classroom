package com.zhiling.classroom.ai

import android.util.Base64
import com.zhiling.classroom.model.AppException
import com.zhiling.classroom.model.LLMModelsRequest
import com.zhiling.classroom.model.LLMProviderConfig
import com.zhiling.classroom.model.WireJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.serialization.json.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.BufferedReader
import java.io.InputStreamReader

data class ImagePayload(
    val mimeType: String,
    val bytes: ByteArray,
)

data class ChatTurn(
    val role: String, // "user" | "assistant"
    val text: String,
    val images: List<ImagePayload> = emptyList(),
)

sealed interface LlmStreamEvent {
    data class ThinkingDelta(val delta: String) : LlmStreamEvent
    data class ContentDelta(val delta: String) : LlmStreamEvent
}

/**
 * 统一适配四大主流大模型协议（OpenAI / OpenAI-Compatible / Anthropic / Google Gemini），
 * 支持多模态图片（拍板书照片）、思考链分离与模型列表拉取。
 */
class LlmClient(
    private val http: OkHttpClient,
) {
    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    fun listModels(req: LLMModelsRequest): List<String> {
        val base = req.baseUrl.trim().trimEnd('/')
        val key = req.apiKey.trim()
        if (base.isEmpty()) throw AppException(400, "MISSING_BASE_URL", "请填写供应商 Base URL")
        if (key.isEmpty() && req.protocol != "openai-compatible") {
            throw AppException(400, "MISSING_API_KEY", "请先填写 API Key")
        }

        val httpReq = when (req.protocol) {
            "anthropic" -> Request.Builder()
                .url("$base/v1/models")
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .get()
                .build()
            "gemini" -> Request.Builder()
                .url("$base/v1beta/models?key=$key")
                .get()
                .build()
            else -> Request.Builder()
                .url("$base/models")
                .apply { if (key.isNotEmpty()) header("Authorization", "Bearer $key") }
                .get()
                .build()
        }

        http.newCall(httpReq).execute().use { resp ->
            val raw = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                throw AppException(502, "LIST_MODELS_FAILED", "获取模型列表失败（HTTP ${resp.code}）")
            }
            val root = WireJson.parseToJsonElement(raw).jsonObject
            return when (req.protocol) {
                "gemini" -> root["models"]?.jsonArray?.mapNotNull { el ->
                    el.jsonObject["name"]?.jsonPrimitive?.contentOrNull?.removePrefix("models/")
                }?.distinct()?.sorted().orEmpty()
                else -> root["data"]?.jsonArray?.mapNotNull { el ->
                    el.jsonObject["id"]?.jsonPrimitive?.contentOrNull
                }?.distinct()?.sorted().orEmpty()
            }
        }
    }

    fun streamCompletion(
        provider: LLMProviderConfig,
        modelId: String,
        systemPrompt: String,
        turns: List<ChatTurn>,
    ): Flow<LlmStreamEvent> = flow {
        val base = provider.baseUrl.trim().trimEnd('/')
        val key = provider.apiKey.trim()
        if (base.isEmpty() || modelId.isBlank()) {
            throw AppException(400, "MODEL_NOT_CONFIGURED", "请先在设置中配置大模型的 API Key 与模型")
        }

        when (provider.protocol) {
            "anthropic" -> streamAnthropic(base, key, modelId, systemPrompt, turns) { emit(it) }
            "gemini" -> streamGemini(base, key, modelId, systemPrompt, turns) { emit(it) }
            else -> streamOpenAi(base, key, modelId, systemPrompt, turns) { emit(it) }
        }
    }.flowOn(Dispatchers.IO)

    suspend fun completeText(
        provider: LLMProviderConfig,
        modelId: String,
        systemPrompt: String,
        userContent: String,
    ): Pair<String, String> {
        val content = StringBuilder()
        val thinking = StringBuilder()
        streamCompletion(provider, modelId, systemPrompt, listOf(ChatTurn("user", userContent))).collect { ev ->
            when (ev) {
                is LlmStreamEvent.ThinkingDelta -> thinking.append(ev.delta)
                is LlmStreamEvent.ContentDelta -> content.append(ev.delta)
            }
        }
        return Pair(content.toString().trim(), thinking.toString().trim())
    }

    private suspend fun streamOpenAi(
        base: String,
        apiKey: String,
        modelId: String,
        systemPrompt: String,
        turns: List<ChatTurn>,
        emit: suspend (LlmStreamEvent) -> Unit,
    ) {
        val messages = buildJsonArray {
            if (systemPrompt.isNotBlank()) {
                add(buildJsonObject {
                    put("role", "system")
                    put("content", systemPrompt)
                })
            }
            for (t in turns) {
                add(buildJsonObject {
                    put("role", t.role)
                    if (t.images.isEmpty()) {
                        put("content", t.text)
                    } else {
                        put("content", buildJsonArray {
                            add(buildJsonObject {
                                put("type", "text")
                                put("text", t.text)
                            })
                            for (img in t.images) {
                                val b64 = Base64.encodeToString(img.bytes, Base64.NO_WRAP)
                                add(buildJsonObject {
                                    put("type", "image_url")
                                    put("image_url", buildJsonObject {
                                        put("url", "data:${img.mimeType};base64,$b64")
                                    })
                                })
                            }
                        })
                    }
                })
            }
        }

        val payload = buildJsonObject {
            put("model", modelId)
            put("stream", true)
            put("messages", messages)
        }

        val req = Request.Builder()
            .url("$base/chat/completions")
            .apply { if (apiKey.isNotEmpty()) header("Authorization", "Bearer $apiKey") }
            .header("Accept", "text/event-stream")
            .post(payload.toString().toRequestBody(jsonMediaType))
            .build()

        val thinkParser = InlineThinkSplitter()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                throw AppException(502, "LLM_UPSTREAM_ERROR", "大模型接口异常（HTTP ${resp.code}）")
            }
            val body = resp.body ?: return
            BufferedReader(InputStreamReader(body.byteStream(), Charsets.UTF_8)).use { reader ->
                while (true) {
                    val line = reader.readLine() ?: break
                    if (!line.startsWith("data:")) continue
                    val data = line.removePrefix("data:").trim()
                    if (data.isEmpty() || data == "[DONE]") continue
                    val obj = runCatching { WireJson.parseToJsonElement(data).jsonObject }.getOrNull() ?: continue
                    val delta = obj["choices"]?.jsonArray?.firstOrNull()?.jsonObject?.get("delta")?.jsonObject ?: continue
                    val reasoning = delta["reasoning_content"]?.jsonPrimitive?.contentOrNull
                        ?: delta["reasoning"]?.jsonPrimitive?.contentOrNull
                    if (!reasoning.isNullOrEmpty()) {
                        emit(LlmStreamEvent.ThinkingDelta(reasoning))
                    }
                    val text = delta["content"]?.jsonPrimitive?.contentOrNull
                    if (!text.isNullOrEmpty()) {
                        for (ev in thinkParser.feed(text)) emit(ev)
                    }
                }
            }
        }
        for (ev in thinkParser.flush()) emit(ev)
    }

    private suspend fun streamAnthropic(
        base: String,
        apiKey: String,
        modelId: String,
        systemPrompt: String,
        turns: List<ChatTurn>,
        emit: suspend (LlmStreamEvent) -> Unit,
    ) {
        val messages = buildJsonArray {
            for (t in turns) {
                add(buildJsonObject {
                    put("role", t.role)
                    if (t.images.isEmpty()) {
                        put("content", t.text)
                    } else {
                        put("content", buildJsonArray {
                            for (img in t.images) {
                                val b64 = Base64.encodeToString(img.bytes, Base64.NO_WRAP)
                                add(buildJsonObject {
                                    put("type", "image")
                                    put("source", buildJsonObject {
                                        put("type", "base64")
                                        put("media_type", img.mimeType)
                                        put("data", b64)
                                    })
                                })
                            }
                            add(buildJsonObject {
                                put("type", "text")
                                put("text", t.text)
                            })
                        })
                    }
                })
            }
        }

        val payload = buildJsonObject {
            put("model", modelId)
            put("max_tokens", 4096)
            put("stream", true)
            if (systemPrompt.isNotBlank()) put("system", systemPrompt)
            put("messages", messages)
        }

        val req = Request.Builder()
            .url("$base/v1/messages")
            .header("x-api-key", apiKey)
            .header("anthropic-version", "2023-06-01")
            .header("Accept", "text/event-stream")
            .post(payload.toString().toRequestBody(jsonMediaType))
            .build()

        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                throw AppException(502, "LLM_UPSTREAM_ERROR", "Anthropic 接口异常（HTTP ${resp.code}）")
            }
            val body = resp.body ?: return
            BufferedReader(InputStreamReader(body.byteStream(), Charsets.UTF_8)).use { reader ->
                while (true) {
                    val line = reader.readLine() ?: break
                    if (!line.startsWith("data:")) continue
                    val data = line.removePrefix("data:").trim()
                    if (data.isEmpty()) continue
                    val obj = runCatching { WireJson.parseToJsonElement(data).jsonObject }.getOrNull() ?: continue
                    if (obj["type"]?.jsonPrimitive?.contentOrNull != "content_block_delta") continue
                    val delta = obj["delta"]?.jsonObject ?: continue
                    when (delta["type"]?.jsonPrimitive?.contentOrNull) {
                        "thinking_delta" -> delta["thinking"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotEmpty() }
                            ?.let { emit(LlmStreamEvent.ThinkingDelta(it)) }
                        "text_delta" -> delta["text"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotEmpty() }
                            ?.let { emit(LlmStreamEvent.ContentDelta(it)) }
                    }
                }
            }
        }
    }

    private suspend fun streamGemini(
        base: String,
        apiKey: String,
        modelId: String,
        systemPrompt: String,
        turns: List<ChatTurn>,
        emit: suspend (LlmStreamEvent) -> Unit,
    ) {
        val contents = buildJsonArray {
            for (t in turns) {
                add(buildJsonObject {
                    put("role", if (t.role == "assistant") "model" else "user")
                    put("parts", buildJsonArray {
                        for (img in t.images) {
                            val b64 = Base64.encodeToString(img.bytes, Base64.NO_WRAP)
                            add(buildJsonObject {
                                put("inlineData", buildJsonObject {
                                    put("mimeType", img.mimeType)
                                    put("data", b64)
                                })
                            })
                        }
                        add(buildJsonObject { put("text", t.text) })
                    })
                })
            }
        }

        val payload = buildJsonObject {
            if (systemPrompt.isNotBlank()) {
                put("systemInstruction", buildJsonObject {
                    put("parts", buildJsonArray { add(buildJsonObject { put("text", systemPrompt) }) })
                })
            }
            put("contents", contents)
        }

        val req = Request.Builder()
            .url("$base/v1beta/models/$modelId:streamGenerateContent?alt=sse&key=$apiKey")
            .header("Accept", "text/event-stream")
            .post(payload.toString().toRequestBody(jsonMediaType))
            .build()

        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                throw AppException(502, "LLM_UPSTREAM_ERROR", "Gemini 接口异常（HTTP ${resp.code}）")
            }
            val body = resp.body ?: return
            BufferedReader(InputStreamReader(body.byteStream(), Charsets.UTF_8)).use { reader ->
                while (true) {
                    val line = reader.readLine() ?: break
                    if (!line.startsWith("data:")) continue
                    val data = line.removePrefix("data:").trim()
                    if (data.isEmpty()) continue
                    val obj = runCatching { WireJson.parseToJsonElement(data).jsonObject }.getOrNull() ?: continue
                    val parts = obj["candidates"]?.jsonArray?.firstOrNull()?.jsonObject
                        ?.get("content")?.jsonObject?.get("parts")?.jsonArray ?: continue
                    for (p in parts) {
                        val po = p.jsonObject
                        val text = po["text"]?.jsonPrimitive?.contentOrNull ?: continue
                        val isThought = po["thought"]?.jsonPrimitive?.booleanOrNull == true
                        if (text.isNotEmpty()) {
                            emit(if (isThought) LlmStreamEvent.ThinkingDelta(text) else LlmStreamEvent.ContentDelta(text))
                        }
                    }
                }
            }
        }
    }
}

/**
 * 实时分离模型正文中的内联 `<think>...</think>` 思考过程。
 */
class InlineThinkSplitter {
    private var inThink = false
    private val pending = StringBuilder()

    fun feed(chunk: String): List<LlmStreamEvent> {
        pending.append(chunk)
        val out = mutableListOf<LlmStreamEvent>()
        while (true) {
            val tag = if (inThink) "</think>" else "<think>"
            val idx = pending.indexOf(tag)
            if (idx >= 0) {
                if (idx > 0) {
                    val part = pending.substring(0, idx)
                    out.add(if (inThink) LlmStreamEvent.ThinkingDelta(part) else LlmStreamEvent.ContentDelta(part))
                }
                pending.delete(0, idx + tag.length)
                inThink = !inThink
            } else {
                val keep = tag.length - 1
                if (pending.length > keep) {
                    val safeLen = pending.length - keep
                    val part = pending.substring(0, safeLen)
                    pending.delete(0, safeLen)
                    out.add(if (inThink) LlmStreamEvent.ThinkingDelta(part) else LlmStreamEvent.ContentDelta(part))
                }
                break
            }
        }
        return out
    }

    fun flush(): List<LlmStreamEvent> {
        if (pending.isEmpty()) return emptyList()
        val tail = pending.toString()
        pending.clear()
        return listOf(if (inThink) LlmStreamEvent.ThinkingDelta(tail) else LlmStreamEvent.ContentDelta(tail))
    }
}
