package com.zhiling.classroom.audio

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 原生 Android 16 kHz / 16-bit / Mono AudioRecord 采集器。
 * 运行在 ForegroundService 专属高优先级线程中，锁屏/后台 3 小时不掉帧。
 */
class AndroidAudioRecorder(
    private val onPcmFrame: (pcm: ByteArray, length: Int, rms: Double) -> Unit,
    private val onError: (String) -> Unit,
) {
    private val running = AtomicBoolean(false)
    @Volatile
    private var muted = false
    private var thread: Thread? = null

    fun setMuted(isMuted: Boolean) {
        muted = isMuted
    }

    fun isRunning(): Boolean = running.get()

    @SuppressLint("MissingPermission")
    fun start() {
        if (!running.compareAndSet(false, true)) return
        val sampleRate = WavStorage.SAMPLE_RATE
        val minBuf = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBuf <= 0) {
            running.set(false)
            onError("无法初始化麦克风录音缓冲区，请检查设备麦克风权限")
            return
        }
        val bufferSize = maxOf(minBuf * 2, 6400 * 2) // >= 400ms ring buffer
        val recorder = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferSize,
            )
        } catch (_: Throwable) {
            try {
                AudioRecord(
                    MediaRecorder.AudioSource.MIC,
                    sampleRate,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    bufferSize,
                )
            } catch (e: Throwable) {
                running.set(false)
                onError("麦克风打开失败，请授予录音权限：${e.message}")
                return
            }
        }

        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            runCatching { recorder.release() }
            running.set(false)
            onError("麦克风未能完成初始化，可能被其他应用占用")
            return
        }

        val aec = runCatching {
            if (AcousticEchoCanceler.isAvailable()) {
                AcousticEchoCanceler.create(recorder.audioSessionId)?.apply { enabled = true }
            } else null
        }.getOrNull()
        val ns = runCatching {
            if (NoiseSuppressor.isAvailable()) {
                NoiseSuppressor.create(recorder.audioSessionId)?.apply { enabled = true }
            } else null
        }.getOrNull()

        val worker = Thread({
            val chunk = ByteArray(3200) // 100ms @ 16kHz PCM16
            try {
                recorder.startRecording()
                while (running.get()) {
                    val read = recorder.read(chunk, 0, chunk.size)
                    if (read > 0) {
                        val payload = if (muted) ByteArray(read) else chunk.copyOf(read)
                        val rms = if (muted) 0.0 else SenseVoiceEngine.computeRms(payload, read)
                        onPcmFrame(payload, read, rms)
                    } else if (read < 0) {
                        onError("录音采集异常中断（错误码 $read）")
                        break
                    }
                }
            } catch (e: Throwable) {
                if (running.get()) {
                    onError("录音采集异常：${e.message ?: "未知错误"}")
                }
            } finally {
                running.set(false)
                runCatching { recorder.stop() }
                runCatching { aec?.release() }
                runCatching { ns?.release() }
                runCatching { recorder.release() }
            }
        }, "ZhilingAudioRecordThread")
        worker.priority = Thread.NORM_PRIORITY + 2
        thread = worker
        worker.start()
    }

    fun stop() {
        running.set(false)
        runCatching { thread?.join(1500) }
        thread = null
    }
}
