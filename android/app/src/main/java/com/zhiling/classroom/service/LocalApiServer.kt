package com.zhiling.classroom.service

import android.content.res.AssetManager
import com.zhiling.classroom.ai.ClassroomAiService
import com.zhiling.classroom.ai.LlmClient
import com.zhiling.classroom.audio.CloudAsrClient
import com.zhiling.classroom.audio.SenseVoiceEngine
import com.zhiling.classroom.audio.WavStorage
import com.zhiling.classroom.db.ClassroomRepository
import com.zhiling.classroom.export.SessionExporter
import com.zhiling.classroom.model.*
import com.zhiling.classroom.settings.SettingsManager
import com.zhiling.classroom.update.AndroidUpdater
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.cio.*
import io.ktor.server.engine.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import java.io.IOException
import java.net.ServerSocket
import java.time.Duration

/**
 * 嵌入式 Ktor CIO 本地服务端（127.0.0.1:随机端口）：
 * 完整实现桌面端 backend/app/api.py 的所有 REST / SSE / WebSocket 路由，
 * 同时从 APK assets/www/ 托管打包好的 React 前端 dist/，确保零跨域与原生音频 Range 回放。
 */
class LocalApiServer(
    private val assets: AssetManager,
    private val repo: ClassroomRepository,
    private val settingsManager: SettingsManager,
    private val wavStorage: WavStorage,
    private val senseVoice: SenseVoiceEngine,
    private val cloudAsr: CloudAsrClient,
    private val llmClient: LlmClient,
    private val aiService: ClassroomAiService,
    private val streams: StreamManager,
    private val updater: AndroidUpdater,
    private val onRequestCameraCapture: ((String, Long?, String?) -> Unit)? = null,
    private val audioDevicesProvider: () -> NativeAudioDevices = {
        NativeAudioDevices(
            platform = "android",
            wasapiSupported = true,
            inputs = listOf(
                NativeAudioEndpoint(
                    id = "default",
                    rawId = "default",
                    name = "手机内置麦克风（含硬件降噪）",
                    isDefault = true,
                    isCommunicationsDefault = true,
                )
            ),
            loopbacks = listOf(
                NativeAudioEndpoint(
                    id = "default",
                    rawId = "android-playback-capture",
                    name = "手机系统媒体声音内录（支持耳机/网课）",
                    isDefault = true,
                    isCommunicationsDefault = true,
                )
            ),
        )
    },
) {
    private var engine: ApplicationEngine? = null
    @Volatile
    var boundPort: Int = 0
        private set

    fun start(): Int {
        if (engine != null && boundPort > 0) return boundPort
        val port = findFreeLocalPort()
        val server = embeddedServer(CIO, host = "127.0.0.1", port = port) {
            install(WebSockets) {
                pingPeriod = Duration.ofSeconds(25)
                timeout = Duration.ofSeconds(60)
                maxFrameSize = Long.MAX_VALUE
                masking = false
            }

            routing {
                route("/api/v1") {
                    // -------- Folders --------
                    get("/folders") {
                        call.respondApi { DataEnvelope(repo.listFolders()) }
                    }
                    post("/folders") {
                        call.respondApi(HttpStatusCode.Created) {
                            val req = WireJson.decodeFromString<FolderCreateRequest>(call.receiveText())
                            DataEnvelope(repo.createFolder(req))
                        }
                    }
                    patch("/folders/{id}") {
                        call.respondApi {
                            val id = call.parameters["id"]!!
                            val req = WireJson.decodeFromString<FolderPatchRequest>(call.receiveText())
                            DataEnvelope(repo.patchFolder(id, req))
                        }
                    }
                    delete("/folders/{id}") {
                        call.respondNoContent { repo.deleteFolder(call.parameters["id"]!!) }
                    }

                    // -------- Sessions & Workspace --------
                    get("/sessions") {
                        call.respondApi { DataEnvelope(repo.listSessions()) }
                    }
                    post("/sessions") {
                        call.respondApi(HttpStatusCode.Created) {
                            val raw = call.receiveText().ifBlank { "{}" }
                            val req = WireJson.decodeFromString<SessionCreateRequest>(raw)
                            DataEnvelope(repo.createSession(req.folderId))
                        }
                    }
                    patch("/sessions/{id}") {
                        call.respondApi {
                            val id = call.parameters["id"]!!
                            val req = WireJson.decodeFromString<SessionPatchRequest>(call.receiveText())
                            DataEnvelope(repo.patchSession(id, req))
                        }
                    }
                    delete("/sessions/{id}") {
                        call.respondNoContent { streams.deleteSessionSafely(call.parameters["id"]!!) }
                    }
                    get("/sessions/{id}/workspace") {
                        call.respondApi {
                            val id = call.parameters["id"]!!
                            val audioMs = wavStorage.existingDurationMs(id)
                            DataEnvelope(repo.workspace(id, audioDurationMs = audioMs))
                        }
                    }
                    patch("/sessions/{sessionId}/speakers/{speakerId}") {
                        call.respondNoContent {
                            val sid = call.parameters["sessionId"]!!
                            val spkId = call.parameters["speakerId"]!!
                            val req = WireJson.decodeFromString<SpeakerRenameRequest>(call.receiveText())
                            repo.renameSpeaker(sid, spkId, req.label)
                        }
                    }

                    // -------- AI Chat / Explain / Notes / Flashcards --------
                    post("/sessions/{sessionId}/segments/{segmentId}/explain/stream") {
                        val sid = call.parameters["sessionId"]!!
                        val segId = call.parameters["segmentId"]!!
                        call.respondSse(aiService.explainSegmentStream(sid, segId))
                    }
                    post("/sessions/{sessionId}/chat/stream") {
                        val sid = call.parameters["sessionId"]!!
                        val req = WireJson.decodeFromString<ChatRequest>(call.receiveText())
                        call.respondSse(aiService.chatStream(sid, req.content, req.attachmentIds))
                    }
                    post("/sessions/{sessionId}/notes/stream") {
                        val sid = call.parameters["sessionId"]!!
                        call.respondSse(aiService.notesStream(sid))
                    }
                    post("/sessions/{sessionId}/flashcards") {
                        call.respondApi {
                            val sid = call.parameters["sessionId"]!!
                            DataEnvelope(aiService.generateFlashcards(sid))
                        }
                    }

                    // -------- Export & Audio Playback --------
                    post("/sessions/{sessionId}/export") {
                        try {
                            val sid = call.parameters["sessionId"]!!
                            val req = WireJson.decodeFromString<SessionExportRequest>(call.receiveText())
                            val ws = repo.workspace(sid, wavStorage.existingDurationMs(sid))
                            val doc = SessionExporter.export(ws, req)
                            call.response.header(HttpHeaders.ContentDisposition, doc.contentDisposition)
                            call.respondBytes(doc.bytes, ContentType.parse(doc.mimeType))
                        } catch (e: AppException) {
                            call.respondAppError(e)
                        }
                    }
                    get("/sessions/{sessionId}/audio") {
                        try {
                            val sid = call.parameters["sessionId"]!!
                            repo.ensureSessionExists(sid)
                            val slice = wavStorage.readWavRange(sid, call.request.headers[HttpHeaders.Range])
                            slice.headers.forEach { (k, v) -> call.response.header(k, v) }
                            call.respondBytes(
                                slice.bytes,
                                ContentType.parse("audio/wav"),
                                HttpStatusCode.fromValue(slice.statusCode),
                            )
                        } catch (e: AppException) {
                            call.respondAppError(e)
                        }
                    }
                    post("/sessions/{sessionId}/retranscribe-gap") {
                        call.respondApi {
                            val sid = call.parameters["sessionId"]!!
                            DataEnvelope(streams.retranscribeGap(sid))
                        }
                    }
                    post("/sessions/import-audio") {
                        val fileName = call.request.queryParameters["fileName"] ?: "recording.wav"
                        val title = call.request.queryParameters["title"]
                        val folderId = call.request.queryParameters["folderId"]
                        val raw = call.receive<ByteArray>()
                        call.respondSse(streams.importWavAudioStream(folderId, title, fileName, raw))
                    }

                    // -------- Utterances & Bookmarks --------
                    patch("/sessions/{sessionId}/utterances/{utteranceId}") {
                        call.respondApi {
                            val sid = call.parameters["sessionId"]!!
                            val uid = call.parameters["utteranceId"]!!
                            val req = WireJson.decodeFromString<UtterancePatchRequest>(call.receiveText())
                            val (segId, updated) = repo.patchUtterance(sid, uid, req)
                            streams.publish(
                                sid,
                                "utterance.updated",
                                buildJsonObject {
                                    put("segmentId", segId)
                                    put("utterance", WireJson.encodeToJsonElement(updated))
                                },
                            )
                            DataEnvelope(updated)
                        }
                    }
                    post("/sessions/{sessionId}/bookmarks/now") {
                        call.respondApi {
                            val sid = call.parameters["sessionId"]!!
                            val raw = call.receiveText().ifBlank { "{}" }
                            val req = WireJson.decodeFromString<BookmarkNowRequest>(raw)
                            val (segId, updated, createdSeg) = repo.bookmarkNow(sid, req)
                            if (createdSeg) {
                                streams.publish(
                                    sid,
                                    "segments.regrouped",
                                    buildJsonObject { put("segments", WireJson.encodeToJsonElement(repo.listSegments(sid))) },
                                )
                                streams.publish(
                                    sid,
                                    "utterance.final",
                                    buildJsonObject {
                                        put("segmentId", segId)
                                        put("utterance", WireJson.encodeToJsonElement(updated))
                                    },
                                )
                            } else {
                                streams.publish(
                                    sid,
                                    "utterance.updated",
                                    buildJsonObject {
                                        put("segmentId", segId)
                                        put("utterance", WireJson.encodeToJsonElement(updated))
                                    },
                                )
                            }
                            DataEnvelope(BookmarkNowResponse(segId, updated))
                        }
                    }

                    // -------- Attachments & Blackboard Camera --------
                    post("/sessions/{sessionId}/attachments") {
                        call.respondApi(HttpStatusCode.Created) {
                            val sid = call.parameters["sessionId"]!!
                            val fileName = call.request.queryParameters["fileName"] ?: "image.png"
                            val mimeType = call.request.queryParameters["mimeType"]
                                ?: call.request.contentType().toString().ifBlank { "application/octet-stream" }
                            val kind = call.request.queryParameters["kind"]
                            val segmentId = call.request.queryParameters["segmentId"]
                            val tsMs = call.request.queryParameters["timestampMs"]?.toLongOrNull()
                            val caption = call.request.queryParameters["caption"]
                            val raw = call.receive<ByteArray>()
                            val item = repo.saveAttachment(sid, fileName, mimeType, raw, kind, segmentId, tsMs, caption)
                            streams.publish(
                                sid,
                                "attachment.created",
                                buildJsonObject { put("attachment", WireJson.encodeToJsonElement(item)) },
                            )
                            DataEnvelope(item)
                        }
                    }
                    post("/sessions/{sessionId}/capture-screen") {
                        val sid = call.parameters["sessionId"]!!
                        val raw = call.receiveText().ifBlank { "{}" }
                        val req = WireJson.decodeFromString<CaptureScreenRequest>(raw)
                        onRequestCameraCapture?.invoke(sid, req.timestampMs, req.segmentId)
                        call.respondAppError(
                            AppException(
                                400,
                                "ANDROID_USE_CAMERA_CAPTURE",
                                "请使用相机拍板书按钮或相册上传课堂画面",
                            )
                        )
                    }
                    get("/sessions/{sessionId}/attachments/{attachmentId}/raw") {
                        try {
                            val sid = call.parameters["sessionId"]!!
                            val aid = call.parameters["attachmentId"]!!
                            val (bytes, mime, _) = repo.readAttachmentRaw(sid, aid)
                            call.response.header(HttpHeaders.CacheControl, "private, max-age=86400")
                            call.respondBytes(bytes, ContentType.parse(mime))
                        } catch (e: AppException) {
                            call.respondAppError(e)
                        }
                    }
                    delete("/sessions/{sessionId}/attachments/{attachmentId}") {
                        call.respondNoContent {
                            val sid = call.parameters["sessionId"]!!
                            val aid = call.parameters["attachmentId"]!!
                            repo.deleteAttachment(sid, aid)
                            streams.publish(sid, "attachment.deleted", buildJsonObject { put("attachmentId", aid) })
                        }
                    }

                    // -------- Sticky Notes --------
                    get("/sessions/{sessionId}/sticky-notes") {
                        call.respondApi { DataEnvelope(repo.listStickyNotes(call.parameters["sessionId"]!!)) }
                    }
                    post("/sessions/{sessionId}/sticky-notes") {
                        call.respondApi(HttpStatusCode.Created) {
                            val sid = call.parameters["sessionId"]!!
                            val req = WireJson.decodeFromString<StickyNoteCreateRequest>(call.receiveText().ifBlank { "{}" })
                            DataEnvelope(repo.createStickyNote(sid, req))
                        }
                    }
                    patch("/sessions/{sessionId}/sticky-notes/{noteId}") {
                        call.respondApi {
                            val sid = call.parameters["sessionId"]!!
                            val nid = call.parameters["noteId"]!!
                            val req = WireJson.decodeFromString<StickyNotePatchRequest>(call.receiveText())
                            DataEnvelope(repo.updateStickyNote(sid, nid, req))
                        }
                    }
                    patch("/sessions/{sessionId}/sticky-notes") {
                        call.respondApi {
                            val sid = call.parameters["sessionId"]!!
                            val req = WireJson.decodeFromString<StickyNoteBatchOpenRequest>(call.receiveText())
                            DataEnvelope(repo.setAllStickyNotesOpen(sid, req.isOpen))
                        }
                    }
                    delete("/sessions/{sessionId}/sticky-notes/{noteId}") {
                        call.respondNoContent {
                            repo.deleteStickyNote(call.parameters["sessionId"]!!, call.parameters["noteId"]!!)
                        }
                    }

                    // -------- Search & Settings & Providers --------
                    get("/search") {
                        call.respondApi {
                            val q = call.request.queryParameters["q"] ?: ""
                            val folderId = call.request.queryParameters["folderId"]?.takeIf { it.isNotBlank() }
                            DataEnvelope(repo.searchGlobal(q, folderId))
                        }
                    }
                    get("/settings") {
                        call.response.header(HttpHeaders.CacheControl, "no-store")
                        call.respondApi { DataEnvelope(settingsManager.get()) }
                    }
                    put("/settings") {
                        call.response.header(HttpHeaders.CacheControl, "no-store")
                        call.respondApi {
                            val req = WireJson.decodeFromString<AppSettings>(call.receiveText())
                            DataEnvelope(settingsManager.put(req))
                        }
                    }
                    post("/providers/models") {
                        call.respondApi {
                            val req = WireJson.decodeFromString<LLMModelsRequest>(call.receiveText())
                            DataEnvelope(llmClient.listModels(req))
                        }
                    }
                    post("/asr-providers/models") {
                        call.respondApi {
                            val req = WireJson.decodeFromString<ASRModelsRequest>(call.receiveText())
                            val models = cloudAsr.listModels(req)
                            settingsManager.saveAsrCatalog(req, models)
                            DataEnvelope(models)
                        }
                    }

                    // -------- Addons (SenseVoice / AEC3 / OpenCode) & Audio Devices --------
                    get("/addons/builtin-free-asr") {
                        call.response.header(HttpHeaders.CacheControl, "no-store")
                        call.respondApi { DataEnvelope(senseVoice.isReady()) }
                    }
                    post("/addons/builtin-free-asr/download/stream") {
                        val req = WireJson.decodeFromString<ConfirmRequest>(call.receiveText().ifBlank { "{}" })
                        if (!req.confirmed) {
                            call.respondAppError(AppException(400, "ASR_DOWNLOAD_NOT_CONFIRMED", "请先确认下载本地语音识别模型"))
                        } else {
                            call.respondSse(senseVoice.downloadStream())
                        }
                    }
                    get("/addons/webrtc-aec3") {
                        call.response.header(HttpHeaders.CacheControl, "no-store")
                        call.respondApi { DataEnvelope(Aec3AddonStatus(installed = false)) }
                    }
                    get("/audio/devices") {
                        call.response.header(HttpHeaders.CacheControl, "no-store")
                        call.respondApi {
                            DataEnvelope(audioDevicesProvider())
                        }
                    }

                    // -------- CNB APK Auto-Updater --------
                    get("/updates/check") {
                        call.response.header(HttpHeaders.CacheControl, "no-store")
                        call.respondApi {
                            val force = call.request.queryParameters["force"] == "true"
                            DataEnvelope(updater.checkUpdate(force))
                        }
                    }
                    post("/updates/download/stream") {
                        call.respondSse(updater.downloadUpdateStream())
                    }
                    post("/updates/apply") {
                        call.respondApi { DataEnvelope(updater.applyStagedUpdate()) }
                    }
                }

                // -------- WebSockets --------
                webSocket("/ws/v1/sessions/{sessionId}/stream") {
                    val sid = call.parameters["sessionId"] ?: return@webSocket
                    streams.handleSessionSocket(sid, this)
                }
                webSocket("/ws/v1/desktop/events") {
                    streams.handleDesktopSocket(this)
                }

                // -------- Static Bundled React Frontend (assets/www/) --------
                get("/") { call.serveAsset("index.html") }
                get("/{path...}") {
                    val rel = call.parameters.getAll("path")?.joinToString("/") ?: "index.html"
                    if (!call.tryServeAsset(rel)) {
                        call.serveAsset("index.html")
                    }
                }
            }
        }
        server.start(wait = false)
        engine = server
        boundPort = port
        return port
    }

    fun stop() {
        runCatching { engine?.stop(300, 800) }
        engine = null
        boundPort = 0
    }

    private suspend fun ApplicationCall.tryServeAsset(relPath: String): Boolean {
        val clean = relPath.trimStart('/').replace("..", "")
        val assetPath = "www/$clean"
        return try {
            val bytes = assets.open(assetPath).use { it.readBytes() }
            val ct = guessContentType(clean)
            if (clean.startsWith("assets/")) {
                response.header(HttpHeaders.CacheControl, "public, max-age=31536000, immutable")
            } else {
                response.header(HttpHeaders.CacheControl, "no-cache")
            }
            respondBytes(bytes, ct)
            true
        } catch (_: IOException) {
            false
        }
    }

    private suspend fun ApplicationCall.serveAsset(relPath: String) {
        if (!tryServeAsset(relPath)) {
            respondText("Frontend bundle not found in assets/www/$relPath", status = HttpStatusCode.NotFound)
        }
    }

    private inline fun <reified T> encodeJson(value: T): String = WireJson.encodeToString(value)

    private suspend inline fun <reified T> ApplicationCall.respondApi(
        status: HttpStatusCode = HttpStatusCode.OK,
        crossinline block: suspend () -> T,
    ) {
        try {
            val result = block()
            respondText(encodeJson(result), ContentType.Application.Json, status)
        } catch (e: AppException) {
            respondAppError(e)
        } catch (e: Throwable) {
            respondAppError(AppException(500, "INTERNAL_ERROR", e.message ?: "内部处理异常"))
        }
    }

    private suspend fun ApplicationCall.respondNoContent(block: suspend () -> Unit) {
        try {
            block()
            respond(HttpStatusCode.NoContent)
        } catch (e: AppException) {
            respondAppError(e)
        } catch (e: Throwable) {
            respondAppError(AppException(500, "INTERNAL_ERROR", e.message ?: "内部处理异常"))
        }
    }

    private suspend fun ApplicationCall.respondAppError(e: AppException) {
        val body = WireJson.encodeToString(ApiErrorEnvelope(ApiErrorDetail(e.code, e.message)))
        respondText(body, ContentType.Application.Json, HttpStatusCode.fromValue(e.statusCode))
    }

    private suspend fun ApplicationCall.respondSse(flow: Flow<JsonObject>) {
        response.header(HttpHeaders.CacheControl, "no-cache, no-transform")
        response.header("X-Accel-Buffering", "no")
        respondTextWriter(contentType = ContentType.Text.EventStream) {
            try {
                flow.collect { ev ->
                    write("data: $ev\n\n")
                    flush()
                }
            } catch (e: AppException) {
                val err = buildJsonObject {
                    put("type", "error")
                    put("error", buildJsonObject {
                        put("code", e.code)
                        put("message", e.message)
                    })
                }
                write("data: $err\n\n")
                flush()
            } catch (e: Throwable) {
                val err = buildJsonObject {
                    put("type", "error")
                    put("error", buildJsonObject {
                        put("code", "INTERNAL_ERROR")
                        put("message", e.message ?: "流式处理异常")
                    })
                }
                write("data: $err\n\n")
                flush()
            }
        }
    }

    companion object {
        private fun findFreeLocalPort(): Int = ServerSocket(0).use { it.localPort }

        private fun guessContentType(path: String): ContentType = when {
            path.endsWith(".html", true) -> ContentType.Text.Html
            path.endsWith(".js", true) || path.endsWith(".mjs", true) -> ContentType.Application.JavaScript
            path.endsWith(".css", true) -> ContentType.Text.CSS
            path.endsWith(".svg", true) -> ContentType.Image.SVG
            path.endsWith(".png", true) -> ContentType.Image.PNG
            path.endsWith(".jpg", true) || path.endsWith(".jpeg", true) -> ContentType.Image.JPEG
            path.endsWith(".ico", true) -> ContentType.parse("image/x-icon")
            path.endsWith(".woff2", true) -> ContentType.parse("font/woff2")
            path.endsWith(".woff", true) -> ContentType.parse("font/woff")
            path.endsWith(".ttf", true) -> ContentType.parse("font/ttf")
            path.endsWith(".json", true) -> ContentType.Application.Json
            path.endsWith(".wasm", true) -> ContentType.parse("application/wasm")
            else -> ContentType.Application.OctetStream
        }
    }
}
