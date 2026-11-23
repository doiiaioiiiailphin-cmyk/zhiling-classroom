package com.zhiling.classroom.settings

import android.content.ContentValues
import com.zhiling.classroom.db.ClassroomDatabase
import com.zhiling.classroom.db.CryptoBox
import com.zhiling.classroom.model.ASRModelsRequest
import com.zhiling.classroom.model.AppSettings
import com.zhiling.classroom.model.AsrProviderConfig
import com.zhiling.classroom.model.DesktopHotkeys
import com.zhiling.classroom.model.FeatureModelBinding
import com.zhiling.classroom.model.FeatureRouting
import com.zhiling.classroom.model.LLMProviderConfig
import com.zhiling.classroom.model.WireJson
import com.zhiling.classroom.model.nowIsoUtc
import kotlinx.serialization.encodeToString

class SettingsManager(
    private val db: ClassroomDatabase,
    private val crypto: CryptoBox,
) {
    private val lock = Any()
    private var cached: AppSettings? = null

    fun get(): AppSettings = synchronized(lock) {
        cached?.let { return it }
        val loaded = readFromDb() ?: defaultSettings()
        val normalized = mergeMissingPresets(loaded)
        cached = normalized
        normalized
    }

    fun put(incoming: AppSettings): AppSettings = synchronized(lock) {
        val normalized = mergeMissingPresets(incoming)
        writeToDb(normalized)
        cached = normalized
        normalized
    }

    fun saveAsrCatalog(req: ASRModelsRequest, models: List<String>) = synchronized(lock) {
        val cur = get()
        val existing = cur.asrProviders[req.providerId] ?: return@synchronized
        val nextSelected = existing.selectedModelId.ifBlank { models.firstOrNull() ?: "" }
        val updated = existing.copy(
            availableModels = models,
            selectedModelId = nextSelected,
        )
        val nextProviders = cur.asrProviders.toMutableMap().apply { put(req.providerId, updated) }
        put(cur.copy(asrProviders = nextProviders))
    }

    private fun readFromDb(): AppSettings? {
        return try {
            val readable = db.readableDatabase
            readable.rawQuery("SELECT payload_encrypted FROM app_settings WHERE id = 1", null).use { cursor ->
                if (!cursor.moveToFirst()) return null
                val raw = cursor.getString(0) ?: return null
                val plain = crypto.decrypt(raw)
                if (plain.isBlank()) return null
                WireJson.decodeFromString<AppSettings>(plain)
            }
        } catch (_: Throwable) {
            null
        }
    }

    private fun writeToDb(settings: AppSettings) {
        val encoded = WireJson.encodeToString(settings)
        val encrypted = crypto.encrypt(encoded)
        val cv = ContentValues().apply {
            put("id", 1)
            put("payload_encrypted", encrypted)
            put("updated_at", nowIsoUtc())
        }
        db.writableDatabase.insertWithOnConflict(
            "app_settings",
            null,
            cv,
            android.database.sqlite.SQLiteDatabase.CONFLICT_REPLACE,
        )
    }

    private fun mergeMissingPresets(current: AppSettings): AppSettings {
        val defaults = defaultSettings()
        val llm = LinkedHashMap<String, LLMProviderConfig>(defaults.llmProviders)
        current.llmProviders.forEach { (k, v) ->
            if (k != "opencode-free-bridge") llm[k] = v
        }

        val asr = LinkedHashMap<String, AsrProviderConfig>(defaults.asrProviders)
        current.asrProviders.forEach { (k, v) -> asr[k] = v }

        val fallbackLlm = llm.entries.firstOrNull { (_, cfg) ->
            cfg.apiKey.isNotBlank() || (cfg.isCustom == true && cfg.baseUrl.isNotBlank())
        }?.key ?: defaults.selectedLlmProviderId

        val selectedLlm = if (current.selectedLlmProviderId != "opencode-free-bridge" && llm.containsKey(current.selectedLlmProviderId)) {
            current.selectedLlmProviderId
        } else {
            fallbackLlm
        }
        val selectedAsr = if (asr.containsKey(current.selectedAsrProviderId)) {
            current.selectedAsrProviderId
        } else {
            defaults.selectedAsrProviderId
        }
        fun sanitizeBinding(b: FeatureModelBinding, disableOnMigrate: Boolean): FeatureModelBinding {
            return if (b.providerId == "opencode-free-bridge" || !llm.containsKey(b.providerId)) {
                b.copy(
                    enabled = if (disableOnMigrate) false else b.enabled,
                    providerId = fallbackLlm,
                    modelId = "",
                )
            } else b
        }
        val cleanRouting = FeatureRouting(
            chat = sanitizeBinding(current.featureRouting.chat, disableOnMigrate = false),
            sentenceCorrection = sanitizeBinding(current.featureRouting.sentenceCorrection, disableOnMigrate = true),
            resegmentation = sanitizeBinding(current.featureRouting.resegmentation, disableOnMigrate = true),
            keyTermHighlight = sanitizeBinding(current.featureRouting.keyTermHighlight, disableOnMigrate = true),
            bubbleExplanation = sanitizeBinding(current.featureRouting.bubbleExplanation, disableOnMigrate = true),
        )
        return current.copy(
            selectedLlmProviderId = selectedLlm,
            llmProviders = llm,
            featureRouting = cleanRouting,
            selectedAsrProviderId = selectedAsr,
            asrProviders = asr,
        )
    }

    companion object {
        val LLM_PRESETS: List<LLMProviderConfig> = listOf(
            LLMProviderConfig("deepseek", "DeepSeek", null, "openai-compatible", "https://api.deepseek.com/v1"),
            LLMProviderConfig("openai", "OpenAI", null, "openai", "https://api.openai.com/v1"),
            LLMProviderConfig("anthropic", "Anthropic", null, "anthropic", "https://api.anthropic.com"),
            LLMProviderConfig("gemini", "Google Gemini", null, "gemini", "https://generativelanguage.googleapis.com"),
            LLMProviderConfig("aliyun", "阿里云百炼", null, "openai-compatible", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
            LLMProviderConfig("zhipu", "智谱 GLM", null, "openai-compatible", "https://open.bigmodel.cn/api/paas/v4"),
            LLMProviderConfig("moonshot", "月之暗面 Kimi", null, "openai-compatible", "https://api.moonshot.cn/v1"),
            LLMProviderConfig("volcengine", "火山方舟", null, "openai-compatible", "https://ark.cn-beijing.volces.com/api/v3"),
            LLMProviderConfig("siliconflow", "硅基流动", null, "openai-compatible", "https://api.siliconflow.cn/v1"),
            LLMProviderConfig("openrouter", "OpenRouter", null, "openai-compatible", "https://openrouter.ai/api/v1"),
            LLMProviderConfig("groq", "Groq", null, "openai-compatible", "https://api.groq.com/openai/v1"),
            LLMProviderConfig("custom", "自定义接口", true, "openai-compatible", ""),
        )

        val ASR_PRESETS: List<AsrProviderConfig> = listOf(
            AsrProviderConfig(
                providerId = "builtin-free-asr",
                name = "本地离线语音（SenseVoice）",
                protocol = "builtin-free-asr",
                baseUrl = "local://sensevoice",
                availableModels = listOf("sensevoice-small-int8"),
                selectedModelId = "sensevoice-small-int8",
            ),
            AsrProviderConfig(
                providerId = "openai-audio",
                name = "OpenAI 语音",
                protocol = "openai-audio",
                baseUrl = "https://api.openai.com/v1",
                availableModels = listOf("gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"),
                selectedModelId = "gpt-4o-mini-transcribe",
            ),
            AsrProviderConfig(
                providerId = "deepgram",
                name = "Deepgram",
                protocol = "deepgram",
                baseUrl = "wss://api.deepgram.com/v1/listen",
                availableModels = listOf("nova-3", "nova-2"),
                selectedModelId = "nova-3",
            ),
            AsrProviderConfig(
                providerId = "aliyun-asr",
                name = "阿里云通义听悟",
                protocol = "aliyun-tingwu",
                baseUrl = "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
                availableModels = listOf("paraformer-realtime-v2"),
                selectedModelId = "paraformer-realtime-v2",
            ),
            AsrProviderConfig(
                providerId = "volcengine-asr",
                name = "豆包流式语音",
                protocol = "volcengine-asr",
                baseUrl = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
                appId = "",
            ),
            AsrProviderConfig(
                providerId = "iflytek-asr",
                name = "科大讯飞转写",
                protocol = "iflytek-rtasr",
                baseUrl = "wss://rtasr.xfyun.cn/v1/ws",
                appId = "",
            ),
            AsrProviderConfig(
                providerId = "tencent-asr",
                name = "腾讯云语音",
                protocol = "tencent-asr",
                baseUrl = "wss://asr.cloud.tencent.com/asr/v2",
                appId = "",
            ),
            AsrProviderConfig(
                providerId = "assemblyai",
                name = "AssemblyAI",
                protocol = "assemblyai",
                baseUrl = "wss://streaming.assemblyai.com/v3/ws",
            ),
            AsrProviderConfig(
                providerId = "elevenlabs",
                name = "ElevenLabs",
                protocol = "elevenlabs-scribe",
                baseUrl = "https://api.elevenlabs.io/v1",
                availableModels = listOf("scribe_v1"),
                selectedModelId = "scribe_v1",
            ),
            AsrProviderConfig(
                providerId = "custom-asr",
                name = "自定义语音",
                isCustom = true,
                protocol = "custom-asr",
                baseUrl = "",
            ),
        )

        fun defaultSettings(): AppSettings {
            val llmMap = LinkedHashMap<String, LLMProviderConfig>()
            for (p in LLM_PRESETS) llmMap[p.providerId] = p

            val asrMap = LinkedHashMap<String, AsrProviderConfig>()
            for (p in ASR_PRESETS) asrMap[p.providerId] = p

            val chatBinding = FeatureModelBinding(
                enabled = true,
                providerId = "deepseek",
                modelId = "",
            )
            val disabledAutoBinding = FeatureModelBinding(
                enabled = false,
                providerId = "deepseek",
                modelId = "",
            )
            return AppSettings(
                selectedLlmProviderId = "deepseek",
                llmProviders = llmMap,
                featureRouting = FeatureRouting(
                    chat = chatBinding,
                    sentenceCorrection = disabledAutoBinding,
                    resegmentation = disabledAutoBinding,
                    keyTermHighlight = disabledAutoBinding,
                    bubbleExplanation = disabledAutoBinding,
                ),
                selectedAsrProviderId = "builtin-free-asr",
                asrProviders = asrMap,
                enableSpeakerDiarization = true,
                expectedSpeakerMode = "auto",
                recognitionLanguage = "zh-en",
                audioInputSource = "mic-only",
                audioDeviceId = "default",
                systemAudioDeviceId = "default",
                micEnabled = true,
                systemAudioEnabled = false,
                enableWebrtcAec3 = false,
                aec3PromptDismissed = true,
                enableDualChannelSpeakerSplit = false,
                globalHotwords = emptyList(),
                desktopHotkeys = DesktopHotkeys(enabled = false),
                enableVadAutoPause = false,
                autoSaveSession = true,
                defaultExportFormat = "markdown",
            )
        }
    }
}
