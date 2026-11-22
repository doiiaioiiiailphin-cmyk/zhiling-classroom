package com.zhiling.classroom.audio

import com.zhiling.classroom.model.AppException
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * 16 kHz / 16-bit / Mono PCM16 增量 WAV 存储引擎，支持断点续录与 HTTP 206 Partial Content 拖拽播放。
 */
class WavStorage(
    private val audioDir: File,
) {
    init {
        audioDir.mkdirs()
    }

    fun fileFor(sessionId: String): File = File(audioDir, "$sessionId.wav")

    fun existingDurationMs(sessionId: String): Long {
        val f = fileFor(sessionId)
        if (!f.isFile || f.length() <= WAV_HEADER_BYTES) return 0L
        val pcmBytes = (f.length() - WAV_HEADER_BYTES).coerceAtLeast(0L)
        return pcmBytes / BYTES_PER_MS
    }

    fun deleteSessionAudio(sessionId: String) {
        fileFor(sessionId).delete()
    }

    fun openWriter(sessionId: String): WavAppendWriter = WavAppendWriter(fileFor(sessionId))

    fun readPcmWindow(sessionId: String, fromMs: Long, toMs: Long): ByteArray {
        val f = fileFor(sessionId)
        if (!f.isFile || f.length() <= WAV_HEADER_BYTES) return ByteArray(0)
        val totalPcm = (f.length() - WAV_HEADER_BYTES).coerceAtLeast(0L)
        val startByte = ((fromMs.coerceAtLeast(0L) * BYTES_PER_MS) and -2L).coerceAtMost(totalPcm)
        val endByte = ((toMs.coerceAtLeast(fromMs) * BYTES_PER_MS) and -2L).coerceAtMost(totalPcm)
        val len = (endByte - startByte).toInt()
        if (len <= 0) return ByteArray(0)
        val out = ByteArray(len)
        RandomAccessFile(f, "r").use { raf ->
            raf.seek(WAV_HEADER_BYTES + startByte)
            raf.readFully(out)
        }
        return out
    }

    data class RangeSlice(
        val bytes: ByteArray,
        val statusCode: Int,
        val headers: Map<String, String>,
    )

    fun readWavRange(sessionId: String, rangeHeader: String?): RangeSlice {
        val f = fileFor(sessionId)
        if (!f.isFile || f.length() <= WAV_HEADER_BYTES) {
            throw AppException(404, "AUDIO_NOT_FOUND", "当前课堂暂无本地录音文件")
        }
        val total = f.length()
        if (rangeHeader.isNullOrBlank() || !rangeHeader.startsWith("bytes=")) {
            val bytes = f.readBytes()
            return RangeSlice(
                bytes = bytes,
                statusCode = 200,
                headers = mapOf(
                    "Accept-Ranges" to "bytes",
                    "Content-Length" to total.toString(),
                    "Cache-Control" to "no-store",
                ),
            )
        }

        val spec = rangeHeader.removePrefix("bytes=").substringBefore(",").trim()
        val parts = spec.split("-")
        val start = parts.getOrNull(0)?.takeIf { it.isNotEmpty() }?.toLongOrNull() ?: 0L
        val rawEnd = parts.getOrNull(1)?.takeIf { it.isNotEmpty() }?.toLongOrNull()
        val clampedStart = start.coerceIn(0L, total - 1L)
        val maxChunk = 2L * 1024L * 1024L // 2 MB chunk cap for smooth mobile seeking
        val clampedEnd = (rawEnd ?: minOf(total - 1L, clampedStart + maxChunk - 1L))
            .coerceIn(clampedStart, total - 1L)
        val len = (clampedEnd - clampedStart + 1L).toInt()
        val buf = ByteArray(len)
        RandomAccessFile(f, "r").use { raf ->
            raf.seek(clampedStart)
            raf.readFully(buf)
        }
        return RangeSlice(
            bytes = buf,
            statusCode = 206,
            headers = mapOf(
                "Accept-Ranges" to "bytes",
                "Content-Range" to "bytes $clampedStart-$clampedEnd/$total",
                "Content-Length" to len.toString(),
                "Cache-Control" to "no-store",
            ),
        )
    }

    companion object {
        const val SAMPLE_RATE = 16_000
        const val CHANNELS = 1
        const val BITS_PER_SAMPLE = 16
        const val BYTES_PER_MS = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8) / 1000 // 32
        const val WAV_HEADER_BYTES = 44L

        fun buildWavHeader(pcmDataBytes: Long): ByteArray {
            val byteRate = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8)
            val blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8)
            val dataLen = pcmDataBytes.coerceAtMost(0x7FFF_FFB0L).toInt()
            val riffLen = dataLen + 36
            return ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
                put("RIFF".toByteArray(Charsets.US_ASCII))
                putInt(riffLen)
                put("WAVE".toByteArray(Charsets.US_ASCII))
                put("fmt ".toByteArray(Charsets.US_ASCII))
                putInt(16) // PCM fmt chunk size
                putShort(1) // PCM format
                putShort(CHANNELS.toShort())
                putInt(SAMPLE_RATE)
                putInt(byteRate)
                putShort(blockAlign.toShort())
                putShort(BITS_PER_SAMPLE.toShort())
                put("data".toByteArray(Charsets.US_ASCII))
                putInt(dataLen)
            }.array()
        }
    }
}

class WavAppendWriter(private val file: File) : AutoCloseable {
    private val lock = Any()
    private val raf: RandomAccessFile
    private var pcmBytes: Long

    init {
        file.parentFile?.mkdirs()
        raf = RandomAccessFile(file, "rw")
        if (raf.length() < WavStorage.WAV_HEADER_BYTES) {
            raf.setLength(0)
            raf.seek(0)
            raf.write(WavStorage.buildWavHeader(0))
            pcmBytes = 0L
        } else {
            pcmBytes = raf.length() - WavStorage.WAV_HEADER_BYTES
            raf.seek(raf.length())
        }
    }

    fun append(pcm: ByteArray, offset: Int = 0, length: Int = pcm.size) = synchronized(lock) {
        if (length <= 0) return@synchronized
        raf.seek(WavStorage.WAV_HEADER_BYTES + pcmBytes)
        raf.write(pcm, offset, length)
        pcmBytes += length
        updateHeaderLocked()
    }

    fun durationMs(): Long = synchronized(lock) { pcmBytes / WavStorage.BYTES_PER_MS }

    private fun updateHeaderLocked() {
        val header = WavStorage.buildWavHeader(pcmBytes)
        raf.seek(0)
        raf.write(header)
    }

    override fun close() {
        synchronized(lock) {
            runCatching { updateHeaderLocked() }
            runCatching { raf.close() }
        }
    }
}
