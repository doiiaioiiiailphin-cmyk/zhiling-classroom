package com.zhiling.classroom

import com.zhiling.classroom.ai.ClassroomAiService
import com.zhiling.classroom.ai.InlineThinkSplitter
import com.zhiling.classroom.ai.LlmStreamEvent
import com.zhiling.classroom.audio.AudioChannelMixer
import com.zhiling.classroom.audio.SenseVoiceEngine
import com.zhiling.classroom.audio.WavStorage
import com.zhiling.classroom.export.SessionExporter
import com.zhiling.classroom.model.*
import com.zhiling.classroom.service.OverlayBoundsMath
import com.zhiling.classroom.service.OverlaySpringMath
import com.zhiling.classroom.settings.SettingsManager
import com.zhiling.classroom.update.AndroidUpdater
import kotlinx.serialization.encodeToString
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.util.zip.ZipInputStream

class ZhilingCoreTests {

    @get:Rule
    val tempFolder = TemporaryFolder()

    @Test
    fun testWireJsonPreservesExplicitNullFolderId() {
        val ts = nowIsoUtc()
        val card = SessionCard("s1", null, "测试课堂", "idle", 0, 0, 0, ts, ts)
        val encoded = WireJson.encodeToString(card)
        assertTrue("Root session must serialize explicit null folderId", encoded.contains("\"folderId\":null"))
    }

    @Test
    fun testStickyTimestampExtractionAndValidation() {
        val content = "先看 [04:12] 推导，再对照 [01:02:05] 结论，非法 [04:75] 忽略，重复 [04:12] 去重。"
        val parsed = extractStickyTimestamps(content)
        assertEquals(2, parsed.size)
        assertEquals(252, parsed[0].timestampSec)
        assertEquals("04:12", parsed[0].timestampText)
        assertEquals(3725, parsed[1].timestampSec)
        assertEquals("01:02:05", parsed[1].timestampText)
    }

    @Test
    fun testFillerOnlyCorrectionGuardrail() {
        // Pure filler -> empty string allowed
        assertEquals("", ClassroomAiService.guardFillerOnlyCorrection("嗯嗯，啊，呃...", ""))
        // Incomplete fragment -> NEVER deleted
        assertEquals("所以我们下一步要", ClassroomAiService.guardFillerOnlyCorrection("所以我们下一步要", ""))
        // Auto-completion attempt -> rejected, preserves rawText
        assertEquals(
            "因为矩阵的秩",
            ClassroomAiService.guardFillerOnlyCorrection("因为矩阵的秩", "因为矩阵的秩等于行空间的维数"),
        )
        // Legitimate filler removal -> accepted
        assertEquals(
            "线性方程组有唯一解",
            ClassroomAiService.guardFillerOnlyCorrection("嗯线性方程组啊有唯一解呢", "线性方程组有唯一解"),
        )
    }

    @Test
    fun testInlineThinkSplitterAcrossSplitTags() {
        val splitter = InlineThinkSplitter()
        val events = mutableListOf<LlmStreamEvent>()
        events += splitter.feed("前言<thi")
        events += splitter.feed("nk>推导步骤1")
        events += splitter.feed("</thi")
        events += splitter.feed("nk>最终答案")
        events += splitter.flush()

        val thinking = events.filterIsInstance<LlmStreamEvent.ThinkingDelta>().joinToString("") { it.delta }
        val content = events.filterIsInstance<LlmStreamEvent.ContentDelta>().joinToString("") { it.delta }
        assertEquals("推导步骤1", thinking)
        assertEquals("前言最终答案", content)
    }

    @Test
    fun testWavArchiveAppendAndHttpRangeSlicing() {
        val storage = WavStorage(tempFolder.newFolder("audio"))
        val oneSecPcm = ByteArray(32_000) { (it and 0xFF).toByte() } // 1000ms @ 16kHz 16-bit mono
        storage.openWriter("s1").use { w ->
            w.append(oneSecPcm)
            w.append(oneSecPcm)
            assertEquals(2000L, w.durationMs())
        }
        assertEquals(2000L, storage.existingDurationMs("s1"))

        val range = storage.readWavRange("s1", "bytes=0-43")
        assertEquals(206, range.statusCode)
        assertEquals(44, range.bytes.size)
        assertEquals("RIFF", String(range.bytes, 0, 4, Charsets.US_ASCII))
        assertEquals("WAVE", String(range.bytes, 8, 4, Charsets.US_ASCII))
        assertTrue(range.headers["Content-Range"]!!.startsWith("bytes 0-43/"))
    }

    @Test
    fun testAndroidUpdaterSemverAndApkSelection() {
        assertTrue(AndroidUpdater.compareSemver("0.1.11", "0.1.10") > 0)
        assertTrue(AndroidUpdater.compareSemver("0.2.0", "0.1.10") > 0)
        assertEquals(0, AndroidUpdater.compareSemver("v0.1.10", "0.1.10"))

        val assets = listOf(
            UpdateAssetInfo("ZhilingClassroom-Windows-x86_64.zip", 60_000_000, "", "https://cnb.cool/a"),
            UpdateAssetInfo("ZhilingClassroom-macOS-arm64.dmg", 42_000_000, "", "https://cnb.cool/b"),
            UpdateAssetInfo("ZhilingClassroom-Android-arm64.apk", 28_000_000, "a".repeat(64), "https://cnb.cool/c"),
        )
        val picked = AndroidUpdater.selectAndroidAsset(assets)
        assertNotNull(picked)
        assertEquals("ZhilingClassroom-Android-arm64.apk", picked!!.name)
    }

    @Test
    fun testSenseVoiceTextCleanerAndPcmConversion() {
        assertEquals(
            "今天讲动态规划。",
            SenseVoiceEngine.cleanSenseVoiceText("<|zh|><|NEUTRAL|><|Speech|><|withitn|>今天讲动态规划。"),
        )
        // Little-endian +16384 (~0.5f)
        val pcm = byteArrayOf(0x00, 0x40, 0x00, 0xC0.toByte())
        val floats = SenseVoiceEngine.pcm16LeToFloats(pcm)
        assertEquals(2, floats.size)
        assertEquals(0.5f, floats[0], 0.001f)
        assertEquals(-0.5f, floats[1], 0.001f)
    }

    @Test
    fun testSessionExporterGeneratesMarkdownAnkiAndValidDocx() {
        val ts = nowIsoUtc()
        val ws = WorkspacePayload(
            session = SessionCard("s1", null, "测试高数课", "paused", 120, 1, 1, ts, ts),
            segments = listOf(
                KnowledgeSegment(
                    id = "seg1",
                    sessionId = "s1",
                    orderIndex = 0,
                    topicTitle = "拉格朗日中值定理",
                    utterances = listOf(
                        UtteranceItem("u1", "sp1", "教授", "00:15", 15000, 20000, "函数连续可导", "函数连续可导", true),
                    ),
                    highlights = listOf(HighlightItem("h1", "中值定理", "连接导数与增量的核心桥梁")),
                )
            ),
            stickyNotes = listOf(
                StickyNoteItem("n1", "s1", "考前必背", "[00:15] 闭区间连续开区间可导", createdAt = ts, updatedAt = ts),
            ),
            flashcards = listOf(FlashcardItem("c1", "中值定理条件？", "闭区间连续、开区间可导", "微积分")),
        )

        val md = SessionExporter.export(ws, SessionExportRequest(format = "markdown"))
        val mdText = String(md.bytes, Charsets.UTF_8)
        assertTrue(mdText.contains("拉格朗日中值定理"))
        assertTrue(mdText.contains("考前必背"))

        val anki = SessionExporter.export(ws, SessionExportRequest(format = "anki"))
        assertTrue(String(anki.bytes, Charsets.UTF_8).contains("中值定理条件？\t闭区间连续、开区间可导\t微积分"))

        val docx = SessionExporter.export(ws, SessionExportRequest(format = "docx"))
        val entries = mutableSetOf<String>()
        ZipInputStream(ByteArrayInputStream(docx.bytes)).use { zis ->
            while (true) {
                val e = zis.nextEntry ?: break
                entries.add(e.name)
            }
        }
        assertTrue(entries.contains("word/document.xml"))
        assertTrue(entries.contains("[Content_Types].xml"))
    }

    @Test
    fun testAudioChannelMixerSumsAndClampsPcm16() {
        fun le16(vararg samples: Int): ByteArray {
            val out = ByteArray(samples.size * 2)
            samples.forEachIndexed { idx, v ->
                out[idx * 2] = (v and 0xFF).toByte()
                out[idx * 2 + 1] = ((v ushr 8) and 0xFF).toByte()
            }
            return out
        }
        fun readLe16(buf: ByteArray, idx: Int): Int =
            ((buf[idx * 2 + 1].toInt() shl 8) or (buf[idx * 2].toInt() and 0xFF)).toShort().toInt()

        val mic = le16(1000, 30000, -30000)
        val sys = le16(2500, 15000, -15000)
        val mixed = AudioChannelMixer.mixPcm16Mono(mic, sys, mic.size)
        assertEquals(6, mixed.size)
        assertEquals(3500, readLe16(mixed, 0))
        assertEquals(Short.MAX_VALUE.toInt(), readLe16(mixed, 1))
        assertEquals(Short.MIN_VALUE.toInt(), readLe16(mixed, 2))

        val sysOnly = AudioChannelMixer.mixPcm16Mono(null, sys, sys.size)
        assertArrayEquals(sys, sysOnly)
    }

    @Test
    fun testDualChannelSpeakerResolution() {
        assertEquals(
            "remote",
            AudioChannelMixer.resolveSpeakerChannel(0.0, 0.5, splitEnabled = false, micActive = false, sysActive = true),
        )
        assertEquals(
            "self",
            AudioChannelMixer.resolveSpeakerChannel(0.8, 0.2, splitEnabled = true, micActive = true, sysActive = true),
        )
        assertEquals(
            "remote",
            AudioChannelMixer.resolveSpeakerChannel(0.1, 0.9, splitEnabled = true, micActive = true, sysActive = true),
        )
        assertEquals(
            "default",
            AudioChannelMixer.resolveSpeakerChannel(0.8, 0.2, splitEnabled = false, micActive = true, sysActive = true),
        )
    }

    @Test
    fun testOverlayBoundsClampAcrossPortraitAndLandscape() {
        // Rotating from portrait (1080x2400) where window was at y=1600 into landscape (2400x1080)
        val clamped = OverlayBoundsMath.clampExpanded(
            x = 200,
            y = 1600,
            width = 960,
            height = 1200,
            screenW = 2400,
            screenH = 1080,
            minW = 520,
            minH = 340,
            marginPx = 20,
        )
        assertEquals(960, clamped.width)
        assertEquals(1040, clamped.height)
        assertEquals(20, clamped.y)
        assertTrue(clamped.x >= 20 && clamped.x + clamped.width <= 2380)

        // Bubble edge snap left vs right
        assertEquals(20, OverlayBoundsMath.snapBubbleX(centerX = 300, screenW = 1080, bubbleW = 200, marginPx = 20))
        assertEquals(860, OverlayBoundsMath.snapBubbleX(centerX = 800, screenW = 1080, bubbleW = 200, marginPx = 20))

        // Expanding after moving collapsed bubble to bottom-right follows new bubble location instead of old top coords
        val expandedBottomRight = OverlayBoundsMath.expandFromBubble(
            bubbleX = 860,
            bubbleY = 2050,
            bubbleW = 200,
            targetW = 900,
            targetH = 600,
            screenW = 1080,
            screenH = 2400,
            minW = 520,
            minH = 340,
            marginPx = 20,
        )
        assertEquals(160, expandedBottomRight.x)
        assertEquals(1780, expandedBottomRight.y)
        assertEquals(900, expandedBottomRight.width)
        assertEquals(600, expandedBottomRight.height)

        // Expanding after moving collapsed bubble to mid-left anchors flush to left at new y
        val expandedMidLeft = OverlayBoundsMath.expandFromBubble(
            bubbleX = 20,
            bubbleY = 920,
            bubbleW = 200,
            targetW = 900,
            targetH = 600,
            screenW = 1080,
            screenH = 2400,
            minW = 520,
            minH = 340,
            marginPx = 20,
        )
        assertEquals(20, expandedMidLeft.x)
        assertEquals(920, expandedMidLeft.y)
    }

    @Test
    fun testDefaultSettingsRequireUserModelConfigAndDisableAutoAi() {
        val defaults = SettingsManager.defaultSettings()
        assertFalse(defaults.llmProviders.containsKey("opencode-free-bridge"))
        assertEquals(12, defaults.llmProviders.size)
        assertEquals("deepseek", defaults.selectedLlmProviderId)
        assertEquals("", defaults.llmProviders["deepseek"]?.apiKey)
        assertTrue(defaults.llmProviders["deepseek"]?.availableModels.orEmpty().isEmpty())

        assertTrue(defaults.featureRouting.chat.enabled)
        assertEquals("", defaults.featureRouting.chat.modelId)
        assertFalse(defaults.featureRouting.sentenceCorrection.enabled)
        assertFalse(defaults.featureRouting.resegmentation.enabled)
        assertFalse(defaults.featureRouting.keyTermHighlight.enabled)
        assertFalse(defaults.featureRouting.bubbleExplanation.enabled)
    }

    @Test
    fun testUtteranceBatchDeleteWireModelsRoundTrip() {
        val req = UtteranceBatchDeleteRequest(utteranceIds = listOf("u-1", "u-2", "u-3"))
        val reqJson = WireJson.encodeToString(UtteranceBatchDeleteRequest.serializer(), req)
        val decodedReq = WireJson.decodeFromString(UtteranceBatchDeleteRequest.serializer(), reqJson)
        assertEquals(listOf("u-1", "u-2", "u-3"), decodedReq.utteranceIds)

        val res = UtteranceDeleteResult(
            deletedIds = listOf("u-1", "u-2"),
            deletedCount = 2,
            segments = emptyList(),
        )
        val resJson = WireJson.encodeToString(UtteranceDeleteResult.serializer(), res)
        val decodedRes = WireJson.decodeFromString(UtteranceDeleteResult.serializer(), resJson)
        assertEquals(2, decodedRes.deletedCount)
        assertEquals(listOf("u-1", "u-2"), decodedRes.deletedIds)
        assertTrue(decodedRes.segments.isEmpty())
    }

    @Test
    fun testOverlaySpringMathConvergesSmoothly() {
        // 验证 120Hz 下 RK4 弹簧可稳定收敛至目标位置，且能安全消化卡顿大步长
        var state = OverlaySpringMath.SpringState(value = 24.0, velocity = 600.0, settled = false)
        var frames = 0
        while (!state.settled && frames < 360) {
            state = OverlaySpringMath.stepSpring(
                value = state.value,
                velocity = state.velocity,
                target = 960.0,
                dtSeconds = 1.0 / 120.0,
                stiffness = 400.0,
                damping = 33.0,
            )
            frames += 1
        }
        assertTrue("RK4 spring should settle within 3s at 120Hz", state.settled)
        assertEquals(960.0, state.value, 0.001)
        assertEquals(0.0, state.velocity, 0.001)

        // 卡顿帧大 dt（0.25s）也不得发散爆炸
        val spike = OverlaySpringMath.stepSpring(
            value = 100.0,
            velocity = 200.0,
            target = 500.0,
            dtSeconds = 0.25,
            stiffness = 400.0,
            damping = 33.0,
        )
        assertTrue(spike.value.isFinite())
        assertTrue(spike.velocity.isFinite())
        assertTrue(spike.value in 90.0..580.0)
    }
}
