package com.zhiling.classroom.audio

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.media.projection.MediaProjection
import android.os.Build
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 纯 Kotlin 双通道 PCM16 混音与能量声源分离工具（JVM 单测可覆盖）。
 */
object AudioChannelMixer {

    /**
     * 将麦克风与系统内录两路 16-bit LE 单声道 PCM 混音为一路 16-bit LE PCM（带饱和防削波）。
     */
    fun mixPcm16Mono(mic: ByteArray?, sys: ByteArray?, length: Int): ByteArray {
        val alignedLen = length - (length and 1)
        if (alignedLen <= 0) return ByteArray(0)
        if (mic == null && sys == null) return ByteArray(alignedLen)
        if (mic == null) {
            val out = ByteArray(alignedLen)
            val copyLen = minOf(alignedLen, sys!!.size)
            System.arraycopy(sys, 0, out, 0, copyLen)
            return out
        }
        if (sys == null) {
            val out = ByteArray(alignedLen)
            val copyLen = minOf(alignedLen, mic.size)
            System.arraycopy(mic, 0, out, 0, copyLen)
            return out
        }

        val out = ByteArray(alignedLen)
        var i = 0
        while (i + 1 < alignedLen) {
            val sMic = if (i + 1 < mic.size) {
                ((mic[i + 1].toInt() shl 8) or (mic[i].toInt() and 0xFF)).toShort().toInt()
            } else 0
            val sSys = if (i + 1 < sys.size) {
                ((sys[i + 1].toInt() shl 8) or (sys[i].toInt() and 0xFF)).toShort().toInt()
            } else 0
            val mixed = (sMic + sSys).coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
            out[i] = (mixed and 0xFF).toByte()
            out[i + 1] = ((mixed ushr 8) and 0xFF).toByte()
            i += 2
        }
        return out
    }

    /**
     * 根据双通道能量占比判定讲话人通道：
     * - 仅开启双通道身份分离且双轨均处于采集状态时返回 "self" / "remote"；
     * - 单通道系统内录时返回 "remote"（老师/系统音频）；
     * - 否则返回 "default"。
     */
    fun resolveSpeakerChannel(
        micEnergy: Double,
        sysEnergy: Double,
        splitEnabled: Boolean,
        micActive: Boolean,
        sysActive: Boolean,
    ): String {
        if (!micActive && sysActive) return "remote"
        if (!splitEnabled || !micActive || !sysActive) return "default"
        val total = micEnergy + sysEnergy
        if (total <= 1e-9) return "default"
        return when {
            micEnergy > sysEnergy * 1.15 -> "self"
            sysEnergy > micEnergy * 1.15 -> "remote"
            else -> "default"
        }
    }
}

/**
 * 原生 Android 16 kHz / 16-bit / Mono AudioRecord 麦克风采集器。
 * 运行在 ForegroundService 专属高优先级线程中，锁屏/后台 3 小时不掉帧。
 */
class AndroidAudioRecorder(
    private val onPcmFrame: (pcm: ByteArray, length: Int, rms: Double) -> Unit,
    private val onError: (String) -> Unit,
    private val preferredDevice: AudioDeviceInfo? = null,
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

        if (preferredDevice != null) {
            runCatching { recorder.setPreferredDevice(preferredDevice) }
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

/**
 * 原生 Android 10+ (API 29+) 系统媒体声音内录采集器（基于 MediaProjection + AudioPlaybackCapture）。
 * 支持捕获手机中网课、视频、会议等媒体播放音轨，戴耳机也能清晰采集 16kHz 单声道 PCM16。
 */
class AndroidSystemAudioRecorder(
    private val mediaProjection: MediaProjection,
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
    fun start(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            onError("系统声音内录需要 Android 10 及以上系统版本")
            return false
        }
        if (!running.compareAndSet(false, true)) return true

        val sampleRate = WavStorage.SAMPLE_RATE
        val minBuf = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBuf <= 0) {
            running.set(false)
            onError("无法初始化系统内录音频缓冲区")
            return false
        }
        val bufferSize = maxOf(minBuf * 2, 6400 * 2)

        val recorder = try {
            val captureConfig = AudioPlaybackCaptureConfiguration.Builder(mediaProjection)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .build()
            val audioFormat = AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(sampleRate)
                .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                .build()
            AudioRecord.Builder()
                .setAudioFormat(audioFormat)
                .setBufferSizeInBytes(bufferSize)
                .setAudioPlaybackCaptureConfig(captureConfig)
                .build()
        } catch (e: Throwable) {
            running.set(false)
            onError("系统声音内录启动失败：${e.message ?: "请重新授予录屏音频权限"}")
            return false
        }

        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            runCatching { recorder.release() }
            running.set(false)
            onError("系统声音内录未能完成初始化，请重新授权后再试")
            return false
        }

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
                        if (running.get()) {
                            onError("系统内录采集异常中断（错误码 $read）")
                        }
                        break
                    }
                }
            } catch (e: Throwable) {
                if (running.get()) {
                    onError("系统内录采集异常：${e.message ?: "未知错误"}")
                }
            } finally {
                running.set(false)
                runCatching { recorder.stop() }
                runCatching { recorder.release() }
            }
        }, "ZhilingSystemAudioThread")
        worker.priority = Thread.NORM_PRIORITY + 2
        thread = worker
        worker.start()
        return true
    }

    fun stop() {
        running.set(false)
        runCatching { thread?.join(1500) }
        thread = null
    }
}
