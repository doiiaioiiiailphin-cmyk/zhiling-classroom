package com.zhiling.classroom.service

import android.media.AudioDeviceInfo
import android.media.projection.MediaProjection
import com.zhiling.classroom.ai.ClassroomAiService
import com.zhiling.classroom.audio.AndroidAudioRecorder
import com.zhiling.classroom.audio.AndroidSystemAudioRecorder
import com.zhiling.classroom.audio.AudioChannelMixer
import com.zhiling.classroom.audio.CloudAsrClient
import com.zhiling.classroom.audio.SenseVoiceEngine
import com.zhiling.classroom.audio.WavAppendWriter
import com.zhiling.classroom.audio.WavStorage
import com.zhiling.classroom.db.ClassroomRepository
import com.zhiling.classroom.model.*
import com.zhiling.classroom.settings.SettingsManager
import io.ktor.websocket.DefaultWebSocketSession
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.serialization.json.*
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

data class ActiveRecordingSnapshot(
    val sessionId: String,
    val sessionTitle: String,
    val isRecording: Boolean,
    val durationSeconds: Int,
    val micActive: Boolean = true,
    val systemAudioActive: Boolean = false,
)

/**
 * 课堂实时流调度中心：
 * - 录音采集（麦克风 + Android 10+ 系统媒体内录双轨混音）、WAV 持久化、能量切句与 SenseVoice/云端 ASR 全部驻留于 ForegroundService 作用域内；
 * - 即使手机锁屏导致 WebView WebSocket 休眠断开，录音与转写依然 100% 持续运行；
 * - 亮屏后 WebView 重新连接 WebSocket，立即收到最新分段与实时录制状态。
 */
class StreamManager(
    private val scope: CoroutineScope,
    private val repo: ClassroomRepository,
    private val settingsManager: SettingsManager,
    private val wavStorage: WavStorage,
    private val senseVoice: SenseVoiceEngine,
    private val cloudAsr: CloudAsrClient,
    private val aiService: ClassroomAiService,
    private val onRecordingStateChanged: (ActiveRecordingSnapshot?) -> Unit,
    private val mediaProjectionProvider: () -> MediaProjection? = { null },
    private val preferredMicDeviceResolver: (String) -> AudioDeviceInfo? = { null },
) {
    private val sockets = ConcurrentHashMap<String, MutableSet<DefaultWebSocketSession>>()
    private val desktopSockets = ConcurrentHashMap.newKeySet<DefaultWebSocketSession>()

    private val recordingLock = Any()
    @Volatile
    private var activeRun: ActiveRecordingRun? = null
    @Volatile
    private var pendingMicOverride: Boolean? = null
    @Volatile
    private var pendingSysOverride: Boolean? = null
    @Volatile
    private var pendingMicDeviceOverride: String? = null
    @Volatile
    private var pendingDualSplitOverride: Boolean? = null

    fun activeSnapshot(): ActiveRecordingSnapshot? = activeRun?.snapshot()

    fun onMediaProjectionRevoked() {
        val cur = activeRun ?: return
        cur.onSystemAudioRevoked()
        onRecordingStateChanged(cur.snapshot())
    }

    suspend fun publish(sessionId: String, type: String, payload: JsonObject) {
        val frameText = buildJsonObject {
            put("type", type)
            put("payload", payload)
        }.toString()
        val set = sockets[sessionId] ?: return
        val dead = mutableListOf<DefaultWebSocketSession>()
        for (ws in set) {
            try {
                ws.send(Frame.Text(frameText))
            } catch (_: Throwable) {
                dead.add(ws)
            }
        }
        dead.forEach { set.remove(it) }
    }

    suspend fun publishDesktopEvent(type: String, payload: JsonObject) {
        val frameText = buildJsonObject {
            put("type", type)
            put("payload", payload)
        }.toString()
        val dead = mutableListOf<DefaultWebSocketSession>()
        for (ws in desktopSockets) {
            try {
                ws.send(Frame.Text(frameText))
            } catch (_: Throwable) {
                dead.add(ws)
            }
        }
        dead.forEach { desktopSockets.remove(it) }
    }

    private fun buildNativeOverlaySnapshotJson(): JsonObject? {
        val run = activeRun
        val targetSessionId = run?.sessionId ?: return null
        val snap = run.snapshot()
        val segs = runCatching { repo.listSegments(targetSessionId) }.getOrDefault(emptyList())
        val lines = mutableListOf<JsonObject>()
        for (seg in segs) {
            for (u in seg.utterances) {
                val txt = (u.refinedText ?: u.rawText).trim()
                if (txt.isNotEmpty()) {
                    lines.add(
                        buildJsonObject {
                            put("id", u.id)
                            put("speaker", u.speakerLabel)
                            put("text", txt)
                            put("time", u.timestampText)
                        }
                    )
                }
            }
        }
        val msgs = runCatching { repo.listMessages(targetSessionId, emptyMap()) }
            .getOrDefault(emptyList())
            .takeLast(24)
            .map { m ->
                buildJsonObject {
                    put("id", m.id)
                    put("role", m.role)
                    put("content", m.content)
                    if (!m.thinking.isNullOrBlank()) put("thinking", m.thinking)
                }
            }
        return buildJsonObject {
            put("sessionId", targetSessionId)
            put("sessionTitle", snap.sessionTitle)
            put("isRecording", snap.isRecording)
            put("durationSeconds", snap.durationSeconds)
            put("micEnabled", settingsManager.get().micEnabled)
            put("recentLines", JsonArray(lines.takeLast(80)))
            put("partialLine", JsonNull)
            put("recentMessages", JsonArray(msgs))
        }
    }

    private fun scheduleNativeOverlaySnapshotBroadcast() {
        if (desktopSockets.isEmpty()) return
        scope.launch(Dispatchers.IO) {
            val snap = buildNativeOverlaySnapshotJson() ?: return@launch
            publishDesktopEvent("overlay.snapshot", snap)
        }
    }

    suspend fun handleDesktopSocket(ws: DefaultWebSocketSession) {
        desktopSockets.add(ws)
        try {
            // 新连入的 Android 悬浮窗立即收到当前后台录音快照（即使主界面在后台挂起也能实时显示字幕）
            buildNativeOverlaySnapshotJson()?.let { snap ->
                val frameText = buildJsonObject {
                    put("type", "overlay.snapshot")
                    put("payload", snap)
                }.toString()
                runCatching { ws.send(Frame.Text(frameText)) }
            }
            for (frame in ws.incoming) {
                if (frame is Frame.Text) {
                    val txt = frame.readText()
                    val parsed = runCatching { WireJson.parseToJsonElement(txt).jsonObject }.getOrNull()
                    val evType = parsed?.get("type")?.jsonPrimitive?.contentOrNull
                    val cmdType = parsed?.get("payload")?.jsonObject?.get("type")?.jsonPrimitive?.contentOrNull
                    if (evType == "overlay.command" && cmdType != null) {
                        if (cmdType == "request-snapshot") {
                            buildNativeOverlaySnapshotJson()?.let { snap ->
                                val frameText = buildJsonObject {
                                    put("type", "overlay.snapshot")
                                    put("payload", snap)
                                }.toString()
                                runCatching { ws.send(Frame.Text(frameText)) }
                            }
                        } else if (desktopSockets.size <= 1) {
                            // 若主界面 WebView 已在后台断开，由 ForegroundService 原生直接响应悬浮窗快捷控制
                            when (cmdType) {
                                "toggle-recording" -> toggleRecordingFromNotification()
                                "bookmark-confused" -> bookmarkConfusedFromNotification()
                                "toggle-mic" -> {
                                    val curCfg = settingsManager.get()
                                    val nextMic = !curCfg.micEnabled
                                    settingsManager.put(curCfg.copy(micEnabled = nextMic))
                                    activeRun?.setMicMuted(!nextMic)
                                    scheduleNativeOverlaySnapshotBroadcast()
                                }
                            }
                        }
                    }
                    // Relay overlay snapshots/commands between peers
                    for (peer in desktopSockets) {
                        if (peer !== ws) runCatching { peer.send(Frame.Text(txt)) }
                    }
                }
            }
        } finally {
            desktopSockets.remove(ws)
        }
    }

    suspend fun handleSessionSocket(sessionId: String, ws: DefaultWebSocketSession) {
        val set = sockets.computeIfAbsent(sessionId) { ConcurrentHashMap.newKeySet() }
        set.add(ws)
        try {
            // Immediately push current segments so reconnecting after lock-screen catches up 100%
            val segs = repo.listSegments(sessionId)
            if (segs.isNotEmpty()) {
                publish(
                    sessionId,
                    "segments.regrouped",
                    buildJsonObject { put("segments", WireJson.encodeToJsonElement(segs)) },
                )
            }
            for (frame in ws.incoming) {
                when (frame) {
                    is Frame.Text -> handleCommandText(sessionId, frame.readText())
                    is Frame.Binary -> {
                        // Also accept browser-pushed PCM frames if ever used in hybrid testing
                        activeRun?.takeIf { it.sessionId == sessionId }?.feedExternalPcm(frame.data)
                    }
                    else -> {}
                }
            }
        } finally {
            set.remove(ws)
            // NOTE: Intentionally do NOT stop activeRun when WebView disconnects on screen lock!
            // Native recording stays alive in ForegroundService until user explicitly pauses/stops.
        }
    }

    private suspend fun handleCommandText(sessionId: String, raw: String) {
        val obj = runCatching { WireJson.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return
        val type = obj["type"]?.jsonPrimitive?.contentOrNull ?: return
        when (type) {
            "recording.start", "recording.resume" -> {
                try {
                    startNativeRecording(sessionId)
                } catch (e: AppException) {
                    publish(
                        sessionId,
                        "error",
                        buildJsonObject {
                            put("code", e.code)
                            put("message", e.message)
                        },
                    )
                }
            }
            "recording.pause" -> pauseRecording(sessionId)
            "recording.stop" -> stopRecording(sessionId)
            "mic.mute" -> {
                val muted = obj["payload"]?.jsonObject?.get("muted")?.jsonPrimitive?.booleanOrNull ?: false
                activeRun?.setMicMuted(muted)
            }
            "audio.channels" -> {
                val payload = obj["payload"]?.jsonObject ?: return
                val micEnabled = payload["micEnabled"]?.jsonPrimitive?.booleanOrNull
                val sysEnabled = payload["systemAudioEnabled"]?.jsonPrimitive?.booleanOrNull
                val micDeviceId = payload["micDeviceId"]?.jsonPrimitive?.contentOrNull
                val dualSplit = payload["enableDualChannelSpeakerSplit"]?.jsonPrimitive?.booleanOrNull
                pendingMicOverride = micEnabled
                pendingSysOverride = sysEnabled
                pendingMicDeviceOverride = micDeviceId
                pendingDualSplitOverride = dualSplit
                val cur = activeRun
                if (cur != null && cur.sessionId == sessionId && cur.isRunning()) {
                    cur.updateChannels(
                        micEnabled = micEnabled,
                        systemAudioEnabled = sysEnabled,
                        dualSplitEnabled = dualSplit,
                    )
                    onRecordingStateChanged(cur.snapshot())
                }
            }
        }
    }

    fun startNativeRecording(sessionId: String) = synchronized(recordingLock) {
        val cur = activeRun
        if (cur != null && cur.sessionId == sessionId && cur.isRunning()) {
            onRecordingStateChanged(cur.snapshot())
            return@synchronized
        }
        cur?.stop(finalStatus = "paused")

        val settings = settingsManager.get()
        val provider = settings.asrProviders[settings.selectedAsrProviderId]
            ?: throw AppException(400, "ASR_NOT_CONFIGURED", "请在设置中选择语音识别供应商")
        if (provider.protocol == "builtin-free-asr") {
            senseVoice.requireReady()
        }
        val effectiveMicEnabled = pendingMicOverride ?: settings.micEnabled
        val effectiveSysEnabled = pendingSysOverride ?: settings.systemAudioEnabled
        val effectiveMicDeviceId = pendingMicDeviceOverride ?: settings.audioDeviceId
        val effectiveDualSplit = pendingDualSplitOverride ?: settings.enableDualChannelSpeakerSplit
        pendingMicOverride = null
        pendingSysOverride = null
        pendingMicDeviceOverride = null
        pendingDualSplitOverride = null

        val card = repo.getSessionCard(sessionId)
        val run = ActiveRecordingRun(
            sessionId = sessionId,
            sessionTitle = card.title,
            asrProvider = provider,
            language = settings.recognitionLanguage,
            hotwords = (repo.folderHotwordsForSession(sessionId) + settings.globalHotwords).distinct(),
            initialMicEnabled = effectiveMicEnabled,
            initialSysEnabled = effectiveSysEnabled,
            micDeviceId = effectiveMicDeviceId,
            initialDualSplit = effectiveDualSplit,
        )
        activeRun = run
        run.start()
        onRecordingStateChanged(run.snapshot())
    }

    fun pauseRecording(sessionId: String? = null) = synchronized(recordingLock) {
        val cur = activeRun ?: return@synchronized
        if (sessionId != null && cur.sessionId != sessionId) return@synchronized
        cur.stop(finalStatus = "paused")
        activeRun = null
        onRecordingStateChanged(null)
    }

    fun stopRecording(sessionId: String? = null) = synchronized(recordingLock) {
        val cur = activeRun ?: return@synchronized
        if (sessionId != null && cur.sessionId != sessionId) return@synchronized
        cur.stop(finalStatus = "paused")
        activeRun = null
        onRecordingStateChanged(null)
    }

    fun toggleRecordingFromNotification() {
        val cur = activeRun
        if (cur != null && cur.isRunning()) {
            val sid = cur.sessionId
            pauseRecording(sid)
            scope.launch {
                publishDesktopEvent("hotkey.triggered", buildJsonObject { put("action", "toggleRecording") })
            }
        }
    }

    fun bookmarkConfusedFromNotification() {
        val cur = activeRun ?: return
        scope.launch(Dispatchers.IO) {
            runCatching {
                val (segId, utt, createdSeg) = repo.bookmarkNow(
                    cur.sessionId,
                    BookmarkNowRequest(kind = "confused", timestampMs = cur.currentOffsetMs()),
                )
                if (createdSeg) {
                    publish(
                        cur.sessionId,
                        "segments.regrouped",
                        buildJsonObject { put("segments", WireJson.encodeToJsonElement(repo.listSegments(cur.sessionId))) },
                    )
                }
                publish(
                    cur.sessionId,
                    "utterance.updated",
                    buildJsonObject {
                        put("segmentId", segId)
                        put("utterance", WireJson.encodeToJsonElement(utt))
                    },
                )
            }
        }
    }

    fun deleteSessionSafely(sessionId: String) {
        val cur = activeRun
        if (cur != null && cur.sessionId == sessionId && cur.isRunning()) {
            throw AppException(409, "SESSION_STREAM_ACTIVE", "请先暂停当前课堂录音后再删除")
        }
        wavStorage.deleteSessionAudio(sessionId)
        repo.deleteSession(sessionId)
    }

    suspend fun retranscribeGap(sessionId: String): RetranscribeGapResult = withContext(Dispatchers.IO) {
        if (activeRun?.sessionId == sessionId && activeRun?.isRunning() == true) {
            throw AppException(409, "SESSION_STREAM_ACTIVE", "请先暂停当前录音后再补转写")
        }
        val audioMs = wavStorage.existingDurationMs(sessionId)
        if (audioMs <= 0L) throw AppException(404, "AUDIO_NOT_FOUND", "当前课堂暂无本地录音文件")
        val segs = repo.listSegments(sessionId)
        val lastUttMs = segs.flatMap { it.utterances }.maxOfOrNull { it.endTimeMs } ?: 0L
        if (audioMs - lastUttMs < 1500L) {
            return@withContext RetranscribeGapResult(0, lastUttMs, audioMs)
        }
        val pcm = wavStorage.readPcmWindow(sessionId, lastUttMs, audioMs)
        val count = transcribeBatchPcm(sessionId, pcm, lastUttMs)
        RetranscribeGapResult(count, lastUttMs, audioMs)
    }

    fun importWavAudioStream(
        folderId: String?,
        title: String?,
        fileName: String,
        rawBytes: ByteArray,
    ): Flow<JsonObject> = flow {
        val settings = settingsManager.get()
        val provider = settings.asrProviders[settings.selectedAsrProviderId]
            ?: throw AppException(400, "ASR_NOT_CONFIGURED", "请先选择语音识别供应商")
        if (provider.protocol == "builtin-free-asr") senseVoice.requireReady()

        emit(buildJsonObject {
            put("type", "progress")
            put("stage", "decoding")
            put("downloadedBytes", 0L)
            put("totalBytes", rawBytes.size.toLong())
            put("percent", 10)
        })

        // Extract PCM16 16kHz from WAV header (or reject non-WAV gracefully with clear hint)
        if (rawBytes.size <= 44 || String(rawBytes, 0, 4, Charsets.US_ASCII) != "RIFF") {
            throw AppException(400, "UNSUPPORTED_AUDIO_FORMAT", "当前安卓端音频导入支持 16kHz WAV 文件")
        }
        val pcm = rawBytes.copyOfRange(44, rawBytes.size)
        val durationMs = pcm.size.toLong() / WavStorage.BYTES_PER_MS
        val created = repo.createSession(folderId)
        val sid = created.session.id
        val cleanTitle = (title ?: fileName.substringBeforeLast(".")).trim().ifEmpty { created.session.title }
        repo.patchSession(
            sid,
            SessionPatchRequest(title = cleanTitle, status = "paused", durationSeconds = maxOf(1, (durationMs / 1000L).toInt())),
        )
        wavStorage.openWriter(sid).use { it.append(pcm) }
        repo.checkpointSession(sid, durationMs, status = "paused", audioPath = wavStorage.fileFor(sid).absolutePath)

        emit(buildJsonObject {
            put("type", "progress")
            put("stage", "transcribing")
            put("downloadedBytes", 0L)
            put("totalBytes", pcm.size.toLong())
            put("percent", 25)
        })

        transcribeBatchPcm(sid, pcm, 0L) { pct ->
            emit(buildJsonObject {
                put("type", "progress")
                put("stage", "transcribing")
                put("downloadedBytes", 0L)
                put("totalBytes", pcm.size.toLong())
                put("percent", 25 + (pct * 65) / 100)
            })
        }

        val finalWs = repo.workspace(sid, audioDurationMs = durationMs)
        emit(buildJsonObject {
            put("type", "done")
            put("data", WireJson.encodeToJsonElement(finalWs))
        })
    }.flowOn(Dispatchers.IO)

    private suspend fun transcribeBatchPcm(
        sessionId: String,
        pcm: ByteArray,
        offsetMs: Long,
        onPercent: (suspend (Int) -> Unit)? = null,
    ): Int {
        val settings = settingsManager.get()
        val provider = settings.asrProviders[settings.selectedAsrProviderId]
            ?: throw AppException(400, "ASR_NOT_CONFIGURED", "请先选择语音识别供应商")
        val hotwords = (repo.folderHotwordsForSession(sessionId) + settings.globalHotwords).distinct()
        val chunkBytes = 16_000 * 2 * 8 // 8 seconds per chunk
        var pos = 0
        var count = 0
        while (pos < pcm.size) {
            val end = minOf(pcm.size, pos + chunkBytes)
            val slice = pcm.copyOfRange(pos, end)
            val startMs = offsetMs + (pos.toLong() / WavStorage.BYTES_PER_MS)
            val endMs = offsetMs + (end.toLong() / WavStorage.BYTES_PER_MS)
            val text = runAsrOnChunk(provider, slice, settings.recognitionLanguage, hotwords)
            if (text.isNotBlank()) {
                val saved = repo.saveFinalUtterance(sessionId, "default", text, startMs, endMs)
                count++
                if (saved.createdInitialSegment != null) {
                    publish(
                        sessionId,
                        "segments.regrouped",
                        buildJsonObject { put("segments", WireJson.encodeToJsonElement(listOf(saved.createdInitialSegment))) },
                    )
                }
                publish(
                    sessionId,
                    "utterance.final",
                    buildJsonObject {
                        put("segmentId", saved.segmentId)
                        put("utterance", WireJson.encodeToJsonElement(saved.utterance))
                    },
                )
            }
            pos = end
            onPercent?.invoke(((pos.toLong() * 100L) / maxOf(1, pcm.size)).toInt())
        }
        return count
    }

    private fun runAsrOnChunk(
        provider: AsrProviderConfig,
        pcm: ByteArray,
        language: String,
        hotwords: List<String>,
    ): String {
        return if (provider.protocol == "builtin-free-asr") {
            senseVoice.transcribePcm16(pcm, language)
        } else {
            cloudAsr.transcribeChunk(provider, pcm, language, hotwords)
        }
    }

    private data class UtteranceChunk(
        val pcm: ByteArray,
        val startMs: Long,
        val endMs: Long,
        val speakerChannel: String = "default",
    )

    private inner class ActiveRecordingRun(
        val sessionId: String,
        val sessionTitle: String,
        val asrProvider: AsrProviderConfig,
        val language: String,
        val hotwords: List<String>,
        initialMicEnabled: Boolean,
        initialSysEnabled: Boolean,
        private val micDeviceId: String,
        initialDualSplit: Boolean,
    ) {
        private val running = AtomicBoolean(false)
        private val wavWriter: WavAppendWriter = wavStorage.openWriter(sessionId)
        private val baseOffsetMs: Long = maxOf(repo.sessionDurationMs(sessionId), wavWriter.durationMs())
        @Volatile
        private var recordedPcmBytes: Long = 0L

        @Volatile
        private var micEnabled = initialMicEnabled
        @Volatile
        private var sysEnabled = initialSysEnabled
        @Volatile
        private var dualSplitEnabled = initialDualSplit

        private val asrQueue = Channel<UtteranceChunk>(capacity = 64)
        private var asrWorkerJob: Job? = null
        private var tickerJob: Job? = null

        private val segBuffer = ByteArrayOutputStream(16_000 * 2 * 12)
        private var segStartMs: Long = baseOffsetMs
        private var speechDetectedInSeg = false
        private var consecutiveSilenceMs = 0
        private var segMicEnergy = 0.0
        private var segSysEnergy = 0.0
        private var lastTelemetryAtMs = 0L

        private val sysQueueLock = Any()
        private val sysQueue = ArrayDeque<Pair<ByteArray, Double>>(8)

        private var micRecorder: AndroidAudioRecorder? = null
        private var sysRecorder: AndroidSystemAudioRecorder? = null

        fun isRunning(): Boolean = running.get()

        fun setMicMuted(muted: Boolean) {
            micEnabled = !muted
            micRecorder?.setMuted(muted)
        }

        @Synchronized
        fun updateChannels(
            micEnabled: Boolean? = null,
            systemAudioEnabled: Boolean? = null,
            dualSplitEnabled: Boolean? = null,
        ) {
            if (dualSplitEnabled != null) {
                this.dualSplitEnabled = dualSplitEnabled
            }
            if (micEnabled != null) {
                this.micEnabled = micEnabled
                val currentMic = micRecorder
                if (micEnabled && running.get() && (currentMic == null || !currentMic.isRunning())) {
                    startMicTrack()
                } else {
                    currentMic?.setMuted(!micEnabled)
                }
            }
            if (systemAudioEnabled != null) {
                this.sysEnabled = systemAudioEnabled
                if (systemAudioEnabled) {
                    if (running.get() && sysRecorder?.isRunning() != true) {
                        startSystemTrack()
                    } else {
                        sysRecorder?.setMuted(false)
                    }
                } else {
                    stopSystemTrack()
                }
            }
        }

        @Synchronized
        fun onSystemAudioRevoked() {
            sysEnabled = false
            stopSystemTrack()
        }

        fun currentOffsetMs(): Long = baseOffsetMs + (recordedPcmBytes / WavStorage.BYTES_PER_MS)

        fun snapshot(): ActiveRecordingSnapshot = ActiveRecordingSnapshot(
            sessionId = sessionId,
            sessionTitle = sessionTitle,
            isRecording = running.get(),
            durationSeconds = (currentOffsetMs() / 1000L).toInt(),
            micActive = micRecorder?.isRunning() == true && micEnabled,
            systemAudioActive = sysRecorder?.isRunning() == true && sysEnabled,
        )

        private fun startMicTrack() {
            val preferred = preferredMicDeviceResolver(micDeviceId)
            val rec = AndroidAudioRecorder(
                onPcmFrame = { pcm, len, rms -> onMicFrame(pcm, len, rms) },
                onError = { msg ->
                    scope.launch {
                        publish(
                            sessionId,
                            "error",
                            buildJsonObject {
                                put("code", "ANDROID_AUDIO_ERROR")
                                put("message", msg)
                            },
                        )
                    }
                },
                preferredDevice = preferred,
            ).apply { setMuted(!micEnabled) }
            micRecorder = rec
            rec.start()
        }

        private fun startSystemTrack() {
            val projection = mediaProjectionProvider()
            if (projection == null) {
                sysEnabled = false
                if (!micEnabled) {
                    scope.launch {
                        publish(
                            sessionId,
                            "error",
                            buildJsonObject {
                                put("code", "SYS_AUDIO_NOT_AUTHORIZED")
                                put("message", "尚未获取系统声音内录权限，请重新点击开始录音并在弹窗中授权")
                            },
                        )
                    }
                }
                return
            }
            val rec = AndroidSystemAudioRecorder(
                mediaProjection = projection,
                onPcmFrame = { pcm, len, rms -> onSysFrame(pcm, len, rms) },
                onError = { msg ->
                    scope.launch {
                        publish(
                            sessionId,
                            "error",
                            buildJsonObject {
                                put("code", "ANDROID_SYS_AUDIO_ERROR")
                                put("message", msg)
                            },
                        )
                    }
                },
            )
            if (rec.start()) {
                sysRecorder = rec
            } else {
                sysEnabled = false
            }
        }

        private fun stopSystemTrack() {
            sysRecorder?.stop()
            sysRecorder = null
            synchronized(sysQueueLock) { sysQueue.clear() }
        }

        fun start() {
            if (!running.compareAndSet(false, true)) return
            repo.checkpointSession(
                sessionId,
                currentOffsetMs(),
                status = "recording",
                audioPath = wavStorage.fileFor(sessionId).absolutePath,
            )
            asrWorkerJob = scope.launch(Dispatchers.IO) {
                for (chunk in asrQueue) {
                    runCatching {
                        val text = runAsrOnChunk(asrProvider, chunk.pcm, language, hotwords).trim()
                        if (text.isNotEmpty() && !ClassroomAiService.isTrivialFiller(text)) {
                            val saved = repo.saveFinalUtterance(
                                sessionId,
                                chunk.speakerChannel,
                                text,
                                chunk.startMs,
                                chunk.endMs,
                            )
                            if (saved.createdInitialSegment != null) {
                                publish(
                                    sessionId,
                                    "segments.regrouped",
                                    buildJsonObject {
                                        put("segments", WireJson.encodeToJsonElement(listOf(saved.createdInitialSegment)))
                                    },
                                )
                            }
                            publish(
                                sessionId,
                                "utterance.final",
                                buildJsonObject {
                                    put("segmentId", saved.segmentId)
                                    put("utterance", WireJson.encodeToJsonElement(saved.utterance))
                                },
                            )
                            scheduleNativeOverlaySnapshotBroadcast()
                            // Fire-and-forget AI refinement / resegmentation / highlight
                            scope.launch(Dispatchers.IO) {
                                aiService.runBackgroundPostProcess(sessionId, saved.segmentId, saved.utterance, ::publish)
                            }
                        }
                    }.onFailure { err ->
                        publish(
                            sessionId,
                            "error",
                            buildJsonObject {
                                put("code", "ASR_RECOGNIZE_ERROR")
                                put("message", err.message ?: "语音转写失败")
                            },
                        )
                    }
                }
            }
            tickerJob = scope.launch(Dispatchers.IO) {
                while (running.get()) {
                    delay(1000)
                    if (!running.get()) break
                    val nowMs = currentOffsetMs()
                    repo.checkpointSession(sessionId, nowMs, status = "recording")
                    onRecordingStateChanged(snapshot())
                    scheduleNativeOverlaySnapshotBroadcast()
                }
            }
            if (sysEnabled) {
                startSystemTrack()
            }
            // 若开启麦克风，或系统内录未能启动则回退麦克风，保证始终有有效时钟源
            if (micEnabled || sysRecorder?.isRunning() != true) {
                startMicTrack()
            }
        }

        fun feedExternalPcm(pcm: ByteArray) {
            if (!running.get() || pcm.isEmpty()) return
            onAudioFrame(pcm, pcm.size, SenseVoiceEngine.computeRms(pcm, pcm.size), 0.0)
        }

        private fun onMicFrame(pcm: ByteArray, length: Int, micRms: Double) {
            if (!running.get() || length <= 0) return
            val sysPair = synchronized(sysQueueLock) {
                if (sysQueue.isNotEmpty()) sysQueue.removeFirst() else null
            }
            val effectiveMicPcm = if (micEnabled) pcm else null
            val effectiveMicRms = if (micEnabled) micRms else 0.0
            val effectiveSysPcm = if (sysEnabled) sysPair?.first else null
            val effectiveSysRms = if (sysEnabled) (sysPair?.second ?: 0.0) else 0.0
            val mixed = if (effectiveSysPcm != null) {
                AudioChannelMixer.mixPcm16Mono(effectiveMicPcm, effectiveSysPcm, length)
            } else if (effectiveMicPcm != null) {
                effectiveMicPcm
            } else {
                ByteArray(length)
            }
            onAudioFrame(mixed, mixed.size, effectiveMicRms, effectiveSysRms)
        }

        private fun onSysFrame(pcm: ByteArray, length: Int, sysRms: Double) {
            if (!running.get() || length <= 0 || !sysEnabled) return
            // 纯系统内录模式（麦克风轨未运行）：由系统内录线程直接驱动混音与转写时钟
            if (micRecorder?.isRunning() != true) {
                onAudioFrame(pcm, length, 0.0, sysRms)
                return
            }
            synchronized(sysQueueLock) {
                while (sysQueue.size >= 8) {
                    sysQueue.removeFirst()
                }
                sysQueue.addLast(pcm.copyOf(length) to sysRms)
            }
        }

        @Synchronized
        private fun onAudioFrame(pcm: ByteArray, length: Int, micRms: Double, sysRms: Double) {
            if (!running.get() || length <= 0) return
            val frameStartMs = currentOffsetMs()
            wavWriter.append(pcm, 0, length)
            recordedPcmBytes += length
            val frameMs = (length / WavStorage.BYTES_PER_MS).coerceAtLeast(1)

            // Emit throttled RMS telemetry to WebView audio meters (~120ms)
            val now = System.currentTimeMillis()
            if (now - lastTelemetryAtMs >= 120L) {
                lastTelemetryAtMs = now
                val micLevel = (micRms * 4.2).coerceIn(0.0, 1.0)
                val sysLevel = (sysRms * 4.2).coerceIn(0.0, 1.0)
                scope.launch {
                    publish(
                        sessionId,
                        "audio.telemetry",
                        buildJsonObject {
                            put("micLevel", micLevel)
                            put("sysLevel", sysLevel)
                        },
                    )
                }
            }

            val combinedRms = maxOf(micRms, sysRms)
            val isSpeech = combinedRms >= SPEECH_RMS_THRESHOLD
            if (segBuffer.size() == 0) {
                segStartMs = frameStartMs
                segMicEnergy = 0.0
                segSysEnergy = 0.0
            }
            segBuffer.write(pcm, 0, length)
            segMicEnergy += micRms * micRms
            segSysEnergy += sysRms * sysRms
            if (isSpeech) {
                speechDetectedInSeg = true
                consecutiveSilenceMs = 0
            } else {
                consecutiveSilenceMs += frameMs
            }

            val segDurationMs = segBuffer.size() / WavStorage.BYTES_PER_MS
            val shouldFlush = (speechDetectedInSeg && consecutiveSilenceMs >= SILENCE_END_MS && segDurationMs >= MIN_UTT_MS) ||
                (speechDetectedInSeg && segDurationMs >= MAX_UTT_MS)

            if (shouldFlush) {
                flushSegmentLocked(currentOffsetMs())
            } else if (!speechDetectedInSeg && segDurationMs >= 3000) {
                // Drop pure long silence from RAM buffer (still archived in WAV!)
                segBuffer.reset()
                segMicEnergy = 0.0
                segSysEnergy = 0.0
                consecutiveSilenceMs = 0
            }
        }

        private fun flushSegmentLocked(endMs: Long) {
            if (segBuffer.size() <= 0 || !speechDetectedInSeg) {
                segBuffer.reset()
                segMicEnergy = 0.0
                segSysEnergy = 0.0
                speechDetectedInSeg = false
                consecutiveSilenceMs = 0
                return
            }
            val bytes = segBuffer.toByteArray()
            val start = segStartMs
            val speakerChannel = AudioChannelMixer.resolveSpeakerChannel(
                micEnergy = segMicEnergy,
                sysEnergy = segSysEnergy,
                splitEnabled = dualSplitEnabled,
                micActive = micEnabled && micRecorder?.isRunning() == true,
                sysActive = sysEnabled && sysRecorder?.isRunning() == true,
            )
            segBuffer.reset()
            segMicEnergy = 0.0
            segSysEnergy = 0.0
            speechDetectedInSeg = false
            consecutiveSilenceMs = 0
            asrQueue.trySend(UtteranceChunk(bytes, start, endMs, speakerChannel))
        }

        fun stop(finalStatus: String) {
            if (!running.compareAndSet(true, false)) return
            micRecorder?.stop()
            micRecorder = null
            stopSystemTrack()
            synchronized(this) {
                flushSegmentLocked(currentOffsetMs())
            }
            asrQueue.close()
            tickerJob?.cancel()
            wavWriter.close()
            repo.checkpointSession(
                sessionId,
                currentOffsetMs(),
                status = finalStatus,
                audioPath = wavStorage.fileFor(sessionId).absolutePath,
            )
        }
    }

    companion object {
        private const val SPEECH_RMS_THRESHOLD = 0.012
        private const val SILENCE_END_MS = 780
        private const val MIN_UTT_MS = 650
        private const val MAX_UTT_MS = 9500
    }
}
