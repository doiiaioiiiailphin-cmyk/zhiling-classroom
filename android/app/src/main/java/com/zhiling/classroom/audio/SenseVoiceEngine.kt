package com.zhiling.classroom.audio

import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineSenseVoiceModelConfig
import com.zhiling.classroom.model.AppException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest

/**
 * 与桌面端 backend/app/services/builtin_asr.py 完全同源的免费离线 SenseVoice-Small int8 引擎。
 * 首次使用时按需从 ModelScope / hf-mirror 拉取并校验 SHA-256，下载后 100% 离线运行。
 */
class SenseVoiceEngine(
    rootDir: File,
    private val http: OkHttpClient,
) {
    val modelDir: File = File(rootDir, MODEL_DIRNAME)
    val modelFile: File = File(modelDir, MODEL_FILENAME)
    val tokensFile: File = File(modelDir, TOKENS_FILENAME)
    private val readyMarker: File = File(modelDir, READY_MARKER)

    private val downloadMutex = Mutex()
    private val recognizerLock = Any()
    private val recognizers = mutableMapOf<String, OfflineRecognizer>()

    fun isReady(): Boolean =
        readyMarker.isFile && modelFile.isFile && modelFile.length() > 10_000_000L && tokensFile.isFile

    fun requireReady() {
        if (!isReady()) {
            throw AppException(
                400,
                "BUILTIN_ASR_NOT_INSTALLED",
                "本地离线语音模型尚未下载，请在设置中点击一键下载（约 228 MB，下载后永久免费离线使用）",
            )
        }
    }

    fun transcribePcm16(pcm: ByteArray, language: String = "auto"): String {
        requireReady()
        val samples = pcm16LeToFloats(pcm)
        if (samples.isEmpty()) return ""
        val lang = normalizeLanguage(language)
        synchronized(recognizerLock) {
            val recognizer = recognizers.getOrPut(lang) { createRecognizer(lang) }
            val stream = recognizer.createStream()
            return try {
                stream.acceptWaveform(samples, 16_000)
                recognizer.decode(stream)
                cleanSenseVoiceText(recognizer.getResult(stream).text)
            } finally {
                stream.release()
            }
        }
    }

    fun release() = synchronized(recognizerLock) {
        recognizers.values.forEach { runCatching { it.release() } }
        recognizers.clear()
    }

    private fun createRecognizer(lang: String): OfflineRecognizer {
        val threads = (Runtime.getRuntime().availableProcessors() / 2).coerceIn(2, 4)
        val config = OfflineRecognizerConfig(
            featConfig = FeatureConfig(sampleRate = 16_000, featureDim = 80),
            modelConfig = OfflineModelConfig(
                senseVoice = OfflineSenseVoiceModelConfig(
                    model = modelFile.absolutePath,
                    language = lang,
                    useInverseTextNormalization = true,
                ),
                tokens = tokensFile.absolutePath,
                numThreads = threads,
                provider = "cpu",
                debug = false,
            ),
        )
        return OfflineRecognizer(assetManager = null, config = config)
    }

    fun downloadStream(): Flow<JsonObject> = flow {
        downloadMutex.withLock {
            if (isReady()) {
                emit(buildJsonObject {
                    put("type", "progress")
                    put("stage", "ready")
                    put("downloadedBytes", MODEL_EXPECTED_BYTES)
                    put("totalBytes", MODEL_EXPECTED_BYTES)
                    put("percent", 100)
                })
                emit(buildJsonObject { put("type", "done") })
                return@withLock
            }
            modelDir.mkdirs()
            emit(buildJsonObject {
                put("type", "progress")
                put("stage", "connecting")
                put("downloadedBytes", 0L)
                put("totalBytes", MODEL_EXPECTED_BYTES)
                put("percent", 0)
            })

            var lastError: Throwable? = null
            for (mirror in MODEL_MIRRORS) {
                try {
                    downloadSingleFile("$mirror/$TOKENS_FILENAME", tokensFile, TOKENS_SHA256, null)
                    downloadSingleFile("$mirror/$MODEL_FILENAME", modelFile, MODEL_SHA256) { done, total ->
                        val denom = if (total > 0L) total else MODEL_EXPECTED_BYTES
                        val pct = ((done * 100L) / denom).toInt().coerceIn(0, 99)
                        emit(buildJsonObject {
                            put("type", "progress")
                            put("stage", "downloading")
                            put("downloadedBytes", done)
                            put("totalBytes", denom)
                            put("percent", pct)
                        })
                    }
                    emit(buildJsonObject {
                        put("type", "progress")
                        put("stage", "verifying")
                        put("downloadedBytes", MODEL_EXPECTED_BYTES)
                        put("totalBytes", MODEL_EXPECTED_BYTES)
                        put("percent", 99)
                    })
                    readyMarker.writeText("ok\n", Charsets.UTF_8)
                    emit(buildJsonObject {
                        put("type", "progress")
                        put("stage", "ready")
                        put("downloadedBytes", MODEL_EXPECTED_BYTES)
                        put("totalBytes", MODEL_EXPECTED_BYTES)
                        put("percent", 100)
                    })
                    emit(buildJsonObject { put("type", "done") })
                    return@withLock
                } catch (e: Throwable) {
                    lastError = e
                }
            }
            throw AppException(
                502,
                "BUILTIN_ASR_DOWNLOAD_FAILED",
                "本地语音模型下载失败，请检查网络连接：${lastError?.message ?: "镜像均不可达"}",
            )
        }
    }.flowOn(Dispatchers.IO)

    private suspend fun downloadSingleFile(
        url: String,
        target: File,
        expectedSha256: String,
        onProgress: (suspend (Long, Long) -> Unit)?,
    ) {
        val part = File(target.parentFile, "${target.name}.part")
        val req = Request.Builder()
            .url(url)
            .header("User-Agent", "ZhilingClassroom-Android/1.0")
            .get()
            .build()

        val digest = MessageDigest.getInstance("SHA-256")
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                throw IllegalStateException("HTTP ${resp.code} from $url")
            }
            val body = resp.body ?: throw IllegalStateException("Empty body from $url")
            val total = body.contentLength()
            var done = 0L
            var lastEmitNs = 0L
            part.outputStream().use { out ->
                body.byteStream().use { input ->
                    val buf = ByteArray(131_072)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        out.write(buf, 0, n)
                        digest.update(buf, 0, n)
                        done += n
                        if (onProgress != null) {
                            val now = System.nanoTime()
                            if (now - lastEmitNs >= 150_000_000L) {
                                lastEmitNs = now
                                onProgress(done, total)
                            }
                        }
                    }
                }
            }
        }
        val actualSha = digest.digest().joinToString("") { "%02x".format(it) }
        if (expectedSha256.isNotEmpty() && !actualSha.equals(expectedSha256, ignoreCase = true)) {
            part.delete()
            throw IllegalStateException("SHA-256 mismatch for ${target.name}")
        }
        if (target.exists()) target.delete()
        part.renameTo(target)
    }

    companion object {
        const val MODEL_DIRNAME = "sense-voice-small-int8"
        const val MODEL_FILENAME = "model.int8.onnx"
        const val TOKENS_FILENAME = "tokens.txt"
        const val READY_MARKER = ".ready"
        const val MODEL_EXPECTED_BYTES = 239_233_841L
        const val MODEL_SHA256 = "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51"
        const val TOKENS_SHA256 = "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc"

        val MODEL_MIRRORS: List<String> = listOf(
            "https://www.modelscope.cn/models/poloniumrock/SenseVoiceSmallOnnx/resolve/master",
            "https://www.modelscope.cn/models/gomodels/sherpa-small/resolve/master/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
            "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main",
            "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main",
        )

        private val TAG_REGEX = Regex("""<\|[^|>]+\|>""")

        fun normalizeLanguage(lang: String): String = when (lang.trim().lowercase()) {
            "zh", "en", "ja", "ko", "yue" -> lang.trim().lowercase()
            else -> "auto"
        }

        fun cleanSenseVoiceText(raw: String): String =
            TAG_REGEX.replace(raw, "").replace(Regex("""\s+"""), " ").trim()

        fun pcm16LeToFloats(pcm: ByteArray): FloatArray {
            val count = pcm.size / 2
            if (count <= 0) return FloatArray(0)
            val out = FloatArray(count)
            val inv = 1.0f / 32768.0f
            var bi = 0
            for (i in 0 until count) {
                val lo = pcm[bi].toInt() and 0xFF
                val hi = pcm[bi + 1].toInt()
                val sample = (hi shl 8) or lo
                out[i] = sample * inv
                bi += 2
            }
            return out
        }

        fun computeRms(pcm: ByteArray, length: Int = pcm.size): Double {
            val count = length / 2
            if (count <= 0) return 0.0
            var sumSq = 0.0
            var i = 0
            while (i + 1 < length) {
                val lo = pcm[i].toInt() and 0xFF
                val hi = pcm[i + 1].toInt()
                val s = ((hi shl 8) or lo) / 32768.0
                sumSq += s * s
                i += 2
            }
            return kotlin.math.sqrt(sumSq / count)
        }
    }
}
