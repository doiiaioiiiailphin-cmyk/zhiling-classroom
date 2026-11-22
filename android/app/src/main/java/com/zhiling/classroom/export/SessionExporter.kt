package com.zhiling.classroom.export

import com.zhiling.classroom.model.SessionExportRequest
import com.zhiling.classroom.model.WorkspacePayload
import java.io.ByteArrayOutputStream
import java.net.URLEncoder
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

data class ExportedDocument(
    val bytes: ByteArray,
    val mimeType: String,
    val fileName: String,
    val contentDisposition: String,
)

/**
 * 与桌面端 backend/app/services/exporter.py 对齐的四格式导出器（Markdown / TXT / Anki / DOCX）。
 */
object SessionExporter {

    fun export(ws: WorkspacePayload, req: SessionExportRequest): ExportedDocument {
        val safeTitle = ws.session.title
            .replace(Regex("""[\\/:*?"<>|]"""), "_")
            .trim()
            .ifBlank { "知聆课堂记录" }

        return when (req.format.lowercase()) {
            "txt" -> {
                val content = buildPlainText(ws, req)
                pack(content.toByteArray(Charsets.UTF_8), "text/plain; charset=utf-8", "$safeTitle.txt")
            }
            "anki" -> {
                val content = buildAnkiTsv(ws)
                pack(content.toByteArray(Charsets.UTF_8), "text/tab-separated-values; charset=utf-8", "$safeTitle-anki.tsv")
            }
            "docx" -> {
                val bytes = buildDocx(ws, req)
                pack(
                    bytes,
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    "$safeTitle.docx",
                )
            }
            else -> {
                val content = buildMarkdown(ws, req)
                pack(content.toByteArray(Charsets.UTF_8), "text/markdown; charset=utf-8", "$safeTitle.md")
            }
        }
    }

    private fun pack(bytes: ByteArray, mime: String, fileName: String): ExportedDocument {
        val encoded = URLEncoder.encode(fileName, "UTF-8").replace("+", "%20")
        return ExportedDocument(
            bytes = bytes,
            mimeType = mime,
            fileName = fileName,
            contentDisposition = "attachment; filename*=UTF-8''$encoded",
        )
    }

    fun buildMarkdown(ws: WorkspacePayload, req: SessionExportRequest): String = buildString {
        appendLine("# ${ws.session.title}")
        appendLine()
        appendLine("- 创建时间：${ws.session.createdAt}")
        appendLine("- 课堂时长：${ws.session.durationSeconds} 秒")
        appendLine("- 知识点分段：${ws.segments.size} 段")
        appendLine()

        if (req.includeStudyNote && ws.studyNote != null && ws.studyNote.contentMarkdown.isNotBlank()) {
            appendLine("## 全课精编笔记")
            appendLine()
            appendLine(ws.studyNote.contentMarkdown.trim())
            appendLine()
        }

        if (req.includeStickyNotes && ws.stickyNotes.isNotEmpty()) {
            appendLine("## 课堂便签条")
            appendLine()
            ws.stickyNotes.forEachIndexed { idx, note ->
                val title = note.title.ifBlank { "便签 ${idx + 1}" }
                appendLine("### $title")
                if (note.content.isNotBlank()) {
                    appendLine(note.content.trim())
                }
                appendLine()
            }
        }

        if (req.includeHighlights) {
            val allTerms = ws.segments.flatMap { it.highlights }
            if (allTerms.isNotEmpty()) {
                appendLine("## 重点术语表")
                appendLine()
                for (h in allTerms) {
                    appendLine("- **${h.term}**：${h.explanation}")
                }
                appendLine()
            }
        }

        if (req.includeChat && ws.messages.isNotEmpty()) {
            appendLine("## 课堂实时问答")
            appendLine()
            for (msg in ws.messages) {
                val label = if (msg.role == "user") "提问" else "AI 解答"
                appendLine("### $label")
                appendLine(msg.content.trim())
                appendLine()
            }
        }

        if (req.includeTranscript && ws.segments.isNotEmpty()) {
            appendLine("## 课堂转写记录")
            appendLine()
            for (seg in ws.segments) {
                appendLine("### ${seg.orderIndex + 1}. ${seg.topicTitle}")
                appendLine()
                for (u in seg.utterances) {
                    val text = if (u.isRefined) u.refinedText else u.rawText
                    if (text.isBlank()) continue
                    val mark = if (u.isBookmarked) " [待搞懂]" else ""
                    appendLine("- **[${u.timestampText}] ${u.speakerLabel}**$mark：$text")
                    if (!u.userNote.isNullOrBlank()) {
                        appendLine("  > 批注：${u.userNote}")
                    }
                }
                appendLine()
            }
        }
    }

    private fun buildPlainText(ws: WorkspacePayload, req: SessionExportRequest): String {
        return buildMarkdown(ws, req)
            .replace(Regex("""^#+\s*""", RegexOption.MULTILINE), "")
            .replace("**", "")
    }

    private fun buildAnkiTsv(ws: WorkspacePayload): String = buildString {
        for (card in ws.flashcards) {
            val front = card.front.replace("\t", " ").replace("\n", "<br>")
            val back = card.back.replace("\t", " ").replace("\n", "<br>")
            val tag = card.tag.replace("\t", " ").replace(" ", "_")
            appendLine("$front\t$back\t$tag")
        }
    }

    private fun xmlEscape(text: String): String = text
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")
        .replace("'", "&apos;")

    private fun buildDocx(ws: WorkspacePayload, req: SessionExportRequest): ByteArray {
        val lines = buildPlainText(ws, req).lines()
        val bodyXml = buildString {
            for (line in lines) {
                append("<w:p><w:r><w:t xml:space=\"preserve\">")
                append(xmlEscape(line))
                append("</w:t></w:r></w:p>")
            }
        }
        val documentXml = """
            <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
              <w:body>$bodyXml</w:body>
            </w:document>
        """.trimIndent()
        val contentTypes = """
            <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
              <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
              <Default Extension="xml" ContentType="application/xml"/>
              <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
            </Types>
        """.trimIndent()
        val rels = """
            <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
              <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
            </Relationships>
        """.trimIndent()

        val baos = ByteArrayOutputStream()
        ZipOutputStream(baos).use { zos ->
            fun put(name: String, content: String) {
                zos.putNextEntry(ZipEntry(name))
                zos.write(content.toByteArray(Charsets.UTF_8))
                zos.closeEntry()
            }
            put("[Content_Types].xml", contentTypes)
            put("_rels/.rels", rels)
            put("word/document.xml", documentXml)
        }
        return baos.toByteArray()
    }
}
