package com.zhiling.classroom.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.UUID

val WireJson: Json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
    explicitNulls = true
    isLenient = true
}

class AppException(
    val statusCode: Int,
    val code: String,
    override val message: String,
) : RuntimeException(message)

@Serializable
data class ApiErrorDetail(
    val code: String,
    val message: String,
)

@Serializable
data class ApiErrorEnvelope(
    val error: ApiErrorDetail,
)

@Serializable
data class DataEnvelope<T>(
    val data: T,
)

fun newId(): String = UUID.randomUUID().toString().replace("-", "")

fun nowIsoUtc(): String =
    DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
        .withZone(ZoneOffset.UTC)
        .format(Instant.now())

fun formatTimestampMs(ms: Long): String {
    val totalSec = (ms.coerceAtLeast(0L) / 1000L).toInt()
    val hours = totalSec / 3600
    val minutes = (totalSec % 3600) / 60
    val seconds = totalSec % 60
    return if (hours > 0) {
        "%02d:%02d:%02d".format(hours, minutes, seconds)
    } else {
        "%02d:%02d".format(minutes, seconds)
    }
}

fun formatTimestampSec(sec: Int): String = formatTimestampMs(sec.coerceAtLeast(0) * 1000L)

// ---------------- Sticky Note Timestamp Parser (matches desktop) ----------------

data class ParsedStickyTimestamp(
    val timestampSec: Int,
    val timestampText: String,
    val charOffset: Int,
)

private val STICKY_TS_REGEX = Regex("""\[(\d{1,3}):(\d{2})(?::(\d{2}))?\]""")

fun extractStickyTimestamps(content: String): List<ParsedStickyTimestamp> {
    if (content.isEmpty()) return emptyList()
    val seenSec = LinkedHashSet<Int>()
    val result = mutableListOf<ParsedStickyTimestamp>()
    for (m in STICKY_TS_REGEX.findAll(content)) {
        val g1 = m.groupValues[1].toIntOrNull() ?: continue
        val g2 = m.groupValues[2].toIntOrNull() ?: continue
        val g3 = m.groupValues[3]
        val sec = if (g3.isNotEmpty()) {
            val s = g3.toIntOrNull() ?: continue
            if (g2 > 59 || s > 59) continue
            g1 * 3600 + g2 * 60 + s
        } else {
            if (g2 > 59) continue
            g1 * 60 + g2
        }
        if (seenSec.add(sec)) {
            result.add(
                ParsedStickyTimestamp(
                    timestampSec = sec,
                    timestampText = formatTimestampSec(sec),
                    charOffset = m.range.first,
                )
            )
        }
    }
    return result
}

// ---------------- Domain Wire Models ----------------

@Serializable
data class FolderCreateRequest(
    val name: String,
    val parentId: String? = null,
    val hotwords: List<String>? = null,
)

@Serializable
data class FolderPatchRequest(
    val name: String? = null,
    val hotwords: List<String>? = null,
)

@Serializable
data class FolderItem(
    val id: String,
    val name: String,
    val parentId: String? = null,
    val hotwords: List<String> = emptyList(),
    val createdAt: String,
    val updatedAt: String,
)

@Serializable
data class SessionCreateRequest(
    val folderId: String? = null,
)

@Serializable
data class SessionPatchRequest(
    val title: String? = null,
    val folderId: String? = null,
    val status: String? = null,
    val durationSeconds: Int? = null,
)

@Serializable
data class SessionCard(
    val id: String,
    val folderId: String? = null,
    val title: String,
    val status: String = "idle",
    val durationSeconds: Int = 0,
    val speakerCount: Int = 0,
    val segmentCount: Int = 0,
    val createdAt: String,
    val updatedAt: String,
)

@Serializable
data class SpeakerRenameRequest(
    val label: String,
)

@Serializable
data class SpeakerProfile(
    val id: String,
    val label: String,
)

@Serializable
data class HighlightItem(
    val id: String,
    val term: String,
    val explanation: String,
)

@Serializable
data class UtteranceItem(
    val id: String,
    val speakerId: String,
    val speakerLabel: String,
    val timestampText: String,
    val startTimeMs: Long,
    val endTimeMs: Long,
    val rawText: String,
    val refinedText: String,
    val isRefined: Boolean = false,
    val isBookmarked: Boolean = false,
    val bookmarkKind: String? = null,
    val userNote: String? = null,
    val isManualEdited: Boolean = false,
)

@Serializable
data class UtterancePatchRequest(
    val refinedText: String? = null,
    val isBookmarked: Boolean? = null,
    val bookmarkKind: String? = null,
    val userNote: String? = null,
)

@Serializable
data class BookmarkNowRequest(
    val kind: String = "confused",
    val note: String? = null,
    val timestampMs: Long? = null,
)

@Serializable
data class BookmarkNowResponse(
    val segmentId: String,
    val utterance: UtteranceItem,
)

@Serializable
data class SegmentExplanation(
    val title: String,
    val corePoints: List<String> = emptyList(),
    val elaboration: String,
    val thinking: String? = null,
)

@Serializable
data class KnowledgeSegment(
    val id: String,
    val sessionId: String,
    val orderIndex: Int,
    val topicTitle: String,
    val utterances: List<UtteranceItem> = emptyList(),
    val highlights: List<HighlightItem> = emptyList(),
    val detailedExplanation: SegmentExplanation? = null,
)

@Serializable
data class SessionAttachmentItem(
    val id: String,
    val sessionId: String,
    val segmentId: String? = null,
    val kind: String,
    val fileName: String,
    val mimeType: String,
    val sizeBytes: Long = 0,
    val width: Int? = null,
    val height: Int? = null,
    val timestampMs: Long? = null,
    val timestampText: String? = null,
    val caption: String? = null,
    val extractedPreview: String? = null,
    val url: String,
    val createdAt: String,
)

@Serializable
data class CaptureScreenRequest(
    val timestampMs: Long? = null,
    val segmentId: String? = null,
    val caption: String? = null,
)

@Serializable
data class SessionStudyNote(
    val contentMarkdown: String,
    val thinking: String? = null,
    val updatedAt: String,
)

@Serializable
data class FlashcardItem(
    val id: String,
    val front: String,
    val back: String,
    val tag: String = "",
)

@Serializable
data class SessionExportRequest(
    val format: String = "markdown",
    val includeStudyNote: Boolean = true,
    val includeHighlights: Boolean = true,
    val includeChat: Boolean = true,
    val includeTranscript: Boolean = true,
    val includeStickyNotes: Boolean = true,
)

@Serializable
data class StickyNoteTimestampItem(
    val id: String,
    val noteId: String,
    val timestampSec: Int,
    val timestampText: String,
    val charOffset: Int,
    val createdAt: String,
)

@Serializable
data class StickyNoteTimestampConflict(
    val timestampSec: Int,
    val timestampText: String,
    val ownerNoteId: String,
    val ownerNoteTitle: String,
)

@Serializable
data class StickyNoteItem(
    val id: String,
    val sessionId: String,
    val title: String = "",
    val content: String = "",
    val paperColor: String = "cream",
    val posX: Int = 120,
    val posY: Int = 96,
    val width: Int = 340,
    val height: Int = 300,
    val isOpen: Boolean = true,
    val zOrder: Int = 1,
    val isTranslucent: Boolean = false,
    val timestamps: List<StickyNoteTimestampItem> = emptyList(),
    val conflicts: List<StickyNoteTimestampConflict> = emptyList(),
    val createdAt: String,
    val updatedAt: String,
)

@Serializable
data class StickyNoteCreateRequest(
    val title: String = "",
    val content: String = "",
    val paperColor: String = "cream",
    val posX: Int = 120,
    val posY: Int = 96,
    val width: Int = 340,
    val height: Int = 300,
    val isOpen: Boolean = true,
    val zOrder: Int = 1,
    val isTranslucent: Boolean = false,
)

@Serializable
data class StickyNotePatchRequest(
    val title: String? = null,
    val content: String? = null,
    val paperColor: String? = null,
    val posX: Int? = null,
    val posY: Int? = null,
    val width: Int? = null,
    val height: Int? = null,
    val isOpen: Boolean? = null,
    val zOrder: Int? = null,
    val isTranslucent: Boolean? = null,
)

@Serializable
data class StickyNoteBatchOpenRequest(
    val isOpen: Boolean,
)

@Serializable
data class SearchHitItem(
    val sessionId: String,
    val sessionTitle: String,
    val folderId: String? = null,
    val kind: String,
    val segmentId: String? = null,
    val utteranceId: String? = null,
    val stickyNoteId: String? = null,
    val timestampMs: Long? = null,
    val timestampText: String? = null,
    val snippet: String,
    val updatedAt: String,
)

@Serializable
data class ChatRequest(
    val content: String,
    val attachmentIds: List<String> = emptyList(),
)

@Serializable
data class ChatMessage(
    val id: String,
    val sessionId: String,
    val role: String,
    val content: String,
    val thinking: String? = null,
    val referencedSegmentCount: Int? = null,
    val attachments: List<SessionAttachmentItem> = emptyList(),
    val createdAt: String,
)

@Serializable
data class WorkspacePayload(
    val session: SessionCard,
    val speakers: List<SpeakerProfile> = emptyList(),
    val segments: List<KnowledgeSegment> = emptyList(),
    val messages: List<ChatMessage> = emptyList(),
    val studyNote: SessionStudyNote? = null,
    val flashcards: List<FlashcardItem> = emptyList(),
    val attachments: List<SessionAttachmentItem> = emptyList(),
    val stickyNotes: List<StickyNoteItem> = emptyList(),
    val hasAudio: Boolean = false,
    val audioDurationMs: Long = 0,
)

@Serializable
data class LLMModelsRequest(
    val providerId: String,
    val protocol: String,
    val baseUrl: String,
    val apiKey: String,
)

@Serializable
data class ASRModelsRequest(
    val providerId: String,
    val protocol: String,
    val baseUrl: String,
    val apiKey: String,
    val appId: String? = null,
)

@Serializable
data class LLMProviderConfig(
    val providerId: String,
    val name: String,
    val isCustom: Boolean? = null,
    val protocol: String,
    val baseUrl: String,
    val apiKey: String = "",
    val availableModels: List<String> = emptyList(),
    val lastFetchedAt: String? = null,
)

@Serializable
data class AsrProviderConfig(
    val providerId: String,
    val name: String,
    val isCustom: Boolean? = null,
    val protocol: String,
    val baseUrl: String,
    val apiKey: String = "",
    val appId: String? = null,
    val availableModels: List<String> = emptyList(),
    val selectedModelId: String = "",
)

@Serializable
data class FeatureModelBinding(
    val enabled: Boolean = true,
    val providerId: String = "deepseek",
    val modelId: String = "",
)

@Serializable
data class FeatureRouting(
    val chat: FeatureModelBinding = FeatureModelBinding(),
    val sentenceCorrection: FeatureModelBinding = FeatureModelBinding(),
    val resegmentation: FeatureModelBinding = FeatureModelBinding(),
    val keyTermHighlight: FeatureModelBinding = FeatureModelBinding(),
    val bubbleExplanation: FeatureModelBinding = FeatureModelBinding(),
) {
    fun binding(feature: String): FeatureModelBinding = when (feature) {
        "chat" -> chat
        "sentenceCorrection" -> sentenceCorrection
        "resegmentation" -> resegmentation
        "keyTermHighlight" -> keyTermHighlight
        "bubbleExplanation" -> bubbleExplanation
        else -> chat
    }
}

@Serializable
data class DesktopHotkeys(
    val enabled: Boolean = false,
    val toggleRecording: String = "Alt+Shift+R",
    val toggleMicMute: String = "Alt+Shift+M",
    val captureScreenshot: String = "Alt+Shift+S",
    val bookmarkConfused: String = "Alt+Shift+B",
    val toggleMiniOverlay: String = "Alt+Shift+O",
)

@Serializable
data class AppSettings(
    val selectedLlmProviderId: String = "deepseek",
    val llmProviders: Map<String, LLMProviderConfig> = emptyMap(),
    val featureRouting: FeatureRouting = FeatureRouting(),
    val selectedAsrProviderId: String = "builtin-free-asr",
    val asrProviders: Map<String, AsrProviderConfig> = emptyMap(),
    val enableSpeakerDiarization: Boolean = true,
    val expectedSpeakerMode: String = "auto",
    val recognitionLanguage: String = "zh-en",
    val audioInputSource: String = "mic-only",
    val audioDeviceId: String = "default",
    val systemAudioDeviceId: String = "default",
    val micEnabled: Boolean = true,
    val systemAudioEnabled: Boolean = false,
    val enableWebrtcAec3: Boolean = false,
    val aec3PromptDismissed: Boolean = true,
    val enableDualChannelSpeakerSplit: Boolean = false,
    val globalHotwords: List<String> = emptyList(),
    val desktopHotkeys: DesktopHotkeys = DesktopHotkeys(),
    val enableVadAutoPause: Boolean = false,
    val autoSaveSession: Boolean = true,
    val defaultExportFormat: String = "markdown",
)

@Serializable
data class Aec3AddonStatus(
    val installed: Boolean = false,
    val version: String = "1.0.0",
    val sizeBytes: Long = 0,
)

@Serializable
data class UpdateAssetInfo(
    val name: String,
    val sizeBytes: Long = 0,
    val sha256: String = "",
    val downloadUrl: String,
)

@Serializable
data class UpdateCheckResult(
    val currentVersion: String,
    val latestVersion: String,
    val hasUpdate: Boolean,
    val releaseTitle: String = "",
    val releaseNotes: String = "",
    val releaseUrl: String = "",
    val publishedAt: String = "",
    val platform: String = "android",
    val arch: String = "arm64",
    val repo: String = "",
    val canAutoApply: Boolean = true,
    val stagedReady: Boolean = false,
    val asset: UpdateAssetInfo? = null,
    val checkedAt: String = "",
)

@Serializable
data class UpdateApplyResult(
    val scheduled: Boolean,
    val mode: String = "auto-replace",
    val version: String,
    val downloadPath: String,
    val message: String,
)

@Serializable
data class NativeAudioEndpoint(
    val id: String,
    val rawId: String,
    val name: String,
    val isDefault: Boolean = false,
    val isCommunicationsDefault: Boolean = false,
)

@Serializable
data class NativeAudioDevices(
    val platform: String = "android",
    val wasapiSupported: Boolean = false,
    val inputs: List<NativeAudioEndpoint> = emptyList(),
    val loopbacks: List<NativeAudioEndpoint> = emptyList(),
)

@Serializable
data class ConfirmRequest(
    val confirmed: Boolean = false,
)

@Serializable
data class RetranscribeGapResult(
    val recoveredCount: Int,
    val fromMs: Long,
    val toMs: Long,
)

@Serializable
data class WsEnvelope(
    val type: String,
    val payload: JsonElement? = null,
)
