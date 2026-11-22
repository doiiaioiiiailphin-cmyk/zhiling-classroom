package com.zhiling.classroom.audio

import com.zhiling.classroom.model.ASRModelsRequest
import com.zhiling.classroom.model.AppException
import com.zhiling.classroom.model.AsrProviderConfig
import com.zhiling.classroom.model.WireJson
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * 移动端云端 ASR 适配（支持 OpenAI Audio / ElevenLabs Scribe / Custom HTTP Whisper 接口，
 * 并与本地离线 SenseVoice 共用同一分段切句管线）。
 */
class CloudAsrClient(
    private val http: OkHttpClient,
) {
    fun listModels(req: ASRModelsRequest): List<String> = when (req.protocol) {
        "builtin-free-asr" -> listOf("sensevoice-small-int8")
        "openai-audio", "custom-asr" -> {
            if (req.baseUrl.isBlank()) {
                listOf("gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1")
            } else {
                val url = req.baseUrl.trimEnd('/') + "/models"
                runCatching {
                    val call = Request.Builder()
                        .url(url)
                        .apply { if (req.apiKey.isNotBlank()) header("Authorization", "Bearer ${req.apiKey.trim()}") }
                        .get()
                        .build()
                    http.newCall(call).execute().use { resp ->
                        if (!resp.isSuccessful) error("HTTP ${resp.code}")
                        val root = WireJson.parseToJsonElement(resp.body?.string().orEmpty()).jsonObject
                        val ids = root["data"]?.jsonArray?.mapNotNull {
                            it.jsonObject["id"]?.jsonPrimitive?.contentOrNull
                        }.orEmpty()
                        val audioIds = ids.filter {
                            it.contains("whisper", true) || it.contains("transcribe", true) || it.contains("asr", true)
                        }
                        if (audioIds.isNotEmpty()) audioIds else listOf("gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1")
                    }
                }.getOrDefault(listOf("gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"))
            }
        }
        "deepgram" -> listOf("nova-3", "nova-2", "whisper-large")
        "aliyun-tingwu" -> listOf("paraformer-realtime-v2", "paraformer-realtime-8k-v2")
        "volcengine-asr" -> listOf("bigmodel-streaming")
        "iflytek-rtasr" -> listOf("rtasr-v1")
        "tencent-asr" -> listOf("16k_zh_large", "16k_zh", "16k_en")
        "assemblyai" -> listOf("universal-streaming")
        "elevenlabs-scribe" -> listOf("scribe_v1")
        else -> emptyList()
    }

    fun transcribeChunk(
        provider: AsrProviderConfig,
        pcm16k: ByteArray,
        language: String,
        hotwords: List<String>,
    ): String {
        val wavBytes = WavStorage.buildWavHeader(pcm16k.size.toLong()) + pcm16k
        return when (provider.protocol) {
            "openai-audio", "custom-asr" -> transcribeOpenAiCompatible(provider, wavBytes, language, hotwords)
            "elevenlabs-scribe" -> transcribeElevenLabs(provider, wavBytes, language)
            "deepgram" -> transcribeDeepgramRest(provider, wavBytes, language)
            else -> throw AppException(
                400,
                "ANDROID_ASR_PROTOCOL_UNSUPPORTED",
                "当前安卓版推荐优先使用「本地离线语音（SenseVoice）」或 OpenAI / Deepgram / ElevenLabs / 自定义兼容语音接口",
            )
        }
    }

    private fun transcribeOpenAiCompatible(
        provider: AsrProviderConfig,
        wavBytes: ByteArray,
        language: String,
        hotwords: List<String>,
    ): String {
        val base = provider.baseUrl.trim().trimEnd('/')
        if (base.isEmpty()) throw AppException(400, "ASR_BASE_URL_MISSING", "请填写语音接口 Base URL")
        val endpoint = if (base.endsWith("/audio/transcriptions")) base else "$base/audio/transcriptions"
        val model = provider.selectedModelId.ifBlank { "whisper-1" }

        val mp = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", "chunk.wav", wavBytes.toRequestBody("audio/wav".toMediaType()))
            .addFormDataPart("model", model)
            .addFormDataPart("response_format", "json")
        if (language == "zh" || language == "en") {
            mp.addFormDataPart("language", language)
        }
        if (hotwords.isNotEmpty()) {
            mp.addFormDataPart("prompt", hotwords.take(40).joinToString("、"))
        }

        val req = Request.Builder()
            .url(endpoint)
            .apply { if (provider.apiKey.isNotBlank()) header("Authorization", "Bearer ${provider.apiKey.trim()}") }
            .post(mp.build())
            .build()

        http.newCall(req).execute().use { resp ->
            val raw = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                throw AppException(502, "ASR_HTTP_ERROR", "语音识别接口返回 HTTP ${resp.code}")
            }
            val obj = WireJson.parseToJsonElement(raw).jsonObject
            return obj["text"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
        }
    }

    private fun transcribeElevenLabs(
        provider: AsrProviderConfig,
        wavBytes: ByteArray,
        language: String,
    ): String {
        val base = provider.baseUrl.trim().trimEnd('/').ifEmpty { "https://api.elevenlabs.io/v1" }
        val mp = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", "chunk.wav", wavBytes.toRequestBody("audio/wav".toMediaType()))
            .addFormDataPart("model_id", provider.selectedModelId.ifBlank { "scribe_v1" })
        if (language == "zh") mp.addFormDataPart("language_code", "zho")
        else if (language == "en") mp.addFormDataPart("language_code", "eng")

        val req = Request.Builder()
            .url("$base/speech-to-text")
            .header("xi-api-key", provider.apiKey.trim())
            .post(mp.build())
            .build()

        http.newCall(req).execute().use { resp ->
            val raw = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                throw AppException(502, "ASR_HTTP_ERROR", "ElevenLabs 接口返回 HTTP ${resp.code}")
            }
            return WireJson.parseToJsonElement(raw).jsonObject["text"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
        }
    }

    private fun transcribeDeepgramRest(
        provider: AsrProviderConfig,
        wavBytes: ByteArray,
        language: String,
    ): String {
        val model = provider.selectedModelId.ifBlank { "nova-2" }
        val langParam = when (language) {
            "zh" -> "zh-CN"
            "en" -> "en"
            else -> "multi"
        }
        val url = "https://api.deepgram.com/v1/listen?model=$model&language=$langParam&smart_format=true"
        val req = Request.Builder()
            .url(url)
            .header("Authorization", "Token ${provider.apiKey.trim()}")
            .post(wavBytes.toRequestBody("audio/wav".toMediaType()))
            .build()

        http.newCall(req).execute().use { resp ->
            val raw = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                throw AppException(502, "ASR_HTTP_ERROR", "Deepgram 接口返回 HTTP ${resp.code}")
            }
            val root = WireJson.parseToJsonElement(raw).jsonObject
            return root["results"]?.jsonObject
                ?.get("channels")?.jsonArray?.firstOrNull()?.jsonObject
                ?.get("alternatives")?.jsonArray?.firstOrNull()?.jsonObject
                ?.get("transcript")?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
        }
    }
}
