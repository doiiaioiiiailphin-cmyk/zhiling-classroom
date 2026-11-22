package com.zhiling.classroom.db

import android.content.ContentValues
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import com.zhiling.classroom.model.*
import kotlinx.serialization.encodeToString
import java.io.File
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

class ClassroomRepository(
    private val dbHelper: ClassroomDatabase,
    private val attachmentsDir: File,
) {
    private val writeLock = Any()

    init {
        attachmentsDir.mkdirs()
    }

    private val readable: SQLiteDatabase get() = dbHelper.readableDatabase
    private val writable: SQLiteDatabase get() = dbHelper.writableDatabase

    // ---------------- Folders ----------------

    fun listFolders(): List<FolderItem> {
        val list = mutableListOf<FolderItem>()
        readable.rawQuery(
            "SELECT id, name, parent_id, hotwords_json, created_at, updated_at FROM folders ORDER BY created_at ASC",
            null,
        ).use { c ->
            while (c.moveToNext()) list.add(c.toFolder())
        }
        return list
    }

    fun createFolder(req: FolderCreateRequest): FolderItem = synchronized(writeLock) {
        val name = req.name.trim()
        if (name.isEmpty()) throw AppException(400, "INVALID_NAME", "文件夹名称不能为空")
        val id = newId()
        val ts = nowIsoUtc()
        val hotwords = (req.hotwords ?: emptyList()).map { it.trim() }.filter { it.isNotEmpty() }.distinct().take(200)
        val cv = ContentValues().apply {
            put("id", id)
            put("name", name)
            put("parent_id", req.parentId)
            put("hotwords_json", if (hotwords.isEmpty()) null else WireJson.encodeToString(hotwords))
            put("created_at", ts)
            put("updated_at", ts)
        }
        writable.insertOrThrow("folders", null, cv)
        FolderItem(id = id, name = name, parentId = req.parentId, hotwords = hotwords, createdAt = ts, updatedAt = ts)
    }

    fun patchFolder(id: String, req: FolderPatchRequest): FolderItem = synchronized(writeLock) {
        val existing = readable.rawQuery(
            "SELECT id, name, parent_id, hotwords_json, created_at, updated_at FROM folders WHERE id = ?",
            arrayOf(id),
        ).use { if (it.moveToFirst()) it.toFolder() else null }
            ?: throw AppException(404, "FOLDER_NOT_FOUND", "文件夹不存在")

        val nextName = req.name?.trim()?.also {
            if (it.isEmpty()) throw AppException(400, "INVALID_NAME", "文件夹名称不能为空")
        } ?: existing.name
        val nextHotwords = req.hotwords?.map { it.trim() }?.filter { it.isNotEmpty() }?.distinct()?.take(200)
            ?: existing.hotwords
        val ts = nowIsoUtc()
        val cv = ContentValues().apply {
            put("name", nextName)
            put("hotwords_json", if (nextHotwords.isEmpty()) null else WireJson.encodeToString(nextHotwords))
            put("updated_at", ts)
        }
        writable.update("folders", cv, "id = ?", arrayOf(id))
        existing.copy(name = nextName, hotwords = nextHotwords, updatedAt = ts)
    }

    fun deleteFolder(id: String) = synchronized(writeLock) {
        writable.delete("folders", "id = ?", arrayOf(id))
    }

    fun folderHotwordsForSession(sessionId: String): List<String> {
        val folderId = readable.rawQuery(
            "SELECT folder_id FROM class_sessions WHERE id = ?",
            arrayOf(sessionId),
        ).use { if (it.moveToFirst()) it.getString(0) else null } ?: return emptyList()
        return readable.rawQuery(
            "SELECT hotwords_json FROM folders WHERE id = ?",
            arrayOf(folderId),
        ).use { c ->
            if (!c.moveToFirst()) return emptyList()
            val raw = c.getString(0) ?: return emptyList()
            runCatching { WireJson.decodeFromString<List<String>>(raw) }.getOrDefault(emptyList())
        }
    }

    // ---------------- Sessions ----------------

    fun listSessions(): List<SessionCard> {
        val list = mutableListOf<SessionCard>()
        val sql = """
            SELECT s.id, s.folder_id, s.title, s.status, s.duration_seconds, s.created_at, s.updated_at,
                   (SELECT COUNT(*) FROM speakers sp WHERE sp.session_id = s.id) AS speaker_count,
                   (SELECT COUNT(*) FROM knowledge_segments ks WHERE ks.session_id = s.id) AS segment_count
            FROM class_sessions s
            ORDER BY s.updated_at DESC, s.id DESC
        """.trimIndent()
        readable.rawQuery(sql, null).use { c ->
            while (c.moveToNext()) list.add(c.toSessionCard())
        }
        return list
    }

    fun createSession(folderId: String?): WorkspacePayload = synchronized(writeLock) {
        val id = newId()
        val ts = nowIsoUtc()
        val localDate = ZonedDateTime.now(ZoneId.systemDefault())
            .format(DateTimeFormatter.ofPattern("M月d日"))
        val title = "新课堂记录（$localDate）"
        val cv = ContentValues().apply {
            put("id", id)
            put("folder_id", folderId)
            put("title", title)
            put("status", "idle")
            put("duration_seconds", 0)
            put("created_at", ts)
            put("updated_at", ts)
        }
        writable.insertOrThrow("class_sessions", null, cv)
        workspace(id, audioDurationMs = 0L)
    }

    fun patchSession(id: String, req: SessionPatchRequest): SessionCard = synchronized(writeLock) {
        ensureSessionExists(id)
        val cv = ContentValues().apply {
            req.title?.trim()?.let {
                if (it.isEmpty()) throw AppException(400, "INVALID_TITLE", "课堂标题不能为空")
                put("title", it)
            }
            if (req.folderId != null) {
                put("folder_id", req.folderId.ifBlank { null })
            }
            req.status?.let { put("status", it) }
            req.durationSeconds?.let { put("duration_seconds", it.coerceAtLeast(0)) }
            put("updated_at", nowIsoUtc())
        }
        writable.update("class_sessions", cv, "id = ?", arrayOf(id))
        getSessionCard(id)
    }

    fun checkpointSession(sessionId: String, durationMs: Long, status: String? = null, audioPath: String? = null) =
        synchronized(writeLock) {
            val cv = ContentValues().apply {
                put("duration_seconds", (durationMs / 1000L).toInt().coerceAtLeast(0))
                if (status != null) put("status", status)
                if (audioPath != null) put("audio_file_path", audioPath)
                put("updated_at", nowIsoUtc())
            }
            writable.update("class_sessions", cv, "id = ?", arrayOf(sessionId))
        }

    fun deleteSession(id: String) = synchronized(writeLock) {
        writable.delete("class_sessions", "id = ?", arrayOf(id))
        File(attachmentsDir, id).deleteRecursively()
    }

    fun getSessionCard(id: String): SessionCard {
        val sql = """
            SELECT s.id, s.folder_id, s.title, s.status, s.duration_seconds, s.created_at, s.updated_at,
                   (SELECT COUNT(*) FROM speakers sp WHERE sp.session_id = s.id) AS speaker_count,
                   (SELECT COUNT(*) FROM knowledge_segments ks WHERE ks.session_id = s.id) AS segment_count
            FROM class_sessions s WHERE s.id = ?
        """.trimIndent()
        return readable.rawQuery(sql, arrayOf(id)).use { c ->
            if (!c.moveToFirst()) throw AppException(404, "SESSION_NOT_FOUND", "课堂记录不存在")
            c.toSessionCard()
        }
    }

    fun ensureSessionExists(id: String) {
        readable.rawQuery("SELECT 1 FROM class_sessions WHERE id = ?", arrayOf(id)).use { c ->
            if (!c.moveToFirst()) throw AppException(404, "SESSION_NOT_FOUND", "课堂记录不存在")
        }
    }

    fun sessionDurationMs(id: String): Long {
        return readable.rawQuery("SELECT duration_seconds FROM class_sessions WHERE id = ?", arrayOf(id)).use { c ->
            if (!c.moveToFirst()) throw AppException(404, "SESSION_NOT_FOUND", "课堂记录不存在")
            c.getInt(0).toLong() * 1000L
        }
    }

    // ---------------- Workspace ----------------

    fun workspace(sessionId: String, audioDurationMs: Long): WorkspacePayload {
        val card = getSessionCard(sessionId)
        val speakers = listSpeakers(sessionId)
        val segments = listSegments(sessionId)
        val attachments = listAttachments(sessionId)
        val attMap = attachments.associateBy { it.id }
        val messages = listMessages(sessionId, attMap)
        val stickyNotes = listStickyNotes(sessionId)

        var studyNote: SessionStudyNote? = null
        var flashcards: List<FlashcardItem> = emptyList()
        readable.rawQuery(
            "SELECT study_note_json, flashcards_json FROM class_sessions WHERE id = ?",
            arrayOf(sessionId),
        ).use { c ->
            if (c.moveToFirst()) {
                c.getString(0)?.takeIf { it.isNotBlank() }?.let { raw ->
                    studyNote = runCatching { WireJson.decodeFromString<SessionStudyNote>(raw) }.getOrNull()
                }
                c.getString(1)?.takeIf { it.isNotBlank() }?.let { raw ->
                    flashcards = runCatching { WireJson.decodeFromString<List<FlashcardItem>>(raw) }.getOrDefault(emptyList())
                }
            }
        }

        return WorkspacePayload(
            session = card,
            speakers = speakers,
            segments = segments,
            messages = messages,
            studyNote = studyNote,
            flashcards = flashcards,
            attachments = attachments,
            stickyNotes = stickyNotes,
            hasAudio = audioDurationMs > 0L,
            audioDurationMs = audioDurationMs,
        )
    }

    // ---------------- Speakers ----------------

    fun listSpeakers(sessionId: String): List<SpeakerProfile> {
        val list = mutableListOf<SpeakerProfile>()
        readable.rawQuery(
            "SELECT id, label FROM speakers WHERE session_id = ? ORDER BY rowid ASC",
            arrayOf(sessionId),
        ).use { c ->
            while (c.moveToNext()) {
                list.add(SpeakerProfile(id = c.getString(0), label = c.getString(1)))
            }
        }
        return list
    }

    fun getOrCreateSpeaker(sessionId: String, channel: String): SpeakerProfile = synchronized(writeLock) {
        readable.rawQuery(
            "SELECT id, label FROM speakers WHERE session_id = ? AND diarization_channel = ?",
            arrayOf(sessionId, channel),
        ).use { c ->
            if (c.moveToFirst()) {
                return SpeakerProfile(id = c.getString(0), label = c.getString(1))
            }
        }
        val count = readable.rawQuery(
            "SELECT COUNT(*) FROM speakers WHERE session_id = ?",
            arrayOf(sessionId),
        ).use { if (it.moveToFirst()) it.getInt(0) else 0 }
        val id = newId()
        val label = when {
            channel == "self" -> "我（本地）"
            channel == "remote" -> "老师（系统音频）"
            else -> "讲话人 ${count + 1}"
        }
        val cv = ContentValues().apply {
            put("id", id)
            put("session_id", sessionId)
            put("diarization_channel", channel)
            put("label", label)
        }
        writable.insertOrThrow("speakers", null, cv)
        SpeakerProfile(id = id, label = label)
    }

    fun renameSpeaker(sessionId: String, speakerId: String, label: String) = synchronized(writeLock) {
        val clean = label.trim()
        if (clean.isEmpty()) throw AppException(400, "INVALID_LABEL", "讲话人名称不能为空")
        val cv = ContentValues().apply { put("label", clean) }
        val updated = writable.update("speakers", cv, "id = ? AND session_id = ?", arrayOf(speakerId, sessionId))
        if (updated == 0) throw AppException(404, "SPEAKER_NOT_FOUND", "讲话人不存在")
    }

    // ---------------- Segments & Utterances ----------------

    fun listSegments(sessionId: String): List<KnowledgeSegment> {
        val speakerMap = listSpeakers(sessionId).associate { it.id to it.label }
        val segList = mutableListOf<KnowledgeSegment>()
        readable.rawQuery(
            "SELECT id, session_id, order_index, topic_title, detailed_explanation FROM knowledge_segments WHERE session_id = ? ORDER BY order_index ASC",
            arrayOf(sessionId),
        ).use { c ->
            while (c.moveToNext()) {
                val segId = c.getString(0)
                val detailJson = c.getString(4)
                val detail = detailJson?.takeIf { it.isNotBlank() }?.let {
                    runCatching { WireJson.decodeFromString<SegmentExplanation>(it) }.getOrNull()
                }
                segList.add(
                    KnowledgeSegment(
                        id = segId,
                        sessionId = c.getString(1),
                        orderIndex = c.getInt(2),
                        topicTitle = c.getString(3),
                        utterances = listUtterancesForSegment(segId, speakerMap),
                        highlights = listHighlightsForSegment(segId),
                        detailedExplanation = detail,
                    )
                )
            }
        }
        return segList
    }

    private fun listUtterancesForSegment(segmentId: String, speakerMap: Map<String, String>): List<UtteranceItem> {
        val list = mutableListOf<UtteranceItem>()
        readable.rawQuery(
            """
            SELECT id, speaker_id, start_time_ms, end_time_ms, raw_text, refined_text,
                   is_refined, is_bookmarked, bookmark_kind, user_note, is_manual_edited
            FROM utterances WHERE segment_id = ? ORDER BY created_at ASC, id ASC
            """.trimIndent(),
            arrayOf(segmentId),
        ).use { c ->
            while (c.moveToNext()) {
                val spkId = c.getString(1)
                val startMs = c.getLong(2)
                list.add(
                    UtteranceItem(
                        id = c.getString(0),
                        speakerId = spkId,
                        speakerLabel = speakerMap[spkId] ?: "讲话人",
                        timestampText = formatTimestampMs(startMs),
                        startTimeMs = startMs,
                        endTimeMs = c.getLong(3),
                        rawText = c.getString(4),
                        refinedText = c.getString(5),
                        isRefined = c.getInt(6) != 0,
                        isBookmarked = c.getInt(7) != 0,
                        bookmarkKind = c.getString(8),
                        userNote = c.getString(9),
                        isManualEdited = c.getInt(10) != 0,
                    )
                )
            }
        }
        return list
    }

    private fun listHighlightsForSegment(segmentId: String): List<HighlightItem> {
        val list = mutableListOf<HighlightItem>()
        readable.rawQuery(
            "SELECT id, term, explanation FROM segment_highlights WHERE segment_id = ? ORDER BY rowid ASC",
            arrayOf(segmentId),
        ).use { c ->
            while (c.moveToNext()) {
                list.add(HighlightItem(id = c.getString(0), term = c.getString(1), explanation = c.getString(2)))
            }
        }
        return list
    }

    data class SavedFinalResult(
        val segmentId: String,
        val utterance: UtteranceItem,
        val createdInitialSegment: KnowledgeSegment?,
    )

    fun saveFinalUtterance(
        sessionId: String,
        channel: String,
        text: String,
        startTimeMs: Long,
        endTimeMs: Long,
    ): SavedFinalResult = synchronized(writeLock) {
        val speaker = getOrCreateSpeaker(sessionId, channel)
        val ts = nowIsoUtc()
        var createdSeg: KnowledgeSegment? = null
        var targetSegId = readable.rawQuery(
            "SELECT id FROM knowledge_segments WHERE session_id = ? ORDER BY order_index DESC LIMIT 1",
            arrayOf(sessionId),
        ).use { if (it.moveToFirst()) it.getString(0) else null }

        if (targetSegId == null) {
            targetSegId = newId()
            val segCv = ContentValues().apply {
                put("id", targetSegId)
                put("session_id", sessionId)
                put("order_index", 0)
                put("topic_title", "课堂实时记录")
                put("created_at", ts)
                put("updated_at", ts)
            }
            writable.insertOrThrow("knowledge_segments", null, segCv)
            createdSeg = KnowledgeSegment(
                id = targetSegId,
                sessionId = sessionId,
                orderIndex = 0,
                topicTitle = "课堂实时记录",
            )
        }

        val uttId = newId()
        val cv = ContentValues().apply {
            put("id", uttId)
            put("session_id", sessionId)
            put("segment_id", targetSegId)
            put("speaker_id", speaker.id)
            put("start_time_ms", startTimeMs)
            put("end_time_ms", endTimeMs.coerceAtLeast(startTimeMs))
            put("raw_text", text)
            put("refined_text", text)
            put("is_refined", 0)
            put("is_bookmarked", 0)
            put("is_manual_edited", 0)
            put("created_at", ts)
        }
        writable.insertOrThrow("utterances", null, cv)

        val sessCv = ContentValues().apply {
            put("updated_at", ts)
            val sec = (endTimeMs / 1000L).toInt()
            put("duration_seconds", maxOf(sec, (sessionDurationMs(sessionId) / 1000L).toInt()))
        }
        writable.update("class_sessions", sessCv, "id = ?", arrayOf(sessionId))

        val utt = UtteranceItem(
            id = uttId,
            speakerId = speaker.id,
            speakerLabel = speaker.label,
            timestampText = formatTimestampMs(startTimeMs),
            startTimeMs = startTimeMs,
            endTimeMs = endTimeMs.coerceAtLeast(startTimeMs),
            rawText = text,
            refinedText = text,
            isRefined = false,
        )
        SavedFinalResult(targetSegId, utt, createdSeg)
    }

    fun applyAiCorrection(sessionId: String, utteranceId: String, refinedText: String): String? =
        synchronized(writeLock) {
            val row = readable.rawQuery(
                "SELECT segment_id, is_manual_edited FROM utterances WHERE id = ? AND session_id = ?",
                arrayOf(utteranceId, sessionId),
            ).use { if (it.moveToFirst()) Pair(it.getString(0), it.getInt(1) != 0) else null }
                ?: return null
            if (row.second) return null // Manual edit protection!
            val cv = ContentValues().apply {
                put("refined_text", refinedText)
                put("is_refined", 1)
            }
            writable.update("utterances", cv, "id = ?", arrayOf(utteranceId))
            row.first
        }

    fun applyRegroupDecision(
        sessionId: String,
        utteranceId: String,
        action: String,
        updatedTopicTitle: String,
    ): Boolean = synchronized(writeLock) {
        val currentSegId = readable.rawQuery(
            "SELECT segment_id FROM utterances WHERE id = ? AND session_id = ?",
            arrayOf(utteranceId, sessionId),
        ).use { if (it.moveToFirst()) it.getString(0) else null } ?: return false

        val cleanTitle = updatedTopicTitle.trim().take(250).ifEmpty { "知识点分段" }
        val ts = nowIsoUtc()
        if (action == "create_new_segment") {
            val countInSeg = readable.rawQuery(
                "SELECT COUNT(*) FROM utterances WHERE segment_id = ?",
                arrayOf(currentSegId),
            ).use { if (it.moveToFirst()) it.getInt(0) else 0 }
            if (countInSeg <= 1) {
                val cv = ContentValues().apply {
                    put("topic_title", cleanTitle)
                    put("updated_at", ts)
                }
                writable.update("knowledge_segments", cv, "id = ?", arrayOf(currentSegId))
                return true
            }
            val maxIdx = readable.rawQuery(
                "SELECT COALESCE(MAX(order_index), -1) FROM knowledge_segments WHERE session_id = ?",
                arrayOf(sessionId),
            ).use { if (it.moveToFirst()) it.getInt(0) else -1 }
            val newSegId = newId()
            writable.insertOrThrow(
                "knowledge_segments",
                null,
                ContentValues().apply {
                    put("id", newSegId)
                    put("session_id", sessionId)
                    put("order_index", maxIdx + 1)
                    put("topic_title", cleanTitle)
                    put("created_at", ts)
                    put("updated_at", ts)
                },
            )
            // Move this utterance and any newer utterances in currentSegId to the new segment
            val uttCreated = readable.rawQuery(
                "SELECT created_at FROM utterances WHERE id = ?",
                arrayOf(utteranceId),
            ).use { if (it.moveToFirst()) it.getString(0) else ts }
            writable.execSQL(
                "UPDATE utterances SET segment_id = ? WHERE segment_id = ? AND (created_at > ? OR id = ?)",
                arrayOf(newSegId, currentSegId, uttCreated, utteranceId),
            )
            return true
        } else {
            val cv = ContentValues().apply {
                put("topic_title", cleanTitle)
                put("updated_at", ts)
            }
            writable.update("knowledge_segments", cv, "id = ?", arrayOf(currentSegId))
            return true
        }
    }

    fun addHighlights(segmentId: String, terms: List<Pair<String, String>>): List<HighlightItem> =
        synchronized(writeLock) {
            val existingTerms = listHighlightsForSegment(segmentId).map { it.term.lowercase() }.toMutableSet()
            for ((term, expl) in terms) {
                val t = term.trim().take(128)
                val e = expl.trim().take(500)
                if (t.isEmpty() || e.isEmpty()) continue
                if (!existingTerms.add(t.lowercase())) continue
                writable.insertOrThrow(
                    "segment_highlights",
                    null,
                    ContentValues().apply {
                        put("id", newId())
                        put("segment_id", segmentId)
                        put("term", t)
                        put("explanation", e)
                    },
                )
            }
            listHighlightsForSegment(segmentId)
        }

    fun saveSegmentExplanation(sessionId: String, segmentId: String, explanation: SegmentExplanation) =
        synchronized(writeLock) {
            val cv = ContentValues().apply {
                put("detailed_explanation", WireJson.encodeToString(explanation))
                put("updated_at", nowIsoUtc())
            }
            writable.update("knowledge_segments", cv, "id = ? AND session_id = ?", arrayOf(segmentId, sessionId))
        }

    fun patchUtterance(
        sessionId: String,
        utteranceId: String,
        req: UtterancePatchRequest,
    ): Pair<String, UtteranceItem> = synchronized(writeLock) {
        val segId = readable.rawQuery(
            "SELECT segment_id FROM utterances WHERE id = ? AND session_id = ?",
            arrayOf(utteranceId, sessionId),
        ).use { if (it.moveToFirst()) it.getString(0) else null }
            ?: throw AppException(404, "UTTERANCE_NOT_FOUND", "发言记录不存在")

        val cv = ContentValues()
        if (req.refinedText != null) {
            cv.put("refined_text", req.refinedText.trim())
            cv.put("is_refined", 1)
            cv.put("is_manual_edited", 1)
        }
        if (req.isBookmarked != null) {
            cv.put("is_bookmarked", if (req.isBookmarked) 1 else 0)
            if (!req.isBookmarked) cv.putNull("bookmark_kind")
        }
        if (req.bookmarkKind != null) {
            cv.put("bookmark_kind", req.bookmarkKind)
            cv.put("is_bookmarked", 1)
        }
        if (req.userNote != null) {
            val note = req.userNote.trim()
            if (note.isEmpty()) cv.putNull("user_note") else cv.put("user_note", note)
        }
        if (cv.size() > 0) {
            writable.update("utterances", cv, "id = ?", arrayOf(utteranceId))
        }
        val speakerMap = listSpeakers(sessionId).associate { it.id to it.label }
        val updated = listUtterancesForSegment(segId, speakerMap).first { it.id == utteranceId }
        Pair(segId, updated)
    }

    fun bookmarkNow(sessionId: String, req: BookmarkNowRequest): Triple<String, UtteranceItem, Boolean> =
        synchronized(writeLock) {
            ensureSessionExists(sessionId)
            val latest = readable.rawQuery(
                "SELECT id, segment_id FROM utterances WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
                arrayOf(sessionId),
            ).use { if (it.moveToFirst()) Pair(it.getString(0), it.getString(1)) else null }

            if (latest != null) {
                val (uttId, _) = latest
                val (segId, updated) = patchUtterance(
                    sessionId,
                    uttId,
                    UtterancePatchRequest(isBookmarked = true, bookmarkKind = req.kind, userNote = req.note),
                )
                return Triple(segId, updated, false)
            }
            val targetMs = req.timestampMs ?: sessionDurationMs(sessionId)
            val saved = saveFinalUtterance(sessionId, "default", "（标记为待搞懂时间点）", targetMs, targetMs)
            val (segId, updated) = patchUtterance(
                sessionId,
                saved.utterance.id,
                UtterancePatchRequest(isBookmarked = true, bookmarkKind = req.kind, userNote = req.note),
            )
            Triple(segId, updated, saved.createdInitialSegment != null)
        }

    // ---------------- Chat, Study Note, Flashcards ----------------

    fun listMessages(sessionId: String, attMap: Map<String, SessionAttachmentItem>): List<ChatMessage> {
        val list = mutableListOf<ChatMessage>()
        readable.rawQuery(
            """
            SELECT id, session_id, role, content, thinking, referenced_segment_count, attachment_ids_json, created_at
            FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC
            """.trimIndent(),
            arrayOf(sessionId),
        ).use { c ->
            while (c.moveToNext()) {
                val attIds = c.getString(6)?.takeIf { it.isNotBlank() }?.let {
                    runCatching { WireJson.decodeFromString<List<String>>(it) }.getOrDefault(emptyList())
                } ?: emptyList()
                val resolvedAtts = attIds.mapNotNull { attMap[it] }
                list.add(
                    ChatMessage(
                        id = c.getString(0),
                        sessionId = c.getString(1),
                        role = c.getString(2),
                        content = c.getString(3),
                        thinking = c.getString(4),
                        referencedSegmentCount = if (c.isNull(5)) null else c.getInt(5),
                        attachments = resolvedAtts,
                        createdAt = c.getString(7),
                    )
                )
            }
        }
        return list
    }

    fun addChatMessage(
        sessionId: String,
        role: String,
        content: String,
        thinking: String? = null,
        referencedSegmentCount: Int? = null,
        attachmentIds: List<String> = emptyList(),
    ): ChatMessage = synchronized(writeLock) {
        val id = newId()
        val ts = nowIsoUtc()
        val cv = ContentValues().apply {
            put("id", id)
            put("session_id", sessionId)
            put("role", role)
            put("content", content)
            if (thinking != null) put("thinking", thinking)
            if (referencedSegmentCount != null) put("referenced_segment_count", referencedSegmentCount)
            if (attachmentIds.isNotEmpty()) put("attachment_ids_json", WireJson.encodeToString(attachmentIds))
            put("created_at", ts)
        }
        writable.insertOrThrow("chat_messages", null, cv)
        writable.update("class_sessions", ContentValues().apply { put("updated_at", ts) }, "id = ?", arrayOf(sessionId))
        val attMap = listAttachments(sessionId).associateBy { it.id }
        ChatMessage(
            id = id,
            sessionId = sessionId,
            role = role,
            content = content,
            thinking = thinking,
            referencedSegmentCount = referencedSegmentCount,
            attachments = attachmentIds.mapNotNull { attMap[it] },
            createdAt = ts,
        )
    }

    fun saveStudyNote(sessionId: String, contentMarkdown: String, thinking: String? = null): SessionStudyNote =
        synchronized(writeLock) {
            val note = SessionStudyNote(
                contentMarkdown = contentMarkdown,
                thinking = thinking?.takeIf { it.isNotBlank() },
                updatedAt = nowIsoUtc(),
            )
            val cv = ContentValues().apply {
                put("study_note_json", WireJson.encodeToString(note))
                put("updated_at", note.updatedAt)
            }
            writable.update("class_sessions", cv, "id = ?", arrayOf(sessionId))
            note
        }

    fun saveFlashcards(sessionId: String, cards: List<FlashcardItem>): List<FlashcardItem> =
        synchronized(writeLock) {
            val cv = ContentValues().apply {
                put("flashcards_json", WireJson.encodeToString(cards))
                put("updated_at", nowIsoUtc())
            }
            writable.update("class_sessions", cv, "id = ?", arrayOf(sessionId))
            cards
        }

    // ---------------- Attachments ----------------

    fun listAttachments(sessionId: String): List<SessionAttachmentItem> {
        val list = mutableListOf<SessionAttachmentItem>()
        readable.rawQuery(
            """
            SELECT id, session_id, segment_id, kind, file_name, mime_type, size_bytes,
                   width, height, timestamp_ms, caption, extracted_text, created_at
            FROM session_attachments WHERE session_id = ? ORDER BY created_at ASC, id ASC
            """.trimIndent(),
            arrayOf(sessionId),
        ).use { c ->
            while (c.moveToNext()) {
                val id = c.getString(0)
                val tsMs = if (c.isNull(9)) null else c.getLong(9)
                val extracted = c.getString(11)
                list.add(
                    SessionAttachmentItem(
                        id = id,
                        sessionId = c.getString(1),
                        segmentId = c.getString(2),
                        kind = c.getString(3),
                        fileName = c.getString(4),
                        mimeType = c.getString(5),
                        sizeBytes = c.getLong(6),
                        width = if (c.isNull(7)) null else c.getInt(7),
                        height = if (c.isNull(8)) null else c.getInt(8),
                        timestampMs = tsMs,
                        timestampText = tsMs?.let { formatTimestampMs(it) },
                        caption = c.getString(10),
                        extractedPreview = extracted?.take(360),
                        url = "/api/v1/sessions/$sessionId/attachments/$id/raw",
                        createdAt = c.getString(12),
                    )
                )
            }
        }
        return list
    }

    fun saveAttachment(
        sessionId: String,
        fileName: String,
        mimeType: String,
        data: ByteArray,
        kind: String?,
        segmentId: String?,
        timestampMs: Long?,
        caption: String?,
    ): SessionAttachmentItem = synchronized(writeLock) {
        ensureSessionExists(sessionId)
        val id = newId()
        val cleanName = fileName.replace(Regex("""[^\w.\-\u4e00-\u9fff]"""), "_").take(120).ifBlank { "attachment.bin" }
        val resolvedKind = kind ?: if (mimeType.startsWith("image/")) "image" else "material"
        val resolvedSegId = segmentId ?: readable.rawQuery(
            "SELECT id FROM knowledge_segments WHERE session_id = ? ORDER BY order_index DESC LIMIT 1",
            arrayOf(sessionId),
        ).use { if (it.moveToFirst()) it.getString(0) else null }
        val resolvedTs = timestampMs ?: sessionDurationMs(sessionId)

        val sessionFolder = File(attachmentsDir, sessionId).apply { mkdirs() }
        val outFile = File(sessionFolder, "${id}_$cleanName")
        outFile.writeBytes(data)

        val extractedText = if (resolvedKind == "material" && (mimeType.startsWith("text/") ||
                cleanName.endsWith(".md") || cleanName.endsWith(".txt") ||
                cleanName.endsWith(".py") || cleanName.endsWith(".cpp") ||
                cleanName.endsWith(".c") || cleanName.endsWith(".java"))
        ) {
            runCatching { String(data, Charsets.UTF_8).take(12000) }.getOrNull()
        } else null

        val ts = nowIsoUtc()
        val cv = ContentValues().apply {
            put("id", id)
            put("session_id", sessionId)
            if (resolvedSegId != null) put("segment_id", resolvedSegId)
            put("kind", resolvedKind)
            put("file_name", cleanName)
            put("mime_type", mimeType)
            put("file_path", outFile.absolutePath)
            put("size_bytes", data.size.toLong())
            put("timestamp_ms", resolvedTs)
            if (caption != null) put("caption", caption)
            if (extractedText != null) put("extracted_text", extractedText)
            put("created_at", ts)
        }
        writable.insertOrThrow("session_attachments", null, cv)

        SessionAttachmentItem(
            id = id,
            sessionId = sessionId,
            segmentId = resolvedSegId,
            kind = resolvedKind,
            fileName = cleanName,
            mimeType = mimeType,
            sizeBytes = data.size.toLong(),
            timestampMs = resolvedTs,
            timestampText = formatTimestampMs(resolvedTs),
            caption = caption,
            extractedPreview = extractedText?.take(360),
            url = "/api/v1/sessions/$sessionId/attachments/$id/raw",
            createdAt = ts,
        )
    }

    fun readAttachmentRaw(sessionId: String, attachmentId: String): Triple<ByteArray, String, String> {
        val row = readable.rawQuery(
            "SELECT file_path, mime_type, file_name FROM session_attachments WHERE id = ? AND session_id = ?",
            arrayOf(attachmentId, sessionId),
        ).use { if (it.moveToFirst()) Triple(it.getString(0), it.getString(1), it.getString(2)) else null }
            ?: throw AppException(404, "ATTACHMENT_NOT_FOUND", "附件不存在")
        val f = File(row.first)
        if (!f.isFile) throw AppException(404, "ATTACHMENT_FILE_MISSING", "附件文件已丢失")
        return Triple(f.readBytes(), row.second, row.third)
    }

    fun deleteAttachment(sessionId: String, attachmentId: String) = synchronized(writeLock) {
        val path = readable.rawQuery(
            "SELECT file_path FROM session_attachments WHERE id = ? AND session_id = ?",
            arrayOf(attachmentId, sessionId),
        ).use { if (it.moveToFirst()) it.getString(0) else null }
        writable.delete("session_attachments", "id = ? AND session_id = ?", arrayOf(attachmentId, sessionId))
        if (path != null) File(path).delete()
    }

    // ---------------- Sticky Notes (with FCFS UNIQUE(session_id, timestamp_sec)) ----------------

    fun listStickyNotes(sessionId: String): List<StickyNoteItem> {
        val notes = mutableListOf<StickyNoteItem>()
        readable.rawQuery(
            """
            SELECT id, session_id, title, content, paper_color, pos_x, pos_y, width, height,
                   is_open, z_order, is_translucent, created_at, updated_at
            FROM sticky_notes WHERE session_id = ? ORDER BY created_at ASC, id ASC
            """.trimIndent(),
            arrayOf(sessionId),
        ).use { c ->
            while (c.moveToNext()) {
                val id = c.getString(0)
                val tsList = listStickyTimestampsForNote(id)
                notes.add(
                    StickyNoteItem(
                        id = id,
                        sessionId = c.getString(1),
                        title = c.getString(2),
                        content = c.getString(3),
                        paperColor = c.getString(4),
                        posX = c.getInt(5),
                        posY = c.getInt(6),
                        width = c.getInt(7),
                        height = c.getInt(8),
                        isOpen = c.getInt(9) != 0,
                        zOrder = c.getInt(10),
                        isTranslucent = c.getInt(11) != 0,
                        timestamps = tsList,
                        conflicts = emptyList(),
                        createdAt = c.getString(12),
                        updatedAt = c.getString(13),
                    )
                )
            }
        }
        return notes
    }

    private fun listStickyTimestampsForNote(noteId: String): List<StickyNoteTimestampItem> {
        val list = mutableListOf<StickyNoteTimestampItem>()
        readable.rawQuery(
            """
            SELECT id, note_id, timestamp_sec, timestamp_text, char_offset, created_at
            FROM sticky_note_timestamps WHERE note_id = ? ORDER BY char_offset ASC, timestamp_sec ASC
            """.trimIndent(),
            arrayOf(noteId),
        ).use { c ->
            while (c.moveToNext()) {
                list.add(
                    StickyNoteTimestampItem(
                        id = c.getString(0),
                        noteId = c.getString(1),
                        timestampSec = c.getInt(2),
                        timestampText = c.getString(3),
                        charOffset = c.getInt(4),
                        createdAt = c.getString(5),
                    )
                )
            }
        }
        return list
    }

    private fun syncStickyTimestamps(
        sessionId: String,
        noteId: String,
        content: String,
    ): Pair<List<StickyNoteTimestampItem>, List<StickyNoteTimestampConflict>> {
        val parsed = extractStickyTimestamps(content)
        val parsedBySec = parsed.associateBy { it.timestampSec }

        // Load existing timestamps owned by OTHER notes in this session (FCFS!)
        val otherOwners = mutableMapOf<Int, Pair<String, String>>()
        readable.rawQuery(
            """
            SELECT t.timestamp_sec, t.note_id, n.title
            FROM sticky_note_timestamps t
            JOIN sticky_notes n ON n.id = t.note_id
            WHERE t.session_id = ? AND t.note_id != ?
            """.trimIndent(),
            arrayOf(sessionId, noteId),
        ).use { c ->
            while (c.moveToNext()) {
                otherOwners[c.getInt(0)] = Pair(c.getString(1), c.getString(2))
            }
        }

        // Delete removed timestamps of this note
        val existingOwn = listStickyTimestampsForNote(noteId).associateBy { it.timestampSec }
        for ((sec, item) in existingOwn) {
            if (!parsedBySec.containsKey(sec)) {
                writable.delete("sticky_note_timestamps", "id = ?", arrayOf(item.id))
            }
        }

        val conflicts = mutableListOf<StickyNoteTimestampConflict>()
        val ts = nowIsoUtc()
        for (item in parsed) {
            val owner = otherOwners[item.timestampSec]
            if (owner != null) {
                conflicts.add(
                    StickyNoteTimestampConflict(
                        timestampSec = item.timestampSec,
                        timestampText = item.timestampText,
                        ownerNoteId = owner.first,
                        ownerNoteTitle = owner.second.ifBlank { "便签" },
                    )
                )
                continue
            }
            val prev = existingOwn[item.timestampSec]
            if (prev != null) {
                writable.update(
                    "sticky_note_timestamps",
                    ContentValues().apply {
                        put("char_offset", item.charOffset)
                        put("timestamp_text", item.timestampText)
                    },
                    "id = ?",
                    arrayOf(prev.id),
                )
            } else {
                writable.insertOrThrow(
                    "sticky_note_timestamps",
                    null,
                    ContentValues().apply {
                        put("id", newId())
                        put("session_id", sessionId)
                        put("note_id", noteId)
                        put("timestamp_sec", item.timestampSec)
                        put("timestamp_text", item.timestampText)
                        put("char_offset", item.charOffset)
                        put("created_at", ts)
                    },
                )
            }
        }
        return Pair(listStickyTimestampsForNote(noteId), conflicts)
    }

    fun createStickyNote(sessionId: String, req: StickyNoteCreateRequest): StickyNoteItem =
        synchronized(writeLock) {
            ensureSessionExists(sessionId)
            val id = newId()
            val ts = nowIsoUtc()
            val color = if (req.paperColor in setOf("cream", "butter", "sage", "blush")) req.paperColor else "cream"
            writable.insertOrThrow(
                "sticky_notes",
                null,
                ContentValues().apply {
                    put("id", id)
                    put("session_id", sessionId)
                    put("title", req.title.take(255))
                    put("content", req.content.take(32000))
                    put("paper_color", color)
                    put("pos_x", req.posX)
                    put("pos_y", req.posY)
                    put("width", req.width.coerceIn(240, 2000))
                    put("height", req.height.coerceIn(180, 2000))
                    put("is_open", if (req.isOpen) 1 else 0)
                    put("z_order", req.zOrder)
                    put("is_translucent", if (req.isTranslucent) 1 else 0)
                    put("created_at", ts)
                    put("updated_at", ts)
                },
            )
            val (timestamps, conflicts) = syncStickyTimestamps(sessionId, id, req.content)
            StickyNoteItem(
                id = id,
                sessionId = sessionId,
                title = req.title.take(255),
                content = req.content.take(32000),
                paperColor = color,
                posX = req.posX,
                posY = req.posY,
                width = req.width.coerceIn(240, 2000),
                height = req.height.coerceIn(180, 2000),
                isOpen = req.isOpen,
                zOrder = req.zOrder,
                isTranslucent = req.isTranslucent,
                timestamps = timestamps,
                conflicts = conflicts,
                createdAt = ts,
                updatedAt = ts,
            )
        }

    fun updateStickyNote(sessionId: String, noteId: String, req: StickyNotePatchRequest): StickyNoteItem =
        synchronized(writeLock) {
            val existing = listStickyNotes(sessionId).firstOrNull { it.id == noteId }
                ?: throw AppException(404, "STICKY_NOTE_NOT_FOUND", "便签不存在")
            val ts = nowIsoUtc()
            val nextContent = req.content?.take(32000) ?: existing.content
            val cv = ContentValues().apply {
                req.title?.let { put("title", it.take(255)) }
                req.content?.let { put("content", nextContent) }
                req.paperColor?.takeIf { it in setOf("cream", "butter", "sage", "blush") }?.let { put("paper_color", it) }
                req.posX?.let { put("pos_x", it) }
                req.posY?.let { put("pos_y", it) }
                req.width?.let { put("width", it.coerceIn(240, 2000)) }
                req.height?.let { put("height", it.coerceIn(180, 2000)) }
                req.isOpen?.let { put("is_open", if (it) 1 else 0) }
                req.zOrder?.let { put("z_order", it) }
                req.isTranslucent?.let { put("is_translucent", if (it) 1 else 0) }
                put("updated_at", ts)
            }
            writable.update("sticky_notes", cv, "id = ? AND session_id = ?", arrayOf(noteId, sessionId))
            val (timestamps, conflicts) = if (req.content != null) {
                syncStickyTimestamps(sessionId, noteId, nextContent)
            } else {
                Pair(listStickyTimestampsForNote(noteId), emptyList())
            }
            listStickyNotes(sessionId).first { it.id == noteId }.copy(
                timestamps = timestamps,
                conflicts = conflicts,
            )
        }

    fun setAllStickyNotesOpen(sessionId: String, isOpen: Boolean): List<StickyNoteItem> =
        synchronized(writeLock) {
            ensureSessionExists(sessionId)
            writable.update(
                "sticky_notes",
                ContentValues().apply {
                    put("is_open", if (isOpen) 1 else 0)
                    put("updated_at", nowIsoUtc())
                },
                "session_id = ?",
                arrayOf(sessionId),
            )
            listStickyNotes(sessionId)
        }

    fun deleteStickyNote(sessionId: String, noteId: String) = synchronized(writeLock) {
        writable.delete("sticky_notes", "id = ? AND session_id = ?", arrayOf(noteId, sessionId))
    }

    // ---------------- Global Search ----------------

    fun searchGlobal(query: String, folderId: String?): List<SearchHitItem> {
        val q = query.trim()
        if (q.isEmpty()) return emptyList()
        val like = "%$q%"
        val hits = mutableListOf<SearchHitItem>()
        val folderClause = if (folderId != null) " AND s.folder_id = ?" else ""
        fun args(vararg base: String): Array<String> =
            if (folderId != null) arrayOf(*base, folderId) else arrayOf(*base)

        // 1. Session title
        readable.rawQuery(
            "SELECT s.id, s.title, s.folder_id, s.updated_at FROM class_sessions s WHERE s.title LIKE ?$folderClause LIMIT 20",
            args(like),
        ).use { c ->
            while (c.moveToNext()) {
                hits.add(
                    SearchHitItem(
                        sessionId = c.getString(0),
                        sessionTitle = c.getString(1),
                        folderId = c.getString(2),
                        kind = "title",
                        snippet = c.getString(1),
                        updatedAt = c.getString(3),
                    )
                )
            }
        }

        // 2. Segment topics
        readable.rawQuery(
            """
            SELECT s.id, s.title, s.folder_id, k.id, k.topic_title, s.updated_at
            FROM knowledge_segments k JOIN class_sessions s ON s.id = k.session_id
            WHERE k.topic_title LIKE ?$folderClause LIMIT 30
            """.trimIndent(),
            args(like),
        ).use { c ->
            while (c.moveToNext()) {
                hits.add(
                    SearchHitItem(
                        sessionId = c.getString(0),
                        sessionTitle = c.getString(1),
                        folderId = c.getString(2),
                        kind = "topic",
                        segmentId = c.getString(3),
                        snippet = c.getString(4),
                        updatedAt = c.getString(5),
                    )
                )
            }
        }

        // 3. Utterances & user notes
        readable.rawQuery(
            """
            SELECT s.id, s.title, s.folder_id, u.segment_id, u.id, u.start_time_ms, u.refined_text, u.user_note, s.updated_at
            FROM utterances u JOIN class_sessions s ON s.id = u.session_id
            WHERE (u.refined_text LIKE ? OR u.raw_text LIKE ? OR u.user_note LIKE ?)$folderClause
            LIMIT 40
            """.trimIndent(),
            args(like, like, like),
        ).use { c ->
            while (c.moveToNext()) {
                val note = c.getString(7)
                val isNoteMatch = !note.isNullOrBlank() && note.contains(q, ignoreCase = true)
                val tsMs = c.getLong(5)
                hits.add(
                    SearchHitItem(
                        sessionId = c.getString(0),
                        sessionTitle = c.getString(1),
                        folderId = c.getString(2),
                        kind = if (isNoteMatch) "note" else "utterance",
                        segmentId = c.getString(3),
                        utteranceId = c.getString(4),
                        timestampMs = tsMs,
                        timestampText = formatTimestampMs(tsMs),
                        snippet = (if (isNoteMatch) note!! else c.getString(6)).take(160),
                        updatedAt = c.getString(8),
                    )
                )
            }
        }

        // 4. Highlights
        readable.rawQuery(
            """
            SELECT s.id, s.title, s.folder_id, h.segment_id, h.term, h.explanation, s.updated_at
            FROM segment_highlights h
            JOIN knowledge_segments k ON k.id = h.segment_id
            JOIN class_sessions s ON s.id = k.session_id
            WHERE (h.term LIKE ? OR h.explanation LIKE ?)$folderClause LIMIT 20
            """.trimIndent(),
            args(like, like),
        ).use { c ->
            while (c.moveToNext()) {
                hits.add(
                    SearchHitItem(
                        sessionId = c.getString(0),
                        sessionTitle = c.getString(1),
                        folderId = c.getString(2),
                        kind = "highlight",
                        segmentId = c.getString(3),
                        snippet = "${c.getString(4)}：${c.getString(5)}".take(160),
                        updatedAt = c.getString(6),
                    )
                )
            }
        }

        // 5. Sticky notes
        readable.rawQuery(
            """
            SELECT s.id, s.title, s.folder_id, n.id, n.title, n.content, s.updated_at
            FROM sticky_notes n JOIN class_sessions s ON s.id = n.session_id
            WHERE (n.title LIKE ? OR n.content LIKE ?)$folderClause LIMIT 20
            """.trimIndent(),
            args(like, like),
        ).use { c ->
            while (c.moveToNext()) {
                val nTitle = c.getString(4)
                val nBody = c.getString(5)
                hits.add(
                    SearchHitItem(
                        sessionId = c.getString(0),
                        sessionTitle = c.getString(1),
                        folderId = c.getString(2),
                        kind = "sticky_note",
                        stickyNoteId = c.getString(3),
                        snippet = listOf(nTitle, nBody).filter { it.isNotBlank() }.joinToString(" · ").take(160),
                        updatedAt = c.getString(6),
                    )
                )
            }
        }

        // 6. Chat messages
        readable.rawQuery(
            """
            SELECT s.id, s.title, s.folder_id, m.content, s.updated_at
            FROM chat_messages m JOIN class_sessions s ON s.id = m.session_id
            WHERE m.content LIKE ?$folderClause LIMIT 20
            """.trimIndent(),
            args(like),
        ).use { c ->
            while (c.moveToNext()) {
                hits.add(
                    SearchHitItem(
                        sessionId = c.getString(0),
                        sessionTitle = c.getString(1),
                        folderId = c.getString(2),
                        kind = "chat",
                        snippet = c.getString(3).take(160),
                        updatedAt = c.getString(4),
                    )
                )
            }
        }

        return hits.sortedByDescending { it.updatedAt }.take(60)
    }

    private fun Cursor.toFolder(): FolderItem {
        val hwRaw = getString(3)
        val hw = hwRaw?.takeIf { it.isNotBlank() }?.let {
            runCatching { WireJson.decodeFromString<List<String>>(it) }.getOrDefault(emptyList())
        } ?: emptyList()
        return FolderItem(
            id = getString(0),
            name = getString(1),
            parentId = getString(2),
            hotwords = hw,
            createdAt = getString(4),
            updatedAt = getString(5),
        )
    }

    private fun Cursor.toSessionCard(): SessionCard = SessionCard(
        id = getString(0),
        folderId = getString(1),
        title = getString(2),
        status = getString(3),
        durationSeconds = getInt(4),
        createdAt = getString(5),
        updatedAt = getString(6),
        speakerCount = getInt(7),
        segmentCount = getInt(8),
    )
}
